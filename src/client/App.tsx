import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Mic,
  Square,
  AlertCircle,
  Download,
  Trash2,
  HelpCircle,
  Activity,
  Radio,
  Volume2,
  RefreshCw,
  Send,
  Sliders,
  BarChart3,
  Save,
  RotateCcw,
} from 'lucide-react';
import {
  AUDIO_PROFILES,
  type AudioProfileId,
  type BenchmarkTestResult,
  type CommitStrategy,
  type ConnectionStatus,
  type InputAudioChunkMessage,
  type ProxyEnvelopedEvent,
  type TranscriptionWord,
} from '../shared/types.js';
import {
  StreamingProfileProcessor,
  uint8ArrayToBase64,
} from '../shared/audio/profileProcessor.js';
import {
  computeSignalLevels,
  encodePcm16ToWav,
} from '../shared/audio/wavParser.js';
import { calculateAccuracyMetrics } from '../shared/metrics/werCer.js';
import {
  exportResultsToCsv,
  exportResultsToJson,
  loadSavedResults,
  saveResultsToStorage,
} from './services/storageAndExport.js';
import {
  clearAllTestAudioFromDb,
  deleteTestAudioFromDb,
  loadTestAudioFromDb,
  saveTestAudioToDb,
  triggerWavDownload,
} from './services/audioStorage.js';
import { WaveformMeter } from './components/WaveformMeter.js';
import { SetupGuideModal } from './components/SetupGuideModal.js';

interface CommittedSegment {
  id: string;
  text: string;
  languageCode?: string | null;
  words?: TranscriptionWord[] | null;
  timestampMs: number;
}

interface HealthInfo {
  status: string;
  apiKeyConfigured: boolean;
  maskedApiKey: string | null;
  upstreamEndpoint: string;
  warnings: string[];
}

interface SavedAudioPlayerProps {
  runId: string;
  profileId: AudioProfileId;
  hasSavedAudio?: boolean;
}

const SavedAudioPlayerCell: React.FC<SavedAudioPlayerProps> = ({
  runId,
  profileId,
  hasSavedAudio,
}) => {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [wavBytes, setWavBytes] = useState<Uint8Array | null>(null);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;

    if (!hasSavedAudio) {
      return undefined;
    }

    void loadTestAudioFromDb(runId).then((record) => {
      if (!active || !record) return;
      setWavBytes(record.wavBytes);
      const copy = new Uint8Array(record.wavBytes.byteLength);
      copy.set(record.wavBytes);
      const blob = new Blob([copy.buffer], { type: 'audio/wav' });
      createdUrl = URL.createObjectURL(blob);
      setAudioUrl(createdUrl);
    });

    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [runId, hasSavedAudio]);

  if (!hasSavedAudio || !audioUrl) {
    return <span className="text-muted">Sin audio</span>;
  }

  const handleDownload = () => {
    if (!wavBytes) return;
    triggerWavDownload(wavBytes, `audio-${profileId}-${runId.slice(-5)}.wav`);
  };

  return (
    <div className="saved-audio-cell">
      <audio controls src={audioUrl} className="audio-mini-player" preload="metadata" />
      <button
        className="btn btn-secondary btn-sm"
        onClick={handleDownload}
        title="Descargar archivo WAV procesado"
      >
        <Download size={13} /> WAV
      </button>
    </div>
  );
};

