import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SourcePermanentError,
  type HttpClient,
  type JobSourceAdapter,
  type RawJob,
} from '@job-system/core';
import {
  createArbeitnowAdapter,
  createRealSourceAdapters,
  createRemotiveAdapter,
  createRemoteOkAdapter,
} from '../src/real/index.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name, 'search-page.json'), 'utf8'));
}

function fixtureHttpClient(): HttpClient {
  return {
    async request(url) {
      if (url.includes('/api/remote-jobs')) {
        return { status: 200, headers: {}, body: JSON.stringify(fixture('remotive')), finalUrl: url, redirects: [] };
      }
      if (url.includes('/api/job-board-api')) {
        return { status: 200, headers: {}, body: JSON.stringify(fixture('arbeitnow')), finalUrl: url, redirects: [] };
      }
      if (url.includes('/api')) {
        return { status: 200, headers: {}, body: JSON.stringify(fixture('remoteok')), finalUrl: url, redirects: [] };
      }
      throw new SourcePermanentError(`unexpected URL in contract test: ${url}`);
    },
  };
}

const adapters: Array<[string, () => JobSourceAdapter]> = [
  ['remotive', () => createRemotiveAdapter({ http: fixtureHttpClient(), baseUrl: 'https://fixture.local' })],
  ['arbeitnow', () => createArbeitnowAdapter({ http: fixtureHttpClient(), baseUrl: 'https://fixture.local' })],
  ['remoteok', () => createRemoteOkAdapter({ http: fixtureHttpClient(), baseUrl: 'https://fixture.local' })],
];

describe.each(adapters)('%s adapter contract (recorded fixtures)', (_name, factory) => {
  it('implements the JobSourceAdapter contract', () => {
    const adapter = factory();
    expect(typeof adapter.key).toBe('string');
    expect(typeof adapter.searchJobs).toBe('function');
    expect(typeof adapter.fetchJob).toBe('function');
    expect(typeof adapter.normalizeJob).toBe('function');
    expect(typeof adapter.detectApplicationTarget).toBe('function');
    expect(adapter.capabilities.pageSize).toBeGreaterThan(0);
    expect(adapter.capabilities.rateLimitPerMinute).toBeGreaterThan(0);
  });

  it('searches and normalizes fixture offers deterministically', async () => {
    const adapter = factory();
    const result = await adapter.searchJobs({ keywords: [], page: 1 });
    expect(result.jobs.length).toBeGreaterThan(0);
    expect(result.jobs[0]!.sourceKey).toBe(adapter.key);

    const normalizedA = adapter.normalizeJob(result.jobs[0]!);
    const normalizedB = adapter.normalizeJob(result.jobs[0]!);
    expect(normalizedA).toEqual(normalizedB);
    expect(normalizedA.title.length).toBeGreaterThan(0);
    expect(normalizedA.company.length).toBeGreaterThan(0);
    expect(normalizedA.canonicalUrl.startsWith('http')).toBe(true);
    expect(normalizedA.publishedAt).toBeInstanceOf(Date);
  });

  it('rejects malformed payloads with ValidationError (quarantine path)', () => {
    const adapter = factory();
    const malformed: RawJob = {
      sourceKey: adapter.key,
      externalId: 'bad-1',
      fetchedAt: new Date(),
      data: { unexpected: true },
    };
    expect(() => adapter.normalizeJob(malformed)).toThrowError(/Malformed|malformed/);
  });

  it('does not throw on target detection for unknown hosts', async () => {
    const adapter = factory();
    const result = await adapter.searchJobs({ keywords: [], page: 1 });
    for (const raw of result.jobs) {
      expect(() => adapter.detectApplicationTarget(raw)).not.toThrow();
    }
  });
});

describe('target detection with recorded + crafted ATS data', () => {
  it('detects greenhouse from a remoteok apply_url', () => {
    const adapter = createRemoteOkAdapter({ http: fixtureHttpClient(), baseUrl: 'https://fixture.local' });
    const raw: RawJob = {
      sourceKey: 'remoteok',
      externalId: 'ats-1',
      fetchedAt: new Date(),
      data: {
        id: 999,
        company: 'Acme Remote',
        position: 'Platform Engineer',
        apply_url: 'https://boards.greenhouse.io/acme/jobs/42',
        url: 'https://remoteok.com/remote-jobs/999',
        date: '2026-01-01T00:00:00Z',
      },
    };
    expect(adapter.detectApplicationTarget(raw)).toEqual({
      platformKey: 'greenhouse-acme',
      signal: 'metadata',
    });
  });

  it('detects the ATS from a redirect chain when present', () => {
    const adapter = createRemoteOkAdapter({ http: fixtureHttpClient(), baseUrl: 'https://fixture.local' });
    const raw: RawJob = {
      sourceKey: 'remoteok',
      externalId: 'ats-2',
      fetchedAt: new Date(),
      redirects: ['https://jobs.lever.co/initech/abc'],
      data: {
        id: 1000,
        company: 'Initech Staffing',
        position: 'Backend Engineer',
        url: 'https://remoteok.com/remote-jobs/1000',
        date: '2026-01-02T00:00:00Z',
      },
    };
    expect(adapter.detectApplicationTarget(raw)).toEqual({
      platformKey: 'lever-initech',
      signal: 'metadata',
    });
  });

  it('createRealSourceAdapters returns the three Phase 2 adapters', () => {
    const list = createRealSourceAdapters({ http: fixtureHttpClient() });
    expect(list.map((adapter) => adapter.key).sort()).toEqual(['arbeitnow', 'remoteok', 'remotive']);
  });
});