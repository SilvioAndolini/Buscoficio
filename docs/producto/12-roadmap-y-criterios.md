# 12 — Roadmap de implementación y criterios de aceptación

> Principio rector: cada fase entrega valor verificable y no adelanta infraestructura de fases futuras.
> Revisión Fase 0.1 alineada con: discovery/target, SearchSourceRun, identidad de JobMatch, claims, SubmissionPort, Jev, jerarquía DRY_RUN/AUTO, aislamiento del browser worker.

## Fase 0 — Arquitectura

**Estado: cerrada con Fase 0.1 (saneamiento).**

Entregables: documentación completa, modelo de dominio/datos, interfaces, threat model, ADRs (001–021), análisis de contradicciones/overengineering.

Criterios de aceptación:
- [x] Documentos revisados por el dueño del producto (Jev confirmado como TypeSafe AI).
- [x] Decisiones abiertas P1 resuelta; P2–P6 con responsable y fecha límite.
- [x] Revisión cruzada sin contradicciones conocidas (informe Fase 0.1).
- [x] Interfaces de `core` estables para iniciar Fase 1.

## Fase 1 — Foundation

**Objetivo:** esqueleto ejecutable end-to-end con datos ficticios.

Entregables:
- Monorepo pnpm + Turborepo, TS strict, lint de boundaries, CI verde.
- Docker Compose (api, worker, postgres, redis).
- Schema Drizzle inicial + migraciones + repositorios base (incluidas tablas `application_target`, `search_source_run`, `embedding_space`, `decision_log` vacías).
- API Fastify con `/healthz`, `/readyz`, auth de sesión simple.
- Worker con cola `maintenance` + logger con correlationId.
- CRUD de perfil y CVs versionados.
- `MockJobSourceAdapter` + normalización + persistencia de listings/jobs + dedup L0–L2 + detección mock de `ApplicationTarget`.
- UI mínima: perfil, CVs, lista de ofertas.

Criterios de aceptación:
- [ ] `pnpm turbo lint typecheck test build` en verde desde máquina limpia.
- [ ] Subir un CV crea `resume_version` inmutable; el original nunca se modifica.
- [ ] Repetir la ingesta no duplica (L0–L2 probado); oferta malformada va a cuarentena.
- [ ] El mock resuelve un `application_target` y lo persiste en el listing y el Job.
- [ ] Todo log de un job incluye `correlationId` y `jobId`.
- [ ] E2E: perfil → CV → mock search → ofertas con target visible en UI.
- [ ] Los IDs de jobs BullMQ cumplen el formato sin `:` (test).

## Fase 2 — Job Discovery

**Objetivo:** fuentes reales, targets resueltos y búsquedas programadas.

Entregables:
- 2–3 adapters de descubrimiento reales (APIs oficiales/RSS preferentemente) con contract tests.
- Registro `application_target` + resolución (redirect/host/metadata) y revisión ToS por target.
- `SearchRun` + `SearchSourceRun` + scheduler + finalizador idempotente.
- Dedup L3 + cola `dedup-review` para zona gris.
- Filtros duros de política + rate limiting por fuente + métricas de fallos por fuente.

Criterios de aceptación:
- [x] Búsqueda programada con fan-out: un fallo de fuente produce `partial`, nunca pérdida del resto. *(verificado 2026-09-18: worker test de fan-out 3 fuentes)*
- [x] `SearchRun` deriva su estado de los hijos; contadores correctos (test de concurrencia). *(finalizador idempotente + test concurrente)*
- [x] Oferta descubierta en agregador con destino Greenhouse queda con `application_target_id` del ATS. *(E2E con fixture server: metadata y redirect enrichment)*
- [x] Duplicados entre fuentes se agrupan en un Job canónico con un único target primario. *(promoción determinista + conflicto registrado; test concurrente)*
- [x] Zona gris de dedup va a revisión sin merge automático. *(tests secuencial y concurrente: 2 jobs + 1 review pending)*
- [x] Revisión de ToS registrada por cada target activo. *(policy_notes por fuente y por target; targets auto-detectados `blocked` con revisión pendiente)*

