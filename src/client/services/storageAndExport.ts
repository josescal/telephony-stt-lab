import type { BenchmarkTestResult } from '../../shared/types.js';

const STORAGE_KEY_RESULTS = 'telephony_stt_lab_results_v1';
const STORAGE_KEY_REF_TEXT = 'telephony_stt_lab_ref_text_v1';

export function loadSavedResults(): BenchmarkTestResult[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_RESULTS);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as BenchmarkTestResult[]) : [];
  } catch {
    return [];
  }
}

export function saveResultsToStorage(results: BenchmarkTestResult[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_RESULTS, JSON.stringify(results));
  } catch (err) {
    console.error('Failed to save benchmark results to localStorage:', err);
  }
}

export function loadSavedReferenceText(): string {
  try {
    return localStorage.getItem(STORAGE_KEY_REF_TEXT) ?? '';
  } catch {
    return '';
  }
}

export function saveReferenceTextToStorage(text: string): void {
  try {
    localStorage.setItem(STORAGE_KEY_REF_TEXT, text);
  } catch {
    // Ignore storage quota errors
  }
}

export async function fetchBenchmarksFromServer(): Promise<BenchmarkTestResult[]> {
  const res = await fetch('/api/benchmarks');
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} loading benchmarks`);
  }
  const data = (await res.json()) as { results?: BenchmarkTestResult[] };
  return Array.isArray(data.results) ? data.results : [];
}

export async function persistBenchmarkToServer(
  result: BenchmarkTestResult,
  wavBase64?: string | null
): Promise<BenchmarkTestResult> {
  const res = await fetch('/api/benchmarks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result, wavBase64: wavBase64 ?? null }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} saving benchmark`);
  }
  const data = (await res.json()) as { saved: BenchmarkTestResult };
  return data.saved;
}

