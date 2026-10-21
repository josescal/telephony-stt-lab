import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { ValidatedEnv } from './env.js';
import type {
  ElevenLabsServerMessage,
  ProxyEnvelopedEvent,
  ScribeErrorMessage,
} from '../shared/types.js';

const SessionQuerySchema = z.object({
  audio_format: z
    .enum([
      'pcm_8000',
      'pcm_16000',
      'pcm_22050',
      'pcm_24000',
      'pcm_44100',
      'pcm_48000',
      'ulaw_8000',
    ])
    .default('pcm_16000'),
  language_code: z.string().trim().optional(),
  commit_strategy: z.enum(['vad', 'manual']).default('vad'),
  vad_silence_threshold_secs: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .refine((v) => v === undefined || (!Number.isNaN(v) && v >= 0.2 && v <= 5.0), {
      message: 'vad_silence_threshold_secs must be between 0.2 and 5.0',
    }),
  vad_threshold: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .refine((v) => v === undefined || (!Number.isNaN(v) && v >= 0.05 && v <= 0.99), {
      message: 'vad_threshold must be between 0.05 and 0.99',
    }),
  include_timestamps: z
    .enum(['true', 'false'])
    .optional()
    .default('true'),
});

const ClientAudioChunkSchema = z.object({
  message_type: z.literal('input_audio_chunk'),
  audio_base_64: z.string().min(0),
  commit: z.boolean(),
  sample_rate: z.number().int().positive(),
  previous_text: z.string().optional(),
});

function sendToClient(clientWs: WebSocket, message: ElevenLabsServerMessage): void {
  if (clientWs.readyState !== WebSocket.OPEN) {
    return;
  }
  const envelope: ProxyEnvelopedEvent = {
    serverTimestampMs: Date.now(),
    payload: message,
  };
  clientWs.send(JSON.stringify(envelope));
}

export function buildUpstreamElevenLabsUrl(
  baseWsUrl: string,
  queryParams: z.infer<typeof SessionQuerySchema>
): string {
  const upstreamUrl = new URL(baseWsUrl);
  upstreamUrl.searchParams.set('model_id', 'scribe_v2_realtime');
  upstreamUrl.searchParams.set('audio_format', queryParams.audio_format);
  upstreamUrl.searchParams.set('commit_strategy', queryParams.commit_strategy);
  upstreamUrl.searchParams.set('include_timestamps', queryParams.include_timestamps);

  if (queryParams.language_code && queryParams.language_code.length > 0) {
    upstreamUrl.searchParams.set('language_code', queryParams.language_code);
  }

  if (queryParams.commit_strategy === 'vad') {
    if (queryParams.vad_silence_threshold_secs !== undefined) {
      upstreamUrl.searchParams.set(
        'vad_silence_threshold_secs',
        String(queryParams.vad_silence_threshold_secs)
      );
    }
    if (queryParams.vad_threshold !== undefined) {
      upstreamUrl.searchParams.set('vad_threshold', String(queryParams.vad_threshold));
    }
  }

  return upstreamUrl.toString();
}

