import type { AudioProfileId, GladiaEncoding } from '../types.js';

export type GladiaSampleRate = 8000 | 16000 | 32000 | 44100 | 48000;
export type GladiaBitDepth = 8 | 16 | 24 | 32;

export interface GladiaLiveInitRequest {
  profileId: AudioProfileId;
  sampleRate: number;
  languageCode?: string;
  endpointing?: number;
}

export interface GladiaLiveSessionPayload {
  encoding: GladiaEncoding;
  bit_depth: GladiaBitDepth;
  sample_rate: GladiaSampleRate;
  channels: 1;
  model: 'solaria-1';
  endpointing: number;
  maximum_duration_without_endpointing: number;
  language_config: {
    languages: string[];
    code_switching: boolean;
  };
  pre_processing: {
    audio_enhancer: boolean;
    speech_threshold: number;
  };
  messages_config: {
    receive_partial_transcripts: boolean;
    receive_final_transcripts: boolean;
    receive_speech_events: boolean;
    receive_pre_processing_events: boolean;
    receive_realtime_processing_events: boolean;
    receive_post_processing_events: boolean;
    receive_acknowledgments: boolean;
    receive_errors: boolean;
    receive_lifecycle_events: boolean;
  };
}

export interface GladiaLiveInitResponse {
  id: string;
  url: string;
  created_at?: string;
  gladiaFormat: {
    encoding: GladiaEncoding;
    bitDepth: GladiaBitDepth;
    sampleRate: GladiaSampleRate;
    label: string;
  };
}

export interface GladiaLiveWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface GladiaLiveUtterance {
  text: string;
  start: number;
  end: number;
  language?: string;
  confidence?: number;
  words?: GladiaLiveWord[];
}

export interface GladiaLiveEvent {
  type: string;
  session_id?: string;
  created_at?: string;
  error?: { message?: string } | string;
  data?: {
    id?: string;
    is_final?: boolean;
    utterance?: GladiaLiveUtterance;
    utterances?: GladiaLiveUtterance[];
    full_transcript?: string;
    languages?: string[];
    transcription?: {
      languages?: string[];
      utterances?: GladiaLiveUtterance[];
      full_transcript?: string;
    };
    time?: number;
  };
}

/**
 * Resolves the closest Gladia-supported sample rate (8000, 16000, 32000, 44100, 48000).
 */
export function resolveGladiaSampleRate(sampleRate: number): GladiaSampleRate {
  const supported: GladiaSampleRate[] = [8000, 16000, 32000, 44100, 48000];
  let best: GladiaSampleRate = 16000;
  let minDiff = Math.abs(sampleRate - best);
  for (const rate of supported) {
    const diff = Math.abs(sampleRate - rate);
    if (diff < minDiff) {
      minDiff = diff;
      best = rate;
    }
  }
  return best;
}

/**
 * Maps our Telephony STT Lab profile + sample rate to Gladia Live v2 audio configuration.
 * - 'ulaw_8000' -> encoding: 'wav/ulaw', bit_depth: 8, sample_rate: 8000
 * - 'pcm_8000'  -> encoding: 'wav/pcm',  bit_depth: 16, sample_rate: 8000
 * - 'original'  -> encoding: 'wav/pcm',  bit_depth: 16, sample_rate: 16000..48000
 */
export function resolveGladiaAudioFormat(
  profileId: AudioProfileId,
  sampleRate: number
): {
  encoding: GladiaEncoding;
  bitDepth: GladiaBitDepth;
  sampleRate: GladiaSampleRate;
  label: string;
} {
  if (profileId === 'ulaw_8000') {
    return {
      encoding: 'wav/ulaw',
      bitDepth: 8,
      sampleRate: 8000,
      label: 'wav/ulaw 8000Hz (8-bit)',
    };
  }
  if (profileId === 'pcm_8000') {
    return {
      encoding: 'wav/pcm',
      bitDepth: 16,
      sampleRate: 8000,
      label: 'wav/pcm 8000Hz (16-bit)',
    };
  }
  const resolvedRate = resolveGladiaSampleRate(sampleRate);
  return {
    encoding: 'wav/pcm',
    bitDepth: 16,
    sampleRate: resolvedRate,
    label: `wav/pcm ${resolvedRate}Hz (16-bit)`,
  };
}

/**
 * Builds the Gladia V2 Live initialization payload following the reference
 * integration from test-gladia-stt (model 'solaria-1').
 */
export function buildGladiaLiveSessionPayload(
  input: GladiaLiveInitRequest
): GladiaLiveSessionPayload {
  const format = resolveGladiaAudioFormat(input.profileId, input.sampleRate);
  const lang = input.languageCode?.trim().toLowerCase();
  const languages = lang && lang !== 'auto' ? [lang] : [];

  return {
    encoding: format.encoding,
    bit_depth: format.bitDepth,
    sample_rate: format.sampleRate,
    channels: 1,
    model: 'solaria-1',
    endpointing: input.endpointing ?? 0.2,
    maximum_duration_without_endpointing: 5,
    language_config: {
      languages,
      code_switching: languages.length === 0,
    },
    pre_processing: {
      audio_enhancer: false,
      speech_threshold: 0.5,
    },
    messages_config: {
      receive_partial_transcripts: true,
      receive_final_transcripts: true,
      receive_speech_events: true,
      receive_pre_processing_events: false,
      receive_realtime_processing_events: false,
      receive_post_processing_events: true,
      receive_acknowledgments: false,
      receive_errors: true,
      receive_lifecycle_events: true,
    },
  };
}
