import React, { useEffect, useRef } from 'react';
import type { AudioProfileId } from '../../shared/types.js';

interface WaveformMeterProps {
  waveformSamples: Float32Array | null;
  rmsDbFs: number;
  peakDbFs: number;
  isStreaming: boolean;
  sourceType: 'microphone' | 'wav_upload';
  activeProfile: AudioProfileId;
  progressPercent?: number;
}

export const WaveformMeter: React.FC<WaveformMeterProps> = ({
  waveformSamples,
  rmsDbFs,
  peakDbFs,
  isStreaming,
  sourceType,
  activeProfile,
  progressPercent,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || 600;
    const height = rect.height || 110;

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, width, height);

    // Subtle grid lines
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.lineWidth = 1;
    for (let y = 0.25; y <= 0.75; y += 0.25) {
      ctx.beginPath();
      ctx.moveTo(0, height * y);
      ctx.lineTo(width, height * y);
      ctx.stroke();
    }
    for (let x = 0.1; x < 1; x += 0.1) {
      ctx.beginPath();
      ctx.moveTo(width * x, 0);
      ctx.lineTo(width * x, height);
      ctx.stroke();
    }

    // Center zero line
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.25)';
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Waveform trace
    if (waveformSamples && waveformSamples.length > 0) {
      const strokeColor =
        activeProfile === 'ulaw_8000'
          ? '#f59e0b'
          : activeProfile === 'pcm_8000'
            ? '#06b6d4'
            : '#818cf8';

      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2;
      ctx.beginPath();

      const sliceWidth = width / waveformSamples.length;
      let x = 0;

      for (let i = 0; i < waveformSamples.length; i++) {
        const s = Math.max(-1, Math.min(1, waveformSamples[i] ?? 0));
        const y = height / 2 - s * (height * 0.44);
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth;
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = '#64748b';
      ctx.font = '12px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        isStreaming
          ? 'Capturing & filtering audio frames...'
          : 'Idle — Start microphone capture or stream a WAV file to visualize real-time signal',
        width / 2,
        height / 2 + 4
      );
    }

    ctx.restore();
  }, [waveformSamples, isStreaming, activeProfile]);

  // Normalize dBFS [-60, 0] to [0, 100]%
  const rmsPercent = Math.max(0, Math.min(100, ((rmsDbFs + 60) / 60) * 100));
  const peakPercent = Math.max(0, Math.min(100, ((peakDbFs + 60) / 60) * 100));
  const isClipping = peakDbFs >= -0.5;

  return (
    <div className="waveform-card">
      <div className="waveform-header">
        <div className="waveform-status">
          <span className={`recording-dot ${isStreaming ? 'active' : ''}`} />
          <span className="waveform-title">
            {isStreaming
              ? sourceType === 'microphone'
                ? 'LIVE MICROPHONE STREAMING'
                : 'STREAMING WAV AUDIO (1x REAL-TIME)'
              : 'SIGNAL MONITOR & OSCILLOSCOPE'}
          </span>
          <span className={`profile-pill profile-${activeProfile}`}>
            {activeProfile === 'original'
              ? 'Wideband Unfiltered'
              : activeProfile === 'pcm_8000'
                ? '300–3400 Hz Bandpass • 8kHz PCM16'
                : '300–3400 Hz Bandpass • 8kHz G.711 μ-law'}
          </span>
        </div>

        <div className="db-readout">
          <span>
            RMS: <strong>{rmsDbFs <= -90 ? '-∞' : `${rmsDbFs.toFixed(1)}`} dBFS</strong>
          </span>
          <span>
            Peak: <strong>{peakDbFs <= -90 ? '-∞' : `${peakDbFs.toFixed(1)}`} dBFS</strong>
          </span>
          {isClipping && <span className="clip-badge">CLIP</span>}
        </div>
      </div>

      <div className="canvas-wrapper">
        <canvas ref={canvasRef} className="waveform-canvas" />
        {typeof progressPercent === 'number' && isStreaming && sourceType === 'wav_upload' && (
          <div className="wav-progress-overlay" style={{ width: `${progressPercent}%` }} />
        )}
      </div>

      <div className="meter-bar-container">
        <span className="meter-label">LEVEL</span>
        <div className="meter-track">
          <div
            className={`meter-fill ${rmsPercent > 88 ? 'hot' : rmsPercent > 70 ? 'warm' : 'normal'}`}
            style={{ width: `${rmsPercent}%` }}
          />
          <div className="meter-peak-marker" style={{ left: `${peakPercent}%` }} />
        </div>
        <div className="meter-scale">
          <span>-60</span>
          <span>-40</span>
          <span>-20</span>
          <span>-12</span>
          <span>-6</span>
          <span>0 dB</span>
        </div>
      </div>
    </div>
  );
};
