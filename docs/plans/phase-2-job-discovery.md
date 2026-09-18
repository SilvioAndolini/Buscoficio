# Plan de implementación — Fase 2: Job Discovery

> Arquitectura vigente (`docs/`) y ADRs son la fuente de verdad. Este plan ejecuta, no rediseña.
> Estado: **completado** (2026-09-18). Verificación al pie.

## Alcance

Descubrimiento real multi-fuente + scheduler + L3 + zona gris + filtros duros + rate limiting + watchdog + UI mínima. Nada de Fase 3+.

## Decisiones de implementación

| Tema | Decisión |
|---|---|
| Fuentes reales | `remotive` (API JSON), `arbeitnow` (API paginada), `remoteok` (API JSON con atribución). Sin evasión; rate limits conservadores |
| HTTP | Puerto `HttpClient` en `core`; implementación `fetch` con redirects manuales (cadena para detección de ATS) y timeout, dentro de `job-sources` |
| Tests sin internet | Contract tests con fixtures grabados/anonimizados; E2E controlado con servidor HTTP local que sirve fixtures reales al adapter real; suite live separada (`test:live`) fuera de CI |
| Scheduler | `search_config` es fuente de verdad; `SchedulerService.syncAll()` reconcilia BullMQ Job Schedulers (worker es dueño). API encola `scheduler.sync`. Jitter determinista vía `startDate` |
| L3 | Blocking por `company_norm` + `location_norm`; similitud pg_trgm `similarity(title_norm)` y `similarity(description_norm)`; score = 0.6·title + 0.4·desc; umbrales configurables (`DEDUP_L3_*`) y función pura `resolveFuzzyDecision` |
| Zona gris | Tabla `dedup_review` + cola `dedup-review` (señal/log); decisión humana por API auditada; nunca auto-merge |
| Filtros duros | `evaluateHardFilters` en `core`; rechazo con `rule` + `reason` persistido en `job.metadata.filterDecision` y `job.status='rejected'` |
| Rate limiting | Bucket Redis por `source:operation` + penalización `Retry-After`; espera acotada dentro del job |
| Watchdog | Job repetible `maintenance.search-reconcile`; runs `running` > `WATCHDOG_TIMEOUT_MS` → hijos corriendo a `failed(timeout)` + finalize idempotente |
| Retries | Transient/RateLimited → backoff exponencial + jitter (BullMQ); permanent/auth/validation → sin retry (UnrecoverableError) |
| CI | Se mantiene pipeline; los tests de Fase 2 corren en unit/integration; E2E existente se amplía con el flujo de adapter real contra servidor local |

## Unidades

- U1 core: `HttpClient`, filtros duros, fuzzy score + umbrales, capacidades de fuente.
- U2 shared: env `DEDUP_L3_*`, `WATCHDOG_TIMEOUT_MS`, `SCHEDULER_ENABLED`; helper `schedulerIdForSearchConfig`.
- U3 database: migración 0002 (`job.description_norm`, `job.location_norm`, índices L3, `dedup_review`), repos nuevos y stats por fuente.
- U4 job-sources: http client, helpers (html→text, salario, job type, detección ATS), adapters remotive/arbeitnow/remoteok, fixtures, contract tests.
- U5 worker: rate limiter Redis, scheduler service, watchdog, ingest con L3 + filtros + review, handlers/colas, wiring.
- U6 api: fuentes (list/patch), configs (patch/activar), runs, dedup-reviews, stats; audit.
- U7 web: fuentes, configs, runs con desglose, dedup-review, filtros en lista de jobs.
- U8 tests: unit/contract/integration/E2E controlado/live separado.
- U9 verificación: batería completa + gitleaks + audit + compose smoke + CI.

## Criterios de aceptación

Los de la tarea (§24), verificados con evidencia ejecutable en el reporte final.

## Resultado de la ejecución (2026-09-18)

- Batería: install/lint (15/15 + arch)/typecheck (21/21)/test/build (14/14) ✓
- Integración real (Postgres+Redis): 21/21 tasks — core 30, job-sources 39, database 21, worker 11, api 4, shared 20, storage 4, observability 2 ✓
- E2E Playwright: 2/2 (incluye desglose por fuente, zona gris y `destino: greenhouse`) ✓
- E2E API: flujo mock + flujo real contra servidor de fixtures local (target `greenhouse-acme`, discovery `remoteok`) ✓
- Live manual (`pnpm test:live`): 3/3 fuentes reales ✓ (fuera de CI)
- gitleaks full history: sin hallazgos ✓ · audit: 0 vulnerabilidades ✓
- Docker Compose dev: healthz/readyz OK, fuentes con policy notes registradas ✓
- CI: jobs `ci` + `e2e` en verde.

