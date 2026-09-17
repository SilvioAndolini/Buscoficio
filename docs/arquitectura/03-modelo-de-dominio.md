# 03 — Modelo de dominio

> Define entidades, relaciones, ownership e invariantes. **No** contiene el schema SQL (ver `04-modelo-de-datos.md`).
> Revisión Fase 0.1: separación discovery source / application target, identidad de JobMatch, SearchSourceRun, claims, SubmissionPort, DecisionProvider.

## 1. Bounded contexts (módulos de dominio)

| Contexto | Agregado raíz | Responsabilidad |
|---|---|---|
| **Candidate** | `CandidateProfile` | Perfil profesional, skills, experiencia, educación, idiomas, preferencias |
| **Resume** | `Resume` | Múltiples CVs y sus versiones; nunca se modifican destructivamente |
| **JobCatalog** | `Job` (canónico) | Fuentes de descubrimiento, listings, destino de aplicación, dedup, estado |
| **Search** | `SearchConfig` / `SearchRun` | Búsquedas programadas y su ejecución fan-out por fuente |
| **Matching** | `JobMatch` | Puntuación explicable y versionada candidato↔oferta |
| **Application** | `Application` | Ciclo de vida completo, respuestas, documentos, eventos, envío |
| **Automation** | `AutomationRun` | Sesiones de navegador y ejecuciones por adapter de destino |
| **Governance** | `AuditLog` / `AppPolicy` / `DecisionLog` | Auditoría, reglas configurables y trazabilidad de decisiones asistidas |

## 2. Entidades y value objects

### Candidate
- `CandidateProfile` (raíz): datos personales mínimos, headline, ubicación, disponibilidad, aspiraciones salariales (rango + moneda), preferencias (`remoteType[]`, `employmentType[]`, países autorizados, idiomas).
- `Skill` (catálogo canónico + alias) y `CandidateSkill` (nivel, años, evidencia).
- `Experience`: empresa, cargo, fechas, descripción, skills usadas, logros.
- `Education`: institución, título, fechas, estado.
- `CandidateLanguage`: idioma + nivel (MCER o equivalente).
- `WorkPreference` (VO embebido): modalidad, jornada, salario mínimo aceptable, relocation, disponibilidad.

**Invariante C1**: toda afirmación usada en documentos/respuestas debe referenciar una entidad del perfil (`sourceRefs`) o marcarse `requiresHumanInput`.

### Resume
- `Resume` (raíz): nombre lógico, categoría (`software-engineering`, `audiovisual`, `management`, …), idioma, CV principal asociado.
- `ResumeVersion`: versión inmutable (número, fecha, archivo en storage, hash, skills destacadas, experiencia relevante, metadatos). Una variante adaptada es **otra versión** con `parent_version_id`.

**Invariantes R1**: el CV original nunca se sobrescribe; cada generación crea una versión nueva.
**R2**: una versión generada sólo puede reordenar, resumir o reenfatizar contenido existente; no puede añadir hechos (ver §8).

### JobCatalog

**Separación explícita (corrección Fase 0.1):**

| Concepto | Entidad | Significado |
|---|---|---|
| Fuente de descubrimiento | `JobSource` | De dónde salió la oferta (agregador, RSS, API de búsqueda) |
| Destino de aplicación | `ApplicationTarget` | Plataforma real donde se envía la candidatura (ATS, API, email, sitio corporativo) |

Una oferta descubierta en un agregador puede aplicar en Greenhouse: discovery source ≠ application target.

- `JobSource`: tipo (`api`, `rss`, `html`, `manual`), estado (`active`, `paused`, `blocked`), rate limits, capacidades de descubrimiento (`requiresHumanLogin`, `supportsPagination`).
- `ApplicationTarget`: `key` único, `kind` (`ats_api` | `ats_browser` | `company_site` | `email` | `external_unknown`), `platform` (greenhouse, lever, workday, ashby, custom…), `baseUrl`, `capabilities` (`supportsApiSubmission`, `supportsBrowserSubmission`, `supportsAutoSubmit`, `requiresLogin`), `authRequired`, `status` (`active` | `paused` | `blocked`), `policyNotes` (revisión de ToS).
- `JobListing`: oferta observada en una fuente; incluye `discovery_source_id`, **`application_target_id` detectado** (por redirect, metadata o regla de host) y `application_target_signal` (`redirect` | `metadata` | `pattern` | `manual` | `unknown`), `application_method` (`api` | `external_form` | `email` | `unknown`), `raw`, `status` (`active` | `expired` | `removed`).
- `Job` (canónico): agrupación deduplicada; conserva el mejor conjunto de campos, `application_target_id` primario (el destino resuelto con mayor evidencia), `application_target_resolved_at`, y `content_hash` (hash de los campos que afectan al matching).
- `JobSkillLink`: skills requeridas/deseadas (determinista primero; extracción IA validada después).

