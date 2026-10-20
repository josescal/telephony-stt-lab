export type AudioProfileId = 'original' | 'pcm_8000' | 'ulaw_8000';

export type ElevenLabsAudioFormat =
  | 'pcm_8000'
  | 'pcm_16000'
  | 'pcm_22050'
  | 'pcm_24000'
  | 'pcm_44100'
  | 'pcm_48000'
  | 'ulaw_8000';

export type CommitStrategy = 'vad' | 'manual';

export type G711WireTransport = 'ulaw_8000' | 'pcm_8000_decoded';

export interface AudioProfileSpec {
  id: AudioProfileId;
  name: string;
  shortLabel: string;
  description: string;
  targetSampleRate: number | 'preserve';
  bandpassFilter: {
    enabled: boolean;
    highpassHz: number;
    lowpassHz: number;
  };
  muLawCompanding: boolean;
  defaultElevenLabsFormat: ElevenLabsAudioFormat;
  bitDepthLabel: string;
  bandwidthLabel: string;
}

export const AUDIO_PROFILES: Record<AudioProfileId, AudioProfileSpec> = {
  original: {
    id: 'original',
    name: 'Original Audio (Wideband PCM 16-bit)',
    shortLabel: 'Original (Wideband)',
    description:
      'Unfiltered mono 16-bit linear PCM at native/wideband sample rate (16 kHz–48 kHz). No telephone bandpass filtering or companding.',
    targetSampleRate: 'preserve',
    bandpassFilter: {
      enabled: false,
      highpassHz: 0,
      lowpassHz: 0,
    },
    muLawCompanding: false,
    defaultElevenLabsFormat: 'pcm_16000',
    bitDepthLabel: '16-bit Signed Linear PCM',
    bandwidthLabel: '256–768 kbps (16–48 kHz)',
  },
  pcm_8000: {
    id: 'pcm_8000',
    name: 'Telephone Band PCM (16-bit, 8000 Hz)',
    shortLabel: 'PCM 16-bit 8kHz',
    description:
      'ITU-T telephone-band filtered (300–3400 Hz cascaded Butterworth IIR), anti-aliased and resampled to 8000 Hz, encoded as mono 16-bit linear PCM.',
    targetSampleRate: 8000,
    bandpassFilter: {
      enabled: true,
      highpassHz: 300,
      lowpassHz: 3400,
    },
    muLawCompanding: false,
    defaultElevenLabsFormat: 'pcm_8000',
    bitDepthLabel: '16-bit Signed Linear PCM',
    bandwidthLabel: '128 kbps (8 kHz)',
  },
  ulaw_8000: {
    id: 'ulaw_8000',
    name: 'Simulated G.711 μ-law Telephone (8-bit, 8000 Hz)',
    shortLabel: 'G.711 μ-law 8kHz',
    description:
      'Authentic PSTN simulation: 300–3400 Hz telephone-band filtering, anti-aliased resampling to 8000 Hz, ITU-T G.711 μ-law (μ=255) 8-bit logarithmic encoding and decoding.',
    targetSampleRate: 8000,
    bandpassFilter: {
      enabled: true,
      highpassHz: 300,
      lowpassHz: 3400,
    },
    muLawCompanding: true,
    defaultElevenLabsFormat: 'ulaw_8000',
    bitDepthLabel: '8-bit ITU-T G.711 μ-law (14-bit dynamic range)',
    bandwidthLabel: '64 kbps (8 kHz)',
  },
};

export interface SessionConfigParams {
  modelId: 'scribe_v2_realtime';
  audioFormat: ElevenLabsAudioFormat;
  sampleRate: number;
  languageCode?: string;
  commitStrategy: CommitStrategy;
  vadSilenceThresholdSecs?: number;
  vadThreshold?: number;
  includeTimestamps: boolean;
}

// Client -> Server message according to ElevenLabs Scribe v2 Realtime AsyncAPI spec
export interface InputAudioChunkMessage {
  message_type: 'input_audio_chunk';
  audio_base_64: string;
  commit: boolean;
  sample_rate: number;
  previous_text?: string;
}

// Server -> Client messages according to ElevenLabs Scribe v2 Realtime AsyncAPI spec
export interface SessionStartedMessage {
  message_type: 'session_started';
  session_id: string;
  config: {
    sample_rate?: number;
    audio_format?: ElevenLabsAudioFormat;
    language_code?: string | null;
    commit_strategy?: CommitStrategy;
    vad_silence_threshold_secs?: number;
    vad_threshold?: number;
    min_speech_duration_ms?: number;
    min_silence_duration_ms?: number;
    model_id?: string;
    enable_logging?: boolean;
    include_timestamps?: boolean;
    include_language_detection?: boolean;
  };
}

export interface PartialTranscriptMessage {
  message_type: 'partial_transcript';
  text: string;
}

