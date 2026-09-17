# 04 — Modelo preliminar de base de datos (PostgreSQL + Drizzle)

> Diseño preliminar. No se implementa el schema en esta fase.
> Revisión Fase 0.1: application_target, unicidad de candidatura por Job canónico, identidad de JobMatch, ledger sin DRY_RUN, SearchSourceRun, EmbeddingSpace, claims, browser_session_id, app_policy con índices parciales.

## 1. Convenciones

- **IDs**: `uuid` generados en aplicación (UUID v7 para orden temporal).
- **Timestamps**: `timestamptz` UTC. `created_at` / `updated_at` por defecto.
- **Nombres**: `snake_case`, tablas en singular.
- **Enums**: `text` + validación Zod en frontera (no `pg_enum`), evolución sin migración bloqueante.
- **JSONB**: sólo datos flexibles validados por Zod (`score_breakdown`, `preparation_snapshot`, `claims`, `payload`). Todo lo consultable/agregable es columna.
- **Soft delete**: no. Estado explícito (`archived`, `expired`) o borrado real con cascada controlada.
- **Migraciones**: `drizzle-kit`, forward-only, revisadas en PR.
- **Ownership de escritura**: un solo módulo escribe cada tabla (doc 03 §3). El browser worker usa un **rol de DB limitado** (doc 09 §8).
- **PII**: columnas sensibles marcadas; cifrado sólo para secretos de sesión.

## 2. Tablas

### 2.1 Candidate

**`candidate_profile`**: `id` PK · `full_name` · `email` · `phone` · `headline` · `summary` · `location_city` · `location_country` · `location_timezone` · `availability_date` · `salary_min` · `salary_max` · `salary_currency` · `remote_preference` (text[]) · `employment_types` (text[]) · `allowed_countries` (text[]) · `relocation` bool · `preferences` JSONB · `profile_hash` sha256 (índice de matching) · `created_at` · `updated_at`

**`skill`** — catálogo: `id` · `canonical_name` UNIQUE · `aliases` (text[]) · `category`
**`candidate_skill`**: `id` · `candidate_id` FK · `skill_id` FK · `level` · `years` numeric(4,1) nullable · `evidence_ref` JSONB · UNIQUE(`candidate_id`,`skill_id`)
**`experience`**: `id` · `candidate_id` FK · `company` · `title` · `start_date` · `end_date` nullable · `description` · `location` · `skills` (text[])
**`education`**: `id` · `candidate_id` FK · `institution` · `degree` · `field` · `start_date` · `end_date` · `status`
**`candidate_language`**: `id` · `candidate_id` FK · `language` · `level` · UNIQUE(`candidate_id`,`language`)

### 2.2 Resume

**`resume`**: `id` · `candidate_id` FK · `name` · `category` · `language` · `is_default` bool · `created_at` · `updated_at`
**`resume_version`**: `id` · `resume_id` FK · `version_number` int · `parent_version_id` FK self nullable · `kind` (`original`|`tailored`|`generated`) · `storage_key` · `file_hash` sha256 · `highlights` JSONB · `created_at` · UNIQUE(`resume_id`,`version_number`)

### 2.3 JobCatalog

**`application_target`** (destino real de aplicación): `id` · `key` UNIQUE (`greenhouse-acme`, `lever-acme`, `email-acme`, …) · `kind` (`ats_api`|`ats_browser`|`company_site`|`email`|`external_unknown`) · `platform` · `label` · `base_url` · `capabilities` JSONB (`supportsApiSubmission`, `supportsBrowserSubmission`, `supportsAutoSubmit`, `requiresLogin`) · `auth_required` bool · `status` (`active`|`paused`|`blocked`) · `policy_notes` · `created_at` · `updated_at`

**`job_source`** (sólo descubrimiento): `id` · `key` UNIQUE · `name` · `kind` (`api`|`rss`|`html`|`manual`) · `status` (`active`|`paused`|`blocked`) · `capabilities` JSONB (`requiresHumanLogin`, `supportsPagination`, `rateLimit`) · `policy_notes` · `created_at` · `updated_at`
> Nota: `supportsAutoApply` **ya no vive aquí**; pertenece a `application_target.capabilities`.

**`job_listing`**: `id` · `source_id` FK (discovery) · `external_id` · `job_id` FK (canónico) · `application_target_id` FK nullable (detectado) · `application_target_signal` (`redirect`|`metadata`|`pattern`|`manual`|`unknown`) · `canonical_url` · `url_hash` · `company` · `company_norm` · `title` · `title_norm` · `description` · `description_norm` · `description_fingerprint` · `location` · `remote_type` · `employment_type` · `salary_min`/`salary_max` numeric · `currency` · `experience_level` · `language_requirements` (text[]) · `published_at` · `discovered_at` · `expires_at` · `application_method` (`api`|`external_form`|`email`|`unknown`) · `raw` JSONB · `raw_ref` · `status` (`active`|`expired`|`removed`) · `validated` bool · `validation_errors` JSONB nullable
Constraints: **UNIQUE(`source_id`,`external_id`)**; índices: `(job_id)`, `(url_hash)`, `(description_fingerprint)`, `(application_target_id)`, `(discovered_at desc)`, GIN trigram `(title_norm, company_norm)`.

