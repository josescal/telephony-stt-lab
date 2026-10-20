import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { parseAndValidateEnv } from './env.js';
import { attachSttWebSocketProxy } from './wsProxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createAppServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Re-read env dynamically on health checks so editing .env works smoothly
  const getEnv = () => parseAndValidateEnv(process.env);

  app.get('/api/health', (_req, res) => {
    try {
      const env = getEnv();
      res.json({
        status: 'ok',
        service: 'telephony-stt-lab-proxy',
        modelId: 'scribe_v2_realtime',
        apiKeyConfigured: env.isApiKeyConfigured,
        maskedApiKey: env.maskedApiKey,
        upstreamEndpoint: env.elevenLabsWsUrl,
        warnings: env.validationWarnings,
        supportedFormats: [
          'pcm_8000',
          'pcm_16000',
          'pcm_22050',
          'pcm_24000',
          'pcm_44100',
          'pcm_48000',
          'ulaw_8000',
        ],
      });
    } catch (err) {
      res.status(500).json({
        status: 'error',
        error: err instanceof Error ? err.message : 'Environment validation error',
      });
    }
  });

  // Serve built static frontend in production if dist/client exists
  const clientDistPath = path.resolve(__dirname, '../../dist/client');
  if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      res.sendFile(path.join(clientDistPath, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  attachSttWebSocketProxy(httpServer, getEnv);

  return { app, httpServer, getEnv };
}

// Start server if invoked directly
const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  try {
    const { httpServer, getEnv } = createAppServer();
    const env = getEnv();

    httpServer.listen(env.port, () => {
      console.log(`\n=============================================================`);
      console.log(`  Telephony STT Lab — Secure Proxy Server`);
      console.log(`  HTTP & WebSocket Proxy listening on: http://localhost:${env.port}`);
      console.log(`  Upstream Scribe v2 URL: ${env.elevenLabsWsUrl}`);
      console.log(
        `  ElevenLabs API Key: ${
          env.isApiKeyConfigured
            ? `Configured (${env.maskedApiKey})`
            : 'NOT CONFIGURED (set ELEVENLABS_API_KEY in .env)'
        }`
      );
      if (env.validationWarnings.length > 0) {
        for (const warning of env.validationWarnings) {
          console.warn(`  [WARNING] ${warning}`);
        }
      }
      console.log(`=============================================================\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}
