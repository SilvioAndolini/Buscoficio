# 02 — Arquitectura general

> Revisión Fase 0.1: `ApplicationTarget` separado de la fuente de descubrimiento, `SubmissionPort` en el dominio, puertos de IA en `core`, jerarquía DRY_RUN/AUTO, flujo de preparación completa antes de `READY_FOR_REVIEW`.

## 1. Forma arquitectónica

**Modular monolith con workers separados** (monorepo TypeScript, pnpm + Turborepo):

- `apps/web` — Next.js (UI). Consume **exclusivamente** la API pública. Cero lógica de dominio.
- `apps/api` — Fastify (HTTP, validación Zod, auth, composición). No ejecuta trabajos largos; encola.
- `apps/worker` — consumidores BullMQ. Ejecuta búsquedas, ingesta, matching, documentos, orquestación de candidaturas y reconciliación.
- `apps/browser-worker` (mismo código que `apps/worker`, perfil distinto) — consume sólo `automation`; **rol de DB limitado**; no puede tocar `application`.
- `packages/*` — dominio, puertos y adaptadores con reglas de dependencia estrictas.

Justificación: volumen y equipo (1 persona) no justifican microservicios; la separación API/worker es necesaria por las operaciones largas y frágiles (IA, scraping, navegador), y el browser worker se aísla por seguridad (mínimo privilegio).

## 2. Principios de diseño

1. **Dependencias hacia dentro**: `core` no importa infraestructura. `matching`/`documents`/`application-engine` dependen de **puertos**, no de implementaciones (`packages/ai` incluido).
2. **Puertos y adaptadores donde aportan separación real**: `JobSourceAdapter`, `TextGenerationPort`, `EmbeddingProvider`, `DecisionProvider`, `SubmissionPort`, `StoragePort`, `SecretProvider`, `Clock`, `RateLimiter`. Sin abstracciones especulativas.
3. **Fronteras validadas**: todo dato que entra o sale (HTTP, colas, fuentes, IA, DB al leer) pasa por Zod.
4. **Postgres es la fuente de verdad**; Redis es transporte/efímero. La idempotencia funcional descansa en claves de dominio y constraints de Postgres, no en BullMQ.
5. **Trabajo largo fuera del request lifecycle**: la API responde < 300 ms; todo lo demás es asíncrono (`202 + jobId`).
6. **Determinista antes que IA**: la IA redacta/extrae/clasifica con validación; **nunca decide** dedup, elegibilidad, score final, selección de CV ni envíos.
7. **Explicabilidad**: match, política, jerarquía de configuración y transiciones producen estructuras persistidas y visibles.
8. **Seguridad por defecto**: `DRY_RUN=true`, `AUTO_APPLY_ENABLED=false`, sin secretos en código, PII minimizada, browser worker con mínimo privilegio.
9. **Discovery ≠ target de aplicación**: se descubren ofertas en fuentes y se aplica en destinos reales (ATS/API/email); nunca se confunden.
10. **Simplicidad primero**: cada pieza nueva debe justificar por qué no basta lo existente (ver `decisiones/13`).

## 3. Diagrama lógico (texto)

```
                                ┌────────────────────────────────────────────┐
                                │                apps/web (Next.js)          │
                                │  perfil, CVs, ofertas, matches, revisión   │
                                │  de candidaturas, seguimiento, stats       │
                                └───────────────▲────────────────────────────┘
                                                │ HTTPS (sólo API pública /v1)
───────────────────────────────────────────────┴────────────────────────────┐
│ apps/api (Fastify): auth, validación, consultas, encolado. Nunca ejecuta   │
│ trabajos largos.                                                            │
└───────┬────────────────────────────────────────────────────────────────────┘
        │ encola (BullMQ)                              ▲ lee/escribe
        ▼                                              │
┌──────────────────────────────┐              ┌────────┴─────────────────────┐
│ apps/worker (BullMQ)         │              │ PostgreSQL (fuente de verdad)│
│  search, ingest, match,      │◄────────────►│  dominio + auditoría +       │
│  documents, apply, maint.    │              │  decision_log + pgvector      │
──┬──────────┬────────────┬───┘              ──────────────────────────────
   │          │            │                  ┌──────────────────────────────┐
   ▼          ▼            ▼                  │ Redis (colas, rate limits,   │
┌────────┐ ┌──────────┐ ─────────────┐       │ locks, caché)                │
│job-    │ │ai        │ │apply-results│       ──────────────────────────────
│sources │ │TextGen + │ └──────▲──────┘
│(discov.)│ │Embeddings│        │ publica resultado (no transiciona)
│+ target │ │+ Jev     │ ┌──────┴───────────────────────────┐
│resolution│ │(Decision)│ │ apps/browser-worker              │
└──────── └──────────┘ │  automation (Playwright/API)     │
                         │  rol DB limitado: browser_session│
                         │  + automation_run + artefactos   │
                         └──────────────────────────────────┘
```

