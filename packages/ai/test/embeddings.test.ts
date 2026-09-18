import { describe, expect, it } from 'vitest';
import { isAppError } from '@job-system/core';
import {
  createEmbeddingProvider,
  MockEmbeddingProvider,
  OpenAiEmbeddingProvider,
} from '../src/index.js';

const trace = { correlationId: 'test-correlation' };

describe('MockEmbeddingProvider', () => {
  it('is deterministic, configurable in dimension and offline', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 16 });
    const first = await provider.embed({ text: 'hello', contentHash: 'h', embeddingSpaceId: 's', trace });
    const second = await provider.embed({ text: 'hello', contentHash: 'h', embeddingSpaceId: 's', trace });
    const other = await provider.embed({ text: 'world', contentHash: 'h2', embeddingSpaceId: 's', trace });
    expect(first).toHaveLength(16);
    expect(second).toEqual(first);
    expect(other).not.toEqual(first);
    expect(provider.calls).toBe(3);
  });

  it('produces L2-normalized vectors', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 32 });
    const vector = await provider.embed({ text: 'normalize me', contentHash: 'h', embeddingSpaceId: 's', trace });
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 10);
  });
});

describe('createEmbeddingProvider', () => {
  it('defaults to the mock provider', () => {
    const provider = createEmbeddingProvider({
      provider: 'mock',
      model: 'mock-deterministic-v1',
      dimensions: 1536,
    });
    expect(provider).toBeInstanceOf(MockEmbeddingProvider);
    expect(provider.provider).toBe('mock');
  });

  it('rejects anthropic (no embeddings API) with a typed error', () => {
    try {
      createEmbeddingProvider({ provider: 'anthropic', model: 'x', dimensions: 1536 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('AI_ERROR');
    }
  });

  it('requires credentials for real providers', () => {
    expect(() =>
      createEmbeddingProvider({ provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 }),
    ).toThrowError(/API key/);
  });
});

describe('OpenAiEmbeddingProvider', () => {
  it('parses a valid response and validates dimensions', async () => {
    const provider = new OpenAiEmbeddingProvider({
      apiKey: 'test-key',
      model: 'test-model',
      dimensions: 4,
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const vector = await provider.embed({ text: 'x', contentHash: 'h', embeddingSpaceId: 's', trace });
    expect(vector).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('fails with a typed, non-retryable error on dimension mismatch', async () => {
    const provider = new OpenAiEmbeddingProvider({
      apiKey: 'test-key',
      model: 'test-model',
      dimensions: 8,
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 }),
    });
    try {
      await provider.embed({ text: 'x', contentHash: 'h', embeddingSpaceId: 's', trace });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      expect((error as { retryable: boolean }).retryable).toBe(false);
    }
  });

  it('marks 429/5xx as retryable and 4xx as permanent', async () => {
    const make = (status: number) =>
      new OpenAiEmbeddingProvider({
        apiKey: 'test-key',
        model: 'test-model',
        dimensions: 4,
        fetchImpl: async () => new Response('rate limited', { status }),
      });
    for (const status of [429, 503]) {
      try {
        await make(status).embed({ text: 'x', contentHash: 'h', embeddingSpaceId: 's', trace });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as { retryable: boolean }).retryable).toBe(true);
      }
    }
    try {
      await make(400).embed({ text: 'x', contentHash: 'h', embeddingSpaceId: 's', trace });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { retryable: boolean }).retryable).toBe(false);
    }
  });
});
