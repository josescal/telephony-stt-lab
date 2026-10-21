import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_FILE_PATH = path.resolve(__dirname, '../../.env');

dotenv.config({ path: ENV_FILE_PATH, override: true });

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
  GLADIA_API_KEY: z.string().optional().default(''),
  GLADIA_LIVE_URL: z
    .string()
    .url()
    .optional()
    .default('https://api.gladia.io/v2/live?region=eu-west'),
  GOOGLE_CREDENTIALS_JSON: z.string().optional().default(''),
  GOOGLE_CLOUD_PROJECT: z.string().optional().default(''),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional().default(''),
  GOOGLE_STT_LOCATION: z.string().optional().default('eu'),
  GOOGLE_STT_MODEL: z.string().optional().default('chirp_3'),
});

export interface GoogleServiceAccountCredentials {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export interface ValidatedEnv {
  port: number;
  elevenLabsApiKey: string;
  elevenLabsWsUrl: string;
  isApiKeyConfigured: boolean;
  maskedApiKey: string | null;
  gladiaApiKey: string;
  gladiaLiveUrl: string;
  isGladiaApiKeyConfigured: boolean;
  maskedGladiaApiKey: string | null;
  googleCredentials: GoogleServiceAccountCredentials | null;
  googleApplicationCredentialsPath: string;
  googleProjectId: string;
  googleLocation: string;
  googleModel: string;
  isGoogleConfigured: boolean;
  maskedGoogleKey: string | null;
  validationWarnings: string[];
}

const PLACEHOLDER_KEYS = new Set([
  '',
  'your_elevenlabs_api_key_here',
  'your_gladia_api_key_here',
  'your-api-key',
  'xi-api-key',
  'your_google_project_id_here',
]);

/**
 * Extracts a multiline JSON object assigned to `key=` in a `.env` file content,
 * even if the user pasted the pretty-printed JSON across multiple lines without
 * wrapping it in single quotes.
 */
export function extractMultilineJsonFromEnvContent(
  envContent: string,
  key = 'GOOGLE_CREDENTIALS_JSON'
): string | null {
  const regex = new RegExp(`^\\s*${key}\\s*=\\s*`, 'm');
  const match = regex.exec(envContent);
  if (!match) return null;

  let startIdx = match.index + match[0].length;
  while (startIdx < envContent.length && (envContent[startIdx] === ' ' || envContent[startIdx] === '\t')) {
    startIdx++;
  }

  // Strip optional leading quote (' or ")
  if (envContent[startIdx] === "'" || envContent[startIdx] === '"') {
    startIdx++;
  }

  const braceStart = envContent.indexOf('{', startIdx);
  if (braceStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = braceStart; i < envContent.length; i++) {
    const ch = envContent[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return envContent.slice(braceStart, i + 1);
        }
      }
    }
  }

  return null;
}

/**
 * Escapes literal newline/carriage-return characters that appear *inside* JSON string literals
 * so JSON.parse succeeds even if a multiline `private_key` had `\n` expanded.
 */
function sanitizeJsonStringNewlines(jsonText: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i]!;
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && ch === '\n') {
      out += '\\n';
      continue;
    }
    if (inString && ch === '\r') {
      continue;
    }
    out += ch;
  }

  return out;
}

export function parseGoogleCredentialsJson(
  rawJson: string
): GoogleServiceAccountCredentials | null {
  let trimmed = rawJson.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed || trimmed === '{}' || trimmed.startsWith('your_')) {
    return null;
  }
  try {
    const sanitized = sanitizeJsonStringNewlines(trimmed);
    const parsed = JSON.parse(sanitized) as Record<string, unknown>;
    const clientEmail =
      typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
    const rawPrivateKey =
      typeof parsed.private_key === 'string' ? parsed.private_key : '';
    const privateKey = rawPrivateKey.replace(/\\n/g, '\n').trim();
    const projectId =
      typeof parsed.project_id === 'string' ? parsed.project_id.trim() : undefined;

    if (!clientEmail || !privateKey) {
      return null;
    }
    return {
      client_email: clientEmail,
      private_key: privateKey,
      project_id: projectId,
    };
  } catch {
    return null;
  }
}

