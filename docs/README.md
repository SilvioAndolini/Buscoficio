# Documentación de arquitectura — Plataforma de búsqueda y candidatura automática de empleo

Estado: **Fase 0 — cerrada con revisión 0.1 (saneamiento aplicado)**
Fecha: 2026-09-17

Esta carpeta es la **fuente oficial de decisiones arquitectónicas** del proyecto. No contiene código de producción. Toda desviación posterior respecto de lo aquí documentado debe registrarse como ADR en `decisiones/`.

---

## Índice

| Documento | Contenido |
|---|---|
| [producto/01-vision-supuestos-riesgos.md](producto/01-vision-supuestos-riesgos.md) | Resumen del sistema, alcance, supuestos, riesgos principales |
| [arquitectura/02-arquitectura-general.md](arquitectura/02-arquitectura-general.md) | Principios, diagrama lógico, límites de módulos, flujo completo de datos |
| [arquitectura/03-modelo-de-dominio.md](arquitectura/03-modelo-de-dominio.md) | Entidades, relaciones, invariantes, máquina de estados, dedup, matching, políticas |
| [arquitectura/04-modelo-de-datos.md](arquitectura/04-modelo-de-datos.md) | Modelo preliminar PostgreSQL, índices, constraints, retención |
| [arquitectura/05-interfaces-y-contratos.md](arquitectura/05-interfaces-y-contratos.md) | Interfaces entre módulos, taxonomía de errores, eventos, API pública |
| [arquitectura/06-workers-y-colas.md](arquitectura/06-workers-y-colas.md) | Topología de colas, scheduler, idempotencia, retries, rate limiting |
| [arquitectura/07-automatizacion-web.md](arquitectura/07-automatizacion-web.md) | SubmissionPort, targets de aplicación, Playwright, errores, artefactos, handoff, Jev |
| [arquitectura/08-estrategia-ia.md](arquitectura/08-estrategia-ia.md) | Puertos de IA, Jev vs LLM, salidas estructuradas, claims + factualidad, costos |
| [arquitectura/10-testing-ci.md](arquitectura/10-testing-ci.md) | Estrategia de testing, fixtures, CI, Definition of Done |
| [arquitectura/11-estructura-repositorio.md](arquitectura/11-estructura-repositorio.md) | Monorepo, paquetes, reglas de dependencia, tooling |
| [seguridad/09-seguridad-privacidad.md](seguridad/09-seguridad-privacidad.md) | Threat model, secretos, PII, auditoría, cumplimiento |
| [producto/12-roadmap-y-criterios.md](producto/12-roadmap-y-criterios.md) | Fases 0–7, entregables y criterios de aceptación |
| [decisiones/13-alternativas-adr.md](decisiones/13-alternativas-adr.md) | ADRs, alternativas y trade-offs, contradicciones, overengineering, decisiones abiertas |

---

## Resumen ejecutivo

Plataforma **personal** (single-user en v1, preparada para multi-usuario futuro) que descubre ofertas de empleo en múltiples fuentes, las normaliza y deduplica, las filtra y puntúa contra el perfil del candidato, prepara candidaturas (CV, cover letter, respuestas) usando **exclusivamente información verídica del perfil**, y — sólo cuando las reglas y la plataforma lo permiten — las envía de forma controlada. Mantiene historial completo, seguimiento de estado y estadísticas.

**Forma arquitectónica elegida:** *modular monolith* con aplicaciones separadas (`web`, `api`, `worker`, y `browser-worker` aislado en la Fase 5) sobre packages de dominio y adaptadores, PostgreSQL como fuente de verdad, Redis/BullMQ para trabajo asíncrono, Playwright encapsulado tras `SubmissionPort`, y puertos de IA agnósticos de proveedor (LLM redacta, Jev decide entre opciones acotadas).

**Principios no negociables:**

