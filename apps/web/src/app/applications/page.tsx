'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import { LoginGate } from '../../components/login-gate';

interface ApplicationListItemDto {
  application: {
    id: string;
    status: string;
    mode: string;
    scoreAtCreation: number;
    requiresHumanReason: string | null;
    updatedAt: string;
  };
  job: { id: string; title: string; company: string; status: string };
  resumeName: string | null;
  target: { key: string; label: string; platform: string; status: string } | null;
}

const STATUS_LABELS: Record<string, string> = {
  DISCOVERED: 'Descubierta',
  FILTERED: 'Filtrada',
  SHORTLISTED: 'Preseleccionada',
  PREPARING: 'Preparando',
  READY_FOR_REVIEW: 'Lista para revisión (F5)',
  APPROVED: 'Aprobada',
  SUBMITTING: 'Enviando',
  SUBMITTED: 'Enviada',
  REJECTED: 'Rechazada',
  INTERVIEW: 'Entrevista',
  OFFER: 'Oferta',
  FAILED: 'Fallida',
  REQUIRES_HUMAN_ACTION: 'Requiere acción humana',
  ARCHIVED: 'Archivada',
};

function ApplicationsContent(): ReactNode {
  const [items, setItems] = useState<ApplicationListItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await api<{ items: ApplicationListItemDto[]; total: number }>(
      '/v1/applications?limit=100',
    );
    setItems(response.items);
    setTotal(response.total);
  }, []);

  useEffect(() => {
    void load().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'error'),
    );
  }, [load]);

  return (
    <section>
      <h1>Candidaturas</h1>
      <div className="card">
        <p className="muted">
          {total} candidatura(s) · Fase 4 prepara documentos y claims; el formulario real se
          inspecciona en Fase 5.
        </p>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Título</th>
              <th>Empresa</th>
              <th>Estado</th>
              <th>Modo</th>
              <th>Score al crear</th>
              <th>CV</th>
              <th>Target</th>
              <th>Actualizada</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.application.id}>
                <td>{item.job.title}</td>
                <td>{item.job.company}</td>
                <td>
                  {STATUS_LABELS[item.application.status] ?? item.application.status}
                  {item.application.requiresHumanReason ? (
                    <span className="error"> · incidencia</span>
                  ) : null}
                </td>
                <td>{item.application.mode}</td>
                <td>{(item.application.scoreAtCreation * 100).toFixed(1)}%</td>
                <td>{item.resumeName ?? '—'}</td>
                <td>
                  {item.target ? (
                    <>
                      {item.target.label}
                      {item.target.status === 'blocked' ? (
                        <span className="error"> (bloqueado)</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="muted">sin resolver</span>
                  )}
                </td>
                <td>{new Date(item.application.updatedAt).toLocaleString()}</td>
                <td>
                  <Link href={`/applications/${item.application.id}`}>Detalle</Link>
                </td>
              </tr>
            ))}
            {items.length === 0 ? (
              <tr>
                <td colSpan={9} className="muted">
                  Sin candidaturas. Ve a Matching y pulsa «Preparar candidatura».
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

export default function ApplicationsPage(): ReactNode {
  return (
    <LoginGate>
      <ApplicationsContent />
    </LoginGate>
  );
}
