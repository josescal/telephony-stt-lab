import type { AudioProfileId, TranscriptionWord } from '../types.js';

export type GoogleExplicitEncoding = 'MULAW' | 'LINEAR16';

export interface GoogleAudioFormatSpec {
  encoding: GoogleExplicitEncoding;
  sampleRateHertz: number;
  audioChannelCount: number;
  label: string;
}

/**
 * Maps a telephony audio profile + sample rate to Google Cloud Speech-to-Text V2
 * ExplicitDecodingConfig parameters.
 * - ulaw_8000 -> MULAW 8000Hz (8-bit G.711 u-law)
 * - pcm_8000 -> LINEAR16 8000Hz (16-bit signed little-endian PCM)
 * - original -> LINEAR16 at the session's native sample rate (16kHz-48kHz)
 */
export function resolveGoogleAudioFormat(
  profileId: AudioProfileId,
  sampleRate: number
): GoogleAudioFormatSpec {
  if (profileId === 'ulaw_8000') {
    return {
      encoding: 'MULAW',
      sampleRateHertz: 8000,
      audioChannelCount: 1,
      label: 'MULAW 8000Hz (8-bit)',
    };
  }

  if (profileId === 'pcm_8000') {
    return {
      encoding: 'LINEAR16',
      sampleRateHertz: 8000,
      audioChannelCount: 1,
      label: 'LINEAR16 8000Hz (16-bit)',
    };
  }

  const safeRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 16000;
  return {
    encoding: 'LINEAR16',
    sampleRateHertz: safeRate,
    audioChannelCount: 1,
    label: `LINEAR16 ${safeRate}Hz (16-bit)`,
  };
}

const SHORT_LANG_TO_BCP47: Record<string, string> = {
  es: 'es-ES',
  en: 'en-US',
  pt: 'pt-PT',
  fr: 'fr-FR',
  de: 'de-DE',
  it: 'it-IT',
  ca: 'ca-ES',
  eu: 'eu-ES',
  gl: 'gl-ES',
  nl: 'nl-NL',
  pl: 'pl-PL',
  ja: 'ja-JP',
  zh: 'cmn-Hans-CN',
};

/**
 * Normalizes a short ISO language code (e.g. 'es', 'en') or full BCP-47 tag ('es-MX')
 * into a list of valid BCP-47 language codes required by Google Cloud STT v2 (chirp_3).
 */
export function normalizeGoogleLanguageCodes(rawCode?: string): string[] {
  const trimmed = (rawCode ?? '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'auto') {
    return ['es-ES'];
  }

  if (trimmed.includes('-') || trimmed.includes('_')) {
    const parts = trimmed.replace('_', '-').split('-');
    if (parts.length >= 2) {
      return [`${parts[0]!.toLowerCase()}-${parts[1]!.toUpperCase()}`];
    }
  }

  const lower = trimmed.toLowerCase();
  return [SHORT_LANG_TO_BCP47[lower] ?? `${lower}-${lower.toUpperCase()}`];
}

/**
 * Builds the regional API endpoint for Google Cloud Speech-to-Text V2.
 */
export function resolveGoogleSttApiEndpoint(location: string): string {
  const loc = location.trim().toLowerCase() || 'eu';
  if (loc === 'global') {
    return 'speech.googleapis.com';
  }
  return `${loc}-speech.googleapis.com`;
}

// Messages sent from Backend /api/ws/google -> Browser Client
export interface GoogleProxySessionStartedMessage {
  type: 'session_started';
  sessionId: string;
  model: string;
  location: string;
  languageCodes: string[];
  format: GoogleAudioFormatSpec;
}

export interface GoogleProxyTranscriptMessage {
  type: 'transcript';
  text: string;
  isFinal: boolean;
  confidence?: number;
  languageCode?: string;
  words?: TranscriptionWord[];
  resultEndOffsetMs?: number;
}

export interface GoogleProxySpeechEventMessage {
  type: 'speech_event';
  event: string;
}

export interface GoogleProxyErrorMessage {
  type: 'error';
  error: string;
}

export type GoogleProxyServerMessage =
  | GoogleProxySessionStartedMessage
  | GoogleProxyTranscriptMessage
  | GoogleProxySpeechEventMessage
  | GoogleProxyErrorMessage;
