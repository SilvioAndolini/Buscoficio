# Plan de implementación — Fase 1: Foundation

> Fuente de verdad: `/documentos` (arquitectura aprobada tras Fase 0.1). Este plan no rediseña; ejecuta.
> Estado: **completado** (2026-09-17). Verificación final al pie del documento. Fecha de inicio: 2026-09-17.

## Alcance

Esqueleto funcional end-to-end con datos ficticios: perfil → CV versionado → búsqueda mock → normalización → dedup L0–L2 → JobListing + Job canónico → API → UI. Postgres y Redis reales en el flujo E2E.

Fuera de alcance (Fases 2–7): fuentes reales, L3/embeddings, matching, IA/proveedores reales, Jev, documentos generados, application engine, Playwright, AUTO. Los paquetes `matching`, `ai`, `documents`, `application-engine`, `browser-automation` existen como estructura vacía.

## Decisiones de implementación (compatibles con la arquitectura)

| Tema | Decisión | Justificación |
|---|---|---|
| Paquetes internos | Se consumen como fuente TS (exports → `src/index.ts`); apps empaquetan con `tsup` (`noExternal: @job-system/*`) | Evita pipeline de build intermedio; `build` de packages = `tsc --noEmit` |
| `packages/storage` | Paquete nuevo mínimo para `StoragePort` local | Ningún paquete aprobado era dueño del storage de archivos (doc 02 lo lista como adapter) |
| Boundaries | Script propio `scripts/check-arch.mjs` (con self-test) integrado a `turbo lint` vía tarea raíz `//#arch:check` | `dependency-cruiser`/`eslint-plugin-boundaries` no aportan más para reglas por paquete |
| Colas F1 | `search` (run + finalize), `ingest` (por fuente), `maintenance` (smoke) | Fiel a doc 06 (fan-out por fuente + finalizador idempotente) sin adelantar colas de fases futuras |
| Migraciones | `drizzle-kit generate` + migrator programático (`packages/database/src/migrate.ts`) | Reproducible desde DB vacía; usado por CI/tests |
| Tests integración | Postgres/Redis reales vía `docker/docker-compose.test.yml` + `TEST_DATABASE_URL`/`TEST_REDIS_URL`; skip explícito si faltan | Sin mocks de infraestructura; CI provee servicios |
| E2E | Pipeline completo API→worker→DB/Redis con Fastify `inject` + worker en proceso; UI validada con Playwright smoke (`scripts/test-e2e.mjs`) | Cubre el flujo real sin fragilidad de navegador para el core; UI como smoke test |
| Frontend ↔ API | Next.js proxy (`rewrites`) hacia API; cookie same-site | Evita CORS sin debilitar seguridad (mismo origen lógico) |

## Unidades de trabajo

### U0 — Monorepo y tooling
- **Objetivo:** pnpm + Turbo + TS strict + ESLint + Prettier + boundaries + CI. `pnpm turbo lint|typecheck|test|build`.
- **Archivos:** raíz (`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.mjs`, `prettier.config.mjs`, `.gitignore`, `.env.example`, `scripts/check-arch.mjs`), `AGENTS.md`.
- **Tests:** self-test del checker de boundaries (fixture con import prohibido detectado).
- **Verificación:** `pnpm install`, `pnpm arch:check`.
- **Depende de:** nada.

### U1 — `packages/shared`
- **Objetivo:** config Zod centralizada (`loadEnv`), ids UUIDv7, hashing sha256, normalización de texto.
- **Interfaces:** `loadEnv(): Env`, `uuidv7()`, `sha256Hex()`, `normalizeText()`.
- **Tests unit:** formato UUIDv7, defaults seguros (`DRY_RUN=true`, `AUTO_APPLY_ENABLED=false`), rechazo de env inválido, hashing determinista.
- **Verificación:** `pnpm --filter @job-system/shared test`.
- **Depende de:** U0.

