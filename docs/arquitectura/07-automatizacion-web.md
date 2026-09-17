# 07 — Automatización web (Playwright), targets de aplicación y JEV

> Revisión Fase 0.1: el dominio usa `SubmissionPort` (sin detalles de Playwright), los envíos apuntan a `ApplicationTarget` (no a la fuente de descubrimiento), preparación completa antes de `READY_FOR_REVIEW`, ledger sin DRY_RUN, browser worker con rol DB limitado, Jev como decisor tipado.

## 1. Principios no negociables

1. **No evasión**: nada de resolver CAPTCHA, ocultar automatización, rotar fingerprints/IPs ni saltarse controles.
2. **Preferencia por APIs oficiales**: si el target ofrece API de aplicación, se usa la API, no el navegador.
3. **Allowlist por target**: sólo se automatiza sobre `application_target` revisados (`policy_notes`), con `status=active`.
4. **Intervención humana de primera clase**: CAPTCHA, login, 2FA, campos desconocidos o resultados inciertos → `REQUIRES_HUMAN_ACTION` con contexto y artefactos.
5. **Aislamiento**: Playwright vive sólo en `packages/browser-automation`; el dominio no conoce `BrowserContext`, `Page`, `Locator`, selectores ni handles.
6. **Mínimo privilegio**: el browser worker escribe sólo `browser_session` y `automation_run`; las transiciones de `Application` las aplica `application-engine` (doc 06 §7).

## 2. Estructura del paquete `browser-automation`

```
packages/browser-automation/
  src/
    submission-port.ts        # implementa SubmissionPort (inspect/prepare/submit/reconcile)
    targets/<target-key>/     # un adapter por ApplicationTarget (browser o API)
    browser/                  # manager, contexts, sessions (interno, no exportado al dominio)
    form/
      field-mapper.ts         # heurísticas deterministas: label/name/autocomplete/type
      decision-bridge.ts      # fallback Jev: propuestas tipadas con confianza
      answer-validator.ts     # valida claims y estructura
    errors.ts                 # transient | permanent | auth | captcha | uncertain | human_action
    artifacts.ts              # screenshots, trace.zip, HTML snapshot → StoragePort
    handoff.ts                # pausa, notificación, REQUIRES_HUMAN_ACTION
    dry-run-guard.ts          # bloqueo de submit real a bajo nivel
```

```ts
interface TargetAdapter {                    // interno al paquete
  readonly targetKey: string;
  readonly transport: 'browser' | 'api' | 'email';
  authenticate(ctx): Promise<AuthResult>;
  isAuthenticated(ctx): Promise<boolean>;
  inspect(ctx, job): Promise<ApplicationInspection>;
  prepare(ctx, job, input): Promise<PreparedSubmission>;
  submit(ctx, prepared, opts): Promise<SubmitOutcome>;
  detectExistingApplication(ctx, job): Promise<SubmissionStatus>;
}
```

Regla: los adapters **traducen** (selectores, flujos, endpoints) y **no deciden** (nada de políticas, scores, cuotas, textos). Todo llega ya decidido en `PreparationInput` y respuestas validadas.

## 3. Pipeline de preparación y envío

```
PREPARING (worker `apply`; puede abrir navegador vía SubmissionPort)
 1. Selección de CV + documentos (TextGenerationPort) + claims verificados
 2. inspectApplication(target):
      - descubre formulario real, campos, preguntas custom, uploads requeridos
      - detecta login requerido → si falta sesión: REQUIRES_HUMAN_ACTION (login asistido)
 3. Mapeo de campos:
      determinista primero (label/name/autocomplete/aria → catálogo semántico)
      ambiguo → DecisionProvider (Jev): propuesta tipada {semanticField, confianza}
      confianza < umbral_alto → revisión; < umbral_medio → REQUIRES_HUMAN_ACTION
 4. Preguntas desconocidas:
      banco de respuestas → route_question (Jev) → LLM redacta (claims validados)
      sin dato → requiresHumanInput=true
 5. prepareApplication():
      rellena el formulario (upload incluido) SIN ENVIAR
      artifacts: screenshots del formulario completo, resumen campo→valor
 6. Persiste preparationSnapshot (inmutable) + ApplicationEvent(application.prepared)
      guarda: cada campo resuelto o requiresHumanInput; docs versionados inmutables
      (máx. 2 ciclos inspect→answer; excedido → REQUIRES_HUMAN_ACTION)
 → READY_FOR_REVIEW
```