export function parseAndValidateEnv(
  rawEnv: Record<string, string | undefined> = process.env
): ValidatedEnv {
  if (rawEnv === process.env) {
    dotenv.config({ path: ENV_FILE_PATH, override: true });
  }
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

  const trimmedGladiaKey = parsed.data.GLADIA_API_KEY.trim();
  const isGladiaApiKeyConfigured =
    trimmedGladiaKey.length > 8 &&
    !PLACEHOLDER_KEYS.has(trimmedGladiaKey.toLowerCase());

  const validationWarnings: string[] = [];
  if (!isApiKeyConfigured) {
    validationWarnings.push(
      'ELEVENLABS_API_KEY is missing or set to a placeholder in .env. Live Scribe v2 Realtime WebSocket connections will be rejected until a valid ElevenLabs API key is configured.'
    );
  }

  const maskedApiKey = isApiKeyConfigured
    ? `${trimmedKey.slice(0, 4)}...${trimmedKey.slice(-4)}`
    : null;

  const maskedGladiaApiKey = isGladiaApiKeyConfigured
    ? `${trimmedGladiaKey.slice(0, 4)}...${trimmedGladiaKey.slice(-4)}`
    : null;

  let googleCredentials = parseGoogleCredentialsJson(
    parsed.data.GOOGLE_CREDENTIALS_JSON
  );
  if (!googleCredentials && rawEnv === process.env) {
    try {
      if (fs.existsSync(ENV_FILE_PATH)) {
        const rawEnvFile = fs.readFileSync(ENV_FILE_PATH, 'utf8');
        const extractedBlock = extractMultilineJsonFromEnvContent(
          rawEnvFile,
          'GOOGLE_CREDENTIALS_JSON'
        );
        if (extractedBlock) {
          googleCredentials = parseGoogleCredentialsJson(extractedBlock);
        }
      }
    } catch {
      // ignore fs read errors
    }
  }
  const googleApplicationCredentialsPath =
    parsed.data.GOOGLE_APPLICATION_CREDENTIALS.trim();
  const explicitProject = parsed.data.GOOGLE_CLOUD_PROJECT.trim();
  const googleProjectId =
    !PLACEHOLDER_KEYS.has(explicitProject.toLowerCase()) && explicitProject
      ? explicitProject
      : (googleCredentials?.project_id ?? '');
  const googleLocation = parsed.data.GOOGLE_STT_LOCATION.trim() || 'eu';
  const googleModel = parsed.data.GOOGLE_STT_MODEL.trim() || 'chirp_3';

  const hasValidCredentialsSource =
    Boolean(googleCredentials) || Boolean(googleApplicationCredentialsPath);
  const isGoogleConfigured =
    Boolean(googleProjectId) && hasValidCredentialsSource;

  if (
    parsed.data.GOOGLE_CREDENTIALS_JSON.trim() &&
    !googleCredentials
  ) {
    validationWarnings.push(
      'GOOGLE_CREDENTIALS_JSON in .env could not be parsed as a valid Service Account JSON with client_email and private_key.'
    );
  }

  const maskedGoogleKey = isGoogleConfigured
    ? `${googleProjectId} (${googleLocation}/${googleModel})`
    : null;

  return {
    port: parsed.data.PORT,
    elevenLabsApiKey: trimmedKey,
    elevenLabsWsUrl: parsed.data.ELEVENLABS_WS_URL,
    isApiKeyConfigured,
    maskedApiKey,
    gladiaApiKey: trimmedGladiaKey,
    gladiaLiveUrl: parsed.data.GLADIA_LIVE_URL,
    isGladiaApiKeyConfigured,
    maskedGladiaApiKey,
    googleCredentials,
    googleApplicationCredentialsPath,
    googleProjectId,
    googleLocation,
    googleModel,
    isGoogleConfigured,
    maskedGoogleKey,
    validationWarnings,
  };
}

