import { AiError, type EmbeddingProvider } from '@job-system/core';
import { MockEmbeddingProvider } from './mock-provider.js';
import { OpenAiEmbeddingProvider } from './openai-provider.js';

export interface EmbeddingProviderFactoryConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'mock';
  model: string;
  dimensions: number;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
};

/**
 * Composition-root factory: `AI_PROVIDER=mock` (default) yields the
 * deterministic offline provider; real providers require explicit credentials
 * and are never exercised by CI.
 */
export function createEmbeddingProvider(
  config: EmbeddingProviderFactoryConfig,
): EmbeddingProvider {
  if (config.provider === 'mock') {
    return new MockEmbeddingProvider({ model: config.model, dimensions: config.dimensions });
  }
  if (config.provider === 'anthropic') {
    throw new AiError(
      'Anthropic does not provide an embeddings API; configure AI_PROVIDER=openai|deepseek|mock',
    );
  }
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new AiError(
      `AI_PROVIDER=${config.provider} requires an API key (OPENAI_API_KEY) via configuration/SecretProvider`,
    );
  }
  return new OpenAiEmbeddingProvider({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    dimensions: config.dimensions,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URLS[config.provider] ?? DEFAULT_BASE_URLS['openai']!,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });
}

export { MockEmbeddingProvider } from './mock-provider.js';
export { OpenAiEmbeddingProvider } from './openai-provider.js';
