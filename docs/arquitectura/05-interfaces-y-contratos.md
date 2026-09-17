# 05 — Interfaces y contratos entre módulos

> Bocetos de diseño (no código compilable). Los puertos se declaran en `core`; las implementaciones viven en los paquetes de adaptadores. Toda frontera valida con Zod.
> Revisión Fase 0.1: `SubmissionPort` (sin detalles de Playwright), puertos de IA en `core`, jerarquía DRY_RUN/AUTO, separación discovery/target.

## 1. Reglas generales de contratos

1. Los puertos (interfaces) se declaran en `core` o en el paquete dueño del contrato. `matching`, `documents` y `application-engine` **nunca** importan `packages/ai` ni SDKs; dependen de puertos.
2. Todo método que cruza una frontera externa recibe/retorna datos validados; el parseo ocurre en la frontera (Zod).
3. Errores tipados con taxonomía común (§6). Prohibido lanzar `Error` genérico desde dominio.
4. Convención de idempotencia: todo comando crítico acepta `idempotencyKey` y devuelve el resultado existente si ya se ejecutó. La idempotencia funcional se apoya en claves de dominio y constraints de PostgreSQL, **no** en IDs de BullMQ (doc 06 §3).
5. Convención de trazabilidad: toda operación recibe `TraceContext { correlationId, jobId?, sourceId?, applicationId?, applicationTargetId? }`.

## 2. Puertos de dominio (core)

### 2.1 Discovery

```ts
interface JobSourceAdapter {
  readonly key: string;
  readonly capabilities: SourceCapabilities; // requiresHumanLogin, supportsPagination, rateLimit
  searchJobs(query: SourceSearchQuery): Promise<SourceSearchResult>;
  fetchJob(externalId: string): Promise<RawJob | null>;
  normalizeJob(raw: RawJob): NormalizedJob;     // puro, determinista, valida Zod
  detectApplicationTarget(raw: RawJob | RedirectTrace): DetectedTarget | null; // redirect/host/metadata
}
```

### 2.2 IA (implementado por `packages/ai`)

```ts
// Generación de texto: cover letters, redacción de respuestas, variantes de CV
interface TextGenerationPort {
  complete(req: CompletionRequest): Promise<CompletionResult>;
  completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>; // schema Zod obligatorio
}

// Embeddings: siempre asociados a un espacio registrado
interface EmbeddingProvider {
  embed(req: EmbeddingRequest & { embeddingSpaceId: string }): Promise<EmbeddingResult>;
}

// Decisiones tipadas (Jev / System One): elegir entre opciones acotadas
interface DecisionProvider {
  evaluate<TState, TDecision>(request: DecisionRequest<TState, TDecision>): Promise<DecisionResult<TDecision>>;
}
interface DecisionRequest<TState, TDecision> {
  task: DecisionTask;                 // map_form_field | choose_action | classify_field_type |
                                      // route_question | guardrail_check | classify_job_category
  state: TState;                      // estado estructurado (nunca screenshots en v1)
  schema: z.ZodType<TDecision>;
  options?: DecisionOption[];         // opciones acotadas (cardinalidad máx. recomendada 255)
  threshold?: number;                 // umbral de confianza configurable por tarea
  promptVersion: string;
}
interface DecisionResult<TDecision> {
  decision: TDecision;
  confidence: number;                              // probabilidad calibrada
  probabilities?: Record<string, number>;
  metadata: { provider: string; model: string; latencyMs: number; inputHash: string };
}
```

Implementaciones previstas: `OpenAIProvider`, `AnthropicProvider`, `DeepSeekProvider` (texto/embeddings); `JevDecisionProvider` (TypeSafe), `LLMDecisionAdapter` (LLM estructurado que implementa `DecisionProvider` como fallback), `Mock*` (tests). El composition root inyecta.

### 2.3 Envío de candidaturas (implementado por `packages/browser-automation` y futuros adapters de target)

```ts
interface SubmissionPort {                     // el dominio NO conoce Playwright
  inspectApplication(ctx: SubmissionContext, job: JobRef): Promise<ApplicationInspection>;
  prepareApplication(ctx: SubmissionContext, job: JobRef, input: PreparationInput): Promise<PreparedSubmission>;
  submitApplication(ctx: SubmissionContext, prepared: PreparedSubmission, opts: { dryRun: boolean }): Promise<SubmitOutcome>;
  reconcileSubmission(ctx: SubmissionContext, app: ApplicationRef): Promise<SubmissionStatus>;
}
interface ApplicationInspection {
  targetRef: ApplicationTargetRef;
  formFields: FormFieldDescriptor[];           // semanticType, label, required, options[] (datos, no selectores)
  unknownQuestions: QuestionDescriptor[];
  requiresLogin: boolean;
  artifacts: ArtifactRef[];
}
interface PreparedSubmission {
  snapshot: PreparationSnapshot;               // congelado para revisión y reenvío exacto
  fieldsMapped: number;
  requiresHumanInput: boolean;
  artifacts: ArtifactRef[];                    // screenshots del formulario rellenado (sin enviar)
}
type SubmitOutcome =
  | { kind: 'confirmed'; evidence: string }
  | { kind: 'uncertain'; evidence?: string }   // NUNCA reintentar sin reconcileSubmission
  | { kind: 'rejected_validation'; fields: string[] }  // recuperable → PREPARING
  | { kind: 'failed'; errorClass: string };
```

