# Fase 3 — Matching (plan de implementación)

> Fuente de verdad: `docs/arquitectura/03` (§6–§7), `04` (§2.3/§2.5), `05` (§2.2/§3),
> `06` (§1/§3), `08` (§4), `10` (§2), `12` (Fase 3). Este plan no rediseña; aterriza.

## 1. Objetivo

Ranking candidato↔oferta **determinista, explicable, reproducible, versionado e idempotente**,
con embeddings reales en pgvector, identidad completa de `JobMatch` e histórico intacto.
Sin IA como autoridad: ningún LLM decide score, requisitos duros ni CV recomendado.

## 2. Arquitectura

```
apps/api ── encola match.score / lee ranking (repos)
apps/worker
  └─ services/matching-service.ts   (orquestación: carga, hashes, embeddings, persistencia)
       ├─ @job-system/matching      (motor puro: señales, fórmula, hashes, textos, coseno)
       ├─ @job-system/database      (repos matching/embeddings/ai_usage)
       └─ EmbeddingProvider (puerto core, implementado por @job-system/ai)
```

- `packages/matching` es **puro** (sin I/O): motor, pesos, hashes, builders de texto, coseno.
- `packages/ai` implementa `EmbeddingProvider` (Mock determinista + adapter OpenAI-compatible).
- `packages/database` es el único que escribe `job_match`, `job_embedding`, `resume_embedding`,
  `embedding_space`, `ai_usage`.
- `apps/api` sólo valida/encola/consulta; el cálculo nunca corre en el request.

## 3. File map

| Archivo | Contenido |
|---|---|
| `packages/core/src/ports/embedding.ts` | `EmbeddingProvider` + `EmbeddingRequest/Result` |
| `packages/core/src/jobs/dedup.ts` | `computeJobContentHash` extendido con required/preferred skills |
| `packages/matching/src/versions.ts` | `ENGINE_VERSION='matching-v1'`, `WEIGHTS_VERSION='v1'`, cap y reglas duras |
| `packages/matching/src/weights.ts` | `MatchingWeightsSchema` (Zod) + `MATCHING_WEIGHTS_V1` |
| `packages/matching/src/hashes.ts` | `computeCandidateProfileHash`, `computeResumeSetHash`, `computeIdentityHash` |
| `packages/matching/src/schemas.ts` | `ScoreBreakdownSchema`, `MatchPolicySchema`, señales |
| `packages/matching/src/signals/*.ts` | skills, experience, location, salary, language, employment, semantic, career |
| `packages/matching/src/engine.ts` | fórmula ponderada, señales ausentes, cap, reasons, selección de CV |
| `packages/matching/src/text.ts` | builders versionados de texto de Job/ResumeVersion |
| `packages/matching/src/similarity.ts` | coseno + normalización `(c+1)/2` documentada |
| `packages/matching/src/category.ts` | clasificador determinista de categoría de oferta |
| `packages/ai/src/embeddings/*` | `MockEmbeddingProvider`, `OpenAiEmbeddingProvider`, factory |
| `packages/database/src/schema.ts` | `job_match`, `job_embedding`, `resume_embedding`, `ai_usage`, unique activo |
| `packages/database/migrations/0007_*` | pgvector + tablas + constraints + HNSW |
| `packages/database/src/repositories/matching-repo.ts` | espacios, embeddings (caché), `job_match` transaccional |
| `packages/database/src/repositories/ai-usage-repo.ts` | `operation=embed` con latencia/caché/costo |
| `apps/worker/src/services/matching-service.ts` | `score(jobId, candidateId, trace)` |
| `apps/worker/src/handlers.ts` | `match.score`; encolado tras discovery (`newJobIds`) |
| `apps/worker/src/queues.ts`, `runtime.ts` | cola `match`, wiring de provider y servicio |
| `apps/api/src/routes/matches.ts`, `jobs.ts` | `POST/GET /v1/jobs/:id/match`, `GET /v1/matches`, recompute |
| `apps/web/src/app/matches/page.tsx` | ranking + breakdown + requisitos duros |
| `docker/*`, `.github/workflows/ci.yml` | PostgreSQL con pgvector real |

## 4. Tablas y migraciones

- `0007_matching_pgvector.sql` (forward-only, no toca 0000–0006):
  - `CREATE EXTENSION IF NOT EXISTS vector;`
  - `embedding_space`: partial unique `(status) WHERE status='active'` (un espacio activo, determinista).
  - `job_match`: columnas del doc 04 §2.5 + `UNIQUE(job_id, candidate_id, identity_hash)` +
    partial unique `(job_id, candidate_id) WHERE is_current` + índice
    `(candidate_id, overall_score DESC) WHERE is_current` + `(computed_at DESC)`.
  - `job_embedding` PK(`job_id`,`embedding_space_id`) + `content_hash` + `vector(1536)` + HNSW cosine.
  - `resume_embedding` PK(`resume_version_id`,`embedding_space_id`) + `content_hash` + `vector(1536)` + HNSW cosine.
  - `ai_usage` (doc 04 §2.8) para `operation=embed`.
