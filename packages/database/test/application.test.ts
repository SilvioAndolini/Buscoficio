import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { ConflictError, type ApplicationRepositoryPort } from '@job-system/core';
import { uuidv7 } from '@job-system/shared';
import { createTestDb, truncateAll } from '../src/testing.js';
import type { Db, DbHandle } from '../src/client.js';
import { application, applicationDocument, applicationEvent, aiUsage } from '../src/schema.js';
import {
  createApplicationRepo,
  createApplicationRepositoryPort,
  type ApplicationRepo,
} from '../src/repositories/application-repo.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? '';
const hasDatabase = TEST_DATABASE_URL.length > 0;
const describeIntegration = hasDatabase ? describe : describe.skip;

function pgCode(error: unknown): string | undefined {
  const candidate = (error as { cause?: { code?: string } }).cause ?? error;
  return (candidate as { code?: string }).code;
}

interface Seed {
  candidateId: string;
  jobId: string;
  matchId: string;
  resumeId: string;
  resumeVersionId: string;
  targetId: string;
  sourceId: string;
}

async function seed(db: Db): Promise<Seed> {
  const candidateId = uuidv7();
  const sourceId = uuidv7();
  const targetId = uuidv7();
  const jobId = uuidv7();
  const matchId = uuidv7();
  const resumeId = uuidv7();
  const resumeVersionId = uuidv7();
  await db.execute(sql`
    insert into candidate_profile (id, full_name, email, headline)
    values (${candidateId}, 'Ada Lovelace', 'ada@example.com', 'Software Engineer')
  `);
  await db.execute(sql`
    insert into job_source (id, key, name, kind, capabilities, policy_notes)
    values (${sourceId}, ${`src-${sourceId.slice(0, 8)}`}, 'Mock', 'api', '{}'::jsonb, 'mock source')
  `);
  await db.execute(sql`
    insert into application_target (id, key, kind, platform, label, status, policy_notes)
    values (${targetId}, ${`tgt-${targetId.slice(0, 8)}`}, 'ats_browser', 'greenhouse', 'Acme Greenhouse', 'active', 'Reviewed 2026-01-01 by user.')
  `);
  await db.execute(sql`
    insert into job (id, company, company_norm, title, title_norm, description, dedup_key, content_hash,
      application_target_id, required_skills)
    values (${jobId}, 'Acme', 'acme', 'Developer', 'developer', 'Build things', ${'d'.repeat(64)}, ${'c'.repeat(64)},
      ${targetId}, '{"React"}')
  `);
  await db.execute(sql`
    insert into resume (id, candidate_id, name, category)
    values (${resumeId}, ${candidateId}, 'Engineering CV', 'software-engineering')
  `);
  await db.execute(sql`
    insert into resume_version (id, resume_id, version_number, storage_key, file_hash, highlights)
    values (${resumeVersionId}, ${resumeId}, 1, 'resumes/x/v1.txt', ${'a'.repeat(64)}, '{"skills":["React"]}'::jsonb)
  `);
  await db.execute(sql`
    insert into job_match (id, job_id, candidate_id, overall_score, score_breakdown, engine_version,
      weights_version, job_content_hash, candidate_profile_hash, resume_set_hash, identity_hash, is_current,
      recommended_resume_id)
    values (${matchId}, ${jobId}, ${candidateId}, 0.7500,
      ${JSON.stringify({ resumeSelection: { recommendedResumeVersionId: resumeVersionId } })}::jsonb,
      'matching-v2', 'v1', ${'c'.repeat(64)}, ${'b'.repeat(64)}, ${'e'.repeat(64)}, ${'f'.repeat(64)}, true,
      ${resumeId})
  `);
  return { candidateId, jobId, matchId, resumeId, resumeVersionId, targetId, sourceId };
}

