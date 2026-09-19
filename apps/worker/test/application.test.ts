import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import {
  computeDedupKey,
  computeJobContentHash,
  computeUrlHash,
  ConflictError,
  type NormalizedJob,
  type TextGenerationPort,
  type TraceContext,
} from '@job-system/core';
import {
  createAiUsageRepo,
  createApplicationRepo,
  createCandidateRepo,
  createJobRepo,
  createMatchingRepo,
  createResumeRepo,
  job as jobTable,
  type DbHandle,
} from '@job-system/database';
import { createTestDb, truncateAll } from '@job-system/database/testing';
import { MockTextGenerationProvider } from '@job-system/ai';
import { hashQuestion } from '@job-system/documents';
import { createLogger } from '@job-system/observability';
import { LocalStorageAdapter } from '@job-system/storage';
import { uuidv7, type Env } from '@job-system/shared';
import {
  createApplicationService,
  type ApplicationService,
} from '../src/services/application-service.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? '';
const hasDatabase = TEST_DATABASE_URL.length > 0;
const describeIntegration = hasDatabase ? describe : describe.skip;

const logger = createLogger({ level: 'error' });
const clock = { now: () => new Date('2026-09-18T12:00:00.000Z') };

function buildEnv(storageDir: string): Env {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: process.env['TEST_REDIS_URL'] ?? 'redis://localhost:56379',
    API_HOST: '127.0.0.1',
    API_PORT: 0,
    AUTH_PASSWORD_HASH: 'a'.repeat(64),
    AUTH_SECRET: 'test-secret-value-1234567890',
    AUTH_COOKIE_SECURE: false,
    DRY_RUN: true,
    AUTO_APPLY_ENABLED: false,
    STORAGE_BACKEND: 'local',
    STORAGE_LOCAL_DIR: storageDir,
    LOG_LEVEL: 'error',
    AI_PROVIDER: 'mock',
    DECISION_PROVIDER: 'mock',
    AI_MONTHLY_BUDGET_USD: 0,
    DEDUP_L3_HIGH_THRESHOLD: 0.92,
    DEDUP_L3_MEDIUM_THRESHOLD: 0.75,
    WATCHDOG_TIMEOUT_MS: 900_000,
    SCHEDULER_ENABLED: false,
    TARGET_ENRICHMENT_MAX_PER_RUN: 0,
    EMBEDDING_DIMENSIONS: 1536,
    EMBEDDING_SPACE_VERSION: 'v1',
    EMBEDDING_PROVIDER: 'mock',
    APPLICATION_PREPARATION_POLICY_VERSION: 'application-prep-v1',
    REAPPLICATION_COOLDOWN_DAYS: 30,
  };
}

let handle: DbHandle;
let storageDir: string;
let storage: LocalStorageAdapter;
let env: Env;

beforeAll(async () => {
  handle = await createTestDb();
  storageDir = await mkdtemp(join(tmpdir(), 'job-system-app-storage-'));
  storage = new LocalStorageAdapter(storageDir);
  env = buildEnv(storageDir);
});

