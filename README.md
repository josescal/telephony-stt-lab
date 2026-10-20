# Telephony STT Lab — ElevenLabs Scribe v2 vs. Gladia Live v2 Benchmark

**Telephony STT Lab** is a full-stack TypeScript, Node.js, React, and Vite benchmarking suite designed to evaluate and compare **ElevenLabs Scribe v2 Real-time** (`scribe_v2_realtime`) and **Gladia Live v2** (`solaria-1`) speech-to-text accuracy (**WER**) and latency side-by-side under authentic telephone-quality audio conditions.

---

## Key Features

1. **Simultaneous Dual-Engine Streaming (ElevenLabs vs. Gladia)**:
   - Captures a single microphone stream, processes each audio chunk **once** through the active DSP telephony profile, and dispatches the **exact same processed audio bytes simultaneously** to:
     - **ElevenLabs Scribe v2 Realtime (`scribe_v2_realtime`)** via `/api/ws/stt` (Base64 `input_audio_chunk`).
     - **Gladia Live v2 (`solaria-1`)** via an ephemeral session initialized at `POST /api/gladia/session` (`https://api.gladia.io/v2/live?region=eu-west`) and binary WebSocket streaming.
   - Pre-handshake chunk buffering ensures neither engine loses initial syllables while WebSockets are connecting.

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
│   ├── benchmarks.json           # Persistent comparative benchmark runs (ElevenLabs + Gladia WER & latencies)
│   └── audio/                    # Saved processed WAV files (8-bit μ-law mono / 16-bit PCM mono)
└── src/
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
    │   └── index.ts              # Express HTTP server, /api/gladia/session endpoint & static hosting
    └── client/
        ├── App.tsx               # Main UI: dual ElevenLabs/Gladia streaming, side-by-side WER & benchmark table
        ├── styles.css            # Responsive dark UI theme, dual comparison cards & toast notifications
        ├── components/
        │   ├── WaveformMeter.tsx # Real-time canvas oscilloscope & dBFS level meter
        │   └── SetupGuideModal.tsx # Interactive setup & dual-engine DSP pipeline documentation modal
        └── services/
            └── storageAndExport.ts # Backend API sync, comparative CSV/JSON export & WAV download helpers
```
