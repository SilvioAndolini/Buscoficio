# Fase 4 — Application Preparation (plan de implementación)

> Fuente de verdad: `docs/arquitectura/03` (§2, §4, §5, §8, §9), `04` (§2.6), `05` (§2.2,
> §3, §5, §7), `06` (§1, §3, §4), `08` (§5–§7), `09` (§4–§5, §7), `10` (§2), `12` (Fase 4).
> Este plan no rediseña; aterriza. Frontera dura: la candidatura queda **PREPARING** con
> `preparationSnapshot = NULL`; `READY_FOR_REVIEW` exige `SubmissionPort` (Fase 5).

## 1. Alcance

Transformar un `JobMatch` en una candidatura **documental, versionada, verificable y
auditable**: CV exacto del match → variante de CV → cover letter → respuestas conocidas →
claims con provenance → validación factual determinista → eventos atómicos.

Dentro: state machine completa (los estados futuros existen, no se ejecutan), creación
idempotente desde match, reaplicación con `supersedes` + confirmación + cooldown, repos y
constraints, banco de respuestas, AI ports (`TextGenerationPort`, `DecisionProvider`) con
mock y providers reales, cola `documents`, API y UI de revisión documental.

Fuera (Fase 5/6): `SubmissionPort`, browser automation, Playwright, inspect/prepare de
formularios reales, submit/reconcile/ledger, `READY_FOR_REVIEW` operativo, `APPROVED`,
AUTO APPLY, cuotas, `canRealSubmit`, Jev browser.

## 2. State machine

```
DISCOVERED ─► FILTERED ─► SHORTLISTED ─► PREPARING ─► READY_FOR_REVIEW ─► APPROVED
    │            │            │             │  ▲             │                │
    └────────────┴────────────┴─────────────┴──┴─────────────┴────────────────┴─► ARCHIVED
                                              │
APPROVED ─► SUBMITTING ─► SUBMITTED ► (REJECTED | INTERVIEW | OFFER)
                 │  ▲
                 │  └── (corrección recuperable: vuelve a PREPARING)
                 ├─► FAILED ─► (PREPARING si retry permitido | ARCHIVED)
                 └─► REQUIRES_HUMAN_ACTION ─► (PREPARING | APPROVED tras resolución humana)
PREPARING ─► REQUIRES_HUMAN_ACTION
```

Transiciones y guardas (`canTransition(from, to, context)` pura en `application-engine`):

| Transición | Actor | Guarda | Fase 4 |
|---|---|---|---|
| DISCOVERED→FILTERED | system | — | ejecutable (bootstrap) |
| FILTERED→SHORTLISTED | system | — | ejecutable (bootstrap) |
| SHORTLISTED→PREPARING | system | modo `manual`\|`assisted` (AUTO no en F4) | ejecutable |
| PREPARING→REQUIRES_HUMAN_ACTION | system | `reason` no vacío | ejecutable |
| PREPARING→READY_FOR_REVIEW | system | `preparationSnapshotComplete === true` | **denegada** (sin SubmissionPort) |
| READY_FOR_REVIEW→APPROVED | user/system | actor user (system exige guardas AUTO futuras) | denegada |
| REQUIRES_HUMAN_ACTION→PREPARING | user | `reason` no vacío | ejecutable |
| REQUIRES_HUMAN_ACTION→APPROVED | user | `preparationSnapshotComplete === true` | **denegada** |
| DISCOVERED/FILTERED/SHORTLISTED/PREPARING/READY_FOR_REVIEW/APPROVED/SUBMITTING/SUBMITTED/FAILED/REQUIRES_HUMAN_ACTION/INTERVIEW/OFFER/REJECTED→ARCHIVED | user (system sólo DISCOVERED/FILTERED) | — | ejecutable |
| APPROVED→SUBMITTING | system | `submissionAuthorized === true` (ledger+preflight F5) | denegada |
| SUBMITTING→PREPARING/SUBMITTED/FAILED/REQUIRES_HUMAN_ACTION | system | futuras | denegada |
| SUBMITTED→REJECTED/INTERVIEW/OFFER | user | futuras | denegada |
| FAILED→PREPARING | system | `retryAllowed === true` | denegada |

