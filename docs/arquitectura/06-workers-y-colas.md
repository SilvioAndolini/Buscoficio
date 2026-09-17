# 06 — Estrategia de workers y colas (Redis + BullMQ)

> Revisión Fase 0.1: SearchSourceRun, IDs de job compatibles con BullMQ, ledger sin DRY_RUN, jerarquía DRY_RUN/AUTO, privilegios del browser worker.

## 1. Topología de colas

| Cola | Productor | Consumidor | Concurrencia | Rate limit | Prioridad |
|---|---|---|---|---|---|
| `search` | Scheduler / API | worker | 3 | por discovery source | normal |
| `ingest` | `search` (fan-out) | worker | 5 | — | normal |
| `match` | `ingest` / API | worker | 5 | límite global de embeddings | normal |
| `dedup-review` | `ingest` (zona gris L3-bis) | worker/UI | 1 | — | baja |
| `documents` | `apply` (preparación) | worker | 2 | presupuesto IA | normal |
| `apply` | API / política | worker | 1 por aplicación | cuotas global y por target | alta |
| `automation` | `apply` | **browser worker** | 1–2 por cuenta | estricto por target/sesión | alta |
| `maintenance` | scheduler | worker | 1 | — | baja |
| `dlq` (revisión) | todos | manual/CLI | — | — | — |

- El browser worker consume sólo `automation`; puede desplegarse en contenedor separado con **rol de DB limitado** (§7).
- La API nunca consume colas.

## 2. Scheduler y fan-out por fuente

- Fuente de verdad: `search_config` (Postgres). BullMQ Job Schedulers se reconcilian al arrancar y ante cambios.
- Cada ejecución crea `SearchRun` (padre) y **una fila `SearchSourceRun` por fuente**; cada job de fuente escribe **sólo su fila** (sin contención).
- Al terminar cada hijo se encola `search.finalize` (idempotente): cuando todos los hijos son terminales, agrega contadores y fija `SearchRun.status` (`completed` | `partial` | `failed`).
- Watchdog: hijo o padre `running` más de N minutos → `failed` con `errorClass=timeout`; re-ejecución permitida (idempotente).
- Jitter obligatorio; ventanas horarias configurables.

## 3. Identidad de jobs BullMQ (corrección Fase 0.1)

- **Prohibido `:` en custom job IDs.** Formato: `componente-<id>-<sufijo>`.
- Los identificadores externos largos o con caracteres problemáticos se normalizan/hashean.

| Operación | Job ID | Última defensa (Postgres) |
|---|---|---|
| Search run | `search-<configId>-<scheduledEpochMs>` | `search_run` única por ventana |
| Source run | `search-src-<searchRunId>-<sourceKey>` | UNIQUE(`search_run_id`,`source_id`) |
| Ingesta | `ingest-<sourceKey>-<sha256(externalId).slice(0,16)>` | UNIQUE(`source_id`,`external_id`) |
| Match | `match-<jobId>-<engineVersion>` | UNIQUE identidad de `job_match` |
| Preparación | `prepare-<applicationId>` | snapshot + estado |
| Envío real | `submit-<applicationId>-<attempt>` | ledger UNIQUE(`idempotency_key`) |
| Reconciliación | `reconcile-<applicationId>` | idempotente por naturaleza |

- **Job Schedulers**: no fijar `jobId` manualmente para jobs programados por BullMQ (el scheduler controla sus IDs). La unicidad funcional se garantiza por claves de dominio + constraints de PostgreSQL, **nunca** por el ID de BullMQ.
- Consumidores idempotentes: si el trabajo ya se hizo, devuelven el resultado existente sin efectos.

## 4. Retries, backoff y DLQ

| Clase de error | Retry | Estrategia |
|---|---|---|
| `SourceTransientError` | sí | exponencial 30s → 2m → 10m (máx. 3), jitter ±20 % |
| `RateLimitedError` | sí | respeta `Retry-After`/token bucket |
| `AIError` (timeout/5xx/429) | sí, limitado | 2 reintentos; luego degradación (plantilla determinista) o DLQ |
| `DecisionLowConfidenceError` | no | revisión/handoff; nunca “reintentar hasta que acierte” |
| `BrowserError.transient` (timeout, red) | sí | 2 reintentos; screenshot en cada fallo |
| `CaptchaDetectedError` / login requerido | **no** | `REQUIRES_HUMAN_ACTION` + notificación |
| `SubmissionUncertainError` | **no** | reconciliación obligatoria o humano |
| `ValidationError` / `SourcePermanentError` | no | cuarentena + DLQ + alerta |
| `BudgetExceededError` | no | pausa de la cola afectada |
| `ConflictError` (duplicado) | no | resultado idempotente; job descartado |

