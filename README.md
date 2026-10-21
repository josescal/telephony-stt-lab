# Telephony STT Lab — Multi-Engine STT Benchmark (ElevenLabs, Gladia & Extensible)

**Telephony STT Lab** is a modular TypeScript, Node.js, React, and Vite benchmarking laboratory designed to evaluate, compare, and benchmark multiple Speech-to-Text (**STT**) engines side-by-side (currently **ElevenLabs Scribe v2** and **Gladia Live v2**, with a pluggable adapter architecture to easily add **Deepgram**, **Whisper**, **AssemblyAI**, etc.) under authentic telephone-quality audio conditions (G.711 $\mu$-law, 8kHz PCM, and Wideband).

---

## Key Features

1. **Pluggable Multi-Engine STT Architecture**:
   - Central registry and standard interface [`STTEngineAdapter`](src/engines/base/types.ts):
     - **ElevenLabs Scribe v2 Realtime (`scribe_v2_realtime`)**: Full-duplex WebSocket streaming with timestamps and punctuation.
     - **Gladia Live v2 (`solaria-1`)**: Multilingual low-latency streaming via ephemeral session tokens and binary audio chunks.
   - **Engine Selector Bar**: Dynamic toggling to test individual engines or multiple engines simultaneously in parallel from a single microphone or audio stream.
   - Server endpoint `GET /api/engines` for dynamic engine discovery, capabilities, and API key readiness.

2. **Three Authentic Audio Processing Profiles**:
   - **G.711 μ-law 8kHz (`ulaw_8000`, default)**: Applies a cascaded 4th-order Butterworth **300–3400 Hz telephone bandpass filter** at the native input sample rate **before** anti-aliased resampling to **8000 Hz**, followed by authentic **ITU-T G.711 μ-law logarithmic 8-bit mono encoding** (`encodePcm16ToMuLaw`). Sent to ElevenLabs as `ulaw_8000` and to Gladia as `wav/ulaw` (`8-bit, 8000 Hz`). Saved `.wav` files are encoded as true **8-bit ITU-T G.711 μ-law (`WAVE_FORMAT_MULAW = 0x0007`), 8000 Hz, Mono, 64 kbps**.
   - **PCM 16-bit 8kHz (`pcm_8000`)**: Applies the **300–3400 Hz telephone bandpass filter** before anti-aliased resampling to **8000 Hz**, and **16-bit signed linear PCM mono quantization** (`pcm_8000` / `wav/pcm 16-bit 8000 Hz`).
   - **Original Wideband (`original`)**: Preserves wideband microphone audio (`pcm_16000` to `pcm_48000`, 16-bit PCM, Mono) without telephone bandpass filtering for baseline comparison.
   - **Cookie Persistence**: The last selected `Telephony Profile` is automatically persisted in the `scribe_active_profile` cookie.

3. **Streamlined Workbench Layout**:
   - **Horizontal Configuration Bar**: Compact single-line bar directly below the top header for quick selection of **Telephony Profile**, **Idioma (ISO)**, and **Commit Strategy** (`VAD Automático` or `Manual`).
   - **Left Column (Capture & Simple Listening Indicator)**: Live microphone recording controls, a lightweight listening indicator with a live voice level bar (`dBFS`), live DSP resampling verification, and immediate playback/download of the processed WAV.
   - **Right Column (Side-by-Side Comparison & Ground-Truth Correction)**:
     - **1. Comparativa en Vivo (ElevenLabs vs Gladia)**: Displays side-by-side cards with real-time partials, committed transcripts, handshake/first-partial/first-commit latencies, Gladia confidence %, and per-engine WER with an automatic winner badge.
     - **2. Texto Real (Ground Truth Común)**: Shared reference text (with quick buttons to copy from ElevenLabs or Gladia) used to compute exact **Word Error Rate (WER)** for both providers simultaneously.
     - **3. Save Comparative Benchmark**: Duplicate-save protection and floating toast notifications.
   - **Bottom Section (Comparative WER Summary & Benchmark Table)**:
     - Side-by-side global average **WER**, per-profile **WER** (`EL` vs `GL`), and win/tie counters.
     - Historical table of saved runs with inline processed `.wav` playback/download, ElevenLabs and Gladia transcripts, comparative WER badges, winner indicator, and **CSV / JSON** export.