export const App: React.FC = () => {
  // Backend health state
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [healthLoading, setHealthLoading] = useState<boolean>(false);
  const [isGuideOpen, setIsGuideOpen] = useState<boolean>(false);

  // Telephony Profile selection (Microphone only)
  const [activeProfile, setActiveProfile] = useState<AudioProfileId>('original');

  // Simplified Session Config
  const [commitStrategy, setCommitStrategy] = useState<CommitStrategy>('vad');
  const [languageCode, setLanguageCode] = useState<string>('es');

  // Recorded & processed WAV buffer from the latest microphone test
  const [latestProcessedWavBytes, setLatestProcessedWavBytes] =
    useState<Uint8Array | null>(null);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);

  // Live Streaming & Connection state
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('disconnected');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  // Transcripts & Ground-Truth Correction
  const [partialTranscript, setPartialTranscript] = useState<string>('');
  const [committedSegments, setCommittedSegments] = useState<CommittedSegment[]>([]);
  const [realTranscript, setRealTranscript] = useState<string>('');
  const [isRealTranscriptEdited, setIsRealTranscriptEdited] =
    useState<boolean>(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Signal, Resampling & Telemetry state
  const [waveformSamples, setWaveformSamples] = useState<Float32Array | null>(null);
  const [rmsDbFs, setRmsDbFs] = useState<number>(-96);
  const [peakDbFs, setPeakDbFs] = useState<number>(-96);
  const [quantizationSnrDb, setQuantizationSnrDb] = useState<number | null>(null);
  const [inputSampleRate, setInputSampleRate] = useState<number>(48000);
  const [outputSampleRate, setOutputSampleRate] = useState<number>(48000);
  const [totalInputSamples, setTotalInputSamples] = useState<number>(0);
  const [totalOutputSamples, setTotalOutputSamples] = useState<number>(0);

  // Latency & Counters
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [handshakeLatencyMs, setHandshakeLatencyMs] = useState<number | null>(null);
  const [timeToFirstPartialMs, setTimeToFirstPartialMs] = useState<number | null>(null);
  const [timeToFirstCommittedMs, setTimeToFirstCommittedMs] = useState<number | null>(
    null
  );
  const [lastPartialLatencyMs, setLastPartialLatencyMs] = useState<number | null>(null);
  const [avgPartialLatencyMs, setAvgPartialLatencyMs] = useState<number | null>(null);
  const [lastCommittedLatencyMs, setLastCommittedLatencyMs] = useState<number | null>(
    null
  );
  const [chunksSent, setChunksSent] = useState<number>(0);
  const [bytesSent, setBytesSent] = useState<number>(0);
  const [audioDurationStreamedSec, setAudioDurationStreamedSec] = useState<number>(0);
  const [partialEventCount, setPartialEventCount] = useState<number>(0);
  const [committedEventCount, setCommittedEventCount] = useState<number>(0);

  // Saved Benchmark Results
  const [savedResults, setSavedResults] = useState<BenchmarkTestResult[]>(() =>
    loadSavedResults()
  );

  // Refs for real-time audio & WebSocket lifecycle
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const processedPcm16ChunksRef = useRef<Int16Array[]>([]);

  // Timing refs for accurate millisecond telemetry
  const connectInitiatedAtRef = useRef<number>(0);
  const firstChunkSentAtRef = useRef<number | null>(null);
  const lastChunkSentAtRef = useRef<number | null>(null);
  const partialLatenciesRef = useRef<number[]>([]);
  const isStoppingRef = useRef<boolean>(false);

  // Fetch backend health status
  const checkBackendHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as HealthInfo;
      setHealth(data);
    } catch (err) {
      setHealth({
        status: 'error',
        apiKeyConfigured: false,
        maskedApiKey: null,
        upstreamEndpoint: 'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
        warnings: [
          `Cannot reach backend proxy server (/api/health): ${
            err instanceof Error ? err.message : 'Network error'
          }`,
        ],
      });
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    void checkBackendHealth();
  }, [checkBackendHealth]);

  useEffect(() => {
    saveResultsToStorage(savedResults);
  }, [savedResults]);

  // Create object URL whenever latestProcessedWavBytes updates
  useEffect(() => {
    if (!latestProcessedWavBytes) {
      setPreviewAudioUrl(null);
      return undefined;
    }
    const copy = new Uint8Array(latestProcessedWavBytes.byteLength);
    copy.set(latestProcessedWavBytes);
    const blob = new Blob([copy.buffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    setPreviewAudioUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [latestProcessedWavBytes]);

  // Combined transcript text (committed segments + any non-duplicate trailing partial transcript)
  const fullTranscript = useMemo(() => {
    const trimmedSegments = committedSegments
      .map((s) => s.text.trim())
      .filter((t) => t.length > 0);
    const committedText = trimmedSegments.join(' ');
    const partial = partialTranscript.trim();
    const lastCommitted = trimmedSegments[trimmedSegments.length - 1] ?? '';

    if (
      partial &&
      lastCommitted &&
      partial.toLowerCase() === lastCommitted.toLowerCase()
    ) {
      return committedText;
    }

    if (committedText && partial) {
      return `${committedText} ${partial}`;
    }
    return committedText || partial;
  }, [committedSegments, partialTranscript]);

  // Keep Texto Real initially populated with the transcribed text until user edits it
  useEffect(() => {
    if (!isRealTranscriptEdited) {
      setRealTranscript(fullTranscript);
    }
  }, [fullTranscript, isRealTranscriptEdited]);

  // Live WER calculation comparing Texto Real (ground truth) vs Texto Transcrito (hypothesis)
  const liveAccuracy = useMemo(() => {
    if (!realTranscript.trim() && !fullTranscript.trim()) return null;
    return calculateAccuracyMetrics(realTranscript, fullTranscript);
  }, [realTranscript, fullTranscript]);

  // WER Summary across all saved tests (global and per telephony profile)
  const werSummary = useMemo(() => {
    const withAccuracy = savedResults.filter((r) => r.accuracy !== null);
    const globalAvgWer =
      withAccuracy.length > 0
        ? (withAccuracy.reduce((acc, r) => acc + (r.accuracy?.wer ?? 0), 0) /
            withAccuracy.length) *
          100
        : null;

    const byProfile = (Object.keys(AUDIO_PROFILES) as AudioProfileId[]).map(
      (pid) => {
        const runs = savedResults.filter((r) => r.profileId === pid);
        const runsWithWer = runs.filter((r) => r.accuracy !== null);
        const avgWer =
          runsWithWer.length > 0
            ? (runsWithWer.reduce((acc, r) => acc + (r.accuracy?.wer ?? 0), 0) /
                runsWithWer.length) *
              100
            : null;
        return {
          profileId: pid,
          label: AUDIO_PROFILES[pid].shortLabel,
          count: runs.length,
          avgWer,
        };
      }
    );

    return {
      totalRuns: savedResults.length,
      globalAvgWer,
      byProfile,
    };
  }, [savedResults]);

  // Clean up media & timers on unmount
  const cleanupAudioResources = useCallback(() => {
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    if (scriptNodeRef.current) {
      scriptNodeRef.current.disconnect();
      scriptNodeRef.current.onaudioprocess = null;
      scriptNodeRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cleanupAudioResources();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [cleanupAudioResources]);

  // Save a completed or active test result (including processed WAV audio, transcribed text, corrected real text, telephony profile, and WER)
  const saveCurrentTestResult = useCallback(async () => {
    const transcriptToSave = fullTranscript.trim();
    const referenceToSave = realTranscript.trim() || transcriptToSave;

    const accuracy =
      referenceToSave || transcriptToSave
        ? calculateAccuracyMetrics(referenceToSave, transcriptToSave)
        : null;

    const resolvedFormat =
      activeProfile === 'original'
        ? (`pcm_${outputSampleRate}` as BenchmarkTestResult['elevenLabsFormat'])
        : activeProfile === 'pcm_8000'
          ? 'pcm_8000'
          : 'ulaw_8000';

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const createdAt = new Date().toISOString();
    const hasAudio = Boolean(
      latestProcessedWavBytes && latestProcessedWavBytes.byteLength > 44
    );

    if (hasAudio && latestProcessedWavBytes) {
      await saveTestAudioToDb({
        id: runId,
        wavBytes: latestProcessedWavBytes,
        sampleRate: outputSampleRate,
        profileId: activeProfile,
        createdAt,
      });
    }

    const newResult: BenchmarkTestResult = {
      id: runId,
      createdAt,
      sourceType: 'microphone',
      sourceName: 'Micrófono',
      profileId: activeProfile,
      profileName: AUDIO_PROFILES[activeProfile].shortLabel,
      elevenLabsFormat: resolvedFormat,
      inputSampleRate,
      outputSampleRate,
      commitStrategy,
      languageCode: languageCode.trim() || 'auto',
      sessionId,
      finalTranscript: transcriptToSave,
      referenceTranscript: referenceToSave,
      evaluationLabel: accuracy ? (accuracy.wer === 0 ? 'correct' : 'incorrect') : null,
      hasSavedAudio: hasAudio,
      accuracy,
      latency: {
        handshakeLatencyMs,
        timeToFirstPartialMs,
        timeToFirstCommittedMs,
        lastPartialLatencyMs,
        averagePartialLatencyMs: avgPartialLatencyMs,
        lastCommittedLatencyMs,
        totalSessionDurationMs: elapsedMs,
        audioDurationStreamedSec,
        chunksSent,
        bytesSent,
        partialEventCount,
        committedEventCount,
      },
      signalMetrics: {
        rmsDbFs,
        peakDbFs,
        quantizationSnrDb,
      },
      warnings,
      errors,
    };

    setSavedResults((prev) => [newResult, ...prev]);
    return newResult;
  }, [
    fullTranscript,
    realTranscript,
    activeProfile,
    outputSampleRate,
    latestProcessedWavBytes,
    inputSampleRate,
    commitStrategy,
    languageCode,
    sessionId,
    handshakeLatencyMs,
    timeToFirstPartialMs,
    timeToFirstCommittedMs,
    lastPartialLatencyMs,
    avgPartialLatencyMs,
    lastCommittedLatencyMs,
    elapsedMs,
    audioDurationStreamedSec,
    chunksSent,
    bytesSent,
    partialEventCount,
    committedEventCount,
    rmsDbFs,
    peakDbFs,
    quantizationSnrDb,
    warnings,
    errors,
  ]);

  // Delete a single saved run + its audio in IndexedDB
  const handleDeleteSavedRun = (runId: string) => {
    setSavedResults((prev) => prev.filter((item) => item.id !== runId));
    void deleteTestAudioFromDb(runId);
  };

  // Clear all saved runs + all audio in IndexedDB
  const handleClearAllRuns = () => {
    setSavedResults([]);
    void clearAllTestAudioFromDb();
  };

  // Send manual commit chunk
  const handleManualCommit = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const silentBytes =
      activeProfile === 'ulaw_8000'
        ? new Uint8Array(160).fill(0xff)
        : new Uint8Array(Math.floor(outputSampleRate * 0.02) * 2);

    const commitMsg: InputAudioChunkMessage = {
      message_type: 'input_audio_chunk',
      audio_base_64: uint8ArrayToBase64(silentBytes),
      commit: true,
      sample_rate: outputSampleRate,
    };
    ws.send(JSON.stringify(commitMsg));
  };

  // Stop streaming & build processed WAV for playback/saving
  const handleStopStream = useCallback(() => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;
    setIsStreaming(false);
    cleanupAudioResources();

    // Combine processed PCM16 chunks at outputSampleRate into a playable/downloadable WAV file
    if (processedPcm16ChunksRef.current.length > 0) {
      const totalSamples = processedPcm16ChunksRef.current.reduce(
        (acc, chunk) => acc + chunk.length,
        0
      );
      const combinedPcm16 = new Int16Array(totalSamples);
      let offset = 0;
      for (const chunk of processedPcm16ChunksRef.current) {
        combinedPcm16.set(chunk, offset);
        offset += chunk.length;
      }
      const wavBytes = encodePcm16ToWav(combinedPcm16, outputSampleRate);
      setLatestProcessedWavBytes(wavBytes);
    }

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      setConnectionStatus('committing');
      const silentBytes =
        activeProfile === 'ulaw_8000'
          ? new Uint8Array(160).fill(0xff)
          : new Uint8Array(320);

      const finalChunk: InputAudioChunkMessage = {
        message_type: 'input_audio_chunk',
        audio_base_64: uint8ArrayToBase64(silentBytes),
        commit: true,
        sample_rate: outputSampleRate,
      };
      try {
        ws.send(JSON.stringify(finalChunk));
      } catch {
        // Ignore send errors on closing socket
      }

      window.setTimeout(() => {
        if (wsRef.current === ws) {
          ws.close(1000, 'Session completed');
          wsRef.current = null;
        }
        setConnectionStatus('disconnected');
        isStoppingRef.current = false;
      }, 1200);
    } else {
      setConnectionStatus('disconnected');
      isStoppingRef.current = false;
    }
  }, [cleanupAudioResources, activeProfile, outputSampleRate]);

  // Start Live Microphone Streaming Session
  const handleStartStream = async () => {
    if (isStreaming) return;

    // Reset session telemetry & state
    isStoppingRef.current = false;
    setErrors([]);
    setWarnings([]);
    setPartialTranscript('');
    setCommittedSegments([]);
    setRealTranscript('');
    setIsRealTranscriptEdited(false);
    setSessionId(null);
    setElapsedMs(0);
    setHandshakeLatencyMs(null);
    setTimeToFirstPartialMs(null);
    setTimeToFirstCommittedMs(null);
    setLastPartialLatencyMs(null);
    setAvgPartialLatencyMs(null);
    setLastCommittedLatencyMs(null);
    setChunksSent(0);
    setBytesSent(0);
    setAudioDurationStreamedSec(0);
    setPartialEventCount(0);
    setCommittedEventCount(0);
    setTotalInputSamples(0);
    setTotalOutputSamples(0);
    setLatestProcessedWavBytes(null);
    firstChunkSentAtRef.current = null;
    lastChunkSentAtRef.current = null;
    partialLatenciesRef.current = [];
    processedPcm16ChunksRef.current = [];

    let audioCtx: AudioContext;
    let stream: MediaStream;
    let sourceSampleRate = 48000;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      audioCtx = new AudioContext();
      sourceSampleRate = audioCtx.sampleRate;
      mediaStreamRef.current = stream;
      audioCtxRef.current = audioCtx;
    } catch (err) {
      setErrors([
        `No se pudo acceder al micrófono: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ]);
      return;
    }

    const processor = new StreamingProfileProcessor(
      activeProfile,
      sourceSampleRate,
      'ulaw_8000'
    );

    setInputSampleRate(processor.inputSampleRate);
    setOutputSampleRate(processor.outputSampleRate);

    // Open WebSocket connection to our Node.js secure proxy (/api/ws/stt)
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = new URL(`${wsProtocol}//${window.location.host}/api/ws/stt`);
    wsUrl.searchParams.set('audio_format', processor.elevenLabsFormat);
    wsUrl.searchParams.set('commit_strategy', commitStrategy);
    wsUrl.searchParams.set('include_timestamps', 'true');

    if (languageCode.trim()) {
      wsUrl.searchParams.set('language_code', languageCode.trim());
    }

    setConnectionStatus('connecting');
    connectInitiatedAtRef.current = performance.now();

    const ws = new WebSocket(wsUrl.toString());
    wsRef.current = ws;
    setIsStreaming(true);

    const startedAt = performance.now();
    elapsedTimerRef.current = window.setInterval(() => {
      setElapsedMs(Math.round(performance.now() - startedAt));
    }, 100);

    ws.onopen = () => {
      setConnectionStatus('connected');
    };

    ws.onmessage = (event) => {
      const nowPerf = performance.now();
      try {
        const envelope = JSON.parse(String(event.data)) as ProxyEnvelopedEvent;
        const msg = envelope.payload;

        switch (msg.message_type) {
          case 'session_started': {
            setSessionId(msg.session_id);
            setConnectionStatus('session_active');
            setHandshakeLatencyMs(
              Math.round(nowPerf - connectInitiatedAtRef.current)
            );
            break;
          }

          case 'partial_transcript': {
            setPartialTranscript(msg.text);
            if (msg.text.trim().length > 0) {
              setPartialEventCount((c) => c + 1);
              if (firstChunkSentAtRef.current !== null) {
                const sinceFirst = Math.round(nowPerf - firstChunkSentAtRef.current);
                setTimeToFirstPartialMs((prev) => (prev === null ? sinceFirst : prev));
              }
              if (lastChunkSentAtRef.current !== null) {
                const chunkLat = Math.max(
                  1,
                  Math.round(nowPerf - lastChunkSentAtRef.current)
                );
                setLastPartialLatencyMs(chunkLat);
                partialLatenciesRef.current.push(chunkLat);
                const sum = partialLatenciesRef.current.reduce((a, b) => a + b, 0);
                setAvgPartialLatencyMs(
                  Math.round(sum / partialLatenciesRef.current.length)
                );
              }
            }
            break;
          }

          case 'committed_transcript': {
            setPartialTranscript('');
            if (msg.text.trim().length > 0) {
              setCommittedEventCount((c) => c + 1);
              if (firstChunkSentAtRef.current !== null) {
                const sinceFirst = Math.round(nowPerf - firstChunkSentAtRef.current);
                setTimeToFirstCommittedMs((prev) =>
                  prev === null ? sinceFirst : prev
                );
              }
              if (lastChunkSentAtRef.current !== null) {
                setLastCommittedLatencyMs(
                  Math.max(1, Math.round(nowPerf - lastChunkSentAtRef.current))
                );
              }
              setCommittedSegments((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.text.trim() === msg.text.trim()) {
                  return prev;
                }
                return [
                  ...prev,
                  {
                    id: `seg_${Date.now()}_${prev.length}`,
                    text: msg.text,
                    timestampMs: Math.round(nowPerf - startedAt),
                  },
                ];
              });
            }
            break;
          }

          case 'committed_transcript_with_timestamps': {
            setPartialTranscript('');
            if (msg.text.trim().length > 0) {
              setCommittedSegments((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.text.trim() === msg.text.trim()) {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    ...last,
                    languageCode: msg.language_code,
                    words: msg.words,
                  };
                  return updated;
                }
                return [
                  ...prev,
                  {
                    id: `seg_${Date.now()}_${prev.length}`,
                    text: msg.text,
                    languageCode: msg.language_code,
                    words: msg.words,
                    timestampMs: Math.round(nowPerf - startedAt),
                  },
                ];
              });
            }
            break;
          }

          case 'edited_transcript': {
            setCommittedSegments((prev) => {
              if (prev.length === 0) return prev;
              const updated = [...prev];
              const last = updated[updated.length - 1]!;
              if (last.text === msg.text) {
                updated[updated.length - 1] = { ...last, text: msg.edited_text };
              }
              return updated;
            });
            break;
          }

          case 'warning': {
            setWarnings((prev) => [...prev, msg.warning]);
            break;
          }

          default: {
            if ('error' in msg) {
              setErrors((prev) => [...prev, `[${msg.message_type}] ${msg.error}`]);
              setConnectionStatus('error');
            }
            break;
          }
        }
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onerror = () => {
      setErrors((prev) => [
        ...prev,
        'WebSocket error communicating with backend proxy (/api/ws/stt).',
      ]);
      setConnectionStatus('error');
    };

    ws.onclose = () => {
      if (!isStoppingRef.current) {
        setIsStreaming(false);
        cleanupAudioResources();
        setConnectionStatus((prev) => (prev === 'error' ? 'error' : 'disconnected'));
      }
    };

    // Real-time Microphone Capture -> Bandpass Filter -> Anti-Aliased Resampler -> PCM16 / G.711 μ-law
    const micSource = audioCtx.createMediaStreamSource(stream);
    const scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
    scriptNodeRef.current = scriptNode;

    scriptNode.onaudioprocess = (audioEvent) => {
      if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
        return;
      }

      const inputData = audioEvent.inputBuffer.getChannelData(0);
      const copy = new Float32Array(inputData);

      const processed = processor.processChunk(copy);
      processedPcm16ChunksRef.current.push(processed.previewPcm16);

      const levels = computeSignalLevels(processed.previewPcm16);
      setRmsDbFs(levels.rmsDbFs);
      setPeakDbFs(levels.peakDbFs);
      if (processed.quantizationSnrDb !== null) {
        setQuantizationSnrDb(processed.quantizationSnrDb);
      }
      setWaveformSamples(copy.subarray(0, 1024));
      setTotalInputSamples((n) => n + copy.length);
      setTotalOutputSamples((n) => n + processed.previewPcm16.length);

      const chunkMsg: InputAudioChunkMessage = {
        message_type: 'input_audio_chunk',
        audio_base_64: processed.wireBase64,
        commit: false,
        sample_rate: processed.outputSampleRate,
      };

      if (ws.readyState === WebSocket.OPEN) {
        const now = performance.now();
        if (firstChunkSentAtRef.current === null) {
          firstChunkSentAtRef.current = now;
        }
        lastChunkSentAtRef.current = now;

        ws.send(JSON.stringify(chunkMsg));
        setChunksSent((c) => c + 1);
        setBytesSent((b) => b + processed.wireBytes.byteLength);
        setAudioDurationStreamedSec(
          (d) => d + copy.length / processor.inputSampleRate
        );
      }
    };

    micSource.connect(scriptNode);
    scriptNode.connect(audioCtx.destination);
  };

  const resamplingRatio =
    outputSampleRate > 0 ? (inputSampleRate / outputSampleRate).toFixed(2) : '1.00';

  return (
    <div className="app-shell">
      {/* Top Navigation & Status Header */}
      <header className="top-header">
        <div className="brand-block">
          <div className="brand-logo">
            <Radio size={22} />
          </div>
          <div>
            <h1>Telephony STT Lab</h1>
            <p className="brand-subtitle">
              ElevenLabs Scribe v2 Real-Time Telephony Benchmark
            </p>
          </div>
        </div>

        <div className="header-status-group">
          <div
            className={`api-status-pill ${
              health?.apiKeyConfigured ? 'configured' : 'missing'
            }`}
          >
            <span className="status-dot" />
            <span>
              API Key:{' '}
              {healthLoading
                ? 'Checking...'
                : health?.apiKeyConfigured
                  ? `Ready (${health.maskedApiKey})`
                  : 'Missing in .env'}
            </span>
            <button
              className="btn-inline-refresh"
              onClick={() => void checkBackendHealth()}
              title="Refresh backend health"
            >
              <RefreshCw size={13} />
            </button>
          </div>

          <div className={`conn-status-badge status-${connectionStatus}`}>
            <Activity size={14} />
            <span>{connectionStatus.replace('_', ' ').toUpperCase()}</span>
          </div>

          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setIsGuideOpen(true)}
          >
            <HelpCircle size={15} />
            <span>Guía</span>
          </button>
        </div>
      </header>

      {/* Warning banner if API key is missing */}
      {health && !health.apiKeyConfigured && (
        <div className="alert-banner alert-warning">
          <AlertCircle size={18} />
          <div className="alert-content">
            <strong>Falta ELEVENLABS_API_KEY:</strong> Configura{' '}
            <code>ELEVENLABS_API_KEY</code> en <code>.env</code> y pulsa refrescar.
          </div>
        </div>
      )}

      {/* Main Two-Column Workbench */}
      <main className="workbench-grid">
        {/* LEFT COLUMN: Configuration Options & Microphone Recording */}
        <section className="panel-column">
          {/* 1. Opciones de Configuración */}
          <div className="lab-card">
            <div className="card-header">
              <h2>
                <Sliders size={18} className="icon-accent" /> Opciones de Configuración
              </h2>
              <span className="badge-neutral">
                <Mic size={13} /> Micrófono
              </span>
            </div>

            <div className="form-row">
              <label>Telephony Profile</label>
              <div className="compact-profile-grid">
                {(Object.keys(AUDIO_PROFILES) as AudioProfileId[]).map((pid) => {
                  const spec = AUDIO_PROFILES[pid];
                  const isSelected = activeProfile === pid;
                  return (
                    <button
                      key={pid}
                      type="button"
                      className={`compact-profile-btn ${isSelected ? 'selected' : ''}`}
                      onClick={() => setActiveProfile(pid)}
                      disabled={isStreaming}
                    >
                      <span className="compact-profile-title">{spec.shortLabel}</span>
                      <div className="compact-profile-meta">
                        <span className={`profile-pill profile-${pid}`}>
                          {spec.defaultElevenLabsFormat}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="params-grid">
              <div className="form-group">
                <label htmlFor="lang-code-input">Idioma (ISO)</label>
                <input
                  id="lang-code-input"
                  type="text"
                  className="form-input"
                  placeholder="es, en (o vacío = auto)"
                  value={languageCode}
                  onChange={(e) => setLanguageCode(e.target.value)}
                  disabled={isStreaming}
                />
              </div>

              <div className="form-group">
                <label htmlFor="commit-strategy-select">Commit</label>
                <select
                  id="commit-strategy-select"
                  className="form-select"
                  value={commitStrategy}
                  onChange={(e) => setCommitStrategy(e.target.value as CommitStrategy)}
                  disabled={isStreaming}
                >
                  <option value="vad">VAD Automático</option>
                  <option value="manual">Manual</option>
                </select>
              </div>
            </div>
          </div>

          {/* 2. Grabación de Micrófono y Resampling DSP */}
          <div className="lab-card">
            <div className="stream-action-bar">
              <div className="primary-controls">
                {!isStreaming ? (
                  <button
                    className="btn btn-start"
                    onClick={() => void handleStartStream()}
                  >
                    <Mic size={18} /> Iniciar Grabación ({AUDIO_PROFILES[activeProfile].shortLabel})
                  </button>
                ) : (
                  <button className="btn btn-stop" onClick={handleStopStream}>
                    <Square size={18} /> Detener Micrófono
                  </button>
                )}

                {isStreaming && (
                  <button
                    className="btn btn-secondary"
                    onClick={handleManualCommit}
                    title="Send input_audio_chunk with commit: true"
                  >
                    <Send size={15} /> Commit Manual
                  </button>
                )}
              </div>

              <div className="session-id-readout">
                <span>Tiempo: </span>
                <code>{(elapsedMs / 1000).toFixed(1)}s</code>
              </div>
            </div>

            <WaveformMeter
              waveformSamples={waveformSamples}
              rmsDbFs={rmsDbFs}
              peakDbFs={peakDbFs}
              isStreaming={isStreaming}
              sourceType="microphone"
              activeProfile={activeProfile}
              progressPercent={0}
            />

            {/* Live Resampling & DSP Verification Banner */}
            <div className="resampling-confirm-bar">
              <span>
                <strong>Resampling DSP:</strong>{' '}
                <code>
                  {inputSampleRate} Hz → {outputSampleRate} Hz
                </code>{' '}
                (<code>{resamplingRatio}x</code>)
              </span>
              <span>
                Muestras:{' '}
                <code>
                  {totalInputSamples.toLocaleString()} in →{' '}
                  {totalOutputSamples.toLocaleString()} out
                </code>
              </span>
              <span>
                Filtro:{' '}
                <code>
                  {activeProfile === 'original' ? 'Sin filtro' : '300–3400 Hz'}
                </code>
              </span>
            </div>

            {/* Recorded & Processed Audio Player */}
            {previewAudioUrl && latestProcessedWavBytes && (
              <div className="audio-preview-bar">
                <div className="preview-label">
                  <Volume2 size={16} className="icon-accent" />
                  <span>
                    Audio Procesado (
                    <strong>{AUDIO_PROFILES[activeProfile].shortLabel}</strong>):
                  </span>
                </div>
                <div className="saved-audio-cell">
                  <audio controls src={previewAudioUrl} className="audio-element" />
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() =>
                      triggerWavDownload(
                        latestProcessedWavBytes,
                        `audio-${activeProfile}-${Date.now().toString().slice(-5)}.wav`
                      )
                    }
                  >
                    <Download size={14} /> WAV
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Errors & Warnings Display */}
          {(errors.length > 0 || warnings.length > 0) && (
            <div className="stream-alerts-stack">
              {errors.map((err, i) => (
                <div key={i} className="alert-banner alert-danger">
                  <AlertCircle size={16} />
                  <span>{err}</span>
                </div>
              ))}
              {warnings.map((warn, i) => (
                <div key={i} className="alert-banner alert-warning">
                  <AlertCircle size={16} />
                  <span>Warning: {warn}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* RIGHT COLUMN: Resultado Simple (Texto Transcrito, Texto Real Editable y Guardar) */}
        <section className="panel-column">
          <div className="lab-card transcript-card">
            <div className="card-header">
              <h2>Resultado de la Prueba</h2>
              <span className={`profile-pill profile-${activeProfile}`}>
                {AUDIO_PROFILES[activeProfile].shortLabel}
              </span>
            </div>

            {/* 1. Sección con el Texto Transcrito */}
            <div className="form-row">
              <label>1. Texto Transcrito (Scribe v2 Realtime)</label>
              <div className="transcript-viewport" style={{ minHeight: '95px' }}>
                {!fullTranscript ? (
                  <p className="transcript-placeholder">
                    {isStreaming
                      ? 'Escuchando micrófono... La transcripción aparecerá aquí.'
                      : 'Pulsa "Iniciar Grabación" para transcribir desde el micrófono.'}
                  </p>
                ) : (
                  <div className="transcript-flow">
                    <span className="committed-segment">{fullTranscript}</span>
                  </div>
                )}
              </div>
            </div>

            {/* 2. Sección con el Texto Real (inicializado con el texto transcrito para corregir errores) */}
            <div className="form-row">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <label htmlFor="real-transcript-textarea">
                  2. Texto Real (Corrige aquí los errores sobre el texto transcrito)
                </label>
                {isRealTranscriptEdited && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setRealTranscript(fullTranscript);
                      setIsRealTranscriptEdited(false);
                    }}
                    title="Restablecer al texto transcrito original"
                  >
                    <RotateCcw size={12} /> Restablecer al transcrito
                  </button>
                )}
              </div>
              <textarea
                id="real-transcript-textarea"
                className="form-textarea"
                rows={4}
                placeholder="Se rellena automáticamente con el texto transcrito para que solo tengas que corregir las palabras erróneas..."
                value={realTranscript}
                onChange={(e) => {
                  setIsRealTranscriptEdited(true);
                  setRealTranscript(e.target.value);
                }}
              />
            </div>

            {/* 3. Vista previa de WER + Botón de Guardar Resultado */}
            <div className="eval-controls-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div>
                  <span className="tel-label">WER Calculada: </span>
                  <strong
                    style={{
                      fontSize: '1.15rem',
                      color:
                        liveAccuracy === null
                          ? 'var(--text-secondary)'
                          : liveAccuracy.wer === 0
                            ? 'var(--success)'
                            : liveAccuracy.wer <= 0.2
                              ? 'var(--warning)'
                              : 'var(--danger)',
                    }}
                  >
                    {liveAccuracy !== null
                      ? `${(liveAccuracy.wer * 100).toFixed(1)}%`
                      : '0.0%'}
                  </strong>
                </div>
                {liveAccuracy && (
                  <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                    (Sustituciones: {liveAccuracy.substitutions} • Omisiones:{' '}
                    {liveAccuracy.deletions} • Inserciones: {liveAccuracy.insertions})
                  </span>
                )}
              </div>

              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveCurrentTestResult()}
                disabled={!fullTranscript && !latestProcessedWavBytes}
              >
                <Save size={16} /> Guardar Resultado
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* Bottom Section: Resumen de WER y Tabla de Resultados */}
      <section className="bottom-section lab-card">
        <div className="bottom-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <BarChart3 size={20} className="icon-accent" />
            <h2 style={{ margin: 0, fontSize: '1.05rem' }}>
              Resumen de WER y Tabla de Resultados ({savedResults.length})
            </h2>
          </div>

          <div className="export-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => exportResultsToCsv(savedResults)}
              disabled={savedResults.length === 0}
            >
              <Download size={14} /> Export CSV
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => exportResultsToJson(savedResults)}
              disabled={savedResults.length === 0}
            >
              <Download size={14} /> Export JSON
            </button>
            {savedResults.length > 0 && (
              <button
                className="btn btn-danger-outline btn-sm"
                onClick={handleClearAllRuns}
              >
                <Trash2 size={14} /> Borrar Todo
              </button>
            )}
          </div>
        </div>

        {/* Resumen de WER Global y por Telephony Profile */}
        <div
          className="accuracy-kpi-row"
          style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: '1rem' }}
        >
          <div className="kpi-box">
            <span className="kpi-title">WER Promedio Global ({werSummary.totalRuns} pruebas)</span>
            <span className="kpi-num">
              {werSummary.globalAvgWer !== null
                ? `${werSummary.globalAvgWer.toFixed(1)}%`
                : '—'}
            </span>
          </div>
          {werSummary.byProfile.map((p) => (
            <div key={p.profileId} className="kpi-box">
              <span className="kpi-title">
                {p.label} ({p.count} {p.count === 1 ? 'prueba' : 'pruebas'})
              </span>
              <span className="kpi-num">
                {p.avgWer !== null ? `${p.avgWer.toFixed(1)}%` : '—'}
              </span>
            </div>
          ))}
        </div>

        {/* Tabla de Resultados Guardados */}
        <div className="history-table-container">
          {savedResults.length === 0 ? (
            <p className="empty-history-msg">
              No hay resultados guardados todavía. Realiza una grabación, corrige el{' '}
              <strong>Texto Real</strong> si hubo algún error y pulsa{' '}
              <strong>"Guardar Resultado"</strong>.
            </p>
          ) : (
            <table className="benchmark-table">
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Telephony Profile</th>
                  <th>Resampling</th>
                  <th>Audio Guardado</th>
                  <th>Texto Transcrito</th>
                  <th>Texto Real (Corregido)</th>
                  <th>WER</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {savedResults.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.createdAt).toLocaleTimeString()}</td>
                    <td>
                      <span className={`profile-pill profile-${r.profileId}`}>
                        {AUDIO_PROFILES[r.profileId].shortLabel}
                      </span>{' '}
                      <small className="text-muted">({r.elevenLabsFormat})</small>
                    </td>
                    <td>
                      <code>
                        {r.inputSampleRate}→{r.outputSampleRate} Hz
                      </code>
                    </td>
                    <td>
                      <SavedAudioPlayerCell
                        runId={r.id}
                        profileId={r.profileId}
                        hasSavedAudio={r.hasSavedAudio}
                      />
                    </td>
                    <td className="td-transcript" title={r.finalTranscript}>
                      {r.finalTranscript || <em>(vacío)</em>}
                    </td>
                    <td className="td-transcript" title={r.referenceTranscript}>
                      {r.referenceTranscript || <em>(vacío)</em>}
                    </td>
                    <td>
                      {r.accuracy ? (
                        <strong
                          className={
                            r.accuracy.wer === 0
                              ? 'text-success'
                              : r.accuracy.wer <= 0.2
                                ? 'text-warning'
                                : 'text-danger'
                          }
                        >
                          {(r.accuracy.wer * 100).toFixed(1)}%
                        </strong>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <button
                        className="btn-icon-danger"
                        onClick={() => handleDeleteSavedRun(r.id)}
                        title="Eliminar resultado"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <SetupGuideModal
        isOpen={isGuideOpen}
        onClose={() => setIsGuideOpen(false)}
        apiKeyConfigured={Boolean(health?.apiKeyConfigured)}
        maskedApiKey={health?.maskedApiKey ?? null}
        upstreamEndpoint={
          health?.upstreamEndpoint ??
          'wss://api.elevenlabs.io/v1/speech-to-text/realtime'
        }
      />
    </div>
  );
};
