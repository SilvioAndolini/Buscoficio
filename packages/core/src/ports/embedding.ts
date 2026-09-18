import type { TraceContext } from './trace.js';

/**
 * Provider-agnostic embedding port (architecture docs 05 §2.2, 08 §1).
 * `matching` depends only on this contract; implementations live in
 * `packages/ai` and are injected by the composition root.
 */
export interface EmbeddingRequest {
  text: string;
  /** sha256 of the versioned embedding input; cache key (no re-embed on hit). */
  contentHash: string;
  embeddingSpaceId: string;
  trace: TraceContext;
}

export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  embed(request: EmbeddingRequest): Promise<number[]>;
}
