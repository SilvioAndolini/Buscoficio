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

/**
 * Minimal runtime identity of an embedding implementation. Shared by the
 * worker (bootstrap/service) and the API (space activation) so compatibility
 * is decided by one pure function, never duplicated.
 */
export interface EmbeddingRuntimeDescriptor {
  provider: string;
  model: string;
  dimensions: number;
}

export interface EmbeddingSpaceDescriptor {
  provider: string;
  model: string;
  dimensions: number;
}

export interface EmbeddingCompatibility {
  compatible: boolean;
  /** Safe, loggable mismatch descriptions (no credentials). */
  mismatches: string[];
}

/**
 * Strict binding rule: a vector written into a space MUST come from the same
 * provider+model+dimensions the space declares. Dimensions alone are not
 * enough (two different models can share a dimension).
 */
export function embeddingRuntimeMatchesSpace(
  space: EmbeddingSpaceDescriptor,
  runtime: EmbeddingRuntimeDescriptor,
): EmbeddingCompatibility {
  const mismatches: string[] = [];
  if (space.provider !== runtime.provider) {
    mismatches.push(`provider: space '${space.provider}' vs runtime '${runtime.provider}'`);
  }
  if (space.model !== runtime.model) {
    mismatches.push(`model: space '${space.model}' vs runtime '${runtime.model}'`);
  }
  if (space.dimensions !== runtime.dimensions) {
    mismatches.push(
      `dimensions: space ${space.dimensions} vs runtime ${runtime.dimensions}`,
    );
  }
  return { compatible: mismatches.length === 0, mismatches };
}