**Invariantes J1**: un `JobListing` pertenece a exactamente un `Job`.
**J2**: el merge de listings sólo ocurre por reglas deterministas (L0–L3) o por decisión humana registrada.
**J3**: un `Job` que no tiene `application_target` resoluble **no puede** ser candidato a AUTO; queda visible para MANUAL/ASSISTED.

### Search
- `SearchConfig`: keywords, ubicaciones, remoto, fuentes (discovery), intervalo, filtros, modo, activo.
- `SearchRun` (padre): `startedAt`, `finishedAt`, `status` (`running` | `completed` | `partial` | `failed`), contadores agregados **derivados** de sus hijos. Sin estado por fuente en el padre.
- `SearchSourceRun` (hijo, nueva entidad): una fila por `search_run + source` con `status`, `startedAt`, `finishedAt`, `jobsDiscovered`, `jobsNew`, `jobsDuplicated`, `jobsRejected`, `errors`, `durationMs`, `errorClass`.

**Invariante S1**: `SearchRun.status` se deriva: `completed` si todos los hijos completaron; `partial` si ≥ 1 falló y ≥ 1 completó; `failed` si todos fallaron; `running` mientras haya hijos no terminales.
**S2**: cada hijo es escrito únicamente por el job de su fuente; el padre nunca se actualiza desde múltiples workers a la vez (finalizador único idempotente).

### Matching
- `JobMatch`: `jobId`, `candidateId`, `overallScore`, `scoreBreakdown` (JSONB validado), `reasons[]`, `missingRequirements[]`, `matchingSkills[]`, `recommendedResumeId`, y la **identidad completa** de cómputo (ver §6).
- `EmbeddingSpace` (registro): `id`, `provider`, `model`, `dimensions`, `distanceMetric`, `version`, `status` (`active` | `inactive`). Todo embedding referencia su `embeddingSpaceId`.

**Invariantes M1**: recomputar el mismo input bajo la misma identidad es idempotente (no crea fila nueva).
**M2**: un cambio significativo (oferta, perfil, CVs, pesos, motor, espacio de embeddings) produce una identidad distinta y por tanto un resultado nuevo, sin colisionar con el histórico.
**M3**: todo score tiene explicación; nunca un número sin breakdown.
**M4**: como máximo un `JobMatch` marcado `isCurrent` por (`jobId`, `candidateId`).

### Application
- `Application` (raíz): `jobId`, `candidateId`, `applicationTargetId` (nullable hasta resolución), `discoverySourceId` (analytics, nullable), `matchId`, `mode`, `status`, `resumeVersionId`, `idempotencyKey`, `policyVersion`, `scoreAtCreation`, `preparationSnapshot` (JSONB: campos mapeados, preguntas desconocidas, uploads, artefactos), `supersedesApplicationId` (nullable), timestamps por transición clave, `requiresHumanReason`.
- `ApplicationAnswer`: pregunta canónica + hash, respuesta, `answerKind` (`profile` | `resume` | `user` | `generated`), `sourceRefs`, `claims[]` (estructuras verificables, ver §8), `verification` (resultado de validación), `requiresHumanInput`, `approved`.
- `ApplicationDocument`: kind (`cover_letter` | `resume_variant` | `other`), versión de CV, storage key, hash, `claims[]`, `verification`, `generatedBy` (provider/modelo/prompt).
- `ApplicationEvent`: bitácora append-only (`type`, `payload`, `actor`, `occurredAt`). Toda transición genera evento.

**Invariantes A1**: **como máximo una `Application` activa por (`candidateId`, `jobId`)** — el `jobId` es el Job canónico, no la fuente. Activas = todas excepto `ARCHIVED` y `REJECTED`.
**A2**: reaplicar tras `REJECTED` requiere `supersedesApplicationId` y confirmación humana; queda auditado.
**A3**: transiciones sólo por la máquina de estados (§4).
**A4**: ninguna respuesta con `requiresHumanInput=true` puede pasar a `SUBMITTING`.
**A5**: `READY_FOR_REVIEW` exige `preparationSnapshot` completo (§5).
**A6**: los documentos usados en un envío son inmutables.

