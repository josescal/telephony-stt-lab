import { describe, it, expect } from 'vitest';
import {
  getRegisteredEngines,
  createEngineAdapter,
  isEngineRegistered,
  ELEVENLABS_METADATA,
  GLADIA_METADATA,
  GOOGLE_METADATA,
} from '../src/engines/index.js';
import {
  resolveGoogleAudioFormat,
  normalizeGoogleLanguageCodes,
  resolveGoogleSttApiEndpoint,
} from '../src/shared/google/liveSession.js';
import {
  parseGoogleCredentialsJson,
  extractMultilineJsonFromEnvContent,
} from '../src/server/env.js';

describe('STT Engines Registry & Adapters', () => {
  it('registers built-in engines (ElevenLabs, Gladia, and Google STT v2)', () => {
    expect(isEngineRegistered('elevenlabs')).toBe(true);
    expect(isEngineRegistered('gladia')).toBe(true);
    expect(isEngineRegistered('google')).toBe(true);

    const engines = getRegisteredEngines();
    expect(engines.length).toBeGreaterThanOrEqual(3);

    const el = engines.find((e) => e.id === 'elevenlabs');
    expect(el).toBeDefined();
    expect(el?.name).toBe(ELEVENLABS_METADATA.name);
    expect(el?.capabilities.supportsUlaw8k).toBe(true);
    expect(el?.capabilities.supportsPcm8k).toBe(true);

    const gl = engines.find((e) => e.id === 'gladia');
    expect(gl).toBeDefined();
    expect(gl?.name).toBe(GLADIA_METADATA.name);
    expect(gl?.defaultModel).toBe('solaria-1');

    const go = engines.find((e) => e.id === 'google');
    expect(go).toBeDefined();
    expect(go?.name).toBe(GOOGLE_METADATA.name);
    expect(go?.defaultModel).toBe('chirp_3');
    expect(go?.capabilities.supportsUlaw8k).toBe(true);
    expect(go?.capabilities.supportsPcm8k).toBe(true);
  });

  it('instantiates ElevenLabsAdapter with correct initial status', () => {
    const adapter = createEngineAdapter('elevenlabs');
    expect(adapter.metadata.id).toBe('elevenlabs');
    expect(adapter.currentStatus).toBe('disconnected');
    expect(typeof adapter.connect).toBe('function');
    expect(typeof adapter.sendAudioChunk).toBe('function');
    expect(typeof adapter.disconnect).toBe('function');
  });

  it('instantiates GladiaAdapter with correct initial status', () => {
    const adapter = createEngineAdapter('gladia');
    expect(adapter.metadata.id).toBe('gladia');
    expect(adapter.currentStatus).toBe('disconnected');
    expect(typeof adapter.connect).toBe('function');
    expect(typeof adapter.sendAudioChunk).toBe('function');
    expect(typeof adapter.disconnect).toBe('function');
  });

  it('instantiates GoogleSttAdapter with correct initial status', () => {
    const adapter = createEngineAdapter('google');
    expect(adapter.metadata.id).toBe('google');
    expect(adapter.currentStatus).toBe('disconnected');
    expect(typeof adapter.connect).toBe('function');
    expect(typeof adapter.sendAudioChunk).toBe('function');
    expect(typeof adapter.disconnect).toBe('function');
  });

  it('throws when requesting an unknown engine', () => {
    expect(() => createEngineAdapter('unknown_engine' as any)).toThrow(
      /is not registered/
    );
  });
});

describe('Google Cloud STT v2 Helpers & Credentials Parser', () => {
  it('resolves Google explicitDecodingConfig for ulaw_8000, pcm_8000, and original profiles', () => {
    const ulaw = resolveGoogleAudioFormat('ulaw_8000', 8000);
    expect(ulaw.encoding).toBe('MULAW');
    expect(ulaw.sampleRateHertz).toBe(8000);
    expect(ulaw.audioChannelCount).toBe(1);

    const pcm8k = resolveGoogleAudioFormat('pcm_8000', 8000);
    expect(pcm8k.encoding).toBe('LINEAR16');
    expect(pcm8k.sampleRateHertz).toBe(8000);

    const orig = resolveGoogleAudioFormat('original', 48000);
    expect(orig.encoding).toBe('LINEAR16');
    expect(orig.sampleRateHertz).toBe(48000);
  });

  it('normalizes language codes to BCP-47 for Google STT v2', () => {
    expect(normalizeGoogleLanguageCodes('es')).toEqual(['es-ES']);
    expect(normalizeGoogleLanguageCodes('en')).toEqual(['en-US']);
    expect(normalizeGoogleLanguageCodes('es-MX')).toEqual(['es-MX']);
    expect(normalizeGoogleLanguageCodes('auto')).toEqual(['es-ES']);
  });

  it('resolves regional Google STT API endpoints', () => {
    expect(resolveGoogleSttApiEndpoint('eu')).toBe('eu-speech.googleapis.com');
    expect(resolveGoogleSttApiEndpoint('us')).toBe('us-speech.googleapis.com');
    expect(resolveGoogleSttApiEndpoint('global')).toBe('speech.googleapis.com');
  });

  it('parses inline GOOGLE_CREDENTIALS_JSON safely', () => {
    const validJson = JSON.stringify({
      project_id: 'my-gcp-project',
      client_email: 'stt-bot@my-gcp-project.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    });
    const parsed = parseGoogleCredentialsJson(validJson);
    expect(parsed).not.toBeNull();
    expect(parsed?.project_id).toBe('my-gcp-project');
    expect(parsed?.client_email).toContain('stt-bot@');

    expect(parseGoogleCredentialsJson('')).toBeNull();
    expect(parseGoogleCredentialsJson('invalid-json')).toBeNull();
  });

  it('parses multiline pretty-printed GOOGLE_CREDENTIALS_JSON with line breaks', () => {
    const multilineEnvContent = `
PORT=3001
GOOGLE_CREDENTIALS_JSON={
  "type": "service_account",
  "project_id": "multiline-gcp-project",
  "private_key_id": "123456",
  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\\n-----END PRIVATE KEY-----\\n",
  "client_email": "voice-agent@multiline-gcp-project.iam.gserviceaccount.com"
}
GOOGLE_STT_LOCATION=eu
`;
    const extracted = extractMultilineJsonFromEnvContent(
      multilineEnvContent,
      'GOOGLE_CREDENTIALS_JSON'
    );
    expect(extracted).not.toBeNull();
    const creds = parseGoogleCredentialsJson(extracted!);
    expect(creds).not.toBeNull();
    expect(creds?.project_id).toBe('multiline-gcp-project');
    expect(creds?.client_email).toBe(
      'voice-agent@multiline-gcp-project.iam.gserviceaccount.com'
    );
    expect(creds?.private_key).toContain('-----BEGIN PRIVATE KEY-----\n');
  });
});
