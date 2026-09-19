/**
 * `application-engine`: candidature lifecycle orchestration (Phase 4).
 * Pure domain orchestration: state machine, guards, idempotency and document
 * preparation flow over injected ports (repository, documents, storage, clock).
 * It never imports database/ai/apps (architecture doc 11 §3).
 */
export * from './blockers.js';
export * from './engine.js';
export * from './idempotency.js';
export * from './policy.js';
export * from './ports.js';
export * from './state-machine.js';
