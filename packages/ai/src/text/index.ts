import { AiError, type TextGenerationPort } from '@job-system/core';
import { ConfigError } from '@job-system/shared';
import { AnthropicTextProvider } from './anthropic-provider.js';
import { MockTextGenerationProvider, type MockTextResponse } from './mock-provider.js';
import { OpenAiCompatibleTextProvider } from './openai-provider.js';

export interface TextProviderFactoryConfig {
  provider: string;
  model: string;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Test seam: scripted mock responses. */
  mockResponses?: MockTextResponse[] | undefined;
}

const DOCUMENTED_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  anthropic: 'https://api.anthropic.com',
};

/**
 * Composition-root factory for `TextGenerationPort` (task §48). Only providers
 * with a real, documented API are implemented; a configured provider without
 * an implementation fails with a clear ConfigError at startup instead of
 * calling a guessed endpoint.
 */
export function createTextGenerationProvider(
  config: TextProviderFactoryConfig,
): TextGenerationPort {
  if (config.provider === 'mock') {
    return new MockTextGenerationProvider({
      model: config.model,
      ...(config.mockResponses === undefined ? {} : { responses: config.mockResponses }),
    });
  }
  if (!(config.provider in DOCUMENTED_BASE_URLS)) {
    throw new ConfigError([
      `AI_PROVIDER=${config.provider} has no implemented TextGenerationPort adapter; supported: mock|openai|anthropic|deepseek`,
    ]);
  }
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new ConfigError([
      `AI_PROVIDER=${config.provider} requires an API key via configuration/SecretProvider`,
    ]);
  }
  const baseUrl = config.baseUrl ?? DOCUMENTED_BASE_URLS[config.provider]!;
  if (config.provider === 'anthropic') {
    return new AnthropicTextProvider({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl,
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    });
  }
  if (config.provider === 'openai' || config.provider === 'deepseek') {
    return new OpenAiCompatibleTextProvider({
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      baseUrl,
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    });
  }
  throw new AiError(`Unsupported text provider '${config.provider}'`);
}

export { AnthropicTextProvider } from './anthropic-provider.js';
export { MockTextGenerationProvider, type MockTextResponse } from './mock-provider.js';
export { OpenAiCompatibleTextProvider } from './openai-provider.js';
