import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NormalizedJobSchema, type NormalizedJob } from '@job-system/core';
import type { DbHandle } from '../src/client.js';
import { createDedupRepo, createJobRepo } from '../src/repositories/index.js';
import { createTestDb, truncateAll } from '../src/testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']);
const describeDb = hasDatabase ? describe : describe.skip;

let handle: DbHandle;

function normalized(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return NormalizedJobSchema.parse({
    externalId: 'ext-1',
    canonicalUrl: 'https://jobs.example.com/acme/senior-react-developer',
    company: 'Acme Corp',
    title: 'Senior React Developer',
    description: 'Build internal tools with React and TypeScript.',
    location: 'Remote (EU)',
    remoteType: 'remote',
    employmentType: 'full_time',
    salaryMin: 65000,
    salaryMax: 85000,
    currency: 'EUR',
    experienceLevel: 'senior',
    languageRequirements: ['en'],
    publishedAt: new Date('2026-01-10T09:00:00Z'),
    expiresAt: null,
    applicationMethod: 'external_form',
    ...overrides,
  });
}

const URL_HASH = 'hash-url-1';
const DEDUP_KEY = 'fingerprint-1';

function ingestData(overrides: {
  externalId: string;
  urlHash?: string;
  dedupKey?: string;
  normalizedJob?: NormalizedJob;
  applicationTargetId?: string | null;
  applicationTargetSignal?: string | null;
}) {
  return {
    sourceId: '',
    externalId: overrides.externalId,
    applicationTargetId: overrides.applicationTargetId ?? null,
    applicationTargetSignal: overrides.applicationTargetSignal ?? null,
    normalized: overrides.normalizedJob ?? normalized({ externalId: overrides.externalId }),
    urlHash: overrides.urlHash ?? URL_HASH,
    dedupKey: overrides.dedupKey ?? DEDUP_KEY,
    contentHash: 'content-hash-1',
    discoveredAt: new Date('2026-01-15T10:00:00Z'),
    raw: { fixture: true },
  };
}

beforeEach(async () => {
  handle = await createTestDb();
  await truncateAll(handle.db);
});

afterAll(async () => {
  if (handle) await handle.pool.end();
});