### Automation
- `BrowserSession`: plataforma/target, etiqueta de cuenta, `storageState` cifrado, expiración, estado (`valid` | `expired` | `requires_login`). **Nunca guarda contraseñas.**
- `AutomationRun`: intento (`adapterKey`, `operation`, `attempt`, resultado, clase de error, artefactos: screenshots/trace/HTML, duración) con **`browserSessionId`** (nullable si la operación no usa navegador, p. ej. target con API) y `applicationId` nullable.

**Invariante AU1**: todo submit real referencia `Application` + `browserSessionId` (si aplica) + `idempotencyKey` en el ledger.
**AU2**: CAPTCHA/challenge detectado → `REQUIRES_HUMAN_ACTION`; nunca se intenta resolver.
**AU3**: una `AutomationRun` de tipo `prepare` (rellenado sin envío) no produce efecto externo y puede repetirse sin riesgo.

### Governance
- `AuditLog`: actor, acción, entidad, `before/after` redactado, IP, timestamp.
- `AppPolicy`: reglas versionadas; global (sin candidato) o por candidato; precedencia: **candidato > global**.
- `DecisionLog`: cada decisión asistida (`task`, `inputHash`, `proposed`, `chosen`, `confidence`, `threshold`, `outcome`, `provider/model`), para auditoría y medición de calibración.

## 3. Ownership de escritura (regla dura)

| Tabla | Único escritor |
|---|---|
| candidate_*, resume*, skill* | módulo Candidate/Resume (`apps/api` vía servicios) |
| job_source, job_listing, job*, application_target | `job-sources` (ingest/resolution) |
| search_config/run/source_run | `scheduler`/`search` |
| job_match, embeddings | `matching` |
| application*, ledger | `application-engine` (**nunca el browser worker**) |
| browser_session, automation_run | `browser-automation` (rol DB limitado) |
| audit_log, app_policy, settings, decision_log, ai_usage | governance/observabilidad (append o servicio) |

## 4. Máquina de estados de la candidatura

```
DISCOVERED ─► FILTERED ─► SHORTLISTED ─► PREPARING ─► READY_FOR_REVIEW ─► APPROVED
    │            │            │             │  ▲             │                │
    └────────────┴─────────────────────────┴──┴─────────────┴────────────────┴─► ARCHIVED
                                              │
APPROVED ─► SUBMITTING ─► SUBMITTED ► (REJECTED | INTERVIEW | OFFER)
                 │  ▲
                 │  └── (corrección de campos recuperable: vuelve a PREPARING)
                 ├─► FAILED ─► (PREPARING si retry permitido | ARCHIVED)
                 └─► REQUIRES_HUMAN_ACTION ─► (PREPARING | APPROVED tras resolución humana)
PREPARING ─► REQUIRES_HUMAN_ACTION (login requerido, ambigüedad no resoluble)
```

| Transición | Guarda | Actor | Evento |
|---|---|---|---|
| DISCOVERED→FILTERED | pasa reglas duras de política | system | application.status_changed |
| DISCOVERED/FILTERED→ARCHIVED | descarte | system/user | application.status_changed |
| FILTERED→SHORTLISTED | score ≥ threshold y cuota disponible | system | application.status_changed |
| SHORTLISTED→PREPARING | modo assisted/auto y lock de preparación | system | application.preparing |
| PREPARING→REQUIRES_HUMAN_ACTION | login requerido o ambigüedad bloqueante | system | application.requires_human_action |
| PREPARING→READY_FOR_REVIEW | snapshot completo: formulario inspeccionado, campos mapeados, documentos versionados, **cada campo resuelto o marcado `requiresHumanInput`**, artefactos de revisión generados | system | application.prepared |
| READY_FOR_REVIEW→APPROVED | aprobación humana o guardas AUTO completas | user/system | application.approved |
| APPROVED→SUBMITTING | lock idempotente + ledger `claimed` + preflight OK | system | application.submission_attempted |
| SUBMITTING→PREPARING | error de validación recuperable (campos) | system | application.status_changed |
| SUBMITTING→SUBMITTED | confirmación detectada | system | application.submitted |
| SUBMITTING→FAILED | error no recuperable o retries agotados | system | application.failed |
| SUBMITTING→REQUIRES_HUMAN_ACTION | CAPTCHA, login, resultado incierto | system | application.requires_human_action |
| REQUIRES_HUMAN_ACTION→PREPARING/APPROVED | resolución humana registrada | user | application.status_changed |
| SUBMITTED→REJECTED/INTERVIEW/OFFER | seguimiento | user | application.status_changed |
| cualquiera→ARCHIVED | decisión explícita | user | application.status_changed |
| REJECTED→(nueva Application) | reaplicación con `supersedesApplicationId` + confirmación | user | application.created |