**`job`** (canónico): `id` · `primary_listing_id` FK · `application_target_id` FK nullable · `application_target_resolved_at` · `company` · `title` · `description` · `location` · `remote_type` · `employment_type` · `salary_min`/`salary_max` · `currency` · `experience_level` · `required_skills` (text[]) · `preferred_skills` (text[]) · `language_requirements` (text[]) · `published_at` · `discovered_at` · `expires_at` · `application_method` · `dedup_key` sha256 · `content_hash` sha256 (campos que afectan matching) · `merged_from` (uuid[]) · `status` (`active`|`expired`|`archived`) · `metadata` JSONB
Constraints: **UNIQUE(`dedup_key`)**; índices: `(status, published_at desc)`, `(application_target_id)`, GIN trigram `(title)`.

**`job_skill_link`**: `job_id` FK · `skill_id` FK nullable · `skill_text` · `kind` (`required`|`preferred`) · `origin` (`deterministic`|`ai`) · PK(`job_id`,`skill_text`,`kind`).

**`embedding_space`** (registro): `id` · `key` UNIQUE · `provider` · `model` · `dimensions` int · `distance_metric` (`cosine`|`l2`|`ip`) · `version` · `status` (`active`|`inactive`) · `created_at` · UNIQUE(`provider`,`model`,`dimensions`,`version`)
> Regla pgvector: una columna `vector(N)` tiene dimensión fija. Estrategia: un espacio activo por tipo con dimensión N (default 1536); cambiar de dimensión = tabla paralela por migración + re-embedding; los embeddings antiguos permanecen referenciados a su espacio hasta completar la migración (ADR-018).

**`job_embedding`**: PK(`job_id`,`embedding_space_id`) · `content_hash` · `embedding` `vector(1536)` · `created_at`
**`resume_embedding`**: PK(`resume_version_id`,`embedding_space_id`) · `content_hash` · `embedding` `vector(1536)` · `created_at`
Índices HNSW por espacio (`vector_cosine_ops` según `distance_metric`).

### 2.4 Search

**`search_config`**: `id` · `candidate_id` FK · `name` · `keywords` (text[]) · `locations` (text[]) · `remote` bool nullable · `sources` (text[] de `job_source.key`) · `interval_minutes` int · `filters` JSONB · `mode` (`manual`|`assisted`|`auto`) · `is_active` bool · `last_run_at` · `next_run_at` · `created_at` · `updated_at`

**`search_run`** (padre): `id` · `search_config_id` FK · `started_at` · `finished_at` nullable · `status` (`running`|`completed`|`partial`|`failed`) · `jobs_discovered` int (agregado) · `jobs_new` · `jobs_duplicated` · `jobs_rejected` · `errors` · `correlation_id`
Índices: `(search_config_id, started_at desc)`, `(status)`.

**`search_source_run`** (hijo, uno por fuente): `id` · `search_run_id` FK · `source_id` FK · `status` (`running`|`completed`|`failed`|`skipped`) · `started_at` · `finished_at` nullable · `jobs_discovered` · `jobs_new` · `jobs_duplicated` · `jobs_rejected` · `errors` · `duration_ms` · `error_class` nullable · `error_detail` nullable · `correlation_id`
Constraints: **UNIQUE(`search_run_id`,`source_id`)**; índices: `(search_run_id)`, `(source_id, started_at desc)`.

> Concurrencia: cada job de fuente escribe **sólo su fila**. Un finalizador idempotente (`search.finalize`) agrega contadores y fija el estado del padre cuando todos los hijos son terminales. Sin updates concurrentes sobre un JSONB compartido.

### 2.5 Matching

**`job_match`**: `id` · `job_id` FK · `candidate_id` FK · `overall_score` numeric(5,4) · `score_breakdown` JSONB · `reasons` text[] · `missing_requirements` text[] · `matching_skills` text[] · `recommended_resume_id` FK nullable · `engine_version` · `weights_version` · `job_content_hash` · `candidate_profile_hash` · `resume_set_hash` · `embedding_space_id` FK nullable · `identity_hash` sha256 · `is_current` bool · `semantic_model` nullable · `computed_at`
Constraints: **UNIQUE(`job_id`,`candidate_id`,`identity_hash`)**; partial unique **(`job_id`,`candidate_id`) WHERE `is_current`**; índices: `(candidate_id, overall_score desc) WHERE is_current`, `(computed_at desc)`.
> Recomputar el mismo input es idempotente; cambios de oferta/perfil/CVs/pesos/motor/espacio generan identidad nueva sin colisionar con el histórico.

