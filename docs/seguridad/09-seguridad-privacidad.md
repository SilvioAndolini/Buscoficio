# 09 — Seguridad y privacidad

## 1. Activos y clasificación

| Activo | Clasificación | Dónde vive |
|---|---|---|
| Datos personales del candidato (nombre, email, teléfono, CV, historial) | **PII sensible** | PostgreSQL + StoragePort (archivos) |
| Sesiones de navegador (`storageState`) | **Secreto** | Cifrado en reposo (columna `bytea`) |
| Claves de IA / APIs | **Secreto** | `SecretProvider` (env hoy, secret manager futuro) |
| Tokens de sesión de la app | **Secreto** | Cookie HttpOnly firmada |
| Descripciones de ofertas y HTML scrapeado | Datos de terceros **no confiables** | PostgreSQL / artefactos |

## 2. Threat model (resumen)

| Amenaza | Vector | Mitigación |
|---|---|---|
| Robo de credenciales/sesiones | logs, repos, backups, malware local | Sin secretos en código/git; redacción Pino; cifrado; gitleaks en CI |
| Prompt injection | job descriptions, HTML de formularios | Contenido como dato; schemas de salida; sin tool-calling desde contenido; verificación factual |
| Fuga de PII en logs | `console.log`, errores con payload | Pino `redact` obligatorio; revisión en PR; tests de redacción |
| Duplicación de envíos | reintentos, race conditions | Constraints únicos + ledger + reconciliación (docs 04/06) |
| Bloqueo de cuentas por automatización | ritmo, patrones | Rate limiting estricto, no evasión, horarios humanos, handoff |
| Acceso no autorizado a la API | red local expuesta | Auth de sesión, bind a localhost por defecto, CORS cerrado |
| Supply chain | dependencias comprometidas | lockfile, `pnpm audit` en CI, revisión de deps nuevas (regla 26) |
| Exposición de PII a proveedores de IA | prompts con datos del candidato | Minimización (`ProfileFactsView`), redacción de estado en decisiones Jev, zero-retention cuando exista; revisar términos de TypeSafe (early access) |
| Compromiso del browser worker | superficie más expuesta (navegador) | Rol DB limitado (sin `application*`); resultados vía `apply-results`; artefactos aislados (ADR-020) |
| Borrado accidental de datos | migraciones, jobs | Backups diarios, migraciones forward-only revisadas, retención |

Fuera de alcance v1: protección frente a atacante con acceso root a la máquina del candidato.

## 3. Gestión de secretos

- **Regla dura**: ningún secreto en código, tests, fixtures, documentación ni git. `.env` en `.gitignore`; `.env.example` con placeholders.
- `SecretProvider` (puerto) con implementación `EnvSecretProvider` en v1. **Futuro**: `AwsSecretsManagerProvider` / `DopplerProvider` sin cambiar el dominio.
- Claves de IA y credenciales de plataforma con rotación documentada (runbook).
- CI: `gitleaks`/`trufflehog` como step bloqueante.

## 4. Contenido externo no confiable (anti prompt-injection)

1. Todo texto proveniente de fuentes externas se etiqueta y delimita (`<untrusted_source>…</untrusted_source>`).
2. El sistema nunca ejecuta acciones dictadas por contenido (links, instrucciones, “ignora lo anterior”).
3. Las salidas de IA son siempre estructuradas y validadas; el texto libre sólo se usa para redactar documentos revisables.
4. Detección heurística de inyección en job descriptions (frases tipo “ignore previous instructions”) → marca `suspicious_content`; señal complementaria `guardrail_check` (Jev) con confianza, y revisión humana.
5. El HTML scrapeado se sanea antes de almacenarse (scripts, handlers, iframes eliminados) y nunca se renderiza en la UI sin sanitizar.

## 5. PII: minimización y ciclo de vida

- Recoger sólo lo necesario para candidaturas (regla 17.5: no almacenar datos innecesarios).
- `raw` de listings con retención corta (90 días) y redacción de datos de contacto de terceros.
- Artefactos de automatización (screenshots pueden contener PII) con retención 180 días y acceso restringido.
- Borrado a petición: procedimiento documentado que purga PII de Postgres, storage y backups (backups expiran en ≤ 30 días).
- Export: `GET /v1/export` futuro (no v1) para portabilidad del candidato.

## 6. Autenticación y autorización de la app

- v1 single-user: sesión con cookie `HttpOnly`, `SameSite=Lax`, `Secure` en prod; credencial única configurada fuera del repo (hash en config, nunca la contraseña).
- La API escucha en localhost por defecto; exponerla requiere TLS (reverse proxy) y revisión explícita.
- CORS: sólo el origen del frontend.
- Rate limiting de endpoints sensibles (login, submit, export).
- Sin RBAC en v1; el modelo de datos ya soporta `candidate_id` para futura separación por usuario.

## 7. Auditoría

- `audit_log` append-only para: cambios de perfil/CV, creación/edición de políticas, transiciones de candidatura, aprobaciones, envíos, cambios de configuración de fuentes, resoluciones de `REQUIRES_HUMAN_ACTION`.
- Cada registro: actor (`user`/`system`/`job`), acción, entidad, `before/after` **redactados**, `correlationId`, IP.
- Retención 2 años; sin secretos ni PII innecesaria en payloads.

## 8. Infraestructura

- Docker Compose dev: red interna; Postgres/Redis no expuestos salvo a localhost.
- Producción futura: contenedores sin root, volúmenes mínimos, TLS terminado en proxy, backups cifrados.
- Browser worker: contenedor separado con **rol PostgreSQL limitado** (sólo `browser_session` y `automation_run`; artefactos vía `StoragePort`); no puede modificar `application` ni `application_event`; publica resultados en la cola `apply-results` y `application-engine` aplica las transiciones (ADR-020).
- `storageState` por `application_target`/cuenta, cifrado en reposo; desencriptado sólo en memoria del browser worker.
- Principio de menor privilegio en DB: roles `app` (sin DDL), `migrations` (DDL) y `browser_worker` (limitado) — implementación progresiva, obligatoria desde Fase 5.

## 9. Cumplimiento y reglas de plataforma

- Cada fuente de descubrimiento y cada `application_target` requieren revisión de ToS registrada (`policy_notes`) antes de activarse; el estado `blocked` impide cualquier operación.
- Preferencia por APIs/integraciones oficiales; el auto-submit sólo sobre targets en `autoSubmitTargets` con permiso explícito.
- No se implementa ningún mecanismo de evasión (CAPTCHA, anti-bot, fingerprints, proxies rotativos para ocultar origen).
- Retención y borrado compatibles con GDPR básico (base legal: interés propio del candidato sobre sus propios datos).

## 10. Criterios de aceptación de seguridad

- `gitleaks` en verde y revisión manual de secretos en PR.
- Test que verifica redacción de campos sensibles en logs (email, teléfono, tokens, storageState).
- Test de inyección: job description maliciosa no altera el flujo ni produce acciones.
- `storageState` ilegible en claro en la DB (test de cifrado).
- Toda transición sensible aparece en `audit_log` (test de auditoría).
- `DRY_RUN` impide submits incluso con `AUTO_APPLY_ENABLED=true` (test de guardas).
- El rol del browser worker no puede escribir `application`/`application_event` (test de permisos).
- Ninguna combinación de `settings`/`app_policy` habilita submit con ENV en contra (test de jerarquía, ADR-017).