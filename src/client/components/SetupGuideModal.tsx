import React from 'react';
import { X, Terminal, ShieldCheck, Cpu, Radio } from 'lucide-react';

interface SetupGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
  apiKeyConfigured: boolean;
  maskedApiKey: string | null;
  gladiaApiKeyConfigured?: boolean;
  maskedGladiaApiKey?: string | null;
  upstreamEndpoint: string;
}

export const SetupGuideModal: React.FC<SetupGuideModalProps> = ({
  isOpen,
  onClose,
  apiKeyConfigured,
  maskedApiKey,
  gladiaApiKeyConfigured = false,
  maskedGladiaApiKey = null,
  upstreamEndpoint,
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-group">
            <Terminal size={20} className="icon-accent" />
            <h2>Telephony STT Lab — Guía ElevenLabs vs Gladia</h2>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close setup guide">
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          <section className="guide-section">
            <h3>
              <ShieldCheck size={17} /> 1. Configuración de API Keys (ElevenLabs & Gladia)
            </h3>
            <p>
              El mismo flujo de audio procesado del micrófono se envía simultáneamente a{' '}
              <strong>ElevenLabs Scribe v2 Realtime</strong> (mediante el proxy WebSocket{' '}
              <code>{upstreamEndpoint}</code>) y a <strong>Gladia Live v2 (Solaria-1)</strong>{' '}
              (mediante sesión efímera inicializada en <code>/api/gladia/session</code>).
            </p>
            <div className="status-callout" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <div>
                <span>ElevenLabs Key (.env): </span>
                {apiKeyConfigured ? (
                  <strong className="text-success">
                    Configurada ({maskedApiKey})
                  </strong>
                ) : (
                  <strong className="text-danger">
                    No configurada — Añade ELEVENLABS_API_KEY en .env
                  </strong>
                )}
              </div>
              <div>
                <span>Gladia Key (.env): </span>
                {gladiaApiKeyConfigured ? (
                  <strong className="text-success">
                    Configurada ({maskedGladiaApiKey})
                  </strong>
                ) : (
                  <strong className="text-warning">
                    No configurada — Añade GLADIA_API_KEY en .env
                  </strong>
                )}
              </div>
            </div>
            <pre className="code-snippet">
{`# 1. Copia el archivo de entorno de ejemplo
cp .env.example .env

# 2. Añade tus claves de ElevenLabs y Gladia en .env
ELEVENLABS_API_KEY=tu_api_key_elevenlabs
GLADIA_API_KEY=tu_api_key_gladia
PORT=3001

# 3. Inicia el servidor proxy y el frontend
npm run dev`}
            </pre>
          </section>

          <section className="guide-section">
            <h3>
              <Cpu size={17} /> 2. Pipeline DSP Telefónico Compartido (Mismo Audio Exacto)
            </h3>
            <p>
              Cada bloque capturado del micrófono pasa una única vez por el motor DSP y se transmite en paralelo a ambos proveedores:
            </p>
            <ul className="guide-list">
              <li>
                <strong>Original (Wideband PCM 16-bit):</strong> Audio mono sin filtrar en 16-bit PCM (<code>pcm_16000</code>–<code>pcm_48000</code> en ElevenLabs y <code>wav/pcm 16-bit</code> en Gladia).
              </li>
              <li>
                <strong>PCM 16-bit 8kHz:</strong> Filtro paso banda telefónico Butterworth IIR de 4.º orden (<strong>300–3400 Hz</strong>), filtro anti-aliasing y diezmado a 8000 Hz en 16-bit PCM (<code>pcm_8000</code> en ElevenLabs y <code>wav/pcm 8000Hz 16-bit</code> en Gladia).
              </li>
              <li>
                <strong>G.711 μ-law 8kHz:</strong> Filtrado telefónico 300–3400 Hz, remuestreo a 8000 Hz y compresión logarítmica <strong>ITU-T G.711 μ-law (8-bit)</strong> enviada nativamente como <code>ulaw_8000</code> a ElevenLabs y <code>wav/ulaw 8000Hz 8-bit</code> a Gladia.
              </li>
            </ul>
          </section>

          <section className="guide-section">
            <h3>
              <Radio size={17} /> 3. Comparativa de Precisión (WER) y Latencia
            </h3>
            <ul className="guide-list">
              <li>
                <strong>Transcripción Simultánea:</strong> Observa en tiempo real cómo transcriben ElevenLabs Scribe v2 y Gladia Solaria-1 exactamente la misma señal acústica.
              </li>
              <li>
                <strong>Texto Real (Ground Truth):</strong> Corrige cualquier palabra sobre el texto de referencia para obtener al instante el <strong>WER %</strong> comparativo de ambos modelos y determinar el ganador en cada perfil telefónico.
              </li>
            </ul>
          </section>
        </div>

        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
};

