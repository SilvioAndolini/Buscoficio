'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/api';
import { LoginGate } from '../../components/login-gate';

interface SignalBreakdownDto {
  present: boolean;
  score: number | null;
  weight: number;
  weightedContribution: number;
  reason?: string;
  details?: string[];
}

interface MatchDto {
  match: {
    id: string;
    overallScore: string;
    reasons: string[];
    missingRequirements: string[];
    matchingSkills: string[];
    recommendedResumeId: string | null;
    engineVersion: string;
    weightsVersion: string;
    embeddingSpaceId: string | null;
    semanticModel: string | null;
    matchingAsOfDate: string | null;
    computedAt: string;
    scoreBreakdown: {
      signals: Record<string, SignalBreakdownDto>;
      rawScore: number;
      finalScore: number;
      capApplied: boolean;
      hardRequirementCap: number;
      resumeSelection?: { recommendedResumeVersionId: string | null; reasons: string[] };
    };
  };
  job: {
    id: string;
    title: string;
    company: string;
    location: string | null;
    remoteType: string | null;
    employmentType: string | null;
  };
  recommendedResume: { id: string; name: string; category: string } | null;
}

const SIGNAL_LABELS: Array<{ key: string; label: string }> = [
  { key: 'skillsMatch', label: 'Skills' },
  { key: 'experienceMatch', label: 'Experience' },
  { key: 'locationMatch', label: 'Location' },
  { key: 'salaryMatch', label: 'Salary' },
  { key: 'languageMatch', label: 'Languages' },
  { key: 'employmentTypeMatch', label: 'Employment type' },
  { key: 'semanticSimilarity', label: 'Semantic' },
  { key: 'careerRelevance', label: 'Career relevance' },
];

function MatchesContent(): ReactNode {
  const router = useRouter();
  const [items, setItems] = useState<MatchDto[]>([]);
  const [total, setTotal] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prepareMode, setPrepareMode] = useState<'manual' | 'assisted'>('assisted');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await api<{ items: MatchDto[]; total: number }>('/v1/matches?limit=100');
    setItems(response.items);
    setTotal(response.total);
  }, []);

  useEffect(() => {
    void load().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'error'),
    );
  }, [load]);

  async function prepare(matchId: string): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await api<{ application: { id: string }; created: boolean }>(
        '/v1/applications',
        {
          method: 'POST',
          body: JSON.stringify({ matchId, mode: prepareMode }),
        },
      );
      router.push(`/applications/${response.application.id}`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'error');
    } finally {
      setBusy(false);
    }
  }

  async function recompute(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const jobs = await api<{ items: Array<{ id: string }> }>('/v1/jobs?limit=100&status=active');
      await api('/v1/matches/recompute', {
        method: 'POST',
        body: JSON.stringify({ limit: Math.max(1, Math.min(200, jobs.items.length)) }),
      });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const response = await api<{ items: MatchDto[]; total: number }>('/v1/matches?limit=100');
        setItems(response.items);
        setTotal(response.total);
        if (response.items.length >= jobs.items.length) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
      }
      setMessage('Matching recomputado');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>Ranking de ofertas</h1>
      <div className="card">
        <div className="row">
          <button type="button" disabled={busy} onClick={() => void recompute()}>
            {busy ? 'Calculando…' : 'Recomputar pendientes'}
          </button>
          <span className="muted">
            {total} match(s) vigente(s) · motor determinista y versionado
          </span>
        </div>
        {message ? <p className="success">{message}</p> : null}
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Score</th>
              <th>Título</th>
              <th>Empresa</th>
              <th>Modalidad</th>
              <th>CV recomendado</th>
              <th>Requisitos</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={item.match.id}>
                <td>{index + 1}</td>
                <td>
                  <strong>{(Number(item.match.overallScore) * 100).toFixed(1)}%</strong>
                  {item.match.scoreBreakdown.capApplied ? (
                    <span className="error"> (cap)</span>
                  ) : null}
                </td>
                <td>{item.job.title}</td>
                <td>{item.job.company}</td>
                <td>{item.job.remoteType ?? '—'}</td>
                <td>{item.recommendedResume ? item.recommendedResume.name : '—'}</td>
                <td>
                  {item.match.missingRequirements.length > 0 ? (
                    <span className="error">{item.match.missingRequirements[0]}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setExpanded(expanded === item.match.id ? null : item.match.id)}
                  >
                    {expanded === item.match.id ? 'Ocultar' : 'Detalle'}
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted">
                  Sin matches. Ejecuta una búsqueda y pulsa «Recomputar pendientes».
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {items
        .filter((item) => item.match.id === expanded)
        .map((item) => (
          <div className="card" key={item.match.id}>
            <h2>
              {item.job.title} <span className="badge">{item.job.company}</span>
            </h2>
            {item.match.missingRequirements.length > 0 ? (
              <div className="error">
                <strong>Requisitos no cumplidos:</strong>
                <ul>
                  {item.match.missingRequirements.map((requirement) => (
                    <li key={requirement}>{requirement}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <h3>Desglose del score</h3>
            <table>
              <thead>
                <tr>
                  <th>Señal</th>
                  <th>Score</th>
                  <th>Peso</th>
                  <th>Contribución</th>
                  <th>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {SIGNAL_LABELS.map(({ key, label }) => {
                  const signal = item.match.scoreBreakdown.signals[key];
                  if (!signal) return null;
                  return (
                    <tr key={key}>
                      <td>{label}</td>
                      <td>{signal.present ? signal.score!.toFixed(2) : 'N/A'}</td>
                      <td>{signal.weight.toFixed(2)}</td>
                      <td>{signal.present ? signal.weightedContribution.toFixed(3) : '—'}</td>
                      <td className="muted">
                        {signal.present ? (signal.details ?? []).join('; ') : signal.reason}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted">
              Score bruto {item.match.scoreBreakdown.rawScore.toFixed(4)} · final{' '}
              {item.match.scoreBreakdown.finalScore.toFixed(4)}
              {item.match.scoreBreakdown.capApplied
                ? ` · tope ${item.match.scoreBreakdown.hardRequirementCap.toFixed(2)} por requisito duro`
                : ''}
              {` · ${item.match.engineVersion}/${item.match.weightsVersion}`}
              {item.match.semanticModel ? ` · ${item.match.semanticModel}` : ' · sin embeddings'}
              {item.match.matchingAsOfDate
                ? ` · evaluado al ${item.match.matchingAsOfDate.slice(0, 10)}`
                : ' · evaluación sin dependencia temporal'}
            </p>

            <h3>Razones</h3>
            <ul>
              {item.match.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            {item.match.scoreBreakdown.resumeSelection ? (
              <>
                <h3>Selección de CV</h3>
                <ul>
                  {item.match.scoreBreakdown.resumeSelection.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </>
            ) : null}

            <h3>Preparar candidatura</h3>
            <div className="row">
              <label>
                Modo
                <select
                  value={prepareMode}
                  onChange={(event) =>
                    setPrepareMode(event.target.value === 'manual' ? 'manual' : 'assisted')
                  }
                >
                  <option value="assisted">Assisted (revisión humana)</option>
                  <option value="manual">Manual</option>
                </select>
              </label>
              <button type="button" disabled={busy} onClick={() => void prepare(item.match.id)}>
                Preparar candidatura
              </button>
            </div>
            <p className="muted">
              Fase 4: documentos y claims verificados. El formulario real se inspecciona en Fase 5
              (AUTO no disponible).
            </p>
          </div>
        ))}

      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

export default function MatchesPage(): ReactNode {
  return (
    <LoginGate>
      <MatchesContent />
    </LoginGate>
  );
}