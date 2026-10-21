import type {
  AudioProfileId,
  CommitStrategy,
  ConnectionStatus,
  AccuracyMetrics,
  LatencyMetrics,
  TranscriptionWord,
} from '../../shared/types.js';

export type EngineId = 'elevenlabs' | 'gladia' | 'google' | (string & {});

export interface EngineCapabilities {
  supportsUlaw8k: boolean;
  supportsPcm8k: boolean;
  supportsPcm16k: boolean;
  supportsWordTimestamps: boolean;
  supportsConfidenceScore: boolean;
  supportsManualCommit: boolean;
  supportsVadAutoCommit: boolean;
}

export interface EngineMetadata {
  id: EngineId;
  name: string;
  vendor: string;
  defaultModel: string;
  description: string;
  website: string;
  capabilities: EngineCapabilities;
}

export interface EngineSessionConfig {
  profileId: AudioProfileId;
  sampleRate: number;
  languageCode: string;
  commitStrategy: CommitStrategy;
  vadSilenceThresholdSecs?: number;
  vadThreshold?: number;
  includeTimestamps?: boolean;
}

export interface EngineCallbacks {
  onStatusChange: (status: ConnectionStatus) => void;
  onPartialTranscript: (text: string, latencyMs: number | null) => void;
  onCommittedTranscript: (
    text: string,
    latencyMs: number | null,
    words?: TranscriptionWord[]
  ) => void;
  onConfidenceUpdate?: (confidence: number) => void;
  onError: (error: string) => void;
  onWarning?: (warning: string) => void;
}

export interface STTEngineAdapter {
  readonly metadata: EngineMetadata;
  readonly currentStatus: ConnectionStatus;

  /**
   * Initializes the session and establishes WebSocket or streaming connection.
   */
  connect(config: EngineSessionConfig, callbacks: EngineCallbacks): Promise<void>;

  /**
   * Sends an encoded audio chunk (e.g. PCM 16-bit or G.711 u-law bytes).
   */
  sendAudioChunk(chunk: Uint8Array, isLastChunk?: boolean): void;

  /**
   * Explicitly commits or finalizes pending speech (for manual commit strategy).
   */
  commit?(): Promise<void> | void;

  /**
   * Gracefully terminates the session and frees resources.
   */
  disconnect(): Promise<void> | void;
}

/**
 * Standardized single-engine result for benchmark runs.
 */
export interface SingleEngineResult {
  engineId: EngineId;
  engineName: string;
  model: string;
  formatLabel: string;
  transcript: string;
  accuracy: AccuracyMetrics | null;
  latency: LatencyMetrics;
  confidence: number | null;
  words?: TranscriptionWord[];
  errors: string[];
  warnings: string[];
}

/**
 * Standardized benchmark evaluation run containing N engines evaluated simultaneously.
 */
export interface BenchmarkRun {
  id: string;
  createdAt: string;
  sourceType: 'microphone' | 'wav_upload';
  sourceName: string;
  profileId: AudioProfileId;
  profileName: string;
  inputSampleRate: number;
  outputSampleRate: number;
  referenceTranscript: string;
  hasSavedAudio?: boolean;
  signalMetrics: {
    rmsDbFs: number;
    peakDbFs: number;
    quantizationSnrDb: number | null;
  };
  engines: Record<EngineId, SingleEngineResult>;
}