`transition()` / `assertTransition()` lanzan `ConflictError` tipado si la guarda falla.
Nunca existe una ruta a `APPROVED` sin `READY_FOR_REVIEW` (A5).

## 3. Esquema (migración `0009_application_preparation.sql`)

Forward-only; no toca `0000–0008`.

- **`application`** (doc 04 §2.6): `id` · `job_id` FK RESTRICT · `candidate_id` FK RESTRICT ·
  `application_target_id` FK RESTRICT nullable · `discovery_source_id` FK RESTRICT nullable ·
  `match_id` FK RESTRICT · `mode` · `status` · `resume_version_id` FK RESTRICT nullable ·
  `idempotency_key` UNIQUE · `policy_version` · `score_at_creation` numeric(5,4) ·
  `preparation_snapshot` JSONB nullable · `supersedes_application_id` FK self RESTRICT nullable ·
  `submitted_at` · `last_transition_at` · `requires_human_reason` · `created_at` · `updated_at`.
  - **Partial unique `(candidate_id, job_id) WHERE status NOT IN ('ARCHIVED','REJECTED')`**
    (defensa definitiva A1, probada con SQL directo).
  - Índices `(status, last_transition_at)`, `(job_id)`, `(application_target_id)`.
- **`application_answer`** (doc 04 §2.6): columnas del doc + `UNIQUE(application_id,
  question_hash)`. `claims`/`verification`/`source_refs` JSONB validados por Zod.
- **`application_document`**: columnas del doc + `UNIQUE(application_id, kind, content_hash)`;
  append-only (regenerar = fila nueva).
- **`application_event`**: append-only (`id` UUIDv7, `type`, `from_status`, `to_status`,
  `actor`, `payload`, `correlation_id`, `occurred_at`); índice `(application_id, occurred_at)`.
  Sin métodos `updateEvent`/`deleteEvent`.
- **FKs nuevas**: `ai_usage.application_id → application(id) ON DELETE SET NULL`;
  `decision_log.application_id → application(id) ON DELETE SET NULL` (sin datos retroactivos).
- **Sin** `application_submission_ledger` (Fases 5/6).
- Migración probada fresh (0000→0009) y upgrade (0008→0009) sin pérdida de Jobs, JobMatch,
  embeddings, CVs ni targets.

## 4. Repositorios (`packages/database`)

`createApplicationRepo(db, pool)` — persistencia sin reglas de negocio:

`createWithBootstrap` (transacción: INSERT + created event + DISCOVERED→FILTERED→SHORTLISTED
con eventos), `findById`, `findActiveByJobCandidate`, `findByIdempotencyKey`, `list`,
`listEvents`, `listAnswers`, `listDocuments`, `findApprovedAnswerByQuestionHash`,
`transitionWithEvent` (compare-and-set `WHERE id AND status = expected`, evento en la misma
tx), `appendEvent`, `upsertAnswer` (ON CONFLICT), `insertDocument` (ON CONFLICT → reuse),
`getResumeVersion`, `findTailoredVersionByParentAndHash`, `withApplicationLock` (advisory
lock de sesión sobre un cliente dedicado; serializa preparaciones concurrentes).

Concurrencia de transiciones: `UPDATE ... WHERE id = X AND status = expected`; si 0 filas →
`ConflictError`. Nunca `UPDATE` + `INSERT event` separados.

## 5. Ownership

| Escritor | Tablas |
|---|---|
| `application-engine` (vía `apps/worker`, API para comandos) | `application`, `application_answer`, `application_document`, `application_event` |
| `documents` (puro) | — (no persiste; devuelve drafts) |
| `database` | custodia y constraints |
| `apps/api` | comandos (create/prepare/answers/resolve/archive) y lectura; nunca ejecuta trabajos |

El browser worker (Fase 5) nunca escribirá `application*`.

## 6. Document pipeline

`packages/documents` (puro, sin DB/IA/red) produce drafts validados:

1. `buildProfileFactsView(aggregate, { includeSalary })` — minimización PII (sin email,
   teléfono, dirección, archivos de CV).
2. `hashQuestion(text)` — lowercase + trim + colapso de whitespace + puntuación trivial →
   sha256.
3. `validateClaims(claims, facts, { asOfDate })` — autoridad determinista por kind.
4. `prepareResumeVariant({ facts, sourceVersion, job, jobSkills, asOfDate })` — plantilla
   canónica Markdown/UTF-8 que sólo reordena/selecciona/resume hechos existentes; sin LLM.
