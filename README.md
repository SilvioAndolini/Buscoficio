# Job System — Automated Job Search & Application System

Plataforma personal de búsqueda, clasificación y candidatura a ofertas de empleo.
**Estado: Fase 2 (Job Discovery) completada** — descubrimiento multi-fuente real (remotive, arbeitnow, remoteok), scheduler, dedup L0–L3, filtros duros, rate limiting, watchdog y UI mínima.

## Stack

TypeScript (strict) · pnpm + Turborepo · Next.js · Fastify · PostgreSQL + Drizzle ORM · Redis + BullMQ · Playwright · Zod · Pino · Vitest.

## Quickstart (desarrollo local)

```bash
pnpm install --frozen-lockfile
cp .env.example .env          # ajusta AUTH_PASSWORD_HASH y AUTH_SECRET
docker compose -f docker/docker-compose.yml up -d postgres redis
pnpm db:migrate               # DATABASE_URL del .env
pnpm dev                      # api + worker + web (turbo, en paralelo)
```

- API: http://localhost:3001 (`/healthz`, `/readyz`)
- Web: http://localhost:3000 (proxy `/v1` → API, cookie same-site)
- Generar hash de contraseña: `pnpm --filter @job-system/api hash-password "tu-password"`

Alternativa containerizada (api + worker + db + redis + migración automática):

```bash
docker compose -f docker/docker-compose.yml up -d --build --wait
```

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm turbo lint` | ESLint + reglas de arquitectura (boundaries, self-test) |
| `pnpm turbo typecheck` | `tsc --noEmit` en todo el monorepo |
| `pnpm turbo test` | Unit + integración (los de integración se omiten sin `TEST_DATABASE_URL`/`TEST_REDIS_URL`) |
| `pnpm test:integration` | Levanta Postgres/Redis de test, exporta URLs y ejecuta toda la suite real |
| `pnpm test:e2e` | Smoke Playwright: build + api + worker + web + navegador |
| `pnpm test:live` | Suite live manual contra las APIs reales (nunca en CI) |
| `pnpm turbo build` | Bundles de api/worker (tsup) y build de web (Next) |
| `pnpm db:migrate` | Aplica migraciones (requiere `DATABASE_URL`) |
| `pnpm --filter @job-system/database db:generate` | Genera migración a partir del schema Drizzle |
| `pnpm format` / `pnpm format:check` | Prettier |

## Estructura

```
apps/
  web/     Next.js (UI mínima: perfil, CVs, ofertas) — sólo consume /v1
  api/     Fastify (auth single-user, CRUD, encolado; nunca ejecuta trabajos largos)
  worker/  BullMQ (search, ingest, maintenance) + servicios de orquestación
packages/
  core/        dominio puro: schemas, errores, puertos, dedup L0–L2
  shared/      config Zod, ids UUIDv7, texto, ids de cola
  database/    schema Drizzle, migraciones, repositorios
  job-sources/ mock adapter determinista + normalización (contrato JobSourceAdapter)
  storage/     StoragePort local (CVs fuera de Postgres)
  observability/ Pino con redacción y contexto de trazabilidad
  matching | ai | documents | application-engine | browser-automation
               placeholders de fases 3–7 (sin funcionalidad)
docker/       Compose dev, Compose test, Dockerfile
docs/         arquitectura aprobada (Fase 0/0.1) + planes de fase
e2e/          smoke de UI con Playwright
scripts/      check-arch, test-integration, test-e2e
```

## Reglas de arquitectura (verificadas en CI)

- `core` y `shared` no dependen de nada del proyecto.
- `matching`, `documents`, `application-engine` sólo dependen de puertos de `core` (nunca de `packages/ai` ni SDKs).
- Ningún package importa `apps/*`; `apps/web` no importa packages internos.
- `scripts/check-arch.mjs` corre en `turbo lint` (con self-test de violaciones).

## Testing

- **Unit**: schemas, dedup (URL canónica, fingerprint, claves), errores, redacción de logs, normalización, adapter mock.
- **Integración**: Postgres/Redis reales (nunca mocks de infraestructura): migraciones desde DB vacía, constraints, inmutabilidad de versiones de CV, idempotencia de ingesta L0–L2, pipeline de búsqueda completo.
- **E2E**: `apps/api/test/foundation.e2e.test.ts` (API + worker + DB + Redis reales) y `e2e/ui.smoke.spec.ts` (Playwright sobre la UI).
- Prohibido apuntar a plataformas reales en tests; fixtures ficticios únicamente.

## Fases

- Fase 0/0.1 — Arquitectura (completa) → `docs/arquitectura`, `docs/decisiones`
- **Fase 1 — Foundation (completa)** → perfil, CVs versionados, búsqueda mock, dedup L0–L2, API, worker, UI
- Fases 2–7 → `docs/producto/12-roadmap-y-criterios.md`

## Seguridad

`DRY_RUN=true` y `AUTO_APPLY_ENABLED=false` por defecto; ENV es techo inmutable.
Sin secretos en el repo (`.env` ignorado, `.env.example` con placeholders). Pino redacta
passwords, tokens, cookies, emails y sesiones. La API no expone datos sin sesión.