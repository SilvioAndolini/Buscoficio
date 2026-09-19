import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  PolicyDeniedError,
  type DocumentsPort,
  type MatchCreationContext,
} from '@job-system/core';
import { createApplicationEngine } from '../src/engine.js';
import { createInMemoryRepo } from './helpers/in-memory-repo.js';
import {
  buildFakeDocuments,
  buildFakeStorage,
  buildMatchContext,
  buildResumeVersion,
  MATCH_ID,
} from './helpers/fixtures.js';

const clock = { now: () => new Date('2026-09-18T12:00:00.000Z') };
const policy = {
  version: 'application-prep-v1:cooldown=30d',
  reapplicationCooldownDays: 30,
  maxFactualRepairAttempts: 1,
};
const trace = { correlationId: 'engine-test' };
const promptBuilder = () => ({
  promptVersion: 'cover-letter/v1',
  system: 'system',
  user: 'user',
});

function setup(options: {
  match?: Partial<MatchCreationContext>;
  extraMatches?: MatchCreationContext[];
  documents?: Partial<DocumentsPort>;
} = {}) {
  const { repo, state } = createInMemoryRepo({
    match: buildMatchContext(options.match),
    resumeVersions: [buildResumeVersion()],
    ...(options.extraMatches === undefined ? {} : { matches: options.extraMatches }),
  });
  const engine = createApplicationEngine({
    repo,
    documents: buildFakeDocuments(options.documents),
    storage: buildFakeStorage(),
    clock,
    policy,
  });
  return { engine, repo, state };
}

