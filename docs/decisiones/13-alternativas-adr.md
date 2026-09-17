# 13 — ADRs, alternativas, contradicciones y overengineering

Formato: Contexto → Opciones → Decisión → Consecuencias.
Revisión Fase 0.1: ADR-012 reescrito (Jev); nuevos ADR-013 a ADR-021. Decisiones abiertas actualizadas (P1 resuelta).

---

## ADR-001 — Forma arquitectónica: modular monolith con workers

**Contexto:** un desarrollador, dominio amplio, operaciones largas y frágiles (IA, scraping, navegador).
**Opciones:** (a) Next.js full-stack; (b) modular monolith con apps web/api/worker; (c) microservicios.
**Decisión:** (b). API y workers separados; packages de dominio puros; browser worker aislado.
**Consecuencias:** despliegue simple, aislamiento de fallos, escalado futuro sin rediseño. (a) mezcla dominio/transporte; (c) overengineering.

## ADR-002 — Modelo de ofertas: `job_listing` + `job` canónico

**Contexto:** la misma vacante aparece en varias fuentes; se necesita provenance y dedup.
**Opciones:** (a) tabla única con `canonical_id`; (b) listing + canónico.
**Decisión:** (b).
**Consecuencias:** provenance completa y merge auditable; un join más. (a) complica historial y estado por fuente.

## ADR-003 — Deduplicación determinista por capas; IA excluida

**Contexto:** falsos positivos y negativos son costosos.
**Opciones:** (a) claves exactas; (b) capas exactas + fuzzy con zona gris; (c) embeddings como mecanismo principal.
**Decisión:** (b). Embeddings sólo sugieren candidatos para revisión (L4, Fase 3+).
**Consecuencias:** reproducible y testeable; trabajo manual acotado en zona gris.

## ADR-004 — Colas por dominio, rate limit por fuente/target

**Contexto:** operaciones heterogéneas con límites externos y prioridades distintas.
**Opciones:** (a) cola única; (b) por dominio; (c) por fuente/target.
**Decisión:** (b) + token buckets por fuente/target; `automation` consumida por browser worker; `apply-results` de vuelta al worker de aplicación.
**Consecuencias:** aislamiento y concurrencia ajustable; más configuración. (a) bloquea envíos por fallos de scraping; (c) explosión operativa.

## ADR-005 — Matching híbrido explicable

**Contexto:** score con desglose y razones; los LLM no son reproducibles ni baratos por oferta.
**Opciones:** (a) sólo determinista; (b) híbrido; (c) LLM puntúa.
**Decisión:** (b); LLM sólo redacta explicaciones; requisitos duros topan el score.
**Consecuencias:** reproducible, barato, explicable. (c) descartada por costo/sesgo/no determinismo.

## ADR-006 — Puertos de IA en core; implementaciones en packages/ai

**Contexto:** riesgo de acoplar dominio a SDKs y de sobre-abstraer.
**Opciones:** (a) SDK directo; (b) puertos finos (`TextGenerationPort`, `EmbeddingProvider`, `DecisionProvider`) + implementaciones inyectadas; (c) framework propio de plugins.
**Decisión:** (b). `matching`, `documents`, `application-engine` nunca importan `packages/ai`.
**Consecuencias:** cambiar proveedor es configuración; se renuncia a features específicas no expuestas por los puertos. (c) descartada.

## ADR-007 — Envío idempotente con ledger y reconciliación

**Contexto:** un envío duplicado es irreversible.
**Opciones:** (a) retry simple; (b) ledger de intentos reales + reconciliación obligatoria; (c) sin automatización.
**Decisión:** (b). `uncertain` ⇒ `REQUIRES_HUMAN_ACTION`; jamás segundo submit ciego.
**Consecuencias:** más estados; máxima seguridad. (a) descartada por riesgo.

## ADR-008 — Sesiones de navegador: reutilizar sesión humana, nunca credenciales

**Contexto:** login scriptado con credenciales viola ToS y es frágil (2FA).
**Opciones:** (a) credenciales guardadas; (b) `storageState` de login humano, cifrado; (c) sin persistencia.
**Decisión:** (b).
**Consecuencias:** menos automatización desatendida en plataformas con login; seguridad y cumplimiento superiores. (a) prohibida.

## ADR-009 — Encolado post-commit; outbox diferido

**Contexto:** Postgres y Redis no comparten transacción.
**Opciones:** (a) outbox desde día 1; (b) post-commit + `reconcile_pending`; (c) ignorar.
**Decisión:** (b); evaluar (a) en Fase 7.
**Consecuencias:** simplicidad temprana; requiere reconciliador idempotente.