**Fase 2.1 — saneamiento verificado (2026-09-18):** SearchConfig respetado por todas las fuentes
(matcher determinista + server-side donde existe), L3 concurrent-safe (advisory lock company+location),
targets auto-detectados bloqueados con nota de revisión pendiente y activación auditada, redirect
enrichment conectado con presupuesto/rate-limit, taxonomía 401/403→`SourceAuthError`, logger contextual
en servicios de Fase 2, wording ToS corregido. Evidencia: 158 tests de integración + 2 E2E Playwright +
CI `ci`/`e2e` en verde.

**Fase 2.2 — bloqueadores finales verificados (2026-09-18):** targets legacy no revisados bloqueados
por migración `0005` (revisados intactos; test de upgrade incremental 0000–0003 → 0004–0005),
activación de targets condicionada a `policyReview` explícita (revisión persistida con `reviewed_at`
del servidor y `reviewed_by`, audit `application_target.policy_reviewed`; sin revisión → `422
POLICY_DENIED`). Evidencia: 160 tests de integración + 2 E2E Playwright + CI `ci`/`e2e` en verde.

**Fase 2.3 — edge case legacy final verificado (2026-09-18):** migración `0006` bloquea el estado
`active` + nota “pending separate platform policy review” sin `reviewed_at/reviewed_by`; las reviews
estructuradas permanecen `active` y la evidencia textual legacy se conserva intacta (conservador).
Test de upgrade en 3 etapas (0000–0003 → 0004–0005 → 0006) con 6 casos + idempotencia, en CI.
Evidencia: 161 tests de integración + 2 E2E Playwright + CI `ci`/`e2e` en verde.

## Fase 3 — Matching

**Objetivo:** ranking explicable, versionado y reproducible con espacios de embeddings.

Entregables:
- Motor determinista completo + pesos configurables.
- `EmbeddingSpace` + embeddings de ofertas/CVs con caché por `content_hash` (pgvector).
- `semanticSimilarity` + `careerRelevance` (Jev opcional para clasificación con confianza).
- `JobMatch` con identidad completa (`jobContentHash`, `candidateProfileHash`, `resumeSetHash`, `engineVersion`, `weightsVersion`, `embeddingSpaceId`) e `isCurrent`.
- UI de ranking con explicación.

Criterios de aceptación:
- [x] Recomputar el mismo input **no** crea fila nueva (idempotencia por `identity_hash`). *(test de servicio + constraint UNIQUE)*
- [x] Cambiar la descripción de la oferta o un CV genera identidad nueva y nuevo match vigente, preservando histórico. *(tests de job/perfil/CV/pesos/espacio)*
- [x] Existe a lo sumo un `isCurrent` por (job, candidato) (test de constraint). *(partial unique probado con SQL directo + concurrencia)*
- [x] Requisito duro incumplido topea el score y aparece en `missingRequirements`. *(cap 0.49 + test de idioma C1 vs B2)*
- [x] Cambiar de espacio de embeddings no rompe datos previos (coexistencia probada). *(Space A/B + vectores coexistentes)*
- [x] Re-ejecutar no re-embebe contenido sin cambios (caché). *(contador del MockEmbeddingProvider sin cambios; `ai_usage` sólo en llamadas reales)*

**Fase 3 — Matching implementada y verificada (2026-09-18):** motor determinista versionado
(`matching-v1`/`v1`) con 8 señales (ausentes fuera del denominador), requisitos duros con cap,
explicabilidad persistida (breakdown Zod + reasons + missingRequirements + matchingSkills),
selección determinista de CV, `EmbeddingProvider` (mock determinista + adapter OpenAI-compatible
en `packages/ai`), pgvector real (`job_embedding`/`resume_embedding` vector(1536) + HNSW cosine),
caché por `contentHash`, `EmbeddingSpace` único activo con coexistencia, `job_match` con
`UNIQUE(job_id,candidate_id,identity_hash)` + partial unique `is_current` + índice de ranking,
cola `match` desacoplada del discovery y UI `/matches` con breakdown expandible.
Evidencia: unit matching+ai, integración Postgres/pgvector (idempotencia, caché, espacios,
concurrencia, ranking), E2E API (ranking + recompute v1→v2) y Playwright 3/3.