export interface CommittedTranscriptMessage {
  message_type: 'committed_transcript';
  text: string;
}

export interface TranscriptionWord {
  text: string;
  start?: number;
  end?: number;
  type?: 'word' | 'spacing';
  speaker_id?: string;
  logprob?: number;
  characters?: string[];
}

export interface CommittedTranscriptWithTimestampsMessage {
  message_type: 'committed_transcript_with_timestamps';
  text: string;
  language_code?: string | null;
  words?: TranscriptionWord[] | null;
}

export interface EditedTranscriptMessage {
  message_type: 'edited_transcript';
  text: string;
  edited_text: string;
}

export interface ScribeWarningMessage {
  message_type: 'warning';
  warning: string;
}

export type ScribeErrorType =
  | 'error'
  | 'auth_error'
  | 'quota_exceeded'
  | 'commit_throttled'
  | 'unaccepted_terms'
  | 'rate_limited'
  | 'queue_overflow'
  | 'resource_exhausted'
  | 'session_time_limit_exceeded'
  | 'input_error'
  | 'invalid_request'
  | 'chunk_size_exceeded'
  | 'insufficient_audio_activity'
  | 'transcriber_error';

export interface ScribeErrorMessage {
  message_type: ScribeErrorType;
  error: string;
}

export type ElevenLabsServerMessage =
  | SessionStartedMessage
  | PartialTranscriptMessage
  | CommittedTranscriptMessage
  | CommittedTranscriptWithTimestampsMessage
  | EditedTranscriptMessage
  | ScribeWarningMessage
  | ScribeErrorMessage;

export interface ProxyEnvelopedEvent {
  serverTimestampMs: number;
  payload: ElevenLabsServerMessage;
}

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'session_active'
  | 'committing'
  | 'error';

export type DiffOperation = 'hit' | 'substitution' | 'insertion' | 'deletion';

export interface AlignmentToken {
  op: DiffOperation;
  reference?: string;
  hypothesis?: string;
}

export interface AccuracyMetrics {
  wer: number; // 0..1+ (percentage = wer * 100)
  cer: number; // 0..1+ (percentage = cer * 100)
  wordAccuracy: number; // max(0, 1 - wer)
  charAccuracy: number; // max(0, 1 - cer)
  substitutions: number;
  deletions: number;
  insertions: number;
  hits: number;
  referenceWordCount: number;
  hypothesisWordCount: number;
  referenceCharCount: number;
  hypothesisCharCount: number;
  charSubstitutions: number;
  charDeletions: number;
  charInsertions: number;
  charHits: number;
  wordAlignment: AlignmentToken[];
}

export interface LatencyMetrics {
  handshakeLatencyMs: number | null;
  timeToFirstPartialMs: number | null;
  timeToFirstCommittedMs: number | null;
  lastPartialLatencyMs: number | null;
  averagePartialLatencyMs: number | null;
  lastCommittedLatencyMs: number | null;
  totalSessionDurationMs: number;
  audioDurationStreamedSec: number;
  chunksSent: number;
  bytesSent: number;
  partialEventCount: number;
  committedEventCount: number;
}

export type EvaluationLabel = 'correct' | 'incorrect' | null;

export type GladiaEncoding = 'wav/pcm' | 'wav/ulaw' | 'wav/alaw';

export interface GladiaProviderMetrics {
  sessionId: string | null;
  formatLabel: string; // e.g. 'wav/ulaw 8000Hz (8-bit)'
  finalTranscript: string;
  accuracy: AccuracyMetrics | null;
  confidence: number | null; // 0..1 average utterance confidence from Gladia
  handshakeLatencyMs: number | null;
  timeToFirstPartialMs: number | null;
  timeToFirstCommittedMs: number | null;
  lastCommittedLatencyMs: number | null;
  partialEventCount: number;
  committedEventCount: number;
}

export interface BenchmarkTestResult {
  id: string;
  createdAt: string;
  sourceType: 'microphone' | 'wav_upload';
  sourceName: string; // Scenario or test label
  profileId: AudioProfileId;
  profileName: string;
  g711WireTransport?: G711WireTransport;
  elevenLabsFormat: ElevenLabsAudioFormat;
  inputSampleRate: number;
  outputSampleRate: number;
  commitStrategy: CommitStrategy;
  languageCode: string;
  sessionId: string | null;
  finalTranscript: string;
  referenceTranscript: string;
  evaluationLabel?: EvaluationLabel;
  hasSavedAudio?: boolean;
  accuracy: AccuracyMetrics | null;
  latency: LatencyMetrics;
  // Gladia Live v2 (solaria-1) simultaneous comparison data
  gladia?: GladiaProviderMetrics | null;
  signalMetrics: {
    rmsDbFs: number;
    peakDbFs: number;
    quantizationSnrDb: number | null; // Measured SNR from G.711 mu-law quantization when applicable
  };
  warnings: string[];
  errors: string[];
}

