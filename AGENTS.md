# AGENTS.md

Guía para agentes que trabajen en este repositorio. **La fuente de verdad arquitectónica está en `docs/`** (Fase 0/0.1 aprobada). No rediseñar; si algo la contradice, detenerse y documentarlo.

## Comandos

```bash
pnpm install --frozen-lockfile
pnpm turbo lint          # ESLint + boundaries (incluye self-test de check-arch)
pnpm turbo typecheck     # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
pnpm turbo test          # unit + integración (integración se omite sin TEST_DATABASE_URL/TEST_REDIS_URL)
pnpm test:integration    # levanta Postgres/Redis reales y ejecuta TODO
pnpm test:e2e            # smoke Playwright (build + compose + api + worker + web)
pnpm test:live           # suite live manual contra APIs reales (fuera de CI)
pnpm record:fixtures     # regraba fixtures anonimizados de las fuentes reales
pnpm turbo build         # tsup (api/worker) + next build (web)
pnpm db:migrate          # requiere DATABASE_URL
```

## Reglas duras

1. **Boundaries** (verificadas por `scripts/check-arch.mjs`): `core`/`shared` sin dependencias internas; `matching`/`documents`/`application-engine` sólo puertos de `core` (nunca `packages/ai`); ningún package importa `apps/*`; `apps/web` sólo consume `/v1`.
2. **Validación Zod en toda frontera** (HTTP, colas, fuentes externas, IA).
3. **Errores**: usar la taxonomía de `@job-system/core` (`AppError` y subclases). Nada de `throw new Error` en dominio; mapear errores externos en la frontera.
4. **Idempotencia**: claves de dominio + constraints de Postgres; los job ids de BullMQ nunca son el mecanismo de idempotencia (formato `componente-id-sufijo`, sin `:`).
5. **DRY_RUN=true / AUTO_APPLY_ENABLED=false** por defecto. ENV es techo inmutable; settings/políticas sólo restringen.
6. **Sin secretos ni PII real en código, tests ni fixtures.** Pino redacta campos sensibles; no añadir `console.log` (lint lo bloquea).
7. **No adelantar fases**: los paquetes de fases 3–7 son placeholders; su funcionalidad no se implementa hasta su fase (ver `docs/producto/12`).
8. **No modificar migraciones ya aplicadas**; cambios de schema → `db:generate` + revisión.

## Flujo de trabajo

- Cambios pequeños y coherentes; tests después de cada bloque.
- Definition of Done: compila, typecheck, lint, tests relevantes, sin secretos, sin romper interfaces (`docs/arquitectura/10-testing-ci.md`).
- Infra de test: `docker/docker-compose.test.yml` (puertos 55432 Postgres, 56379 Redis).
- Los tests de integración requieren env `TEST_DATABASE_URL` y `TEST_REDIS_URL`; nunca sustituir Postgres/Redis por mocks.

## Contexto de fase

Fase 1 (Foundation) completada. **Fase 2 (Job Discovery) completada**: 3 fuentes reales por API pública
(remotive, arbeitnow, remoteok) con revisión ToS en `policy_notes`, scheduler BullMQ reconciliado desde
`search_config`, fan-out `SearchRun`/`SearchSourceRun` con finalizador idempotente y watchdog, dedup L3
pg_trgm con umbrales configurables y zona gris `dedup_review` (decisión humana, nunca auto-merge), filtros
duros con razones, rate limiting Redis por fuente+operación y UI mínima de descubrimiento.
Detalles en `docs/producto/14-fuentes-y-tos.md` y `docs/plans/phase-2-job-discovery.md`.

**Fase 3 (Matching) completada + Fase 3.1 (saneamiento)**: motor determinista versionado
(`matching-v2`/`v1`) con señales deterministas + semánticas (ausentes fuera del denominador),
requisitos duros con cap y explicación, identidad completa de `JobMatch` (`identity_hash` +
`is_current` con constraints, ancla temporal `matchingAsOfDate`), binding estricto
`EmbeddingSpace`↔provider (fail-closed) con caché por `contentHash` y espacios coexistentes,
`EMBEDDING_PROVIDER` independiente de `AI_PROVIDER`, cola `match` desacoplada del discovery y UI
`/matches`. `EmbeddingProvider` se inyecta desde `packages/ai` (`EMBEDDING_PROVIDER=mock` por
defecto; jamás un LLM decide score/CV/requisitos). Detalles en `docs/plans/phase-3-matching.md`.

**Fase 4 (Application Preparation) completada + Fase 4.1 (saneamiento)**: `packages/application-engine`
(state machine completa con guardas, idempotencia de candidatura, reaplicación con `supersedes` +
cooldown, orquestación `createFromMatch`/`prepareDocuments`/`resolveQuestion`/`resolveHumanAction`/
`archive`, y `derivePreparationBlockers` puro compartido con la API) y `packages/documents`
(ProfileFactsView sin PII, validador determinista de claims con `sourceRefs`, variante de CV
determinista, cover letter con **claim completeness**: el modelo devuelve un plan de claims y el
texto final se renderiza determinísticamente —sin canal de texto libre—, banco de respuestas
revalidado). Migración `0009`: `application` (+ partial unique activa), `application_answer`,
`application_document` (append-only), `application_event` (transición atómica); `0010`: defaults
JSONB de arrays (`[]`) + normalización idempotente de `{}` legacy. `packages/ai` añade
TextGeneration (mock/OpenAI-compatible/Anthropic) y prompts versionados; Jev/DecisionProvider queda
como infraestructura (piloto en Fase 5). Sólo `verification.status === 'verified'` habilita reuse
automático (`unverifiable` y `rejected` ⇒ revisión humana). El CV usado es exactamente el
`recommendedResumeVersionId` del JobMatch (sin fallback a la última versión); la identidad de
preparación incluye `preparationAsOfDate` cuando hay experiencias abiertas. La candidatura
permanece en `PREPARING` con `preparationSnapshot = NULL`: `READY_FOR_REVIEW` exige `SubmissionPort`
(Fase 5) y está denegada por la state machine. Sin browser automation, sin submit, sin ledger, sin
AUTO. Detalles en `docs/plans/phase-4-application-preparation.md`.
Próxima: Fase 5 (browser automation + SubmissionPort).