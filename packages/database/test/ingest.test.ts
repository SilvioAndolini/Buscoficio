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

  /* ------------------------------------------------------------------ */
  /* Phase 2.1 — target safe defaults and concurrency                    */
  /* ------------------------------------------------------------------ */

  it('auto-detected targets start blocked with pending-review notes and are never silently reset', async () => {
    const repo = createJobRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });

    const detected = await repo.upsertTarget({
      key: 'greenhouse-acme',
      kind: 'ats_browser',
      platform: 'greenhouse',
      label: 'greenhouse-acme',
    });
    expect(detected.status).toBe('blocked');
    expect(detected.policyNotes).toContain('pending separate platform policy review');

    // Re-detection must not reset authorization nor overwrite notes.
    const reDetected = await repo.upsertTarget({
      key: 'greenhouse-acme',
      kind: 'ats_browser',
      platform: 'greenhouse',
      label: 'greenhouse-acme',
    });
    expect(reDetected.status).toBe('blocked');
    expect(reDetected.policyNotes).toBe(detected.policyNotes);

    // Explicit (audited at API level) review authorizes submission later.
    const authorized = await repo.updateTargetStatus('greenhouse-acme', 'active');
    expect(authorized.status).toBe('active');
    const after = await repo.upsertTarget({
      key: 'greenhouse-acme',
      kind: 'ats_browser',
      platform: 'greenhouse',
      label: 'greenhouse-acme',
    });
    expect(after.status).toBe('active');

    // Discovery association still works with a blocked target.
    const blockedTarget = await repo.upsertTarget({
      key: 'lever-globex',
      kind: 'ats_browser',
      platform: 'lever',
      label: 'lever-globex',
    });
    const result = await repo.ingestJob({
      ...ingestData({ externalId: 'blocked-target-1', applicationTargetId: blockedTarget.id }),
      sourceId: source.id,
    });
    const { job } = await repo.getJobWithListings(result.jobId!);
    expect(job.applicationTargetId).toBe(blockedTarget.id);
  });

  it('is concurrency-safe under L3 HIGH: equivalent offers merge into one canonical job', async () => {
    const repo = createJobRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });
    const thresholds = { high: 0.5, medium: 0.05 };

    for (let round = 0; round < 5; round += 1) {
      const company = `Concurrent Acme ${round}`;
      const build = (suffix: string) => ({
        ...ingestData({
          externalId: `c${round}-${suffix}`,
          urlHash: `hash-${round}-${suffix}`,
          dedupKey: `fp-${round}-${suffix}`,
          normalizedJob: normalized({
            externalId: `c${round}-${suffix}`,
            canonicalUrl: `https://jobs.example.com/${company.replace(/ /g, '-')}/${suffix}`,
            company,
          }),
        }),
        sourceId: source.id,
        fuzzy: { thresholds },
      });

      await Promise.all([repo.ingestJob(build('a')), repo.ingestJob(build('b'))]);

      const jobs = (await repo.listJobs({ limit: 500, offset: 0 })).filter(
        (row) => row.job.company === company,
      );
      expect(jobs).toHaveLength(1);
      const { listings } = await repo.getJobWithListings(jobs[0]!.job.id);
      expect(listings).toHaveLength(2);
    }
  });

  it('is concurrency-safe in the L3 gray zone: never auto-merges, one pending review', async () => {
    const repo = createJobRepo(handle.db);
    const dedupRepo = createDedupRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });
    const thresholds = { high: 0.999, medium: 0.05 };

    for (let round = 0; round < 5; round += 1) {
      const company = `Gray Concurrent Acme ${round}`;
      await Promise.all([
        repo.ingestJob({
          ...ingestData({
            externalId: `g${round}-a`,
            urlHash: `hash-g${round}-a`,
            dedupKey: `fp-g${round}-a`,
            normalizedJob: normalized({
              externalId: `g${round}-a`,
              canonicalUrl: `https://jobs.example.com/gray/${round}/a`,
              company,
            }),
          }),
          sourceId: source.id,
          fuzzy: { thresholds },
        }),
        repo.ingestJob({
          ...ingestData({
            externalId: `g${round}-b`,
            urlHash: `hash-g${round}-b`,
            dedupKey: `fp-g${round}-b`,
            normalizedJob: normalized({
              externalId: `g${round}-b`,
              canonicalUrl: `https://jobs.example.com/gray/${round}/b`,
              company,
              description:
                'Build internal tools with React and TypeScript. You will mentor two engineers extensively.',
            }),
          }),
          sourceId: source.id,
          fuzzy: { thresholds },
        }),
      ]);

      const jobs = (await repo.listJobs({ limit: 500, offset: 0 })).filter(
        (row) => row.job.company === company,
      );
      expect(jobs).toHaveLength(2);
      const pending = (await dedupRepo.listReviews('pending', 100)).filter(
        (entry) => entry.candidateCompany === company,
      );
      expect(pending).toHaveLength(1);
    }
  });

  it('promotes a detected target from a concurrent equivalent listing', async () => {
    const repo = createJobRepo(handle.db);
    const source = await repo.upsertSource({ key: 'mock', name: 'Mock', kind: 'api', capabilities: {} });
    const thresholds = { high: 0.5, medium: 0.05 };

    for (let round = 0; round < 3; round += 1) {
      const company = `Target Concurrent ${round}`;
      const target = await repo.upsertTarget({
        key: `greenhouse-target-${round}`,
        kind: 'ats_browser',
        platform: 'greenhouse',
        label: `greenhouse-target-${round}`,
      });
      await Promise.all([
        repo.ingestJob({
          ...ingestData({
            externalId: `t${round}-a`,
            urlHash: `hash-t${round}-a`,
            dedupKey: `fp-t${round}-a`,
            normalizedJob: normalized({
              externalId: `t${round}-a`,
              canonicalUrl: `https://jobs.example.com/target/${round}/a`,
              company,
            }),
          }),
          sourceId: source.id,
          fuzzy: { thresholds },
        }),
        repo.ingestJob({
          ...ingestData({
            externalId: `t${round}-b`,
            urlHash: `hash-t${round}-b`,
            dedupKey: `fp-t${round}-b`,
            applicationTargetId: target.id,
            applicationTargetSignal: 'redirect',
            normalizedJob: normalized({
              externalId: `t${round}-b`,
              canonicalUrl: `https://jobs.example.com/target/${round}/b`,
              company,
            }),
          }),
          sourceId: source.id,
          fuzzy: { thresholds },
        }),
      ]);

      const jobs = (await repo.listJobs({ limit: 500, offset: 0 })).filter(
        (row) => row.job.company === company,
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.job.applicationTargetId).toBe(target.id);
      const { listings } = await repo.getJobWithListings(jobs[0]!.job.id);
      expect(listings).toHaveLength(2);
    }
  });
});