```
READY_FOR_REVIEW → APPROVED → SUBMITTING (worker `apply` → `automation` en browser worker)
 7. Lock idempotente + ledger.claim (sólo submit real)
 8. Preflight: target activo, sesión válida, reconcile (¿ya enviada?), snapshot coincide con el estado actual del formulario
 9. submitApplication(dryRun)
      dryRun=true  → registra automation_run(dry_run=true) + evento; NO toca ledger; NO efecto externo
      dryRun=false → submit real (sólo si canRealSubmit, doc 05 §6)
10. Resultado:
      confirmed → ledger=confirmed → SUBMITTED
      uncertain → ledger=uncertain → REQUIRES_HUMAN_ACTION
      rejected_validation → PREPARING (puede re-preparar y re-aprobar)
      failed → FAILED (retry sólo tras reconciliación)
11. Artefactos en cada fase (screenshots, trace, HTML) → StoragePort + automation_run
```

Los archivos (CV, cover letter) se suben desde `StoragePort`; nunca se regeneran durante el submit.

## 4. Clasificación de errores y recuperación

| Clase | Detección | Recuperación |
|---|---|---|
| `timeout` / `network` | Playwright timeout, `net::ERR_*` | retry ×2 con backoff; screenshot |
| `selector_missing` | formulario cambió | retry ×1; luego `REQUIRES_HUMAN_ACTION` (adapter desactualizado) |
| `auth_required` / `session_expired` | redirect a login | `REQUIRES_HUMAN_ACTION` (login asistido); nunca credenciales en código |
| `captcha` / `challenge` | widgets/iframes conocidos | **detener**; `REQUIRES_HUMAN_ACTION`; sin intentos de resolución |
| `validation_rejected` | errores del propio formulario | re-mapear campo; recuperable → PREPARING |
| `upload_failed` | error de subida | retry ×1; luego handoff |
| `duplicate_application` | “ya te postulaste” | marcar SUBMITTED existente; sin reenvío |
| `uncertain_outcome` | sin confirmación clara | ledger=uncertain; reconciliación obligatoria |
| `unknown` | cualquier otra | artefactos completos + handoff |

Todo fallo guarda `AutomationRun` (con `browser_session_id`, `application_target_id`, `dry_run`, clase, artefactos, duración).

## 5. Sesiones

- Una sesión por `application_target`/cuenta; `storageState` cifrado en reposo (clave vía `SecretProvider`; doc 09).
- Verificación periódica (`login_check`, baja frecuencia); expiración → `requires_login` + notificación.
- Nunca se almacenan contraseñas. Login siempre humano (ventana visible o importación de sesión).

## 6. DRY_RUN

- `DryRunGuard` a bajo nivel: aunque un bug pase las guardas superiores, en `DRY_RUN` el submit real no ocurre.
- El dry-run ejecuta **todo** el pipeline (inspect, fill, screenshots) y registra resultados en `automation_run`/eventos/auditoría; no toca el ledger de submits reales.
- Entorno E2E: **ATS simulado local** (`test-fixtures/fake-ats`): login, upload, preguntas, confirmación, CAPTCHA simulado. Prohibido apuntar a plataformas reales en CI.

## 7. JEV — Jev (TypeSafe AI) como decisor entre opciones acotadas

