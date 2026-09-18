/**
 * `packages/ai` implements the core AI ports (TextGeneration, Embeddings,
 * DecisionProvider). Phase 3 lands the EmbeddingProvider; text generation and
 * Jev/DecisionProvider belong to their roadmap phases.
 */
export * from './embeddings/index.js';

export const PACKAGE_PHASE = 'ai:phase-3' as const;