Dependencias entre capas (siempre hacia dentro):

```
apps/* (composition roots: inyectan implementaciones)
   ▼
servicios: matching · documents · application-engine · search
   ▼
core: entidades, state machine, policies, PUERTOS, errores
   ▲
adapters: database · job-sources · ai (implementa puertos) · browser-automation (SubmissionPort) · observability · storage
   ▼
infra: PostgreSQL · Redis · Playwright · SDKs IA · filesystem/S3
```

## 4. Límites de cada módulo

| Módulo | Responsabilidad | NO es su responsabilidad | Datos que posee | Depende de |
|---|---|---|---|---|
| `core` | Entidades, invariantes, state machine, políticas, **puertos**, errores, eventos | I/O, frameworks, SDKs | — | zod |
| `database` | Schema Drizzle, migraciones, repositorios | Lógica de negocio | Todas las tablas (custodia) | core, drizzle |
| `job-sources` | Adapters de descubrimiento, normalización, **resolución de `ApplicationTarget`** | Filtrar, puntuar, aplicar | `job_source`, `job_listing`, `job`, `application_target` | core, HTTP |
| `matching` | Scoring determinista + semántico, explicación, selección de CV | Generar documentos, enviar | `job_match`, embeddings | core (puertos) |
| `ai` | **Implementa** `TextGenerationPort`, `EmbeddingProvider`, `DecisionProvider`; prompts, validación, costos | Lógica de negocio | `ai_usage`, `decision_log`, prompts | core, SDKs IA |
| `documents` | CVs/variantes, cover letters, respuestas, claims | Enviar, tocar originales | `application_document`, `resume_version` | core (puertos) |
| `application-engine` | Ciclo de candidatura, transiciones, ledger, reconciliación | Navegar, redactar | `application*`, ledger | core (puertos), matching, documents |
| `browser-automation` | **Implementa `SubmissionPort`**; sesiones, adapters de target, errores, artefactos | Decidir a qué/cuándo aplicar; tocar `application` | `browser_session`, `automation_run` | core, Playwright |
| `observability` | Pino, redacción, métricas, correlationId | Dominio | `audit_log` (co-custodia) | core, pino |
| `shared` | Utilidades puras, config Zod | Estado | — | zod |
| `apps/api` | HTTP, auth, validación, consultas, encolado | Ejecutar trabajos | — | todos (composición) |
| `apps/worker` | Consumir colas, orquestar casos de uso | HTTP de negocio | — | todos (composición) |

## 5. Flujo completo de datos