`BrowserPort` (con `BrowserContext`/`Page`/`Locator`) **desaparece del dominio**: si existe, es interno de `packages/browser-automation`. El adapter de destino decide si usa navegador, API oficial o ambos.

### 2.4 Otros puertos

```ts
interface PolicyEngine { evaluate(ctx: PolicyContext): PolicyDecision; }   // core puro
interface RateLimiter { acquire(bucket: RateBucket, cost?: number): Promise<RateDecision>; }
interface StoragePort { put(key, bytes, meta): Promise<ArtifactRef>; get(key): Promise<Readable>; delete(key): Promise<void>; }
interface SecretProvider { get(name: string): Promise<string>; }          // env hoy, secret manager mañana
interface EventBus { publish(event: DomainEvent): void; subscribe(type, handler): Unsubscribe; }
interface Clock { now(): Date; }
```

## 3. Servicios de aplicación (usados por apps/api y apps/worker)

```ts
interface SearchService {
  runSearch(searchConfigId: string, trace: TraceContext): Promise<SearchRunRef>;  // fan-out por fuente
}
interface IngestService {
  ingestListing(raw: RawJob, sourceKey: string, trace: TraceContext): Promise<IngestResult>;
  // resuelve/actualiza application_target del listing y del Job canónico
}
interface MatchingService {
  score(jobId: string, candidateId: string, trace: TraceContext): Promise<MatchRef>;
}
interface ApplicationService {
  createFromMatch(matchId: string, mode: ApplicationMode): Promise<Application>;
  resolveTarget(applicationId: string): Promise<ApplicationTargetRef>;             // puede quedar unknown
  prepare(applicationId: string, trace: TraceContext): Promise<PreparedApplication>; // inspect + fill + docs
  approve(applicationId: string, actor: 'user'|'system', reason?: string): Promise<Application>;
  submit(applicationId: string, trace: TraceContext): Promise<SubmitResult>;       // real o dry-run según jerarquía
  reconcile(applicationId: string): Promise<SubmissionStatus>;
  transition(applicationId: string, to: ApplicationStatus, actor, reason?): Promise<Application>;
}
interface SchedulerService { syncSearchConfigs(): Promise<void>; }
```

## 4. Eventos de dominio

```ts
type DomainEvent =
  | { type: 'search.started';      searchRunId; searchConfigId; correlationId }
  | { type: 'search.source_completed'; searchRunId; searchSourceRunId; sourceKey; counters }
  | { type: 'search.source_failed';    searchRunId; searchSourceRunId; sourceKey; errorClass }
  | { type: 'search.completed';    searchRunId; status; counters }
  | { type: 'job.discovered';      jobId; listingId; discoverySourceKey }
  | { type: 'job.merged';          jobId; listingId; layer: 'L0'|'L1'|'L2'|'L3' }
  | { type: 'job.target_resolved'; jobId; applicationTargetKey; signal }
  | { type: 'job.filtered';        jobId; decision: PolicyDecision }
  | { type: 'job.matched';         jobId; matchId; overallScore; identityHash }
  | { type: 'application.created'; applicationId; jobId; mode }
  | { type: 'application.prepared'; applicationId; documents[]; pendingQuestions; targetKey }
  | { type: 'application.approved'; applicationId; actor }
  | { type: 'application.submission_attempted'; applicationId; attempt; dryRun }
  | { type: 'application.submitted'; applicationId; confirmedBy }
  | { type: 'application.failed'; applicationId; errorClass }
  | { type: 'application.requires_human_action'; applicationId; reason }
  | { type: 'application.status_changed'; applicationId; from; to; actor }
  | { type: 'document.generated'; applicationId; kind; contentHash; provider; model }
  | { type: 'decision.recorded'; decisionLogId; task; confidence; outcome }
  | { type: 'ai.usage_recorded'; operation; provider; model; costEstimateUsd };
```

## 5. Taxonomía de errores

