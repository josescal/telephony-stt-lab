import { describe, it, expect } from 'vitest';
import {
  calculateAccuracyMetrics,
  normalizeTranscriptText,
} from '../src/shared/metrics/werCer.js';
import { buildUpstreamElevenLabsUrl } from '../src/server/wsProxy.js';
import { parseAndValidateEnv } from '../src/server/env.js';

describe('WER and CER Accuracy Metrics Calculator', () => {
  it('returns 0% WER and 0% CER for identical transcripts ignoring case and punctuation', () => {
    const ref = 'Hello, world! Welcome to the Telephony STT Lab.';
    const hyp = 'hello world welcome to the telephony stt lab';

    const metrics = calculateAccuracyMetrics(ref, hyp);
    expect(metrics.wer).toBe(0);
    expect(metrics.cer).toBe(0);
    expect(metrics.wordAccuracy).toBe(1);
    expect(metrics.hits).toBe(8);
    expect(metrics.substitutions).toBe(0);
    expect(metrics.deletions).toBe(0);
    expect(metrics.insertions).toBe(0);
  });

  it('accurately counts substitutions, deletions, and insertions for WER and CER', () => {
    // Reference: 5 words ("the quick brown fox jumps")
    // Hypothesis: "the fast brown jumps over"
    // - "the" -> hit
    // - "quick" -> "fast" (1 substitution)
    // - "brown" -> hit
    // - "fox" -> deleted (1 deletion)
    // - "jumps" -> hit
    // - "over" -> inserted (1 insertion)
    // Total edits = 1 sub + 1 del + 1 ins = 3 / 5 = 0.60 (60% WER)
    const ref = 'the quick brown fox jumps';
    const hyp = 'the fast brown jumps over';

    const metrics = calculateAccuracyMetrics(ref, hyp);
    expect(metrics.referenceWordCount).toBe(5);
    expect(metrics.hypothesisWordCount).toBe(5);
    expect(metrics.substitutions).toBe(1);
    expect(metrics.deletions).toBe(1);
    expect(metrics.insertions).toBe(1);
    expect(metrics.hits).toBe(3);
    expect(metrics.wer).toBeCloseTo(0.6, 4);
    expect(metrics.wordAccuracy).toBeCloseTo(0.4, 4);
    expect(metrics.cer).toBeGreaterThan(0);
    expect(metrics.cer).toBeLessThan(0.6);
  });

  it('handles empty reference or empty hypothesis gracefully', () => {
    const emptyBoth = calculateAccuracyMetrics('', '');
    expect(emptyBoth.wer).toBe(0);
    expect(emptyBoth.cer).toBe(0);

    const emptyHyp = calculateAccuracyMetrics('testing one two three', '');
    expect(emptyHyp.wer).toBe(1);
    expect(emptyHyp.deletions).toBe(4);
    expect(emptyHyp.cer).toBe(1);

    const emptyRef = calculateAccuracyMetrics('', 'unexpected words');
    expect(emptyRef.wer).toBe(1);
    expect(emptyRef.insertions).toBe(2);
  });

  it('normalizes whitespace and punctuation properly', () => {
    expect(normalizeTranscriptText('  Hello,   WORLD!!  123 ')).toBe('hello world 123');
  });
});

describe('Environment Validation & ElevenLabs Upstream URL Builder', () => {
  it('builds the official ElevenLabs Scribe v2 Realtime WebSocket URL with query parameters', () => {
    const url = buildUpstreamElevenLabsUrl(
      'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
      {
        audio_format: 'ulaw_8000',
        language_code: 'en',
        commit_strategy: 'vad',
        vad_silence_threshold_secs: 1.2,
        vad_threshold: 0.45,
        include_timestamps: 'true',
      }
    );

    const parsed = new URL(url);
    expect(parsed.origin).toBe('wss://api.elevenlabs.io');
    expect(parsed.pathname).toBe('/v1/speech-to-text/realtime');
    expect(parsed.searchParams.get('model_id')).toBe('scribe_v2_realtime');
    expect(parsed.searchParams.get('audio_format')).toBe('ulaw_8000');
    expect(parsed.searchParams.get('language_code')).toBe('en');
    expect(parsed.searchParams.get('commit_strategy')).toBe('vad');
    expect(parsed.searchParams.get('vad_silence_threshold_secs')).toBe('1.2');
    expect(parsed.searchParams.get('vad_threshold')).toBe('0.45');
    expect(parsed.searchParams.get('include_timestamps')).toBe('true');
  });

  it('validates environment variables and masks API key', () => {
    const envWithKey = parseAndValidateEnv({
      PORT: '4000',
      ELEVENLABS_API_KEY: 'sk_1234567890abcdef1234',
      ELEVENLABS_WS_URL: 'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
    });
    expect(envWithKey.port).toBe(4000);
    expect(envWithKey.isApiKeyConfigured).toBe(true);
    expect(envWithKey.maskedApiKey).toBe('sk_1...1234');
    expect(envWithKey.validationWarnings).toHaveLength(0);

    const envPlaceholder = parseAndValidateEnv({
      PORT: '3001',
      ELEVENLABS_API_KEY: 'your_elevenlabs_api_key_here',
    });
    expect(envPlaceholder.isApiKeyConfigured).toBe(false);
    expect(envPlaceholder.validationWarnings.length).toBeGreaterThan(0);
  });
});
