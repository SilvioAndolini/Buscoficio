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

Fase 1 (Foundation) completada: perfil, CVs versionados inmutables, búsqueda mock, normalización Zod, dedup L0–L2, JobListing + Job canónico, API Fastify, worker BullMQ, UI mínima, CI y E2E. Próxima: Fase 2 (fuentes reales, scheduler, L3).