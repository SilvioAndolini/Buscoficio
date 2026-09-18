import { describe, expect, it } from 'vitest';
import { isAppError } from '@job-system/core';
import { cosineSimilarity, normalizeCosine, semanticSimilarity } from '../src/index.js';

describe('semantic similarity normalization', () => {
  it('identical vectors normalize to 1', () => {
    expect(semanticSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('opposite vectors normalize to 0', () => {
    expect(normalizeCosine(-1)).toBe(0);
    expect(semanticSimilarity([1, 0], [-1, 0])).toBeCloseTo(0, 10);
  });

  it('orthogonal vectors normalize to 0.5', () => {
    expect(semanticSimilarity([1, 0], [0, 1])).toBeCloseTo(0.5, 10);
  });

  it('zero vectors yield 0 cosine (documented degenerate case)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('rejects incompatible dimensions with a typed error', () => {
    try {
      cosineSimilarity([1, 2], [1, 2, 3]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('INTERNAL');
    }
  });
});