### 2.6 Application

**`application`**: `id` · `job_id` FK (canónico) · `candidate_id` FK · `application_target_id` FK nullable (se resuelve en PREPARING) · `discovery_source_id` FK nullable (analytics) · `match_id` FK · `mode` (`manual`|`assisted`|`auto`) · `status` (validado por state machine) · `resume_version_id` FK nullable · `idempotency_key` text UNIQUE · `policy_version` · `score_at_creation` numeric · `preparation_snapshot` JSONB nullable (inmutable al pasar a READY_FOR_REVIEW) · `supersedes_application_id` FK self nullable · `submitted_at` · `last_transition_at` · `requires_human_reason` nullable · `created_at` · `updated_at`
Constraints:
- **Partial unique `(candidate_id, job_id) WHERE status NOT IN ('ARCHIVED','REJECTED')`** → imposible duplicar una candidatura activa al mismo Job canónico, sin importar en cuántas fuentes se descubrió.
- `supersedes_application_id` sólo se usa tras `REJECTED`, con confirmación humana y `reapplicationCooldownDays` (política).
Índices: `(status, last_transition_at)`, `(job_id)`, `(application_target_id)`.

**`application_answer`**: `id` · `application_id` FK · `question_text` · `question_hash` sha256 · `answer_text` nullable · `answer_kind` (`profile`|`resume`|`user`|`generated`) · `source_refs` JSONB · `claims` JSONB (validado: `[{claim, kind, value?, sourceRefs[], verified}]`) · `verification` JSONB (`status`, `failures[]`) · `requires_human_input` bool · `approved` bool · `created_at` · `updated_at` · UNIQUE(`application_id`,`question_hash`)

**`application_document`**: `id` · `application_id` FK · `kind` (`cover_letter`|`resume_variant`|`other`) · `resume_version_id` FK nullable · `storage_key` · `content_hash` · `claims` JSONB · `verification` JSONB · `generated_by` JSONB · `created_at` · UNIQUE(`application_id`,`kind`,`content_hash`)

**`application_event`**: `id` (uuid v7) · `application_id` FK · `type` · `from_status` nullable · `to_status` nullable · `actor` (`system`|`user`) · `payload` JSONB redactado · `correlation_id` · `occurred_at`
Índice: `(application_id, occurred_at)`. Append-only.

**`application_submission_ledger`** (sólo submits reales): `id` · `application_id` FK · `attempt` int · `idempotency_key` text UNIQUE · `state` (`claimed`|`in_progress`|`confirmed`|`uncertain`|`failed`) · `automation_run_id` FK nullable · `claimed_at` · `resolved_at` · `resolution_notes`
> **DRY_RUN no vive aquí.** Los dry-runs se registran en `automation_run` (operation `prepare`/`submit` con `dry_run=true`), `application_event` y `audit_log`. El ledger representa exclusivamente intentos capaces de producir un efecto externo real.
> Regla dura: `uncertain` nunca permite segundo submit automático hasta reconciliación resuelta.

### 2.7 Automation

**`browser_session`**: `id` · `application_target_id` FK · `account_label` · `storage_state_ciphertext` bytea · `encryption_key_ref` · `expires_at` · `status` (`valid`|`expired`|`requires_login`) · `last_verified_at` · `created_at` · `updated_at`
**`automation_run`**: `id` · `application_id` FK nullable · `application_target_id` FK · `browser_session_id` FK nullable (null si el target usa API) · `adapter_key` · `operation` (`login_check`|`inspect`|`prepare`|`submit`|`reconcile`) · `dry_run` bool · `attempt` int · `status` (`running`|`succeeded`|`failed`|`requires_human_action`) · `error_class` nullable · `error_detail` nullable · `artifacts` JSONB (screenshots, trace, html) · `duration_ms` · `started_at` · `finished_at` · `correlation_id`
Índices: `(application_id, started_at desc)`, `(application_target_id, status)`, `(browser_session_id)`.

### 2.8 Governance / operación

**`audit_log`**: `id` · `actor` · `action` · `entity_type` · `entity_id` · `before` JSONB redactado · `after` JSONB redactado · `ip` nullable · `correlation_id` · `created_at`
Índices: `(entity_type, entity_id, created_at desc)`, `(created_at desc)`.

