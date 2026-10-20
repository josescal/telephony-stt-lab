# Telephony STT Lab — ElevenLabs Scribe v2 Realtime Benchmark

**Telephony STT Lab** is a full-stack TypeScript, Node.js, React, and Vite benchmarking suite designed to evaluate **ElevenLabs Scribe v2 Real-time** (`scribe_v2_realtime`) speech-to-text accuracy and latency under authentic telephone-quality audio conditions.

---

## Features

1. **Three Authentic Audio Processing Profiles**:
   - **Original Wideband (`original`)**: Mono 16-bit PCM preserved at the source/closest supported wideband sample rate (`pcm_16000` to `pcm_48000`) with no telephone bandpass filtering.
   - **PSTN Narrowband PCM (`pcm_8000`)**: Applies a cascaded 4th-order Butterworth **300–3400 Hz telephone bandpass filter**, anti-aliased resampling to **8000 Hz**, and 16-bit signed linear PCM quantization (`pcm_8000`).
   - **Simulated G.711 μ-law (`ulaw_8000`)**: Applies the **300–3400 Hz telephone bandpass filter**, resamples to **8000 Hz**, performs authentic **ITU-T G.711 μ-law logarithmic 8-bit encoding** (`encodePcm16ToMuLaw`) for the ElevenLabs `ulaw_8000` stream, and decodes the companded signal (`decodeMuLawToPcm16`) for degraded audio playback/download and SQNR measurement (~38 dB SQNR).
2. **Real-Time Microphone Capture & WAV Upload**:
   - Live microphone capture with real-time DSP filtering/resampling/companding and streaming over WebSocket.
   - Upload any `.wav` file (supports 8/16/24/32-bit PCM, 32/64-bit IEEE Float, and 8-bit G.711 μ-law WAVs), preview or download the processed telephone-degraded audio, and stream at real-time (`1×`) or accelerated (`2×`, `4×`) pacing.
3. **Secure Node.js WebSocket Proxy**:
   - Connects to the official ElevenLabs endpoint (`wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime`).
   - Injects `xi-api-key` server-side from `.env` (`ELEVENLABS_API_KEY`) so your API key is never exposed to the browser.
4. **Live Telemetry, WER / CER & Word Alignment**:
   - Real-time waveform oscilloscope, dBFS RMS/peak meter, partial and committed transcript stream, connection time, time-to-first-partial, time-to-first-committed, and mean commit latency.
   - Dynamic **Word Error Rate (WER)** and **Character Error Rate (CER)** calculation against a reference transcript with word-level Levenshtein alignment (`correct`, `substitution`, `insertion`, `deletion`).
5. **Local Persistence, Export & Multi-Profile Comparison**:
   - Automatically saves benchmark runs to browser `localStorage`, supports **CSV** and **JSON** export, and groups repeated runs by source audio in the **Comparison Matrix** view.

---

## Verified ElevenLabs Scribe v2 Realtime Protocol

- **WebSocket Endpoint**: `wss://api.elevenlabs.io/v1/speech-to-text/realtime`
- **Authentication**: `xi-api-key: <ELEVENLABS_API_KEY>` header injected by the Node.js proxy (`src/server/wsProxy.ts`).
- **Query Parameters**:
  - `model_id=scribe_v2_realtime`
  - `audio_format`: `pcm_8000` | `pcm_16000` | `pcm_22050` | `pcm_24000` | `pcm_44100` | `pcm_48000` | `ulaw_8000`
  - `commit_strategy`: `vad` | `manual`
  - `vad_silence_threshold_secs`, `vad_threshold`, `include_timestamps`, `language_code`
- **Client → Server Message (`input_audio_chunk`)**:
  ```json
  {
    "message_type": "input_audio_chunk",
    "audio_base_64": "<base64 encoded PCM16LE or G.711 u-law bytes>",
    "commit": false,
    "sample_rate": 8000
  }
  ```
- **Server → Client Messages**:
  - `session_started`
  - `partial_transcript`
  - `committed_transcript`
  - `committed_transcript_with_timestamps`
  - `edited_transcript`
  - `warning`
  - Error events (`error`, `auth_error`, `quota_exceeded`, `rate_limited`, `commit_throttled`, `TranscriberError`, `input_error`, `chunk_size_exceeded`, `insufficient_audio_activity`, `transcriber_error`, `queue_overflow`, `resource_exhausted`, `session_time_limit_exceeded`, `unaccepted_terms`)

---

## Prerequisites & Setup

### 1. Install Dependencies

Requires **Node.js 18+** and **npm**:

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and add your ElevenLabs API key:

```bash
cp .env.example .env
```

Edit `.env`:

```dotenv
PORT=3001
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
ELEVENLABS_WS_URL=wss://api.elevenlabs.io/v1/speech-to-text/realtime
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
| `npm test` | Run the Vitest unit test suite (G.711 μ-law, bandpass filter, resampler, WAV parser, WER/CER) |
| `npm run typecheck` | Run strict TypeScript type-checking across client, shared, tests, and server |

---

## Project Architecture

```text
src/
├── shared/
│   ├── types.ts                  # Shared types, Scribe v2 Realtime WS payloads, benchmark models
│   ├── audio/
│   │   ├── mulaw.ts              # ITU-T G.711 μ-law 8-bit encoder/decoder & SQNR analysis
│   │   ├── biquadFilter.ts       # Direct Form II Transposed biquad & 300-3400 Hz Butterworth filter
│   │   ├── resampler.ts          # Streaming anti-aliased resampler & mono downmixer
│   │   ├── wavParser.ts          # RIFF WAV decoder (PCM/Float/μ-law) & 16-bit WAV encoder
│   │   └── profileProcessor.ts   # Streaming & batch pipeline for original, pcm_8000, ulaw_8000
│   └── metrics/
│       └── werCer.ts             # Word Error Rate (WER), Character Error Rate (CER) & alignment
├── server/
│   ├── env.ts                    # Zod environment variable validation & API key masking
│   ├── wsProxy.ts                # Secure WebSocket proxy (/api/ws/stt -> ElevenLabs Scribe v2)
│   └── index.ts                  # Express HTTP server, /api/health endpoint & static hosting
└── client/
    ├── App.tsx                   # Main benchmarking studio, mic/WAV streaming & live telemetry
    ├── components/
    │   ├── WaveformMeter.tsx     # Real-time canvas oscilloscope & dBFS level meter
    │   ├── ComparisonView.tsx    # Multi-profile side-by-side comparison matrix
    │   └── SetupGuideModal.tsx   # Interactive setup & DSP pipeline documentation modal
    └── services/
        └── storageAndExport.ts   # LocalStorage persistence, CSV & JSON export
```