## 5. Flujo de preparación (redefinición de `READY_FOR_REVIEW`)

`READY_FOR_REVIEW` significa: **la candidatura está completamente preparada y el sistema conoce exactamente qué información, documentos y respuestas se enviarán.** Por tanto PREPARING incluye:

```
PREPARING:
 1. Seleccionar CV + generar documentos (TextGenerationPort) y claims
 2. inspectApplication(target)          ← SubmissionPort: descubre formulario real
 3. Detectar campos y preguntas desconocidas
 4. Resolver preguntas nuevas: banco de respuestas → DecisionProvider (routing a hechos)
    → LLM (redacción validada) → si no hay dato: requiresHumanInput
 5. prepareApplication(...)             ← rellenar el formulario SIN enviar
 6. Generar artefactos de revisión (screenshots, resumen de envío, snapshot)
 7. Persistir preparationSnapshot       ← congelado e inmutable para revisión
    (máx. 2 ciclos inspect→answer; luego REQUIRES_HUMAN_ACTION)
 → READY_FOR_REVIEW
```

Tras la aprobación, el envío ejecuta exactamente el `preparationSnapshot` aprobado: si el formulario externo cambió entre revisión y submit, la discrepancia detectada **aborta** y vuelve a PREPARING con evento (nunca se envía algo distinto a lo aprobado).

## 6. Identidad y reproducibilidad de JobMatch

```
jobContentHash      = sha256(campos del Job que afectan al matching)
candidateProfileHash= sha256(campos del perfil que afectan al matching)
resumeSetHash       = sha256(versiones de CV relevantes)
embeddingSpaceId    = espacio semántico usado (null si el motor es sólo determinista)
engineVersion       = versión del algoritmo
weightsVersion      = versión de pesos configurados
identityHash        = sha256(engineVersion | weightsVersion | jobContentHash |
                             candidateProfileHash | resumeSetHash | embeddingSpaceId)
```

- `UNIQUE(jobId, candidateId, identityHash)` ⇒ recomputación idempotente.
- Al persistir, el nuevo match se marca `isCurrent` y el anterior se desmarca en la misma transacción (partial unique `(jobId, candidateId) WHERE isCurrent`).
- El histórico nunca se sobrescribe: permite comparar motores/pesos y auditar por qué cambió un ranking.

## 7. Motor de matching

Señales (normalizadas a [0,1] o ausente explícito):

| Señal | Tipo | Cálculo |
|---|---|---|
| `skillsMatch` | determinista | cobertura ponderada de required/preferred con skills canónicas |
| `experienceMatch` | determinista | años y seniority vs. rango pedido |
| `locationMatch` | determinista | ciudad/país/remoto; reglas de relocation |
| `salaryMatch` | determinista | intersección de rangos; `null` si falta dato |
| `languageMatch` | determinista | requisitos vs. idiomas del candidato |
| `employmentTypeMatch` | determinista | jornada/contrato preferidos |
| `semanticSimilarity` | semántico | coseno en el `EmbeddingSpace` activo, cacheado por `contentHash` |
| `careerRelevance` | híbrido | reglas + embeddings; clasificación asistida por `DecisionProvider` **opcional** con confianza calibrada |

Fórmula: `overallScore = Σ(w·sᵢ)/Σwᵢ` (señales ausentes fuera del denominador). Requisitos duros incumplidos → `missingRequirements` + tope de score configurable. Salida completa: `overallScore`, `scoreBreakdown`, `reasons[]`, `missingRequirements[]`, `matchingSkills[]`, `recommendedResumeId`.

Selección de CV: determinista (categoría ↔ clasificación de la oferta, cobertura de skills, recencia). La IA puede justificarla, no decidirla.

## 8. Factualidad basada en claims + provenance

