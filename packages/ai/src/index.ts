/**
 * `packages/ai` implements the core AI ports: EmbeddingProvider (Phase 3),
 * TextGenerationPort and DecisionProvider (Phase 4). Prompts live in
 * `packages/ai/prompts/<task>/v<N>.ts` and are versioned in code.
 */
export * from './embeddings/index.js';
export * from './text/index.js';
export * from './decision/index.js';

export const PACKAGE_PHASE = 'ai:phase-4' as const;