## ADR-010 — Auth v1: sesión single-user simple

**Contexto:** app personal con PII.
**Opciones:** (a) sin auth; (b) sesión simple; (c) JWT + RBAC.
**Decisión:** (b). Modelo de datos preparado para multi-candidato.
**Consecuencias:** simple y seguro; trabajo futuro si se abre a terceros (aceptado).

## ADR-011 — `StoragePort` con backend local/S3-compatible

**Contexto:** CVs, screenshots y traces no pertenecen a Postgres ni a un cloud concreto.
**Decisión:** puerto con backend local (dev) y S3-compatible (prod futuro).
**Consecuencias:** desarrollo local sin nube; migración trivial.

## ADR-012 — Jev como `DecisionProvider`: decisiones tipadas entre opciones acotadas

**Contexto:** JEV es **Jev**, System One Model de TypeSafe AI: estado no estructurado → decisiones tipadas con probabilidades calibradas; sin generación de texto; 70–500 ms; costo muy bajo; early access (ADR confirmado por el dueño en Fase 0.1).
**Opciones:**
- J0 sin Jev (sólo determinista);
- J1 Jev como decisor acotado (mapeo de campos, acción de navegación, clasificación, guardrail) con umbrales de confianza;
- J2 Jev como agente de navegación completo;
- J3 sólo diagnóstico/login.
**Decisión:** J1. Jev **nunca** redacta, inventa datos, decide envíos/aplicaciones, resuelve CAPTCHA ni hace submit. El LLM redacta; el código valida; Playwright ejecuta. Fallback: `LLMDecisionAdapter`/heurísticas (mismo puerto).
**Consecuencias:** mayor cobertura de formularios sin agentes frágiles; exige medir calibración propia (`decision_log`) antes de relajar umbrales; dependencia de proveedor joven mitigada por el puerto. J2 descartado en v1.

## ADR-013 — Separación `DiscoverySource` / `ApplicationTarget`

**Contexto:** una oferta descubierta en un agregador puede aplicar en Greenhouse. `source_id` único mezclaba descubrimiento y destino, rompiendo políticas, rate limits, sesiones y auditoría.
**Opciones:** (a) mantener `source_id` con un campo `apply_method`; (b) entidad `application_target` separada, referenciada por listing y Job canónico; (c) múltiples targets por Job con selección en runtime.
**Decisión:** (b). El Job canónico resuelve **un target primario** por evidencia (redirect > metadata > patrón > manual); sin target resoluble → no AUTO.
**Consecuencias:** políticas/allowlists y sesiones por destino real; trazabilidad clara. (c) descartado en v1: el caso multi-target legítimo se modela como Jobs separados (dedup no debe fusionarlos); excepción documentada.

## ADR-014 — Identidad y versionado de `JobMatch`

**Contexto:** `UNIQUE(job, candidate, engineVersion)` no capturaba cambios de contenido de la oferta, perfil, CVs ni espacio de embeddings; colisionaba o duplicaba incorrectamente.
**Opciones:** (a) sobrescribir match por (job, candidato); (b) identidad completa con `identity_hash` + histórico inmutable + `isCurrent`; (c) borrar y recalcular.
**Decisión:** (b): `identity_hash = sha256(engineVersion | weightsVersion | jobContentHash | candidateProfileHash | resumeSetHash | embeddingSpaceId)`; UNIQUE por identidad; partial unique de `isCurrent`.
**Consecuencias:** recomputación idempotente, histórico comparable y auditable; algo más de almacenamiento. (a)/(c) pierden trazabilidad.

## ADR-015 — `SubmissionPort` de dominio vs detalles de Playwright

**Contexto:** `BrowserPort` exponía `BrowserContext`/`Page`/handles al dominio: fuga de infraestructura y acoplamiento a Playwright.
**Opciones:** (a) mantener `BrowserPort` con tipos del navegador; (b) `SubmissionPort` conceptual (`inspectApplication`, `prepareApplication`, `submitApplication`, `reconcileSubmission`) y adapters internos; (c) sin puerto (llamar Playwright desde application-engine).
**Decisión:** (b). Los detalles de navegador quedan encapsulados en `browser-automation`; futuros targets por API implementan el mismo puerto.
**Consecuencias:** dominio testeable con mocks; sustituir Playwright/target no toca dominio. (a)/(c) descartados por acoplamiento.