export function attachSttWebSocketProxy(
  httpServer: HttpServer,
  getEnv: () => ValidatedEnv
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
  });

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const reqUrl = new URL(request.url ?? '/', 'http://localhost');
    if (reqUrl.pathname === '/api/ws/google') {
      return;
    }
    if (reqUrl.pathname !== '/api/ws/stt') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (clientWs) => {
      wss.emit('connection', clientWs, request);
    });
  });

  wss.on('connection', (clientWs: WebSocket, request: IncomingMessage) => {
    const env = getEnv();

    if (!env.isApiKeyConfigured) {
      const authErr: ScribeErrorMessage = {
        message_type: 'auth_error',
        error:
          'ELEVENLABS_API_KEY is not configured on the backend server. Please set a valid API key in your .env file and restart the server.',
      };
      sendToClient(clientWs, authErr);
      clientWs.close(1008, 'Missing ELEVENLABS_API_KEY');
      return;
    }

    const reqUrl = new URL(request.url ?? '/', 'http://localhost');
    const rawQuery: Record<string, string> = {};
    reqUrl.searchParams.forEach((value, key) => {
      rawQuery[key] = value;
    });

    const parsedQuery = SessionQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      const errMsg = parsedQuery.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      sendToClient(clientWs, {
        message_type: 'invalid_request',
        error: `Invalid session parameters: ${errMsg}`,
      });
      clientWs.close(1008, 'Invalid session parameters');
      return;
    }

    const upstreamUrl = buildUpstreamElevenLabsUrl(
      env.elevenLabsWsUrl,
      parsedQuery.data
    );

    const pendingClientMessages: string[] = [];
    const MAX_PENDING_MESSAGES = 100;

    const upstreamWs = new WebSocket(upstreamUrl, {
      headers: {
        'xi-api-key': env.elevenLabsApiKey,
      },
    });

    upstreamWs.on('open', () => {
      while (pendingClientMessages.length > 0 && upstreamWs.readyState === WebSocket.OPEN) {
        const msg = pendingClientMessages.shift();
        if (msg) {
          upstreamWs.send(msg);
        }
      }
    });

    upstreamWs.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      res.on('end', () => {
        const statusCode = res.statusCode ?? 500;
        let detail = body.trim();
        try {
          const json = JSON.parse(body) as { detail?: { message?: string } | string };
          if (typeof json.detail === 'string') {
            detail = json.detail;
          } else if (json.detail && typeof json.detail.message === 'string') {
            detail = json.detail.message;
          }
        } catch {
          // Use raw body string if not JSON
        }

        const errorType =
          statusCode === 401 || statusCode === 403
            ? 'auth_error'
            : statusCode === 429
              ? 'rate_limited'
              : 'error';

        sendToClient(clientWs, {
          message_type: errorType,
          error: `ElevenLabs WebSocket handshake failed (HTTP ${statusCode})${detail ? `: ${detail}` : ''}`,
        });
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close(1008, `Upstream HTTP ${statusCode}`);
        }
      });
    });

    upstreamWs.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const text = data.toString();
      try {
        const parsed = JSON.parse(text) as ElevenLabsServerMessage;
        sendToClient(clientWs, parsed);
      } catch {
        sendToClient(clientWs, {
          message_type: 'error',
          error: 'Received malformed non-JSON frame from ElevenLabs Scribe stream.',
        });
      }
    });

    upstreamWs.on('error', (err: Error) => {
      sendToClient(clientWs, {
        message_type: 'error',
        error: `Upstream ElevenLabs WebSocket error: ${err.message}`,
      });
    });

    upstreamWs.on('close', (code: number, reason: Buffer) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        const safeCode = code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1000;
        clientWs.close(safeCode, reason.toString() || 'Upstream closed');
      }
    });

    clientWs.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const rawText = data.toString();
      let json: unknown;
      try {
        json = JSON.parse(rawText);
      } catch {
        sendToClient(clientWs, {
          message_type: 'input_error',
          error: 'Client sent invalid JSON frame to proxy.',
        });
        return;
      }

      const validated = ClientAudioChunkSchema.safeParse(json);
      if (!validated.success) {
        sendToClient(clientWs, {
          message_type: 'input_error',
          error: `Invalid input_audio_chunk payload: ${validated.error.issues.map((i) => i.message).join(', ')}`,
        });
        return;
      }

      const serialized = JSON.stringify(validated.data);
      if (upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.send(serialized);
      } else if (upstreamWs.readyState === WebSocket.CONNECTING) {
        if (pendingClientMessages.length < MAX_PENDING_MESSAGES) {
          pendingClientMessages.push(serialized);
        } else {
          sendToClient(clientWs, {
            message_type: 'queue_overflow',
            error: 'Audio chunk queue overflow while waiting for ElevenLabs handshake.',
          });
        }
      }
    });

    clientWs.on('close', () => {
      if (
        upstreamWs.readyState === WebSocket.OPEN ||
        upstreamWs.readyState === WebSocket.CONNECTING
      ) {
        upstreamWs.close(1000, 'Client disconnected');
      }
    });

    clientWs.on('error', () => {
      if (
        upstreamWs.readyState === WebSocket.OPEN ||
        upstreamWs.readyState === WebSocket.CONNECTING
      ) {
        upstreamWs.close(1000, 'Client socket error');
      }
    });
  });

  return wss;
}
