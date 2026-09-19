import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Job System',
  description: 'Búsqueda y candidatura automática de empleo (Fase 1)',
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="es">
      <body>
        <nav>
          <strong>Job System</strong>
          <Link href="/">Inicio</Link>
          <Link href="/profile">Perfil</Link>
          <Link href="/resumes">CVs</Link>
          <Link href="/jobs">Ofertas</Link>
          <Link href="/matches">Matching</Link>
          <Link href="/applications">Candidaturas</Link>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}