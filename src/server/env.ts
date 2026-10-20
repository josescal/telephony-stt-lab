import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  PORT: z
    .string()
    .optional()
    .default('3001')
    .transform((val) => Number(val))
    .refine((port) => Number.isInteger(port) && port > 0 && port <= 65535, {
      message: 'PORT must be a valid TCP port number (1-65535)',
    }),
  ELEVENLABS_API_KEY: z.string().optional().default(''),
  ELEVENLABS_WS_URL: z
    .string()
    .url()
    .optional()
    .default('wss://api.elevenlabs.io/v1/speech-to-text/realtime')
    .refine((url) => url.startsWith('wss://') || url.startsWith('ws://'), {
      message: 'ELEVENLABS_WS_URL must use ws:// or wss:// protocol',
    }),
});

export interface ValidatedEnv {
  port: number;
  elevenLabsApiKey: string;
  elevenLabsWsUrl: string;
  isApiKeyConfigured: boolean;
  maskedApiKey: string | null;
  validationWarnings: string[];
}

const PLACEHOLDER_KEYS = new Set([
  '',
  'your_elevenlabs_api_key_here',
  'your-api-key',
  'xi-api-key',
]);

export function parseAndValidateEnv(
  rawEnv: Record<string, string | undefined> = process.env
): ValidatedEnv {
  const parsed = EnvSchema.safeParse(rawEnv);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Environment validation failed: ${issues}`);
  }

  const trimmedKey = parsed.data.ELEVENLABS_API_KEY.trim();
  const isApiKeyConfigured =
    trimmedKey.length > 8 && !PLACEHOLDER_KEYS.has(trimmedKey.toLowerCase());

  const validationWarnings: string[] = [];
  if (!isApiKeyConfigured) {
    validationWarnings.push(
      'ELEVENLABS_API_KEY is missing or set to a placeholder in .env. Live Scribe v2 Realtime WebSocket connections will be rejected until a valid ElevenLabs API key is configured.'
    );
  }

  const maskedApiKey = isApiKeyConfigured
    ? `${trimmedKey.slice(0, 4)}...${trimmedKey.slice(-4)}`
    : null;

  return {
    port: parsed.data.PORT,
    elevenLabsApiKey: trimmedKey,
    elevenLabsWsUrl: parsed.data.ELEVENLABS_WS_URL,
    isApiKeyConfigured,
    maskedApiKey,
    validationWarnings,
  };
}
