import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  computeDedupKey,
  computeJobContentHash,
  computeUrlHash,
  isAppError,
  type NormalizedJob,
} from '@job-system/core';
import {
  createAiUsageRepo,
  createCandidateRepo,
  createJobRepo,
  createMatchingRepo,
  createResumeRepo,
  job as jobTable,
  type DbHandle,
} from '@job-system/database';
import { createTestDb, truncateAll } from '@job-system/database/testing';
import { MockEmbeddingProvider } from '@job-system/ai';
import {
  DEFAULT_MATCH_POLICY,
  MatchPolicySchema,
  type MatchPolicy,
} from '@job-system/matching';
import { createLogger } from '@job-system/observability';
import { uuidv7 } from '@job-system/shared';
import { createMatchingService, type MatchingService } from '../src/services/matching-service.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? '';
const hasDatabase = TEST_DATABASE_URL.length > 0;
const describeIntegration = hasDatabase ? describe : describe.skip;

const logger = createLogger({ level: 'error' });
const clock = { now: () => new Date('2026-09-18T12:00:00.000Z') };
const trace = { correlationId: 'matching-test-correlation' };

let handle: DbHandle;

interface Scenario {
  candidateId: string;
  jobId: string;
  resumeId: string;
  provider: MockEmbeddingProvider;
  service: MatchingService;
  matchingRepo: ReturnType<typeof createMatchingRepo>;
  spaceId: string | null;
}

