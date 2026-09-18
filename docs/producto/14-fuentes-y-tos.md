# 14 — Fuentes de descubrimiento y revisión de ToS (Fase 2)

Revisión realizada: **2026-09-18**. Cada fuente se registra en `job_source.policy_notes` al arrancar el worker
(ver `packages/job-sources/src/real/index.ts`). Una fuente no revisada debe quedar en `status = blocked`.

## Fuentes de descubrimiento (discovery)

| Fuente | Método de acceso | Limitaciones relevantes | Automatización | Rate limit propio | Estado |
|---|---|---|---|---|---|
| `remotive` | API JSON pública `remotive.com/api/remote-jobs` | Atribución/link-back esperado; sin paginación | Permitida para búsqueda personal; sin CAPTCHA/anti-bot | 10 req/min (autolimitado) | active |
| `arbeitnow` | API JSON pública `arbeitnow.com/api/job-board-api` (paginada) | Feed público de ofertas; enlazar a la oferta original | Permitida para búsqueda personal; sin CAPTCHA/anti-bot | 10 req/min (autolimitado) | active |
| `remoteok` | API JSON pública `remoteok.com/api` | **Atribución obligatoria**; User-Agent identificable obligatorio | Permitida para búsqueda personal; sin CAPTCHA/anti-bot | 6 req/min (autolimitado) | active |
| `mock` | Fixtures deterministas locales | Ninguna (no hay servicio externo) | N/A | 60 req/min | active (tests/dev) |

Reglas aplicadas a todas las fuentes:

- Nunca se implementan técnicas de evasión (CAPTCHA, fingerprints, proxies rotativos, ocultación de UA).
- Los rate limits son **autolimitados** (más estrictos que lo publicado cuando no hay cifra oficial).
- `Retry-After` se respeta mediante penalización en Redis (`rate:blocked:<source>:<operation>`).
- Si una fuente se marca `blocked` (API de fuentes o `PATCH /v1/sources/:key`), el scheduler la salta y sus
  `SearchSourceRun` quedan en `skipped` con evidencia.

## Destinos de aplicación (application targets)

La detección de ATS es **determinista por hostname/redirect/enlaces estructurados** (`detectAtsFromUrl`):
`boards.greenhouse.io`, `job-boards.greenhouse.io`, `jobs.lever.co`, `*.myworkdayjobs.com`,
`jobs.ashbyhq.com`, `apply.workable.com`, `jobs.smartrecruiters.com`.

- El destino se registra como `application_target` con clave `plataforma-empresa` (p. ej. `greenhouse-acme`).
- `job_source` (descubrimiento) y `application_target` (envío) son conceptos separados (ADR-013); el Job
  canónico conserva la provenance de sus listings y promueve el target solo cuando no tiene uno (sin
  sobrescribir conflictos; el conflicto queda registrado en `reasons`).
- `policy_notes` de los targets detectados: revisión pendiente por plataforma antes de habilitar envíos
  (Fase 5/6). Por ahora **ningún target permite submit** (`supportsAutoSubmit` no habilitado).

## Suites de test

- **Contract tests (CI)**: fixtures reales anonimizados en `packages/job-sources/test/fixtures/`
  (grabados con `node scripts/record-fixtures.mjs`, compañías sustituidas por alias ficticios).
- **E2E controlado (CI)**: servidor HTTP local que sirve esos fixtures a los adapters reales; incluye un
  ítem sintético con `apply_url` a Greenhouse para verificar la resolución de target. Sin internet.
- **Live (manual, fuera de CI)**: `pnpm test:live` consulta las APIs reales una vez por fuente y valida
  normalización. No se ejecuta en CI ni en tests automáticos.
