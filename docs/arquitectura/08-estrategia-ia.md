# 08 — Estrategia de IA

> Revisión Fase 0.1: inversión de dependencias (puertos en `core`, implementaciones en `packages/ai`), `DecisionProvider` (Jev) separado de la generación de texto, `EmbeddingSpace`, factualidad basada en claims.

## 1. Puertos y dependencias (regla dura)

`matching`, `documents` y `application-engine` **no importan** `packages/ai` ni SDKs. Dependen exclusivamente de puertos declarados en `core`:

| Puerto | Uso | Implementaciones |
|---|---|---|
| `TextGenerationPort` | Redactar cover letters, respuestas, variantes/resúmenes | `OpenAIProvider`, `AnthropicProvider`, `DeepSeekProvider`, `Mock` |
| `EmbeddingProvider` | Embeddings para similitud semántica | idem + modelo de embeddings dedicado |
| `DecisionProvider` | Decisiones tipadas entre opciones acotadas (Jev) | `JevDecisionProvider` (TypeSafe), `LLMDecisionAdapter` (fallback), `Mock` |

El composition root (`apps/api` / `apps/worker`) inyecta las implementaciones. Cambiar proveedor = configuración (`AI_PROVIDER`, `DECISION_PROVIDER`), no código de dominio.

## 2. Responsabilidades separadas: Jev decide, el LLM redacta

| Capacidad | `DecisionProvider` (Jev) | `TextGenerationPort` (LLM) |
|---|---|---|
| Naturaleza | Selección tipada entre opciones acotadas, con probabilidad calibrada | Texto libre con schema opcional |
| Ejemplos | Tipo de campo; acción (continuar/retry/handoff/stop); elegir entre opciones; clasificar categoría; señal de guardrail | Cover letter; redacción de respuestas; variante de CV; explicación de match |
| Prohibido | Redactar, inventar, decidir envíos/aplicaciones, CAPTCHA, evasión, submit | Decidir acciones de navegación; sustituir validación determinista |
| Latencia/costo | 70–500 ms; entrada ~$0.042/MTok, salida gratuita | Segundos; costo por token de salida |
| Garantía | Esquema garantizado (sin errores de tipo) | Requiere parseo + validación Zod |

El LLM **valida igual que siempre**: JSON parse → Zod → reparación (máx. 1) → error. Jev elimina la clase de errores de tipo, pero **no exime de la validación semántica/factual** (§5).

## 3. Routing por tarea

| Tarea | Motor | Fallback |
|---|---|---|
| Extracción estructurada de ofertas | Jev (`classify_job_category`/extracción tipada) | reglas/keywords → LLM estructurado |
| Clasificación de categoría de oferta | Jev | keywords + catálogo |
| Mapeo de campos de formulario | Jev (`map_form_field`, `classify_field_type`) | heurísticas → LLM estructurado |
| Navegación (siguiente acción) | Jev (`choose_action`) | heurísticas deterministas |
| Routing pregunta→hecho del perfil | Jev (`route_question`) | búsqueda determinista en perfil |
| Respuestas a preguntas | banco de respuestas → Jev (routing) → LLM (redacción) | plantilla determinista |
| Guardrail factual / inyección | Jev (`guardrail_check`) como señal | verificador determinista |
| Explicación de match (`reasons`) | LLM (redacción corta) | plantilla determinista |
| Cover letter | LLM | plantilla |
| Variante de CV | LLM/plantillas | plantillas |
| Embeddings | `EmbeddingProvider` | — |

Regla de oro: **ninguna decisión de negocio** (dedup, elegibilidad, score final, selección de CV, envío) se delega a IA. Todo score final es determinista y versionado.

## 4. Embeddings y `EmbeddingSpace`

- Registro `embedding_space` (provider, model, dimensions, distanceMetric, version, status). Todo embedding referencia su espacio.
- Cambio de modelo/dimensión = nuevo espacio + re-embedding en background; los vectores antiguos coexisten hasta completar migración (ADR-018).
- Caché por `content_hash` (no re-embeber contenido sin cambios).
- pgvector, sin vector DB externa. Dimensión fija por columna `vector(N)`; política de un espacio activo por tipo (doc 04 §2.3).