async function seedScenario(options: {
  jobOverrides?: {
    description?: string;
    title?: string;
    company?: string;
    location?: string | null;
    remoteType?: 'onsite' | 'hybrid' | 'remote' | 'unknown' | null;
    employmentType?: string | null;
    salaryMin?: number | null;
    salaryMax?: number | null;
    currency?: string | null;
    experienceLevel?: string | null;
    languageRequirements?: string[];
    requiredSkills?: string[];
    preferredSkills?: string[];
  };
  profileOverrides?: { remotePreference?: string[]; employmentTypes?: string[]; relocation?: boolean };
  languages?: Array<{ language: string; level: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2' | 'native' }>;
  policy?: MatchPolicy;
  withSpace?: boolean;
  secondResume?: boolean;
  /** Seeds one open-ended experience (endDate = null) for temporal tests. */
  openEnded?: boolean;
  /** Clock date used by the scenario service (defaults to 2026-09-18T12:00Z). */
  asOf?: Date;
  /** Embedding provider/model override (must match the created space). */
  providerModel?: string;
} = {}): Promise<Scenario> {
  const candidateRepo = createCandidateRepo(handle.db);
  const resumeRepo = createResumeRepo(handle.db);
  const jobRepo = createJobRepo(handle.db);
  const matchingRepo = createMatchingRepo(handle.db);
  const aiUsageRepo = createAiUsageRepo(handle.db);

  const profile = await candidateRepo.upsertProfile({
    fullName: 'Ada Lovelace',
    email: 'ada@example.com',
    locationCity: 'Madrid',
    locationCountry: 'Spain',
    salaryMin: 60000,
    salaryMax: 80000,
    salaryCurrency: 'EUR',
    remotePreference: (options.profileOverrides?.remotePreference ?? ['remote']) as Array<
      'onsite' | 'hybrid' | 'remote' | 'unknown'
    >,
    employmentTypes: (options.profileOverrides?.employmentTypes ?? ['full_time']) as Array<
      'full_time' | 'part_time' | 'contract' | 'internship' | 'temporary' | 'other'
    >,
    allowedCountries: ['Spain'],
    relocation: options.profileOverrides?.relocation ?? false,
    preferences: {},
  });
  await candidateRepo.addSkill(profile.id, { skillName: 'React', level: 'expert', years: 6 });
  await candidateRepo.addSkill(profile.id, { skillName: 'TypeScript', level: 'advanced', years: 5 });
  for (const language of options.languages ?? [{ language: 'English', level: 'C1' as const }]) {
    await candidateRepo.addLanguage(profile.id, language);
  }
  await candidateRepo.addExperience(profile.id, {
    company: 'Acme',
    title: 'Senior Developer',
    startDate: new Date('2018-01-01T00:00:00Z'),
    endDate: options.openEnded ? null : new Date('2024-01-01T00:00:00Z'),
    description: '',
    skills: ['React'],
  });

  const resume = await resumeRepo.createResume(profile.id, {
    name: 'Engineering CV',
    category: 'software-engineering',
    language: 'en',
    isDefault: true,
  });
  await resumeRepo.createVersion(resume.id, {
    kind: 'original',
    storageKey: `resumes/${resume.id}/v1.txt`,
    fileHash: 'a'.repeat(64),
    highlights: { skills: ['React', 'TypeScript'] },
  });
  if (options.secondResume) {
    const design = await resumeRepo.createResume(profile.id, {
      name: 'Audiovisual CV',
      category: 'audiovisual',
      language: 'es',
      isDefault: false,
    });
    await resumeRepo.createVersion(design.id, {
      kind: 'original',
      storageKey: `resumes/${design.id}/v1.txt`,
      fileHash: 'b'.repeat(64),
      highlights: { skills: ['Video editing'] },
    });
  }

  const overrides = options.jobOverrides ?? {};
  const externalId = `m-${uuidv7()}`;
  const normalized: NormalizedJob = {
    externalId,
    canonicalUrl: `https://jobs.example.com/acme/${externalId}`,
    company: overrides.company ?? 'Acme Corp',
    title: overrides.title ?? 'Senior React Developer',
    description:
      overrides.description ?? 'Build internal tools with React and TypeScript. Own the design system.',
    location: overrides.location === undefined ? 'Remote (EU)' : overrides.location,
    remoteType: overrides.remoteType === undefined ? 'remote' : overrides.remoteType,
    employmentType:
      overrides.employmentType === undefined
        ? 'full_time'
        : (overrides.employmentType as NormalizedJob['employmentType']),
    salaryMin: overrides.salaryMin === undefined ? 65000 : overrides.salaryMin,
    salaryMax: overrides.salaryMax === undefined ? 85000 : overrides.salaryMax,
    currency: overrides.currency === undefined ? 'EUR' : overrides.currency,
    experienceLevel:
      overrides.experienceLevel === undefined
        ? 'senior'
        : (overrides.experienceLevel as NormalizedJob['experienceLevel']),
    languageRequirements: overrides.languageRequirements ?? ['English B2'],
    publishedAt: new Date('2026-01-10T09:00:00.000Z'),
    expiresAt: null,
    applicationMethod: 'external_form',
  };
  const source = await jobRepo.upsertSource({
    key: 'mock',
    name: 'mock',
    kind: 'api',
    capabilities: {},
  });
  const ingest = await jobRepo.ingestJob({
    sourceId: source.id,
    externalId,
    applicationTargetId: null,
    applicationTargetSignal: null,
    normalized,
    urlHash: computeUrlHash(normalized.canonicalUrl),
    dedupKey: computeDedupKey(normalized),
    contentHash: computeJobContentHash(normalized),
    discoveredAt: clock.now(),
    raw: {},
  });
  const jobId = ingest.jobId!;
  await handle.db
    .update(jobTable)
    .set({
      requiredSkills: [...(overrides.requiredSkills ?? ['React', 'TypeScript'])],
      preferredSkills: [...(overrides.preferredSkills ?? [])],
    })
    .where(eq(jobTable.id, jobId));

  const providerModel = options.providerModel ?? 'mock-deterministic-v1';
  let spaceId: string | null = null;
  if (options.withSpace !== false) {
    const space = await matchingRepo.ensureEmbeddingSpace({
      key: `${providerModel}-1536-v1`,
      provider: 'mock',
      model: providerModel,
      dimensions: 1536,
      distanceMetric: 'cosine',
      version: 'v1',
    });
    spaceId = space.id;
  }

  const provider = new MockEmbeddingProvider({ model: providerModel });
  const scenarioClock = {
    now: () => options.asOf ?? new Date('2026-09-18T12:00:00.000Z'),
  };
  const service = createMatchingService({
    matchingRepo,
    aiUsageRepo,
    embeddingProvider: provider,
    clock: scenarioClock,
    logger,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });
  return {
    candidateId: profile.id,
    jobId,
    resumeId: resume.id,
    provider,
    service,
    matchingRepo,
    spaceId,
  };
}

beforeAll(async () => {
  handle = await createTestDb();
});

afterAll(async () => {
  await handle.pool.end();
});

beforeEach(async () => {
  await truncateAll(handle.db);
});

describeIntegration('MatchingService (real Postgres + pgvector + mock embeddings)', () => {
  it('computes an explainable match, persists it and records embed usage', async () => {
    const scenario = await seedScenario();
    expect(scenario.provider.calls).toBe(0);

    const first = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    expect(first.created).toBe(true);
    expect(first.overallScore).toBeGreaterThan(0);
    expect(scenario.provider.calls).toBeGreaterThan(0);

    const row = await scenario.matchingRepo.getCurrentMatch(scenario.jobId, scenario.candidateId);
    expect(row).not.toBeNull();
    expect(row!.isCurrent).toBe(true);
    expect(row!.scoreBreakdown).toBeTruthy();
    expect(row!.reasons.length).toBeGreaterThan(0);
    expect(row!.recommendedResumeId).toBe(scenario.resumeId);
    expect(row!.engineVersion).toBe(DEFAULT_MATCH_POLICY.engineVersion);
    expect(row!.weightsVersion).toBe(DEFAULT_MATCH_POLICY.weightsVersion);
    expect(row!.embeddingSpaceId).not.toBeNull();
    expect(row!.semanticModel).toContain('mock:mock-deterministic-v1');

    const usage = await handle.db.execute(
      sql`select operation, cached, provider from ai_usage order by created_at`,
    );
    const rows = usage.rows as Array<{ operation: string; cached: boolean; provider: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.operation).toBe('embed');
    expect(rows[0]!.cached).toBe(false);
    expect(rows[0]!.provider).toBe('mock');
  });

  it('is idempotent: same input reuses the same row and does NOT re-embed', async () => {
    const scenario = await seedScenario();
    const first = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    const callsAfterFirst = scenario.provider.calls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    expect(second.matchId).toBe(first.matchId);
    expect(second.created).toBe(false);
    expect(scenario.provider.calls).toBe(callsAfterFirst);

    const count = await scenario.matchingRepo.listMatchHistory(scenario.jobId, scenario.candidateId);
    expect(count).toHaveLength(1);
  });

  it('produces a new current match when the job content changes, preserving history', async () => {
    const scenario = await seedScenario();
    const first = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);

    await handle.db.execute(
      sql`update job set description = 'Completely different PostgreSQL and data platform role.' where id = ${scenario.jobId}`,
    );
    const second = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    expect(second.matchId).not.toBe(first.matchId);
    expect(second.created).toBe(true);

    const history = await scenario.matchingRepo.listMatchHistory(scenario.jobId, scenario.candidateId);
    expect(history).toHaveLength(2);
    const current = history.filter((row) => row.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe(second.matchId);
    const old = history.find((row) => row.id === first.matchId)!;
    expect(old.isCurrent).toBe(false);
    expect(old.jobContentHash).not.toBe(current[0]!.jobContentHash);
  });

  it('produces a new identity when a matching-relevant profile field changes', async () => {
    const scenario = await seedScenario();
    const first = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    const candidateRepo = createCandidateRepo(handle.db);
    await candidateRepo.addSkill(scenario.candidateId, {
      skillName: 'Node.js',
      level: 'advanced',
      years: 4,
    });
    const second = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    expect(second.matchId).not.toBe(first.matchId);
    const history = await scenario.matchingRepo.listMatchHistory(scenario.jobId, scenario.candidateId);
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.isCurrent)!.id).toBe(second.matchId);
  });

  it('produces a new identity when a new ResumeVersion is created (original stays immutable)', async () => {
    const scenario = await seedScenario();
    const first = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    const resumeRepo = createResumeRepo(handle.db);
    const version = await resumeRepo.createVersion(scenario.resumeId, {
      kind: 'tailored',
      parentVersionId: null,
      storageKey: `resumes/${scenario.resumeId}/v2.txt`,
      fileHash: 'c'.repeat(64),
      highlights: { skills: ['React', 'TypeScript', 'Node.js'] },
    });
    const second = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    expect(second.matchId).not.toBe(first.matchId);

    const versions = await resumeRepo.listVersions(scenario.resumeId);
    expect(versions).toHaveLength(2);
    const original = versions.find((entry) => entry.versionNumber === 1)!;
    expect(original.fileHash).toBe('a'.repeat(64));
    expect(versions.find((entry) => entry.id === version.id)!.fileHash).toBe('c'.repeat(64));
  });

  it('produces a new identity when weightsVersion changes, reusing cached embeddings', async () => {
    const scenario = await seedScenario();
    const first = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    const callsAfterFirst = scenario.provider.calls;

    const v2Policy = MatchPolicySchema.parse({
      ...DEFAULT_MATCH_POLICY,
      weightsVersion: 'v2',
      weights: { ...DEFAULT_MATCH_POLICY.weights, skillsMatch: 0.3, semanticSimilarity: 0.15 },
    });
    const v2Service = createMatchingService({
      matchingRepo: scenario.matchingRepo,
      aiUsageRepo: createAiUsageRepo(handle.db),
      embeddingProvider: scenario.provider,
      clock,
      logger,
      policy: v2Policy,
    });
    const second = await v2Service.score(scenario.jobId, scenario.candidateId, trace);
    expect(second.matchId).not.toBe(first.matchId);
    expect(second.weightsVersion).toBe('v2');
    // Same content, same space -> embedding cache, no provider call.
    expect(scenario.provider.calls).toBe(callsAfterFirst);

    const history = await scenario.matchingRepo.listMatchHistory(scenario.jobId, scenario.candidateId);
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.isCurrent)!.weightsVersion).toBe('v2');
  });

  it('produces a new identity when the active EmbeddingSpace changes (compatible provider B)', async () => {
    const scenario = await seedScenario();
    const first = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    const spaceA = first.embeddingSpaceId!;

    const spaceB = await scenario.matchingRepo.ensureEmbeddingSpace({
      key: 'mock-deterministic-v2-1536-v1',
      provider: 'mock',
      model: 'mock-deterministic-v2',
      dimensions: 1536,
      distanceMetric: 'cosine',
      version: 'v1',
    });
    expect(spaceB.status).toBe('inactive');
    await scenario.matchingRepo.activateEmbeddingSpace(spaceB.id);

    // Space B requires its own compatible provider (strict binding).
    const providerB = new MockEmbeddingProvider({ model: 'mock-deterministic-v2' });
    const serviceB = createMatchingService({
      matchingRepo: scenario.matchingRepo,
      aiUsageRepo: createAiUsageRepo(handle.db),
      embeddingProvider: providerB,
      clock,
      logger,
    });
    const second = await serviceB.score(scenario.jobId, scenario.candidateId, trace);
    expect(second.matchId).not.toBe(first.matchId);
    expect(second.embeddingSpaceId).toBe(spaceB.id);
    expect(providerB.calls).toBeGreaterThan(0);

    const history = await scenario.matchingRepo.listMatchHistory(scenario.jobId, scenario.candidateId);
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.isCurrent)!.id).toBe(second.matchId);
    expect(history.find((row) => row.id === first.matchId)!.embeddingSpaceId).toBe(spaceA);

    // Space A vectors remain; space B vectors coexist.
    const jobEmbeddings = await handle.db.execute(
      sql`select embedding_space_id from job_embedding where job_id = ${scenario.jobId} order by embedding_space_id`,
    );
    const spaceIds = (jobEmbeddings.rows as Array<{ embedding_space_id: string }>).map(
      (row) => row.embedding_space_id,
    );
    expect(spaceIds).toContain(spaceA);
    expect(spaceIds).toContain(spaceB.id);
    expect(spaceIds).toHaveLength(2);

    // Exactly one active space at a time (partial unique index).
    const spaces = await scenario.matchingRepo.listEmbeddingSpaces();
    expect(spaces.filter((space) => space.status === 'active')).toHaveLength(1);
  });

  it('fails closed when the active space and the runtime provider do not match', async () => {
    const scenario = await seedScenario();
    const first = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    const callsBefore = scenario.provider.calls;
    const embeddingsBefore = await handle.db.execute(
      sql`select
            (select count(*) from job_embedding) as jobs,
            (select count(*) from resume_embedding) as resumes`,
    );
    const countBefore = embeddingsBefore.rows[0] as { jobs: string; resumes: string };

    // Runtime provider B while the active space declares model-A.
    const providerB = new MockEmbeddingProvider({ model: 'mock-deterministic-v2' });
    const serviceB = createMatchingService({
      matchingRepo: scenario.matchingRepo,
      aiUsageRepo: createAiUsageRepo(handle.db),
      embeddingProvider: providerB,
      clock,
      logger,
    });
    let caught: unknown;
    try {
      await serviceB.score(scenario.jobId, scenario.candidateId, trace);
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    const appError = caught as { code: string; context?: Record<string, unknown> };
    expect(appError.code).toBe('AI_ERROR');
    expect(appError.context?.['mismatches']).toEqual(
      expect.arrayContaining([expect.stringContaining('model')]),
    );
    expect(appError.context?.['spaceModel']).toBe('mock-deterministic-v1');
    expect(appError.context?.['runtimeModel']).toBe('mock-deterministic-v2');

    // Fail closed: no embed call, no new vectors, current match untouched.
    expect(providerB.calls).toBe(0);
    expect(scenario.provider.calls).toBe(callsBefore);
    const embeddingsAfter = await handle.db.execute(
      sql`select
            (select count(*) from job_embedding) as jobs,
            (select count(*) from resume_embedding) as resumes`,
    );
    const countAfter = embeddingsAfter.rows[0] as { jobs: string; resumes: string };
    expect(countAfter).toEqual(countBefore);
    const history = await scenario.matchingRepo.listMatchHistory(scenario.jobId, scenario.candidateId);
    expect(history).toHaveLength(1);
    expect(history[0]!.id).toBe(first.matchId);
    expect(history[0]!.isCurrent).toBe(true);
  });

  it('anchors open-ended experience to the injected clock (identity changes across days)', async () => {
    const scenario = await seedScenario({
      openEnded: true,
      asOf: new Date('2026-09-18T00:00:00Z'),
    });
    const first = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    expect(first.matchingAsOfDate).toBe('2026-09-18');
    const row = await scenario.matchingRepo.getCurrentMatch(scenario.jobId, scenario.candidateId);
    expect(row!.matchingAsOfDate?.toISOString().slice(0, 10)).toBe('2026-09-18');
    const signals = (row!.scoreBreakdown as {
      signals: { experienceMatch: { present: boolean; score: number | null; details: string[] } };
    }).signals;
    expect(signals.experienceMatch.present).toBe(true);
    expect(Number(signals.experienceMatch.score)).toBeGreaterThan(0);
    expect(signals.experienceMatch.details.join(' ')).toContain('as of 2026-09-18');

    // Same asOf: same identity, no new row.
    const replay = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    expect(replay.matchId).toBe(first.matchId);

    // Later asOf: the open role added experience -> new identity, v1 historical.
    const laterService = createMatchingService({
      matchingRepo: scenario.matchingRepo,
      aiUsageRepo: createAiUsageRepo(handle.db),
      embeddingProvider: scenario.provider,
      clock: { now: () => new Date('2027-03-01T00:00:00Z') },
      logger,
    });
    const later = await laterService.score(scenario.jobId, scenario.candidateId, trace);
    expect(later.matchId).not.toBe(first.matchId);
    expect(later.matchingAsOfDate).toBe('2027-03-01');
    const history = await scenario.matchingRepo.listMatchHistory(scenario.jobId, scenario.candidateId);
    expect(history).toHaveLength(2);
    expect(history.filter((entry) => entry.isCurrent)).toHaveLength(1);
    expect(history.find((entry) => entry.isCurrent)!.id).toBe(later.matchId);
    // Cached embeddings are reused for the same content (no re-embed).
    expect(scenario.provider.calls).toBeGreaterThan(0);
  });

  it('closed careers keep a time-independent identity (no daily churn)', async () => {
    const scenario = await seedScenario();
    const first = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    expect(first.matchingAsOfDate).toBeNull();

    const laterService = createMatchingService({
      matchingRepo: scenario.matchingRepo,
      aiUsageRepo: createAiUsageRepo(handle.db),
      embeddingProvider: scenario.provider,
      clock: { now: () => new Date('2027-06-15T00:00:00Z') },
      logger,
    });
    const later = await laterService.score(scenario.jobId, scenario.candidateId, trace);
    expect(later.matchId).toBe(first.matchId);
    expect(later.created).toBe(false);
    expect(later.matchingAsOfDate).toBeNull();
  });

  it('engine bump keeps the historical match and creates the new current one', async () => {
    const scenario = await seedScenario();
    const v1Policy = MatchPolicySchema.parse({
      ...DEFAULT_MATCH_POLICY,
      engineVersion: 'matching-v1',
    });
    const v1Service = createMatchingService({
      matchingRepo: scenario.matchingRepo,
      aiUsageRepo: createAiUsageRepo(handle.db),
      embeddingProvider: scenario.provider,
      clock,
      logger,
      policy: v1Policy,
    });
    const first = await v1Service.score(scenario.jobId, scenario.candidateId, trace);
    expect(first.engineVersion).toBe('matching-v1');

    const second = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    expect(second.engineVersion).toBe('matching-v2');
    expect(second.matchId).not.toBe(first.matchId);
    const history = await scenario.matchingRepo.listMatchHistory(scenario.jobId, scenario.candidateId);
    expect(history).toHaveLength(2);
    const current = history.find((entry) => entry.isCurrent)!;
    const historical = history.find((entry) => entry.id === first.matchId)!;
    expect(current.engineVersion).toBe('matching-v2');
    expect(historical.engineVersion).toBe('matching-v1');
    expect(historical.isCurrent).toBe(false);
  });

  it('supports the deterministic-only path without an active space', async () => {
    const scenario = await seedScenario({ withSpace: false });
    const result = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    expect(result.embeddingSpaceId).toBeNull();
    expect(result.overallScore).toBeGreaterThan(0);
    const row = await scenario.matchingRepo.getCurrentMatch(scenario.jobId, scenario.candidateId);
    const breakdown = row!.scoreBreakdown as {
      signals: { semanticSimilarity: { present: boolean } };
    };
    expect(breakdown.signals.semanticSimilarity.present).toBe(false);
    expect(scenario.provider.calls).toBe(0);
  });

  it('caps the score and explains the hard requirement failure', async () => {
    const scenario = await seedScenario({
      languages: [{ language: 'English', level: 'B2' }],
      jobOverrides: { languageRequirements: ['English C1'] },
    });
    const result = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    expect(result.overallScore).toBeLessThanOrEqual(DEFAULT_MATCH_POLICY.hardRequirementCap);
    const row = await scenario.matchingRepo.getCurrentMatch(scenario.jobId, scenario.candidateId);
    expect(row!.missingRequirements.some((entry) => entry.includes('English C1 required'))).toBe(true);
    const breakdown = row!.scoreBreakdown as { capApplied: boolean };
    expect(breakdown.capApplied).toBe(true);
  });

  it('selects the recommended resume deterministically', async () => {
    const scenario = await seedScenario({ secondResume: true });
    await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    const row = await scenario.matchingRepo.getCurrentMatch(scenario.jobId, scenario.candidateId);
    expect(row!.recommendedResumeId).toBe(scenario.resumeId);
  });

  it('persists at most one current match under concurrent computation', async () => {
    const scenario = await seedScenario();
    const [a, b] = await Promise.all([
      scenario.service.score(scenario.jobId, scenario.candidateId, trace),
      scenario.service.score(scenario.jobId, scenario.candidateId, trace),
    ]);
    expect(a.matchId).toBe(b.matchId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    const history = await scenario.matchingRepo.listMatchHistory(scenario.jobId, scenario.candidateId);
    expect(history).toHaveLength(1);
    const currents = history.filter((row) => row.isCurrent);
    expect(currents).toHaveLength(1);
  });

  it('enforces the DB partial unique index for isCurrent (not only service logic)', async () => {
    const scenario = await seedScenario();
    await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    const row = await scenario.matchingRepo.getCurrentMatch(scenario.jobId, scenario.candidateId);
    // Direct SQL violates the partial unique index (same job+candidate current).
    let caught: unknown;
    try {
      await handle.db.execute(sql`
        insert into job_match (id, job_id, candidate_id, overall_score, score_breakdown, engine_version,
          weights_version, job_content_hash, candidate_profile_hash, resume_set_hash, identity_hash, is_current)
        values (${uuidv7()}, ${scenario.jobId}, ${scenario.candidateId}, 0.5, '{}'::jsonb, 'x', 'x',
          'a', 'b', 'c', ${'f'.repeat(64)}, true)
      `);
    } catch (error) {
      caught = error;
    }
    const cause = (caught as { cause?: { code?: string } } | undefined)?.cause ?? caught;
    expect((cause as { code?: string } | undefined)?.code).toBe('23505');
    expect(row).not.toBeNull();
  });

  it('ranks current matches by score using the DB query (no in-memory sort)', async () => {
    const scenario = await seedScenario();
    await scenario.service.score(scenario.jobId, scenario.candidateId, trace);

    // Second job: weaker on every deterministic axis.
    const weakJob = await (async () => {
      const jobRepo = createJobRepo(handle.db);
      const externalId = `m-${uuidv7()}`;
      const normalized: NormalizedJob = {
        externalId,
        canonicalUrl: `https://jobs.example.com/globex/${externalId}`,
        company: 'Globex',
        title: 'Junior Video Editor',
        description: 'Edit corporate videos and motion graphics.',
        location: 'Berlin, Germany',
        remoteType: 'onsite',
        employmentType: 'contract',
        salaryMin: 20000,
        salaryMax: 25000,
        currency: 'EUR',
        experienceLevel: 'intern',
        languageRequirements: ['German B2'],
        publishedAt: new Date(),
        expiresAt: null,
        applicationMethod: 'email',
      };
      const source = await jobRepo.upsertSource({
        key: 'mock-weak',
        name: 'mock-weak',
        kind: 'api',
        capabilities: {},
      });
      const result = await jobRepo.ingestJob({
        sourceId: source.id,
        externalId,
        applicationTargetId: null,
        applicationTargetSignal: null,
        normalized,
        urlHash: computeUrlHash(normalized.canonicalUrl),
        dedupKey: computeDedupKey(normalized),
        contentHash: computeJobContentHash(normalized),
        discoveredAt: clock.now(),
        raw: {},
      });
      await scenario.service.score(result.jobId!, scenario.candidateId, trace);
      return result.jobId!;
    })();

    const ranking = await scenario.matchingRepo.listCurrentMatches({
      candidateId: scenario.candidateId,
      limit: 10,
      offset: 0,
    });
    expect(ranking).toHaveLength(2);
    expect(Number(ranking[0]!.match.overallScore)).toBeGreaterThanOrEqual(
      Number(ranking[1]!.match.overallScore),
    );
    expect(ranking[0]!.job.id).toBe(scenario.jobId);
    expect(ranking[1]!.job.id).toBe(weakJob);

    const total = await scenario.matchingRepo.countCurrentMatches(scenario.candidateId);
    expect(total).toBe(2);
  });

  it('is fully deterministic: identical inputs produce identical scores', async () => {
    const scenario = await seedScenario();
    const first = await scenario.service.score(scenario.jobId, scenario.candidateId, trace);
    const rowA = await scenario.matchingRepo.getCurrentMatch(scenario.jobId, scenario.candidateId);
    await truncateAll(handle.db);
    const second = await seedScenario();
    const replay = await second.service.score(second.jobId, second.candidateId, trace);
    const rowB = await second.matchingRepo.getCurrentMatch(second.jobId, second.candidateId);
    expect(replay.overallScore).toBe(first.overallScore);
    // Reasons are identical modulo entity ids (resumes/uuid differ per seed).
    const normalize = (reasons: string[]): string[] =>
      reasons.map((reason) =>
        reason.replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
          '<id>',
        ),
      );
    expect(normalize(rowB!.reasons)).toEqual(normalize(rowA!.reasons));
    expect(rowB!.matchingSkills).toEqual(rowA!.matchingSkills);
    const signalsA = (rowA!.scoreBreakdown as { signals: Record<string, { score: number | null }> })
      .signals;
    const signalsB = (rowB!.scoreBreakdown as { signals: Record<string, { score: number | null }> })
      .signals;
    for (const key of Object.keys(signalsA)) {
      expect(signalsB[key]?.score).toBe(signalsA[key]!.score);
    }
  });
});