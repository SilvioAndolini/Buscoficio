'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { api } from '../../../lib/api';
import { LoginGate } from '../../../components/login-gate';

interface SourceRefDto {
  entityType: string;
  entityId: string;
  field?: string;
}

interface ClaimDto {
  claim: string;
  kind: string;
  value?: unknown;
  sourceRefs: SourceRefDto[];
  verified: 'verified' | 'unverifiable' | 'rejected';
}

interface VerificationDto {
  status: 'verified' | 'unverifiable' | 'rejected';
  failures: Array<{ claim: string; kind: string; reason: string }>;
}

interface DocumentDto {
  id: string;
  kind: string;
  resumeVersionId: string | null;
  storageKey: string;
  contentHash: string;
  claims: ClaimDto[];
  verification: VerificationDto;
  generatedBy: { provider: string; model: string; promptVersion: string; inputHash: string };
  createdAt: string;
}

interface AnswerDto {
  id: string;
  questionText: string;
  answerText: string | null;
  answerKind: string;
  claims: ClaimDto[];
  verification: VerificationDto;
  requiresHumanInput: boolean;
  approved: boolean;
  updatedAt: string;
}

interface EventDto {
  id: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

interface BlockerDto {
  code: string;
  message: string;
  refId?: string;
}

interface DetailDto {
  application: {
    id: string;
    status: string;
    mode: string;
    scoreAtCreation: number;
    policyVersion: string;
    preparationSnapshot: unknown | null;
    requiresHumanReason: string | null;
    createdAt: string;
    updatedAt: string;
    lastTransitionAt: string;
  };
  job: { id: string; title: string; company: string; status: string } | null;
  resumeName: string | null;
  match: {
    id: string;
    overallScore: number;
    identityHash: string;
    engineVersion: string;
    weightsVersion: string;
    computedAt: string;
  } | null;
  resumeVersion: {
    id: string;
    versionNumber: number;
    kind: string;
    fileHash: string;
    storageKey: string;
  } | null;
  documents: DocumentDto[];
  answers: AnswerDto[];
  events: EventDto[];
  target: { key: string; label: string; platform: string; status: string } | null;
  blockers: BlockerDto[];
}

const STATUS_LABELS: Record<string, string> = {
  DISCOVERED: 'Descubierta',
  FILTERED: 'Filtrada',
  SHORTLISTED: 'Preseleccionada',
  PREPARING: 'Preparando',
  READY_FOR_REVIEW: 'Lista para revisión (Fase 5)',
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

const DOCUMENT_LABELS: Record<string, string> = {
  resume_variant: 'Variante de CV',
  cover_letter: 'Cover letter',
  other: 'Documento',
};

function ClaimTable({
  claims,
  verification,
}: {
  claims: ClaimDto[];
  verification: VerificationDto;
}): ReactNode {
  if (claims.length === 0) {
    return <p className="muted">Sin claims factuales en este documento.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Claim</th>
          <th>Tipo</th>
          <th>Verificación</th>
          <th>Procedencia (sourceRefs)</th>
        </tr>
      </thead>
      <tbody>
        {claims.map((claim, index) => {
          const failure = verification.failures.find((entry) => entry.claim === claim.claim);
          return (
            <tr key={`${claim.claim}-${index}`}>
              <td>{claim.claim}</td>
              <td>{claim.kind}</td>
              <td>
                {claim.verified === 'verified' ? (
                  <span className="success">verificada</span>
                ) : claim.verified === 'unverifiable' ? (
                  <span className="muted">no verificable</span>
                ) : (
                  <span className="error">rechazada</span>
                )}
                {failure ? <div className="error">{failure.reason}</div> : null}
              </td>
              <td className="muted">
                {claim.sourceRefs.length === 0 ? (
                  '—'
                ) : (
                  <ul>
                    {claim.sourceRefs.map((ref) => (
                      <li key={`${ref.entityType}-${ref.entityId}-${ref.field ?? ''}`}>
                        {ref.entityType} · {ref.entityId}
                        {ref.field ? ` · ${ref.field}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ApplicationDetailContent(): ReactNode {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [detail, setDetail] = useState<DetailDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await api<DetailDto>(`/v1/applications/${id}`);
    setDetail(response);
  }, [id]);

  useEffect(() => {
    void load().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'error'),
    );
  }, [load]);

  async function prepare(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/v1/applications/${id}/prepare`, { method: 'POST' });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const response = await api<DetailDto>(`/v1/applications/${id}`);
        setDetail(response);
        if (response.documents.length > 0 || response.application.status === 'REQUIRES_HUMAN_ACTION') {
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
      }
      setMessage('Preparación de documentos solicitada');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'error');
    } finally {
      setBusy(false);
    }
  }

  async function resolveHuman(): Promise<void> {
    const reason = window.prompt('Motivo de la resolución (queda auditado):');
    if (reason === null || reason.trim().length < 3) return;
    setBusy(true);
    try {
      await api(`/v1/applications/${id}/resolve-human`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      await load();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'error');
    } finally {
      setBusy(false);
    }
  }

  async function archive(): Promise<void> {
    setBusy(true);
    try {
      await api(`/v1/applications/${id}/archive`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'error');
    } finally {
      setBusy(false);
    }
  }

  if (detail === null) {
    return (
      <section>
        <h1>Candidatura</h1>
        {error ? <p className="error">{error}</p> : <p className="muted">Cargando…</p>}
      </section>
    );
  }

  const { application, job, match, resumeVersion, resumeName, documents, answers, events, target, blockers } =
    detail;
  const documentsReady = documents.length > 0;

  return (
    <section>
      <h1>
        {job ? `${job.title} · ${job.company}` : 'Candidatura'}{' '}
        <span className="badge">{STATUS_LABELS[application.status] ?? application.status}</span>
      </h1>

      <div className="card">
        <div className="row">
          {application.status === 'SHORTLISTED' || application.status === 'PREPARING' ? (
            <button type="button" disabled={busy} onClick={() => void prepare()}>
              {documentsReady ? 'Re-preparar documentos' : 'Preparar documentos'}
            </button>
          ) : null}
          {application.status === 'REQUIRES_HUMAN_ACTION' ? (
            <button type="button" disabled={busy} onClick={() => void resolveHuman()}>
              Resolver incidencia
            </button>
          ) : null}
          {application.status !== 'ARCHIVED' ? (
            <button type="button" className="secondary" disabled={busy} onClick={() => void archive()}>
              Archivar
            </button>
          ) : null}
        </div>
        {message ? <p className="success">{message}</p> : null}
        <p className="muted">
          Modo {application.mode} · score congelado {(application.scoreAtCreation * 100).toFixed(1)}%
          · política {application.policyVersion} · creada{' '}
          {new Date(application.createdAt).toLocaleString()}
        </p>
        {application.status === 'PREPARING' && documentsReady ? (
          <p className="success">
            Documentos listos · Formulario pendiente de inspección (Fase 5). No existe envío en
            Fase 4.
          </p>
        ) : null}
        {application.preparationSnapshot === null ? (
          <p className="muted">preparationSnapshot: pendiente (requiere SubmissionPort, Fase 5)</p>
        ) : null}
      </div>

      {blockers.length > 0 ? (
        <div className="card error">
          <strong>Bloqueos</strong>
          <ul>
            {blockers.map((blocker, index) => (
              <li key={`${blocker.code}-${index}`}>
                [{blocker.code}] {blocker.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="card">
        <h2>Origen</h2>
        <p className="muted">
          Match {match?.id ?? '—'}
          {match ? ` · score ${(match.overallScore * 100).toFixed(1)}% · ${match.engineVersion}/${match.weightsVersion} · ${new Date(match.computedAt).toLocaleString()}` : ''}
        </p>
        <p className="muted">
          CV fuente: {resumeVersion ? `v${resumeVersion.versionNumber} (${resumeVersion.kind}) · ${resumeVersion.fileHash.slice(0, 12)}…` : resumeName ?? '—'}
        </p>
        <p className="muted">
          Target: {target ? `${target.label} (${target.platform}) · ${target.status}` : 'sin resolver'}
          {target?.status === 'blocked' ? ' · bloqueado para envío (no impide preparar)' : ''}
        </p>
      </div>

      <div className="card">
        <h2>Documentos</h2>
        {documents.length === 0 ? (
          <p className="muted">Sin documentos preparados todavía.</p>
        ) : (
          documents.map((document) => (
            <div key={document.id} className="card">
              <h3>
                {DOCUMENT_LABELS[document.kind] ?? document.kind}{' '}
                <span className="badge">{document.verification.status}</span>
              </h3>
              <p className="muted">
                {document.generatedBy.provider}:{document.generatedBy.model} ·{' '}
                {document.generatedBy.promptVersion} · hash {document.contentHash.slice(0, 12)}… ·{' '}
                {document.storageKey}
              </p>
              <ClaimTable claims={document.claims} verification={document.verification} />
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>Respuestas</h2>
        {answers.length === 0 ? (
          <p className="muted">Sin respuestas registradas.</p>
        ) : (
          answers.map((answer) => (
            <div key={answer.id} className="card">
              <h3>{answer.questionText}</h3>
              <p>{answer.answerText}</p>
              <p className="muted">
                tipo {answer.answerKind} · aprobada: {answer.approved ? 'sí' : 'no'} · requiere
                entrada humana: {answer.requiresHumanInput ? 'sí' : 'no'} · verificación{' '}
                {answer.verification.status}
              </p>
              <ClaimTable claims={answer.claims} verification={answer.verification} />
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>Timeline</h2>
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Evento</th>
              <th>Transición</th>
              <th>Actor</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{new Date(event.occurredAt).toLocaleString()}</td>
                <td>{event.type}</td>
                <td>
                  {event.fromStatus ?? '—'} → {event.toStatus ?? '—'}
                </td>
                <td>{event.actor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

export default function ApplicationDetailPage(): ReactNode {
  return (
    <LoginGate>
      <ApplicationDetailContent />
    </LoginGate>
  );
}