## 5. Factualidad basada en claims + provenance

La verificación de entidades es necesaria pero insuficiente: mencionar “React” no prueba “5 años de experiencia profesional con React”. Toda generación relevante produce:

```ts
{ text, claims: [ { claim, kind, value?, sourceRefs: [...], verified } ] }
```

**Kinds sensibles obligatorios**: `years_experience`, `date_range`, `job_title`, `company`, `certification`, `degree`, `language_level`, `salary`, `project`, `seniority`.

Pipeline:

```
Vista mínima de hechos (ProfileFactsView, sin PII innecesaria)
   ▼
Generación (LLM) → claims estructurados
   ▼
Validación determinista por kind:
  · cuantitativas (años, fechas, salarios): sólo si son estrictamente computables
    desde el perfil (suma de rangos sin solapamiento; candidate_skill.years)
  · categóricas (cargos, empresas, títulos, certificaciones, idiomas, proyectos):
    deben coincidir con una entidad existente
   ▼
¿claim rechazado? → eliminar / regenerar (máx. 1) / requiresHumanInput
   ▼
Persistencia: application_answer.claims + verification · application_document.claims + verification
```

Reglas adicionales:

1. Prohibida toda inferencia cuantitativa no respaldada (“≈5 años porque usó React en 3 empleos”).
2. Los claims se muestran en UI con enlace a las entidades del perfil que los respaldan.
3. `requiresHumanInput=true` bloquea AUTO (invariante A4).
4. El banco de respuestas aprobadas se reutiliza por `question_hash`.
5. La señal `guardrail_check` de Jev complementa (no sustituye) al validador determinista.

## 6. Gestión de prompts y procedencia

- Prompts en `packages/ai/prompts/<task>/v<N>.ts` (revisados en PR); cada llamada registra `promptVersion`.
- Cambiar prompt = nueva versión; documentos existentes no se regeneran automáticamente.
- Persistencia de procedencia: `generated_by { provider, model, promptVersion, inputHash }` en documentos; `ai_usage` y `decision_log` para métricas.

## 7. Costos y presupuesto

- `AI_MONTHLY_BUDGET_USD` + contador en `ai_usage`; umbral → `BudgetExceededError`: se pausan tareas no críticas y se degrada a determinista/plantilla.
- Caché por `(task, model, inputHash)`; embeddings por `content_hash`.
- Routing: modelo caro sólo para cover letters aprobadas (en ASSISTED se genera al aprobar). Jev se usa intensivamente donde aporta (decisiones frecuentes y baratas).
- Reporte en `/v1/stats/ai-usage`: costo por operación/día/mes, incluido costo por decisión Jev.

## 8. Evaluación

- Fixtures dorados por tarea (ofertas anonimizadas, formularios, preguntas, pares perfil↔oferta, casos que deben rechazarse por factualidad).
- **Calibración de Jev**: medir con `decision_log` (auto_accepted vs human_overridden) y reajustar umbrales; un umbral sólo se relaja con evidencia.
- Suite CI con `Mock*` deterministas + suite live manual con presupuesto.
- Métricas: exactitud de extracción, tasa de rechazo factual, calibración (confianza vs acierto), costo por tarea.

## 9. Seguridad específica de IA

- **Contenido externo = no confiable** (job descriptions, HTML): delimitado, sin tool-calling, salidas restringidas por schema; señal `guardrail_check` para inyección (doc 09 §4).
- **PII**: minimización en prompts (`ProfileFactsView`); Jev recibe estado redactado cuando sea posible; nunca CV completo si basta un resumen.
- **Proveedores**: claves vía `SecretProvider`; rotación documentada; TLS; zero-retention cuando exista. Jev/TypeSafe está en early access (US-West): revisar términos y minimizar datos enviados.
- **Determinismo**: temperatura 0 / seed en extracción cuando el proveedor lo permita.