describeDb('ingest idempotency (L0–L2)', () => {
  it('ingests a new listing exactly once (L0)', async () => {
    const repo = createJobRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });

    const first = await repo.ingestJob({ ...ingestData({ externalId: 'm-001' }), sourceId: source.id });
    expect(first.outcome).toBe('new');

    const second = await repo.ingestJob({ ...ingestData({ externalId: 'm-001' }), sourceId: source.id });
    expect(second.outcome).toBe('duplicate');
    expect(second.listingId).toBe(first.listingId);
    expect(second.jobId).toBe(first.jobId);

    expect(await repo.countJobs()).toBe(1);
  });

  it('merges a duplicate URL into the same canonical job (L1)', async () => {
    const repo = createJobRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });

    const first = await repo.ingestJob({ ...ingestData({ externalId: 'm-001' }), sourceId: source.id });
    const merged = await repo.ingestJob({
      ...ingestData({ externalId: 'm-003', urlHash: URL_HASH, dedupKey: DEDUP_KEY }),
      sourceId: source.id,
    });
    expect(merged.outcome).toBe('merged');
    expect(merged.jobId).toBe(first.jobId);
    expect(await repo.countJobs()).toBe(1);
  });

  it('merges a fingerprint duplicate into the same canonical job (L2)', async () => {
    const repo = createJobRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });

    const first = await repo.ingestJob({ ...ingestData({ externalId: 'm-001' }), sourceId: source.id });
    const merged = await repo.ingestJob({
      ...ingestData({ externalId: 'm-009', urlHash: 'hash-url-9', dedupKey: DEDUP_KEY }),
      sourceId: source.id,
    });
    expect(merged.outcome).toBe('merged');
    expect(merged.jobId).toBe(first.jobId);

    const { listings } = await repo.getJobWithListings(first.jobId!);
    expect(listings).toHaveLength(2);
  });

  it('creates separate canonical jobs for genuinely different offers', async () => {
    const repo = createJobRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });

    await repo.ingestJob({ ...ingestData({ externalId: 'm-001' }), sourceId: source.id });
    await repo.ingestJob({
      ...ingestData({
        externalId: 'm-004',
        urlHash: 'hash-url-4',
        dedupKey: 'fingerprint-4',
        normalizedJob: normalized({
          externalId: 'm-004',
          canonicalUrl: 'https://jobs.example.com/globex/data-engineer',
          company: 'Globex',
          title: 'Data Engineer',
          description: 'Own batch and streaming pipelines.',
        }),
      }),
      sourceId: source.id,
    });
    expect(await repo.countJobs()).toBe(2);
  });

  it('quarantines malformed offers without creating canonical jobs', async () => {
    const repo = createJobRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });

    const row = await repo.insertQuarantine({
      sourceId: source.id,
      externalId: 'm-007',
      raw: { title: '' },
      errors: [{ path: 'title', message: 'required' }],
    });
    expect(row).not.toBeNull();
    expect(row!.validated).toBe(false);
    expect(row!.jobId).toBeNull();
    expect(await repo.countJobs()).toBe(0);

    const quarantined = await repo.listQuarantinedListings(source.id);
    expect(quarantined).toHaveLength(1);

    const again = await repo.insertQuarantine({
      sourceId: source.id,
      externalId: 'm-007',
      raw: { title: '' },
      errors: [],
    });
    expect(again).toBeNull();
  });

  it('lists jobs with their primary listing', async () => {
    const repo = createJobRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });
    await repo.ingestJob({ ...ingestData({ externalId: 'm-001' }), sourceId: source.id });

    const jobs = await repo.listJobs({ limit: 10, offset: 0 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job.title).toBe('Senior React Developer');
    expect(jobs[0]!.primaryListing?.externalId).toBe('m-001');
  });

  it('promotes the application target from a merged listing when the job has none', async () => {
    const repo = createJobRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });
    const greenhouse = await repo.upsertTarget({
      key: 'greenhouse',
      kind: 'ats_browser',
      platform: 'greenhouse',
      label: 'Greenhouse',
    });

    const first = await repo.ingestJob({ ...ingestData({ externalId: 'm-001' }), sourceId: source.id });
    expect(first.outcome).toBe('new');

    const merged = await repo.ingestJob({
      ...ingestData({ externalId: 'm-003', applicationTargetId: greenhouse.id, applicationTargetSignal: 'metadata' }),
      sourceId: source.id,
    });
    expect(merged.outcome).toBe('merged');
    expect(merged.reasons.join(' ')).toContain('application target promoted');

    const { job } = await repo.getJobWithListings(first.jobId!);
    expect(job.applicationTargetId).toBe(greenhouse.id);
  });

  it('keeps the existing application target on conflict and records it', async () => {
    const repo = createJobRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });
    const greenhouse = await repo.upsertTarget({
      key: 'greenhouse',
      kind: 'ats_browser',
      platform: 'greenhouse',
      label: 'Greenhouse',
    });
    const lever = await repo.upsertTarget({
      key: 'lever',
      kind: 'ats_browser',
      platform: 'lever',
      label: 'Lever',
    });

    const first = await repo.ingestJob({
      ...ingestData({ externalId: 'm-001', applicationTargetId: greenhouse.id }),
      sourceId: source.id,
    });
    const merged = await repo.ingestJob({
      ...ingestData({ externalId: 'm-003', applicationTargetId: lever.id }),
      sourceId: source.id,
    });
    expect(merged.outcome).toBe('merged');
    expect(merged.reasons.join(' ')).toContain('application target conflict');

    const { job, listings } = await repo.getJobWithListings(first.jobId!);
    expect(job.applicationTargetId).toBe(greenhouse.id);
    const mergedListing = listings.find((entry) => entry.listing.externalId === 'm-003');
    expect(mergedListing?.listing.applicationTargetId).toBe(lever.id);
  });

  it('auto-merges L3 fuzzy duplicates when above the high threshold', async () => {
    const repo = createJobRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });
    const thresholds = { high: 0.5, medium: 0.05 };

    const first = await repo.ingestJob({
      ...ingestData({ externalId: 'l3-1' }),
      sourceId: source.id,
      fuzzy: { thresholds },
    });
    expect(first.outcome).toBe('new');

    const merged = await repo.ingestJob({
      ...ingestData({
        externalId: 'l3-2',
        urlHash: 'hash-l3-2',
        dedupKey: 'fingerprint-l3-2',
        normalizedJob: normalized({
          externalId: 'l3-2',
          canonicalUrl: 'https://jobs.example.com/acme/senior-react-developer-2',
          description:
            'Build internal tools with React and TypeScript. You will mentor two engineers.',
        }),
      }),
      sourceId: source.id,
      fuzzy: { thresholds },
    });

    expect(merged.outcome).toBe('merged');
    expect(merged.reasons.join(' ')).toContain('L3');
    expect(merged.fuzzy?.decision).toBe('merge');
    expect(await repo.countJobs()).toBe(1);
  });

  it('queues the L3 gray zone for human review and never auto-merges it', async () => {
    const repo = createJobRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });
    const thresholds = { high: 0.999, medium: 0.05 };

    const first = await repo.ingestJob({
      ...ingestData({ externalId: 'gray-1' }),
      sourceId: source.id,
      fuzzy: { thresholds },
    });
    const second = await repo.ingestJob({
      ...ingestData({
        externalId: 'gray-2',
        urlHash: 'hash-gray-2',
        dedupKey: 'fingerprint-gray-2',
        normalizedJob: normalized({
          externalId: 'gray-2',
          canonicalUrl: 'https://jobs.example.com/acme/senior-react-developer-gray',
          description:
            'Build internal tools with React and TypeScript. You will mentor two engineers.',
        }),
      }),
      sourceId: source.id,
      fuzzy: { thresholds },
    });

    expect(second.outcome).toBe('new');
    expect(second.fuzzy?.decision).toBe('review');
    expect(second.reviewId).toBeTruthy();
    expect(second.reasons.join(' ')).toContain('gray zone');
    expect(await repo.countJobs()).toBe(2);

    const reviews = await createDedupRepo(handle.db).listReviews('pending', 50);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.review.status).toBe('pending');
    expect(reviews[0]!.review.candidateJobId).toBe(first.jobId);
    expect(reviews[0]!.review.createdJobId).toBe(second.jobId);

    // Human decision: merging moves the listing and archives the loser.
    const decided = await createDedupRepo(handle.db).decideReview(
      reviews[0]!.review.id,
      'merged',
      'user',
    );
    expect(decided.review.status).toBe('decided');
    expect(decided.review.decision).toBe('merged');
    const winner = await repo.getJobWithListings(first.jobId!);
    expect(winner.listings).toHaveLength(2);
    const loser = await repo.getJobWithListings(second.jobId!);
    expect(loser.job.status).toBe('archived');
    expect(loser.listings).toHaveLength(0);

    await expect(
      createDedupRepo(handle.db).decideReview(reviews[0]!.review.id, 'kept-separate', 'user'),
    ).rejects.toThrow();
  });

  it('treats offers from different companies as distinct (no fuzzy candidate)', async () => {
    const repo = createJobRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });
    const thresholds = { high: 0.5, medium: 0.05 };

    await repo.ingestJob({ ...ingestData({ externalId: 'distinct-1' }), sourceId: source.id, fuzzy: { thresholds } });
    const second = await repo.ingestJob({
      ...ingestData({
        externalId: 'distinct-2',
        urlHash: 'hash-distinct-2',
        dedupKey: 'fingerprint-distinct-2',
        normalizedJob: normalized({
          externalId: 'distinct-2',
          canonicalUrl: 'https://jobs.example.com/globex/senior-react-developer',
          company: 'Globex',
        }),
      }),
      sourceId: source.id,
      fuzzy: { thresholds },
    });

    expect(second.outcome).toBe('new');
    expect(second.fuzzy?.decision).toBe('distinct');
    expect(second.reviewId).toBeNull();
    expect(await repo.countJobs()).toBe(2);
  });
});