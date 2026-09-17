'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { LoginGate } from '../../components/login-gate';

interface SearchConfigDto {
  id: string;
  name: string;
  sources: string[];
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
}

interface JobDetailDto {
  job: JobDto & { description: string };
  listings: Array<{ listing: { externalId: string }; sourceKey: string }>;
  applicationTarget: { key: string; kind: string } | null;
}

interface JobsResponse {
  items: JobDto[];
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
  const [run, setRun] = useState<RunDto | null>(null);
  const [running, setRunning] = useState(false);
  const [detail, setDetail] = useState<JobDetailDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    const response = await api<JobsResponse>('/v1/jobs?limit=100');
    setJobs(response.items);
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

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
      if (latest?.status === 'completed') {
        setMessage('Búsqueda completada');
      } else {
        setMessage(`Estado de la búsqueda: ${latest?.status ?? 'desconocido'}`);
      }
      await loadJobs();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'error');
    } finally {
      setRunning(false);
    }
  }

  async function openDetail(jobId: string): Promise<void> {
    setDetail(await api<JobDetailDto>(`/v1/jobs/${jobId}`));
  }

  return (
    <section>
      <h1>Ofertas</h1>
      <div className="card">
        <div className="row">
          <button type="button" disabled={running} onClick={() => void runSearch()}>
            {running ? 'Buscando…' : 'Ejecutar búsqueda mock'}
          </button>
        </div>
        {message ? <p className="success">{message}</p> : null}
        {run ? (
          <p className="muted">
            Última ejecución: <span className="badge">{run.status}</span> descubiertas {run.jobsDiscovered} · nuevas{' '}
            {run.jobsNew} · duplicadas {run.jobsDuplicated} · rechazadas {run.jobsRejected}
          </p>
        ) : null}
      </div>

      <div className="card">
        <h2>Jobs canónicos ({jobs.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Título</th>
              <th>Empresa</th>
              <th>Ubicación</th>
              <th>Modalidad</th>
              <th>Salario</th>
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
                  <button type="button" className="secondary" onClick={() => void openDetail(job.id)}>
                    Ver
                  </button>
                </td>
              </tr>
            ))}
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  Sin ofertas todavía. Ejecuta la búsqueda mock.
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
              ? `destino: ${detail.applicationTarget.key} (${detail.applicationTarget.kind})`
              : 'destino de aplicación sin resolver'}
          </p>
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