export async function deleteBenchmarkFromServer(runId: string): Promise<void> {
  await fetch(`/api/benchmarks/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
  });
}

export async function clearBenchmarksOnServer(): Promise<void> {
  await fetch('/api/benchmarks', {
    method: 'DELETE',
  });
}

function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function resultsToCsvString(results: BenchmarkTestResult[]): string {
  const headers = [
    'ID',
    'Timestamp',
    'Telephony Profile ID',
    'Telephony Profile Name',
    'Evaluation Label',
    'ElevenLabs Format',
    'Gladia Format',
    'Google Format',
    'Input Sample Rate (Hz)',
    'Output Sample Rate (Hz)',
    'Commit Strategy',
    'Language Code',
    'ElevenLabs Session ID',
    'Gladia Session ID',
    'Google Session ID',
    'ElevenLabs WER (%)',
    'ElevenLabs Word Accuracy (%)',
    'Gladia WER (%)',
    'Gladia Word Accuracy (%)',
    'Gladia Confidence (%)',
    'Google WER (%)',
    'Google Word Accuracy (%)',
    'Google Confidence (%)',
    'Winner',
    'ElevenLabs Substitutions',
    'ElevenLabs Deletions',
    'ElevenLabs Insertions',
    'Gladia Substitutions',
    'Gladia Deletions',
    'Gladia Insertions',
    'Google Substitutions',
    'Google Deletions',
    'Google Insertions',
    'ElevenLabs Handshake Latency (ms)',
    'ElevenLabs First Partial (ms)',
    'ElevenLabs First Committed (ms)',
    'Gladia Handshake Latency (ms)',
    'Gladia First Partial (ms)',
    'Gladia First Committed (ms)',
    'Google Handshake Latency (ms)',
    'Google First Partial (ms)',
    'Google First Committed (ms)',
    'Audio Duration (s)',
    'Total Session Time (ms)',
    'RMS Level (dBFS)',
    'Peak Level (dBFS)',
    'G.711 SQNR (dB)',
    'Reference Transcript (Ground Truth)',
    'ElevenLabs Final Transcript',
    'Gladia Final Transcript',
    'Google Final Transcript',
  ];

  const rows = results.map((r) => {
    const candidates: Array<{ name: string; wer: number }> = [];
    if (r.accuracy && (r.finalTranscript || r.sessionId)) {
      candidates.push({ name: 'ElevenLabs', wer: r.accuracy.wer });
    }
    if (r.gladia?.accuracy && (r.gladia.finalTranscript || r.gladia.sessionId)) {
      candidates.push({ name: 'Gladia', wer: r.gladia.accuracy.wer });
    }
    if (r.google?.accuracy && (r.google.finalTranscript || r.google.sessionId)) {
      candidates.push({ name: 'Google', wer: r.google.accuracy.wer });
    }

    let winner = '';
    if (candidates.length === 1) {
      winner = candidates[0]!.name;
    } else if (candidates.length > 1) {
      const minWer = Math.min(...candidates.map((c) => c.wer));
      const best = candidates.filter((c) => Math.abs(c.wer - minWer) < 1e-6);
      winner = best.length > 1 ? 'Tie' : best[0]!.name;
    }

    return [
      r.id,
      r.createdAt,
      r.profileId,
      r.profileName,
      r.evaluationLabel ?? 'unlabeled',
      r.elevenLabsFormat,
      r.gladia?.formatLabel ?? '',
      r.google?.formatLabel ?? '',
      r.inputSampleRate,
      r.outputSampleRate,
      r.commitStrategy,
      r.languageCode || 'auto',
      r.sessionId ?? '',
      r.gladia?.sessionId ?? '',
      r.google?.sessionId ?? '',
      r.accuracy ? (r.accuracy.wer * 100).toFixed(2) : '',
      r.accuracy ? (r.accuracy.wordAccuracy * 100).toFixed(2) : '',
      r.gladia?.accuracy ? (r.gladia.accuracy.wer * 100).toFixed(2) : '',
      r.gladia?.accuracy ? (r.gladia.accuracy.wordAccuracy * 100).toFixed(2) : '',
      r.gladia?.confidence !== null && r.gladia?.confidence !== undefined
        ? (r.gladia.confidence * 100).toFixed(1)
        : '',
      r.google?.accuracy ? (r.google.accuracy.wer * 100).toFixed(2) : '',
      r.google?.accuracy ? (r.google.accuracy.wordAccuracy * 100).toFixed(2) : '',
      r.google?.confidence !== null && r.google?.confidence !== undefined
        ? (r.google.confidence * 100).toFixed(1)
        : '',
      winner,
      r.accuracy?.substitutions ?? '',
      r.accuracy?.deletions ?? '',
      r.accuracy?.insertions ?? '',
      r.gladia?.accuracy?.substitutions ?? '',
      r.gladia?.accuracy?.deletions ?? '',
      r.gladia?.accuracy?.insertions ?? '',
      r.google?.accuracy?.substitutions ?? '',
      r.google?.accuracy?.deletions ?? '',
      r.google?.accuracy?.insertions ?? '',
      r.latency.handshakeLatencyMs ?? '',
      r.latency.timeToFirstPartialMs ?? '',
      r.latency.timeToFirstCommittedMs ?? '',
      r.gladia?.handshakeLatencyMs ?? '',
      r.gladia?.timeToFirstPartialMs ?? '',
      r.gladia?.timeToFirstCommittedMs ?? '',
      r.google?.handshakeLatencyMs ?? '',
      r.google?.timeToFirstPartialMs ?? '',
      r.google?.timeToFirstCommittedMs ?? '',
      r.latency.audioDurationStreamedSec.toFixed(2),
      r.latency.totalSessionDurationMs,
      r.signalMetrics.rmsDbFs,
      r.signalMetrics.peakDbFs,
      r.signalMetrics.quantizationSnrDb ?? '',
      r.referenceTranscript,
      r.finalTranscript,
      r.gladia?.finalTranscript ?? '',
      r.google?.finalTranscript ?? '',
    ];
  });

  const lines = [
    headers.map(escapeCsvCell).join(','),
    ...rows.map((row) => row.map(escapeCsvCell).join(',')),
  ];

  return lines.join('\n');
}

export function triggerFileDownload(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportResultsToCsv(results: BenchmarkTestResult[]): void {
  const csv = resultsToCsvString(results);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  triggerFileDownload(csv, `telephony-stt-benchmark-${stamp}.csv`, 'text/csv;charset=utf-8;');
}

export function exportResultsToJson(results: BenchmarkTestResult[]): void {
  const json = JSON.stringify(results, null, 2);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  triggerFileDownload(json, `telephony-stt-benchmark-${stamp}.json`, 'application/json');
}