4. **Persistent Disk Storage (`data/`)**:
   - Benchmark metadata and comparative WER results are persisted on the server in `data/benchmarks.json`.
   - Processed audio recordings are stored on disk in `data/audio/<runId>.wav` in their exact target telephony encoding (`8-bit μ-law 8kHz mono` or `16-bit PCM mono`).

---

## Audio Profiles & Provider Format Mapping

| UI Profile | `profileId` | ElevenLabs Format | Gladia Live v2 Format | Sample Rate | WAV Encoding (`data/audio/*.wav`) | Bitrate |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **G.711 μ-law 8kHz** | `ulaw_8000` | `ulaw_8000` | `wav/ulaw` (8-bit) | `8000 Hz` | 8-bit ITU-T G.711 μ-law (`0x0007`) | `64 kbps` |
| **PCM 16-bit 8kHz** | `pcm_8000` | `pcm_8000` | `wav/pcm` (16-bit) | `8000 Hz` | 16-bit Signed Integer PCM (`0x0001`) | `128 kbps` |
| **Original (Wideband)** | `original` | `pcm_48000` (or closest) | `wav/pcm` (16-bit) | `16000–48000 Hz` | 16-bit Signed Integer PCM (`0x0001`) | `256–768 kbps` |

> **Note on `sox --info` with `ulaw_8000` WAV files:** `sox` reports `Sample Encoding: 8-bit u-law` (1 byte per sample physical storage, 64 kbps) and `Precision: 14-bit` because the ITU-T G.711 μ-law logarithmic curve compresses 14-bit linear PCM dynamic range into 8-bit samples.

---

## Prerequisites & Setup

### 1. Install Dependencies

Requires **Node.js 18+** and **npm**:

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and add your ElevenLabs and Gladia API keys:

```bash
cp .env.example .env
```

Edit `.env`:

```dotenv
PORT=3001
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
ELEVENLABS_WS_URL=wss://api.elevenlabs.io/v1/speech-to-text/realtime
GLADIA_API_KEY=your_gladia_api_key_here
GLADIA_LIVE_URL=https://api.gladia.io/v2/live?region=eu-west
```

### 3. Run in Development Mode

Starts both the Express + WebSocket proxy server (`http://localhost:3001`) and the Vite React frontend (`http://localhost:5173`):

```bash
npm run dev
```

Open **`http://localhost:5173`** in your browser.

---

## Package Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Run both the Node.js WebSocket proxy server and Vite frontend concurrently |
| `npm run build` | Build the React client (`dist/client`) and compile the TypeScript server (`dist/server`) |
| `npm start` | Start the compiled production server on `PORT` (serves both API/WebSocket and static frontend) |
| `npm test` | Run the Vitest unit test suite (G.711 μ-law, bandpass filter, resampler, WAV parser, Gladia format mapping, WER) |
| `npm run typecheck` | Run strict TypeScript type-checking across client, shared, tests, and server |

---

## Project Architecture