describeIntegration('application repository (Phase 4)', () => {
  let handle: DbHandle;
  let repo: ApplicationRepo;
  let port: ApplicationRepositoryPort;

  beforeAll(async () => {
    handle = await createTestDb();
    repo = createApplicationRepo(handle.db, handle.pool);
    port = createApplicationRepositoryPort(repo);
  });

  afterAll(async () => {
    await handle.pool.end();
  });

  beforeEach(async () => {
    await truncateAll(handle.db);
  });

  it('bootstraps SHORTLISTED atomically with the event chain and is idempotent', async () => {
    const ids = await seed(handle.db);
    const key = 'k'.repeat(64);
    const first = await repo.createWithBootstrap({
      id: uuidv7(),
      jobId: ids.jobId,
      candidateId: ids.candidateId,
      applicationTargetId: ids.targetId,
      discoverySourceId: ids.sourceId,
      matchId: ids.matchId,
      mode: 'assisted',
      resumeVersionId: ids.resumeVersionId,
      idempotencyKey: key,
      policyVersion: 'application-prep-v1:cooldown=30d',
      scoreAtCreation: 0.75,
      supersedesApplicationId: null,
      actor: 'user',
      correlationId: 'test',
      now: new Date('2026-09-18T12:00:00Z'),
    });
    expect(first.created).toBe(true);
    expect(first.application.status).toBe('SHORTLISTED');

    const events = await repo.listEvents(first.application.id);
    expect(events.map((event) => `${event.type}:${event.fromStatus}->${event.toStatus}`)).toEqual([
      'application.created:null->DISCOVERED',
      'application.status_changed:DISCOVERED->FILTERED',
      'application.status_changed:FILTERED->SHORTLISTED',
    ]);

    const second = await repo.createWithBootstrap({
      id: uuidv7(),
      jobId: ids.jobId,
      candidateId: ids.candidateId,
      applicationTargetId: null,
      discoverySourceId: null,
      matchId: ids.matchId,
      mode: 'assisted',
      resumeVersionId: null,
      idempotencyKey: key,
      policyVersion: 'application-prep-v1:cooldown=30d',
      scoreAtCreation: 0.75,
      supersedesApplicationId: null,
      actor: 'user',
      correlationId: 'test',
      now: new Date('2026-09-18T12:00:00Z'),
    });
    expect(second.created).toBe(false);
    expect(second.application.id).toBe(first.application.id);
    const rows = await handle.db.select().from(application);
    expect(rows).toHaveLength(1);
  });

  it('enforces the active partial unique in PostgreSQL (not only in the service)', async () => {
    const ids = await seed(handle.db);
    const base = {
      jobId: ids.jobId,
      candidateId: ids.candidateId,
      matchId: ids.matchId,
      idempotencyKey: 'x'.repeat(64),
      policyVersion: 'v',
      scoreAtCreation: '0.5',
    };
    await handle.db.insert(application).values({ id: uuidv7(), ...base, mode: 'manual', status: 'PREPARING' });
    await expect(
      handle.db.insert(application).values({
        id: uuidv7(),
        ...base,
        idempotencyKey: 'y'.repeat(64),
        mode: 'manual',
        status: 'SHORTLISTED',
      }),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '23505');

    // ARCHIVED/REJECTED rows are outside the constraint.
    await handle.db.update(application).set({ status: 'REJECTED' }).where(eq(application.candidateId, ids.candidateId));
    await handle.db.insert(application).values({ id: uuidv7(), ...base, idempotencyKey: 'z'.repeat(64), mode: 'manual', status: 'ARCHIVED' });
    await handle.db.insert(application).values({ id: uuidv7(), ...base, idempotencyKey: 'w'.repeat(64), mode: 'manual', status: 'PREPARING' });
    const rows = await handle.db.select().from(application);
    expect(rows).toHaveLength(3);
  });

  it('transitions with the event in the same transaction and compare-and-set', async () => {
    const ids = await seed(handle.db);
    const created = await port.createWithBootstrap({
      id: uuidv7(),
      jobId: ids.jobId,
      candidateId: ids.candidateId,
      applicationTargetId: null,
      discoverySourceId: null,
      matchId: ids.matchId,
      mode: 'assisted',
      resumeVersionId: null,
      idempotencyKey: 't'.repeat(64),
      policyVersion: 'v',
      scoreAtCreation: 0.5,
      supersedesApplicationId: null,
      actor: 'user',
      correlationId: null,
      now: new Date(),
    });
    const result = await port.transitionWithEvent({
      applicationId: created.application.id,
      expectedStatus: 'SHORTLISTED',
      toStatus: 'PREPARING',
      actor: 'system',
      eventType: 'application.preparing',
      reason: null,
      payload: {},
      correlationId: 'c',
      now: new Date(),
    });
    expect(result.application.status).toBe('PREPARING');
    const events = await handle.db
      .select()
      .from(applicationEvent)
      .where(eq(applicationEvent.applicationId, created.application.id));
    expect(events.some((event) => event.type === 'application.preparing')).toBe(true);

    await expect(
      port.transitionWithEvent({
        applicationId: created.application.id,
        expectedStatus: 'SHORTLISTED',
        toStatus: 'ARCHIVED',
        actor: 'user',
        eventType: 'application.status_changed',
        reason: null,
        payload: {},
        correlationId: null,
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    const after = await handle.db
      .select()
      .from(applicationEvent)
      .where(eq(applicationEvent.applicationId, created.application.id));
    expect(after).toHaveLength(events.length);
  });

  it('serializes concurrent transitions: exactly one wins', async () => {
    const ids = await seed(handle.db);
    const created = await port.createWithBootstrap({
      id: uuidv7(),
      jobId: ids.jobId,
      candidateId: ids.candidateId,
      applicationTargetId: null,
      discoverySourceId: null,
      matchId: ids.matchId,
      mode: 'assisted',
      resumeVersionId: null,
      idempotencyKey: 'c'.repeat(64),
      policyVersion: 'v',
      scoreAtCreation: 0.5,
      supersedesApplicationId: null,
      actor: 'user',
      correlationId: null,
      now: new Date(),
    });
    const results = await Promise.allSettled([
      port.transitionWithEvent({
        applicationId: created.application.id,
        expectedStatus: 'SHORTLISTED',
        toStatus: 'PREPARING',
        actor: 'system',
        eventType: 'application.preparing',
        reason: null,
        payload: {},
        correlationId: null,
        now: new Date(),
      }),
      port.transitionWithEvent({
        applicationId: created.application.id,
        expectedStatus: 'SHORTLISTED',
        toStatus: 'ARCHIVED',
        actor: 'user',
        eventType: 'application.status_changed',
        reason: null,
        payload: {},
        correlationId: null,
        now: new Date(),
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('keeps documents append-only and deduplicates identical bytes', async () => {
    const ids = await seed(handle.db);
    const created = await port.createWithBootstrap({
      id: uuidv7(),
      jobId: ids.jobId,
      candidateId: ids.candidateId,
      applicationTargetId: null,
      discoverySourceId: null,
      matchId: ids.matchId,
      mode: 'assisted',
      resumeVersionId: ids.resumeVersionId,
      idempotencyKey: 'd'.repeat(64),
      policyVersion: 'v',
      scoreAtCreation: 0.5,
      supersedesApplicationId: null,
      actor: 'user',
      correlationId: null,
      now: new Date(),
    });
    const base = {
      applicationId: created.application.id,
      kind: 'resume_variant' as const,
      resumeVersionId: ids.resumeVersionId,
      storageKey: 'applications/x/resume/hash.md',
      contentHash: 'h'.repeat(64),
      claims: [],
      verification: { status: 'verified' as const, failures: [] },
      generatedBy: {
        provider: 'deterministic',
        model: 'template-v1',
        promptVersion: 'resume-variant/v1',
        inputHash: 'i'.repeat(64),
      },
      now: new Date(),
    };
    const first = await port.insertDocument({ id: uuidv7(), ...base });
    const second = await port.insertDocument({ id: uuidv7(), ...base });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.document.id).toBe(first.document.id);

    const other = await port.insertDocument({ id: uuidv7(), ...base, contentHash: 'j'.repeat(64) });
    expect(other.created).toBe(true);
    const rows = await handle.db.select().from(applicationDocument);
    expect(rows).toHaveLength(2);

    const byInputHash = await port.findDocumentByInputHash(
      created.application.id,
      'resume_variant',
      'i'.repeat(64),
    );
    expect(byInputHash?.id).toBe(first.document.id);
  });

  it('upserts answers by question hash and finds approved bank entries', async () => {
    const ids = await seed(handle.db);
    const created = await port.createWithBootstrap({
      id: uuidv7(),
      jobId: ids.jobId,
      candidateId: ids.candidateId,
      applicationTargetId: null,
      discoverySourceId: null,
      matchId: ids.matchId,
      mode: 'assisted',
      resumeVersionId: null,
      idempotencyKey: 'a'.repeat(64),
      policyVersion: 'v',
      scoreAtCreation: 0.5,
      supersedesApplicationId: null,
      actor: 'user',
      correlationId: null,
      now: new Date(),
    });
    const base = {
      applicationId: created.application.id,
      questionText: 'Are you authorized to work?',
      questionHash: 'q'.repeat(64),
      answerKind: 'user' as const,
      sourceRefs: [],
      claims: [],
      verification: { status: 'verified' as const, failures: [] },
      requiresHumanInput: false,
      approved: true,
      now: new Date(),
    };
    const first = await port.upsertAnswer({ id: uuidv7(), ...base, answerText: 'Yes' });
    const second = await port.upsertAnswer({ id: uuidv7(), ...base, answerText: 'Yes, in the EU' });
    expect(second.id).toBe(first.id);
    const answers = await port.listAnswers(created.application.id);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.answerText).toBe('Yes, in the EU');

    const bank = await port.findApprovedAnswerByQuestionHash(ids.candidateId, 'q'.repeat(64));
    expect(bank?.id).toBe(first.id);
  });

  it('returns the full match creation context (job, target, resume version, facts)', async () => {
    const ids = await seed(handle.db);
    const context = await port.getMatchCreationContext(ids.matchId);
    expect(context).not.toBeNull();
    expect(context!.job.status).toBe('active');
    expect(context!.job.applicationTarget?.key).toBe(`tgt-${ids.targetId.slice(0, 8)}`);
    expect(context!.recommendedResumeVersionId).toBe(ids.resumeVersionId);
    expect(context!.candidate.profile.fullName).toBe('Ada Lovelace');
    expect(context!.candidate.experiences).toEqual([]);
  });

  it('restricts supersedes/job/match deletions (traceability preserved)', async () => {
    const ids = await seed(handle.db);
    await expect(
      handle.db.insert(application).values({
        id: uuidv7(),
        jobId: ids.jobId,
        candidateId: ids.candidateId,
        matchId: ids.matchId,
        mode: 'manual',
        status: 'PREPARING',
        idempotencyKey: 'f'.repeat(64),
        policyVersion: 'v',
        scoreAtCreation: '0.5',
        supersedesApplicationId: uuidv7(),
      }),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '23503');
  });

  it('sets ai_usage.application_id to null when the application is deleted', async () => {
    const ids = await seed(handle.db);
    const created = await port.createWithBootstrap({
      id: uuidv7(),
      jobId: ids.jobId,
      candidateId: ids.candidateId,
      applicationTargetId: null,
      discoverySourceId: null,
      matchId: ids.matchId,
      mode: 'assisted',
      resumeVersionId: null,
      idempotencyKey: 'u'.repeat(64),
      policyVersion: 'v',
      scoreAtCreation: 0.5,
      supersedesApplicationId: null,
      actor: 'user',
      correlationId: null,
      now: new Date(),
    });
    await handle.db.insert(aiUsage).values({
      id: uuidv7(),
      provider: 'mock',
      model: 'mock-text-v1',
      operation: 'cover_letter',
      latencyMs: 1,
      applicationId: created.application.id,
    });
    await handle.db.delete(application).where(eq(application.id, created.application.id));
    const rows = await handle.db.select().from(aiUsage);
    expect(rows[0]!.applicationId).toBeNull();
  });

  it('exposes no event mutation methods (append-only)', () => {
    expect('updateEvent' in repo).toBe(false);
    expect('deleteEvent' in repo).toBe(false);
  });

  it('serializes preparations per application with the advisory lock', async () => {
    const order: string[] = [];
    await Promise.all([
      port.withApplicationLock('lock-test', async () => {
        order.push('a-start');
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        order.push('a-end');
      }),
      port.withApplicationLock('lock-test', async () => {
        order.push('b-start');
        order.push('b-end');
      }),
    ]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('creates tailored versions with sequential numbers and reuses by parent+hash', async () => {
    const ids = await seed(handle.db);
    const first = await repo.createTailoredResumeVersion({
      id: uuidv7(),
      resumeId: ids.resumeId,
      parentVersionId: ids.resumeVersionId,
      storageKey: 'applications/x/resume/h1.md',
      fileHash: '1'.repeat(64),
      highlights: {},
      now: new Date(),
    });
    expect(first.versionNumber).toBe(2);
    expect(first.kind).toBe('tailored');
    const reused = await repo.findTailoredVersionByParentAndHash(ids.resumeVersionId, '1'.repeat(64));
    expect(reused?.id).toBe(first.id);

    const duplicate = await repo.createTailoredResumeVersion({
      id: uuidv7(),
      resumeId: ids.resumeId,
      parentVersionId: ids.resumeVersionId,
      storageKey: 'applications/x/resume/h1.md',
      fileHash: '1'.repeat(64),
      highlights: {},
      now: new Date(),
    });
    expect(duplicate.id).toBe(first.id);
  });
});
