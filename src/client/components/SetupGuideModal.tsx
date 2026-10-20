import React from 'react';
import { X, Terminal, ShieldCheck, Cpu, Radio } from 'lucide-react';

interface SetupGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
  apiKeyConfigured: boolean;
  maskedApiKey: string | null;
  upstreamEndpoint: string;
}

export const SetupGuideModal: React.FC<SetupGuideModalProps> = ({
  isOpen,
  onClose,
  apiKeyConfigured,
  maskedApiKey,
  upstreamEndpoint,
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-group">
            <Terminal size={20} className="icon-accent" />
            <h2>Telephony STT Lab — Setup & Architecture Guide</h2>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close setup guide">
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          <section className="guide-section">
            <h3>
              <ShieldCheck size={17} /> 1. Environment & API Key Configuration
            </h3>
            <p>
              To protect your credentials, the browser never connects directly with your ElevenLabs
              API key. Instead, the Node.js backend proxy attaches the{' '}
              <code>xi-api-key</code> header server-side when opening the WebSocket to{' '}
              <code>{upstreamEndpoint}</code>.
            </p>
            <div className="status-callout">
              <span>Current Backend Key Status: </span>
              {apiKeyConfigured ? (
                <strong className="text-success">
                  Configured ({maskedApiKey})
                </strong>
              ) : (
                <strong className="text-danger">
                  Not Configured — Set ELEVENLABS_API_KEY in .env
                </strong>
              )}
            </div>
            <pre className="code-snippet">
{`# 1. Copy the example environment file
cp .env.example .env

# 2. Add your ElevenLabs API key in .env
ELEVENLABS_API_KEY=your_actual_elevenlabs_api_key
PORT=3001

# 3. Start both backend proxy and Vite frontend
npm run dev`}
            </pre>
          </section>

          <section className="guide-section">
            <h3>
              <Cpu size={17} /> 2. Authentic Telephony DSP Processing Pipeline
            </h3>
            <p>
              Unlike tools that only alter WAV header metadata, Telephony STT Lab performs genuine
              digital signal processing on every audio chunk:
            </p>
            <ul className="guide-list">
              <li>
                <strong>Original Audio (Wideband PCM 16-bit):</strong> Downmixes multi-channel
                inputs to mono and encodes to 16-bit signed little-endian PCM at the closest
                supported wideband sample rate (<code>pcm_16000</code> to <code>pcm_48000</code>),
                preserving full frequency response.
              </li>
              <li>
                <strong>Telephone Band PCM (16-bit, 8000 Hz):</strong> Passes audio through a
                cascaded 4th-order Butterworth IIR Bandpass Filter (<strong>300 Hz high-pass</strong>{' '}
                + <strong>3400 Hz low-pass</strong>) to simulate PSTN subscriber-loop bandwidth,
                applies anti-aliasing low-pass filtering, resamples to 8000 Hz, and streams as{' '}
                <code>pcm_8000</code>.
              </li>
              <li>
                <strong>Simulated G.711 μ-law (8-bit, 8000 Hz):</strong> Applies the 300–3400 Hz
                telephone-band filter and 8000 Hz resampling, then executes bit-level{' '}
                <strong>ITU-T Recommendation G.711 μ-law (μ=255)</strong> logarithmic encoding (8-bit)
                and decoding (16-bit reconstruction) to measure actual Signal-to-Quantization-Noise
                Ratio (SQNR ~37 dB) and stream native <code>ulaw_8000</code> frames (or decoded{' '}
                <code>pcm_8000</code> frames) to ElevenLabs.
              </li>
            </ul>
          </section>

          <section className="guide-section">
            <h3>
              <Radio size={17} /> 3. Official ElevenLabs Scribe v2 Realtime Protocol
            </h3>
            <ul className="guide-list">
              <li>
                <strong>Upstream Endpoint:</strong>{' '}
                <code>wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime</code>
              </li>
              <li>
                <strong>Supported Audio Formats:</strong> <code>pcm_8000</code>,{' '}
                <code>pcm_16000</code>, <code>pcm_22050</code>, <code>pcm_24000</code>,{' '}
                <code>pcm_44100</code>, <code>pcm_48000</code>, and <code>ulaw_8000</code>.
              </li>
              <li>
                <strong>Client Audio Frame:</strong>{' '}
                <code>{`{ "message_type": "input_audio_chunk", "audio_base_64": "...", "commit": false, "sample_rate": 8000 }`}</code>
              </li>
              <li>
                <strong>Server Events:</strong> <code>session_started</code>,{' '}
                <code>partial_transcript</code>, <code>committed_transcript</code>,{' '}
                <code>committed_transcript_with_timestamps</code>, and structured error events.
              </li>
            </ul>
          </section>
        </div>

        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>
            Got It
          </button>
        </div>
      </div>
    </div>
  );
};
