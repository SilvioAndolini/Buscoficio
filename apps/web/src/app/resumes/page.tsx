'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { LoginGate } from '../../components/login-gate';

interface ResumeVersionDto {
  id: string;
  versionNumber: number;
  kind: string;
  storageKey: string;
  fileHash: string;
  createdAt: string;
}

interface ResumeDto {
  id: string;
  name: string;
  category: string;
  language: string;
  isDefault: boolean;
  versions?: ResumeVersionDto[];
}

function ResumesContent(): ReactNode {
  const [resumes, setResumes] = useState<ResumeDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await api<{ items: ResumeDto[] }>('/v1/resumes');
    const detailed = await Promise.all(
      list.items.map((resume) => api<ResumeDto>(`/v1/resumes/${resume.id}`)),
    );
    setResumes(detailed);
  }, []);

  useEffect(() => {
    load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'error'));
  }, [load]);

  async function createResume(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const form = event.currentTarget;
    try {
      const formData = new FormData(form);
      await api('/v1/resumes', {
        method: 'POST',
        body: JSON.stringify({
          name: String(formData.get('name')),
          category: String(formData.get('category')),
          language: String(formData.get('language') ?? 'en'),
          isDefault: formData.get('isDefault') === 'on',
        }),
      });
      form.reset();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Error al crear el CV');
    }
  }

  async function uploadVersion(event: FormEvent<HTMLFormElement>, resumeId: string): Promise<void> {
    event.preventDefault();
    setError(null);
    const form = event.currentTarget;
    try {
      const formData = new FormData(form);
      const file = formData.get('file');
      if (!(file instanceof File) || file.size === 0) {
        setError('Selecciona un archivo');
        return;
      }
      const payload = new FormData();
      payload.set('file', file);
      payload.set('kind', String(formData.get('kind') ?? 'original'));
      await api(`/v1/resumes/${resumeId}/versions`, { method: 'POST', body: payload });
      form.reset();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Error al subir la versión');
    }
  }

  return (
    <section>
      <h1>CVs</h1>
      <form className="card" onSubmit={(event) => void createResume(event)}>
        <h2>Nuevo CV</h2>
        <div className="grid">
          <label>
            Nombre
            <input name="name" required />
          </label>
          <label>
            Categoría
            <select name="category" defaultValue="software-engineering">
              <option value="software-engineering">software-engineering</option>
              <option value="audiovisual">audiovisual</option>
              <option value="management">management</option>
              <option value="other">other</option>
            </select>
          </label>
          <label>
            Idioma
            <input name="language" defaultValue="en" />
          </label>
        </div>
        <label>
          <input
            type="checkbox"
            name="isDefault"
            style={{ width: 'auto', display: 'inline-block', marginRight: 8 }}
          />
          CV principal
        </label>
        <button type="submit">Crear CV</button>
      </form>

      {error ? <p className="error">{error}</p> : null}

      {resumes.map((resume) => (
        <div className="card" key={resume.id}>
          <h2>
            {resume.name} <span className="badge">{resume.category}</span>
            {resume.isDefault ? <span className="badge">principal</span> : null}
          </h2>
          <table>
            <thead>
              <tr>
                <th>Versión</th>
                <th>Tipo</th>
                <th>Hash</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {(resume.versions ?? []).map((version) => (
                <tr key={version.id}>
                  <td>v{version.versionNumber}</td>
                  <td>{version.kind}</td>
                  <td>
                    <code>{version.fileHash.slice(0, 12)}…</code>
                  </td>
                  <td>{new Date(version.createdAt).toLocaleString()}</td>
                </tr>
              ))}
              {(resume.versions ?? []).length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    Sin versiones
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <form onSubmit={(event) => void uploadVersion(event, resume.id)}>
            <div className="grid">
              <label>
                Archivo
                <input type="file" name="file" required />
              </label>
              <label>
                Tipo
                <select name="kind" defaultValue="original">
                  <option value="original">original</option>
                  <option value="tailored">tailored</option>
                  <option value="generated">generated</option>
                </select>
              </label>
            </div>
            <button type="submit">Subir versión inmutable</button>
          </form>
        </div>
      ))}
    </section>
  );
}

export default function ResumesPage(): ReactNode {
  return (
    <LoginGate>
      <ResumesContent />
    </LoginGate>
  );
}