5. `prepareCoverLetter({ facts, job, prompt, textProvider, clock, repairAttempts })` —
   `completeStructured` → validación → **1** reparación → `requiresHumanInput` si persiste.
6. `resolveAnswer({ question, priorApproved, facts, ... })` — banco por `question_hash`;
   revalidación de claims; stale ⇒ no reutilizar.
7. `computePreparationInputHash(...)` — applicationId, matchId, sourceResumeVersionId,
   profile facts hash, job content hash, prompt versions, provider/model.

Flujo `documents.prepare` (worker):

```
SHORTLISTED → PREPARING (evento)
→ cargar JobMatch exacto + ResumeVersion exacta + ProfileFactsView
→ variante de CV determinista → validar claims → persistir ResumeVersion(tailored)
→ persistir ApplicationDocument(resume_variant)
→ cover letter (TextGenerationPort) → validar → reparar (máx 1) → persistir ApplicationDocument
→ revalidar respuestas aprobadas existentes
→ append application.documents_prepared
→ permanecer PREPARING (nunca READY_FOR_REVIEW)
```

Si tras la reparación quedan claims rechazadas: `PREPARING → REQUIRES_HUMAN_ACTION` con
`requiresHumanReason` y evento. Si el provider falla y no hay fallback: idem. La plantilla
determinista de cover letter degrada de forma controlada si la IA no está disponible.

Idempotencia: lock por aplicación + `UNIQUE(application_id, kind, content_hash)` + reuso de
`ResumeVersion` por `(parent_version_id, file_hash)`; mismo input ⇒ mismos documentos y sin
eventos duplicados. Cover letter y variante llevan `generated_by { provider, model,
promptVersion, inputHash }`.

## 7. Factuality pipeline

Vista mínima → generación estructurada → validación determinista por kind → eliminar /
regenerar (máx 1) / `requiresHumanInput` → persistir claims + verification.

| Kind | Regla determinista |
|---|---|
| `years_experience` | con `skill`: exige `candidate_skill.years` y `claim ≤ years` (nunca inferir de experiencias); general: meses computados de rangos sin solape con `asOfDate` inyectado; claim ≤ computado (sin redondear hacia arriba) |
| `date_range` | coincidencia exacta (mes) con `experience`/`education`; abierto ⇒ `asOfDate` |
| `job_title` / `company` | normalización case/whitespace/puntuación trivial contra `experience`; sin matching semántico |
| `degree` | coincide con `education.degree` (+ institución si se declara) |
| `language_level` | `candidate_language`; orden A1<A2<B1<B2<C1<C2<native; nunca elevar |
| `salary` | campos explícitos del perfil; moneda distinta ⇒ `unverifiable`; sin datos ⇒ `unverifiable` |
| `certification` / `project` | sin entidad estructurada ⇒ `rejected` |
| `seniority` | sin fuente explícita ⇒ `unverifiable` |

`VerificationResult { status: verified|unverifiable|rejected, failures[] }`. El tipado del
LLM nunca implica `verified`; el validador reescribe `verified` en cada claim.

## 8. Claims y provenance

`Claim { claim, kind, value?, sourceRefs[], verified }` con `SourceRef { entityType ∈
candidate_profile|candidate_skill|experience|education|candidate_language|resume_version,
entityId, field? }`. Cada claim factual puede responder “¿qué entidad la respalda?”; la UI
muestra la procedencia y los rechazos con razón. Una claim nunca aparece como verificada sin
sourceRefs válidos.

## 9. Answer bank

Sin tabla nueva: `application_answer` históricas con `approved = true` + mismo `candidate_id`
+ mismo `question_hash`. Reutilización sólo tras revalidar claims/sourceRefs contra el perfil
actual; si quedan stale ⇒ `approved=false`, `requiresHumanInput=true`, bloqueo visible.
`answerKind=user` puede aprobarse sin claims; con claims factual-sensitive se valida igual.
`answerKind=generated` nace `approved=false` (nunca autoaprobado por venir de un modelo).

## 10. AI ports (`core`) e implementaciones (`ai`)

