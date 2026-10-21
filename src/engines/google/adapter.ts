import type {
  ConnectionStatus,
  TranscriptionWord,
} from '../../shared/types.js';
import type { GoogleProxyServerMessage } from '../../shared/google/liveSession.js';
import type {
  EngineCallbacks,
  EngineMetadata,
  EngineSessionConfig,
  STTEngineAdapter,
} from '../base/types.js';

export const GOOGLE_METADATA: EngineMetadata = {
  id: 'google',
  name: 'Google STT v2 (Chirp 3)',
  vendor: 'Google Cloud',
  defaultModel: 'chirp_3',
  description:
    'Google Cloud Speech-to-Text V2 streaming powered by USM / Chirp 3 (eu-speech.googleapis.com).',
  website: 'https://cloud.google.com/speech-to-text/v2/docs/chirp_3-model',
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

export class GoogleSttAdapter implements STTEngineAdapter {
  public readonly metadata = GOOGLE_METADATA;
  public currentStatus: ConnectionStatus = 'disconnected';

  private ws: WebSocket | null = null;
  private callbacks: EngineCallbacks | null = null;
  private pendingChunks: Uint8Array[] = [];
  private connectTimestampMs = 0;

  async connect(config: EngineSessionConfig, callbacks: EngineCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.updateStatus('connecting');
    this.connectTimestampMs = Date.now();

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = new URL(`${wsProtocol}//${window.location.host}/api/ws/google`);
    wsUrl.searchParams.set('profile_id', config.profileId);
    wsUrl.searchParams.set('sample_rate', String(config.sampleRate));
    wsUrl.searchParams.set('language_code', config.languageCode || 'es');

    return new Promise((resolve, reject) => {
      let isResolved = false;

      try {
        const ws = new WebSocket(wsUrl.toString());
        ws.binaryType = 'arraybuffer';
        this.ws = ws;

        ws.onopen = () => {
          this.updateStatus('connected');
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
            const msg = JSON.parse(String(event.data)) as GoogleProxyServerMessage;
            this.handleServerMessage(msg);
          } catch (err) {
            console.error('[GoogleSttAdapter] Error parsing message:', err);
          }
        };

        ws.onerror = () => {
          const errorMsg = 'Error en WebSocket /api/ws/google (Google STT v2).';
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

    while (this.pendingChunks.length > 0) {
      const prev = this.pendingChunks.shift()!;
      this.ws.send(prev);
    }

    this.ws.send(chunk);
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'stop_recording' }));
        } catch {
          // ignore
        }
      }
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

  private handleServerMessage(msg: GoogleProxyServerMessage): void {
    if (!this.callbacks) return;
    const latencyNow = Date.now() - this.connectTimestampMs;

    if (msg.type === 'session_started') {
      this.updateStatus('session_active');
      return;
    }

    if (msg.type === 'transcript') {
      const text = msg.text.trim();
      if (!text) return;

      if (typeof msg.confidence === 'number') {
        this.callbacks.onConfidenceUpdate?.(msg.confidence);
      }

      const words: TranscriptionWord[] | undefined = msg.words;

      if (msg.isFinal) {
        this.callbacks.onCommittedTranscript(text, latencyNow, words);
      } else {
        this.callbacks.onPartialTranscript(text, latencyNow);
      }
      return;
    }

    if (msg.type === 'error') {
      this.callbacks.onError(msg.error);
      this.updateStatus('error');
    }
  }

  private updateStatus(status: ConnectionStatus): void {
    this.currentStatus = status;
    this.callbacks?.onStatusChange(status);
  }
}