**Fase 3.1 — saneamiento (2026-09-18):** (1) binding estricto `EmbeddingSpace.provider/model/
dimensions` ↔ provider real con fail-closed antes de `embed()`/escrituras y activación de espacios
incompatibles rechazada con `409`; (2) ancla temporal `matchingAsOfDate` desde `Clock`
(migración `0008`, columna nullable) con empleos abiertos correctamente computados y sin churn
diario en carreras cerradas; (3) identidad ampliada: aliases en `candidateProfileHash` y
`highlights` en `resumeSetHash` (todo input material cubierto); (4) `EMBEDDING_PROVIDER`
independiente de `AI_PROVIDER` (`deepseek`/`anthropic` como embeddings ⇒ `ConfigError`, sin
endpoints inventados); (5) `engineVersion` `matching-v1 → matching-v2` conservando el histórico;
(6) invalidación de embeddings legacy en `0008` (dato derivado regenerable; Jobs/CVs/JobMatch
intactos).

## Fase 4 — Application Preparation

**Objetivo:** candidaturas completas y verificadas esperando revisión (MANUAL/ASSISTED documental).

Entregables:
- State machine completa + `ApplicationEvent` en cada transición.
- Creación desde match con partial unique `(candidate_id, job_id)` activo; reaplicación con `supersedes`.
- Selección de CV + variante + cover letter + respuestas con **claims validados** (provenance y validación estructural de años, fechas, cargos, certificaciones, idiomas, salarios).
- Banco de respuestas aprobadas; `requiresHumanInput` bloqueante para AUTO.
- UI de revisión de documentos y claims.

Criterios de aceptación:
- [x] Imposible crear dos candidaturas activas al mismo Job canónico (test de constraint). *(partial unique probado con SQL directo)*
- [x] Reaplicar tras `REJECTED` exige `supersedes` + confirmación + cooldown. *(unit engine + integración)*
- [x] Claim cuantitativo no computable desde el perfil es rechazado (p. ej. “5 años con React” sin `candidate_skill.years`). *(fixtures del validador)*
- [x] Claim categórico sin entidad de respaldo es rechazado. *(certification/project ⇒ rejected; company/degree/title inventados)*
- [x] Documentos versionados; CV original intacto (hash). *(test de hash original + variante nueva `kind=tailored`)*
- [x] Timeline visible con eventos y procedencia de cada respuesta. *(UI detalle + sourceRefs visibles)*

**Fase 4 — Application Preparation implementada y verificada (2026-09-18):** agregado `application`
(`idempotency_key` UNIQUE + partial unique activa A1 + FK RESTRICT), `application_answer`
(UNIQUE por `question_hash`), `application_document` (append-only por `(application_id, kind,
content_hash)` + índice `generated_by->>'inputHash'`), `application_event` append-only con
transición atómica (compare-and-set) y migración `0009`. State machine completa en
`packages/application-engine` (Phase 4 sólo ejecuta DISCOVERED→…→PREPARING/REQUIRES_HUMAN_ACTION/
ARCHIVED; `PREPARING→READY_FOR_REVIEW` denegada sin snapshot, `preparationSnapshot` siempre NULL).
`packages/documents` implementa `ProfileFactsView` sin PII, hashing canónico de preguntas, validador
determinista de claims por kind (sourceRefs autoritativos), variante de CV determinista, cover
letter vía `TextGenerationPort` con **una** reparación factual y degradación a plantilla, y banco
de respuestas con revalidación (stale ⇒ no reutilizar). `packages/ai` añade
`TextGenerationPort` (mock scripted + OpenAI-compatible + Anthropic), prompts versionados con
contenido externo delimitado y `MockDecisionProvider` (Jev queda para Fase 5). Cola `documents`
(`prepare-<applicationId>`, lock advisory por aplicación, idempotencia por inputHash), API
`/v1/applications` (create idempotente, prepare 202, answers + resolve, resolve-human, archive; sin
submit/reconcile) y UI `/applications` + detalle con claims/provenance/timeline. `AI_PROVIDER`
independiente de `EMBEDDING_PROVIDER`; `APPLICATION_PREPARATION_POLICY_VERSION` +
`REAPPLICATION_COOLDOWN_DAYS` (default 30) forman la política versionada. Evidencia: unit
engine/documents/ai, integración Postgres (constraints, concurrencia, lock, respuestas), worker
(match→application→prepare, CV original intacto, reparación ok/fallida, concurrencia), E2E API
(create/prepare/answers/archive, `mode=auto` 422, submit 404) y Playwright 4/4.