```text
├── data/
│   ├── benchmarks.json           # Persistent comparative benchmark runs (WER, latencies & transcripts)
│   └── audio/                    # Saved processed WAV files (8-bit μ-law mono / 16-bit PCM mono)
├── tests/
│   └── engines.test.ts           # Vitest tests for STT engine registry, instantiation & metadata
└── src/
    ├── engines/                  # Pluggable Multi-Engine STT Architecture
    │   ├── base/
    │   │   ├── types.ts          # Universal STTEngineAdapter interface, metadata, capabilities & session config
    │   │   └── registry.ts       # Central engine registry (registerEngine, createEngineAdapter, getRegisteredEngines)
    │   ├── elevenlabs/
    │   │   └── adapter.ts        # ElevenLabs Scribe v2 realtime adapter implementation
    │   ├── gladia/
    │   │   └── adapter.ts        # Gladia Live v2 (solaria-1) adapter implementation
    │   └── index.ts              # Registry bootstrap auto-registering default engines
    ├── shared/
    │   ├── types.ts              # Shared types, Scribe v2 & Gladia metrics, benchmark models
    │   ├── gladia/
    │   │   └── liveSession.ts    # Gladia Live v2 (solaria-1) session payload builder & format resolver
    │   ├── audio/
    │   │   ├── g711.ts           # ITU-T G.711 μ-law 8-bit encoder/decoder & SQNR analysis
    │   │   ├── biquadFilter.ts   # Direct Form II Transposed biquad & 300-3400 Hz Butterworth filter
    │   │   ├── resampler.ts      # Streaming anti-aliased resampler & mono downmixer
    │   │   ├── wavParser.ts      # RIFF WAV decoder & encoders (16-bit PCM & 8-bit G.711 μ-law)
    │   │   └── profileProcessor.ts # Real-time & batch DSP pipeline for original, pcm_8000, ulaw_8000
    │   └── metrics/
    │       └── werCer.ts         # Word Error Rate (WER) & word-level Levenshtein alignment
    ├── server/
    │   ├── env.ts                # Zod environment variable validation & API key masking
    │   ├── wsProxy.ts            # Secure WebSocket proxy (/api/ws/stt -> ElevenLabs Scribe v2)
    │   ├── benchmarkStore.ts     # Persistent disk storage for benchmarks.json & data/audio/*.wav
    │   └── index.ts              # Express server: /api/engines, /api/gladia/session & static hosting
    └── client/
        ├── App.tsx               # Main UI: multi-engine streaming, side-by-side WER & benchmark table
        ├── styles.css            # Responsive dark UI theme & engine selector chip styles
        ├── components/
        │   ├── WaveformMeter.tsx # Real-time canvas oscilloscope & dBFS level meter
        │   ├── SetupGuideModal.tsx # Interactive setup & dual-engine DSP pipeline documentation modal
        │   └── engines/
        │       └── EngineSelectorBar.tsx # Dynamic chip selector to toggle active STT engines
        └── services/
            └── storageAndExport.ts # Backend API sync, comparative CSV/JSON export & WAV download helpers
```

---

## How to Add a New STT Engine (e.g., Deepgram, Whisper, AssemblyAI)

Adding a new Speech-to-Text engine to the lab requires 3 simple steps:

### 1. Implement the `STTEngineAdapter` interface

Create `src/engines/<engine-name>/adapter.ts`:

```typescript
import {
  STTEngineAdapter,
  EngineMetadata,
  EngineCapabilities,
  EngineSessionConfig,
  EngineCallbacks,
} from '../base/types.js';

export const MY_ENGINE_METADATA: EngineMetadata = {
  id: 'my_engine',
  name: 'My STT Engine',
  vendor: 'MyCompany',
  description: 'Real-time low-latency speech recognition',
  website: 'https://example.com',
  docsUrl: 'https://example.com/docs',
};

export const MY_ENGINE_CAPABILITIES: EngineCapabilities = {
  supportedProfiles: ['ulaw_8000', 'pcm_8000', 'original'],
  supportsInterimResults: true,
  supportsTimestamps: true,
  requiresProxy: false,
};

export class MyEngineAdapter implements STTEngineAdapter {
  readonly metadata = MY_ENGINE_METADATA;
  readonly capabilities = MY_ENGINE_CAPABILITIES;

  async connect(config: EngineSessionConfig, callbacks: EngineCallbacks): Promise<void> {
    // 1. Establish WebSocket / HTTP streaming connection
    // 2. Invoke callbacks.onInterimResult({ transcript, latencyMs }) on partials
    // 3. Invoke callbacks.onFinalResult({ transcript, latencyMs }) on commits
  }

  sendAudio(chunk: ArrayBuffer | Uint8Array): void {
    // Transmit audio chunk to the engine
  }

  async disconnect(): Promise<void> {
    // Close connection and clean up resources
  }
}
```

### 2. Register the engine in `src/engines/index.ts`

```typescript
import { registerEngine } from './base/registry.js';
import { MyEngineAdapter, MY_ENGINE_METADATA } from './my_engine/adapter.js';

// Register your engine factory
registerEngine(MY_ENGINE_METADATA, () => new MyEngineAdapter());
```

### 3. (Optional) Backend credentials & Discovery

- Add any required API keys to `.env.example`, `.env`, and `src/server/env.ts`.
- If an ephemeral token or proxy is needed (like ElevenLabs or Gladia), register the proxy or session route in `src/server/index.ts`.
- The engine will automatically be discovered by the server (`GET /api/engines`) and appear dynamically in the UI's **Engine Selector Bar**!
