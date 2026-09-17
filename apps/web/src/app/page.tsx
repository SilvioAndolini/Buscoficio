'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';

interface Ready {
  status: string;
  checks: Record<string, string>;
}

export default function HomePage(): ReactNode {
  const [ready, setReady] = useState<Ready | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Ready>('/readyz')
      .then(setReady)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'error'));
  }, []);

  return (
    <section>
      <h1>Panel de Fase 1</h1>
      <div className="card">
        <h2>Estado del sistema</h2>
        {error ? <p className="error">API no disponible: {error}</p> : null}
        {ready ? (
          <ul>
            <li>
              API: <span className="badge">{ready.status}</span>
            </li>
            {Object.entries(ready.checks).map(([name, value]) => (
              <li key={name}>
                {name}: <span className="badge">{value}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Consultando…</p>
        )}
      </div>
      <div className="card">
        <h2>Flujo de la fase</h2>
        <ol>
          <li>Crear el perfil candidato.</li>
          <li>Registrar un CV y subir una versión inmutable.</li>
          <li>Ejecutar una búsqueda mock.</li>
          <li>Consultar las ofertas normalizadas y deduplicadas.</li>
        </ol>
      </div>
    </section>
  );
}