## ADR-016 — `SearchSourceRun`: fan-out por fuente sin contención

**Contexto:** `SearchRun.per_source` JSONB con varios workers terminando a la vez generaba updates concurrentes y pérdida de datos.
**Opciones:** (a) JSONB con lock optimista; (b) tabla hija `search_source_run` + finalizador idempotente; (c) una `SearchRun` por fuente.
**Decisión:** (b). Cada hijo escribe sólo su fila; el padre deriva estado/contadores al finalizar todos.
**Consecuencias:** sin contención, métricas limpias por fuente, `partial` correcto. (c) fragmenta el agregado y complica la UI.

## ADR-017 — Jerarquía única DRY_RUN/AUTO_APPLY: ENV como techo

**Contexto:** flags duplicados entre ENV, settings, política y fuentes permitían estados contradictorios (“DB habilita lo que ENV prohíbe”).
**Opciones:** (a) una sola fuente (ENV); (b) precedencia ENV > settings > policy > target > guards con ENV como hard ceiling; (c) sólo policy en DB.
**Decisión:** (b). `canRealSubmit` = conjunción completa (doc 05 §6); ninguna capa inferior relaja ENV.
**Consecuencias:** seguridad demostrable y explicable (se persiste la cadena evaluada); pequeña complejidad de evaluación. (a) pierde control fino; (c) es peligrosa (DB comprometida ⇒ envíos).

## ADR-018 — `EmbeddingSpace`: evolución de modelos de embeddings

**Contexto:** asumir un único modelo/dimensión perpetuo rompe al cambiar de proveedor (dimensiones y métricas distintas).
**Opciones:** (a) una tabla única con dimensión fija implícita; (b) registro `embedding_space` + `embedding_space_id` en cada embedding, con migración por coexistencia; (c) vector DB externa.
**Decisión:** (b). Un espacio activo por tipo; cambio de dimensión ⇒ tabla paralela por migración + re-embedding en background; pgvector se mantiene.
**Consecuencias:** migración sin downtime lógico ni pérdida de histórico; coste de almacenamiento temporal duplicado. (c) descartada (infraestructura adicional).

## ADR-019 — Factualidad por claims + provenance

**Contexto:** verificar entidades no detecta afirmaciones cuantitativas no respaldadas (“5 años con React” con sólo “React” en skills).
**Opciones:** (a) verificación de entidades (estado previo); (b) claims tipados con validación estructural y procedural (cuantitativas sólo si computables); (c) revisión humana de todo.
**Decisión:** (b): kinds sensibles obligatorios; validación determinista; fallo → eliminar/regenerar/marcar `requiresHumanInput`. Jev puede asistir como señal, no como veredicto.
**Consecuencias:** mayor carga de validación y prompts más estructurados; reducción drástica del riesgo de invención. (c) no escala.

## ADR-020 — Aislamiento y privilegios del browser worker

**Contexto:** el browser worker es la superficie más expuesta; no debe poder corromper el estado de candidaturas.
**Opciones:** (a) rol DB limitado a tablas de automatización; (b) resultados vía BullMQ al worker de aplicación; (c) servicio interno dedicado.
**Decisión:** (a)+(b): el browser worker escribe sólo `browser_session`, `automation_run` y artefactos; publica resultados en `apply-results`; `application-engine` es el único que transiciona `Application`.
**Consecuencias:** mínimo privilegio y ownership claro; requiere cola de resultados y workers coordinados. (c) descartado por infraestructura adicional.

## ADR-021 — Una candidatura activa por Job canónico

**Contexto:** `UNIQUE(candidate_id, job_id, source_id)` permitía duplicados al mismo Job canónico si se descubría en varias fuentes.
**Opciones:** (a) unique por (candidate, job, source); (b) partial unique `(candidate_id, job_id) WHERE status NOT IN ('ARCHIVED','REJECTED')` + reaplicación con `supersedes`; (c) unique total sin reaplicación.
**Decisión:** (b). Reaplicar tras REJECTED requiere `supersedes_application_id`, confirmación humana y cooldown (`reapplicationCooldownDays`).
**Consecuencias:** imposible duplicar accidentalmente; reaplicación legítima auditada. (a) deja el agujero; (c) impide volver a intentarlo tras un rechazo.

---

## Contradicciones detectadas y resueltas