1. El dominio no conoce infraestructura (ni Playwright, ni Fastify, ni Next.js, ni BullMQ, ni proveedores de IA, ni Redis, ni S3).
2. Toda frontera del sistema valida con Zod.
3. La deduplicación es determinista; la IA no decide duplicados.
4. La IA nunca inventa datos del candidato; si falta información → `requiresHumanInput`.
5. `AUTO_APPLY` está deshabilitado por defecto; `DRY_RUN` es el modo por defecto en desarrollo.
6. No se evade CAPTCHA ni anti-bot; cuando algo no se puede automatizar → `REQUIRES_HUMAN_ACTION`.
7. Toda operación crítica es idempotente o reconcilia estado antes de reintentar.

---

## Glosario

| Término | Significado |
|---|---|
| **JobListing** | Oferta tal como fue observada en una fuente concreta (provenance). Inmutable salvo refresco de estado. |
| **Job (canónico)** | Entidad única tras deduplicación; agrupa uno o más JobListings. Es lo que se puntúa y a lo que se postula. |
| **Discovery Source / Adapter** | Fuente donde se descubre la oferta (agregador, API, RSS) y su implementación de `JobSourceAdapter`. No es el destino de aplicación. |
| **ApplicationTarget** | Destino real de la candidatura (ATS por API o navegador, sitio corporativo, email), separado de la fuente de descubrimiento. Cada Job canónico resuelve un target primario. |
| **Match** | Resultado explicable (`overallScore` + `scoreBreakdown` + `reasons`) de comparar Job canónico con CandidateProfile. |
| **Application** | Candidatura de un candidato a un Job canónico, con máquina de estados explícita y eventos auditables. |
| **DRY_RUN** | Modo seguro: busca/analiza/genera documentos/rellena formularios controlados, pero **nunca** envía. |
| **AUTO_APPLY** | Modo de envío desatendido, sólo si ENV + settings + política + target autorizado + guards (threshold, CV, sin preguntas pendientes) se cumplen. Deshabilitado por defecto. |
| **Jev (TypeSafe)** | *System One Model* de TypeSafe AI (https://typesafe.ai): recibe estado no estructurado y devuelve **decisiones tipadas con probabilidades calibradas**; no genera texto libre, 70–500 ms por llamada, costo de entrada ~$0.042/MTok (salida gratuita). En v1 no procesa imágenes. Se usa para mapeo de formularios, navegación, clasificación y guardrails — nunca como autoridad final. Ver `arquitectura/07 §7` y `decisiones/13` ADR-012. |
| **sourceId / correlationId / jobId / applicationId** | Identificadores de trazabilidad obligatorios en logs y jobs. |

---

## Convenciones documentales

- Los fragmentos TypeScript son **bocetos de diseño**, no código compilable.
- Los identificadores de código se mantienen en inglés; los documentos, en español.
- Cuando hay más de una alternativa razonable, se documenta en `decisiones/13-alternativas-adr.md` con formato ADR (contexto → opciones → decisión → consecuencias).
- Las decisiones abiertas que requieren confirmación del dueño del producto están listadas en `decisiones/13` (§ Decisiones abiertas).

---

## Control de cambios

| Versión | Fecha | Cambios |
|---|---|---|
| Fase 0 | 2026-09-17 | Documentación inicial de arquitectura |
| Fase 0.1 | 2026-09-17 | Saneamiento: `ApplicationTarget` separado de discovery source (ADR-013); unicidad de candidatura por Job canónico (ADR-021); identidad/versionado de `JobMatch` (ADR-014); ledger sólo de submits reales; `SubmissionPort` vs detalles de Playwright (ADR-015); puertos de IA en `core` (ADR-006); `SearchSourceRun` (ADR-016); flujo de preparación completa antes de `READY_FOR_REVIEW`; jerarquía DRY_RUN/AUTO con ENV como techo (ADR-017); Jev como `DecisionProvider` (ADR-012); `EmbeddingSpace` (ADR-018); factualidad por claims (ADR-019); `browser_session_id`; `app_policy` con índices parciales; IDs BullMQ sin `:`; aislamiento y privilegios del browser worker (ADR-020) |