```ts
abstract class AppError extends Error { code: ErrorCode; retryable: boolean; context?: Record<string, unknown>; }
// ValidationError · NotFoundError · ConflictError · PolicyDeniedError
// SourceTransientError · SourcePermanentError · SourceAuthError
// CaptchaDetectedError (→ REQUIRES_HUMAN_ACTION, no retry)
// AIError · DecisionLowConfidenceError (→ revisión/handoff, no retry)
// BrowserError (transient | permanent | human_action) · SubmissionUncertainError (nunca retry ciego)
// BudgetExceededError · RateLimitedError
```

## 6. Jerarquía única de configuración: DRY_RUN y AUTO_APPLY

Fuente de verdad por precedencia estricta (ENV es **techo de seguridad**, sólo puede restringir):

```
1. ENV               (DRY_RUN, AUTO_APPLY_ENABLED)         ← hard safety ceiling, inmutable en runtime
2. runtime settings  (settings.dry_run, allow_real_submit) ← sólo puede endurecer, nunca relajar ENV
3. app_policy        (global y por candidato; versionada)  ← sólo puede endurecer
4. application_target.capabilities + status                ← autoSubmitTargets, blocked
5. application guards (score, CV, preguntas, warnings, cuotas, ledger)
```

```text
canRealSubmit =
  ENV.DRY_RUN == false
  AND ENV.AUTO_APPLY_ENABLED == true
  AND runtimeSettings.allowRealSubmit == true        (default false)
  AND policyAllows                                      (global ∩ candidato)
  AND targetAllows                                      (target activo ∩ autoSubmitTargets ∩ supportsAutoSubmit)
  AND applicationGuardsPass                             (sin requiresHumanInput, sin uncertain en ledger, cuotas)
```

- Ninguna fila de `settings`, `app_policy` o configuración de fuente/target puede habilitar un submit si ENV lo prohíbe.
- El submit manual (usuario aprueba y envía) sigue la misma fórmula; la aprobación humana **no** sustituye a ENV.
- Toda decisión persiste la cadena evaluada (para explicar por qué se bloqueó).

## 7. API pública (consumida sólo por `apps/web`)

REST `/v1`, JSON, errores `{ code, message, details?, reasons? }`. La API nunca ejecuta trabajos largos: responde `202 + jobId`.

| Recurso | Endpoints |
|---|---|
| Perfil | `GET/PUT /v1/profile`, CRUD `/v1/profile/experiences`, `/skills`, `/educations`, `/languages` |
| CVs | `CRUD /v1/resumes`, `POST /v1/resumes/:id/versions`, `GET /v1/resumes/:id/versions` |
| Discovery sources | `GET /v1/sources`, `PATCH /v1/sources/:key` |
| Application targets | `GET /v1/application-targets`, `PATCH /v1/application-targets/:key` |
| Búsquedas | `CRUD /v1/search-configs`, `POST /v1/search-configs/:id/run`, `GET /v1/search-runs`, `GET /v1/search-runs/:id/sources` |
| Ofertas | `GET /v1/jobs`, `GET /v1/jobs/:id`, `GET /v1/jobs/:id/match`, `POST /v1/jobs/:id/archive` |
| Candidaturas | `GET /v1/applications`, `GET /v1/applications/:id` (timeline + snapshot), `POST /v1/applications`, `POST /v1/applications/:id/prepare`, `POST /v1/applications/:id/approve`, `POST /v1/applications/:id/submit`, `POST /v1/applications/:id/reconcile`, `POST /v1/applications/:id/transition`, `GET/PUT /v1/applications/:id/answers` |
| Automatización | `GET /v1/automation-runs`, `GET /v1/automation-runs/:id/artifacts`, `POST /v1/browser-sessions/:target/verify` |
| Decisiones | `GET /v1/decisions` (decision_log: confianza, outcome, override) |
| Políticas / settings | `GET/PUT /v1/policy`, `GET/PUT /v1/settings` |
| Stats | `GET /v1/stats/overview`, `/sources`, `/targets`, `/ai-usage` |
| Operación | `GET /healthz`, `GET /readyz`, `GET /metrics` (red interna) |

## 8. Contrato de configuración (Zod, validado al arranque)

```ts
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development','test','production']),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  DRY_RUN: z.coerce.boolean().default(true),              // techo de seguridad
  AUTO_APPLY_ENABLED: z.coerce.boolean().default(false),  // techo de seguridad
  AI_PROVIDER: z.enum(['openai','anthropic','deepseek','mock']).default('mock'),
  DECISION_PROVIDER: z.enum(['jev','llm-adapter','mock']).default('mock'),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().default(20),
  STORAGE_BACKEND: z.enum(['local','s3']).default('local'),
  LOG_LEVEL: z.enum(['debug','info','warn','error']).default('info'),
});
```

Reglas: `DRY_RUN=false` y `AUTO_APPLY_ENABLED=true` son necesarios pero **no suficientes** (§6). Los defaults seguros nunca cambian.