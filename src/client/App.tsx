import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Mic,
  Square,
  AlertCircle,
  CheckCircle2,
  Info,
  X,
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
  Trophy,
} from 'lucide-react';
import {
  AUDIO_PROFILES,
  type AudioProfileId,
  type BenchmarkTestResult,
  type CommitStrategy,
  type ConnectionStatus,
  type GladiaProviderMetrics,
  type GoogleProviderMetrics,
  type InputAudioChunkMessage,
  type ProxyEnvelopedEvent,
  type TranscriptionWord,
} from '../shared/types.js';
import {
  StreamingMicrophoneAgc,
  StreamingProfileProcessor,
  uint8ArrayToBase64,
} from '../shared/audio/profileProcessor.js';
import {
  computeSignalLevels,
  encodeMuLawToWav,
  encodePcm16ToWav,
  pcm16ToLittleEndianBytes,
} from '../shared/audio/wavParser.js';
import { decodeMuLawToPcm16, float32ToPcm16 } from '../shared/audio/mulaw.js';
import { StreamingResampler } from '../shared/audio/resampler.js';
import {
  calculateAccuracyMetrics,
  normalizeSpanishAlphanumericText,
} from '../shared/metrics/werCer.js';
import {
  resolveGladiaAudioFormat,
  type GladiaLiveEvent,
  type GladiaLiveInitResponse,
} from '../shared/gladia/liveSession.js';
import {
  resolveGoogleAudioFormat,
  type GoogleProxyServerMessage,
} from '../shared/google/liveSession.js';
import {
  clearBenchmarksOnServer,
  deleteBenchmarkFromServer,
  exportResultsToCsv,
  exportResultsToJson,
  fetchBenchmarksFromServer,
  loadSavedResults,
  persistBenchmarkToServer,
  saveResultsToStorage,
} from './services/storageAndExport.js';
import {
  clearAllTestAudioFromDb,
  deleteTestAudioFromDb,
  loadTestAudioFromDb,
  saveTestAudioToDb,
  triggerWavDownload,
} from './services/audioStorage.js';
import { SetupGuideModal } from './components/SetupGuideModal.js';
import {
  getRegisteredEngines,
  type EngineId,
} from '../engines/index.js';
import { EngineSelectorBar } from './components/engines/EngineSelectorBar.js';


/**
 * Creates a browser-playable WAV Blob URL from raw WAV bytes.
 * If the WAV uses ITU-T G.711 μ-law (format 0x0007), decodes the μ-law payload
 * to 16-bit PCM solely for the <audio> element so all browsers can play it inline,
 * while keeping the saved/downloaded file on disk as authentic 8-bit μ-law.
 */
function createPlayableWavBlobUrl(wavBytes: Uint8Array): string {
  if (wavBytes.byteLength > 44) {
    const view = new DataView(
      wavBytes.buffer,
      wavBytes.byteOffset,
      wavBytes.byteLength
    );
    const formatCode = view.getUint16(20, true);
    const sampleRate = view.getUint32(24, true) || 8000;
    if (formatCode === 7) {
      const muLawPayload = wavBytes.subarray(44);
      const pcm16 = decodeMuLawToPcm16(muLawPayload);
      const playableWav = encodePcm16ToWav(pcm16, sampleRate);
      const copy = new Uint8Array(playableWav.byteLength);
      copy.set(playableWav);
      return URL.createObjectURL(new Blob([copy.buffer], { type: 'audio/wav' }));
    }
  }
  const copy = new Uint8Array(wavBytes.byteLength);
  copy.set(wavBytes);
  return URL.createObjectURL(new Blob([copy.buffer], { type: 'audio/wav' }));
}

interface CommittedSegment {
  id: string;
  text: string;
  languageCode?: string | null;
  words?: TranscriptionWord[] | null;
  confidence?: number;
  timestampMs: number;
}

interface HealthInfo {
  status: string;
  apiKeyConfigured: boolean;
  maskedApiKey: string | null;
  gladiaApiKeyConfigured?: boolean;
  maskedGladiaApiKey?: string | null;
  googleConfigured?: boolean;
  maskedGoogleKey?: string | null;
  googleModelId?: string;
  googleLocation?: string;
  upstreamEndpoint: string;
  gladiaLiveUrl?: string;
  warnings: string[];
}

interface AppNotification {
  id: string;
  type: 'success' | 'warning' | 'error' | 'info';
  message: string;
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
  const serverAudioUrl = `/api/benchmarks/${encodeURIComponent(runId)}/audio`;
  const [audioUrl, setAudioUrl] = useState<string | null>(
    hasSavedAudio ? serverAudioUrl : null
  );
  const [fallbackWavBytes, setFallbackWavBytes] = useState<Uint8Array | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    if (hasSavedAudio) {
      setAudioUrl(serverAudioUrl);
      setFallbackWavBytes(null);
      return;
    }