```
[1] Scheduler dispara SearchConfig → crear SearchRun + SearchSourceRun por fuente
      │
[2] Search (fan-out por fuente): JobSourceAdapter.searchJobs  [rate-limited, timeout]
      │        errores aislados por hijo; el finalizador deriva completed|partial|failed
      ▼
[3] Ingest: normalizeJob(raw) → Zod NormalizedJob → inválido a cuarentena
      │        detección de ApplicationTarget (redirect/host/metadata) en listing
      ▼
[4] Dedup determinista L0–L3 (+ L3-bis a revisión) → Job canónico
      │        resolución del target primario del Job (job.target_resolved)
      ▼
[5] Filtro de elegibilidad (policy) → job.filtered | job.rejected (con razones)
      ▼
[6] Matching → señales deterministas + semánticas (EmbeddingSpace activo)
      │        persistir JobMatch con identidad completa (isCurrent) → job.matched
      ▼
[7] Shortlist → Application (DISCOVERED→FILTERED→SHORTLISTED; cuotas)
      ▼
[8] PREPARING (worker `apply`):
      │        docs + claims → inspectApplication(target) → mapeo de campos
      │        (determinista → Jev con umbral) → respuestas (banco→Jev routing→LLM validado)
      │        → prepareApplication() rellena SIN enviar → screenshots → snapshot inmutable
      ▼
[9] READY_FOR_REVIEW → aprobación humana (ASSISTED) o guardas AUTO → APPROVED
      ▼
[10] SUBMITTING: lock + ledger.claim (sólo submit real) + preflight/reconcile
      │        DRY_RUN → registra automation_run(dry_run=true), sin efecto externo
      │        real → submit → confirmed | uncertain | rejected_validation | failed
      ▼
[11] Reconciliación y seguimiento: uncertain → REQUIRES_HUMAN_ACTION (nunca 2.º submit ciego)
      │        SUBMITTED → REJECTED | INTERVIEW | OFFER
      ▼
[12] Observabilidad: contadores por etapa, fallo por fuente/target, duración,
      costo IA, decisiones y calibración (decision_log), auditoría.
```

Eventos canónicos: ver doc 05 §4.

## 6. Modos de operación y jerarquía de seguridad

| Modo | Comportamiento | Requisitos |
|---|---|---|
| `MANUAL` | Sólo recomienda y ordena ofertas | — |
| `ASSISTED` | Prepara todo (incluido formulario rellenado) y exige aprobación humana | Snapshot + revisión |
| `AUTO` | Envía sin intervención | `canRealSubmit` completo (doc 05 §6): ENV + settings + policy + target allowlist + guards |
| `DRY_RUN` (ortogonal) | Ejecuta todo salvo el submit real; dry-run auditado | Default en dev y tests |

Precedencia única (ENV es techo inmutable): **ENV > runtime settings > app_policy > target > guards**. Ninguna configuración en DB puede relajar ENV. `AUTO_APPLY_ENABLED=false` y `DRY_RUN=true` por defecto.

## 7. Decisiones arquitectónicas clave (resumen; detalle en doc 13)

| Decisión | Elección | Alternativa descartada (motivo) |
|---|---|---|
| Discovery vs target | `job_source` (descubrir) y `application_target` (aplicar) separados; `Job` resuelve target primario | `source_id` único (mezclaba agregador con destino real) |
| Modelo de ofertas | `job_listing` + `job` canónico | Tabla única (dificulta provenance) |
| Unicidad de candidatura | Partial unique `(candidate_id, job_id)` activo + reaplicación con `supersedes` | `(candidate, job, source)` (permitía duplicados entre fuentes) |
| Identidad de match | `identity_hash` (motor+pesos+hashes+espacio) + `isCurrent` | Unique con engine/weights (colisionaba al cambiar oferta/perfil/CV) |
| Envío | `SubmissionPort` de dominio; Playwright encapsulado; ledger sin DRY_RUN; reconciliación obligatoria | `BrowserPort` con tipos de Playwright (fuga de infraestructura) |
| IA | Puertos en core (`TextGenerationPort`, `EmbeddingProvider`, `DecisionProvider`); Jev decide entre opciones, LLM redacta | Depender de `packages/ai` desde dominio; LLM puntuando |
| Factualidad | Claims + provenance con validación estructural (cuantitativas computables) | Sólo verificación de entidades (insuficiente) |
| Colas | Por dominio + rate limit por fuente/target; browser worker con rol DB limitado y resultados vía BullMQ | Cola única; browser worker escribiendo `application` |
| Scheduler | `SearchRun` + `SearchSourceRun` con finalizador idempotente | JSONB per_source con updates concurrentes |
| Outbox | MVP: post-commit + reconciliador; revisar en Fase 7 | Outbox desde día 1 |