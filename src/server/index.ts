import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { parseAndValidateEnv } from './env.js';
import { attachSttWebSocketProxy } from './wsProxy.js';
import {
  DATA_DIR,
  ensureDataDirectories,
  readBenchmarksFromDisk,
  saveBenchmarkToDisk,
  deleteBenchmarkFromDisk,
  clearAllBenchmarksFromDisk,
  getAudioFilePath,
} from './benchmarkStore.js';
import type { BenchmarkTestResult } from '../shared/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createAppServer() {
  ensureDataDirectories();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

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
        dataDir: DATA_DIR,
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

  // Persistent Benchmark Results API (stored in /data/benchmarks.json and /data/audio/*.wav)
  app.get('/api/benchmarks', (_req, res) => {
    try {
      const results = readBenchmarksFromDisk();
      res.json({ results });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to read benchmarks from disk',
      });
    }
  });

  app.post('/api/benchmarks', (req, res) => {
    try {
      const body = req.body as {
        result?: BenchmarkTestResult;
        wavBase64?: string | null;
      };
      if (!body || !body.result || !body.result.id) {
        res.status(400).json({ error: 'Missing valid benchmark result payload' });
        return;
      }
      const saved = saveBenchmarkToDisk(body.result, body.wavBase64);
      res.status(201).json({ saved });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to save benchmark to disk',
      });
    }
  });

  app.get('/api/benchmarks/:id/audio', (req, res) => {
    const wavPath = getAudioFilePath(req.params.id);
    if (!fs.existsSync(wavPath)) {
      res.status(404).json({ error: 'Audio file not found in data/audio' });
      return;
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.sendFile(wavPath);
  });

  app.delete('/api/benchmarks/:id', (req, res) => {
    try {
      const updated = deleteBenchmarkFromDisk(req.params.id);
      res.json({ results: updated });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to delete benchmark',
      });
    }
  });

  app.delete('/api/benchmarks', (_req, res) => {
    try {
      clearAllBenchmarksFromDisk();
      res.json({ results: [] });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to clear benchmarks',
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
