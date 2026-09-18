import { sha256Hex, type EmbeddingProvider, type EmbeddingRequest } from '@job-system/core';

export interface MockEmbeddingProviderOptions {
  model?: string;
  dimensions?: number;
}

/**
 * Deterministic offline provider for CI and tests.
 * Same text -> same vector (seeded PRNG over sha256(text), L2-normalized).
 * It does NOT represent real semantics; it only guarantees stable geometry.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'mock';
  readonly model: string;
  readonly dimensions: number;
  private callCount = 0;

  constructor(options: MockEmbeddingProviderOptions = {}) {
    this.model = options.model ?? 'mock-deterministic-v1';
    this.dimensions = options.dimensions ?? 1536;
  }

  /** Number of actual embed() calls; the cache test asserts it does not grow. */
  get calls(): number {
    return this.callCount;
  }

  async embed(request: EmbeddingRequest): Promise<number[]> {
    this.callCount += 1;
    const seedHex = sha256Hex(`${this.model}|${request.text}`).slice(0, 8);
    let state = Number.parseInt(seedHex, 16) >>> 0;
    const vector = new Array<number>(this.dimensions);
    let norm = 0;
    for (let index = 0; index < this.dimensions; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const value = (state / 0xffff_ffff) * 2 - 1;
      vector[index] = value;
      norm += value * value;
    }
    const length = Math.sqrt(norm);
    if (length === 0) return vector;
    return vector.map((value) => value / length);
  }
}