describe('application engine — creation and idempotency (Phase 4)', () => {
  it('creates a SHORTLISTED application with the bootstrap event chain', async () => {
    const { engine, state } = setup();
    const result = await engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace);
    expect(result.created).toBe(true);
    expect(result.application.status).toBe('SHORTLISTED');
    expect(result.application.scoreAtCreation).toBeCloseTo(0.82);
    expect(result.application.policyVersion).toBe(policy.version);
    const types = state.events.map((event) => `${event.type}:${event.fromStatus}->${event.toStatus}`);
    expect(types).toEqual([
      'application.created:null->DISCOVERED',
      'application.status_changed:DISCOVERED->FILTERED',
      'application.status_changed:FILTERED->SHORTLISTED',
    ]);
    expect(state.audits.some((audit) => audit.action === 'application.created')).toBe(true);
  });

  it('same create command ⇒ same application (idempotent)', async () => {
    const { engine, state } = setup();
    const first = await engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace);
    const second = await engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace);
    expect(second.created).toBe(false);
    expect(second.application.id).toBe(first.application.id);
    expect(state.applications).toHaveLength(1);
  });

  it('rejects a second active application for the same canonical job', async () => {
    const otherMatch = buildMatchContext({
      matchId: '00000000-0000-4000-8000-0000000000aa',
      overallScore: 0.7,
    });
    const { engine } = setup({ extraMatches: [otherMatch] });
    await engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace);
    await expect(
      engine.createFromMatch({ matchId: otherMatch.matchId, mode: 'assisted' }, trace),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('denies mode=auto in Phase 4', async () => {
    const { engine } = setup();
    await expect(
      engine.createFromMatch({ matchId: MATCH_ID, mode: 'auto' }, trace),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('denies non-active jobs and non-current matches', async () => {
    const archived = setup({
      match: { job: { ...buildMatchContext().job, status: 'archived' } },
    });
    await expect(
      archived.engine.createFromMatch({ matchId: MATCH_ID, mode: 'manual' }, trace),
    ).rejects.toBeInstanceOf(PolicyDeniedError);

    const stale = setup({ match: { isCurrent: false } });
    await expect(
      stale.engine.createFromMatch({ matchId: MATCH_ID, mode: 'manual' }, trace),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses to substitute a missing resume version recorded by the match', async () => {
    const { engine } = setup({
      match: { recommendedResumeVersionId: '00000000-0000-4000-8000-0000000000ff' },
    });
    await expect(
      engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('requires supersedes + confirmation + cooldown for reapplication', async () => {
    const { engine, state } = setup();
    const first = await engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace);
    state.applications[0] = {
      ...first.application,
      status: 'REJECTED',
      lastTransitionAt: new Date('2026-08-01T00:00:00.000Z'),
    };

    // No supersedes at all ⇒ policy denial.
    await expect(
      engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace),
    ).rejects.toBeInstanceOf(PolicyDeniedError);

    // Missing confirmation ⇒ denial.
    await expect(
      engine.createFromMatch(
        { matchId: MATCH_ID, mode: 'assisted', supersedesApplicationId: first.application.id },
        trace,
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);

    // Cooldown not satisfied ⇒ denial.
    state.applications[0] = { ...state.applications[0]!, lastTransitionAt: new Date('2026-09-17T00:00:00.000Z') };
    await expect(
      engine.createFromMatch(
        {
          matchId: MATCH_ID,
          mode: 'assisted',
          supersedesApplicationId: first.application.id,
          confirmReapply: true,
        },
        trace,
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);

    // Cooldown satisfied + confirmation ⇒ new application linked by supersedes.
    state.applications[0] = { ...state.applications[0]!, lastTransitionAt: new Date('2026-08-01T00:00:00.000Z') };
    const reapplied = await engine.createFromMatch(
      {
        matchId: MATCH_ID,
        mode: 'assisted',
        supersedesApplicationId: first.application.id,
        confirmReapply: true,
      },
      trace,
    );
    expect(reapplied.created).toBe(true);
    expect(reapplied.application.supersedesApplicationId).toBe(first.application.id);
    expect(state.applications).toHaveLength(2);
  });

  it('rejects supersedes pointing at a non-REJECTED application', async () => {
    const { engine } = setup();
    const first = await engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace);
    await expect(
      engine.createFromMatch(
        {
          matchId: MATCH_ID,
          mode: 'assisted',
          supersedesApplicationId: first.application.id,
          confirmReapply: true,
        },
        trace,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('application engine — preparation flow (Phase 4)', () => {
  it('prepares documents, stays PREPARING and is idempotent', async () => {
    const { engine, state } = setup();
    const created = await engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace);
    const first = await engine.prepareDocuments(
      created.application.id,
      { buildCoverLetterPrompt: promptBuilder },
      trace,
    );
    expect(first.status).toBe('PREPARING');
    expect(first.created).toBe(true);
    expect(first.documents.map((document) => document.kind).sort()).toEqual([
      'cover_letter',
      'resume_variant',
    ]);
    expect(
      state.events.some((event) => event.type === 'application.documents_prepared'),
    ).toBe(true);

    const second = await engine.prepareDocuments(
      created.application.id,
      { buildCoverLetterPrompt: promptBuilder },
      trace,
    );
    expect(second.created).toBe(false);
    expect(second.documents).toHaveLength(2);
    expect(state.documents).toHaveLength(2);
    expect(
      state.events.filter((event) => event.type === 'application.documents_prepared'),
    ).toHaveLength(1);
  });

  it('raises REQUIRES_HUMAN_ACTION when rejected claims persist after repair', async () => {
    const { engine, state } = setup({
      documents: {
        prepareCoverLetter: async (input) => ({
          kind: 'requires_human',
          reason: 'Rejected factual claims after the single repair: no candidate_skill AWS',
          failures: [
            { claim: '10 years of AWS', kind: 'years_experience', reason: 'no candidate_skill AWS' },
          ],
          generatedBy: {
            provider: 'mock',
            model: 'mock-text-v1',
            promptVersion: input.buildPrompt({
              job: input.job,
              facts: input.facts,
              attempt: 0,
              rejectedClaims: [],
            }).promptVersion,
            inputHash: input.inputHash,
            asOfDate: input.asOfDate === null ? null : input.asOfDate.toISOString().slice(0, 10),
          },
        }),
      },
    });
    const created = await engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace);
    const result = await engine.prepareDocuments(
      created.application.id,
      { buildCoverLetterPrompt: promptBuilder },
      trace,
    );
    expect(result.status).toBe('REQUIRES_HUMAN_ACTION');
    expect(result.requiresHumanInput).toBe(true);
    expect(result.blockers.some((blocker) => blocker.code === 'rejected_claims')).toBe(true);
    const application = state.applications[0]!;
    expect(application.requiresHumanReason).toMatch(/AWS|rejected/i);
    expect(
      state.events.some((event) => event.type === 'application.requires_human_action'),
    ).toBe(true);
  });

  it('resolves human action back to PREPARING and archives', async () => {
    const { engine, state } = setup({
      documents: {
        prepareCoverLetter: async () => {
          throw new Error('should not run');
        },
      },
    });
    const created = await engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace);
    state.applications[0] = {
      ...state.applications[0]!,
      status: 'REQUIRES_HUMAN_ACTION',
      requiresHumanReason: 'login required',
    };
    const resolved = await engine.resolveHumanAction(
      created.application.id,
      { reason: 'profile updated' },
      trace,
    );
    expect(resolved.status).toBe('PREPARING');
    expect(resolved.requiresHumanReason).toBeNull();
    expect(state.audits.some((audit) => audit.action === 'application.human_action_resolved')).toBe(true);

    const archived = await engine.archive(created.application.id, {}, trace);
    expect(archived.status).toBe('ARCHIVED');
    expect(state.audits.some((audit) => audit.action === 'application.archived')).toBe(true);
  });

  it('never allows READY_FOR_REVIEW in Phase 4', async () => {
    const { engine, state } = setup();
    const created = await engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace);
    state.applications[0] = { ...state.applications[0]!, status: 'PREPARING' };
    await expect(
      engine.transition(created.application.id, 'READY_FOR_REVIEW', 'system', null, trace),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('application engine — Phase 4.1 sanitation', () => {
  it('P4: uses the exact ResumeVersion recorded by the match, never a later one', async () => {
    const { engine, state } = setup();
    // A newer version appears after the match was computed.
    state.resumeVersions.push({
      ...buildResumeVersion(),
      id: '00000000-0000-4000-8000-0000000000c9',
      versionNumber: 2,
      fileHash: 'e'.repeat(64),
    });
    const created = await engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace);
    expect(created.application.resumeVersionId).toBe('00000000-0000-4000-8000-000000000005');
    const result = await engine.prepareDocuments(
      created.application.id,
      { buildCoverLetterPrompt: promptBuilder },
      trace,
    );
    expect(result.status).toBe('PREPARING');
    const variant = state.documents.find((document) => document.kind === 'resume_variant');
    expect(variant?.resumeVersionId).not.toBe('00000000-0000-4000-8000-0000000000c9');
  });

  it('P4: fails closed when the match recommends a resume without the exact version id', async () => {
    const { engine } = setup({
      match: { recommendedResumeId: '00000000-0000-4000-8000-000000000004', recommendedResumeVersionId: null },
    });
    await expect(
      engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('P3: temporal anchor participates in the preparation identity for open-ended careers', async () => {
    const openCandidate = buildMatchContext();
    openCandidate.candidate.experiences[0]!.endDate = null;
    const { repo } = createInMemoryRepo({
      match: openCandidate,
      resumeVersions: [buildResumeVersion()],
    });
    const engineNow = createApplicationEngine({
      repo,
      documents: buildFakeDocuments(),
      storage: buildFakeStorage(),
      clock,
      policy,
    });
    const created = await engineNow.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace);
    const firstPrepare = await engineNow.prepareDocuments(
      created.application.id,
      { buildCoverLetterPrompt: promptBuilder },
      trace,
    );

    const engineLater = createApplicationEngine({
      repo,
      documents: buildFakeDocuments(),
      storage: buildFakeStorage(),
      clock: { now: () => new Date('2027-09-18T12:00:00.000Z') },
      policy,
    });
    const secondPrepare = await engineLater.prepareDocuments(
      created.application.id,
      { buildCoverLetterPrompt: promptBuilder },
      trace,
    );
    expect(firstPrepare.inputHash).not.toBe(secondPrepare.inputHash);
  });

  it('P3: closed careers keep the same preparation identity across dates (no churn)', async () => {
    const { repo } = createInMemoryRepo({
      match: buildMatchContext(),
      resumeVersions: [buildResumeVersion()],
    });
    const engineNow = createApplicationEngine({
      repo,
      documents: buildFakeDocuments(),
      storage: buildFakeStorage(),
      clock,
      policy,
    });
    const created = await engineNow.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace);
    const firstPrepare = await engineNow.prepareDocuments(
      created.application.id,
      { buildCoverLetterPrompt: promptBuilder },
      trace,
    );

    const engineLater = createApplicationEngine({
      repo,
      documents: buildFakeDocuments(),
      storage: buildFakeStorage(),
      clock: { now: () => new Date('2027-09-18T12:00:00.000Z') },
      policy,
    });
    const secondPrepare = await engineLater.prepareDocuments(
      created.application.id,
      { buildCoverLetterPrompt: promptBuilder },
      trace,
    );
    expect(firstPrepare.inputHash).toBe(secondPrepare.inputHash);
  });

  it('P5: a cache-hit preparation keeps reporting the persisted blockers', async () => {
    const { engine, state } = setup({
      documents: {
        prepareCoverLetter: async (input) => ({
          kind: 'draft',
          draft: {
            kind: 'cover_letter',
            text: 'I work at a senior level.\n',
            contentHash: 's'.repeat(64),
            claims: [
              {
                claim: 'seniority: senior',
                kind: 'seniority',
                value: { level: 'senior' },
                sourceRefs: [],
                verified: 'unverifiable',
              },
            ],
            verification: {
              status: 'unverifiable',
              failures: [{ claim: 'seniority: senior', kind: 'seniority', reason: 'no explicit source' }],
            },
            generatedBy: {
              provider: 'mock',
              model: 'mock-text-v1',
              promptVersion: input.buildPrompt({
                job: input.job,
                facts: input.facts,
                attempt: 0,
                rejectedClaims: [],
              }).promptVersion,
              inputHash: input.inputHash,
              asOfDate: input.asOfDate === null ? null : input.asOfDate.toISOString().slice(0, 10),
            },
          },
        }),
      },
    });
    const created = await engine.createFromMatch({ matchId: MATCH_ID, mode: 'assisted' }, trace);
    const first = await engine.prepareDocuments(
      created.application.id,
      { buildCoverLetterPrompt: promptBuilder },
      trace,
    );
    expect(first.requiresHumanInput).toBe(true);
    expect(first.blockers.some((blocker) => blocker.code === 'requires_human_input')).toBe(true);
    expect(state.documents).toHaveLength(2);

    const second = await engine.prepareDocuments(
      created.application.id,
      { buildCoverLetterPrompt: promptBuilder },
      trace,
    );
    expect(second.created).toBe(false);
    expect(second.requiresHumanInput).toBe(true);
    expect(second.blockers.map((blocker) => blocker.code)).toEqual(
      first.blockers.map((blocker) => blocker.code),
    );
    expect(state.documents).toHaveLength(2);
  });
});
