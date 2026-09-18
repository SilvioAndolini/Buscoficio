# 14 — Fuentes de descubrimiento y revisión de ToS (Fase 2 / 2.1)

Revisión realizada: **2026-09-18**, wording revisado en Fase 2.1 para evitar conclusiones legales
absolutas. Cada fuente se registra en `job_source.policy_notes` al arrancar el worker
(ver `packages/job-sources/src/real/index.ts`). Una fuente no revisada debe quedar en `status = blocked`.

## Fuentes de descubrimiento (discovery)

| Fuente | Método de acceso | Condiciones/limitaciones | Nuestra postura | Rate limit propio | Estado |
|---|---|---|---|---|---|
| `remotive` | API JSON pública `remotive.com/api/remote-jobs` | Uso sujeto a términos del proveedor; atribución/link-back esperada; sin paginación | Solo búsqueda personal; sin evasión; User-Agent identificable por transparencia | 10 req/min (autolimitado) | active |
| `arbeitnow` | API JSON pública `arbeitnow.com/api/job-board-api` (paginada) | Uso sujeto a términos del proveedor; link-back esperado | Solo búsqueda personal; sin evasión; User-Agent identificable por transparencia | 10 req/min (autolimitado) | active |
| `remoteok` | API JSON pública `remoteok.com/api` | Uso sujeto a términos del proveedor; atribución/link-back requerida por el proveedor | Solo búsqueda personal; sin evasión; User-Agent identificable por transparencia | 6 req/min (autolimitado) | active |
| `mock` | Fixtures deterministas locales | Ninguna (no hay servicio externo) | N/A | 60 req/min | active (tests/dev) |

Aclaración de wording (Fase 2.1): no se afirma que la automatización esté “permitida” por el proveedor;
se documenta que **existe API pública y que el uso queda sujeto a sus términos**. El User-Agent
identificable es una medida de transparencia propia, no un requisito publicado por Remote OK.

Reglas aplicadas a todas las fuentes:

- Nunca se implementan técnicas de evasión (CAPTCHA, fingerprints, proxies rotativos, ocultación de UA).
- Los rate limits son **autolimitados** (más estrictos que lo publicado cuando no hay cifra oficial).
- `Retry-After` se respeta mediante penalización en Redis (`rate:blocked:<source>:<operation>`).
- Si una fuente se marca `blocked` (API de fuentes o `PATCH /v1/sources/:key`), no se ejecuta: sus
  `SearchSourceRun` quedan en `skipped` con evidencia explícita.
- `SearchConfig` (keywords/locations/remote) se respeta siempre: filtro server-side cuando existe y,
  en todos los casos, matcher local determinista (`evaluateSearchQuery`).

## Destinos de aplicación (application targets)

La detección de ATS es **determinista por hostname/redirect/enlaces estructurados** (`detectAtsFromUrl`):
`boards.greenhouse.io`, `job-boards.greenhouse.io`, `jobs.lever.co`, `*.myworkdayjobs.com`,
`jobs.ashbyhq.com`, `apply.workable.com`, `jobs.smartrecruiters.com`. Si no hay señal en metadata, el
pipeline puede ejecutar **enrichment de redirects** (presupuesto por run + rate limit propio).

- **Detección ≠ autorización**: todo target nuevo se crea en `status = blocked` con la nota
  “Submission authorization pending separate platform policy review”. El Job conserva el
  `applicationTargetId` (metadata de descubrimiento) aunque el target esté bloqueado.
- **NO POLICY REVIEW → NO ACTIVE TARGET**: activar (`blocked → active`) exige una revisión explícita
  vía `PATCH /v1/application-targets/:key` con `policyReview.notes` (mín. 10 caracteres) y, opcionalmente,
  `policyReview.reference`. El sistema persiste `reviewed_at` (reloj del servidor) y `reviewed_by`
  (`user`) y compone `policy_notes` con la revisión real. La activación sin revisión responde
  `422 POLICY_DENIED`. Transiciones restrictivas (`active→paused`, `active→blocked`, `paused→blocked`)
  no requieren revisión nueva; reactivar un target previamente revisado reutiliza su evidencia.
- **Auditoría**: la revisión genera `application_target.policy_reviewed` (targetKey, previousStatus,
  newStatus, reviewedBy, reviewedAt, reference) y los cambios de estado `application_target.status_changed`.
- **Legacy**: la migración `0005` bloquea los targets auto-detectados de Fase 2 que quedaron
  `status='active'` con `policy_notes NULL` (sin evidencia de revisión), preservando intactos los que
  sí tienen notas y los ya bloqueados. La migración `0006` cubre el estado de Fase 2.1
  (`active` + nota automática “pending separate platform policy review” + `reviewed_at/reviewed_by`
  nulos): lo bloquea. Las reviews estructuradas (`reviewed_at`/`reviewed_by`) permanecen `active` sin
  cambios; la evidencia textual antigua (p. ej. “Reviewed policy 2026-01-01 by user.”) se conserva
  intacta a propósito (no se puede derivar fecha/actor de forma fiable y nunca se inventan datos):
  queda documentada para revisión manual. Ambas migraciones son idempotentes y forward-only.
- Revisión por plataforma (greenhouse, lever, workday, ashby, workable, smartrecruiters) pendiente
  antes de habilitar envíos reales (Fases 5/6).

## Suites de test

- **Contract tests (CI)**: fixtures reales anonimizados en `packages/job-sources/test/fixtures/`
  (grabados con `node scripts/record-fixtures.mjs`, compañías sustituidas por alias ficticios) +
  payloads deterministas para SearchQuery.
- **E2E controlado (CI)**: servidor HTTP local que sirve esos fixtures a los adapters reales; incluye
  un ítem con `apply_url` a Greenhouse y otro cuyo target solo se descubre por redirect chain
  (302 → 302 → Greenhouse), verificado sin salir a internet.
- **Live (manual, fuera de CI)**: `pnpm test:live` consulta las APIs reales una vez por fuente.