La comprobación de entidades es necesaria pero **no suficiente**: mencionar “React” no prueba “5 años de experiencia profesional con React”. Toda generación relevante produce:

```ts
{
  text: "...",
  claims: [ { claim, kind, value?, sourceRefs: [...], verified: 'verified'|'unverifiable'|'rejected' } ]
}
```

`kind` incluye como mínimo: `years_experience`, `date_range`, `job_title`, `company`, `certification`, `degree`, `language_level`, `salary`, `project`, `seniority`.

Reglas de validación:

1. **Cuantitativas** (años, fechas, salarios): sólo se aceptan si son **estrictamente computables** desde datos del perfil (p. ej. suma de rangos de experiencia sin solapamiento; `candidate_skill.years`). Prohibida cualquier inferencia no respaldada (“≈5 años porque trabajó con React en 3 empleos”).
2. **Categóricas** (cargos, empresas, títulos, certificaciones, idiomas/nivel, proyectos): deben coincidir con una entidad existente (normalización + matcher determinista).
3. Fallo de validación → **eliminar la afirmación, regenerar (máx. 1 intento) o marcar `requiresHumanInput`**. Nunca publicar.
4. Los claims se persisten con la respuesta/documento (`application_answer.claims`, `application_document.claims`) y su `verification`.
5. La UI muestra procedencia: cada claim enlaza a las entidades del perfil que lo respaldan.
6. La IA **tipada no exime** de esta validación: el tipado garantiza forma, no veracidad semántica.

## 9. Decisiones asistidas (DecisionProvider / Jev)

Jev decide **entre opciones acotadas** (selección tipada con probabilidad calibrada), nunca genera texto ni ejecuta acciones:

| Permitido | Prohibido |
|---|---|
| Identificar qué elemento representa una acción | Redactar respuestas profesionales |
| Clasificar el tipo de campo observado | Inventar datos del candidato |
| Elegir acción: continuar / retry / handoff / stop | Decidir a qué jobs aplicar |
| Seleccionar entre opciones conocidas (≤255 en una pasada) | Decidir si una candidatura se envía |
| Señal de guardrail (inyección, soporte factual) | Superar CAPTCHA / evadir controles / hacer submit |

```
Reglas deterministas ──► suficiente ──► acción
        │
        └── ambiguo ──► DecisionProvider (Jev) ──► decisión tipada + confianza
                                                   │
                                                   ▼
                                            umbral: auto / revisión / handoff
                                                   ▼
                                                 adapter ──► Playwright
```

Cada decisión se registra en `DecisionLog` (entrada, propuesta, elección, confianza, umbral, resultado) para medir calibración real.

## 10. Motor de políticas

| Regla | Efecto |
|---|---|
| `minimumMatchScore` | < valor → no shortlist |
| `minimumSalary` / `requireSalaryInformation` | salario insuficiente o ausente → revisión/no AUTO |
| `maximumApplicationsPerDay` / `maxDailyPerTarget` | cuotas; exceso → en cola, no rechazo |
| `allowedCountries` / `allowedRemoteTypes` / `allowedSources` | allowlists de elegibilidad (discovery) |
| `allowedTargets` / `autoSubmitTargets` | allowlists de destino; AUTO sólo en `autoSubmitTargets` |
| `excludedCompanies` / `excludedKeywords` / `requiredKeywords` | rechazo duro con razón |
| `reapplicationCooldownDays` | ventana mínima para reaplicar tras REJECTED |

Toda decisión produce `PolicyDecision { allowed, action, appliedRules[], reasons[] }`, persistida y visible. Precedencia de configuración: `ENV > runtime settings > policy > target > guards` (ver doc 05 §6). Ninguna configuración en base de datos puede relajar una prohibición de ENV.

## 11. Responsabilidades de envío (SubmissionPort)

- El dominio conoce `SubmissionPort` (`inspectApplication`, `prepareApplication`, `submitApplication`, `reconcileSubmission`); **no conoce** `BrowserContext`, `Page`, `Locator`, selectores ni handles.
- `application-engine` orquesta y decide; `browser-automation` ejecuta y reporta.
- El browser worker escribe sólo `browser_session`, `automation_run` y artefactos; **jamás** `application` ni `application_event`. Las transiciones las aplica `application-engine` al consumir los resultados.
- Un resultado `uncertain` nunca habilita un segundo submit automático: exige `reconcileSubmission` exitoso o resolución humana.