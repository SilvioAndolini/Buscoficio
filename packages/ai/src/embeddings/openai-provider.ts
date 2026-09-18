import { z } from 'zod';
import { AiError, type EmbeddingProvider, type EmbeddingRequest } from '@job-system/core';

const EmbeddingResponseSchema = z.object({
  data: z
    .array(
      z.object({
        embedding: z.array(z.number()),
      }),
    )
    .min(1),
});

export interface OpenAiEmbeddingProviderOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  baseUrl?: string;
  /** Injectable for contract tests; defaults to global fetch (Node 22). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  provider?: string;
}

/**
 * OpenAI-compatible embeddings adapter (also serves DeepSeek). It lives in
 * `packages/ai` (the only layer allowed to touch provider SDKs/HTTP); the
 * domain only sees `EmbeddingProvider`. Never runs in CI: the composition root
 * injects the mock unless a real provider is explicitly configured.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAiEmbeddingProviderOptions) {
    this.provider = options.provider ?? 'openai';
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async embed(request: EmbeddingRequest): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: request.text,
          dimensions: this.dimensions,
          encoding_format: 'float',
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new AiError(`Embedding request failed (${this.provider}/${this.model})`, {
        retryable: true,
        cause: error,
        context: { correlationId: request.trace.correlationId },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new AiError(
        `Embedding provider returned ${response.status} (${this.provider}/${this.model})`,
        {
          retryable,
          context: { status: response.status, correlationId: request.trace.correlationId },
        },
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new AiError('Embedding provider returned invalid JSON', {
        retryable: false,
        cause: error,
      });
    }
    const parsed = EmbeddingResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AiError('Embedding provider response failed schema validation', {
        context: { issues: parsed.error.issues.length },
      });
    }
    const embedding = parsed.data.data[0]!.embedding;
    if (embedding.length !== this.dimensions) {
      throw new AiError(
        `Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}`,
        { context: { model: this.model } },
      );
    }
    return embedding;
  }
}