- `TextGenerationPort`: `complete()` + `completeStructured<T>()` con `provider`, `model`,
  `promptVersion`, `inputHash`, `trace`, `schema` Zod obligatorio en structured.
- `DecisionProvider`: contrato del doc 05 §2.2 + `MockDecisionProvider` (infra lista; Fase 4
  no depende de Jev real).
- Prompts versionados en `packages/ai/prompts/`: `cover-letter/v1`, `resume-variant/v1`,
  `answer/v1`. La job description viaja delimitada como
  `<untrusted_job_description>…</untrusted_job_description>`; el contenido externo nunca
  selecciona tools ni modifica configuración/estado.
- Providers reales: OpenAI-compatible (openai/deepseek, endpoints documentados) y Anthropic
  Messages; `fetch` inyectable, timeout, taxonomía de errores, contract tests con HTTP falso,
  claves sólo por config; proveedor no implementado ⇒ `ConfigError`/`AiError` al arrancar.
- `MockTextGenerationProvider` simula salida válida, schema inválido, claim inventada,
  timeout/error y reparación válida/fallida. CI nunca depende de internet.
- `ai_usage`: `cover_letter`, `answer`, `resume_variant` (determinista ⇒ sólo `other` si
  aplica) con `applicationId`, latencia, tokens/coste **sólo si se conocen**.

## 11. Queue topology

Cola `documents` (doc 06 §1): job `documents.prepare`, id `prepare-<applicationId>` (sin `:`),
`attempts 3`, backoff exponencial, `removeOnComplete: true`. La idempotencia funcional vive
en Postgres (lock + constraints); BullMQ sólo deduplica en vuelo. Retries técnicos
(timeout/5xx/429) limitados; la reparación factual es independiente (máx 1).

## 12. API (`/v1`)

- `POST /v1/applications` `{ matchId, mode: manual|assisted, supersedesApplicationId?,
  confirmReapply? }` → 201 (creada) / 200 (idempotente). `mode=auto` ⇒ `PolicyDeniedError`.
- `GET /v1/applications` (lista con job) y `GET /v1/applications/:id` (application, job,
  match ref + scoreAtCreation, ResumeVersion seleccionada, documentos, respuestas, timeline,
  blockers, target si se conoce).
- `POST /v1/applications/:id/prepare` → 202 + jobId (nunca genera en el request).
- `GET/PUT /v1/applications/:id/answers` (Zod; validación de claims).
- `POST /v1/applications/:id/resolve-human` `{ reason }` → REQUIRES_HUMAN_ACTION→PREPARING
  (actor user + audit).
- `POST /v1/applications/:id/archive` → ARCHIVED + audit.
- **No** `submit`, **no** `reconcile`, **no** stubs de éxito falso.

## 13. UI

- `/matches`: acción “Preparar candidatura” con modo Manual/Assisted (nunca Auto).
- `/applications`: job, empresa, estado, modo, `scoreAtCreation`, CV, target, blockers, fecha.
- `/applications/[id]`: estado, timeline, match origen, score congelado, CV fuente, variante,
  cover letter, respuestas, claims, verificación, sourceRefs, `requiresHumanInput`.
- Indicador: “Documentos listos · Formulario pendiente de inspección” en PREPARING; nunca
  “Listo para enviar” ni `READY_FOR_REVIEW`.

## 14. Idempotencia

- `application.idempotency_key = sha256(canonicalJson({ candidateId, jobId, matchId, mode,
  supersedesApplicationId ?? 'none' }))` UNIQUE.
- Partial unique activa `(candidate_id, job_id)` como defensa definitiva (test SQL directo).
- Documentos: `(application_id, kind, content_hash)` + reuso de variante por
  `(parent_version_id, file_hash)` + lock por aplicación.
- Eventos: una transición ⇒ un evento, en la misma transacción.

## 15. Reaplicación

`REJECTED → nueva Application` sólo con: `supersedesApplicationId` válido (existe, REJECTED,
mismo candidato, mismo Job canónico), `confirmReapply = true`, y cooldown satisfecho
(`REAPPLICATION_COOLDOWN_DAYS`, default 30, parte de `policyVersion`). Sin cadenas
incoherentes.

## 16. Seguridad