| # | Contradicción | Resolución (Fase 0/0.1) |
|---|---|---|
| 1 | “Sistema personal” vs. requisitos enterprise | Interfaces ahora, implementación diferida. Sin cambios |
| 2 | Modo AUTO vs. prohibición de evasión | AUTO sólo en `autoSubmitTargets` con ToS revisado; nunca por defecto (ADR-017) |
| 3 | “Nunca inventar” vs. generación automática | Claims + provenance + `requiresHumanInput` bloqueante (ADR-019) |
| 4 | Dedup determinista vs. IA | IA clasifica/extrae; jamás decide duplicados (ADR-003) |
| 5 | Fase 5 (browser) antes de Fase 6 (policy) | F5 sólo DRY_RUN; submit real nace en F6 (roadmap) |
| 6 | Observabilidad amplia vs. MVP | Métricas desde tablas + logs; Prometheus en F7 |
| 7 | Variante de CV vs. no destructividad | `resume_version` nueva con `parent_version_id`; original inmutable |
| 8 | Semántico vs. reproducibilidad | Señal cacheada por hash; score final determinista y versionado (ADR-014) |
| 9 | Rate limiting vs. cobertura | Colas + buckets; ofertas en espera, nunca rechazo silencioso |
| 10 | pgvector “cuando sea necesario” vs. F3 | `EmbeddingSpace` desde el diseño; activación en F3 (ADR-018) |
| 11 | `source_id` mezclaba descubrimiento y destino | `job_source` + `application_target` (ADR-013) |
| 12 | DRY_RUN en ledger de submits | Ledger sólo reales; dry-run en automation_run/eventos/auditoría |
| 13 | `BrowserPort` filtraba Playwright al dominio | `SubmissionPort` conceptual (ADR-015) |
| 14 | `SearchRun.per_source` JSONB con concurrencia | `SearchSourceRun` + finalizador (ADR-016) |

## Riesgos arquitectónicos residuales

1. **Encolado no transaccional** (ADR-009): reconciliador en F2; vigilar duplicados/pérdidas.
2. **Complejidad de la preparación completa** (inspect→answer→fill→snapshot): límite de 2 ciclos y snapshot congelado; tests del flujo con formularios cambiantes.
3. **Calibración de Jev no validada**: umbrales conservadores por defecto; relajación sólo con datos de `decision_log`.
4. **Deriva de targets**: nuevos ATS por target; revisión ToS y fixtures obligatorios.
5. **Browser worker como cuello de botella**: concurrencia 1–2 por cuenta; estados de espera visibles.
6. **PII en screenshots**: retención 180 días + acceso restringido.
7. **Multiplica almacenamiento de matches**: histórico por identidad; particionado futuro si crece.

## Overengineering evitado

| Tentación | Decisión |
|---|---|
| Microservicios/Kubernetes/Kafka | No |
| Event sourcing/CQRS | No (event log simple) |
| RBAC/multi-tenant temprano | No (`candidate_id` preparado) |
| Vector DB externa | No (pgvector + `EmbeddingSpace`) |
| Framework de plugins de IA | No (puertos finos) |
| Outbox transaccional día 1 | No (F7 si hace falta) |
| Paquete nuevo `application-targets` ahora | No: implementaciones en `browser-automation`; se extrae cuando aparezca el primer target por API |
| Agente de navegación total (J2) | No (ADR-012) |
| Antidetect/fingerprint evasion | Prohibido |

## Decisiones abiertas

| # | Decisión | Estado |
|---|---|---|
| P1 | Definición de JEV | **Resuelta (Fase 0.1)**: Jev (TypeSafe AI), `DecisionProvider` con opciones acotadas (ADR-012) |
| P2 | Fuentes iniciales (Fase 2) | Abierta — dueño, antes de F2 |
| P3 | Proveedor de IA de texto inicial | Abierta — antes de F3 |
| P4 | Backend de storage en prod | Abierta — antes de F7 |
| P5 | Canal de notificaciones de handoff | Abierta — antes de F5 |
| P6 | Destino de despliegue | Abierta — antes de F7 |
| P7 | Modelo de embeddings inicial (dimensiones) | Abierta — antes de F3 (define el primer `embedding_space`) |
| P8 | Umbrales de confianza por tarea para Jev | Abierta — se fijan tras el piloto F5 con datos de calibración |

## Preguntas para la revisión

1. ¿Se acepta el modelo “un target primario por Job canónico” (multi-target = Jobs separados)?
2. ¿Presupuesto mensual máximo de IA (texto + decisiones)?
3. ¿Urgencia de multiusuario en 6 meses?
4. ¿Preferencia de proveedor de texto por costo o privacidad?
5. ¿APIs oficiales de aplicación disponibles para tus fuentes prioritarias?