- `attempts`/`backoff` por tipo de job.
- Agotar reintentos → tabla `dead_letter` con payload y trace; replay por CLI/UI.

## 5. Rate limiting

Tres dimensiones: **por discovery source** (búsquedas/fetch), **por target/cuenta** (automatización y envíos por sesión), **por operación** (cuotas globales: aplicaciones/día, `maxDailyPerTarget`, presupuesto IA).

Implementación: BullMQ rate limiter + token buckets en Redis (contadores atómicos con TTL). Los límites se validan antes de encolar (API) y antes de ejecutar (worker). Todo bloqueo es observable (`rate_limit_blocked_total`) y visible en UI con razón. Las llamadas a Jev (70–500 ms, costo mínimo) no requieren throttling propio, pero se contabilizan en `ai_usage` y están sujetas al presupuesto mensual.

## 6. Envío idempotente (protocolo, corregido)

```
APPROVED
  │ acquire lock: SETNX submit-<applicationId>  (TTL 15 min)
  ▼
ledger.claim(idempotencyKey)            ← sólo submits REALES; UNIQUE
  │ si existe confirmed → terminar (ya enviada)
  │ si existe uncertain → NO submit; exigir reconcileSubmission
  ▼
preflight: target activo + sesión válida + reconcile (¿ya enviada?) + snapshot coincide
  │ discrepancia con preparationSnapshot → volver a PREPARING con evento
  ▼
submitApplication(dryRun)   ← dryRun=true: ejecuta y registra en automation_run/eventos,
  │                            NO toca el ledger, NO produce efecto externo
  ▼
resultado
  │ confirmed  → ledger=confirmed → SUBMITTED
  │ uncertain  → ledger=uncertain → REQUIRES_HUMAN_ACTION (reconciliación obligatoria)
  │ rejected_validation → PREPARING (nueva preparación) con ledger=failed resuelto
  │ failed     → ledger=failed → FAILED (retry sólo con reconciliación previa)
```

Regla absoluta: **un intento `uncertain` nunca permite un segundo submit automático** hasta completar reconciliación. DRY_RUN se registra en `automation_run` (`dry_run=true`), `application_event` y `audit_log`; nunca como estado del ledger.

## 7. Browser worker: aislamiento y privilegios (corrección Fase 0.1)

Estrategia elegida: **A + B combinadas**.

- **A. Rol de DB limitado**: el browser worker usa un rol PostgreSQL sin privilegios sobre `application*`; sólo puede `INSERT/UPDATE` en `browser_session`, `automation_run` y escribir artefactos vía `StoragePort`. Lectura mínima de `job`/`application_target` para contexto.
- **B. Resultados vía BullMQ**: el browser worker publica el resultado (outcome, artefactos, errores) en la cola `apply-results`; el worker de aplicación (`application-engine`) consume y es el **único** que transiciona `Application` y escribe `application_event`.
- Justificación: mínimo privilegio + ownership claro; un compromiso del browser worker (la superficie más expuesta) no puede corromper el estado de candidaturas.
- `browser_session` y `automation_run` incluyen `application_target_id` y (automation_run) `application_id` y `browser_session_id` para trazabilidad completa: sesión → cuenta → adapter → aplicación → intento.

## 8. Ciclo de vida del worker

- Arranque: validar config (Zod) → DB/Redis → reconciliar schedulers → consumidores → `readyz`.
- SIGTERM: dejar de aceptar, terminar job en curso hasta timeout, cerrar contexts, liberar locks; stalled jobs se re-entregan (idempotentes).
- `lockDuration`/`stalledInterval` por cola; los jobs de navegación renuevan lock explícitamente.
- Contenedores: `worker` general y `browser-worker` (perfil Compose aparte, red restringida, rol DB limitado). Escalado horizontal futuro: más réplicas; los locks de aplicación evitan dobles envíos.

## 9. Observabilidad por cola

- Métricas: `queue_waiting/active/failed`, `job_duration_seconds`, `job_retries_total`, `source_failure_rate`, `target_failure_rate`, `rate_limit_blocked_total`, `decision_low_confidence_total`, `submit_uncertain_total`.
- Logs Pino con `correlationId`, `jobId`, `sourceId`, `applicationTargetId`, `applicationId`, `attempt`.
- Alertas mínimas: fuente con fallo > 50 %/h; DLQ no vacía; presupuesto IA > 80 %; `uncertain` sin resolver > 24 h.