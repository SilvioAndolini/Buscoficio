import { describe, expect, it, vi } from 'vitest';
import {
  RateLimitedError,
  SourceAuthError,
  SourcePermanentError,
  SourceTransientError,
} from '@job-system/core';
import { createFetchHttpClient } from '../src/http/fetch-client.js';

function jsonResponse(status: number, body = '{}', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('fetch http client error taxonomy', () => {
  it('maps 401 and 403 to SourceAuthError (no retry)', async () => {
    const client = createFetchHttpClient({
      fetchImpl: vi.fn(async () => jsonResponse(401)) as unknown as typeof fetch,
    });
    await expect(client.request('https://api.example/401')).rejects.toThrow(SourceAuthError);

    const forbidden = createFetchHttpClient({
      fetchImpl: vi.fn(async () => jsonResponse(403)) as unknown as typeof fetch,
    });
    await expect(forbidden.request('https://api.example/403')).rejects.toThrow(SourceAuthError);
  });

  it('maps 429 to RateLimitedError including Retry-After', async () => {
    const client = createFetchHttpClient({
      fetchImpl: vi.fn(async () =>
        jsonResponse(429, '{}', { 'retry-after': '2' }),
      ) as unknown as typeof fetch,
    });
    const error = await client.request('https://api.example/429').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).context?.['retryAfterMs']).toBe(2000);
  });

  it('maps 5xx to transient and other 4xx to permanent', async () => {
    const serverError = createFetchHttpClient({
      fetchImpl: vi.fn(async () => jsonResponse(503)) as unknown as typeof fetch,
    });
    await expect(serverError.request('https://api.example/503')).rejects.toThrow(SourceTransientError);

    const notFound = createFetchHttpClient({
      fetchImpl: vi.fn(async () => jsonResponse(404)) as unknown as typeof fetch,
    });
    await expect(notFound.request('https://api.example/404')).rejects.toThrow(SourcePermanentError);
  });

  it('follows redirects and stops before fetching a matched URL (stopWhen)', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/step1')) {
        return jsonResponse(302, '', { location: 'https://middle.example/step2' });
      }
      if (url.endsWith('/step2')) {
        return jsonResponse(302, '', { location: 'https://boards.greenhouse.io/acme/jobs/1' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const client = createFetchHttpClient({ fetchImpl });
    const response = await client.request('https://aggregator.example/step1', {
      stopWhen: (next) => next.includes('boards.greenhouse.io'),
    });
    expect(response.redirects).toEqual([
      'https://middle.example/step2',
      'https://boards.greenhouse.io/acme/jobs/1',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});