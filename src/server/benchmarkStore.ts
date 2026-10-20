import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkTestResult } from '../shared/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root /data directory for persistent benchmark results and WAV files
export const DATA_DIR = path.resolve(__dirname, '../../data');
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');
export const BENCHMARKS_FILE = path.join(DATA_DIR, 'benchmarks.json');

export function ensureDataDirectories(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  }
  if (!fs.existsSync(BENCHMARKS_FILE)) {
    fs.writeFileSync(BENCHMARKS_FILE, JSON.stringify([], null, 2), 'utf8');
  }
}

export function readBenchmarksFromDisk(): BenchmarkTestResult[] {
  ensureDataDirectories();
  try {
    const raw = fs.readFileSync(BENCHMARKS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as BenchmarkTestResult[]) : [];
  } catch (err) {
    console.error('Error reading data/benchmarks.json:', err);
    return [];
  }
}

export function writeBenchmarksToDisk(results: BenchmarkTestResult[]): void {
  ensureDataDirectories();
  fs.writeFileSync(BENCHMARKS_FILE, JSON.stringify(results, null, 2), 'utf8');
}

export function sanitizeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_-]/g, '');
}

export function getAudioFilePath(runId: string): string {
  const safeId = sanitizeRunId(runId);
  return path.join(AUDIO_DIR, `${safeId}.wav`);
}

export function saveBenchmarkToDisk(
  result: BenchmarkTestResult,
  wavBase64?: string | null
): BenchmarkTestResult {
  ensureDataDirectories();

  let hasSavedAudio = Boolean(result.hasSavedAudio);
  if (wavBase64 && wavBase64.length > 0) {
    const audioBuffer = Buffer.from(wavBase64, 'base64');
    if (audioBuffer.byteLength > 44) {
      const wavPath = getAudioFilePath(result.id);
      fs.writeFileSync(wavPath, audioBuffer);
      hasSavedAudio = true;
    }
  }

  const savedItem: BenchmarkTestResult = {
    ...result,
    hasSavedAudio,
  };

  const existing = readBenchmarksFromDisk();
  const filtered = existing.filter((r) => r.id !== savedItem.id);
  const updated = [savedItem, ...filtered];
  writeBenchmarksToDisk(updated);

  return savedItem;
}

export function deleteBenchmarkFromDisk(runId: string): BenchmarkTestResult[] {
  ensureDataDirectories();
  const wavPath = getAudioFilePath(runId);
  if (fs.existsSync(wavPath)) {
    try {
      fs.unlinkSync(wavPath);
    } catch (err) {
      console.error(`Failed to delete audio file ${wavPath}:`, err);
    }
  }

  const existing = readBenchmarksFromDisk();
  const updated = existing.filter((r) => r.id !== runId);
  writeBenchmarksToDisk(updated);
  return updated;
}

export function clearAllBenchmarksFromDisk(): void {
  ensureDataDirectories();
  writeBenchmarksToDisk([]);

  try {
    const files = fs.readdirSync(AUDIO_DIR);
    for (const file of files) {
      if (file.endsWith('.wav')) {
        fs.unlinkSync(path.join(AUDIO_DIR, file));
      }
    }
  } catch (err) {
    console.error('Failed to clear data/audio directory:', err);
  }
}