### U2 — `packages/observability`
- **Objetivo:** logger Pino con redacción y contexto (`correlationId`, `jobId`, `sourceId`, `applicationId`).
- **Interfaces:** `createLogger(env)`, `createJobLogger(ctx)`.
- **Tests unit:** redacción de password/token/cookie/email/phone/storageState; presencia de ids en logs.
- **Verificación:** `pnpm --filter @job-system/observability test`.
- **Depende de:** U0, U1.

### U3 — `packages/core`
- **Objetivo:** esquemas Zod de dominio F1 (Candidate, Resume, JobSource/RawJob/NormalizedJob/Job), taxonomía de errores, puertos, dedup puro (canonical URL, fingerprints, dedup key).
- **Interfaces:** `NormalizedJobSchema`, `normalizeCanonicalUrl()`, `computeUrlHash()`, `computeDescriptionFingerprint()`, `computeDedupKey()`, `AppError` + subclases, `JobSourceAdapter`, `StoragePort`, `Clock`, `TraceContext`.
- **Tests unit:** schemas aceptan/rechazan; URL canonical (utm/fbclid/trailing slash/host); fingerprint estable; dedup key determinista; errores con código/reintentabilidad.
- **Verificación:** `pnpm --filter @job-system/core test`.
- **Depende de:** U1.

### U4 — `packages/database`
- **Objetivo:** schema Drizzle del modelo aprobado (F1 + tablas estructurales `application_target`, `embedding_space`, `decision_log`), migración inicial, migrator, repositorios idempotentes.
- **Tablas:** candidate_profile, skill, candidate_skill, experience, education, candidate_language, resume, resume_version, job_source, application_target, job_listing, job, search_config, search_run, search_source_run, embedding_space, decision_log, audit_log.
- **Interfaces:** `createDb(url)`, `migrate(url)`, repos: `candidateRepo`, `resumeRepo`, `jobSourceRepo`, `jobRepo` (ingest transaccional), `searchRunRepo`, `auditRepo`; helper `truncateAll` (testing).
- **Tests:** integración (DB real): migración desde vacío, constraints (unique source+external, dedup_key, resume_version number), inmutabilidad de versión, transacción de ingesta, idempotencia.
- **Verificación:** `pnpm --filter @job-system/database test` (con `TEST_DATABASE_URL`).
- **Depende de:** U0, U1, U3.

### U5 — `packages/storage`
- **Objetivo:** `LocalStorageAdapter` (StoragePort) para desarrollo local; archivos fuera de Postgres, referencia por `storage_key` + hash.
- **Tests unit:** put/get/delete, hash estable, keys sin path traversal.
- **Verificación:** `pnpm --filter @job-system/storage test`.
- **Depende de:** U3.

### U6 — `packages/job-sources`
- **Objetivo:** `MockJobSourceAdapter` determinista (paginación, fetch, duplicados, malformados, expirados, errores simulados), normalizador Zod puro y registry de adapters. Sin acceso a DB (boundary doc 11).
- **Interfaces:** `createMockJobSource(options)`, `SourceRegistry`, `normalizeJob(raw)`, contrato `JobSourceAdapter` (core).
- **Tests:** unit (normalización, malformado no aborta, expiración, paginación, errores, determinismo, contrato del adapter).
- **Verificación:** `pnpm --filter @job-system/job-sources test`.
- **Depende de:** U3.

### U7 — `apps/api`
- **Objetivo:** Fastify: health/ready reales, auth single-user (cookie firmada + hash de password), CRUD perfil/CVs con upload, jobs, search-configs/run (encolado BullMQ), manejo de errores por taxonomía.
- **Interfaces:** `buildApp({deps})` (testeable con `inject`), rutas `/v1/*`.
- **Tests:** integración (auth, CRUD, upload, run encolado; POST no ejecuta pipeline) + unit (error mapping).
- **Verificación:** `pnpm --filter @job-system/api test` y `build`.
- **Depende de:** U1–U6.

