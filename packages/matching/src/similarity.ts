import { InternalError } from '@job-system/core';

/**
 * Semantic similarity helpers. Cosine similarity lives in [-1,1]; the engine
 * works in [0,1], so the documented normalization is `(cosine + 1) / 2`.
 * Embeddings from different EmbeddingSpaces are NEVER compared.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    throw new InternalError(`cosineSimilarity: incompatible dimensions (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function normalizeCosine(cosine: number): number {
  const clamped = Math.min(1, Math.max(-1, cosine));
  return (clamped + 1) / 2;
}

export function semanticSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  return normalizeCosine(cosineSimilarity(a, b));
}
