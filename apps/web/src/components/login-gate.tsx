'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api';

type SessionState = 'loading' | 'anonymous' | 'authenticated';

export function LoginGate({ children }: { children: ReactNode }): ReactNode {
  const [session, setSession] = useState<SessionState>('loading');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      await api('/v1/auth/me');
      setSession('authenticated');
    } catch {
      setSession('anonymous');
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await api('/v1/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
      setPassword('');
      setSession('authenticated');
    } catch {
      setError('Credenciales inválidas');
    }
  }

  if (session === 'loading') return <p>Cargando…</p>;

  if (session === 'anonymous') {
    return (
      <form className="card" onSubmit={(event) => void submit(event)}>
        <h2>Acceso</h2>
        <p className="muted">Sistema personal: introduce tu contraseña.</p>
        <label>
          Contraseña
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit">Entrar</button>
      </form>
    );
  }

  return children;
}