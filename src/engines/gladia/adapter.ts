import type {
  ConnectionStatus,
  TranscriptionWord,
} from '../../shared/types.js';
import type {
  GladiaLiveEvent,
  GladiaLiveInitResponse,
} from '../../shared/gladia/liveSession.js';
import type {
  EngineCallbacks,
  EngineMetadata,
  EngineSessionConfig,
  STTEngineAdapter,
} from '../base/types.js';

export const GLADIA_METADATA: EngineMetadata = {
  id: 'gladia',
  name: 'Gladia Live v2 (Solaria-1)',
  vendor: 'Gladia',
  defaultModel: 'solaria-1',
  description: 'Multilingual real-time ASR powered by Solaria-1 with live endpointing.',
  website: 'https://gladia.io',
  capabilities: {
    supportsUlaw8k: true,
    supportsPcm8k: true,
    supportsPcm16k: true,
    supportsWordTimestamps: true,
    supportsConfidenceScore: true,
    supportsManualCommit: false,
    supportsVadAutoCommit: true,
  },
};

export class GladiaAdapter implements STTEngineAdapter {
  public readonly metadata = GLADIA_METADATA;
  public currentStatus: ConnectionStatus = 'disconnected';

  private ws: WebSocket | null = null;
  private callbacks: EngineCallbacks | null = null;
  private pendingChunks: Uint8Array[] = [];
  private connectTimestampMs = 0;
  private sessionId: string | null = null;

  async connect(config: EngineSessionConfig, callbacks: EngineCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.updateStatus('connecting');
    this.connectTimestampMs = Date.now();

    // Step 1: Initialize ephemeral session via backend
    const sessionRes = await fetch('/api/gladia/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: config.profileId,
        sampleRate: config.sampleRate,
        languageCode: config.languageCode || 'es',
        endpointing: 0.2,
      }),
    });

    if (!sessionRes.ok) {
      let errMsg = `Error inicializando sesión de Gladia: HTTP ${sessionRes.status}`;
      try {
        const errJson = await sessionRes.json();
        if (errJson.error) errMsg = errJson.error;
      } catch {
        // use default message
      }
      this.callbacks.onError(errMsg);
      this.updateStatus('error');
      throw new Error(errMsg);
    }

    const initData = (await sessionRes.json()) as GladiaLiveInitResponse;
    this.sessionId = initData.id;

    // Step 2: Connect direct WebSocket to Gladia ephemeral live URL
    return new Promise((resolve, reject) => {
      let isResolved = false;

      try {
        const ws = new WebSocket(initData.url);
        this.ws = ws;

        ws.onopen = () => {
          this.updateStatus('session_active');
          // Flush pre-buffered chunks
          while (this.pendingChunks.length > 0) {
            const chunk = this.pendingChunks.shift()!;
            this.ws?.send(chunk);
          }
          if (!isResolved) {
            isResolved = true;
            resolve();
          }
        };

        ws.onmessage = (event) => {
          try {
            const liveEvent = JSON.parse(event.data) as GladiaLiveEvent;
            this.handleServerMessage(liveEvent);
          } catch (err) {
            console.error('[GladiaAdapter] Error parsing event:', err);
          }
        };

        ws.onerror = (evt) => {
          console.error('[GladiaAdapter] WebSocket error:', evt);
          const errorMsg = 'Error en WebSocket de Gladia Live.';
          this.callbacks?.onError(errorMsg);
          this.updateStatus('error');
          if (!isResolved) {
            isResolved = true;
            reject(new Error(errorMsg));
          }
        };

        ws.onclose = () => {
          this.updateStatus('disconnected');
          this.ws = null;
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.callbacks?.onError(msg);
        this.updateStatus('error');
        reject(err);
      }
    });
  }

  sendAudioChunk(chunk: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingChunks.push(chunk);
      return;
    }

    // Flush pending chunks
    while (this.pendingChunks.length > 0) {
      const prev = this.pendingChunks.shift()!;
      this.ws.send(prev);
    }

    this.ws.send(chunk);
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
    this.pendingChunks = [];
    this.updateStatus('disconnected');
  }

  private handleServerMessage(event: GladiaLiveEvent): void {
    if (!this.callbacks) return;
    const latencyNow = Date.now() - this.connectTimestampMs;

    if (event.type === 'transcript' && event.data?.utterance) {
      const utterance = event.data.utterance;
      const text = (utterance.text ?? '').trim();
      if (!text) return;

      if (typeof utterance.confidence === 'number') {
        this.callbacks.onConfidenceUpdate?.(utterance.confidence);
      }

      const words: TranscriptionWord[] | undefined = utterance.words?.map((w) => ({
        text: w.word,
        start: w.start,
        end: w.end,
        logprob: w.confidence !== undefined ? Math.log(Math.max(0.0001, w.confidence)) : undefined,
      }));

      if (event.data.is_final) {
        this.callbacks.onCommittedTranscript(text, latencyNow, words);
      } else {
        this.callbacks.onPartialTranscript(text, latencyNow);
      }
    } else if (event.type === 'post_transcript' && event.data?.utterances) {
      for (const utt of event.data.utterances) {
        const text = (utt.text ?? '').trim();
        if (!text) continue;
        const words: TranscriptionWord[] | undefined = utt.words?.map((w) => ({
          text: w.word,
          start: w.start,
          end: w.end,
          logprob: w.confidence !== undefined ? Math.log(Math.max(0.0001, w.confidence)) : undefined,
        }));
        this.callbacks.onCommittedTranscript(text, latencyNow, words);
      }
    } else if (event.type === 'post_final_transcript' && event.data?.transcription?.utterances) {
      for (const utt of event.data.transcription.utterances) {
        const text = (utt.text ?? '').trim();
        if (!text) continue;
        const words: TranscriptionWord[] | undefined = utt.words?.map((w) => ({
          text: w.word,
          start: w.start,
          end: w.end,
          logprob: w.confidence !== undefined ? Math.log(Math.max(0.0001, w.confidence)) : undefined,
        }));
        this.callbacks.onCommittedTranscript(text, latencyNow, words);
      }
    } else if (event.type === 'error') {
      const errorMsg =
        typeof event.error === 'string'
          ? event.error
          : event.error?.message ?? 'Gladia unknown error';
      this.callbacks.onError(errorMsg);
      this.updateStatus('error');
    }
  }

  private updateStatus(status: ConnectionStatus): void {
    this.currentStatus = status;
    this.callbacks?.onStatusChange(status);
  }

  public getSessionId(): string | null {
    return this.sessionId;
  }
}