afterAll(async () => {
  await handle.pool.end();
  await rm(storageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(handle.db);
});

interface Scenario {
  candidateId: string;
  resumeId: string;
  resumeVersionId: string;
  sourceId: string;
}

async function seedCandidate(): Promise<Scenario> {
  const candidateRepo = createCandidateRepo(handle.db);
  const resumeRepo = createResumeRepo(handle.db);
  const jobRepo = createJobRepo(handle.db);
  const profile = await candidateRepo.upsertProfile({
    fullName: 'Ada Lovelace',
    email: 'ada@example.com',
    headline: 'Software Engineer',
    remotePreference: ['remote'],
    employmentTypes: ['full_time'],
    allowedCountries: ['Spain'],
    relocation: false,
    preferences: {},
  });
  await candidateRepo.addSkill(profile.id, { skillName: 'React', level: 'expert', years: 5 });
  await candidateRepo.addExperience(profile.id, {
    company: 'Acme Corp',
    title: 'Senior Developer',
    startDate: new Date('2018-01-01T00:00:00Z'),
    endDate: new Date('2024-01-01T00:00:00Z'),
    description: 'Built things',
    skills: ['React'],
  });
  const resume = await resumeRepo.createResume(profile.id, {
    name: 'Engineering CV',
    category: 'software-engineering',
    language: 'en',
    isDefault: true,
  });
  const version = await resumeRepo.createVersion(resume.id, {
    kind: 'original',
    storageKey: `resumes/${resume.id}/v1.txt`,
    fileHash: 'a'.repeat(64),
    highlights: { skills: ['React'] },
  });
  const source = await jobRepo.upsertSource({
    key: 'mock',
    name: 'mock',
    kind: 'api',
    capabilities: {},
  });
  return {
    candidateId: profile.id,
    resumeId: resume.id,
    resumeVersionId: version.id,
    sourceId: source.id,
  };
}

async function seedMatchedJob(
  scenario: Scenario,
  title: string,
  options: { omitResumeSelection?: boolean } = {},
): Promise<{ jobId: string; matchId: string }> {
  const jobRepo = createJobRepo(handle.db);
  const matchingRepo = createMatchingRepo(handle.db);
  const externalId = `app-${uuidv7()}`;
  const normalized: NormalizedJob = {
    externalId,
    canonicalUrl: `https://jobs.example.com/acme/${externalId}`,
    company: 'Acme Corp',
    title,
    description: 'Build internal tools with React and TypeScript.',
    location: 'Remote (EU)',
    remoteType: 'remote',
    employmentType: 'full_time',
    salaryMin: 65_000,
    salaryMax: 85_000,
    currency: 'EUR',
    experienceLevel: 'senior',
    languageRequirements: ['English B2'],
    publishedAt: new Date('2026-01-10T09:00:00.000Z'),
    expiresAt: null,
    applicationMethod: 'external_form',
  };
  const ingest = await jobRepo.ingestJob({
    sourceId: scenario.sourceId,
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
    .set({ requiredSkills: ['React'], preferredSkills: ['TypeScript'] })
    .where(eq(jobTable.id, jobId));
  const { row: match } = await matchingRepo.upsertCurrentMatch({
    jobId,
    candidateId: scenario.candidateId,
    overallScore: 0.82,
    scoreBreakdown: options.omitResumeSelection
      ? {}
      : {
          resumeSelection: {
            recommendedResumeId: scenario.resumeId,
            recommendedResumeVersionId: scenario.resumeVersionId,
            reasons: ['category match'],
          },
        },
    reasons: ['strong skills coverage'],
    missingRequirements: [],
    matchingSkills: ['React'],
    recommendedResumeId: scenario.resumeId,
    engineVersion: 'matching-v2',
    weightsVersion: 'v1',
    jobContentHash: computeJobContentHash(normalized),
    candidateProfileHash: 'b'.repeat(64),
    resumeSetHash: 'e'.repeat(64),
    embeddingSpaceId: null,
    identityHash: uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    semanticModel: null,
    matchingAsOfDate: null,
    computedAt: clock.now(),
  });
  return { jobId, matchId: match.id };
}

function buildService(
  textProvider?: TextGenerationPort,
  clockOverride?: { now: () => Date },
): ApplicationService {
  return createApplicationService({
    repo: createApplicationRepo(handle.db, handle.pool),
    aiUsageRepo: createAiUsageRepo(handle.db),
    storage,
    clock: clockOverride ?? clock,
    env,
    logger,
    ...(textProvider === undefined ? {} : { textProvider }),
  });
}

function trace(applicationId?: string): TraceContext {
  return applicationId === undefined
    ? { correlationId: 'application-test' }
    : { correlationId: 'application-test', applicationId };
}

const INVENTED_COVER_LETTER = {
  kind: 'structured' as const,
  value: {
    tone: 'direct',
    opening: 'direct',
    closing: 'thanks',
    claims: [{ kind: 'years_experience', value: { years: 10, skill: 'AWS' } }],
  },
};

const VALID_COVER_LETTER = {
  kind: 'structured' as const,
  value: {
    tone: 'direct',
    opening: 'direct',
    closing: 'thanks',
    claims: [{ kind: 'years_experience', value: { years: 5, skill: 'React' } }],
  },
};

describeIntegration('application preparation integration (Phase 4)', () => {
  it('creates from match, prepares documents and keeps the original CV immutable', async () => {
    const scenario = await seedCandidate();
    const { matchId } = await seedMatchedJob(scenario, 'Senior React Developer');
    const service = buildService();

    const created = await service.createFromMatch({ matchId, mode: 'assisted' }, trace());
    expect(created.created).toBe(true);
    expect(created.application.status).toBe('SHORTLISTED');
    expect(created.application.scoreAtCreation).toBeCloseTo(0.82);
    expect(created.application.resumeVersionId).toBe(scenario.resumeVersionId);

    const result = await service.prepare(created.application.id, trace(created.application.id));
    expect(result.status).toBe('PREPARING');
    expect(result.requiresHumanInput).toBe(false);
    expect(result.documents.map((document) => document.kind).sort()).toEqual([
      'cover_letter',
      'resume_variant',
    ]);

    const documents = await createApplicationRepo(handle.db, handle.pool).listDocuments(
      created.application.id,
    );
    const variantDocument = documents.find((document) => document.kind === 'resume_variant')!;
    const coverDocument = documents.find((document) => document.kind === 'cover_letter')!;
    expect(variantDocument.verification.status).toBe('verified');
    expect(coverDocument.generatedBy.provider).toBe('mock');

    // Tailored version: new row, original untouched.
    const versions = await handle.db.execute(sql`
      select id, version_number, kind, parent_version_id, file_hash, storage_key
      from resume_version order by version_number
    `);
    const rows = versions.rows as Array<{
      id: string;
      version_number: number;
      kind: string;
      parent_version_id: string | null;
      file_hash: string;
      storage_key: string;
    }>;
    expect(rows).toHaveLength(2);
    const original = rows.find((row) => row.kind === 'original')!;
    const tailored = rows.find((row) => row.kind === 'tailored')!;
    expect(original.file_hash).toBe('a'.repeat(64));
    expect(tailored.parent_version_id).toBe(scenario.resumeVersionId);
    expect(tailored.file_hash).toBe(variantDocument.contentHash);
    expect(tailored.storage_key).not.toBe(original.storage_key);
    expect(await storage.exists(tailored.storage_key)).toBe(true);
    expect(await storage.exists(coverDocument.storageKey)).toBe(true);

    // Event + ai_usage with applicationId and no invented cost.
    const events = await createApplicationRepo(handle.db, handle.pool).listEvents(
      created.application.id,
    );
    expect(events.some((event) => event.type === 'application.documents_prepared')).toBe(true);
    const usage = await handle.db.execute(sql`
      select operation, provider, cost_estimate_usd, application_id
      from ai_usage where operation = 'cover_letter'
    `);
    const usageRows = usage.rows as Array<{
      provider: string;
      cost_estimate_usd: string | null;
      application_id: string | null;
    }>;
    expect(usageRows.length).toBeGreaterThan(0);
    expect(usageRows[0]!.provider).toBe('mock');
    expect(usageRows[0]!.cost_estimate_usd).toBe('0.000000');
    expect(usageRows[0]!.application_id).toBe(created.application.id);

    // preparationSnapshot stays NULL in Phase 4.
    expect(created.application.preparationSnapshot).toBeNull();
    const snapshot = await handle.db.execute(
      sql`select preparation_snapshot from application where id = ${created.application.id}`,
    );
    expect((snapshot.rows[0] as { preparation_snapshot: unknown }).preparation_snapshot).toBeNull();
  });

  it('repairs an invented claim once and persists the valid document', async () => {
    const scenario = await seedCandidate();
    const { matchId } = await seedMatchedJob(scenario, 'React Engineer');
    const provider = new MockTextGenerationProvider({
      responses: [INVENTED_COVER_LETTER, VALID_COVER_LETTER],
    });
    const service = buildService(provider);
    const created = await service.createFromMatch({ matchId, mode: 'assisted' }, trace());
    const result = await service.prepare(created.application.id, trace(created.application.id));
    expect(result.status).toBe('PREPARING');
    expect(result.requiresHumanInput).toBe(false);
    expect(provider.calls).toHaveLength(2);
    const documents = await createApplicationRepo(handle.db, handle.pool).listDocuments(
      created.application.id,
    );
    const cover = documents.find((document) => document.kind === 'cover_letter')!;
    expect(cover.verification.status).toBe('verified');
    expect(cover.claims[0]!.claim).toBe('5 years of experience with React');
    const stored = new TextDecoder().decode(await storage.get(cover.storageKey));
    expect(stored).toContain('I have 5 years of experience with React.');
    expect(stored).not.toContain('AWS');
  });

  it('raises REQUIRES_HUMAN_ACTION after the single repair fails', async () => {
    const scenario = await seedCandidate();
    const { matchId } = await seedMatchedJob(scenario, 'AWS Engineer');
    const provider = new MockTextGenerationProvider({
      responses: [INVENTED_COVER_LETTER, INVENTED_COVER_LETTER],
    });
    const service = buildService(provider);
    const created = await service.createFromMatch({ matchId, mode: 'assisted' }, trace());
    const result = await service.prepare(created.application.id, trace(created.application.id));
    expect(result.status).toBe('REQUIRES_HUMAN_ACTION');
    expect(result.requiresHumanInput).toBe(true);
    expect(result.blockers.some((blocker) => blocker.code === 'rejected_claims')).toBe(true);
    expect(provider.calls).toHaveLength(2);

    const documents = await createApplicationRepo(handle.db, handle.pool).listDocuments(
      created.application.id,
    );
    expect(documents.some((document) => document.kind === 'cover_letter')).toBe(false);
    expect(documents.some((document) => document.kind === 'resume_variant')).toBe(true);

    const row = await createApplicationRepo(handle.db, handle.pool).getApplication(
      created.application.id,
    );
    expect(row!.requiresHumanReason).toMatch(/AWS|rejected/i);

    // Human resolution returns to PREPARING.
    const resolved = await service.resolveHumanAction(
      created.application.id,
      'Profile updated manually',
      trace(created.application.id),
    );
    expect(resolved.status).toBe('PREPARING');
  });

  it('is idempotent for sequential and concurrent preparations', async () => {
    const scenario = await seedCandidate();
    const { matchId } = await seedMatchedJob(scenario, 'Idempotent Engineer');
    const service = buildService();
    const created = await service.createFromMatch({ matchId, mode: 'assisted' }, trace());

    await service.prepare(created.application.id, trace(created.application.id));
    const second = await service.prepare(created.application.id, trace(created.application.id));
    expect(second.created).toBe(false);
    expect(second.documents).toHaveLength(2);

    const [concurrentA, concurrentB] = await Promise.all([
      service.prepare(created.application.id, trace(created.application.id)),
      service.prepare(created.application.id, trace(created.application.id)),
    ]);
    expect(concurrentA.documents).toHaveLength(2);
    expect(concurrentB.documents).toHaveLength(2);

    const repo = createApplicationRepo(handle.db, handle.pool);
    const documents = await repo.listDocuments(created.application.id);
    expect(documents).toHaveLength(2);
    const events = await repo.listEvents(created.application.id);
    expect(events.filter((event) => event.type === 'application.documents_prepared')).toHaveLength(1);
    const versions = await handle.db.execute(
      sql`select count(*)::int as count from resume_version where kind = 'tailored'`,
    );
    expect((versions.rows[0] as { count: number }).count).toBe(1);
  });

  it('reuses an approved answer after revalidation and invalidates it when stale', async () => {
    const scenario = await seedCandidate();
    const first = await seedMatchedJob(scenario, 'First Job');
    const second = await seedMatchedJob(scenario, 'Second Job');
    const third = await seedMatchedJob(scenario, 'Third Job');
    const service = buildService();
    const repo = createApplicationRepo(handle.db, handle.pool);

    const applicationA = await service.createFromMatch(
      { matchId: first.matchId, mode: 'assisted' },
      trace(),
    );
    await repo.upsertAnswer({
      id: uuidv7(),
      applicationId: applicationA.application.id,
      questionText: 'How many years of React do you have?',
      questionHash: hashQuestion('How many years of React do you have?'),
      answerText: 'Five years.',
      answerKind: 'user',
      sourceRefs: [],
      claims: [
        {
          claim: '5 years React',
          kind: 'years_experience',
          value: { years: 5, skill: 'React' },
          sourceRefs: [],
          verified: 'unverifiable',
        },
      ],
      verification: { status: 'verified', failures: [] },
      requiresHumanInput: false,
      approved: true,
      now: clock.now(),
    });

    const applicationB = await service.createFromMatch(
      { matchId: second.matchId, mode: 'assisted' },
      trace(),
    );
    const reused = await service.resolveQuestion(
      applicationB.application.id,
      'How many years of React do you have?',
      trace(applicationB.application.id),
    );
    expect(reused.action).toBe('reuse');
    if (reused.action !== 'reuse') throw new Error('unreachable');
    expect(reused.answer.approved).toBe(true);
    expect(reused.answer.verification.status).toBe('verified');

    // Profile change: React years removed ⇒ the claim is no longer supported.
    const candidateRepo = createCandidateRepo(handle.db);
    await candidateRepo.addSkill(scenario.candidateId, {
      skillName: 'React',
      level: 'expert',
      years: null,
    });
    const applicationC = await service.createFromMatch(
      { matchId: third.matchId, mode: 'assisted' },
      trace(),
    );
    const stale = await service.resolveQuestion(
      applicationC.application.id,
      'How many years of React do you have?',
      trace(applicationC.application.id),
    );
    expect(stale.action).toBe('stale');
    if (stale.action !== 'stale') throw new Error('unreachable');
    expect(stale.answer.approved).toBe(false);
    expect(stale.answer.requiresHumanInput).toBe(true);
    expect(stale.answer.verification.status).toBe('rejected');
  });

  it('P4: keeps the exact ResumeVersion recorded by the match when a newer CV exists', async () => {
    const scenario = await seedCandidate();
    const { matchId } = await seedMatchedJob(scenario, 'Exact CV Job');
    const resumeRepo = createResumeRepo(handle.db);
    // A newer immutable version appears after the match was computed.
    await resumeRepo.createVersion(scenario.resumeId, {
      kind: 'original',
      storageKey: `resumes/${scenario.resumeId}/v2.txt`,
      fileHash: 'c'.repeat(64),
      highlights: { skills: ['React', 'TypeScript'] },
    });
    const service = buildService();
    const created = await service.createFromMatch({ matchId, mode: 'assisted' }, trace());
    expect(created.application.resumeVersionId).toBe(scenario.resumeVersionId);

    await service.prepare(created.application.id, trace(created.application.id));
    const versions = await handle.db.execute(sql`
      select parent_version_id from resume_version where kind = 'tailored'
    `);
    const rows = versions.rows as Array<{ parent_version_id: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.parent_version_id).toBe(scenario.resumeVersionId);
  });

  it('P4: fails closed when the match recommends a resume without the exact version id', async () => {
    const scenario = await seedCandidate();
    const { matchId } = await seedMatchedJob(scenario, 'Legacy Match Job', {
      omitResumeSelection: true,
    });
    const service = buildService();
    await expect(
      service.createFromMatch({ matchId, mode: 'assisted' }, trace()),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('P3: open-ended careers change preparation identity across dates', async () => {
    const scenario = await seedCandidate();
    const candidateRepo = createCandidateRepo(handle.db);
    await candidateRepo.addExperience(scenario.candidateId, {
      company: 'Current Corp',
      title: 'Staff Engineer',
      startDate: new Date('2024-02-01T00:00:00Z'),
      endDate: null,
      description: 'Ongoing role',
      skills: ['React'],
    });
    const job = await seedMatchedJob(scenario, 'Open Career Job');
    const serviceA = buildService(undefined, { now: () => new Date('2026-09-18T12:00:00Z') });
    const application = await serviceA.createFromMatch(
      { matchId: job.matchId, mode: 'assisted' },
      trace(),
    );
    const preparedA = await serviceA.prepare(application.application.id, trace(application.application.id));
    const serviceB = buildService(undefined, { now: () => new Date('2027-09-18T12:00:00Z') });
    const preparedB = await serviceB.prepare(application.application.id, trace(application.application.id));
    expect(preparedA.inputHash).not.toBe(preparedB.inputHash);
  });

  it('P3: closed careers keep the same preparation identity across dates (no churn)', async () => {
    const scenario = await seedCandidate();
    const job = await seedMatchedJob(scenario, 'Closed Career Job');
    const serviceA = buildService(undefined, { now: () => new Date('2026-09-18T12:00:00Z') });
    const application = await serviceA.createFromMatch(
      { matchId: job.matchId, mode: 'assisted' },
      trace(),
    );
    const preparedA = await serviceA.prepare(application.application.id, trace(application.application.id));
    const serviceB = buildService(undefined, { now: () => new Date('2027-09-18T12:00:00Z') });
    const preparedB = await serviceB.prepare(application.application.id, trace(application.application.id));
    expect(preparedA.inputHash).toBe(preparedB.inputHash);
  });

  it('P2: an unverifiable answer is never reused from the bank', async () => {
    const scenario = await seedCandidate();
    const first = await seedMatchedJob(scenario, 'Seniority First');
    const second = await seedMatchedJob(scenario, 'Seniority Second');
    const service = buildService();
    const repo = createApplicationRepo(handle.db, handle.pool);

    const applicationA = await service.createFromMatch(
      { matchId: first.matchId, mode: 'assisted' },
      trace(),
    );
    await repo.upsertAnswer({
      id: uuidv7(),
      applicationId: applicationA.application.id,
      questionText: 'What is your seniority level?',
      questionHash: hashQuestion('What is your seniority level?'),
      answerText: 'Senior engineer.',
      answerKind: 'user',
      sourceRefs: [],
      claims: [
        {
          claim: 'seniority: senior',
          kind: 'seniority',
          value: { level: 'senior' },
          sourceRefs: [],
          verified: 'unverifiable',
        },
      ],
      verification: { status: 'unverifiable', failures: [] },
      requiresHumanInput: false,
      approved: true,
      now: clock.now(),
    });

    const applicationB = await service.createFromMatch(
      { matchId: second.matchId, mode: 'assisted' },
      trace(),
    );
    const resolved = await service.resolveQuestion(
      applicationB.application.id,
      'What is your seniority level?',
      trace(applicationB.application.id),
    );
    expect(resolved.action).toBe('stale');
    if (resolved.action !== 'stale') throw new Error('unreachable');
    expect(resolved.answer.approved).toBe(false);
    expect(resolved.answer.requiresHumanInput).toBe(true);
    expect(resolved.answer.verification.status).toBe('unverifiable');
  });

  it('P5: repeated preparation reports the same persisted blockers (cache hit)', async () => {
    const scenario = await seedCandidate();
    const { matchId } = await seedMatchedJob(scenario, 'Blocker Replay Job');
    const provider = new MockTextGenerationProvider({
      responses: [
        {
          kind: 'structured',
          value: {
            tone: 'direct',
            opening: 'direct',
            closing: 'thanks',
            claims: [{ kind: 'seniority', value: { level: 'senior' } }],
          },
        },
      ],
    });
    const service = buildService(provider);
    const created = await service.createFromMatch({ matchId, mode: 'assisted' }, trace());
    const first = await service.prepare(created.application.id, trace(created.application.id));
    expect(first.requiresHumanInput).toBe(true);
    expect(first.blockers.some((blocker) => blocker.code === 'requires_human_input')).toBe(true);

    const second = await service.prepare(created.application.id, trace(created.application.id));
    expect(second.created).toBe(false);
    expect(second.requiresHumanInput).toBe(true);
    expect(second.blockers.map((blocker) => blocker.code).sort()).toEqual(
      first.blockers.map((blocker) => blocker.code).sort(),
    );
    const repo = createApplicationRepo(handle.db, handle.pool);
    expect(await repo.listDocuments(created.application.id)).toHaveLength(2);
  });
});
