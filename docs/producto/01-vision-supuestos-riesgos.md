# 01 — Visión, alcance, supuestos y riesgos

## 1. Resumen del sistema

Sistema personal de automatización del proceso de búsqueda de empleo con estas capacidades:

1. **Descubrimiento**: búsqueda programada de ofertas en múltiples fuentes externas.
2. **Normalización**: toda oferta se convierte a un único esquema `Job` (Zod como contrato).
3. **Deduplicación determinista**: una misma vacante publicada en varias fuentes se agrupa en un Job canónico.
4. **Filtrado y ranking**: reglas de elegibilidad (políticas) + motor de matching híbrido (determinista + semántico) que explica sus puntuaciones.
5. **Preparación de candidatura**: selección del CV adecuado, generación opcional de variante, cover letter y respuestas a preguntas — con factualidad estricta.
6. **Envío controlado**: tres modos (`MANUAL`, `ASSISTED`, `AUTO`) con política configurable, rate limiting e idempotencia.
7. **Seguimiento**: historial completo, máquina de estados, eventos auditables y estadísticas.

**Usuarios:** inicialmente un único candidato (el dueño). El modelo de datos incluye `candidate_id` desde el día 1 para no bloquear un futuro multiusuario, pero **no se implementará multi-tenancy, RBAC ni facturación en el MVP**.

## 2. Alcance

### Dentro del alcance (v1)
- Búsqueda multi-fuente, normalización, dedup, filtrado, matching explicable.
- Gestión de perfil y múltiples CVs versionados.
- Preparación de candidaturas con aprobación humana (modos MANUAL y ASSISTED completos).
- Automatización Playwright en modo `DRY_RUN` sobre un ATS simulado y 1–2 fuentes autorizadas.
- Modo AUTO limitado a fuentes con API oficial o permiso explícito, con todas las salvaguardas.
- Observabilidad local: logs estructurados + métricas agregadas + historial.

### Fuera del alcance (explícito)
- Superar CAPTCHA, evadir anti-bot, ocultar automatización, eludir controles de plataformas.
- Scraping de sitios cuyos ToS lo prohíban (cada fuente requiere revisión y allowlist).
- App móvil nativa.
- Microservicios, Kubernetes, multi-región.
- Entrenamiento o fine-tuning de modelos.
- Cualquier forma de fabricación de datos del candidato.

## 3. Supuestos

| # | Supuesto | Impacto si es falso |
|---|---|---|
| A1 | Single-user en v1 | Si se necesita multiusuario temprano, agregar auth/RBAC y revisar constraints únicos |
| A2 | Volumen moderado: ≤ 5.000 ofertas/día, ≤ 50 aplicaciones/día | Habría que escalar workers y particionar tablas antes de lo previsto |
| A3 | Preferencia por APIs oficiales/RSS/HTML estático; scraping sólo donde ToS lo permita | Reduce fuentes disponibles; más peso en automatización browser |
| A4 | Existe presupuesto medible de IA y se acepta costo variable | Sin presupuesto, matching semántico y generación documental se degradan a determinista/plantillas |
| A5 | El candidato mantiene su perfil y CVs actualizados; el sistema consume, no infiere | Documentos y respuestas pobres; `requiresHumanInput` frecuente |
| A6 | Ejecución local primero (Docker Compose), cloud-agnostic después | Decisiones de storage/secrets se ajustan, pero interfaces ya previstas |
| A7 | JEV = **Jev** (TypeSafe AI), System One Model: decisiones tipadas con probabilidades calibradas, sin generación de texto y sin entrada de imágenes (v1); acceso en early access | Si no hay acceso o la calibración no se valida, el fallback es LLM estructurado (`LLMDecisionAdapter`) o heurísticas deterministas — el puerto `DecisionProvider` lo permite sin cambios |
| A8 | Idiomas principales ES/EN; una zona horaria | Detección de idioma de ofertas y parsing de fechas se simplifican |
| A9 | Las plataformas pueden cambiar sus formularios sin aviso | La automatización es inherentemente frágil: presupuesto permanente de mantenimiento por adapter |
| A10 | `AUTO_APPLY` permanecerá deshabilitado hasta la Fase 6 y tras revisión de riesgos | No afecta fases 0–5 |
| A11 | Cada Job canónico resuelve **un target primario** de aplicación; el caso multi-target se modela como Jobs separados | Si multi-target fuese frecuente, revisar ADR-013 (selección de target por aplicación) |

## 4. Riesgos principales

Probabilidad (P) e impacto (I): A=alto, M=medio, B=bajo.

