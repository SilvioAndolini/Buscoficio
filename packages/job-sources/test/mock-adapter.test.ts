import { describe, expect, it } from 'vitest';
import { SourceAuthError, SourceTransientError, type JobSourceAdapter } from '@job-system/core';
import { createMockJobSource } from '../src/mock/mock-adapter.js';
import { MOCK_PAYLOADS } from '../src/mock/fixtures.js';

const emptyQuery = { keywords: [], page: 1 };

describe('createMockJobSource', () => {
  it('exposes deterministic pagination', async () => {
    const adapter = createMockJobSource();
    const first = await adapter.searchJobs(emptyQuery);
    expect(first.jobs).toHaveLength(4);
    expect(first.hasMore).toBe(true);

    const second = await adapter.searchJobs({ keywords: [], page: 2 });
    expect(second.jobs).toHaveLength(4);
    expect(second.hasMore).toBe(true);

    const third = await adapter.searchJobs({ keywords: [], page: 3 });
    expect(third.jobs).toHaveLength(MOCK_PAYLOADS.length - 8);
    expect(third.hasMore).toBe(false);
  });

  it('is fully deterministic across calls', async () => {
    const adapter = createMockJobSource();
    const a = await adapter.searchJobs(emptyQuery);
    const b = await adapter.searchJobs(emptyQuery);
    expect(a).toEqual(b);
    expect(adapter.normalizeJob(a.jobs[0]!)).toEqual(adapter.normalizeJob(b.jobs[0]!));
  });

  it('filters by keywords across title, description and company', async () => {
    const adapter = createMockJobSource();
    const result = await adapter.searchJobs({ keywords: ['react'], page: 1 });
    expect(result.jobs.length).toBeGreaterThan(0);
    for (const job of result.jobs) {
      const data = job.data as { title: string; description: string; company: string };
      expect(`${data.title} ${data.description} ${data.company}`.toLowerCase()).toContain('react');
    }
    expect(
      result.jobs.some((job) => (job.data as { title: string }).title === 'Senior React Developer'),
    ).toBe(true);
  });

  it('fetches by external id and returns null when missing', async () => {
    const adapter = createMockJobSource();
    expect(await adapter.fetchJob('m-001')).not.toBeNull();
    expect(await adapter.fetchJob('does-not-exist')).toBeNull();
  });

  it('simulates retryable and auth errors deterministically', async () => {
    await expect(createMockJobSource({ failSearch: 'transient' }).searchJobs(emptyQuery)).rejects.toThrow(
      SourceTransientError,
    );
    await expect(createMockJobSource({ failSearch: 'auth' }).searchJobs(emptyQuery)).rejects.toThrow(
      SourceAuthError,
    );
  });

  it('rejects invalid pagination input', async () => {
    const adapter = createMockJobSource();
    await expect(adapter.searchJobs({ keywords: [], page: 0 })).rejects.toThrow();
  });

  it('detects an application target when the payload signals one', async () => {
    const adapter = createMockJobSource();
    const raw = await adapter.fetchJob('m-001');
    expect(raw).not.toBeNull();
    expect(adapter.detectApplicationTarget(raw!)).toEqual({
      platformKey: 'greenhouse',
      signal: 'metadata',
    });

    const noTarget = await adapter.fetchJob('m-004');
    expect(adapter.detectApplicationTarget(noTarget!)).toBeNull();
  });

  it('includes malformed, expired and duplicate fixtures for pipeline coverage', () => {
    const ids = MOCK_PAYLOADS.map((payload) => payload.externalId);
    expect(ids).toContain('m-007'); // malformed
    const expired = MOCK_PAYLOADS.find((payload) => payload.externalId === 'm-006')!;
    expect(new Date(expired.expiresAt!).getTime()).toBeLessThan(Date.now());
    expect(ids).toContain('m-003'); // L1 duplicate of m-001
    expect(ids).toContain('m-009'); // L2 duplicate of m-001
  });
});

describe('JobSourceAdapter contract conformance', () => {
  it('satisfies the contract shape at runtime', () => {
    const adapter: JobSourceAdapter = createMockJobSource();
    expect(typeof adapter.key).toBe('string');
    expect(adapter.capabilities.supportsPagination).toBe(true);
    expect(typeof adapter.searchJobs).toBe('function');
    expect(typeof adapter.fetchJob).toBe('function');
    expect(typeof adapter.normalizeJob).toBe('function');
    expect(typeof adapter.detectApplicationTarget).toBe('function');
  });

  it('normalizeJob is pure (no hidden state between calls)', async () => {
    const adapter = createMockJobSource();
    const { jobs } = await adapter.searchJobs(emptyQuery);
    const raw = jobs[0]!;
    expect(adapter.normalizeJob(raw)).toEqual(adapter.normalizeJob(raw));
  });
});