**Fase 4.1 — saneamiento verificado (2026-09-18):** (1) **claim completeness**: la cover letter
pasa a generación estructurada (plan de claims) + **renderer determinista** — no existe texto
libre, así que un hecho factual no puede entrar en el documento sin una claim validada
(`cover-letter/v2`; `{text, claims:[]}` inventado, claim AWS oculta y prompt injection ⇒ nunca
verificado, `REQUIRES_HUMAN_ACTION`); (2) **`unverifiable` fail-closed**: sólo `verified` permite
reuse/aprobación, en respuestas (`PUT`), banco (`resolveAnswer`) y documentos (blocker siempre);
(3) **ancla temporal** `preparationAsOfDate` (Clock) dentro de `preparationInputHash` y en
`generatedBy.asOfDate` (carreras cerradas sin churn); (4) **CV exacto**: sin fallback a la última
versión, `recommendedResumeId` sin versión ⇒ `ConflictError`, se elimina
`recommendedResumeLatestVersionId`; (5) **blockers idempotentes**:
`derivePreparationBlockers` puro compartido por engine y API, cache-hit conserva blockers;
(6) **defaults JSONB** de arrays corregidos con migración `0010_json_array_defaults.sql`
(normalización idempotente de `{}` legacy). Evidencia: unit documents/engine/ai, integración
Postgres (0010 + histórico), worker (temporal, CV exacto, banco no verificado, replay de
blockers), E2E API (respuesta no verificada bloqueada) y Playwright.

**Fase 4.2 — respuestas claimless saneadas (2026-09-19):** última vía factual cerrada:
`validateClaims([])` (verified vacío) ya no aplica a texto libre. `validateAnswerContent` en
`packages/documents` (expuesta en `DocumentsPort`, consumida por API y banco de respuestas) marca
toda respuesta con `claims.length === 0` como `unverifiable` + `requiresHumanInput` +
`automaticReuseAllowed=false` (con `VerificationResult.reason` opcional), sin heurísticas ni LLM.
La API nunca la aprueba aunque el cliente envíe `approved=true`; `resolveAnswer` nunca la reutiliza
(incluidas filas legacy `approved=true`/`verified`, que además sanea la migración forward-only
`0011_claimless_answer_sanitation.sql` sin tocar respuestas con claims). La UI muestra
`Needs review` + razón. Decisión deliberadamente conservadora: Fase 5 introducirá
`QuestionDescriptor`/`semanticType` para permitir claimless sólo en categorías no factuales
tipadas. Evidencia: unit documents (AWS inventado, benigno, claim válida, claim inválida), engine
(blocker explícito), integración Postgres (0010→0011 + histórico), worker (banco legacy claimless),
E2E API (PUT claimless bloqueada + resolve sin reuse) y Playwright.

## Fase 5 — Browser Automation

**Objetivo:** preparación completa y envío simulado (`DRY_RUN`) sobre fake-ATS y 1–2 targets permitidos.

Entregables:
- `SubmissionPort` implementado en `packages/browser-automation` (sin tipos de Playwright en dominio).
- `inspectApplication` → mapeo → `prepareApplication` (rellenado sin envío) → snapshot → `READY_FOR_REVIEW`.
- Login asistido con `storageState` cifrado; `browser_session` ligada al target.
- `DryRunGuard` + ledger sin DRY_RUN + screenshots/trace por fase.
- Browser worker con rol DB limitado y resultados vía BullMQ (`apply-results`).
- Piloto Jev (mapeo de campos, selección de acción, guardrail) en DRY_RUN con `decision_log` y comparación vs. baseline.

