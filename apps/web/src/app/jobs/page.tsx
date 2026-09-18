'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { LoginGate } from '../../components/login-gate';

interface SourceDto {
  id: string;
  key: string;
  name: string;
  kind: string;
  status: string;
  policyNotes: string | null;
}

interface SearchConfigDto {
  id: string;
  name: string;
  sources: string[];
  keywords: string[];
  intervalMinutes: number;
  mode: string;
  isActive: boolean;
  filters: Record<string, unknown>;
}

interface SourceRunDto {
  id: string;
  sourceKey: string;
  status: string;
  jobsDiscovered: number;
  jobsNew: number;
  jobsDuplicated: number;
  jobsRejected: number;
  errors: number;
  durationMs: number | null;
  errorClass: string | null;
}

interface RunDto {
  id: string;
  status: string;
  jobsDiscovered: number;
  jobsNew: number;
  jobsDuplicated: number;
  jobsRejected: number;
  errors: number;
}

interface DedupReviewDto {
  id: string;
  score: string;
  status: string;
  candidate: { title: string; company: string };
  created: { title: string; company: string };
}

interface JobDto {
  id: string;
  title: string;
  company: string;
  location: string | null;
  remoteType: string | null;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  status: string;
  discoveredAt: string;
  metadata?: { filterDecision?: { rejections: Array<{ rule: string; reason: string }> } };
}

interface JobDetailDto {
  job: JobDto & { description: string };
  listings: Array<{ listing: { externalId: string }; sourceKey: string }>;
  applicationTarget: { key: string; kind: string; status: string } | null;
}

async function ensureSearchConfig(): Promise<SearchConfigDto> {
  const configs = await api<{ items: SearchConfigDto[] }>('/v1/search-configs');
  const existing = configs.items.find((config) => config.sources.includes('mock'));
  if (existing) return existing;
  return api<SearchConfigDto>('/v1/search-configs', {
    method: 'POST',
    body: JSON.stringify({ name: 'Búsqueda mock', sources: ['mock'], keywords: [] }),
  });
}