| ID | Riesgo | P | I | Mitigación principal |
|---|---|---|---|---|
| R1 | Violación de ToS / consecuencias legales por scraping o auto-envío | M | A | Allowlist de fuentes revisadas; preferencia por APIs oficiales; AUTO sólo con permiso explícito; auditoría |
| R2 | Suspensión/bloqueo de cuentas en plataformas de empleo | M | A | Rate limiting estricto, sesiones humanas reutilizadas (no credenciales compartidas), detección de señales de bloqueo, nunca evasión |
| R3 | Alucinación de IA en respuestas/documentos (inventar experiencia) | M | A | Factualidad estricta: generación restringida al perfil, validación post-generación contra fuentes, `requiresHumanInput`, revisión humana en ASSISTED |
| R4 | Duplicados mal resueltos (falsos positivos/negativos) | M | M | Dedup determinista por capas; zona gris → revisión humana; nunca merge automático con confianza media |
| R5 | Fragilidad de selectores/formularios en Playwright | A | M | Adapters versionados, fixtures, screenshots, clasificación de errores, `REQUIRES_HUMAN_ACTION` |
| R6 | Prompt injection desde job descriptions (contenido no confiable) | M | A | Tratar contenido externo como datos; salidas restringidas por schema; sin tool-calling desde contenido; delimitación y saneo |
| R7 | Aplicaciones duplicadas por reintentos o por descubrir la oferta en varias fuentes | M | A | Partial unique `(candidate_id, job_id)` activo en Postgres + ledger + reconciliación antes de reintentar |
| R8 | Costos de IA fuera de control | M | M | Presupuesto mensual con corte, routing por tarea a modelos baratos, caché, embeddings batch |
| R9 | Fuga de PII / credenciales / sesiones de navegador | B | A | Cifrado de sesiones, secret manager futuro, redacción de logs, minimización de datos, auditoría |
| R10 | Expiración de credenciales/sesiones o 2FA inesperado | A | M | Detección de login requerido → `REQUIRES_HUMAN_ACTION`; sesiones re-validables por humano |
| R11 | Drift de esquemas de fuentes (campos cambian) | A | M | Contratos Zod por fuente, cuarentena de registros inválidos, alertas por tasa de fallos |
| R12 | Sobrecarga de mantenimiento de adapters | A | M | Interfaz común mínima, adapters delgados sin lógica de negocio, tests con fixtures grabados |
| R13 | Ambigüedad salarial (rangos, monedas, bruto/neto) | A | B | Parseo conservador, `null` ante duda, nunca inventar; marcar para revisión |
| R14 | Observabilidad insuficiente para depurar fallos asíncronos | M | M | correlationId/jobId/sourceId/applicationId en todo log; run records por búsqueda; DLQ inspeccionable |
| R15 | Deuda por overengineering (ver `13`) | M | M | Regla de simplicidad: interfaces sí, infraestructura prematura no; ADR obligatorio para desviaciones |
| R16 | Dependencia de Jev en early access (disponibilidad, latencia US-West, precio introductorio, sin visión) | M | M | Puerto `DecisionProvider` con fallback a LLM estructurado/heurísticas; medir calibración propia; no diseñar asumiendo costo cero |

## 5. Contradicciones y ambigüedades detectadas (resumen)

El análisis completo está en `decisiones/13-alternativas-adr.md` (§ Contradicciones). Las tres más relevantes:

1. **“Sistema personal” vs. amplitud enterprise de requisitos** (secret manager, multi-cloud, portabilidad). Se resuelve documentando interfaces desde Fase 0 y **postergando su implementación** hasta que exista necesidad real.
2. **Modo AUTO vs. prohibición de evasión anti-bot.** El auto-envío desatendido sólo es defendible sobre APIs oficiales o plataformas que lo permitan explícitamente. Se restringe AUTO a allowlist con revisión de ToS.
3. **“Nunca inventar información” vs. “generar respuestas para formularios”.** Resolución: `requiresHumanInput` bloqueante para AUTO + validación de **claims** (las afirmaciones cuantitativas sólo se aceptan si son estrictamente computables desde el perfil, ADR-019).
4. **`source_id` mezclaba descubrimiento y destino de aplicación.** Resolución: `job_source` (dónde se descubre) y `application_target` (dónde se aplica) separados, con target primario por Job canónico (ADR-013).

## 6. Criterios de éxito del producto

- ≥ 1 fuente real integrada end-to-end (búsqueda → match → candidatura preparada) sin intervención manual de código.
- 100 % de candidaturas enviadas con historial de eventos auditable y documentos versionados.
- 0 envíos en `DRY_RUN` (verificable por tests y por contadores).
- Toda puntuación de match es explicable (breakdown + razones).
- Toda respuesta generada es trazable a un dato del perfil o marcada `requiresHumanInput`.
- Toda decisión asistida por Jev queda registrada en `decision_log` con entrada, salida tipada, confianza y resultado (auto-aceptada / revisada / corregida).
- Es imposible crear dos candidaturas activas al mismo Job canónico (constraint probado).
- Ningún submit incierto produce un segundo envío automático: siempre media reconciliación.