Criterios de aceptación:
- [ ] `READY_FOR_REVIEW` sólo con snapshot completo y sin campos sin resolver (test).
- [ ] Cambio del formulario entre aprobación y submit aborta el envío (fake-ATS).
- [ ] E2E con DRY_RUN=true: candidatura preparada y **cero** submits reales; ledger intacto.
- [ ] CAPTCHA simulado → `REQUIRES_HUMAN_ACTION` sin resolución.
- [ ] El dominio no importa tipos de Playwright (lint).
- [ ] El browser worker no puede escribir `application` (test de permisos).
- [ ] Decisiones Jev bajo umbral → revisión/handoff, nunca acción automática.
- [ ] Métricas de calibración Jev documentadas (confianza vs acierto).

## Fase 6 — Controlled Auto Apply

**Objetivo:** envío desatendido sólo donde es seguro y permitido.

Entregables:
- Policy engine completo + UI de políticas versionadas (global y por candidato).
- Jerarquía `canRealSubmit` implementada y auditada con la cadena evaluada.
- Ledger real + reconciliación obligatoria; `uncertain` inhabilita reintentos.
- Cuotas: global/día, por target, por cuenta; métricas de bloqueo.
- Activación: `AUTO_APPLY_ENABLED=true` (ENV) + `autoSubmitTargets` por política.

Criterios de aceptación:
- [ ] Cualquier guarda incumplida ⇒ AUTO no envía (tests por guarda y combinaciones).
- [ ] `settings`/`policy` no pueden habilitar submit con ENV en contra (test de jerarquía).
- [ ] `uncertain` nunca produce segundo submit sin reconciliación (test).
- [ ] Reconciliación detecta “ya enviada” y no reenvía.
- [ ] Cada decisión AUTO persiste `PolicyDecision` con reglas aplicadas.
- [ ] Primer target AUTO con revisión de ToS firmada.

## Fase 7 — Production Hardening

**Objetivo:** operación estable, observable y segura.

Entregables:
- Métricas completas (incluidas `submit_uncertain_total`, `decision_low_confidence_total`) + alertas.
- Secret manager real + rotación; backups + restauración probada.
- Retención/PII automatizada; export/borrado.
- Presupuesto IA con corte; reporte de costo por decisión Jev.
- Despliegue contenedores (Railway/Render/Fly.io/AWS/GCP) sin cambios de código; runbooks (DLQ, credenciales, fuente/target roto, uncertain).

Criterios de aceptación:
- [ ] Restauración de backup verificada en entorno limpio.
- [ ] Roles DB de browser worker verificados en producción (mínimo privilegio).
- [ ] Alerta efectiva: fuente/target > 50 % fallos, DLQ no vacía, uncertain > 24 h.
- [ ] Corte de presupuesto probado; calibración Jev revisada con datos reales.
- [ ] Despliegue reproducible documentado; cero secretos en repo.

## Resumen de dependencias

```
F0 ─► F1 ─► F2 ─► F3 ─► F4 ─► F5 ─► F6 ► F7
                      └─────┘
     (F3 puede solaparse con F2 con ofertas mock; F5 exige F4; F6 exige F5 + ToS)
```

| Fase | Riesgo dominante | Mitigación de salida |
|---|---|---|
| F1 | Deuda estructural temprana | Lint de boundaries + CI desde el primer commit |
| F2 | Fragilidad/legalidad de fuentes y targets | APIs oficiales primero; ToS por target |
| F3 | Sobreajuste de pesos / costos / deriva de embeddings | Explicabilidad + caché + EmbeddingSpace |
| F4 | Alucinaciones y claims no probados | Validación de claims + revisión humana |
| F5 | Fragilidad de selectores; madurez de Jev | Fixtures + screenshots + handoff + DecisionProvider con fallback |
| F6 | Envíos duplicados/indeseados | Ledger + reconciliación + jerarquía ENV + guardas |
| F7 | Fuga de PII / costos | Secret manager + retención + presupuesto |