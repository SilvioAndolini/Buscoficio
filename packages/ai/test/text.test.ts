import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiError } from '@job-system/core';
import { ConfigError } from '@job-system/shared';
import { MockTextGenerationProvider } from '../src/text/mock-provider.js';
import { OpenAiCompatibleTextProvider } from '../src/text/openai-provider.js';
import { AnthropicTextProvider } from '../src/text/anthropic-provider.js';
import { createTextGenerationProvider } from '../src/text/index.js';

const schema = z.object({ text: z.string(), claims: z.array(z.unknown()) });
const request = {
  system: 'system',
  user: 'user',
  promptVersion: 'cover-letter/v1',
  inputHash: 'h'.repeat(64),
  trace: { correlationId: 'ai-test' },
};

describe('MockTextGenerationProvider (Phase 4)', () => {
  it('returns a deterministic default for cover_letter and records the call', async () => {
    const provider = new MockTextGenerationProvider();
    const result = await provider.completeStructured({
      ...request,
      schema,
      schemaName: 'cover_letter',
    });
    expect(result.value.text.length).toBeGreaterThan(0);
    expect(result.value.claims).toEqual([]);
    expect(provider.calls).toEqual([
      { promptVersion: 'cover-letter/v1', inputHash: 'h'.repeat(64), schemaName: 'cover_letter' },
    ]);
  });

  it('simulates schema-invalid output and provider errors/timeouts', async () => {
    const invalid = new MockTextGenerationProvider({
      responses: [{ kind: 'invalid-schema', value: { text: 1, claims: [] } }],
    });
    await expect(
      invalid.completeStructured({ ...request, schema, schemaName: 'cover_letter' }),
    ).rejects.toBeInstanceOf(AiError);

    const error = new MockTextGenerationProvider({ responses: [{ kind: 'error', retryable: true }] });
    await expect(
      error.completeStructured({ ...request, schema, schemaName: 'cover_letter' }),
    ).rejects.toMatchObject({ retryable: true });

    const timeout = new MockTextGenerationProvider({ responses: [{ kind: 'timeout' }] });
    await expect(
      timeout.completeStructured({ ...request, schema, schemaName: 'cover_letter' }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('supports a repair sequence (invented claim then valid)', async () => {
    const provider = new MockTextGenerationProvider({
      responses: [
        {
          kind: 'structured',
          value: {
            text: 'Invented',
            claims: [{ claim: '10 years AWS', kind: 'years_experience', value: { years: 10 } }],
          },
        },
        { kind: 'structured', value: { text: 'Valid', claims: [] } },
      ],
    });
    const first = await provider.completeStructured({ ...request, schema, schemaName: 'cover_letter' });
    expect((first.value.claims[0] as { claim: string }).claim).toBe('10 years AWS');
    const second = await provider.completeStructured({ ...request, schema, schemaName: 'cover_letter' });
    expect(second.value.claims).toEqual([]);
    expect(provider.calls).toHaveLength(2);
  });
});

describe('createTextGenerationProvider (Phase 4)', () => {
  it('builds the mock and rejects unimplemented providers with ConfigError', () => {
    const provider = createTextGenerationProvider({ provider: 'mock', model: 'mock-text-v1' });
    expect(provider.provider).toBe('mock');
    expect(() =>
      createTextGenerationProvider({ provider: 'unknown-provider', model: 'x' }),
    ).toThrow(ConfigError);
    expect(() => createTextGenerationProvider({ provider: 'openai', model: 'gpt-4o-mini' })).toThrow(
      ConfigError,
    );
    expect(() => createTextGenerationProvider({ provider: 'anthropic', model: 'claude-3-5-sonnet' })).toThrow(
      ConfigError,
    );
    expect(() => createTextGenerationProvider({ provider: 'deepseek', model: 'deepseek-chat' })).toThrow(
      ConfigError,
    );
  });

  it('uses documented base URLs only', () => {
    const fetchImpl = vi.fn();
    const openai = createTextGenerationProvider({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'k',
      fetchImpl,
    });
    expect(openai.provider).toBe('openai');
    const deepseek = createTextGenerationProvider({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'k',
      fetchImpl,
    });
    expect(deepseek.provider).toBe('deepseek');
    const anthropic = createTextGenerationProvider({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      apiKey: 'k',
      fetchImpl,
    });
    expect(anthropic.provider).toBe('anthropic');
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenAiCompatibleTextProvider contract (fake HTTP)', () => {
  it('calls the documented endpoint with bearer auth and parses usage', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: '{"text":"ok","claims":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      }),
    );
    const provider = new OpenAiCompatibleTextProvider({
      provider: 'openai',
      apiKey: 'secret-key',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.completeStructured({ ...request, schema, schemaName: 'cover_letter' });
    expect(result.value.text).toBe('ok');
    expect(result.tokensIn).toBe(12);
    expect(result.tokensOut).toBe(7);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-key');
    const body = JSON.parse(init.body as string) as { response_format?: unknown; messages: unknown[] };
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages).toHaveLength(2);
  });

  it('maps 429/5xx to retryable AiError and 4xx to non-retryable', async () => {
    const rateLimited = new OpenAiCompatibleTextProvider({
      provider: 'openai',
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://api.openai.com/v1',
      fetchImpl: (async () => jsonResponse({ error: 'rate' }, 429)) as unknown as typeof fetch,
    });
    await expect(rateLimited.complete(request)).rejects.toMatchObject({ retryable: true });

    const badRequest = new OpenAiCompatibleTextProvider({
      provider: 'openai',
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://api.openai.com/v1',
      fetchImpl: (async () => jsonResponse({ error: 'bad' }, 400)) as unknown as typeof fetch,
    });
    await expect(badRequest.complete(request)).rejects.toMatchObject({ retryable: false });
  });

  it('rejects schema-invalid structured output and timeouts', async () => {
    const invalid = new OpenAiCompatibleTextProvider({
      provider: 'openai',
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://api.openai.com/v1',
      fetchImpl: (async () =>
        jsonResponse({
          choices: [{ message: { content: '{"text":1}' } }],
        })) as unknown as typeof fetch,
    });
    await expect(
      invalid.completeStructured({ ...request, schema, schemaName: 'cover_letter' }),
    ).rejects.toBeInstanceOf(AiError);

    const timeout = new OpenAiCompatibleTextProvider({
      provider: 'openai',
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://api.openai.com/v1',
      fetchImpl: (async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }) as unknown as typeof fetch,
    });
    await expect(timeout.complete(request)).rejects.toMatchObject({ retryable: true });
  });
});

describe('AnthropicTextProvider contract (fake HTTP)', () => {
  it('calls the messages endpoint with the documented headers', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        content: [{ type: 'text', text: 'Here: {"text":"ok","claims":[]}' }],
        usage: { input_tokens: 5, output_tokens: 3 },
        stop_reason: 'end_turn',
      }),
    );
    const provider = new AnthropicTextProvider({
      apiKey: 'anthropic-key',
      model: 'claude-3-5-sonnet',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.completeStructured({ ...request, schema, schemaName: 'cover_letter' });
    expect(result.value.text).toBe('ok');
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('anthropic-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('maps HTTP failures with the shared taxonomy', async () => {
    const provider = new AnthropicTextProvider({
      apiKey: 'k',
      model: 'm',
      fetchImpl: (async () => jsonResponse({ error: 'overloaded' }, 529)) as unknown as typeof fetch,
    });
    await expect(provider.complete(request)).rejects.toMatchObject({ retryable: true });
  });
});