### U8 — `apps/worker`
- **Objetivo:** BullMQ real: colas `search`, `ingest`, `maintenance`; handlers `search.run`, `ingest.source`, `search.finalize`, `maintenance.smoke`; **servicios de orquestación** `SearchService` e `IngestService` (dedup L0–L2 + cuarentena) viviendo en el composition root (doc 11: `job-sources` no importa `database`); tracing por job; graceful shutdown (SIGTERM/SIGINT).
- **Interfaces:** `startWorker(env)`, handlers invocables en tests, `IngestService.ingest(raw) → {outcome: new|merged|duplicate|rejected}`.
- **Tests:** integración (Redis/Postgres reales): smoke job, pipeline completo search→ingest→dedup→persistencia, idempotencia al repetir.
- **Verificación:** `pnpm --filter @job-system/worker test`.
- **Depende de:** U4, U6.

### U9 — `apps/web`
- **Objetivo:** UI mínima Next.js (perfil, CVs/versiones, ofertas + ejecutar búsqueda mock) consumiendo sólo `/v1` vía proxy.
- **Tests:** smoke Playwright (login, perfil, CV, run, ofertas) — `scripts/test-e2e.mjs`.
- **Verificación:** `pnpm --filter @job-system/web build`.
- **Depende de:** U7.

### U10 — Tests E2E
- **Objetivo:** flujo completo real: seed perfil/CV → run async → worker → persistencia → API devuelve ofertas; idempotencia al segundo run.
- **Archivos:** `apps/api/test/foundation.e2e.test.ts`, `e2e/ui.smoke.spec.ts`.
- **Verificación:** `pnpm test:integration`, `pnpm test:e2e`.
- **Depende de:** U7, U8, U9.

### U11 — Docker y CI
- **Objetivo:** Compose dev (api, worker, postgres, redis con healthchecks) + test (postgres, redis) + Dockerfile; GitHub Actions install→lint→typecheck→test→build + migración desde vacío + gitleaks.
- **Verificación:** `docker compose -f docker/docker-compose.yml config`; CI en verde.
- **Depende de:** U7, U8.

### U12 — Verificación final y reporte
- **Objetivo:** ejecutar la batería completa y el E2E de Fase 1; documentar comandos, env y estructura; reporte final con desviaciones y deuda.
- **Verificación:** `pnpm install --frozen-lockfile && pnpm turbo lint && pnpm turbo typecheck && pnpm turbo test && pnpm turbo build`.

## Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| Docker Desktop no disponible localmente | Tests de integración con skip explícito + servicios en CI; documentado en reporte |
| pnpm sin shim global (EPERM en corepack) | pnpm 9.15.4 instalado vía npm global |
| Bundling `pg`/drizzle con tsup | Mantener deps externas (default) y bundlear sólo `@job-system/*` |
| Paralelismo de tests contra una única DB | Vitest `fileParallelism: false` + truncate entre tests |

## Resultado de la ejecución (2026-09-17)

- `pnpm install --frozen-lockfile` ✓
- `pnpm turbo lint` ✓ (15/15, incluye `arch check: OK` con self-test)
- `pnpm turbo typecheck` ✓ (21/21)
- `pnpm turbo test` (sin infra) ✓ (unit; integración omitida explícitamente)
- `pnpm test:integration` ✓ (74/74 tests con Postgres y Redis reales; migraciones desde DB vacía incluidas)
- `pnpm test:e2e` ✓ (Playwright UI smoke 2/2; API+worker+web+DB+Redis reales)
- `pnpm turbo build` ✓ (14/14; tsup api/worker + next build)
- Docker Compose dev: `up --build --wait` ✓; `/healthz` y `/readyz` OK; worker `ready`; migración automática; flujo E2E manual vía API (7 jobs nuevos, 2 duplicados, 1 rechazado) ✓
- Commits: 14 pequeños y coherentes.

Desviaciones registradas en el reporte de Fase 1 (paquete `packages/storage`, `UnauthorizedError`,
rewrites de Next con API_URL de build, `output: standalone` deshabilitado en Windows).