- Dimensión fija `1536` (ADR-018): cambiar dimensión = migración paralela futura, no Fase 3.
- Tests: fresh DB (0000→0007) + upgrade incremental 0006→0007.

## 5. Identidad

```
identityHash = sha256(engineVersion | weightsVersion | jobContentHash |
                      candidateProfileHash | resumeSetHash | embeddingSpaceId|'none')
```

- `jobContentHash`: `computeJobContentHash` (core) recalculado desde la fila `job` (fuente canónica),
  ahora incluye `requiredSkills`/`preferredSkills` ordenadas.
- `candidateProfileHash`: canonicaliza sólo campos que puntúan (ubicación, modalidad, tipos de empleo,
  países permitidos, relocation, salario/moneda, skills ordenadas, idiomas, experiencias con rangos).
- `resumeSetHash`: array ordenado por `resume.id` con categoría/idioma + última versión (id, número, hash).
- Cambiar oferta, perfil, CV, pesos, motor o espacio ⇒ identidad nueva; recomputar lo mismo ⇒ misma fila.

## 6. Motor y fórmula

Señales (todas `score ∈ [0,1]` o `absent` explícito):

| Señal | Regla determinista |
|---|---|
| `skillsMatch` | cobertura ponderada required 0.7 / preferred 0.3 con nombres canónicos + alias; sin skills ⇒ absent |
| `experienceMatch` | años computados de rangos de experiencia (sin solapamiento) vs nivel mínimo; sin datos ⇒ absent |
| `locationMatch` | remoto compatible / mismo país / relocation / onsite incompatible |
| `salaryMatch` | intersección/unión de rangos misma moneda; sin datos o moneda distinta ⇒ absent |
| `languageMatch` | parser determinista "English B2"; nivel MCER insuficiente ⇒ violación dura |
| `employmentTypeMatch` | intersección de tipos; sin datos ⇒ absent |
| `semanticSimilarity` | coseno normalizado `(c+1)/2` en el espacio activo, cacheado por `contentHash` |
| `careerRelevance` | categoría clasificada de la oferta vs categorías de CVs; sin clasificar ⇒ absent |

`overallScore = Σ(wᵢ·sᵢ)/Σ(wᵢ presentes)`; señales ausentes fuera del denominador.
Pesos v1: skills .25 · experience .15 · location .10 · salary .05 · language .10 ·
employment .05 · semantic .20 · career .10. `Σ=1` por comodidad, no por dependencia.

Requisitos duros v1: idioma exigido no satisfecho ⇒ `missingRequirements` + cap `0.49`.
Salario por debajo del mínimo y skills requeridas ausentes se **reportan** en `missingRequirements`
(con detalle) pero no topean. Cambiar reglas/cap/pesos ⇒ bump de versión.

## 7. Embeddings

- `EmbeddingProvider` (core): `provider/model/dimensions` + `embed({text, contentHash, trace, embeddingSpaceId})`.
- Mock determinista: PRNG sembrado con sha256(texto), vector L2-normalizado, contador de llamadas.
- Adapter real único OpenAI-compatible (`fetch` inyectable), claves por configuración; jamás en CI.
- `EmbeddingSpace` activo: resuelto por `status='active'` + constraint partial unique; el composition
  root asegura el espacio configurado al arrancar si no hay ninguno activo.
- Caché: `job_embedding/resume_embedding.content_hash` = sha256(texto versionado); mismo hash ⇒ no `embed()`.
- Coexistencia: PK por `(entidad, espacio)`; activar B no borra vectores de A.

## 8. Persistencia y concurrencia

`upsertJobMatch` en una transacción con advisory lock `hashtext(jobId||candidateId)`:
si la identidad existe ⇒ reutiliza la fila (y la marca vigente si procede); si no ⇒
`is_current=false` al vigente anterior + insert `is_current=true`. Unique violations se recuperan
re-consultando. El constraint partial unique es la última defensa (test SQL directo).

## 9. API

- `POST /v1/jobs/:id/match` → `202 {jobId, queueJobId}` (idempotente por job id `match-<jobId>-<engine>`).
- `GET /v1/jobs/:id/match` → match vigente (404 si no existe).
- `GET /v1/jobs/:id/matches` → histórico.
- `GET /v1/matches?limit&offset&minScore` → ranking vigente ordenado por score (índice DB).
- `POST /v1/matches/recompute` → encola matching de jobs activos (máx. 200).
- `GET /v1/embedding-spaces`, `POST /v1/embedding-spaces/:id/activate` (operación determinista).