    // Check IndexedDB in case audio was stored locally in browser
    void loadTestAudioFromDb(runId).then((record) => {
      if (cancelled || !record?.wavBytes) {
        if (!cancelled) setAudioUrl(null);
        return;
      }
      setFallbackWavBytes(record.wavBytes);
      const url = createPlayableWavBlobUrl(record.wavBytes);
      blobUrlRef.current = url;
      setAudioUrl(url);
    });

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [runId, hasSavedAudio, serverAudioUrl]);

  const handleAudioError = () => {
    if (audioUrl?.startsWith('blob:')) return;

    void (async () => {
      try {
        const res = await fetch(serverAudioUrl);
        if (res.ok) {
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          setFallbackWavBytes(bytes);
          if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
          const url = createPlayableWavBlobUrl(bytes);
          blobUrlRef.current = url;
          setAudioUrl(url);
          return;
        }
      } catch {
        // Ignore fetch error and try IndexedDB next
      }

      const record = await loadTestAudioFromDb(runId);
      if (!record?.wavBytes) return;
      setFallbackWavBytes(record.wavBytes);
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      const url = createPlayableWavBlobUrl(record.wavBytes);
      blobUrlRef.current = url;
      setAudioUrl(url);
    })();
  };

  if (!audioUrl) {
    return <span className="text-muted">Sin audio</span>;
  }

  const handleDownload = () => {
    const filename = `audio-${profileId}-${runId.slice(-5)}.wav`;
    if (fallbackWavBytes) {
      triggerWavDownload(fallbackWavBytes, filename);
      return;
    }
    const link = document.createElement('a');
    link.href = serverAudioUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="saved-audio-cell">
      <audio
        controls
        src={audioUrl}
        onError={handleAudioError}
        className="audio-mini-player"
        preload="metadata"
      />
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

function formatWerBadgeClass(wer: number | null | undefined): string {
  if (wer === null || wer === undefined) return 'text-muted';
  if (wer === 0) return 'text-success';
  if (wer <= 0.2) return 'text-warning';
  return 'text-danger';
}

export const App: React.FC = () => {
  // Backend health state
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [healthLoading, setHealthLoading] = useState<boolean>(false);
  const [isGuideOpen, setIsGuideOpen] = useState<boolean>(false);

  // Telephony Profile selection (Microphone only) — persisted in cookie
  const [activeProfile, setActiveProfile] = useState<AudioProfileId>(() => {
    try {
      const match = document.cookie
        .split('; ')
        .find((row) => row.startsWith('scribe_active_profile='));
      const saved = match ? decodeURIComponent(match.split('=')[1] ?? '') : null;
      if (saved === 'original' || saved === 'pcm_8000' || saved === 'ulaw_8000') {
        return saved;
      }
    } catch {
      // ignore cookie errors
    }
    return 'ulaw_8000';
  });

  useEffect(() => {
    try {
      document.cookie = `scribe_active_profile=${encodeURIComponent(activeProfile)}; path=/; max-age=31536000; SameSite=Lax`;
    } catch {
      // ignore cookie errors
    }
  }, [activeProfile]);

  // Simplified Session Config
  const [commitStrategy, setCommitStrategy] = useState<CommitStrategy>('vad');
  const [languageCode, setLanguageCode] = useState<string>('es');

  // Recorded & processed WAV buffer from the latest microphone test
  const [latestProcessedWavBytes, setLatestProcessedWavBytes] =
    useState<Uint8Array | null>(null);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);

  // Multi-engine registered list & user selection
  const registeredEngines = useMemo(() => getRegisteredEngines(), []);
  const [selectedEngineIds, setSelectedEngineIds] = useState<EngineId[]>([
    'elevenlabs',
    'gladia',
    'google',
  ]);

  const handleToggleEngine = useCallback((id: EngineId) => {
    setSelectedEngineIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length <= 1) return prev; // Keep at least one engine active
        return prev.filter((e) => e !== id);
      }
      return [...prev, id];
    });
  }, []);

  // ElevenLabs Live Streaming & Connection state
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('disconnected');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  // Gladia Live Streaming & Connection state
  const [gladiaStatus, setGladiaStatus] =
    useState<ConnectionStatus>('disconnected');
  const [gladiaSessionId, setGladiaSessionId] = useState<string | null>(null);
  const [gladiaFormatLabel, setGladiaFormatLabel] = useState<string>(
    resolveGladiaAudioFormat(activeProfile, 8000).label
  );

  // Google STT v2 (Chirp 3) Live Streaming & Connection state
  const [googleStatus, setGoogleStatus] =
    useState<ConnectionStatus>('disconnected');
  const [googleSessionId, setGoogleSessionId] = useState<string | null>(null);
  const [googleFormatLabel, setGoogleFormatLabel] = useState<string>(
    resolveGoogleAudioFormat(activeProfile, 8000).label
  );

  // ElevenLabs Transcripts
  const [partialTranscript, setPartialTranscript] = useState<string>('');
  const [committedSegments, setCommittedSegments] = useState<CommittedSegment[]>([]);

  // Gladia Transcripts
  const [gladiaPartialTranscript, setGladiaPartialTranscript] = useState<string>('');
  const [gladiaCommittedSegments, setGladiaCommittedSegments] = useState<
    CommittedSegment[]
  >([]);

  // Google STT v2 Transcripts
  const [googlePartialTranscript, setGooglePartialTranscript] = useState<string>('');
  const [googleCommittedSegments, setGoogleCommittedSegments] = useState<
    CommittedSegment[]
  >([]);

  // Shared Ground-Truth Correction (Texto Real)
  const [realTranscript, setRealTranscript] = useState<string>('');
  const [isRealTranscriptEdited, setIsRealTranscriptEdited] =
    useState<boolean>(false);
  const [normalizeAlphanumeric, setNormalizeAlphanumeric] =
    useState<boolean>(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Signal, Resampling & Telemetry state
  const [rmsDbFs, setRmsDbFs] = useState<number>(-96);
  const [peakDbFs, setPeakDbFs] = useState<number>(-96);
  const [quantizationSnrDb, setQuantizationSnrDb] = useState<number | null>(null);
  const [inputSampleRate, setInputSampleRate] = useState<number>(48000);
  const [outputSampleRate, setOutputSampleRate] = useState<number>(48000);
  const [_totalInputSamples, setTotalInputSamples] = useState<number>(0);
  const [_totalOutputSamples, setTotalOutputSamples] = useState<number>(0);

  // ElevenLabs Latency & Counters
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

  // Gladia Latency & Counters
  const [gladiaHandshakeLatencyMs, setGladiaHandshakeLatencyMs] = useState<
    number | null
  >(null);
  const [gladiaTimeToFirstPartialMs, setGladiaTimeToFirstPartialMs] = useState<
    number | null
  >(null);
  const [gladiaTimeToFirstCommittedMs, setGladiaTimeToFirstCommittedMs] = useState<
    number | null
  >(null);
  const [gladiaLastCommittedLatencyMs, setGladiaLastCommittedLatencyMs] = useState<
    number | null
  >(null);
  const [gladiaPartialEventCount, setGladiaPartialEventCount] = useState<number>(0);
  const [gladiaCommittedEventCount, setGladiaCommittedEventCount] =
    useState<number>(0);

  // Google STT v2 Latency & Counters
  const [googleHandshakeLatencyMs, setGoogleHandshakeLatencyMs] = useState<
    number | null
  >(null);
  const [googleTimeToFirstPartialMs, setGoogleTimeToFirstPartialMs] = useState<
    number | null
  >(null);
  const [googleTimeToFirstCommittedMs, setGoogleTimeToFirstCommittedMs] = useState<
    number | null
  >(null);
  const [googleLastCommittedLatencyMs, setGoogleLastCommittedLatencyMs] = useState<
    number | null
  >(null);
  const [googlePartialEventCount, setGooglePartialEventCount] = useState<number>(0);
  const [googleCommittedEventCount, setGoogleCommittedEventCount] =
    useState<number>(0);

  // Saved Benchmark Results
  const [savedResults, setSavedResults] = useState<BenchmarkTestResult[]>(() =>
    loadSavedResults()
  );
  const [isCurrentTestSaved, setIsCurrentTestSaved] = useState<boolean>(false);
  const [isSavingTest, setIsSavingTest] = useState<boolean>(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  // Refs for real-time audio & Triple WebSocket lifecycle
  const wsRef = useRef<WebSocket | null>(null);
  const gladiaWsRef = useRef<WebSocket | null>(null);
  const googleWsRef = useRef<WebSocket | null>(null);
  const elPendingChunksRef = useRef<string[]>([]);
  const gladiaPendingBinaryRef = useRef<ArrayBuffer[]>([]);
  const googlePendingBinaryRef = useRef<ArrayBuffer[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const processedPcm16ChunksRef = useRef<Int16Array[]>([]);
  const processedMuLawChunksRef = useRef<Uint8Array[]>([]);
  const latestProcessedWavBytesRef = useRef<Uint8Array | null>(null);
  const sessionOutputSampleRateRef = useRef<number>(48000);
  const sessionProfileRef = useRef<AudioProfileId>(activeProfile);
  const currentTestSavedRef = useRef<boolean>(false);

  // Timing refs for accurate millisecond telemetry
  const connectInitiatedAtRef = useRef<number>(0);
  const gladiaConnectInitiatedAtRef = useRef<number>(0);
  const googleConnectInitiatedAtRef = useRef<number>(0);
  const firstChunkSentAtRef = useRef<number | null>(null);
  const lastChunkSentAtRef = useRef<number | null>(null);
  const gladiaSpeechEndedAtRef = useRef<number | null>(null);
  const googleSpeechEndedAtRef = useRef<number | null>(null);
  const partialLatenciesRef = useRef<number[]>([]);
  const isStoppingRef = useRef<boolean>(false);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const notify = useCallback(
    (type: AppNotification['type'], message: string) => {
      const id = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      setNotifications((prev) => [...prev.slice(-4), { id, type, message }]);
      window.setTimeout(() => {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
      }, 3800);
    },
    []
  );

  // Build and memoize the recorded WAV buffer from captured microphone chunks
  const buildRecordedWavBytes = useCallback((): Uint8Array | null => {
    const targetRate = sessionOutputSampleRateRef.current;
    const profileForSession = sessionProfileRef.current;

    if (
      profileForSession === 'ulaw_8000' &&
      processedMuLawChunksRef.current.length > 0
    ) {
      const totalBytes = processedMuLawChunksRef.current.reduce(
        (acc, chunk) => acc + chunk.length,
        0
      );
      if (totalBytes > 0) {
        const combinedMuLaw = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of processedMuLawChunksRef.current) {
          combinedMuLaw.set(chunk, offset);
          offset += chunk.length;
        }
        const wavBytes = encodeMuLawToWav(combinedMuLaw, targetRate);
        latestProcessedWavBytesRef.current = wavBytes;
        setLatestProcessedWavBytes(wavBytes);
        return wavBytes;
      }
    }

    if (processedPcm16ChunksRef.current.length > 0) {
      const totalSamples = processedPcm16ChunksRef.current.reduce(
        (acc, chunk) => acc + chunk.length,
        0
      );
      if (totalSamples > 0) {
        const combinedPcm16 = new Int16Array(totalSamples);
        let offset = 0;
        for (const chunk of processedPcm16ChunksRef.current) {
          combinedPcm16.set(chunk, offset);
          offset += chunk.length;
        }
        const wavBytes = encodePcm16ToWav(combinedPcm16, targetRate);
        latestProcessedWavBytesRef.current = wavBytes;
        setLatestProcessedWavBytes(wavBytes);
        return wavBytes;
      }
    }

    return latestProcessedWavBytesRef.current;
  }, []);

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
        gladiaApiKeyConfigured: false,
        maskedGladiaApiKey: null,
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

  // Load persisted benchmarks from /data/benchmarks.json on startup (and migrate/repair any local browser runs or audio)
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const diskResults = await fetchBenchmarksFromServer();
        const localResults = loadSavedResults();
        const diskIds = new Set(diskResults.map((r) => r.id));
        const unsyncedLocal = localResults.filter((r) => !diskIds.has(r.id));
        let needsRefresh = false;

        if (unsyncedLocal.length > 0) {
          for (const item of [...unsyncedLocal].reverse()) {
            let wavBase64: string | null = null;
            const audioRecord = await loadTestAudioFromDb(item.id);
            if (audioRecord?.wavBytes) {
              wavBase64 = uint8ArrayToBase64(audioRecord.wavBytes);
            }
            await persistBenchmarkToServer(
              { ...item, hasSavedAudio: Boolean(wavBase64) },
              wavBase64
            );
          }
          needsRefresh = true;
        }

        for (const diskItem of diskResults) {
          if (!diskItem.hasSavedAudio) {
            const audioRecord = await loadTestAudioFromDb(diskItem.id);
            if (audioRecord?.wavBytes && audioRecord.wavBytes.byteLength > 44) {
              const wavBase64 = uint8ArrayToBase64(audioRecord.wavBytes);
              await persistBenchmarkToServer(
                { ...diskItem, hasSavedAudio: true },
                wavBase64
              );
              needsRefresh = true;
            }
          }
        }

        if (needsRefresh) {
          const merged = await fetchBenchmarksFromServer();
          if (active) {
            setSavedResults(merged);
          }
        } else if (active) {
          setSavedResults(diskResults);
        }
      } catch (err) {
        console.warn('Could not fetch benchmarks from /api/benchmarks, using local cache:', err);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    saveResultsToStorage(savedResults);
  }, [savedResults]);

  // Create playable object URL whenever latestProcessedWavBytes updates
  useEffect(() => {
    if (!latestProcessedWavBytes) {
      setPreviewAudioUrl(null);
      return undefined;
    }
    const url = createPlayableWavBlobUrl(latestProcessedWavBytes);
    setPreviewAudioUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [latestProcessedWavBytes]);

  // Combined ElevenLabs transcript text
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

  // Combined Gladia transcript text
  const gladiaFullTranscript = useMemo(() => {
    const trimmedSegments = gladiaCommittedSegments
      .map((s) => s.text.trim())
      .filter((t) => t.length > 0);
    const committedText = trimmedSegments.join(' ');
    const partial = gladiaPartialTranscript.trim();
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
  }, [gladiaCommittedSegments, gladiaPartialTranscript]);

  // Average Gladia confidence across final utterances
  const gladiaAvgConfidence = useMemo(() => {
    const withConf = gladiaCommittedSegments.filter(
      (s) => typeof s.confidence === 'number'
    );
    if (withConf.length === 0) return null;
    const sum = withConf.reduce((acc, s) => acc + (s.confidence ?? 0), 0);
    return sum / withConf.length;
  }, [gladiaCommittedSegments]);

  // Combined Google STT v2 transcript text
  const googleFullTranscript = useMemo(() => {
    const trimmedSegments = googleCommittedSegments
      .map((s) => s.text.trim())
      .filter((t) => t.length > 0);
    const committedText = trimmedSegments.join(' ');
    const partial = googlePartialTranscript.trim();
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
  }, [googleCommittedSegments, googlePartialTranscript]);

  // Average Google confidence across final utterances
  const googleAvgConfidence = useMemo(() => {
    const withConf = googleCommittedSegments.filter(
      (s) => typeof s.confidence === 'number'
    );
    if (withConf.length === 0) return null;
    const sum = withConf.reduce((acc, s) => acc + (s.confidence ?? 0), 0);
    return sum / withConf.length;
  }, [googleCommittedSegments]);

  // Keep Texto Real initially populated with ElevenLabs (or Gladia or Google) transcript until user edits it
  useEffect(() => {
    if (!isRealTranscriptEdited) {
      if (fullTranscript.trim()) {
        setRealTranscript(fullTranscript);
      } else if (gladiaFullTranscript.trim()) {
        setRealTranscript(gladiaFullTranscript);
      } else if (googleFullTranscript.trim()) {
        setRealTranscript(googleFullTranscript);
      } else {
        setRealTranscript('');
      }
    }
  }, [
    fullTranscript,
    gladiaFullTranscript,
    googleFullTranscript,
    isRealTranscriptEdited,
  ]);

  // Live WER calculation for ElevenLabs vs Texto Real
  const liveElevenLabsAccuracy = useMemo(() => {
    if (!realTranscript.trim() && !fullTranscript.trim()) return null;
    return calculateAccuracyMetrics(realTranscript, fullTranscript, {
      normalizeAlphanumeric,
    });
  }, [realTranscript, fullTranscript, normalizeAlphanumeric]);

  // Live WER calculation for Gladia vs Texto Real
  const liveGladiaAccuracy = useMemo(() => {
    if (!realTranscript.trim() && !gladiaFullTranscript.trim()) return null;
    return calculateAccuracyMetrics(realTranscript, gladiaFullTranscript, {
      normalizeAlphanumeric,
    });
  }, [realTranscript, gladiaFullTranscript, normalizeAlphanumeric]);

  // Live WER calculation for Google STT v2 vs Texto Real
  const liveGoogleAccuracy = useMemo(() => {
    if (!realTranscript.trim() && !googleFullTranscript.trim()) return null;
    return calculateAccuracyMetrics(realTranscript, googleFullTranscript, {
      normalizeAlphanumeric,
    });
  }, [realTranscript, googleFullTranscript, normalizeAlphanumeric]);

  // Determine live winner across active engines (ElevenLabs, Gladia, Google STT v2)
  const liveWinner = useMemo((): 'elevenlabs' | 'gladia' | 'google' | 'tie' | null => {
    const candidates: Array<{
      id: 'elevenlabs' | 'gladia' | 'google';
      wer: number;
    }> = [];
    if (fullTranscript.trim() && liveElevenLabsAccuracy) {
      candidates.push({ id: 'elevenlabs', wer: liveElevenLabsAccuracy.wer });
    }
    if (gladiaFullTranscript.trim() && liveGladiaAccuracy) {
      candidates.push({ id: 'gladia', wer: liveGladiaAccuracy.wer });
    }
    if (googleFullTranscript.trim() && liveGoogleAccuracy) {
      candidates.push({ id: 'google', wer: liveGoogleAccuracy.wer });
    }
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!.id;

    const minWer = Math.min(...candidates.map((c) => c.wer));
    const best = candidates.filter((c) => Math.abs(c.wer - minWer) < 1e-6);
    if (best.length > 1) return 'tie';
    return best[0]!.id;
  }, [
    fullTranscript,
    gladiaFullTranscript,
    googleFullTranscript,
    liveElevenLabsAccuracy,
    liveGladiaAccuracy,
    liveGoogleAccuracy,
  ]);

  // Comparative WER Summary across all saved tests (global and per telephony profile)
  const werSummary = useMemo(() => {
    const elRuns = savedResults.filter((r) => r.accuracy !== null);
    const glRuns = savedResults.filter(
      (r) => r.gladia?.accuracy !== null && r.gladia?.accuracy !== undefined
    );
    const goRuns = savedResults.filter(
      (r) => r.google?.accuracy !== null && r.google?.accuracy !== undefined
    );

    const globalElAvgWer =
      elRuns.length > 0
        ? (elRuns.reduce((acc, r) => acc + (r.accuracy?.wer ?? 0), 0) /
            elRuns.length) *
          100
        : null;

    const globalGlAvgWer =
      glRuns.length > 0
        ? (glRuns.reduce((acc, r) => acc + (r.gladia?.accuracy?.wer ?? 0), 0) /
            glRuns.length) *
          100
        : null;

    const globalGoAvgWer =
      goRuns.length > 0
        ? (goRuns.reduce((acc, r) => acc + (r.google?.accuracy?.wer ?? 0), 0) /
            goRuns.length) *
          100
        : null;

    let elWins = 0;
    let glWins = 0;
    let goWins = 0;
    let ties = 0;
    for (const r of savedResults) {
      const candidates: Array<{ id: 'el' | 'gl' | 'go'; wer: number }> = [];
      if (r.accuracy && (r.finalTranscript || r.sessionId)) {
        candidates.push({ id: 'el', wer: r.accuracy.wer });
      }
      if (r.gladia?.accuracy && (r.gladia.finalTranscript || r.gladia.sessionId)) {
        candidates.push({ id: 'gl', wer: r.gladia.accuracy.wer });
      }
      if (r.google?.accuracy && (r.google.finalTranscript || r.google.sessionId)) {
        candidates.push({ id: 'go', wer: r.google.accuracy.wer });
      }
      if (candidates.length >= 2) {
        const minWer = Math.min(...candidates.map((c) => c.wer));
        const best = candidates.filter((c) => Math.abs(c.wer - minWer) < 1e-6);
        if (best.length > 1) ties++;
        else if (best[0]!.id === 'el') elWins++;
        else if (best[0]!.id === 'gl') glWins++;
        else if (best[0]!.id === 'go') goWins++;
      }
    }

    const byProfile = (Object.keys(AUDIO_PROFILES) as AudioProfileId[]).map(
      (pid) => {
        const runs = savedResults.filter((r) => r.profileId === pid);
        const runsWithElWer = runs.filter((r) => r.accuracy !== null);
        const runsWithGlWer = runs.filter(
          (r) => r.gladia?.accuracy !== null && r.gladia?.accuracy !== undefined
        );
        const runsWithGoWer = runs.filter(
          (r) => r.google?.accuracy !== null && r.google?.accuracy !== undefined
        );
        const avgElWer =
          runsWithElWer.length > 0
            ? (runsWithElWer.reduce((acc, r) => acc + (r.accuracy?.wer ?? 0), 0) /
                runsWithElWer.length) *
              100
            : null;
        const avgGlWer =
          runsWithGlWer.length > 0
            ? (runsWithGlWer.reduce(
                (acc, r) => acc + (r.gladia?.accuracy?.wer ?? 0),
                0
              ) /
                runsWithGlWer.length) *
              100
            : null;
        const avgGoWer =
          runsWithGoWer.length > 0
            ? (runsWithGoWer.reduce(
                (acc, r) => acc + (r.google?.accuracy?.wer ?? 0),
                0
              ) /
                runsWithGoWer.length) *
              100
            : null;
        return {
          profileId: pid,
          label: AUDIO_PROFILES[pid].shortLabel,
          count: runs.length,
          avgElWer,
          avgGlWer,
          avgGoWer,
        };
      }
    );

    return {
      totalRuns: savedResults.length,
      globalElAvgWer,
      globalGlAvgWer,
      globalGoAvgWer,
      elWins,
      glWins,
      goWins,
      ties,
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
      if (gladiaWsRef.current) {
        gladiaWsRef.current.close();
      }
      if (googleWsRef.current) {
        googleWsRef.current.close();
      }
    };
  }, [cleanupAudioResources]);

  const isAlreadySaved = useMemo(() => {
    if (isCurrentTestSaved) return true;
    if (sessionId && savedResults.some((r) => r.sessionId === sessionId)) {
      return true;
    }
    if (
      gladiaSessionId &&
      savedResults.some((r) => r.gladia?.sessionId === gladiaSessionId)
    ) {
      return true;
    }
    if (
      googleSessionId &&
      savedResults.some((r) => r.google?.sessionId === googleSessionId)
    ) {
      return true;
    }
    return false;
  }, [isCurrentTestSaved, sessionId, gladiaSessionId, googleSessionId, savedResults]);

  // Save a completed test result (ElevenLabs + Gladia + Google STT v2 comparison + recorded WAV)
  const saveCurrentTestResult = useCallback(async () => {
    if (isSavingTest || currentTestSavedRef.current || isAlreadySaved) {
      notify(
        'warning',
        'Esta prueba ya ha sido guardada. Realiza una nueva grabación para guardar otra.'
      );
      return null;
    }

    const wavBytesToSave =
      buildRecordedWavBytes() ??
      latestProcessedWavBytesRef.current ??
      latestProcessedWavBytes;

    const elTranscriptToSave = fullTranscript.trim();
    const glTranscriptToSave = gladiaFullTranscript.trim();
    const goTranscriptToSave = googleFullTranscript.trim();
    const referenceToSave =
      realTranscript.trim() ||
      elTranscriptToSave ||
      glTranscriptToSave ||
      goTranscriptToSave;

    if (
      !elTranscriptToSave &&
      !glTranscriptToSave &&
      !goTranscriptToSave &&
      !wavBytesToSave
    ) {
      notify('warning', 'No hay audio ni transcripción para guardar.');
      return null;
    }

    currentTestSavedRef.current = true;
    setIsCurrentTestSaved(true);
    setIsSavingTest(true);

    const elAccuracy =
      referenceToSave || elTranscriptToSave
        ? calculateAccuracyMetrics(referenceToSave, elTranscriptToSave, {
            normalizeAlphanumeric,
          })
        : null;

    const glAccuracy =
      glTranscriptToSave || gladiaSessionId
        ? calculateAccuracyMetrics(referenceToSave, glTranscriptToSave, {
            normalizeAlphanumeric,
          })
        : null;

    const goAccuracy =
      goTranscriptToSave || googleSessionId
        ? calculateAccuracyMetrics(referenceToSave, goTranscriptToSave, {
            normalizeAlphanumeric,
          })
        : null;

    const profileUsed = sessionProfileRef.current || activeProfile;
    const resolvedFormat =
      profileUsed === 'original'
        ? (`pcm_${outputSampleRate}` as BenchmarkTestResult['elevenLabsFormat'])
        : profileUsed === 'pcm_8000'
          ? 'pcm_8000'
          : 'ulaw_8000';

    const gladiaMetrics: GladiaProviderMetrics | null =
      glTranscriptToSave || gladiaSessionId
        ? {
            sessionId: gladiaSessionId,
            formatLabel:
              gladiaFormatLabel ||
              resolveGladiaAudioFormat(profileUsed, outputSampleRate).label,
            finalTranscript: glTranscriptToSave,
            accuracy: glAccuracy,
            confidence: gladiaAvgConfidence,
            handshakeLatencyMs: gladiaHandshakeLatencyMs,
            timeToFirstPartialMs: gladiaTimeToFirstPartialMs,
            timeToFirstCommittedMs: gladiaTimeToFirstCommittedMs,
            lastCommittedLatencyMs: gladiaLastCommittedLatencyMs,
            partialEventCount: gladiaPartialEventCount,
            committedEventCount: gladiaCommittedEventCount,
          }
        : null;

    const googleMetrics: GoogleProviderMetrics | null =
      goTranscriptToSave || googleSessionId
        ? {
            sessionId: googleSessionId,
            model: health?.googleModelId ?? 'chirp_3',
            location: health?.googleLocation ?? 'eu',
            formatLabel:
              googleFormatLabel ||
              resolveGoogleAudioFormat(profileUsed, outputSampleRate).label,
            finalTranscript: goTranscriptToSave,
            accuracy: goAccuracy,
            confidence: googleAvgConfidence,
            handshakeLatencyMs: googleHandshakeLatencyMs,
            timeToFirstPartialMs: googleTimeToFirstPartialMs,
            timeToFirstCommittedMs: googleTimeToFirstCommittedMs,
            lastCommittedLatencyMs: googleLastCommittedLatencyMs,
            partialEventCount: googlePartialEventCount,
            committedEventCount: googleCommittedEventCount,
          }
        : null;

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const createdAt = new Date().toISOString();
    const hasAudio = Boolean(wavBytesToSave && wavBytesToSave.byteLength > 44);

    let wavBase64: string | null = null;
    if (hasAudio && wavBytesToSave) {
      wavBase64 = uint8ArrayToBase64(wavBytesToSave);
      try {
        await saveTestAudioToDb({
          id: runId,
          wavBytes: wavBytesToSave,
          sampleRate: outputSampleRate,
          profileId: profileUsed,
          createdAt,
        });
      } catch (dbErr) {
        console.warn('Could not save audio to IndexedDB:', dbErr);
      }
    }

    const newResult: BenchmarkTestResult = {
      id: runId,
      createdAt,
      sourceType: 'microphone',
      sourceName: 'Micrófono',
      profileId: profileUsed,
      profileName: AUDIO_PROFILES[profileUsed].shortLabel,
      elevenLabsFormat: resolvedFormat,
      inputSampleRate,
      outputSampleRate,
      commitStrategy,
      languageCode: languageCode.trim() || 'auto',
      sessionId,
      finalTranscript: elTranscriptToSave,
      referenceTranscript: referenceToSave,
      evaluationLabel: elAccuracy
        ? elAccuracy.wer === 0
          ? 'correct'
          : 'incorrect'
        : null,
      hasSavedAudio: hasAudio,
      accuracy: elAccuracy,
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
      gladia: gladiaMetrics,
      google: googleMetrics,
      signalMetrics: {
        rmsDbFs,
        peakDbFs,
        quantizationSnrDb,
      },
      warnings,
      errors,
    };

    const elWerText = elAccuracy ? `${(elAccuracy.wer * 100).toFixed(1)}%` : '—';
    const glWerText = glAccuracy ? `${(glAccuracy.wer * 100).toFixed(1)}%` : '—';
    const goWerText = goAccuracy ? `${(goAccuracy.wer * 100).toFixed(1)}%` : '—';

    try {
      const persisted = await persistBenchmarkToServer(newResult, wavBase64);
      setSavedResults((prev) => [
        persisted,
        ...prev.filter((r) => r.id !== persisted.id),
      ]);
      notify(
        'success',
        `Comparativa guardada (${AUDIO_PROFILES[profileUsed].shortLabel} • EL: ${elWerText} | GL: ${glWerText} | Google: ${goWerText})`
      );
      return persisted;
    } catch (err) {
      console.error('Failed to persist benchmark to /data on server:', err);
      setSavedResults((prev) => [newResult, ...prev]);
      notify(
        'warning',
        `Guardado localmente (${AUDIO_PROFILES[profileUsed].shortLabel} • EL: ${elWerText} | GL: ${glWerText} | Google: ${goWerText})`
      );
      return newResult;
    } finally {
      setIsSavingTest(false);
    }
  }, [
    isSavingTest,
    isAlreadySaved,
    notify,
    buildRecordedWavBytes,
    latestProcessedWavBytes,
    fullTranscript,
    gladiaFullTranscript,
    googleFullTranscript,
    realTranscript,
    gladiaSessionId,
    googleSessionId,
    activeProfile,
    outputSampleRate,
    gladiaFormatLabel,
    gladiaAvgConfidence,
    gladiaHandshakeLatencyMs,
    gladiaTimeToFirstPartialMs,
    gladiaTimeToFirstCommittedMs,
    gladiaLastCommittedLatencyMs,
    gladiaPartialEventCount,
    gladiaCommittedEventCount,
    googleFormatLabel,
    googleAvgConfidence,
    googleHandshakeLatencyMs,
    googleTimeToFirstPartialMs,
    googleTimeToFirstCommittedMs,
    googleLastCommittedLatencyMs,
    googlePartialEventCount,
    googleCommittedEventCount,
    health,
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

  // Delete a single saved run + its audio in /data and IndexedDB
  const handleDeleteSavedRun = (runId: string) => {
    setSavedResults((prev) => prev.filter((item) => item.id !== runId));
    void deleteTestAudioFromDb(runId);
    void deleteBenchmarkFromServer(runId);
    notify('info', 'Prueba eliminada correctamente.');
  };

  // Clear all saved runs + all audio in /data and IndexedDB
  const handleClearAllRuns = () => {
    setSavedResults([]);
    void clearAllTestAudioFromDb();
    void clearBenchmarksOnServer();
    notify('info', 'Se han eliminado todas las pruebas guardadas.');
  };

  // Send manual commit chunk to ElevenLabs
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
    notify('info', 'Commit manual enviado a ElevenLabs.');
  };

  // Stop streaming on both ElevenLabs and Gladia & build processed WAV for playback/saving
  const handleStopStream = useCallback(() => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;
    setIsStreaming(false);
    cleanupAudioResources();

    const targetRate = sessionOutputSampleRateRef.current;
    buildRecordedWavBytes();

    notify(
      'info',
      'Grabación detenida. Revisa la comparativa y pulsa "Guardar Resultado".'
    );

    const ws = wsRef.current;
    const gladiaWs = gladiaWsRef.current;
    const googleWs = googleWsRef.current;

    if (ws && ws.readyState === WebSocket.OPEN) {
      setConnectionStatus('committing');
      const silentBytes =
        sessionProfileRef.current === 'ulaw_8000'
          ? new Uint8Array(160).fill(0xff)
          : new Uint8Array(320);

      const finalChunk: InputAudioChunkMessage = {
        message_type: 'input_audio_chunk',
        audio_base_64: uint8ArrayToBase64(silentBytes),
        commit: true,
        sample_rate: targetRate,
      };
      try {
        ws.send(JSON.stringify(finalChunk));
      } catch {
        // Ignore send errors on closing socket
      }
    } else {
      setConnectionStatus('disconnected');
    }

    if (gladiaWs && gladiaWs.readyState === WebSocket.OPEN) {
      setGladiaStatus('committing');
      try {
        gladiaWs.send(JSON.stringify({ type: 'stop_recording' }));
      } catch {
        // Ignore send errors on closing socket
      }
    } else {
      setGladiaStatus((prev) => (prev === 'error' ? 'error' : 'disconnected'));
    }

    if (googleWs && googleWs.readyState === WebSocket.OPEN) {
      setGoogleStatus('committing');
      try {
        googleWs.send(JSON.stringify({ type: 'stop_recording' }));
      } catch {
        // Ignore send errors on closing socket
      }
    } else {
      setGoogleStatus((prev) => (prev === 'error' ? 'error' : 'disconnected'));
    }

    window.setTimeout(() => {
      if (wsRef.current === ws && ws) {
        try {
          ws.close(1000, 'Session completed');
        } catch {
          // ignore
        }
        wsRef.current = null;
      }
      setConnectionStatus((prev) => (prev === 'error' ? 'error' : 'disconnected'));
    }, 1250);

    window.setTimeout(() => {
      if (googleWsRef.current === googleWs && googleWs) {
        try {
          googleWs.close(1000, 'Session completed');
        } catch {
          // ignore
        }
        googleWsRef.current = null;
      }
      setGoogleStatus((prev) => (prev === 'error' ? 'error' : 'disconnected'));
    }, 2200);

    window.setTimeout(() => {
      if (gladiaWsRef.current === gladiaWs && gladiaWs) {
        try {
          gladiaWs.close(1000, 'Session completed');
        } catch {
          // ignore
        }
        gladiaWsRef.current = null;
      }
      setGladiaStatus((prev) => (prev === 'error' ? 'error' : 'disconnected'));
      isStoppingRef.current = false;
    }, 3200);
  }, [cleanupAudioResources, buildRecordedWavBytes, notify]);

  // Start Simultaneous Live Microphone Streaming Session (ElevenLabs + Gladia + Google STT v2)
  const handleStartStream = async () => {
    if (isStreaming) return;

    // Reset session telemetry & state
    isStoppingRef.current = false;
    currentTestSavedRef.current = false;
    sessionProfileRef.current = activeProfile;
    latestProcessedWavBytesRef.current = null;
    elPendingChunksRef.current = [];
    gladiaPendingBinaryRef.current = [];
    googlePendingBinaryRef.current = [];

    setIsCurrentTestSaved(false);
    setIsSavingTest(false);
    setErrors([]);
    setWarnings([]);
    setPartialTranscript('');
    setCommittedSegments([]);
    setGladiaPartialTranscript('');
    setGladiaCommittedSegments([]);
    setGooglePartialTranscript('');
    setGoogleCommittedSegments([]);
    setRealTranscript('');
    setIsRealTranscriptEdited(false);
    setSessionId(null);
    setGladiaSessionId(null);
    setGoogleSessionId(null);
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

    setGladiaHandshakeLatencyMs(null);
    setGladiaTimeToFirstPartialMs(null);
    setGladiaTimeToFirstCommittedMs(null);
    setGladiaLastCommittedLatencyMs(null);
    setGladiaPartialEventCount(0);
    setGladiaCommittedEventCount(0);

    setGoogleHandshakeLatencyMs(null);
    setGoogleTimeToFirstPartialMs(null);
    setGoogleTimeToFirstCommittedMs(null);
    setGoogleLastCommittedLatencyMs(null);
    setGooglePartialEventCount(0);
    setGoogleCommittedEventCount(0);

    setTotalInputSamples(0);
    setTotalOutputSamples(0);
    setLatestProcessedWavBytes(null);
    firstChunkSentAtRef.current = null;
    lastChunkSentAtRef.current = null;
    gladiaSpeechEndedAtRef.current = null;
    googleSpeechEndedAtRef.current = null;
    partialLatenciesRef.current = [];
    processedPcm16ChunksRef.current = [];
    processedMuLawChunksRef.current = [];

    let audioCtx: AudioContext;
    let stream: MediaStream;
    let sourceSampleRate = 48000;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: true,
        },
      });
      audioCtx = new AudioContext();
      sourceSampleRate = audioCtx.sampleRate;
      mediaStreamRef.current = stream;
      audioCtxRef.current = audioCtx;
    } catch (err) {
      const msg = `No se pudo acceder al micrófono: ${
        err instanceof Error ? err.message : String(err)
      }`;
      setErrors([msg]);
      notify('error', msg);
      return;
    }

    const processor = new StreamingProfileProcessor(
      activeProfile,
      sourceSampleRate,
      'ulaw_8000'
    );
    const micAgc = new StreamingMicrophoneAgc();

    sessionOutputSampleRateRef.current = processor.outputSampleRate;
    setInputSampleRate(processor.inputSampleRate);
    setOutputSampleRate(processor.outputSampleRate);

    const gladiaFormat = resolveGladiaAudioFormat(
      activeProfile,
      processor.outputSampleRate
    );
    setGladiaFormatLabel(gladiaFormat.label);

    const googleFormat = resolveGoogleAudioFormat(
      activeProfile,
      processor.outputSampleRate
    );
    setGoogleFormatLabel(googleFormat.label);

    // Optional resampler only if 'original' profile resolved to 22050/24000 Hz (which Gladia maps to 16000 Hz)
    const gladiaNeedsResample =
      activeProfile === 'original' &&
      processor.outputSampleRate !== gladiaFormat.sampleRate;
    const gladiaResampler = gladiaNeedsResample
      ? new StreamingResampler(sourceSampleRate, gladiaFormat.sampleRate)
      : null;

    setIsStreaming(true);
    const startedAt = performance.now();
    elapsedTimerRef.current = window.setInterval(() => {
      setElapsedMs(Math.round(performance.now() - startedAt));
    }, 100);

    const isElActive = selectedEngineIds.includes('elevenlabs');
    const isGlActive = selectedEngineIds.includes('gladia');
    const isGoActive = selectedEngineIds.includes('google');

    notify(
      'info',
      `Grabación iniciada: ${selectedEngineIds.join(' + ')} (${AUDIO_PROFILES[activeProfile].shortLabel})`
    );

    // 1. Connect to ElevenLabs Scribe v2 Realtime via local WebSocket proxy (/api/ws/stt)
    let ws: WebSocket | null = null;
    if (isElActive) {
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

      ws = new WebSocket(wsUrl.toString());
      wsRef.current = ws;

      const activeWs = ws;
      ws.onopen = () => {
        setConnectionStatus('connected');
        if (elPendingChunksRef.current.length > 0) {
          for (const payloadStr of elPendingChunksRef.current) {
            try {
              activeWs?.send(payloadStr);
            } catch {
              // ignore
            }
          }
          elPendingChunksRef.current = [];
        }
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
            setWarnings((prev) => [...prev, `[ElevenLabs] ${msg.warning}`]);
            break;
          }

          default: {
            if ('error' in msg) {
              setErrors((prev) => [
                ...prev,
                `[ElevenLabs ${msg.message_type}] ${msg.error}`,
              ]);
              setConnectionStatus('error');
            }
            break;
          }
        }
      } catch (err) {
        console.error('Failed to parse ElevenLabs WebSocket message:', err);
      }
    };

    ws.onerror = () => {
      setErrors((prev) => [
        ...prev,
        '[ElevenLabs] Error de WebSocket al conectar con /api/ws/stt.',
      ]);
      setConnectionStatus('error');
    };

    ws.onclose = () => {
      if (!isStoppingRef.current) {
        buildRecordedWavBytes();
        setConnectionStatus((prev) => (prev === 'error' ? 'error' : 'disconnected'));
      }
    };
  } else {
    setConnectionStatus('disconnected');
  }

  // 2. Initialize & Connect Gladia Live v2 (solaria-1) in parallel
    if (isGlActive) {
      setGladiaStatus('connecting');
      gladiaConnectInitiatedAtRef.current = performance.now();

      void (async () => {
      try {
        const initRes = await fetch('/api/gladia/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profileId: activeProfile,
            sampleRate: processor.outputSampleRate,
            languageCode: languageCode.trim() || 'auto',
            endpointing: 0.2,
          }),
        });

        const initData = (await initRes.json()) as GladiaLiveInitResponse & {
          error?: string;
          details?: string;
        };

        if (!initRes.ok || !initData.url) {
          throw new Error(
            initData.details
              ? `${initData.error}: ${initData.details}`
              : initData.error || `HTTP ${initRes.status}`
          );
        }

        // Refresh health pill if it was previously showing missing
        if (!health?.gladiaApiKeyConfigured) {
          void checkBackendHealth();
        }

        if (isStoppingRef.current) return;

        setGladiaSessionId(initData.id);
        if (initData.gladiaFormat?.label) {
          setGladiaFormatLabel(initData.gladiaFormat.label);
        }

          const gSocket = new WebSocket(initData.url);
          gSocket.binaryType = 'arraybuffer';
          gladiaWsRef.current = gSocket;

          gSocket.onopen = () => {
            const nowPerf = performance.now();
            setGladiaStatus('session_active');
            setGladiaHandshakeLatencyMs(
              Math.round(nowPerf - gladiaConnectInitiatedAtRef.current)
            );
            // Flush any initial audio chunks captured during session POST + WS handshake
            if (gladiaPendingBinaryRef.current.length > 0) {
              console.log(
                `[Gladia] Conexión abierta. Vaciando ${gladiaPendingBinaryRef.current.length} fragmentos pendientes.`
              );
              for (const buf of gladiaPendingBinaryRef.current) {
                try {
                  gSocket.send(buf);
                } catch {
                  // ignore
                }
              }
              gladiaPendingBinaryRef.current = [];
            }
          };

          gSocket.onmessage = (gEvent) => {
            if (typeof gEvent.data !== 'string') return;
            const nowPerf = performance.now();
            try {
              const message = JSON.parse(gEvent.data) as GladiaLiveEvent;

              if (message.type === 'speech_end') {
                gladiaSpeechEndedAtRef.current = nowPerf;
                return;
              }

              if (message.type === 'transcript' && message.data?.utterance) {
                const utterance = message.data.utterance;
                const text = (utterance.text ?? '').trim();
                if (!text) return;

                if (message.data.is_final) {
                  setGladiaPartialTranscript('');
                  setGladiaCommittedEventCount((c) => c + 1);

                  if (firstChunkSentAtRef.current !== null) {
                    const sinceFirst = Math.round(
                      nowPerf - firstChunkSentAtRef.current
                    );
                    setGladiaTimeToFirstCommittedMs((prev) =>
                      prev === null ? sinceFirst : prev
                    );
                  }

                  const refTime =
                    gladiaSpeechEndedAtRef.current ?? lastChunkSentAtRef.current;
                  if (refTime !== null) {
                    setGladiaLastCommittedLatencyMs(
                      Math.max(1, Math.round(nowPerf - refTime))
                    );
                  }

                  const segId =
                    message.data.id ?? `${utterance.start}-${utterance.end}`;
                  setGladiaCommittedSegments((prev) => {
                    const existingIdx = prev.findIndex((item) => item.id === segId);
                    const nextSeg: CommittedSegment = {
                      id: segId,
                      text,
                      languageCode: utterance.language,
                      confidence: utterance.confidence,
                      timestampMs: Math.round(nowPerf - startedAt),
                    };
                    if (existingIdx >= 0) {
                      const clone = [...prev];
                      clone[existingIdx] = nextSeg;
                      return clone;
                    }
                    return [...prev, nextSeg];
                  });
                } else {
                  setGladiaPartialTranscript(text);
                  setGladiaPartialEventCount((c) => c + 1);
                  if (firstChunkSentAtRef.current !== null) {
                    const sinceFirst = Math.round(
                      nowPerf - firstChunkSentAtRef.current
                    );
                    setGladiaTimeToFirstPartialMs((prev) =>
                      prev === null ? sinceFirst : prev
                    );
                  }
                }
                return;
              }

              if (message.type === 'post_transcript' && message.data?.utterances) {
                const utterances = message.data.utterances;
                if (Array.isArray(utterances) && utterances.length > 0) {
                  setGladiaPartialTranscript('');
                  setGladiaCommittedSegments((prev) => {
                    if (prev.length > 0) return prev;
                    const newSegments: CommittedSegment[] = utterances
                      .map((utt, i) => ({
                        id: `post_${utt.start}_${utt.end}_${i}`,
                        text: (utt.text ?? '').trim(),
                        languageCode: utt.language,
                        confidence: utt.confidence,
                        timestampMs: Math.round((utt.end ?? 0) * 1000),
                      }))
                      .filter((s) => s.text.length > 0);
                    return newSegments.length > 0 ? newSegments : prev;
                  });
                  setGladiaCommittedEventCount((c) => Math.max(c, utterances.length));
                }
                return;
              }

              if (
                message.type === 'post_final_transcript' &&
                message.data?.transcription?.utterances
              ) {
                const utterances = message.data.transcription.utterances;
                if (Array.isArray(utterances) && utterances.length > 0) {
                  setGladiaPartialTranscript('');
                  setGladiaCommittedSegments((prev) => {
                    if (prev.length > 0) return prev;
                    const newSegments: CommittedSegment[] = utterances
                      .map((utt, i) => ({
                        id: `post_final_${utt.start}_${utt.end}_${i}`,
                        text: (utt.text ?? '').trim(),
                        languageCode: utt.language,
                        confidence: utt.confidence,
                        timestampMs: Math.round((utt.end ?? 0) * 1000),
                      }))
                      .filter((s) => s.text.length > 0);
                    return newSegments.length > 0 ? newSegments : prev;
                  });
                  setGladiaCommittedEventCount((c) => Math.max(c, utterances.length));
                }
                return;
              }

              if (message.error) {
                const errText =
                  typeof message.error === 'string'
                    ? message.error
                    : message.error.message ?? 'Gladia runtime error';
                setErrors((prev) => [...prev, `[Gladia] ${errText}`]);
                setGladiaStatus('error');
              }
            } catch (parseErr) {
              console.error('Failed to parse Gladia message:', parseErr);
            }
          };

          gSocket.onerror = (evt) => {
            console.error('[Gladia] Error en WebSocket en vivo:', evt);
            setErrors((prev) => [
              ...prev,
              '[Gladia] Error en la conexión WebSocket en vivo.',
            ]);
            setGladiaStatus('error');
          };

          gSocket.onclose = (evt) => {
            console.log('[Gladia] WebSocket cerrado:', evt.code, evt.reason);
            if (!isStoppingRef.current) {
              if (evt.code !== 1000 && evt.code !== 1005) {
                setErrors((prev) => [
                  ...prev,
                  `[Gladia] Conexión cerrada inesperadamente (código ${evt.code}: ${
                    evt.reason || 'sin detalle'
                  }).`,
                ]);
              }
              setGladiaStatus((prev) =>
                prev === 'error' || evt.code !== 1000 ? 'error' : 'disconnected'
              );
            }
          };
        } catch (gladiaErr) {
          const msg =
            gladiaErr instanceof Error
              ? gladiaErr.message
              : 'Error al iniciar sesión en Gladia';
          setErrors((prev) => [...prev, `[Gladia] ${msg}`]);
          setGladiaStatus('error');
        }
      })();
    } else {
      gladiaWsRef.current = null;
      setGladiaStatus('disconnected');
    }

    // 3. Initialize & Connect Google Cloud Speech-to-Text v2 (chirp_3) via local WebSocket proxy (/api/ws/google)
    if (isGoActive) {
      setGoogleStatus('connecting');
      googleConnectInitiatedAtRef.current = performance.now();

      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const goWsUrl = new URL(`${wsProtocol}//${window.location.host}/api/ws/google`);
      goWsUrl.searchParams.set('profile_id', activeProfile);
      goWsUrl.searchParams.set('sample_rate', String(processor.outputSampleRate));
      goWsUrl.searchParams.set('language_code', languageCode.trim() || 'es-ES');

      const goSocket = new WebSocket(goWsUrl.toString());
      goSocket.binaryType = 'arraybuffer';
      googleWsRef.current = goSocket;

      goSocket.onopen = () => {
        setGoogleStatus('connected');
        if (googlePendingBinaryRef.current.length > 0) {
          for (const buf of googlePendingBinaryRef.current) {
            try {
              goSocket.send(buf);
            } catch {
              // ignore
            }
          }
          googlePendingBinaryRef.current = [];
        }
      };

      goSocket.onmessage = (goEvent) => {
        if (typeof goEvent.data !== 'string') return;
        const nowPerf = performance.now();
        try {
          const msg = JSON.parse(goEvent.data) as GoogleProxyServerMessage;

          if (msg.type === 'session_started') {
            setGoogleSessionId(msg.sessionId);
            setGoogleStatus('session_active');
            setGoogleHandshakeLatencyMs(
              Math.round(nowPerf - googleConnectInitiatedAtRef.current)
            );
            if (msg.format?.label) {
              setGoogleFormatLabel(msg.format.label);
            }
            return;
          }

          if (msg.type === 'speech_event') {
            if (
              msg.event.includes('END') ||
              msg.event === 'SPEECH_ACTIVITY_END'
            ) {
              googleSpeechEndedAtRef.current = nowPerf;
            }
            return;
          }

          if (msg.type === 'transcript') {
            const text = (msg.text ?? '').trim();
            if (!text) return;

            if (msg.isFinal) {
              setGooglePartialTranscript('');
              setGoogleCommittedEventCount((c) => c + 1);

              if (firstChunkSentAtRef.current !== null) {
                const sinceFirst = Math.round(nowPerf - firstChunkSentAtRef.current);
                setGoogleTimeToFirstCommittedMs((prev) =>
                  prev === null ? sinceFirst : prev
                );
              }

              const refTime =
                googleSpeechEndedAtRef.current ?? lastChunkSentAtRef.current;
              if (refTime !== null) {
                setGoogleLastCommittedLatencyMs(
                  Math.max(1, Math.round(nowPerf - refTime))
                );
              }

              setGoogleCommittedSegments((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.text.trim() === text) {
                  return prev;
                }
                return [
                  ...prev,
                  {
                    id: `go_seg_${Date.now()}_${prev.length}`,
                    text,
                    languageCode: msg.languageCode,
                    words: msg.words,
                    confidence:
                      typeof msg.confidence === 'number' && msg.confidence > 0
                        ? msg.confidence
                        : undefined,
                    timestampMs: Math.round(nowPerf - startedAt),
                  },
                ];
              });
            } else {
              setGooglePartialTranscript(text);
              setGooglePartialEventCount((c) => c + 1);
              if (firstChunkSentAtRef.current !== null) {
                const sinceFirst = Math.round(nowPerf - firstChunkSentAtRef.current);
                setGoogleTimeToFirstPartialMs((prev) =>
                  prev === null ? sinceFirst : prev
                );
              }
            }
            return;
          }

          if (msg.type === 'error') {
            setErrors((prev) => [...prev, `[Google STT v2] ${msg.error}`]);
            setGoogleStatus('error');
          }
        } catch (parseErr) {
          console.error('Failed to parse Google STT v2 message:', parseErr);
        }
      };

      goSocket.onerror = () => {
        setErrors((prev) => [
          ...prev,
          '[Google STT v2] Error de WebSocket al conectar con /api/ws/google.',
        ]);
        setGoogleStatus('error');
      };

      goSocket.onclose = () => {
        if (!isStoppingRef.current) {
          setGoogleStatus((prev) => (prev === 'error' ? 'error' : 'disconnected'));
        }
      };
    } else {
      googleWsRef.current = null;
      setGoogleStatus('disconnected');
    }

    // 4. Real-time Microphone Capture -> DSP Profile Processor -> Simultaneous dispatch to ElevenLabs, Gladia & Google STT v2
    const micSource = audioCtx.createMediaStreamSource(stream);
    const scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
    scriptNodeRef.current = scriptNode;

    scriptNode.onaudioprocess = (audioEvent) => {
      if (isStoppingRef.current) {
        return;
      }

      const inputData = audioEvent.inputBuffer.getChannelData(0);
      const copy = micAgc.processChunk(new Float32Array(inputData));

      const processed = processor.processChunk(copy);
      processedPcm16ChunksRef.current.push(processed.previewPcm16);
      if (processed.muLawBytes) {
        processedMuLawChunksRef.current.push(processed.muLawBytes);
      }

      const levels = computeSignalLevels(processed.previewPcm16);
      setRmsDbFs(levels.rmsDbFs);
      setPeakDbFs(levels.peakDbFs);
      if (processed.quantizationSnrDb !== null) {
        setQuantizationSnrDb(processed.quantizationSnrDb);
      }
      setTotalInputSamples((n) => n + copy.length);
      setTotalOutputSamples((n) => n + processed.previewPcm16.length);

      const now = performance.now();
      if (firstChunkSentAtRef.current === null) {
        firstChunkSentAtRef.current = now;
      }
      lastChunkSentAtRef.current = now;

      setChunksSent((c) => c + 1);
      setBytesSent((b) => b + processed.wireBytes.byteLength);
      setAudioDurationStreamedSec(
        (d) => d + copy.length / processor.inputSampleRate
      );

      // A) Send processed chunk to ElevenLabs Scribe v2 Realtime (if active)
      if (isElActive && ws) {
        const chunkMsg: InputAudioChunkMessage = {
          message_type: 'input_audio_chunk',
          audio_base_64: processed.wireBase64,
          commit: false,
          sample_rate: processed.outputSampleRate,
        };
        const serializedElMsg = JSON.stringify(chunkMsg);

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(serializedElMsg);
        } else if (
          ws.readyState === WebSocket.CONNECTING &&
          elPendingChunksRef.current.length < 30
        ) {
          elPendingChunksRef.current.push(serializedElMsg);
        }
      }

      // B) Send processed audio to Gladia Live v2 (solaria-1) (if active)
      if (isGlActive) {
        let gladiaBytes: Uint8Array;
        if (activeProfile === 'ulaw_8000' && processed.muLawBytes) {
          gladiaBytes = processed.muLawBytes;
        } else if (gladiaResampler) {
          const resampledForGladia = gladiaResampler.processChunk(copy);
          gladiaBytes = pcm16ToLittleEndianBytes(float32ToPcm16(resampledForGladia));
        } else {
          gladiaBytes = processed.wireBytes;
        }

        const gladiaBuffer = new Uint8Array(gladiaBytes.byteLength);
        gladiaBuffer.set(gladiaBytes);

        const gSocket = gladiaWsRef.current;
        if (gSocket && gSocket.readyState === WebSocket.OPEN) {
          gSocket.send(gladiaBuffer.buffer);
        } else if (gladiaPendingBinaryRef.current.length < 200) {
          gladiaPendingBinaryRef.current.push(gladiaBuffer.buffer);
        }
      }

      // C) Send processed audio to Google Cloud Speech-to-Text v2 (chirp_3) (if active)
      if (isGoActive) {
        const googleBytes =
          activeProfile === 'ulaw_8000' && processed.muLawBytes
            ? processed.muLawBytes
            : processed.wireBytes;

        const googleBuffer = new Uint8Array(googleBytes.byteLength);
        googleBuffer.set(googleBytes);

        const goSocket = googleWsRef.current;
        if (goSocket && goSocket.readyState === WebSocket.OPEN) {
          goSocket.send(googleBuffer.buffer);
        } else if (googlePendingBinaryRef.current.length < 200) {
          googlePendingBinaryRef.current.push(googleBuffer.buffer);
        }
      }
    };

    micSource.connect(scriptNode);
    scriptNode.connect(audioCtx.destination);
  };

  const resamplingRatio =
    outputSampleRate > 0 ? (inputSampleRate / outputSampleRate).toFixed(2) : '1.00';

  const isGladiaReady = Boolean(health?.gladiaApiKeyConfigured);
  const isGoogleReady = Boolean(health?.googleConfigured);

  // Convert RMS dBFS (-60..0) into a 0..100% visual voice activity bar
  const listeningLevelPct = isStreaming
    ? Math.max(4, Math.min(100, ((rmsDbFs + 60) / 60) * 100))
    : 0;

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
              Comparativa en Tiempo Real: ElevenLabs Scribe v2 vs Gladia Solaria-1 vs Google Chirp 3
            </p>
          </div>
        </div>

        <div className="header-status-group">
          <div
            className={`api-status-pill ${
              health?.apiKeyConfigured ? 'configured' : 'missing'
            }`}
            title="Estado de ELEVENLABS_API_KEY en .env"
          >
            <span className="status-dot" />
            <span>
              ElevenLabs:{' '}
              {healthLoading
                ? '...'
                : health?.apiKeyConfigured
                  ? `OK (${health.maskedApiKey})`
                  : 'Falta Key'}
            </span>
          </div>

          <div
            className={`api-status-pill ${isGladiaReady ? 'configured' : 'missing'}`}
            title="Estado de GLADIA_API_KEY en .env"
          >
            <span className="status-dot" />
            <span>
              Gladia:{' '}
              {healthLoading
                ? '...'
                : health?.gladiaApiKeyConfigured
                  ? `OK (${health.maskedGladiaApiKey})`
                  : 'Falta Key (.env)'}
            </span>
          </div>

          <div
            className={`api-status-pill ${isGoogleReady ? 'configured' : 'missing'}`}
            title="Estado de GOOGLE_CREDENTIALS_JSON / GOOGLE_CLOUD_PROJECT en .env"
          >
            <span className="status-dot" />
            <span>
              Google STT v2:{' '}
              {healthLoading
                ? '...'
                : health?.googleConfigured
                  ? `OK (${health.googleLocation ?? 'eu'} / ${health.googleModelId ?? 'chirp_3'})`
                  : 'Falta Creds (.env)'}
            </span>
            <button
              className="btn-inline-refresh"
              onClick={() => void checkBackendHealth()}
              title="Refrescar estado de claves"
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

      {/* Floating Toast Notifications */}
      {notifications.length > 0 && (
        <div className="toast-container" role="status" aria-live="polite">
          {notifications.map((n) => (
            <div key={n.id} className={`toast-item toast-${n.type}`}>
              <span className="toast-icon">
                {n.type === 'success' && <CheckCircle2 size={16} />}
                {n.type === 'warning' && <AlertCircle size={16} />}
                {n.type === 'error' && <AlertCircle size={16} />}
                {n.type === 'info' && <Info size={16} />}
              </span>
              <span className="toast-message">{n.message}</span>
              <button
                type="button"
                className="toast-close"
                onClick={() => dismissNotification(n.id)}
                aria-label="Cerrar notificación"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Warning banner if ElevenLabs API key is missing */}
      {health && !health.apiKeyConfigured && (
        <div className="alert-banner alert-warning">
          <AlertCircle size={18} />
          <div className="alert-content">
            <strong>Falta ELEVENLABS_API_KEY:</strong> Configura{' '}
            <code>ELEVENLABS_API_KEY</code> en <code>.env</code> y pulsa refrescar.
          </div>
        </div>
      )}

      {/* Multi-Engine STT Selector Bar */}
      <EngineSelectorBar
        availableEngines={registeredEngines}
        selectedEngineIds={selectedEngineIds}
        onToggleEngine={handleToggleEngine}
        serverStatuses={{
          elevenlabs: Boolean(health?.apiKeyConfigured),
          gladia: Boolean(health?.gladiaApiKeyConfigured),
          google: Boolean(health?.googleConfigured),
        }}
      />

      {/* Lightweight Horizontal Configuration Bar (Left-to-Right, Single Line) */}
      <section className="config-horizontal-bar" aria-label="Opciones de configuración">
        <div className="config-bar-item config-bar-title">
          <Sliders size={14} className="icon-accent" />
          <span>Perfil:</span>
        </div>

        <div className="config-profile-pills">
          {(Object.keys(AUDIO_PROFILES) as AudioProfileId[]).map((pid) => {
            const spec = AUDIO_PROFILES[pid];
            const isSelected = activeProfile === pid;
            return (
              <button
                key={pid}
                type="button"
                className={`config-profile-btn ${isSelected ? 'selected' : ''}`}
                onClick={() => setActiveProfile(pid)}
                disabled={isStreaming}
                title={`${spec.shortLabel} (${spec.defaultElevenLabsFormat})`}
              >
                <span className="config-profile-name">{spec.shortLabel}</span>
              </button>
            );
          })}
        </div>

        <div className="config-bar-divider" />

        <div className="config-bar-item">
          <label htmlFor="lang-code-input" className="config-bar-label">
            Idioma:
          </label>
          <input
            id="lang-code-input"
            type="text"
            className="form-input config-input-compact"
            placeholder="es"
            value={languageCode}
            onChange={(e) => setLanguageCode(e.target.value)}
            disabled={isStreaming}
          />
        </div>

        <div className="config-bar-divider" />

        <div className="config-bar-item">
          <label htmlFor="commit-strategy-select" className="config-bar-label">
            Commit:
          </label>
          <select
            id="commit-strategy-select"
            className="form-select config-select-compact"
            value={commitStrategy}
            onChange={(e) => setCommitStrategy(e.target.value as CommitStrategy)}
            disabled={isStreaming}
          >
            <option value="vad">VAD Auto</option>
            <option value="manual">Manual</option>
          </select>
        </div>
      </section>

      {/* Main Two-Column Workbench: Left = Mic & Capture, Right = Multi-Engine Results */}
      <main className="workbench-grid">
        {/* LEFT COLUMN: Microphone Recording & Simple Listening Indicator */}
        <section className="panel-column">
          <div className="lab-card">
            <div className="stream-action-bar">
              <div className="primary-controls">
                {!isStreaming ? (
                  <button
                    className="btn btn-start"
                    onClick={() => void handleStartStream()}
                  >
                    <Mic size={18} /> Iniciar Grabación (
                    {selectedEngineIds.length}{' '}
                    {selectedEngineIds.length === 1 ? 'Motor' : 'Motores'} -{' '}
                    {AUDIO_PROFILES[activeProfile].shortLabel})
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
                    title="Enviar input_audio_chunk con commit: true a ElevenLabs"
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

            {/* Simple Listening Indicator */}
            <div className={`simple-listening-card ${isStreaming ? 'active' : ''}`}>
              <div className="simple-listening-status">
                <span className={`recording-dot ${isStreaming ? 'active' : ''}`} />
                <span className="simple-listening-text">
                  {isStreaming
                    ? 'Escuchando micrófono en vivo...'
                    : 'Micrófono en espera'}
                </span>
              </div>

              <div className="simple-level-meter">
                <div className="simple-level-track">
                  <div
                    className="simple-level-fill"
                    style={{ width: `${listeningLevelPct}%` }}
                  />
                </div>
                <code className="simple-level-db">
                  {isStreaming && Number.isFinite(rmsDbFs) && rmsDbFs > -90
                    ? `${rmsDbFs.toFixed(1)} dBFS`
                    : '— dBFS'}
                </code>
              </div>
            </div>

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
                ElevenLabs:{' '}
                <code>
                  {activeProfile === 'original'
                    ? `pcm_${outputSampleRate}`
                    : activeProfile}
                </code>
              </span>
              <span>
                Gladia:{' '}
                <code>
                  {resolveGladiaAudioFormat(activeProfile, outputSampleRate).label}
                </code>
              </span>
              <span>
                Google:{' '}
                <code>
                  {resolveGoogleAudioFormat(activeProfile, outputSampleRate).label}
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
                    Audio Procesado Compartido (
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
                  <span>{warn}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* RIGHT COLUMN: Comparativa Simultánea ElevenLabs vs Gladia vs Google STT v2 */}
        <section className="panel-column">
          <div className="lab-card transcript-card">
            <div className="card-header">
              <h2>Comparativa en Vivo: ElevenLabs vs Gladia vs Google Chirp 3</h2>
              <span className={`profile-pill profile-${activeProfile}`}>
                {AUDIO_PROFILES[activeProfile].shortLabel}
              </span>
            </div>

            {/* Side-by-Side Provider Cards */}
            <div className="dual-providers-grid">
              {/* Provider 1: ElevenLabs Scribe v2 Realtime */}
              {selectedEngineIds.includes('elevenlabs') && (
                <div
                  className={`provider-compare-card ${
                    liveWinner === 'elevenlabs' ? 'winner-glow' : ''
                  }`}
                >
                  <div className="provider-card-header">
                    <div className="provider-title-row">
                      <span className="provider-badge badge-elevenlabs">
                        ElevenLabs
                      </span>
                      <code className="provider-model-code">scribe_v2_realtime</code>
                    </div>
                    <span
                      className={`provider-mini-status status-${connectionStatus}`}
                    >
                      {connectionStatus === 'session_active'
                        ? 'ACTIVO'
                        : connectionStatus.toUpperCase()}
                    </span>
                  </div>

                  <div className="provider-meta-strip">
                    <span>
                      Formato:{' '}
                      <code>
                        {activeProfile === 'original'
                          ? `pcm_${outputSampleRate}`
                          : activeProfile}
                      </code>
                    </span>
                    <span>
                      1er parcial:{' '}
                      <code>
                        {timeToFirstPartialMs !== null
                          ? `${timeToFirstPartialMs}ms`
                          : '—'}
                      </code>
                    </span>
                    <span>
                      Commit:{' '}
                      <code>
                        {lastCommittedLatencyMs !== null
                          ? `${lastCommittedLatencyMs}ms`
                          : '—'}
                      </code>
                    </span>
                  </div>

                  <div className="transcript-viewport provider-transcript-box">
                    {!fullTranscript ? (
                      <p className="transcript-placeholder">
                        {isStreaming
                          ? 'Escuchando en ElevenLabs Scribe v2...'
                          : 'Esperando grabación...'}
                      </p>
                    ) : (
                      <div className="transcript-flow">
                        <span className="committed-segment">{fullTranscript}</span>
                        {normalizeAlphanumeric &&
                          liveElevenLabsAccuracy?.normalizedHypothesis && (
                            <div
                              style={{
                                marginTop: '0.45rem',
                                paddingTop: '0.35rem',
                                borderTop: '1px dashed rgba(148, 163, 184, 0.25)',
                                fontSize: '0.78rem',
                                color: '#94a3b8',
                              }}
                              title="Secuencia normalizada usada para calcular el WER (sin puntuación, letras y números unificados)"
                            >
                              <strong style={{ color: '#cbd5e1' }}>Norm:</strong>{' '}
                              <code>{liveElevenLabsAccuracy.normalizedHypothesis}</code>
                            </div>
                          )}
                      </div>
                    )}
                  </div>

                  <div className="provider-wer-footer">
                    <div>
                      <span className="tel-label">WER ElevenLabs: </span>
                      <strong
                        className={formatWerBadgeClass(liveElevenLabsAccuracy?.wer)}
                        style={{ fontSize: '1.05rem' }}
                      >
                        {liveElevenLabsAccuracy !== null
                          ? `${(liveElevenLabsAccuracy.wer * 100).toFixed(1)}%`
                          : '—'}
                      </strong>
                    </div>
                    {liveElevenLabsAccuracy && (
                      <span className="provider-diff-counts">
                        S:{liveElevenLabsAccuracy.substitutions} • D:
                        {liveElevenLabsAccuracy.deletions} • I:
                        {liveElevenLabsAccuracy.insertions}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Provider 2: Gladia Live v2 (Solaria-1) */}
              {selectedEngineIds.includes('gladia') && (
                <div
                  className={`provider-compare-card ${
                    liveWinner === 'gladia' ? 'winner-glow' : ''
                  }`}
                >
                  <div className="provider-card-header">
                    <div className="provider-title-row">
                      <span className="provider-badge badge-gladia">Gladia</span>
                      <code className="provider-model-code">solaria-1</code>
                    </div>
                    <span className={`provider-mini-status status-${gladiaStatus}`}>
                      {gladiaStatus === 'session_active'
                        ? 'ACTIVO'
                        : gladiaStatus.toUpperCase()}
                    </span>
                  </div>

                  <div className="provider-meta-strip">
                    <span>
                      Formato: <code>{gladiaFormatLabel.split(' ')[0]}</code>
                    </span>
                    <span>
                      1er parcial:{' '}
                      <code>
                        {gladiaTimeToFirstPartialMs !== null
                          ? `${gladiaTimeToFirstPartialMs}ms`
                          : '—'}
                      </code>
                    </span>
                    <span>
                      Confianza:{' '}
                      <code>
                        {gladiaAvgConfidence !== null
                          ? `${Math.round(gladiaAvgConfidence * 100)}%`
                          : '—'}
                      </code>
                    </span>
                  </div>

                  <div className="transcript-viewport provider-transcript-box">
                    {!gladiaFullTranscript ? (
                      <p className="transcript-placeholder">
                        {!isGladiaReady
                          ? 'Configura GLADIA_API_KEY en .env o en la barra superior.'
                          : isStreaming
                            ? 'Escuchando en Gladia Solaria-1...'
                            : 'Esperando grabación...'}
                      </p>
                    ) : (
                      <div className="transcript-flow">
                        <span className="committed-segment">
                          {gladiaFullTranscript}
                        </span>
                        {normalizeAlphanumeric &&
                          liveGladiaAccuracy?.normalizedHypothesis && (
                            <div
                              style={{
                                marginTop: '0.45rem',
                                paddingTop: '0.35rem',
                                borderTop: '1px dashed rgba(148, 163, 184, 0.25)',
                                fontSize: '0.78rem',
                                color: '#94a3b8',
                              }}
                              title="Secuencia normalizada usada para calcular el WER (sin puntuación, letras y números unificados)"
                            >
                              <strong style={{ color: '#cbd5e1' }}>Norm:</strong>{' '}
                              <code>{liveGladiaAccuracy.normalizedHypothesis}</code>
                            </div>
                          )}
                      </div>
                    )}
                  </div>

                  <div className="provider-wer-footer">
                    <div>
                      <span className="tel-label">WER Gladia: </span>
                      <strong
                        className={formatWerBadgeClass(liveGladiaAccuracy?.wer)}
                        style={{ fontSize: '1.05rem' }}
                      >
                        {liveGladiaAccuracy !== null
                          ? `${(liveGladiaAccuracy.wer * 100).toFixed(1)}%`
                          : '—'}
                      </strong>
                    </div>
                    {liveGladiaAccuracy && (
                      <span className="provider-diff-counts">
                        S:{liveGladiaAccuracy.substitutions} • D:
                        {liveGladiaAccuracy.deletions} • I:
                        {liveGladiaAccuracy.insertions}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Provider 3: Google Cloud Speech-to-Text v2 (Chirp 3) */}
              {selectedEngineIds.includes('google') && (
                <div
                  className={`provider-compare-card ${
                    liveWinner === 'google' ? 'winner-glow' : ''
                  }`}
                >
                  <div className="provider-card-header">
                    <div className="provider-title-row">
                      <span className="provider-badge badge-google">Google STT v2</span>
                      <code className="provider-model-code">
                        {health?.googleModelId ?? 'chirp_3'}
                      </code>
                    </div>
                    <span className={`provider-mini-status status-${googleStatus}`}>
                      {googleStatus === 'session_active'
                        ? 'ACTIVO'
                        : googleStatus.toUpperCase()}
                    </span>
                  </div>

                  <div className="provider-meta-strip">
                    <span>
                      Formato: <code>{googleFormatLabel}</code>
                    </span>
                    <span>
                      1er parcial:{' '}
                      <code>
                        {googleTimeToFirstPartialMs !== null
                          ? `${googleTimeToFirstPartialMs}ms`
                          : '—'}
                      </code>
                    </span>
                    <span>
                      Confianza:{' '}
                      <code>
                        {googleAvgConfidence !== null
                          ? `${Math.round(googleAvgConfidence * 100)}%`
                          : '—'}
                      </code>
                    </span>
                  </div>

                  <div className="transcript-viewport provider-transcript-box">
                    {!googleFullTranscript ? (
                      <p className="transcript-placeholder">
                        {!isGoogleReady
                          ? 'Configura GOOGLE_CREDENTIALS_JSON en .env para activar Chirp 3.'
                          : isStreaming
                            ? 'Escuchando en Google STT v2 (Chirp 3)...'
                            : 'Esperando grabación...'}
                      </p>
                    ) : (
                      <div className="transcript-flow">
                        <span className="committed-segment">
                          {googleFullTranscript}
                        </span>
                        {normalizeAlphanumeric &&
                          liveGoogleAccuracy?.normalizedHypothesis && (
                            <div
                              style={{
                                marginTop: '0.45rem',
                                paddingTop: '0.35rem',
                                borderTop: '1px dashed rgba(148, 163, 184, 0.25)',
                                fontSize: '0.78rem',
                                color: '#94a3b8',
                              }}
                              title="Secuencia normalizada usada para calcular el WER (sin puntuación, letras y números unificados)"
                            >
                              <strong style={{ color: '#cbd5e1' }}>Norm:</strong>{' '}
                              <code>{liveGoogleAccuracy.normalizedHypothesis}</code>
                            </div>
                          )}
                      </div>
                    )}
                  </div>

                  <div className="provider-wer-footer">
                    <div>
                      <span className="tel-label">WER Google: </span>
                      <strong
                        className={formatWerBadgeClass(liveGoogleAccuracy?.wer)}
                        style={{ fontSize: '1.05rem' }}
                      >
                        {liveGoogleAccuracy !== null
                          ? `${(liveGoogleAccuracy.wer * 100).toFixed(1)}%`
                          : '—'}
                      </strong>
                    </div>
                    {liveGoogleAccuracy && (
                      <span className="provider-diff-counts">
                        S:{liveGoogleAccuracy.substitutions} • D:
                        {liveGoogleAccuracy.deletions} • I:
                        {liveGoogleAccuracy.insertions}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {selectedEngineIds.length === 0 && (
                <div className="empty-engines-alert" style={{ gridColumn: '1 / -1', padding: '2rem', textAlign: 'center' }}>
                  <p className="text-muted">No hay motores STT seleccionados. Activa al menos un motor en la barra superior.</p>
                </div>
              )}
            </div>

            {/* 2. Texto Real (Ground Truth) compartido para evaluar todos los motores */}
            <div className="form-row">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '0.4rem',
                }}
              >
                <label htmlFor="real-transcript-textarea">
                  Texto Real de Referencia (Ground Truth para calcular el WER de todos los motores)
                </label>
                <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  <button
                    type="button"
                    className={`btn btn-xs ${
                      normalizeAlphanumeric ? 'btn-primary' : 'btn-secondary'
                    }`}
                    onClick={() => setNormalizeAlphanumeric((prev) => !prev)}
                    title="Equipara números escritos ('uno dos') con dígitos ('1 2' o '12') y nombres de letras ('be', 'uve', 'equis') con letras ('b', 'v', 'x'), ignorando signos de puntuación en el cálculo del WER"
                  >
                    <Sliders size={11} /> Normalizar WER (1=uno, B=be):{' '}
                    <strong>{normalizeAlphanumeric ? 'ON' : 'OFF'}</strong>
                  </button>
                  {realTranscript.trim() && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => {
                        setIsRealTranscriptEdited(true);
                        setRealTranscript(
                          normalizeSpanishAlphanumericText(realTranscript)
                        );
                      }}
                      title="Convertir directamente el Texto Real a su forma alfanumérica normalizada (ej: 'uno, dos, be' -> '1 2 b')"
                    >
                      <RefreshCw size={11} /> Normalizar Texto
                    </button>
                  )}
                  {fullTranscript && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => {
                        setRealTranscript(fullTranscript);
                        setIsRealTranscriptEdited(false);
                      }}
                      title="Usar transcripción de ElevenLabs como base"
                    >
                      <RotateCcw size={11} /> Base ElevenLabs
                    </button>
                  )}
                  {gladiaFullTranscript && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => {
                        setRealTranscript(gladiaFullTranscript);
                        setIsRealTranscriptEdited(true);
                      }}
                      title="Usar transcripción de Gladia como base"
                    >
                      <RotateCcw size={11} /> Base Gladia
                    </button>
                  )}
                  {googleFullTranscript && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => {
                        setRealTranscript(googleFullTranscript);
                        setIsRealTranscriptEdited(true);
                      }}
                      title="Usar transcripción de Google STT v2 como base"
                    >
                      <RotateCcw size={11} /> Base Google
                    </button>
                  )}
                </div>
              </div>
              <textarea
                id="real-transcript-textarea"
                className="form-textarea"
                rows={3}
                placeholder="Escribe o corrige aquí lo que realmente dijiste para comparar el WER de ElevenLabs, Gladia y Google Chirp 3..."
                value={realTranscript}
                onChange={(e) => {
                  setIsRealTranscriptEdited(true);
                  setRealTranscript(e.target.value);
                }}
              />
              {normalizeAlphanumeric && realTranscript.trim() && (
                <div
                  style={{
                    marginTop: '0.35rem',
                    fontSize: '0.78rem',
                    color: '#94a3b8',
                  }}
                >
                  <strong style={{ color: '#cbd5e1' }}>
                    Referencia normalizada para WER:
                  </strong>{' '}
                  <code>{normalizeSpanishAlphanumericText(realTranscript)}</code>
                </div>
              )}
            </div>

            {/* 3. Veredicto en vivo + Botón de Guardar Resultado */}
            <div className="eval-controls-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <Trophy size={16} className="icon-accent" />
                <span className="tel-label">Resultado Comparativo:</span>
                {liveWinner === 'elevenlabs' && (
                  <span className="winner-pill winner-elevenlabs">
                    Mejor ElevenLabs (
                    {liveElevenLabsAccuracy
                      ? `${(liveElevenLabsAccuracy.wer * 100).toFixed(1)}%`
                      : '0%'}
                    )
                  </span>
                )}
                {liveWinner === 'gladia' && (
                  <span className="winner-pill winner-gladia">
                    Mejor Gladia (
                    {liveGladiaAccuracy
                      ? `${(liveGladiaAccuracy.wer * 100).toFixed(1)}%`
                      : '0%'}
                    )
                  </span>
                )}
                {liveWinner === 'google' && (
                  <span className="winner-pill winner-google">
                    Mejor Google Chirp 3 (
                    {liveGoogleAccuracy
                      ? `${(liveGoogleAccuracy.wer * 100).toFixed(1)}%`
                      : '0%'}
                    )
                  </span>
                )}
                {liveWinner === 'tie' && (
                  <span className="winner-pill winner-tie">
                    Empate Técnico
                  </span>
                )}
                {!liveWinner && (
                  <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                    Graba un audio para comparar los motores activos
                  </span>
                )}
              </div>

              <button
                type="button"
                className={`btn ${isAlreadySaved ? 'btn-saved' : 'btn-primary'}`}
                onClick={() => void saveCurrentTestResult()}
                disabled={
                  (!fullTranscript &&
                    !gladiaFullTranscript &&
                    !googleFullTranscript &&
                    !latestProcessedWavBytes) ||
                  isStreaming ||
                  isSavingTest ||
                  isAlreadySaved
                }
                title={
                  isAlreadySaved
                    ? 'Esta prueba ya ha sido guardada. Inicia una nueva grabación para guardar otra.'
                    : 'Guardar comparativa de los motores activos y archivo WAV'
                }
              >
                {isAlreadySaved ? (
                  <>
                    <CheckCircle2 size={16} /> Resultado Guardado
                  </>
                ) : isSavingTest ? (
                  <>
                    <Save size={16} /> Guardando...
                  </>
                ) : (
                  <>
                    <Save size={16} /> Guardar Comparativa
                  </>
                )}
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* Bottom Section: Resumen Comparativo de WER y Tabla de Resultados */}
      <section className="bottom-section lab-card">
        <div className="bottom-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <BarChart3 size={20} className="icon-accent" />
            <h2 style={{ margin: 0, fontSize: '1.05rem' }}>
              Benchmark Comparativo: ElevenLabs vs Gladia vs Google Chirp 3 (
              {savedResults.length})
            </h2>
          </div>

          <div className="export-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                exportResultsToCsv(savedResults);
                notify('success', 'Comparativa exportada a CSV.');
              }}
              disabled={savedResults.length === 0}
            >
              <Download size={14} /> Export CSV
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                exportResultsToJson(savedResults);
                notify('success', 'Comparativa exportada a JSON.');
              }}
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

        {/* Resumen de WER Global y por Telephony Profile (ElevenLabs vs Gladia vs Google) */}
        <div
          className="accuracy-kpi-row"
          style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: '1rem' }}
        >
          <div className="kpi-box">
            <span className="kpi-title">
              WER Promedio Global ({werSummary.totalRuns} pruebas)
            </span>
            <div className="kpi-dual-values">
              <div>
                <small className="kpi-provider-tag tag-el">ElevenLabs:</small>{' '}
                <strong className="kpi-num-sm">
                  {werSummary.globalElAvgWer !== null
                    ? `${werSummary.globalElAvgWer.toFixed(1)}%`
                    : '—'}
                </strong>
              </div>
              <div>
                <small className="kpi-provider-tag tag-gl">Gladia:</small>{' '}
                <strong className="kpi-num-sm">
                  {werSummary.globalGlAvgWer !== null
                    ? `${werSummary.globalGlAvgWer.toFixed(1)}%`
                    : '—'}
                </strong>
              </div>
              <div>
                <small className="kpi-provider-tag tag-go">Google:</small>{' '}
                <strong className="kpi-num-sm">
                  {werSummary.globalGoAvgWer !== null
                    ? `${werSummary.globalGoAvgWer.toFixed(1)}%`
                    : '—'}
                </strong>
              </div>
            </div>
            {(werSummary.elWins > 0 ||
              werSummary.glWins > 0 ||
              werSummary.goWins > 0 ||
              werSummary.ties > 0) && (
              <span className="kpi-sub">
                Victorias: EL {werSummary.elWins} • GL {werSummary.glWins} • GO{' '}
                {werSummary.goWins} • Empates {werSummary.ties}
              </span>
            )}
          </div>

          {werSummary.byProfile.map((p) => (
            <div key={p.profileId} className="kpi-box">
              <span className="kpi-title">
                {p.label} ({p.count} {p.count === 1 ? 'prueba' : 'pruebas'})
              </span>
              <div className="kpi-dual-values">
                <div>
                  <small className="kpi-provider-tag tag-el">ElevenLabs:</small>{' '}
                  <strong className="kpi-num-sm">
                    {p.avgElWer !== null ? `${p.avgElWer.toFixed(1)}%` : '—'}
                  </strong>
                </div>
                <div>
                  <small className="kpi-provider-tag tag-gl">Gladia:</small>{' '}
                  <strong className="kpi-num-sm">
                    {p.avgGlWer !== null ? `${p.avgGlWer.toFixed(1)}%` : '—'}
                  </strong>
                </div>
                <div>
                  <small className="kpi-provider-tag tag-go">Google:</small>{' '}
                  <strong className="kpi-num-sm">
                    {p.avgGoWer !== null ? `${p.avgGoWer.toFixed(1)}%` : '—'}
                  </strong>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Tabla de Resultados Guardados */}
        <div className="history-table-container">
          {savedResults.length === 0 ? (
            <p className="empty-history-msg">
              No hay resultados guardados todavía. Realiza una grabación,
              corrige el <strong>Texto Real</strong> si hubo algún error y pulsa{' '}
              <strong>"Guardar Comparativa"</strong>.
            </p>
          ) : (
            <table className="benchmark-table">
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Perfil Telefónico</th>
                  <th>Audio Guardado</th>
                  <th>Texto Real (Ref)</th>
                  <th>ElevenLabs (Scribe v2)</th>
                  <th>WER EL</th>
                  <th>Gladia (Solaria-1)</th>
                  <th>WER GL</th>
                  <th>Google (Chirp 3)</th>
                  <th>WER GO</th>
                  <th>Ganador</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {savedResults.map((r) => {
                  const elWer = r.accuracy ? r.accuracy.wer : null;
                  const glWer = r.gladia?.accuracy ? r.gladia.accuracy.wer : null;
                  const goWer = r.google?.accuracy ? r.google.accuracy.wer : null;

                  const candidates: Array<{
                    id: 'elevenlabs' | 'gladia' | 'google';
                    wer: number;
                  }> = [];
                  if (elWer !== null && (r.finalTranscript || r.sessionId)) {
                    candidates.push({ id: 'elevenlabs', wer: elWer });
                  }
                  if (
                    glWer !== null &&
                    (r.gladia?.finalTranscript || r.gladia?.sessionId)
                  ) {
                    candidates.push({ id: 'gladia', wer: glWer });
                  }
                  if (
                    goWer !== null &&
                    (r.google?.finalTranscript || r.google?.sessionId)
                  ) {
                    candidates.push({ id: 'google', wer: goWer });
                  }

                  let rowWinner: 'elevenlabs' | 'gladia' | 'google' | 'tie' | null =
                    null;
                  if (candidates.length >= 2) {
                    const minWer = Math.min(...candidates.map((c) => c.wer));
                    const best = candidates.filter(
                      (c) => Math.abs(c.wer - minWer) < 1e-6
                    );
                    rowWinner = best.length > 1 ? 'tie' : best[0]!.id;
                  }

                  return (
                    <tr key={r.id}>
                      <td>{new Date(r.createdAt).toLocaleTimeString()}</td>
                      <td>
                        <span className={`profile-pill profile-${r.profileId}`}>
                          {AUDIO_PROFILES[r.profileId].shortLabel}
                        </span>
                        <div className="text-muted" style={{ fontSize: '0.7rem', marginTop: '2px' }}>
                          <code>
                            {r.inputSampleRate}→{r.outputSampleRate}Hz
                          </code>
                        </div>
                      </td>
                      <td>
                        <SavedAudioPlayerCell
                          runId={r.id}
                          profileId={r.profileId}
                          hasSavedAudio={r.hasSavedAudio}
                        />
                      </td>
                      <td className="td-transcript" title={r.referenceTranscript}>
                        {r.referenceTranscript || <em>(vacío)</em>}
                      </td>
                      <td className="td-transcript" title={r.finalTranscript}>
                        {r.finalTranscript || <em>(vacío)</em>}
                      </td>
                      <td>
                        {elWer !== null ? (
                          <strong className={formatWerBadgeClass(elWer)}>
                            {(elWer * 100).toFixed(1)}%
                          </strong>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td
                        className="td-transcript"
                        title={r.gladia?.finalTranscript ?? ''}
                      >
                        {r.gladia?.finalTranscript ? (
                          r.gladia.finalTranscript
                        ) : (
                          <em className="text-muted">(sin datos Gladia)</em>
                        )}
                      </td>
                      <td>
                        {glWer !== null ? (
                          <strong className={formatWerBadgeClass(glWer)}>
                            {(glWer * 100).toFixed(1)}%
                          </strong>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td
                        className="td-transcript"
                        title={r.google?.finalTranscript ?? ''}
                      >
                        {r.google?.finalTranscript ? (
                          r.google.finalTranscript
                        ) : (
                          <em className="text-muted">(sin datos Google)</em>
                        )}
                      </td>
                      <td>
                        {goWer !== null ? (
                          <strong className={formatWerBadgeClass(goWer)}>
                            {(goWer * 100).toFixed(1)}%
                          </strong>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {rowWinner === 'elevenlabs' && (
                          <span className="winner-pill winner-elevenlabs">
                            ElevenLabs
                          </span>
                        )}
                        {rowWinner === 'gladia' && (
                          <span className="winner-pill winner-gladia">Gladia</span>
                        )}
                        {rowWinner === 'google' && (
                          <span className="winner-pill winner-google">Google</span>
                        )}
                        {rowWinner === 'tie' && (
                          <span className="winner-pill winner-tie">Empate</span>
                        )}
                        {!rowWinner && <span className="text-muted">—</span>}
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
                  );
                })}
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
        gladiaApiKeyConfigured={isGladiaReady}
        maskedGladiaApiKey={health?.maskedGladiaApiKey ?? null}
        googleConfigured={isGoogleReady}
        maskedGoogleKey={health?.maskedGoogleKey ?? null}
        upstreamEndpoint={
          health?.upstreamEndpoint ??
          'wss://api.elevenlabs.io/v1/speech-to-text/realtime'
        }
      />
    </div>
  );
};
