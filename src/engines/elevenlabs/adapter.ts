import type {
  ConnectionStatus,
  ElevenLabsAudioFormat,
  ProxyEnvelopedEvent,
  TranscriptionWord,
} from '../../shared/types.js';
import { uint8ArrayToBase64 } from '../../shared/audio/profileProcessor.js';
import type {
  EngineCallbacks,
  EngineMetadata,
  EngineSessionConfig,
  STTEngineAdapter,
} from '../base/types.js';

export const ELEVENLABS_METADATA: EngineMetadata = {
  id: 'elevenlabs',
  name: 'ElevenLabs Scribe v2',
  vendor: 'ElevenLabs',
  defaultModel: 'scribe_v2_realtime',
  description: 'Real-time low-latency ASR with punctuation and word-level timestamps.',
  website: 'https://elevenlabs.io',
  capabilities: {
    supportsUlaw8k: true,
    supportsPcm8k: true,
    supportsPcm16k: true,
    supportsWordTimestamps: true,
    supportsConfidenceScore: true,
    supportsManualCommit: true,
    supportsVadAutoCommit: true,
  },
};

export function resolveElevenLabsFormat(
  profileId: string,
  sampleRate: number
): ElevenLabsAudioFormat {
  if (profileId === 'ulaw_8000') return 'ulaw_8000';
  if (profileId === 'pcm_8000') return 'pcm_8000';
  if (sampleRate >= 44100) return 'pcm_48000';
  if (sampleRate >= 24000) return 'pcm_24000';
  if (sampleRate >= 22050) return 'pcm_22050';
  return 'pcm_16000';
}

export class ElevenLabsAdapter implements STTEngineAdapter {
  public readonly metadata = ELEVENLABS_METADATA;
  public currentStatus: ConnectionStatus = 'disconnected';

  private ws: WebSocket | null = null;
  private callbacks: EngineCallbacks | null = null;
  private config: EngineSessionConfig | null = null;
  private pendingChunks: Uint8Array[] = [];
  private connectTimestampMs = 0;
  private audioFormat: ElevenLabsAudioFormat = 'pcm_16000';

  async connect(config: EngineSessionConfig, callbacks: EngineCallbacks): Promise<void> {
    this.config = config;
    this.callbacks = callbacks;
    this.audioFormat = resolveElevenLabsFormat(config.profileId, config.sampleRate);
    this.updateStatus('connecting');
    this.connectTimestampMs = Date.now();

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({
      audio_format: this.audioFormat,
      commit_strategy: config.commitStrategy,
      include_timestamps: config.includeTimestamps !== false ? 'true' : 'false',
    });

    if (config.languageCode && config.languageCode.trim().length > 0) {
      params.set('language_code', config.languageCode.trim());
    }

    if (config.commitStrategy === 'vad') {
      if (config.vadSilenceThresholdSecs !== undefined) {
        params.set('vad_silence_threshold_secs', String(config.vadSilenceThresholdSecs));
      }
      if (config.vadThreshold !== undefined) {
        params.set('vad_threshold', String(config.vadThreshold));
      }
    }

    const wsUrl = `${wsProtocol}//${window.location.host}/api/ws/stt?${params.toString()}`;

    return new Promise((resolve, reject) => {
      let isResolved = false;

      try {
        const ws = new WebSocket(wsUrl);
        this.ws = ws;

        ws.onopen = () => {
          this.updateStatus('connected');
        };

        ws.onmessage = (event) => {
          try {
            const enveloped = JSON.parse(event.data) as ProxyEnvelopedEvent;
            this.handleServerMessage(enveloped);

            if (!isResolved && enveloped.payload?.message_type === 'session_started') {
              isResolved = true;
              resolve();
            }
          } catch (err) {
            console.error('[ElevenLabsAdapter] Error parsing event:', err);
          }
        };

        ws.onerror = (evt) => {
          console.error('[ElevenLabsAdapter] WebSocket error:', evt);
          const errorMsg = 'Error en WebSocket de ElevenLabs (proxy local).';
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

  sendAudioChunk(chunk: Uint8Array, isLastChunk = false): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingChunks.push(chunk);
      return;
    }

    // Flush any pending chunks first
    while (this.pendingChunks.length > 0) {
      const prev = this.pendingChunks.shift()!;
      this.transmitChunk(prev, false);
    }

    this.transmitChunk(chunk, isLastChunk);
  }

  commit(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = {
      message_type: 'input_audio_chunk',
      audio_base_64: '',
      commit: true,
      sample_rate: this.config?.sampleRate ?? 16000,
    };
    this.ws.send(JSON.stringify(msg));
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

  private transmitChunk(chunk: Uint8Array, commit: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const base64 = uint8ArrayToBase64(chunk);
    const msg = {
      message_type: 'input_audio_chunk',
      audio_base_64: base64,
      commit,
      sample_rate: this.config?.sampleRate ?? 16000,
    };
    this.ws.send(JSON.stringify(msg));
  }

  private handleServerMessage(enveloped: ProxyEnvelopedEvent): void {
    const payload = enveloped.payload;
    if (!payload || !this.callbacks) return;

    const latencyNow = Date.now() - this.connectTimestampMs;

    switch (payload.message_type) {
      case 'session_started':
        this.updateStatus('session_active');
        // Flush buffered chunks immediately
        while (this.pendingChunks.length > 0) {
          const chunk = this.pendingChunks.shift()!;
          this.transmitChunk(chunk, false);
        }
        break;

      case 'partial_transcript':
        if (payload.text) {
          this.callbacks.onPartialTranscript(payload.text, latencyNow);
        }
        break;

      case 'committed_transcript':
      case 'committed_transcript_with_timestamps': {
        const text = payload.text ?? '';
        const words = (payload as { words?: TranscriptionWord[] }).words;
        this.callbacks.onCommittedTranscript(text, latencyNow, words);
        break;
      }

      case 'warning':
        this.callbacks.onWarning?.(payload.warning);
        break;

      default:
        if (
          'error' in payload &&
          typeof (payload as { error: string }).error === 'string'
        ) {
          this.callbacks.onError((payload as { error: string }).error);
          this.updateStatus('error');
        }
        break;
    }
  }

  private updateStatus(status: ConnectionStatus): void {
    this.currentStatus = status;
    this.callbacks?.onStatusChange(status);
  }
}
