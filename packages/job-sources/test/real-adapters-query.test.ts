import { describe, expect, it } from 'vitest';
import type { HttpClient } from '@job-system/core';
import {
  createArbeitnowAdapter,
  createRemoteOkAdapter,
  createRemotiveAdapter,
} from '../src/real/index.js';

/**
 * SearchQuery contract tests with deterministic crafted payloads (offline):
 * every real adapter must respect keywords/locations/remote from SearchConfig,
 * using server-side filters where available and always a deterministic local
 * fallback.
 */
const REMOTIVE_PAYLOAD = {
  jobs: [
    {
      id: 1,
      url: 'https://remotive.com/remote-jobs/1',
      title: 'TypeScript Backend Engineer',
      company_name: 'Acme',
      description: '<p>TypeScript services</p>',
      candidate_required_location: 'Spain',
      job_type: 'full-time',
      publication_date: '2026-01-01T00:00:00Z',
      salary: null,
      tags: ['typescript'],
    },
    {
      id: 2,
      url: 'https://remotive.com/remote-jobs/2',
      title: 'TypeScript Backend Engineer',
      company_name: 'Acme',
      description: '<p>TypeScript services</p>',
      candidate_required_location: 'Germany',
      job_type: 'full-time',
      publication_date: '2026-01-01T00:00:00Z',
      salary: null,
      tags: [],
    },
    {
      id: 3,
      url: 'https://remotive.com/remote-jobs/3',
      title: 'Python Engineer',
      company_name: 'Acme',
      description: '<p>Python services</p>',
      candidate_required_location: 'Spain',
      job_type: 'full-time',
      publication_date: '2026-01-01T00:00:00Z',
      salary: null,
      tags: [],
    },
    {
      id: 4,
      url: 'https://remotive.com/remote-jobs/4',
      title: 'Backend Engineer',
      company_name: 'Acme',
      description: '<p>Services</p>',
      candidate_required_location: 'Spain',
      job_type: 'full-time',
      publication_date: '2026-01-01T00:00:00Z',
      salary: null,
      tags: ['TypeScript'],
    },
  ],
};

const ARBEITNOW_PAYLOAD = {
  data: [
    {
      slug: 'a-1',
      company_name: 'Acme',
      title: 'TypeScript Dev',
      description: '<p>ts</p>',
      remote: true,
      url: 'https://arbeitnow.test/1',
      tags: [],
      job_types: ['full-time'],
      location: 'Spain',
      created_at: 1767225600,
    },
    {
      slug: 'a-2',
      company_name: 'Acme',
      title: 'TypeScript Dev',
      description: '<p>ts</p>',
      remote: false,
      url: 'https://arbeitnow.test/2',
      tags: [],
      job_types: ['full-time'],
      location: 'Spain',
      created_at: 1767225600,
    },
    {
      slug: 'a-3',
      company_name: 'Acme',
      title: 'TypeScript Dev',
      description: '<p>ts</p>',
      remote: true,
      url: 'https://arbeitnow.test/3',
      tags: [],
      job_types: ['full-time'],
      location: 'Germany',
      created_at: 1767225600,
    },
  ],
  links: { next: null },
};

const REMOTEOK_PAYLOAD = [
  { legal: 'attribution notice' },
  {
    id: 1,
    company: 'Acme',
    position: 'TypeScript Dev',
    description: '<p>ts</p>',
    location: 'Worldwide',
    url: 'https://remoteok.test/1',
    date: '2026-01-01T00:00:00Z',
    tags: ['typescript'],
  },
  {
    id: 2,
    company: 'Acme',
    position: 'Product Designer',
    description: '<p>design</p>',
    location: 'Worldwide',
    url: 'https://remoteok.test/2',
    date: '2026-01-01T00:00:00Z',
    tags: ['design'],
  },
];

function payloadHttpClient(): HttpClient {
  return {
    async request(url) {
      const body = url.includes('/api/remote-jobs')
        ? REMOTIVE_PAYLOAD
        : url.includes('/api/job-board-api')
          ? ARBEITNOW_PAYLOAD
          : REMOTEOK_PAYLOAD;
      return { status: 200, headers: {}, body: JSON.stringify(body), finalUrl: url, redirects: [] };
    },
  };
}

const http = payloadHttpClient();
const remotive = createRemotiveAdapter({ http, baseUrl: 'https://fixture.local' });
const arbeitnow = createArbeitnowAdapter({ http, baseUrl: 'https://fixture.local' });
const remoteok = createRemoteOkAdapter({ http, baseUrl: 'https://fixture.local' });

describe('remotive respects SearchQuery', () => {
  it('keeps only offers matching keywords + location (tags included)', async () => {
    const result = await remotive.searchJobs({
      keywords: ['typescript'],
      locations: ['Spain'],
      remote: true,
      page: 1,
    });
    expect(result.jobs.map((job) => job.externalId).sort()).toEqual(['1', '4']);
  });

  it('excludes non-matching keywords and locations', async () => {
    const noKeyword = await remotive.searchJobs({ keywords: ['python'], locations: ['Spain'], page: 1 });
    expect(noKeyword.jobs.map((job) => job.externalId)).toEqual(['3']);
    const noLocation = await remotive.searchJobs({ keywords: ['typescript'], locations: ['France'], page: 1 });
    expect(noLocation.jobs).toHaveLength(0);
  });
});

describe('arbeitnow respects SearchQuery (local fallback)', () => {
  it('remote=true excludes clearly onsite offers and location filters work', async () => {
    const result = await arbeitnow.searchJobs({
      keywords: ['typescript'],
      locations: ['Spain'],
      remote: true,
      page: 1,
    });
    expect(result.jobs.map((job) => job.externalId)).toEqual(['a-1']);
  });

  it('returns onsite offers when the search is not remote-only', async () => {
    const result = await arbeitnow.searchJobs({ keywords: ['typescript'], locations: ['Spain'], page: 1 });
    expect(result.jobs.map((job) => job.externalId).sort()).toEqual(['a-1', 'a-2']);
  });
});

describe('remoteok respects SearchQuery (local fallback)', () => {
  it('keeps only keyword-matching offers', async () => {
    const result = await remoteok.searchJobs({ keywords: ['typescript'], page: 1 });
    expect(result.jobs.map((job) => job.externalId)).toEqual(['1']);
  });

  it('excludes offers whose location does not match', async () => {
    const result = await remoteok.searchJobs({ keywords: [], locations: ['Spain'], page: 1 });
    expect(result.jobs).toHaveLength(0);
  });
});