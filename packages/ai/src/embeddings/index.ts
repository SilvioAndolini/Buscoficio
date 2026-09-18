import { AiError, type EmbeddingProvider } from '@job-system/core';
import { MockEmbeddingProvider } from './mock-provider.js';
import { OpenAiEmbeddingProvider } from './openai-provider.js';

export interface EmbeddingProviderFactoryConfig {
  /** Independent from AI_PROVIDER: embeddings are their own port. */
  provider: string;
  model: string;
  dimensions: number;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Composition-root factory. Only providers with a real, documented embeddings
 * endpoint are implemented (`mock` for CI/dev, `openai` compatible). A chat
 * provider does NOT imply an embeddings provider: unsupported values fail with
 * a typed error instead of calling a guessed endpoint.
 */
export function createEmbeddingProvider(
  config: EmbeddingProviderFactoryConfig,
): EmbeddingProvider {
  if (config.provider === 'mock') {
    return new MockEmbeddingProvider({ model: config.model, dimensions: config.dimensions });
  }
  if (config.provider === 'anthropic') {
    throw new AiError(
      'EMBEDDING_PROVIDER=anthropic: Anthropic does not provide an embeddings API; use openai|mock (AI_PROVIDER is independent)',
    );
  }
  if (config.provider === 'deepseek') {
    throw new AiError(
      'EMBEDDING_PROVIDER=deepseek: no documented embeddings endpoint is implemented; use openai|mock',
    );
  }
  if (config.provider !== 'openai') {
    throw new AiError(
      `Unsupported embedding provider '${config.provider}'; supported: mock|openai`,
    );
  }
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new AiError(
      'EMBEDDING_PROVIDER=openai requires a key (EMBEDDING_API_KEY or OPENAI_API_KEY) via configuration/SecretProvider',
    );
  }
  return new OpenAiEmbeddingProvider({
    provider: 'openai',
    apiKey: config.apiKey,
    model: config.model,
    dimensions: config.dimensions,
    baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });
}

export { MockEmbeddingProvider } from './mock-provider.js';
export { OpenAiEmbeddingProvider } from './openai-provider.js';