function JobsContent(): ReactNode {
  const [jobs, setJobs] = useState<JobDto[]>([]);
  const [jobStatus, setJobStatus] = useState('active');
  const [run, setRun] = useState<RunDto | null>(null);
  const [sourceRuns, setSourceRuns] = useState<SourceRunDto[]>([]);
  const [sources, setSources] = useState<SourceDto[]>([]);
  const [configs, setConfigs] = useState<SearchConfigDto[]>([]);
  const [reviews, setReviews] = useState<DedupReviewDto[]>([]);
  const [running, setRunning] = useState(false);
  const [detail, setDetail] = useState<JobDetailDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    const query = jobStatus === 'all' ? '' : `&status=${jobStatus}`;
    const response = await api<{ items: JobDto[] }>(`/v1/jobs?limit=100${query}`);
    setJobs(response.items);
  }, [jobStatus]);

  const loadSources = useCallback(async () => {
    const response = await api<{ items: SourceDto[] }>('/v1/sources');
    setSources(response.items);
  }, []);

  const loadConfigs = useCallback(async () => {
    const response = await api<{ items: SearchConfigDto[] }>('/v1/search-configs');
    setConfigs(response.items);
  }, []);

  const loadReviews = useCallback(async () => {
    const response = await api<{ items: DedupReviewDto[] }>('/v1/dedup-reviews?status=pending');
    setReviews(response.items);
  }, []);

  const loadLatestRun = useCallback(async () => {
    const runs = await api<{ items: RunDto[] }>('/v1/search-runs?limit=1');
    const latest = runs.items[0] ?? null;
    setRun(latest);
    if (latest) {
      const detailResponse = await api<RunDto & { sources: SourceRunDto[] }>(`/v1/search-runs/${latest.id}`);
      setSourceRuns(detailResponse.sources);
    } else {
      setSourceRuns([]);
    }
  }, []);

  useEffect(() => {
    void Promise.all([loadJobs(), loadSources(), loadConfigs(), loadReviews(), loadLatestRun()]).catch(
      (cause: unknown) => setError(cause instanceof Error ? cause.message : 'error'),
    );
  }, [loadJobs, loadSources, loadConfigs, loadReviews, loadLatestRun]);

  async function runSearch(): Promise<void> {
    setRunning(true);
    setMessage(null);
    try {
      const config = await ensureSearchConfig();
      await api(`/v1/search-configs/${config.id}/run`, { method: 'POST' });
      const deadline = Date.now() + 30_000;
      let latest: RunDto | null = null;
      while (Date.now() < deadline) {
        const runs = await api<{ items: RunDto[] }>('/v1/search-runs?limit=1');
        latest = runs.items[0] ?? null;
        if (latest && latest.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      setRun(latest);
      if (latest?.status === 'completed' || latest?.status === 'partial') {
        setMessage(`Búsqueda ${latest.status === 'partial' ? 'parcial' : 'completada'}`);
      } else {
        setMessage(`Estado de la búsqueda: ${latest?.status ?? 'desconocido'}`);
      }
      await Promise.all([loadJobs(), loadLatestRun(), loadReviews()]);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'error');
    } finally {
      setRunning(false);
    }
  }

  async function toggleSource(source: SourceDto): Promise<void> {
    const next = source.status === 'active' ? 'paused' : 'active';
    await api(`/v1/sources/${source.key}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
    await loadSources();
  }

  async function toggleConfig(config: SearchConfigDto): Promise<void> {
    await api(`/v1/search-configs/${config.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: !config.isActive }),
    });
    await loadConfigs();
  }

  async function createConfig(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const selected = formData.getAll('sources').map(String);
    if (selected.length === 0) {
      setMessage('Selecciona al menos una fuente');
      return;
    }
    const keywords = String(formData.get('keywords') ?? '')
      .split(',')
      .map((keyword) => keyword.trim())
      .filter(Boolean);
    const excludedCompanies = String(formData.get('excludedCompanies') ?? '')
      .split(',')
      .map((company) => company.trim())
      .filter(Boolean);
    await api('/v1/search-configs', {
      method: 'POST',
      body: JSON.stringify({
        name: String(formData.get('name')),
        sources: selected,
        keywords,
        intervalMinutes: Number(formData.get('intervalMinutes') ?? 1440),
        filters: { excludedCompanies },
      }),
    });
    form.reset();
    await loadConfigs();
  }

  async function decideReview(reviewId: string, decision: 'merged' | 'kept-separate'): Promise<void> {
    await api(`/v1/dedup-reviews/${reviewId}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
    await Promise.all([loadReviews(), loadJobs()]);
  }

  async function openDetail(jobId: string): Promise<void> {
    setDetail(await api<JobDetailDto>(`/v1/jobs/${jobId}`));
  }

  return (
    <section>
      <h1>Ofertas</h1>

      <div className="card">
        <h2>Búsquedas programadas</h2>
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Fuentes</th>
              <th>Intervalo</th>
              <th>Modo</th>
              <th>Activa</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {configs.map((config) => (
              <tr key={config.id}>
                <td>{config.name}</td>
                <td>{config.sources.join(', ')}</td>
                <td>{config.intervalMinutes} min</td>
                <td>{config.mode}</td>
                <td>{config.isActive ? 'sí' : 'no'}</td>
                <td>
                  <button type="button" className="secondary" onClick={() => void toggleConfig(config)}>
                    {config.isActive ? 'Pausar' : 'Activar'}
                  </button>
                </td>
              </tr>
            ))}
            {configs.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  Sin búsquedas configuradas
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <form onSubmit={(event) => void createConfig(event)}>
          <div className="grid">
            <label>
              Nombre
              <input name="name" required />
            </label>
            <label>
              Keywords (separadas por coma)
              <input name="keywords" placeholder="react, typescript" />
            </label>
            <label>
              Intervalo (min)
              <input name="intervalMinutes" type="number" min={5} defaultValue={1440} />
            </label>
            <label>
              Empresas excluidas (coma)
              <input name="excludedCompanies" placeholder="Acme Corp" />
            </label>
          </div>
          <div className="row">
            {sources.map((source) => (
              <label key={source.key} style={{ marginRight: 12 }}>
                <input
                  type="checkbox"
                  name="sources"
                  value={source.key}
                  defaultChecked={source.key === 'mock'}
                  style={{ width: 'auto', display: 'inline-block', marginRight: 6 }}
                />
                {source.key}
              </label>
            ))}
          </div>
          <button type="submit">Crear búsqueda</button>
        </form>
      </div>

      <div className="card">
        <h2>Fuentes</h2>
        <table>
          <thead>
            <tr>
              <th>Fuente</th>
              <th>Tipo</th>
              <th>Estado</th>
              <th>Revisión ToS</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.key}>
                <td>{source.key}</td>
                <td>{source.kind}</td>
                <td>
                  <span className="badge">{source.status}</span>
                </td>
                <td className="muted">{source.policyNotes ?? '—'}</td>
                <td>
                  <button type="button" className="secondary" onClick={() => void toggleSource(source)}>
                    {source.status === 'active' ? 'Pausar' : 'Activar'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="row">
          <button type="button" disabled={running} onClick={() => void runSearch()}>
            {running ? 'Buscando…' : 'Ejecutar búsqueda mock'}
          </button>
        </div>
        {message ? <p className="success">{message}</p> : null}
        {run ? (
          <>
            <p className="muted">
              Última ejecución: <span className="badge">{run.status}</span> descubiertas {run.jobsDiscovered} · nuevas{' '}
              {run.jobsNew} · duplicadas {run.jobsDuplicated} · rechazadas {run.jobsRejected} · errores {run.errors}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Fuente</th>
                  <th>Estado</th>
                  <th>Descubiertas</th>
                  <th>Nuevas</th>
                  <th>Duplicadas</th>
                  <th>Rechazadas</th>
                  <th>Errores</th>
                  <th>Duración</th>
                </tr>
              </thead>
              <tbody>
                {sourceRuns.map((sourceRun) => (
                  <tr key={sourceRun.id}>
                    <td>{sourceRun.sourceKey}</td>
                    <td>
                      <span className="badge">{sourceRun.status}</span>
                      {sourceRun.errorClass ? <span className="error"> {sourceRun.errorClass}</span> : null}
                    </td>
                    <td>{sourceRun.jobsDiscovered}</td>
                    <td>{sourceRun.jobsNew}</td>
                    <td>{sourceRun.jobsDuplicated}</td>
                    <td>{sourceRun.jobsRejected}</td>
                    <td>{sourceRun.errors}</td>
                    <td>{sourceRun.durationMs ?? 0} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </div>

      <div className="card">
        <h2>Revisión de duplicados (zona gris)</h2>
        {reviews.length === 0 ? (
          <p className="muted">Sin revisiones pendientes</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Oferta A</th>
                <th>Oferta B</th>
                <th>Similitud</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {reviews.map((review) => (
                <tr key={review.id}>
                  <td>
                    {review.candidate.title} · {review.candidate.company}
                  </td>
                  <td>
                    {review.created.title} · {review.created.company}
                  </td>
                  <td>{Number(review.score).toFixed(3)}</td>
                  <td>
                    <div className="row">
                      <button type="button" onClick={() => void decideReview(review.id, 'merged')}>
                        Fusionar
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void decideReview(review.id, 'kept-separate')}
                      >
                        Mantener separados
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Jobs canónicos ({jobs.length})</h2>
        <div className="row">
          <label>
            Estado
            <select value={jobStatus} onChange={(event) => setJobStatus(event.target.value)}>
              <option value="active">active</option>
              <option value="rejected">rejected</option>
              <option value="archived">archived</option>
              <option value="all">todas</option>
            </select>
          </label>
        </div>
        <table>
          <thead>
            <tr>
              <th>Título</th>
              <th>Empresa</th>
              <th>Ubicación</th>
              <th>Modalidad</th>
              <th>Salario</th>
              <th>Estado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.title}</td>
                <td>{job.company}</td>
                <td>{job.location ?? '—'}</td>
                <td>{job.remoteType ?? '—'}</td>
                <td>
                  {job.salaryMin && job.salaryMax
                    ? `${job.salaryMin}–${job.salaryMax} ${job.currency ?? ''}`
                    : '—'}
                </td>
                <td>
                  <span className="badge">{job.status}</span>
                </td>
                <td>
                  <button type="button" className="secondary" onClick={() => void openDetail(job.id)}>
                    Ver
                  </button>
                </td>
              </tr>
            ))}
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  Sin ofertas para este estado.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {detail ? (
        <div className="card">
          <h2>
            {detail.job.title} <span className="badge">{detail.job.company}</span>
          </h2>
          <p className="muted">
            {detail.listings.length} listing(s) ·{' '}
            {detail.applicationTarget
              ? `destino: ${detail.applicationTarget.key} (${detail.applicationTarget.kind}, ${detail.applicationTarget.status})`
              : 'destino de aplicación sin resolver'}
          </p>
          {detail.job.metadata?.filterDecision ? (
            <div className="error">
              <strong>Rechazada por filtros:</strong>
              <ul>
                {detail.job.metadata.filterDecision.rejections.map((rejection) => (
                  <li key={rejection.rule}>
                    {rejection.rule}: {rejection.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p>{detail.job.description}</p>
          <ul>
            {detail.listings.map((entry) => (
              <li key={`${entry.sourceKey}-${entry.listing.externalId}`}>
                {entry.sourceKey}: {entry.listing.externalId}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

export default function JobsPage(): ReactNode {
  return (
    <LoginGate>
      <JobsContent />
    </LoginGate>
  );
}