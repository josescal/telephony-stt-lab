import React, { useMemo } from 'react';
import {
  AUDIO_PROFILES,
  type AudioProfileId,
  type BenchmarkTestResult,
} from '../../shared/types.js';
import { Layers } from 'lucide-react';

interface ComparisonViewProps {
  results: BenchmarkTestResult[];
  onSelectRunToInspect?: (run: BenchmarkTestResult) => void;
}

const PROFILE_ORDER: AudioProfileId[] = ['original', 'pcm_8000', 'ulaw_8000'];

interface ProfileAggregate {
  profileId: AudioProfileId;
  runs: BenchmarkTestResult[];
  latestRun: BenchmarkTestResult;
  avgWerPercent: number | null;
  bestWerPercent: number | null;
  avgFirstPartialMs: number | null;
  avgFirstCommittedMs: number | null;
  avgHandshakeMs: number | null;
}

function average(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export const ComparisonView: React.FC<ComparisonViewProps> = ({ results }) => {
  const profileAggregates = useMemo(() => {
    const map = new Map<AudioProfileId, ProfileAggregate>();

    for (const profileId of PROFILE_ORDER) {
      const pRuns = results.filter((r) => r.profileId === profileId);
      if (pRuns.length === 0) continue;

      const latestRun = pRuns[0]!;
      const wers = pRuns
        .map((r) => (r.accuracy ? r.accuracy.wer * 100 : null))
        .filter((v): v is number => v !== null);
      const ttfps = pRuns
        .map((r) => r.latency.timeToFirstPartialMs)
        .filter((v): v is number => v !== null);
      const ttfcs = pRuns
        .map((r) => r.latency.timeToFirstCommittedMs)
        .filter((v): v is number => v !== null);
      const handshakes = pRuns
        .map((r) => r.latency.handshakeLatencyMs)
        .filter((v): v is number => v !== null);

      map.set(profileId, {
        profileId,
        runs: pRuns,
        latestRun,
        avgWerPercent: average(wers),
        bestWerPercent: wers.length > 0 ? Math.min(...wers) : null,
        avgFirstPartialMs: average(ttfps),
        avgFirstCommittedMs: average(ttfcs),
        avgHandshakeMs: average(handshakes),
      });
    }

    return map;
  }, [results]);

  if (results.length === 0) {
    return (
      <div className="empty-comparison-card">
        <Layers size={36} className="icon-muted" />
        <h3>Sin pruebas guardadas todavía</h3>
        <p>
          Graba y guarda pruebas con los distintos perfiles telefónicos (
          <code>Original</code>, <code>PCM 16-bit 8000 Hz</code> y{' '}
          <code>G.711 μ-law 8000 Hz</code>) para comparar sus resultados lado a lado.
        </p>
      </div>
    );
  }

  const referenceExample =
    results.find((r) => r.referenceTranscript.trim().length > 0)?.referenceTranscript ??
    '';

  return (
    <div className="comparison-container">
      <div className="comparison-toolbar">
        <div className="comparison-summary-badges">
          <span className="badge-neutral">
            Total Pruebas: <strong>{results.length}</strong>
          </span>
          <span className="badge-neutral">
            Perfiles Probados: <strong>{profileAggregates.size} / 3</strong>
          </span>
        </div>
      </div>

      {referenceExample && (
        <div className="comparison-ref-banner">
          <span className="ref-label">Texto de Referencia:</span>
          <span className="ref-text">"{referenceExample}"</span>
        </div>
      )}

      {/* Side-by-side 3-column Profile Comparison Cards */}
      <div className="comparison-grid">
        {PROFILE_ORDER.map((profileId) => {
          const spec = AUDIO_PROFILES[profileId];
          const agg = profileAggregates.get(profileId);

          if (!agg) {
            return (
              <div key={profileId} className={`comparison-profile-card untested profile-border-${profileId}`}>
                <div className="comp-card-header">
                  <span className={`profile-pill profile-${profileId}`}>{spec.shortLabel}</span>
                  <span className="comp-run-count">Sin pruebas</span>
                </div>
                <p className="comp-untested-note">
                  Selecciona <strong>{spec.shortLabel}</strong> arriba y guarda una prueba para comparar este perfil.
                </p>
              </div>
            );
          }

          const latest = agg.latestRun;
          const werVal = agg.avgWerPercent;

          return (
            <div key={profileId} className={`comparison-profile-card profile-border-${profileId}`}>
              <div className="comp-card-header">
                <span className={`profile-pill profile-${profileId}`}>{spec.shortLabel}</span>
                <span className="comp-run-count">
                  {agg.runs.length} prueba{agg.runs.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="comp-tech-meta">
                <span>Format: <code>{latest.elevenLabsFormat}</code></span>
                <span>Rate: <code>{latest.inputSampleRate}→{latest.outputSampleRate} Hz</code></span>
                {latest.signalMetrics.quantizationSnrDb !== null && (
                  <span>SQNR: <code>{latest.signalMetrics.quantizationSnrDb} dB</code></span>
                )}
              </div>

              <div className="comp-metrics-bars">
                <div className="comp-metric-row">
                  <div className="comp-metric-label">
                    <span>Avg WER (Word Error Rate)</span>
                    <strong>
                      {werVal !== null ? `${werVal.toFixed(1)}%` : 'Sin Ref'}
                    </strong>
                  </div>
                  <div className="comp-bar-track">
                    <div
                      className={`comp-bar-fill ${
                        werVal === null
                          ? ''
                          : werVal <= 10
                            ? 'bar-good'
                            : werVal <= 25
                              ? 'bar-warn'
                              : 'bar-bad'
                      }`}
                      style={{ width: `${werVal !== null ? Math.min(100, werVal) : 0}%` }}
                    />
                  </div>
                </div>
              </div>

              <div className="comp-latency-grid">
                <div className="comp-stat-box">
                  <span className="stat-label">First Partial</span>
                  <span className="stat-val">
                    {agg.avgFirstPartialMs !== null
                      ? `${Math.round(agg.avgFirstPartialMs)} ms`
                      : '—'}
                  </span>
                </div>
                <div className="comp-stat-box">
                  <span className="stat-label">First Committed</span>
                  <span className="stat-val">
                    {agg.avgFirstCommittedMs !== null
                      ? `${Math.round(agg.avgFirstCommittedMs)} ms`
                      : '—'}
                  </span>
                </div>
                <div className="comp-stat-box">
                  <span className="stat-label">WS Handshake</span>
                  <span className="stat-val">
                    {agg.avgHandshakeMs !== null
                      ? `${Math.round(agg.avgHandshakeMs)} ms`
                      : '—'}
                  </span>
                </div>
                <div className="comp-stat-box">
                  <span className="stat-label">Best WER</span>
                  <span className="stat-val">
                    {agg.bestWerPercent !== null ? `${agg.bestWerPercent.toFixed(1)}%` : '—'}
                  </span>
                </div>
              </div>

              <div className="comp-transcript-box">
                <div className="comp-transcript-label">Última Transcripción:</div>
                <p className="comp-transcript-text">
                  {latest.finalTranscript || <em>(Vacío)</em>}
                </p>
              </div>

              {latest.accuracy && latest.accuracy.wordAlignment.length > 0 && (
                <div className="comp-alignment-preview">
                  <div className="comp-transcript-label">
                    Alineación de Palabras (S:{latest.accuracy.substitutions} D:{latest.accuracy.deletions} I:{latest.accuracy.insertions}):
                  </div>
                  <div className="alignment-tokens compact">
                    {latest.accuracy.wordAlignment.map((tok, idx) => (
                      <span key={idx} className={`diff-token diff-${tok.op}`}>
                        {tok.op === 'hit' && tok.hypothesis}
                        {tok.op === 'substitution' && (
                          <>
                            <del>{tok.reference}</del> → {tok.hypothesis}
                          </>
                        )}
                        {tok.op === 'deletion' && <del>{tok.reference}</del>}
                        {tok.op === 'insertion' && <>+{tok.hypothesis}</>}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Detailed Runs Comparison Table */}
      <div className="comparison-table-wrapper">
        <h4>Todas las Pruebas Guardadas</h4>
        <table className="benchmark-table">
          <thead>
            <tr>
              <th>Hora</th>
              <th>Telephony Profile</th>
              <th>Format / Rate</th>
              <th>Resultado</th>
              <th>WER</th>
              <th>TTFP (ms)</th>
              <th>TTFC (ms)</th>
              <th>Texto Transcrito</th>
            </tr>
          </thead>
          <tbody>
            {results.map((run) => (
              <tr key={run.id}>
                <td>{new Date(run.createdAt).toLocaleTimeString()}</td>
                <td>
                  <span className={`profile-pill profile-${run.profileId}`}>
                    {AUDIO_PROFILES[run.profileId].shortLabel}
                  </span>
                </td>
                <td>
                  <code>{run.elevenLabsFormat}</code> ({run.inputSampleRate}→{run.outputSampleRate} Hz)
                </td>
                <td>
                  {run.evaluationLabel === 'correct' ? (
                    <span className="eval-badge eval-correct">✓ Correcto</span>
                  ) : run.evaluationLabel === 'incorrect' ? (
                    <span className="eval-badge eval-incorrect">✗ Incorrecto</span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td>
                  {run.accuracy ? (
                    <strong
                      className={
                        run.accuracy.wer <= 0.1
                          ? 'text-success'
                          : run.accuracy.wer <= 0.25
                            ? 'text-warning'
                            : 'text-danger'
                      }
                    >
                      {(run.accuracy.wer * 100).toFixed(1)}%
                    </strong>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{run.latency.timeToFirstPartialMs ?? '—'}</td>
                <td>{run.latency.timeToFirstCommittedMs ?? '—'}</td>
                <td className="td-transcript">{run.finalTranscript || <em>(vacío)</em>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
