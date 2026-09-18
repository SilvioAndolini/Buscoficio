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

## Fase 3 — Matching

**Objetivo:** ranking explicable, versionado y reproducible con espacios de embeddings.

Entregables:
- Motor determinista completo + pesos configurables.
- `EmbeddingSpace` + embeddings de ofertas/CVs con caché por `content_hash` (pgvector).
- `semanticSimilarity` + `careerRelevance` (Jev opcional para clasificación con confianza).
- `JobMatch` con identidad completa (`jobContentHash`, `candidateProfileHash`, `resumeSetHash`, `engineVersion`, `weightsVersion`, `embeddingSpaceId`) e `isCurrent`.
- UI de ranking con explicación.

Criterios de aceptación:
- [ ] Recomputar el mismo input **no** crea fila nueva (idempotencia por `identity_hash`).
- [ ] Cambiar la descripción de la oferta o un CV genera identidad nueva y nuevo match vigente, preservando histórico.
- [ ] Existe a lo sumo un `isCurrent` por (job, candidato) (test de constraint).
- [ ] Requisito duro incumplido topea el score y aparece en `missingRequirements`.
- [ ] Cambiar de espacio de embeddings no rompe datos previos (coexistencia probada).
- [ ] Re-ejecutar no re-embebe contenido sin cambios (caché).

## Fase 4 — Application Preparation

**Objetivo:** candidaturas completas y verificadas esperando revisión (MANUAL/ASSISTED documental).

Entregables:
- State machine completa + `ApplicationEvent` en cada transición.
- Creación desde match con partial unique `(candidate_id, job_id)` activo; reaplicación con `supersedes`.
- Selección de CV + variante + cover letter + respuestas con **claims validados** (provenance y validación estructural de años, fechas, cargos, certificaciones, idiomas, salarios).
- Banco de respuestas aprobadas; `requiresHumanInput` bloqueante para AUTO.
- UI de revisión de documentos y claims.

Criterios de aceptación:
- [ ] Imposible crear dos candidaturas activas al mismo Job canónico (test de constraint).
- [ ] Reaplicar tras `REJECTED` exige `supersedes` + confirmación + cooldown.
- [ ] Claim cuantitativo no computable desde el perfil es rechazado (p. ej. “5 años con React” sin `candidate_skill.years`).
- [ ] Claim categórico sin entidad de respaldo es rechazado.
- [ ] Documentos versionados; CV original intacto (hash).
- [ ] Timeline visible con eventos y procedencia de cada respuesta.

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