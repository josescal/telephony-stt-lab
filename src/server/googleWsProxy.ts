import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { v2 } from '@google-cloud/speech';
import type { ValidatedEnv } from './env.js';
import type { AudioProfileId, TranscriptionWord } from '../shared/types.js';
import {
  normalizeGoogleLanguageCodes,
  resolveGoogleAudioFormat,
  resolveGoogleSttApiEndpoint,
  type GoogleProxyServerMessage,
} from '../shared/google/liveSession.js';

function sendToClient(clientWs: WebSocket, message: GoogleProxyServerMessage): void {
  if (clientWs.readyState === WebSocket.OPEN) {
    clientWs.send(JSON.stringify(message));
  }
}

export function attachGoogleSttWebSocketProxy(
  httpServer: HttpServer,
  getEnv: () => ValidatedEnv
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
  });

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const reqUrl = new URL(request.url ?? '/', 'http://localhost');
    if (reqUrl.pathname !== '/api/ws/google') {
      return;
    }

    wss.handleUpgrade(request, socket, head, (clientWs) => {
      wss.emit('connection', clientWs, request);
    });
  });

  wss.on('connection', (clientWs: WebSocket, request: IncomingMessage) => {
    const env = getEnv();

    if (!env.isGoogleConfigured) {
      sendToClient(clientWs, {
        type: 'error',
        error:
          'Google Cloud STT v2 no está configurado. Define GOOGLE_CREDENTIALS_JSON (y GOOGLE_CLOUD_PROJECT) en tu archivo .env.',
      });
      clientWs.close(1008, 'Missing Google Cloud STT credentials');
      return;
    }

    const reqUrl = new URL(request.url ?? '/', 'http://localhost');
    const rawProfile = reqUrl.searchParams.get('profile_id') ?? 'ulaw_8000';
    const profileId: AudioProfileId =
      rawProfile === 'original' ||
      rawProfile === 'pcm_8000' ||
      rawProfile === 'ulaw_8000'
        ? rawProfile
        : 'ulaw_8000';

    const sampleRate = Number(reqUrl.searchParams.get('sample_rate')) || 8000;
    const rawLang = reqUrl.searchParams.get('language_code') ?? 'es';
    const languageCodes = normalizeGoogleLanguageCodes(rawLang);
    const formatSpec = resolveGoogleAudioFormat(profileId, sampleRate);
    const apiEndpoint = resolveGoogleSttApiEndpoint(env.googleLocation);

    const sessionId = `goog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    let speechClient: v2.SpeechClient;
    try {
      const clientOpts: ConstructorParameters<typeof v2.SpeechClient>[0] = {
        apiEndpoint,
        projectId: env.googleProjectId,
      };
      if (env.googleCredentials) {
        clientOpts.credentials = {
          client_email: env.googleCredentials.client_email,
          private_key: env.googleCredentials.private_key,
        };
      } else if (env.googleApplicationCredentialsPath) {
        clientOpts.keyFilename = env.googleApplicationCredentialsPath;
      }
      speechClient = new v2.SpeechClient(clientOpts);
    } catch (err) {
      sendToClient(clientWs, {
        type: 'error',
        error: `Error al inicializar cliente Google Speech V2: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      clientWs.close(1011, 'SpeechClient init failed');
      return;
    }

    const recognizer = `projects/${env.googleProjectId}/locations/${env.googleLocation}/recognizers/_`;
    const recognizeStream = speechClient._streamingRecognize();
    let streamEnded = false;

    recognizeStream.on('data', (response: {
      speechEventType?: string;
      results?: Array<{
        isFinal?: boolean;
        stability?: number;
        languageCode?: string;
        resultEndOffset?: { seconds?: number | string; nanos?: number };
        alternatives?: Array<{
          transcript?: string;
          confidence?: number;
          words?: Array<{
            word?: string;
            confidence?: number;
            startOffset?: { seconds?: number | string; nanos?: number };
            endOffset?: { seconds?: number | string; nanos?: number };
          }>;
        }>;
      }>;
    }) => {
      if (
        response.speechEventType &&
        response.speechEventType !== 'SPEECH_EVENT_TYPE_UNSPECIFIED'
      ) {
        sendToClient(clientWs, {
          type: 'speech_event',
          event: String(response.speechEventType),
        });
      }

      if (!Array.isArray(response.results)) return;

      for (const res of response.results) {
        const alt = res.alternatives?.[0];
        const text = (alt?.transcript ?? '').trim();
        if (!text) continue;

        const isFinal = Boolean(res.isFinal);
        const confidence =
          typeof alt?.confidence === 'number' && alt.confidence > 0
            ? alt.confidence
            : undefined;

        const words: TranscriptionWord[] | undefined = Array.isArray(alt?.words)
          ? alt.words.map((w) => {
              const startSec =
                Number(w.startOffset?.seconds ?? 0) +
                Number(w.startOffset?.nanos ?? 0) / 1e9;
              const endSec =
                Number(w.endOffset?.seconds ?? 0) +
                Number(w.endOffset?.nanos ?? 0) / 1e9;
              return {
                text: w.word ?? '',
                start: startSec,
                end: endSec,
                logprob:
                  typeof w.confidence === 'number' && w.confidence > 0
                    ? Math.log(Math.max(0.0001, w.confidence))
                    : undefined,
              };
            })
          : undefined;

        sendToClient(clientWs, {
          type: 'transcript',
          text,
          isFinal,
          confidence,
          languageCode: res.languageCode || languageCodes[0],
          words,
        });
      }
    });

    recognizeStream.on('error', (err: Error) => {
      if (streamEnded && err.message?.includes('cancelled')) {
        return;
      }
      sendToClient(clientWs, {
        type: 'error',
        error: `Google STT v2 (${env.googleLocation}/${env.googleModel}): ${err.message}`,
      });
    });

    recognizeStream.on('end', () => {
      streamEnded = true;
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1000, 'Google STT stream completed');
      }
    });

    // 1. Write the initial StreamingRecognizeRequest configuration frame
    try {
      recognizeStream.write({
        recognizer,
        streamingConfig: {
          config: {
            explicitDecodingConfig: {
              encoding: formatSpec.encoding,
              sampleRateHertz: formatSpec.sampleRateHertz,
              audioChannelCount: formatSpec.audioChannelCount,
            },
            languageCodes,
            model: env.googleModel,
            features: {
              enableAutomaticPunctuation: true,
            },
          },
          streamingFeatures: {
            interimResults: true,
            enableVoiceActivityEvents: true,
          },
        },
      });

      sendToClient(clientWs, {
        type: 'session_started',
        sessionId,
        model: env.googleModel,
        location: env.googleLocation,
        languageCodes,
        format: formatSpec,
      });
    } catch (err) {
      sendToClient(clientWs, {
        type: 'error',
        error: `No se pudo iniciar el stream con Google STT v2: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      clientWs.close(1011, 'Failed to write streamingConfig');
      return;
    }

    // 2. Forward incoming audio chunks from Browser -> Google gRPC stream
    // Maximum Google STT v2 audio chunk size is 25,600 bytes; split if larger.
    const MAX_GOOGLE_CHUNK_BYTES = 16000;

    clientWs.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (streamEnded || recognizeStream.destroyed) return;

      if (!isBinary) {
        try {
          const text = data.toString();
          const parsed = JSON.parse(text) as {
            type?: string;
            audio_base_64?: string;
          };
          if (parsed.type === 'stop_recording') {
            streamEnded = true;
            recognizeStream.end();
            return;
          }
          if (parsed.audio_base_64) {
            const buf = Buffer.from(parsed.audio_base_64, 'base64');
            for (let offset = 0; offset < buf.length; offset += MAX_GOOGLE_CHUNK_BYTES) {
              recognizeStream.write({
                audio: buf.subarray(offset, offset + MAX_GOOGLE_CHUNK_BYTES),
              });
            }
          }
        } catch {
          // Ignore malformed JSON control frame
        }
        return;
      }

      const rawBuffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);

      if (rawBuffer.length === 0) return;

      try {
        for (
          let offset = 0;
          offset < rawBuffer.length;
          offset += MAX_GOOGLE_CHUNK_BYTES
        ) {
          recognizeStream.write({
            audio: rawBuffer.subarray(offset, offset + MAX_GOOGLE_CHUNK_BYTES),
          });
        }
      } catch (writeErr) {
        sendToClient(clientWs, {
          type: 'error',
          error: `Error enviando audio a Google STT v2: ${
            writeErr instanceof Error ? writeErr.message : String(writeErr)
          }`,
        });
      }
    });

    clientWs.on('close', () => {
      if (!streamEnded && !recognizeStream.destroyed) {
        streamEnded = true;
        try {
          recognizeStream.end();
        } catch {
          // ignore
        }
      }
      void speechClient.close().catch(() => {});
    });

    clientWs.on('error', () => {
      if (!streamEnded && !recognizeStream.destroyed) {
        streamEnded = true;
        try {
          recognizeStream.destroy();
        } catch {
          // ignore
        }
      }
      void speechClient.close().catch(() => {});
    });
  });

  return wss;
}
