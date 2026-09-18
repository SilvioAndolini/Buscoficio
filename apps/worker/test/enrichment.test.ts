import { describe, expect, it, vi } from 'vitest';
import { SourceTransientError, type HttpClient } from '@job-system/core';
import type { DestinationStream } from '@job-system/observability';
import { createLogger } from '@job-system/observability';
import { createTargetEnrichmentService } from '../src/services/target-enrichment-service.js';
import type { RateLimiter } from '../src/services/rate-limiter.js';

function capture(): { stream: DestinationStream; lines: string[] } {
  const lines: string[] = [];
  return { stream: { write: (line: string) => void lines.push(line) }, lines };
}

function parsed(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

function fakeRateLimiter(): RateLimiter & { calls: Array<[string, string, number]> } {
  const calls: Array<[string, string, number]> = [];
  return {
    calls,
    async acquire(sourceKey, operation, limitPerMinute) {
      calls.push([sourceKey, operation, limitPerMinute]);
      return { waitedMs: 0, blocked: false };
    },
    async penalize() {
      /* noop */
    },
  };
}

describe('target enrichment service', () => {
  it('resolves the ATS from a redirect chain and logs with job context', async () => {
    const { stream, lines } = capture();
    const jobLogger = createLogger({ level: 'info', stream }).child({
      correlationId: 'corr-1',
      jobId: 'job-1',
      sourceId: 'remoteok',
    });
    const http: HttpClient = {
      async request() {
        return {
          status: 302,
          headers: {},
          body: '',
          finalUrl: 'https://boards.greenhouse.io/acme/jobs/1',
          redirects: [
            'https://middle.example/step2',
            'https://boards.greenhouse.io/acme/jobs/1',
          ],
        };
      },
    };
    const limiter = fakeRateLimiter();
    const service = createTargetEnrichmentService({ http, rateLimiter: limiter });
    const budget = { remaining: 5 };

    const result = await service.enrich({
      url: 'https://aggregator.example/step1',
      sourceKey: 'remoteok',
      limitPerMinute: 6,
      logger: jobLogger,
      budget,
    });

    expect(result).toEqual({ platformKey: 'greenhouse-acme', signal: 'redirect' });
    expect(budget.remaining).toBe(4);
    expect(limiter.calls[0]?.slice(0, 2)).toEqual(['remoteok', 'target-enrichment']);

    const success = parsed(lines).find((entry) => entry['msg'] === 'target enrichment succeeded');
    expect(success).toBeDefined();
    expect(success!['correlationId']).toBe('corr-1');
    expect(success!['jobId']).toBe('job-1');
    expect(success!['sourceId']).toBe('remoteok');
    expect(success!['targetKey']).toBe('greenhouse-acme');
  });

  it('returns null and logs when no ATS is found', async () => {
    const { stream, lines } = capture();
    const logger = createLogger({ level: 'info', stream }).child({ correlationId: 'c', jobId: 'j' });
    const http: HttpClient = {
      async request() {
        return { status: 200, headers: {}, body: '{}', finalUrl: 'https://example.com/plain', redirects: [] };
      },
    };
    const service = createTargetEnrichmentService({ http, rateLimiter: fakeRateLimiter() });
    const result = await service.enrich({
      url: 'https://example.com/plain',
      sourceKey: 'remotive',
      limitPerMinute: 10,
      logger,
      budget: { remaining: 1 },
    });
    expect(result).toBeNull();
    expect(parsed(lines).some((entry) => entry['msg'] === 'target enrichment unresolved')).toBe(true);
  });

  it('never breaks ingestion: failures are logged and return null', async () => {
    const { stream, lines } = capture();
    const logger = createLogger({ level: 'info', stream }).child({ correlationId: 'c', jobId: 'j' });
    const http: HttpClient = {
      async request() {
        throw new SourceTransientError('boom');
      },
    };
    const service = createTargetEnrichmentService({ http, rateLimiter: fakeRateLimiter() });
    const result = await service.enrich({
      url: 'https://example.com/fail',
      sourceKey: 'remoteok',
      limitPerMinute: 6,
      logger,
      budget: { remaining: 1 },
    });
    expect(result).toBeNull();
    const failure = parsed(lines).find((entry) => entry['msg'] === 'target enrichment failed');
    expect(failure).toBeDefined();
    expect(failure!['correlationId']).toBe('c');
  });

  it('respects the per-run budget (no request when exhausted)', async () => {
    const httpRequest = vi.fn();
    const http: HttpClient = { request: httpRequest };
    const service = createTargetEnrichmentService({ http, rateLimiter: fakeRateLimiter() });
    const result = await service.enrich({
      url: 'https://example.com/none',
      sourceKey: 'remoteok',
      limitPerMinute: 6,
      logger: createLogger({ level: 'silent' as 'error' }),
      budget: { remaining: 0 },
    });
    expect(result).toBeNull();
    expect(httpRequest).not.toHaveBeenCalled();
  });
});