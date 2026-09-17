# 10 — Estrategia de testing y CI

## 1. Pirámide de tests

| Nivel | Herramienta | Qué cubre | Regla |
|---|---|---|---|
| **Unit** | Vitest | `core` (state machine, policies, dedup keys, normalización, scoring), utilidades puras | Rápidos, sin I/O, obligatorios en cada PR |
| **Integration** | Vitest + Testcontainers (Postgres/Redis reales) | Repositorios, transacciones, constraints, colas (BullMQ), servicios con DB | Aíslan el componente con dependencias reales |
| **Contract** | Vitest | Adapters de descubrimiento y `SubmissionPort` contra fixtures grabados; puertos de IA contra schemas | Fixtures versionados en repo |
| **E2E** | Playwright | Flujo completo web→api→worker con fuente mock y ATS simulado | **Nunca** contra plataformas reales |
| **Evals IA** | Vitest + MockProvider (CI) / suite live (manual) | Extracción, factualidad, calibración de decisiones (Jev) | Fixtures dorados |

## 2. Qué se prueba por componente

- **Dedup**: tablas de casos L0–L3 (mismo externalId, URL con tracking params, títulos con sufijos, descripciones reformateadas, falsos positivos que NO deben mergear, zona gris → review).
- **State machine**: toda transición válida e inválida; ninguna transición ilegal permitida; eventos generados en la misma tx.
- **Policy engine**: cada regla por separado y combinaciones; toda decisión incluye `appliedRules` y razones.
- **Matching**: reproducibilidad con misma `engineVersion`; señales ausentes; pesos configurables; requisitos duros que topean el score.
- **Factualidad**: respuestas con entidades inventadas deben ser rechazadas; preguntas sin dato → `requiresHumanInput`; banco de respuestas.
- **Normalización**: cada fuente tiene fixtures reales (anonimizados) y un test de contrato que valida `NormalizedJob` con Zod; datos malformados → cuarentena, no crash.
- **Idempotencia**: ingesta duplicada no crea listings; match repetido no duplica; submit con mismo ledger no reenvía.
- **Rate limiting**: excesos bloqueados y observables; cuotas diarias.
- **DRY_RUN**: E2E que verifica que ningún submit sale; guarda de capa baja (DryRunGuard) testeada aisladamente.
- **Reconciliación**: simular submit incierto → no segundo submit; simular “ya enviada” → `SUBMITTED` sin reenvío.
- **Seguridad**: redacción de logs, cifrado de sesiones, prompt injection.
- **Decisiones asistidas (Jev)**: confianza bajo umbral → nunca acción automática; `decision_log` registrado; calibración medida con fixtures.
- **Jerarquía DRY_RUN/AUTO**: ninguna combinación de settings/policy habilita submit con ENV en contra.
- **Unicidad y ledger**: imposible duplicar candidatura activa al mismo Job; `uncertain` nunca reintenta automáticamente.
- **Claims**: afirmaciones cuantitativas no computables y categóricas sin respaldo son rechazadas.
- **Targets**: resolución de `application_target` (redirect/host/metadata); sin target resoluble no hay AUTO.
- **Identidad de match**: recomputación idempotente; cambio de oferta/perfil/CV genera nuevo `identity_hash`.

## 3. Fixtures y mocks

```
packages/job-sources/test/fixtures/<source>/       # payloads crudos grabados + expected NormalizedJob
packages/browser-automation/test/fixtures/         # HTML de formularios; fake-ats servido local
packages/ai/test/fixtures/                         # prompts dorados + salidas esperadas
apps/worker/test/                                  # integración de colas con Redis real
```

- `MockJobSourceAdapter`: fuente determinista para tests (paginación, errores, duplicados, expiración).
- `MockProvider` (IA): respuestas canned validadas por schema; permite simular JSON inválido y alucinaciones.
- `MockDecisionProvider`: decisiones canned con confianzas configurables (incluye esquemas inválidos y casos de baja confianza → revisión/handoff).
- **Fake ATS**: app estática local que emula un ATS (login, upload, preguntas, confirmación, CAPTCHA simulado). Es la única “plataforma” usada en E2E.
- Datos personales en fixtures: ficticios, nunca del candidato real.

## 4. Entornos de test

- `docker compose -f docker-compose.test.yml` con Postgres + Redis efímeros (Testcontainers los levanta por test suite cuando sea posible).
- Migraciones aplicadas desde cero en CI para detectar drift.
- Tests de colas: Redis real, workers en proceso, `await job.waitUntilFinished()`.
- Timeouts explícitos en todos los tests de red/browser; prohibido `sleep` arbitrario (usar eventos/polling acotado).

## 5. CI (GitHub Actions)

Pipeline mínimo (requisito):

```yaml
# .github/workflows/ci.yml (conceptual)
jobs:
  ci:
    steps:
      - pnpm install --frozen-lockfile
      - pnpm turbo lint          # ESLint + reglas de arquitectura (boundaries)
      - pnpm turbo typecheck     # tsc --noEmit en todo el monorepo
      - pnpm turbo test          # Vitest unit + integration (Testcontainers)
      - pnpm turbo build         # build de apps y packages
  e2e:                           # sólo en main / PRs etiquetados
      - docker compose up -d db redis
      - pnpm --filter worker db:migrate
      - pnpm turbo test:e2e      # Playwright con fake-ats
  security:
      - gitleaks
      - pnpm audit --prod (no bloqueante en dev deps críticas, revisado)
```

Reglas: cache de pnpm/turbo; un solo runner en v1; E2E no bloqueante para PRs pequeños pero **obligatorio para cambios en `application-engine`, `browser-automation` o políticas**.

## 6. Cobertura

- Objetivo: **≥ 90 % en `core`** (lógica de decisión), ≥ 70 % en servicios, sin objetivo numérico en adapters (se exige contract tests).
- Cobertura no es criterio de merge por sí sola; los escenarios críticos listados en §2 sí lo son.

## 7. Definition of Done (requisito 25, aplicado)

Una feature está terminada sólo si:

1. Compila (`pnpm turbo build`).
2. `typecheck` pasa (strict, sin `any` injustificado).
3. `lint` pasa (incluidas reglas de dependencia entre paquetes).
4. Tests relevantes pasan (unit + integration; E2E si toca flujos críticos).
5. Errores conocidos manejados con taxonomía del doc 05 (no `throw new Error`).
6. Documentación actualizada (README del paquete o doc de arquitectura si cambia un contrato).
7. Sin secretos ni PII en código/fixtures.
8. No rompe interfaces existentes (o incluye ADR + migración).

## 8. Prohibiciones en tests

- No realizar aplicaciones reales (ni “de prueba”) en plataformas externas.
- No usar credenciales reales en CI.
- No depender de red externa en unit/integration (salvo suite live manual y etiquetada).
- No tests dependientes del orden ni del reloj real (inyectar `Clock`).