# 11 — Estructura del repositorio y reglas de dependencia

## 1. Layout

```
.
├─ apps/
│  ├─ web/                     # Next.js (UI). Consume sólo /v1
│  ├─ api/                     # Fastify: HTTP, auth, validación, encolado
│  ├─ worker/                  # BullMQ consumers + schedulers + CLI de operación
│  └─ browser-worker/          # mismo código que worker; perfil aislado, rol DB limitado (Fase 5+)
├─ packages/
│  ├─ core/                    # Dominio puro: entidades, VOs, state machine, policies, PUERTOS, errores
│  ├─ database/                # Schema Drizzle, migraciones, repositorios por agregado
│  ├─ job-sources/             # JobSourceAdapter + normalización + resolución de ApplicationTarget
│  ├─ matching/                # Motor de scoring determinista + semántico + explicación
│  ├─ ai/                      # Implementa puertos de core: TextGeneration, Embeddings, DecisionProvider (Jev)
│  ├─ documents/               # Selección/variantes de CV, cover letters, respuestas, claims
│  ├─ application-engine/      # Ciclo de vida de candidatura, idempotencia, reconciliación
│  ├─ browser-automation/      # Implementa SubmissionPort (Playwright/API por target), sessions, Jev bridge
│  ├─ observability/           # Pino, redacción, métricas, correlationId, audit helper
│  └─ shared/                  # Utilidades puras, config Zod, hashing, fechas, tipos comunes
├─ docs/                       # Esta documentación (o enlace a /documentos)
├─ docker/
│  ├─ docker-compose.yml       # dev: app, db, redis
│  ├─ docker-compose.browser.yml
│  └─ docker-compose.test.yml
├─ .github/workflows/ci.yml
├─ turbo.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json          # strict: true
└─ .env.example
```

> La documentación de arquitectura vive en `/documentos` (raíz del usuario) durante la Fase 0; al crear el repositorio se copia a `docs/` preservando esta estructura.

## 2. Responsabilidad de cada paquete

| Paquete | Hace | No hace | Depende de |
|---|---|---|---|
| `core` | Modelo de dominio, reglas, contratos | I/O, frameworks, SDKs | `zod` |
| `database` | Persistencia, migraciones, repos | Reglas de negocio | `core`, `drizzle-orm`, `pg` |
| `job-sources` | Buscar/fetch/normalizar ofertas + resolver `ApplicationTarget` | Filtrar/puntuar/aplicar | `core`, HTTP client |
| `matching` | Puntuar y explicar | Generar texto, enviar | `core` (puertos: Embedding, Decision), `shared` |
| `ai` | **Implementar** `TextGenerationPort`, `EmbeddingProvider`, `DecisionProvider` (Jev); prompts, validación, costos | Decidir negocio | `core`, SDKs IA |
| `documents` | Generar y versionar documentos + claims | Enviar, modificar originales | `core` (puertos: TextGeneration, Decision), `shared` |
| `application-engine` | Orquestar ciclo de candidatura, ledger, reconciliación | Navegar, redactar | `core`, `matching`, `documents`, puertos |
| `browser-automation` | **Implementar `SubmissionPort`** (browser/API por target); sesiones, artefactos, Jev bridge | Decidir qué/cuándo aplicar; escribir `application` | `core` (puertos), Playwright |
| `observability` | Logs/métricas/auditoría | Dominio | `core`, Pino |
| `shared` | Utilidades puras y config | Estado | `zod` |
| `apps/*` | Composición, transporte, UI | Duplicar dominio | todos (sólo ellos cablean) |

## 3. Reglas de dependencia (enforced)

```
core          ← nada del proyecto (sólo zod)
shared        ← nada del proyecto
database      ← core, shared
ai            ← core, shared (implementa puertos; única capa con SDKs de IA)
matching, documents, application-engine ← core, shared (+ puertos que consumen; NO packages/ai, NO SDKs de IA)
job-sources, browser-automation, observability ← core, shared (+ infraestructura propia)
apps/*        ← todo (composition root; inyecta implementaciones en los puertos)
```

Prohibiciones explícitas (lint de imports, `eslint-plugin-boundaries` o `dependency-cruiser`):

- `core` no puede importar Playwright, Fastify, Next.js, BullMQ, Drizzle, Redis, SDKs de IA, ni `node:fs`.
- `matching`, `documents` y `application-engine` no pueden importar `packages/ai` ni SDKs: sólo puertos de `core`.
- `browser-automation` no importa `application-engine`; publica resultados por cola (`apply-results`).
- Ningún paquete de dominio importa `apps/*`.
- `apps/web` no importa paquetes internos salvo tipos públicos (idealmente nada; sólo fetch a la API).
- Adapters no se importan entre sí (p. ej. `job-sources` no importa `browser-automation`).
- Sin dependencias circulares (verificación en CI).

## 4. Tooling

| Área | Elección | Notas |
|---|---|---|
| Package manager | pnpm (workspaces) | lockfile obligatorio |
| Orquestación | Turborepo | pipelines `lint`, `typecheck`, `test`, `build` con cache |
| TS | `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` | project references entre packages |
| Lint | ESLint + reglas de boundaries | + Prettier (formato) |
| DB | Drizzle ORM + drizzle-kit | migraciones forward-only |
| Queue | BullMQ | Redis 7 |
| Logs | Pino | `redact` configurado en `observability` |
| Tests | Vitest + Testcontainers + Playwright | ver doc 10 |
| Validación | Zod | en todas las fronteras |
| Dev env | Docker Compose | `application`, `postgres`, `redis` (+ contenedor `browser-worker` con rol DB limitado) |
| CI | GitHub Actions | install → lint → typecheck → test → build |

## 5. Convenciones de código

- Sin `any` (excepciones justificadas en comentario + issue). Preferir `unknown` + Zod.
- Errores: taxonomía de `core` (doc 05 §5); nunca strings mágicos.
- Nombres de archivos `kebab-case`; exports explícitos.
- Sin comentarios obvios; comentar sólo decisiones no evidentes.
- Commits convencionales (`feat:`, `fix:`, `docs:`, `refactor:`); PRs pequeños.
- Ramas: `main` protegida; trabajo en ramas cortas.

## 6. Configuración y entornos

- `.env.example` documenta todas las variables (doc 05 §8); validación Zod al arranque de api/worker.
- `DRY_RUN=true` y `AUTO_APPLY_ENABLED=false` por defecto en `.env.example`. ENV es techo de seguridad; settings/políticas sólo restringen (ADR-017).
- Perfiles de Compose: `dev` (todo), `test` (db+redis efímeros), `browser` (worker de navegador aislado).
- Roles PostgreSQL: `app` (sin DDL), `migrations` (DDL), `browser_worker` (sólo `browser_session` y `automation_run`; jamás `application*` — ADR-020).

## 7. Criterios de aceptación de la estructura

- `pnpm install && pnpm turbo build` funciona en máquina limpia.
- Reglas de boundaries fallan el lint si se violan (test deliberado en CI).
- Ningún paquete de dominio importa infraestructura (auditoría automatizada).
- Docker Compose levanta db+redis y los tests de integración pasan contra ellos.