- PII mínima en prompts (`ProfileFactsView`); sin email/teléfono/dirección/CV completo.
- Job description = contenido no confiable delimitado; test de prompt injection.
- Storage keys sin PII: `applications/<applicationId>/resume/<hash>.md` y
  `applications/<applicationId>/cover-letter/<hash>.md`.
- Logs: `applicationId`, `jobId`, `correlationId`, `provider`, `model`, `promptVersion`,
  `inputHash`, `verificationStatus`; nunca documentos, prompts con PII ni claves.
- `audit_log` para creación, transiciones sensibles, resoluciones humanas y archivo (sin
  contenido documental).
- `DRY_RUN=true`/`AUTO_APPLY_ENABLED=false` intactos; Fase 4 no envía nada.

## 17. Testing

- Unit `application-engine`: cada transición válida/denegada, actores, archive, requires
  human, READY_FOR_REVIEW sin snapshot, APPROVED sin ready, modo auto, idempotency key,
  supersedes/cooldown.
- Unit `documents`: hashes de pregunta, ProfileFactsView sin PII, fixtures de claims del
  doc 03 §8 (5 años React con/sin `candidate_skill.years`, 6 vs 5, empresa exacta/inventada,
  degree existente/inventado, C1 vs B2), prompt injection, reparación 1 intento, banco de
  respuestas reuse/stale, variante determinista sin hechos nuevos.
- Unit `ai`: mock scripted (válido/inválido/inventado/timeout/reparación), contract tests
  OpenAI-compatible/Anthropic con fetch falso, delimitación de contenido no confiable.
- Integración `database`: migraciones fresh/upgrade, constraint activa (SQL directo),
  idempotencia, eventos atómicos, concurrencia de transición, supersedes/cooldown, documentos
  append-only, unique de respuestas.
- Integración `worker`: match→application→prepare con MockProvider, CV original intacto
  (hash), documentos+claims, evento, concurrencia de prepare, reparación ok/fallida →
  REQUIRES_HUMAN_ACTION, answer bank reuse/stale.
- E2E API: create/list/detail/prepare/answers/resolve/archive; `mode=auto` rechazado;
  `POST /submit` inexistente.
- Playwright: `/matches` → Preparar candidatura → `/applications/:id` (estado, docs, claims,
  provenance, timeline, “Formulario pendiente de inspección”).

## 18. Scope exclusions

`SubmissionPort` (implementación), Playwright/browser, `inspectApplication`/
`prepareApplication` reales, screenshots de formularios, mapeo de campos, CAPTCHA/login,
`automation`/`apply-results`, `SUBMITTING` operativo, submit/reconcile/ledger, `uncertain`,
AUTO_APPLY, cuotas, `canRealSubmit`, policy engine completo, UI de políticas, Jev browser
(`map_form_field`, `choose_action`), `READY_FOR_REVIEW` y `APPROVED` operativos,
`preparationSnapshot` no nulo.

## 19. Fase 4.1 — saneamiento (pre-Fase 5)

Correcciones sobre la implementación existente, sin rediseño ni estados nuevos:

### P1 — Claim completeness (crítico)

El contrato anterior `{text, claims[]}` permitía que un proveedor escribiera un hecho inventado
(“I am AWS Certified…”) con `claims=[]` y que `validateClaims([])` lo diera por verificado. La
propiedad exigida ahora es:

```
texto factual ⇒ claim explícita ⇒ validador determinista ⇒ sourceRefs ⇒ verified
```

Arquitectura (structured generation + deterministic rendering):

```
ProfileFactsView
  ↓
LLM devuelve un PLAN estructurado {tone, opening, closing, claims:[{kind,value}]}
  ↓
validateClaims(claims)  (autoridad; sourceRefs las genera el validador)
  ↓
renderer determinista (plantillas de código + una frase por claim validado)
  ↓
texto final (bytes) + contentHash
```

- El modelo **no escribe el documento**: no existe canal de texto libre. Cada frase factual se
  renderiza desde `kind` + `value` validados; saludo/cierre/apertura son plantillas del código.
- `claim.claim` es sólo etiqueta de display/auditoría (`describeClaim`), nunca autoridad.
- Completitud: toda claim no rechazada debe ser renderizable; si no, es output inválido. Tras el
  único intento de reparación, output inválido o claims rechazadas ⇒ `requires_human`
  (`REQUIRES_HUMAN_ACTION`) y **no se persiste documento**. La degradación determinista sólo se usa
  ante indisponibilidad del proveedor (timeout/error), y sus claims derivan de `ProfileFactsView`.