**`app_policy`** (global y por candidato): `id` · `candidate_id` FK nullable · `version` text · `rules` JSONB · `is_active` bool · `created_at`
Constraints (PostgreSQL):
- **UNIQUE(`version`) WHERE `candidate_id IS NULL`** (política global única por versión)
- **UNIQUE(`candidate_id`,`version`) WHERE `candidate_id IS NOT NULL`** (política por candidato única por versión)
- Partial unique `(candidate_id) WHERE is_active` / `(1) WHERE is_active AND candidate_id IS NULL` para una sola activa.
Precedencia: **política del candidato > política global**; ambas sólo pueden **restringir** respecto de ENV (doc 05 §6).

**`ai_usage`**: `id` · `provider` · `model` · `operation` (`extract`|`embed`|`match_explain`|`cover_letter`|`answer`|`classify`|`decide`|`other`) · `tokens_in` · `tokens_out` · `cost_estimate_usd` · `confidence` numeric nullable (Jev/decisiones) · `latency_ms` · `cached` bool · `application_id` FK nullable · `job_id` FK nullable · `correlation_id` · `created_at`

**`decision_log`** (auditoría y calibración de decisiones asistidas): `id` · `task` (`map_form_field`|`choose_action`|`classify_field_type`|`route_question`|`guardrail_check`|`classify_job_category`) · `provider` · `model` · `input_hash` · `proposed` JSONB · `chosen` JSONB nullable · `confidence` numeric(5,4) · `threshold` numeric(5,4) · `outcome` (`auto_accepted`|`human_accepted`|`human_overridden`|`rejected`|`pending`) · `application_id` FK nullable · `automation_run_id` FK nullable · `correlation_id` · `created_at`
Índices: `(task, created_at desc)`, `(outcome)`, `(application_id)`.

**`dead_letter`**: `id` · `queue` · `job_name` · `payload` JSONB · `error_class` · `error_detail` · `attempts` · `failed_at` · `replayed_at` nullable · `status` (`pending`|`replayed`|`discarded`)

**`settings`**: `key` PK · `value` JSONB · `updated_at` (flags runtime: `dry_run`, `allow_real_submit`, presupuesto IA). Nunca puede relajar ENV.

## 3. Relaciones (resumen)

```
candidate_profile 1─N resume 1─N resume_version
job_source 1─N job_listing N─1 job (canónico)
application_target 1─N job_listing / job (destino primario) / browser_session / automation_run
embedding_space 1─N job_embedding / resume_embedding
search_config 1─N search_run 1─N search_source_run N─1 job_source
job 1─N job_match N─1 candidate_profile
job 1─N application N─1 candidate_profile ; application N─1 application_target
application 1─N application_answer / application_document / application_event / ledger / automation_run
```

## 4. Índices y constraints críticos

| Índice / constraint | Propiedad que garantiza |
|---|---|
| `job_listing(source_id, external_id)` UNIQUE | idempotencia de ingesta (L0) |
| `job(dedup_key)` UNIQUE | idempotencia de dedup |
| `application(candidate_id, job_id) WHERE status NOT IN ('ARCHIVED','REJECTED')` UNIQUE | **prohibición de candidaturas duplicadas al mismo Job canónico** |
| `application_submission_ledger(idempotency_key)` UNIQUE | **prohibición de envíos duplicados reales** |
| `job_match(job_id, candidate_id, identity_hash)` UNIQUE + `(job_id, candidate_id) WHERE is_current` | recomputación idempotente y único vigente |
| `search_source_run(search_run_id, source_id)` UNIQUE | fan-out sin duplicar fuentes |
| `embedding_space(provider, model, dimensions, version)` UNIQUE + `(job_id, embedding_space_id)` PK | coexistencia/migración de espacios |
| partial uniques de `app_policy` | una sola política activa global y por candidato |
| GIN trigram `job_listing(title_norm, company_norm)` | blocking fuzzy L3 |
| `job_match(candidate_id, overall_score desc) WHERE is_current` | ranking |
| `application(status, last_transition_at)` | tablero y cuotas |
| HNSW por espacio | búsqueda semántica |

## 5. Retención y minimización (detalle en doc 09)

| Dato | Retención |
|---|---|
| `raw` de listings | 90 días |
| Artefactos de automation (screenshots/traces) | 180 días |
| `preparation_snapshot` | mientras viva la candidatura (referencia a artefactos) |
| `decision_log` | 1 año (agregable para calibración) |
| `audit_log` / `ai_usage` | 2 años |
| Sesiones de navegador | expiración + 30 días |
| Datos de candidatura | hasta borrado a petición del candidato |

## 6. Notas de evolución

- **Particionado**: `job_listing` y `application_event` por mes al superar ~10M filas.
- **pgvector**: activo desde Fase 3 con un espacio; `EmbeddingSpace` permite migrar modelo sin bloquear.
- **Outbox**: revisar en Fase 7 si aparecen huecos de encolado (ADR-009).
- **Multi-candidate**: todas las tablas incluyen `candidate_id`; constraints multi-candidate-safe.