**Definición confirmada**: Jev es un *System One Model* de TypeSafe AI (https://typesafe.ai): estado no estructurado entra, **decisiones tipadas con probabilidades calibradas** salen. No genera texto libre, no tiene errores de tipo (garantía de esquema), 70–500 ms por llamada, costo de entrada ~$0.042/MTok (salida gratuita), cardinalidad hasta 255 opciones por pasada, sin entrada de imágenes en v1, acceso en early access.

**Rol arquitectónico**:

```
Reglas deterministas ──► suficiente ─► acción
        │
        └── ambiguo ──► DecisionProvider (Jev) ──► decisión tipada + confianza calibrada
                                                        │
                                     umbral alto ─► auto-aceptar
                                     umbral medio ─► revisión humana
                                     bajo ────────► REQUIRES_HUMAN_ACTION
                                                        ▼
                                                     adapter ──► Playwright
```

**Jev decide; el LLM redacta; el código valida; Playwright ejecuta.**

| Permitido (tareas tipadas) | Prohibido |
|---|---|
| Qué elemento de la página representa una acción | Redactar respuestas profesionales |
| Qué tipo de campo se observa | Inventar datos del candidato |
| Qué acción corresponde: continuar / retry / handoff / stop | Decidir a qué jobs aplicar |
| Seleccionar entre opciones conocidas (≤255) | Decidir si una candidatura se envía |
| Señal de guardrail (inyección, soporte factual) | Superar CAPTCHA / evadir controles |
| Clasificación de categoría de oferta | Hacer submit directamente |

Reglas de integración:

1. **Jev propone; el adapter valida y ejecuta.** Ninguna acción se ejecuta sólo por decisión del modelo.
2. **Tipado ≠ veracidad**: el esquema garantizado elimina errores de tipo, no errores semánticos; todo contenido que mencione al candidato pasa por el verificador de claims (doc 08 §5).
3. **Lote**: las decisiones independientes (todos los campos de un formulario) se piden en una sola llamada (muestreo paralelo).
4. **Auditoría**: cada propuesta se registra en `decision_log` y `automation_run` (entrada redactada, salida, confianza, umbral, outcome) para medir calibración real.
5. **Fallback**: `LLMDecisionAdapter` (LLM estructurado) o heurísticas deterministas implementan el mismo puerto; cero acoplamiento al proveedor.

Riesgos específicos: early access/waitlist; precio introductorio (el proveedor no descarta subsidio → medir costo por decisión); sin visión (los screenshots son artefactos de auditoría, no entrada del modelo); calibración no verificada en nuestro dominio → medir con `decision_log` antes de subir umbrales; evals del proveedor sesgados → validar con fixtures propios.

**Decisión**: piloto acotado en Fase 5 (mapeo de campos, selección de acción de navegación, guardrail) en **DRY_RUN** sobre fake-ATS y 1–2 targets permitidos, con métricas comparadas contra baseline determinista. Uso en respuestas (Fase 4) sólo tras validar calibración. Jev **nunca** decide envíos, dedup, elegibilidad ni score final (ADR-012).

## 8. Matriz de automatización por tipo de target

| Target | Búsqueda | Preparación | Envío | Notas |
|---|---|---|---|---|
| `ats_api` | HTTP/API | API | API (si `supportsApiSubmission`) | Preferido; candidato a AUTO |
| `ats_browser` (Greenhouse, Lever, …) | API/HTML | Browser | Browser `ASSISTED` en v1; `AUTO` sólo si ToS lo permite | Revisión legal por target |
| `company_site` | HTML | Browser | Browser `ASSISTED` | Fragilidad alta |
| `email` | — | Documentos | Envío por correo (manual/asistido) | Nunca AUTO en v1 |
| `external_unknown` | — | inspección | **No automatizable** | REQUIRES_HUMAN_ACTION / MANUAL |
| Portal con login + anti-bot fuerte | manual/HTML | Browser | **No automatizable** | Nunca evasión |

Regla: el target se resuelve desde el Job canónico (`job.application_target_id`); si es `null`/`external_unknown`, la candidatura no puede pasar a AUTO y, si el humano decide aplicar, queda `REQUIRES_HUMAN_ACTION`.

## 9. Criterios de aceptación

- 100 % de submits bloqueados con `DRY_RUN=true` (test E2E que lo demuestra).
- `READY_FOR_REVIEW` sólo se alcanza con `preparationSnapshot` completo y artefactos de revisión (test).
- Un cambio del formulario entre aprobación y submit aborta el envío (test con fake-ATS).
- CAPTCHA simulado → `REQUIRES_HUMAN_ACTION` sin intentos de resolución.
- `uncertain` no produce segundo submit automático (test de ledger + reconciliación).
- El browser worker no puede escribir `application` (test de permisos del rol DB).
- Decisiones Jev por debajo del umbral nunca desencadenan acción automática (test).
- Todo fallo produce `AutomationRun` con clase, sesión, target y screenshot.
- Adapters sin lógica de negocio y sin imports del dominio fuera de puertos (lint de boundaries).