- `CoverLetterOutputSchema` pasa a `cover-letter/v2` (el prompt version participa en la identidad).
- Tests: `{text, claims:[]}` inventado ⇒ nunca verificado; claim AWS no declarada/declarada ⇒
  bloqueado; inyección en la oferta que pide ocultar el hecho de `claims` ⇒ bloqueado; sólo hechos
  declarados llegan al texto; renderer byte-determinista.

### P2 — `unverifiable` fail-closed

Regla única: `verified` ⇒ reusable/aprobable; `unverifiable` y `rejected` ⇒ revisión humana.

- `resolveAnswer`: sólo reutiliza con `verification.status === 'verified'`; `unverifiable` también
  es `stale` (`requiresHumanInput=true`, `approved=false`).
- `PUT /v1/applications/:id/answers`: `fullyVerified = status === 'verified'`;
  `requiresHumanInput = !fullyVerified`; `approved = body.approved && fullyVerified`. Una respuesta
  sin claims es `verified` vacío y puede aprobarse (no se fuerza a inventar claims).
- Documentos `unverifiable` se persisten para revisión pero siempre generan blocker
  `requires_human_input` (nunca “factualidad completa”).

### P3 — Ancla temporal en la identidad de preparación

`preparationAsOfDate` (YYYY-MM-DD) existe sólo si el candidato tiene alguna experiencia
`endDate=null`; proviene exclusivamente del `Clock` inyectado. Se incorpora a
`preparationInputHash` (`'none'` cuando no aplica) y se persiste en `generatedBy.asOfDate`
(provenance visible en API/UI; sin migración DDL porque `generated_by` es JSONB).

```
preparationInputHash = sha256(
  applicationId | matchId | sourceResumeVersionId | profileFactsHash |
  jobContentHash | promptVersion | provider | model | preparationAsOfDate
)
```

Carreras cerradas ⇒ `null` ⇒ sin churn diario; empleo abierto ⇒ la fecha participa y el documento
se regenera cuando cambia el día.

### P4 — CV exacto del JobMatch

Eliminado el fallback silencioso a la última versión:

- `recommendedResumeVersionId != null` ⇒ se usa exactamente esa versión (se revalida que exista y
  pertenezca al candidato; si no, `ConflictError`).
- `recommendedResumeId != null` con `recommendedResumeVersionId == null` ⇒ `ConflictError`
  (“JobMatch does not contain the exact ResumeVersion used for recommendation; recompute
  matching.”). Se elimina `recommendedResumeLatestVersionId` del puerto y del repo.
- `recommendedResumeId == null` ⇒ sin CV: `missing_resume` ⇒ `REQUIRES_HUMAN_ACTION`.

### P5 — Blockers idempotentes

`derivePreparationBlockers({requiresHumanReason, documents, answers, targetStatus})` (puro, en
`application-engine`) es la única fuente, usada por el engine (resultado de `prepare`) y por la API
(detalle). Un cache-hit de preparación reconstruye los blockers desde el estado persistido: un
documento `unverifiable`/`rejected` o una respuesta no verificada bloquean en todas las
ejecuciones. `target_blocked` es informativo (no marca `requiresHumanInput`). El evento
`application.documents_prepared` se sigue emitiendo sólo cuando se creó algún documento.

### P6 — Defaults JSONB de arrays

`application_answer.source_refs`, `application_answer.claims` y `application_document.claims` eran
`jsonb DEFAULT '{}'` (objeto) pese a ser arrays. Migración forward-only
`0010_json_array_defaults.sql`:

```sql
ALTER TABLE ... ALTER COLUMN ... SET DEFAULT '[]'::jsonb;
UPDATE ... SET ... = '[]'::jsonb WHERE ... = '{}'::jsonb;  -- legacy, idempotente
```

Sólo normaliza objetos vacíos; arrays válidos intactos; `verification`/`payload` siguen siendo
objetos. Drizzle usa el mismo default `[]` para que fresh y upgraded no diverjan. Tests: fresh
(defaults `[]`), upgrade 0009→0010 con fila legacy `{}` normalizada e histórico intacto.