## 10. Worker

- Cola `match`, job `match.score` `{jobId, candidateId, correlationId}`, attempts 3, backoff.
- Tras discovery: si hay perfil, encolar matching de los `newJobIds` (fallo de encolado no rompe discovery).
- Observabilidad: `correlationId`, `jobId`, `candidateId`, `identityHash`, `embeddingSpaceId`; nunca CV ni vectores.

## 11. UI

`/matches`: posición, score, título, empresa, modalidad, CV recomendado, razones, requisitos duros
visibles, breakdown expandible con `N/A` para ausentes, botón "Recomputar pendientes".
Todo funciona con `AI_PROVIDER=mock`; ninguna explicación depende de LLM.

## 12. Testing

- Unit (`matching`): hashes canónicos, pesos, fórmula, ausencias, cada señal, cap, CV recomendado,
  reasons deterministas, normalización de coseno, categoría, builders de texto.
- Unit (`ai`): mock determinista + contador; adapter real con fetch falso.
- Integración (`database`): migraciones fresh/upgrade, constraints, caché de embeddings,
  cambio de espacio/job/perfil/CV/pesos, concurrencia, ranking, aislamiento de espacios.
- E2E: perfil → CV → discovery → matching → ranking API → UI ordenada por score; recompute v1→v2.

## 13. Rollout

Migración forward-only; worker asegura espacio activo; sin feature flags que relajen seguridad.
`AI_PROVIDER=mock` por defecto. Fase 4+ queda fuera.

## 14. Scope exclusions

Nada de `Application`, cover letters, SubmissionPort, browser automation, AUTO_APPLY, ledger,
variantes de CV, DecisionProvider/Jev, extracción IA de skills, re-ranking con LLM ni envíos.
`recommendedResumeId` sólo recomienda CV para matching.

## 15. Fase 3.1 — saneamiento (pre-Fase 4)

Correcciones sobre la implementación existente, sin rediseño:

1. **Binding estricto de `EmbeddingSpace`**: antes sólo se comparaba `dimensions`, lo que permitía
   escribir un vector de `model-B` dentro de un espacio `model-A`. Ahora `provider`, `model` y
   `dimensions` deben coincidir (`embeddingRuntimeMatchesSpace`, core) antes de cualquier cache
   lookup, `embed()`, escritura de embeddings, `semanticSimilarity` o creación de `JobMatch`.
   Mismatch ⇒ **fail closed** con `AiError` tipado y metadata segura (sin credenciales); no se toca
   `isCurrent`. El endpoint de activación de espacios rechaza (`409`) espacios incompatibles con el
   runtime descriptor (misma función pura, sin duplicar comparaciones).
2. **Ancla temporal**: `computeExperienceMonths(experiences, asOfDate)` usa `endDate` o, para
   empleos abiertos, la fecha explícita que proviene de `Clock` (`matchingAsOfDate`). El motor puro
   nunca lee el reloj de pared y falla tipado si falta el ancla con roles abiertos. Si todas las
   experiencias están cerradas, el ancla es `null` y la identidad no depende del tiempo (sin churn
   diario). Migración `0008` añade `job_match.matching_as_of_date` (nullable para histórico).
3. **Identidad**: `identityHash` incorpora `matchingAsOfDate`; `candidateProfileHash` incorpora
   aliases normalizados/ordenados (afectan `skillsMatch`); `resumeSetHash` incorpora `highlights`
   canónicos (afectan cobertura de skills y texto de embedding). Auditoría completa de inputs en
   `docs/producto/12`.
4. **Configuración independiente**: `EMBEDDING_PROVIDER` (default `mock`) desacoplado de
   `AI_PROVIDER`; `EMBEDDING_API_KEY` con fallback a `OPENAI_API_KEY`; `EMBEDDING_BASE_URL` sólo
   aplica a embeddings. `deepseek`/`anthropic` como provider de embeddings ⇒ `ConfigError` claro
   (no se inventan endpoints); `anthropic`/`deepseek` como `AI_PROVIDER` conviven con embeddings
   mock/openai.
5. **`engineVersion` `matching-v1 → matching-v2`** por el cambio material de cálculo de
   experiencia. El histórico v1 permanece; los recomputes crean v2 current normalmente.
6. **Datos derivados legacy**: la migración `0008` invalida `job_embedding`/`resume_embedding`
   (no se puede probar qué vectores pre-saneamiento eran limpios). No se borran Jobs, CVs,
   `job_match` ni espacios; los vectores se regeneran en el siguiente cálculo.

Diferido (documentado, no blocker): registrar cache hits en `ai_usage` (`cached=true`) para medir
hit rate; hoy sólo se registran llamadas reales al provider.
