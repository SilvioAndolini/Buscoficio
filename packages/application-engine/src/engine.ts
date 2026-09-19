import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  type ApplicationActor,
  type ApplicationMode,
  type ApplicationStatus,
  type Clock,
  type CoverLetterPromptBuilder,
  type DocumentsPort,
  type PreparationBlocker,
  type PreparationResult,
  type StoragePort,
  type TraceContext,
} from '@job-system/core';
import { uuidv7 } from '@job-system/shared';
import { blockersRequireHumanInput, derivePreparationBlockers } from './blockers.js';
import {
  computeApplicationIdempotencyKey,
  computePreparationInputHash,
  hashCanonical,
} from './idempotency.js';
import { assertPhase4Mode, isCooldownSatisfied, type ApplicationPreparationPolicy } from './policy.js';
import { canTransition } from './state-machine.js';
import type {
  ApplicationAnswerRecord,
  ApplicationDocumentRecord,
  ApplicationRecord,
  ApplicationRepositoryPort,
  MatchCreationContext,
  ResumeVersionRecord,
} from './ports.js';

export interface CreateApplicationCommand {
  matchId: string;
  mode: ApplicationMode;
  actor?: ApplicationActor;
  supersedesApplicationId?: string;
  confirmReapply?: boolean;
}

export interface PrepareDocumentsOptions {
  buildCoverLetterPrompt: CoverLetterPromptBuilder;
}

export interface ApplicationEngineDeps {
  repo: ApplicationRepositoryPort;
  documents: DocumentsPort;
  storage: StoragePort;
  clock: Clock;
  policy: ApplicationPreparationPolicy;
}

export interface ApplicationEngine {
  createFromMatch(
    command: CreateApplicationCommand,
    trace: TraceContext,
  ): Promise<{ application: ApplicationRecord; created: boolean }>;
  prepareDocuments(
    applicationId: string,
    options: PrepareDocumentsOptions,
    trace: TraceContext,
  ): Promise<PreparationResult>;
  resolveQuestion(
    applicationId: string,
    input: { questionText: string },
    trace: TraceContext,
  ): Promise<
    | { action: 'reuse' | 'stale'; answer: ApplicationAnswerRecord }
    | { action: 'requires_human'; answer: null; reason: string }
  >;
  resolveHumanAction(
    applicationId: string,
    input: { reason: string },
    trace: TraceContext,
  ): Promise<ApplicationRecord>;
  archive(
    applicationId: string,
    input: { reason?: string },
    trace: TraceContext,
  ): Promise<ApplicationRecord>;
  transition(
    applicationId: string,
    to: ApplicationStatus,
    actor: ApplicationActor,
    reason: string | null,
    trace: TraceContext,
  ): Promise<ApplicationRecord>;
}

/** Statuses where questions/answers can still be resolved in Phase 4. */
const QUESTION_STATUSES: readonly ApplicationStatus[] = [
  'DISCOVERED',
  'FILTERED',
  'SHORTLISTED',
  'PREPARING',
  'REQUIRES_HUMAN_ACTION',
];

function toPreparationResult(
  applicationId: string,
  inputHash: string,
  status: ApplicationStatus,
  created: boolean,
  documents: ApplicationDocumentRecord[],
  blockers: PreparationBlocker[],
): PreparationResult {
  return {
    applicationId,
    inputHash,
    status,
    created,
    documents: documents.map((document) => ({
      id: document.id,
      kind: document.kind,
      contentHash: document.contentHash,
      storageKey: document.storageKey,
      verification: document.verification,
    })),
    blockers,
    requiresHumanInput: blockersRequireHumanInput(blockers),
  };
}

/** UTC date-only anchor (no time component) derived from the injected Clock. */
function utcDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function createApplicationEngine(deps: ApplicationEngineDeps): ApplicationEngine {
  async function requireApplication(applicationId: string): Promise<ApplicationRecord> {
    const application = await deps.repo.getApplication(applicationId);
    if (!application) throw new NotFoundError(`Application not found: ${applicationId}`);
    return application;
  }

  async function resolveResumeVersionId(context: MatchCreationContext): Promise<string | null> {
    if (context.recommendedResumeVersionId !== null) {
      const version = await deps.repo.getResumeVersion(context.recommendedResumeVersionId);
      if (!version || version.candidateId !== context.candidateId) {
        throw new ConflictError(
          'The resume version recorded by the match is no longer available; recompute matching instead of silently substituting another CV',
          { context: { recommendedResumeVersionId: context.recommendedResumeVersionId } },
        );
      }
      return version.id;
    }
    // A match that recommends a resume MUST record the exact version it used;
    // never fall back to the current latest version (Phase 4.1, P4).
    if (context.recommendedResumeId !== null) {
      throw new ConflictError(
        'JobMatch does not contain the exact ResumeVersion used for recommendation; recompute matching.',
        {
          context: {
            matchId: context.matchId,
            recommendedResumeId: context.recommendedResumeId,
          },
        },
      );
    }
    return null;
  }

  async function raiseHumanAction(
    application: ApplicationRecord,
    blocker: PreparationBlocker,
    trace: TraceContext,
    extra: { inputHash?: string; created?: boolean } = {},
  ): Promise<PreparationResult> {
    const now = deps.clock.now();
    const { application: updated } = await deps.repo.transitionWithEvent({
      applicationId: application.id,
      expectedStatus: 'PREPARING',
      toStatus: 'REQUIRES_HUMAN_ACTION',
      actor: 'system',
      eventType: 'application.requires_human_action',
      reason: blocker.message,
      payload: { code: blocker.code, from: 'PREPARING', to: 'REQUIRES_HUMAN_ACTION', actor: 'system' },
      correlationId: trace.correlationId,
      now,
    });
    await deps.repo.appendAudit({
      actor: 'system',
      action: 'application.requires_human_action',
      entityType: 'application',
      entityId: application.id,
      after: { code: blocker.code, reason: blocker.message },
      correlationId: trace.correlationId,
    });
    const documents = await deps.repo.listDocuments(application.id);
    return toPreparationResult(
      application.id,
      extra.inputHash ?? '',
      updated.status,
      extra.created ?? false,
      documents,
      [blocker],
    );
  }

  async function createFromMatch(
    command: CreateApplicationCommand,
    trace: TraceContext,
  ): Promise<{ application: ApplicationRecord; created: boolean }> {
    assertPhase4Mode(command.mode);
    const now = deps.clock.now();
    const context = await deps.repo.getMatchCreationContext(command.matchId);
    if (!context) throw new NotFoundError(`Job match not found: ${command.matchId}`);
    if (!context.isCurrent) {
      throw new ConflictError('Job match is not current; recompute matching before creating an application', {
        context: { matchId: command.matchId },
      });
    }
    if (context.job.status !== 'active') {
      throw new PolicyDeniedError(
        `Job status '${context.job.status}' is not eligible for an application (only active jobs)`,
        { context: { jobId: context.jobId, jobStatus: context.job.status } },
      );
    }

    const supersedesId = command.supersedesApplicationId ?? null;
    const idempotencyKey = computeApplicationIdempotencyKey({
      candidateId: context.candidateId,
      jobId: context.jobId,
      matchId: context.matchId,
      mode: command.mode,
      supersedesApplicationId: supersedesId,
    });

    const existingByKey = await deps.repo.findByIdempotencyKey(idempotencyKey);
    if (existingByKey) {
      // A rejected application never satisfies a create command: reapplication
      // must go through supersedes + confirmation + cooldown (A2).
      if (existingByKey.status === 'REJECTED') {
        throw new PolicyDeniedError(
          'A REJECTED application exists for this job: reapplication requires supersedesApplicationId + confirmReapply=true',
          { context: { jobId: context.jobId, applicationId: existingByKey.id } },
        );
      }
      return { application: existingByKey, created: false };
    }

    const active = await deps.repo.findActiveByJobCandidate(context.candidateId, context.jobId);
    if (active) {
      throw new ConflictError('An active application already exists for this candidate and canonical job', {
        context: { applicationId: active.id, status: active.status, matchId: active.matchId },
      });
    }

    if (supersedesId !== null) {
      if (command.confirmReapply !== true) {
        throw new PolicyDeniedError(
          'Reapplication requires explicit human confirmation (confirmReapply=true)',
          { context: { supersedesApplicationId: supersedesId } },
        );
      }
      const previous = await deps.repo.getApplication(supersedesId);
      if (!previous) throw new NotFoundError(`Application to supersede not found: ${supersedesId}`);
      if (previous.candidateId !== context.candidateId || previous.jobId !== context.jobId) {
        throw new ConflictError(
          'supersedesApplicationId must reference an application for the same candidate and canonical job',
          { context: { supersedesApplicationId: supersedesId } },
        );
      }
      if (previous.status !== 'REJECTED') {
        throw new ConflictError(`Only REJECTED applications can be superseded (found ${previous.status})`, {
          context: { supersedesApplicationId: supersedesId, status: previous.status },
        });
      }
      if (
        !isCooldownSatisfied({
          lastTransitionAt: previous.lastTransitionAt,
          now,
          cooldownDays: deps.policy.reapplicationCooldownDays,
        })
      ) {
        throw new PolicyDeniedError(
          `Reapplication cooldown not satisfied (${deps.policy.reapplicationCooldownDays} days)`,
          {
            context: {
              supersedesApplicationId: supersedesId,
              lastTransitionAt: previous.lastTransitionAt.toISOString(),
              cooldownDays: deps.policy.reapplicationCooldownDays,
            },
          },
        );
      }
    } else {
      const history = await deps.repo.findApplicationsByJobCandidate(
        context.candidateId,
        context.jobId,
      );
      if (history.some((application) => application.status === 'REJECTED')) {
        throw new PolicyDeniedError(
          'A REJECTED application exists for this job: reapplication requires supersedesApplicationId + confirmReapply=true',
          { context: { jobId: context.jobId } },
        );
      }
    }

    const resumeVersionId = await resolveResumeVersionId(context);
    const applicationId = uuidv7();
    const result = await deps.repo.createWithBootstrap({
      id: applicationId,
      jobId: context.jobId,
      candidateId: context.candidateId,
      applicationTargetId: context.job.applicationTargetId,
      discoverySourceId: context.job.discoverySourceId,
      matchId: context.matchId,
      mode: command.mode,
      resumeVersionId,
      idempotencyKey,
      policyVersion: deps.policy.version,
      scoreAtCreation: context.overallScore,
      supersedesApplicationId: supersedesId,
      actor: command.actor ?? 'user',
      correlationId: trace.correlationId,
      now,
    });
    await deps.repo.appendAudit({
      actor: command.actor ?? 'user',
      action: 'application.created',
      entityType: 'application',
      entityId: result.application.id,
      after: {
        jobId: context.jobId,
        matchId: context.matchId,
        mode: command.mode,
        scoreAtCreation: context.overallScore,
        supersedesApplicationId: supersedesId,
      },
      correlationId: trace.correlationId,
    });
    return result;
  }

  async function prepareDocuments(
    applicationId: string,
    options: PrepareDocumentsOptions,
    trace: TraceContext,
  ): Promise<PreparationResult> {
    let application = await requireApplication(applicationId);
    if (application.status === 'SHORTLISTED') {
      application = (
        await deps.repo.transitionWithEvent({
          applicationId,
          expectedStatus: 'SHORTLISTED',
          toStatus: 'PREPARING',
          actor: 'system',
          eventType: 'application.preparing',
          reason: null,
          payload: { from: 'SHORTLISTED', to: 'PREPARING', actor: 'system' },
          correlationId: trace.correlationId,
          now: deps.clock.now(),
        })
      ).application;
    } else if (application.status !== 'PREPARING') {
      throw new ConflictError(`Application status '${application.status}' cannot be prepared in Phase 4`, {
        context: { applicationId, status: application.status },
      });
    }

    const context = await deps.repo.getMatchCreationContext(application.matchId);
    if (!context) throw new NotFoundError(`Job match not found: ${application.matchId}`);
    if (context.candidateId !== application.candidateId || context.jobId !== application.jobId) {
      throw new ConflictError('Application does not match its origin job match; refusing to prepare', {
        context: { applicationId, matchId: application.matchId },
      });
    }

    const now = deps.clock.now();
    const facts = deps.documents.buildProfileFactsView(context.candidate, { includeSalary: false });

    // Temporal anchor (Phase 4.1, P3): only open-ended experiences make the
    // document content time-dependent; closed careers keep a stable identity.
    const hasOpenEnded = context.candidate.experiences.some(
      (experience) => experience.endDate === null,
    );
    const preparationAsOfDate = hasOpenEnded ? utcDateOnly(now) : null;
    const preparationAsOfDateIso =
      preparationAsOfDate === null ? null : preparationAsOfDate.toISOString().slice(0, 10);

    // Exact ResumeVersion only (Phase 4.1, P4): never substitute the current
    // latest version when the match recorded a concrete recommendation.
    const candidateSourceVersionId = application.resumeVersionId ?? context.recommendedResumeVersionId;
    let sourceVersion: ResumeVersionRecord | null = null;
    if (candidateSourceVersionId !== null) {
      const version = await deps.repo.getResumeVersion(candidateSourceVersionId);
      if (version && version.candidateId === application.candidateId) sourceVersion = version;
    }
    if (sourceVersion === null) {
      return raiseHumanAction(
        application,
        {
          code: 'missing_resume',
          message:
            'The resume version selected by the match is no longer available; recompute matching or pick a resume',
        },
        trace,
      );
    }
    if (application.resumeVersionId === null) {
      application = await deps.repo.setResumeVersion(application.id, sourceVersion.id, now);
    }

    const prompt = options.buildCoverLetterPrompt({
      job: context.job,
      facts,
      attempt: 0,
      rejectedClaims: [],
    });
    const inputHash = computePreparationInputHash({
      applicationId: application.id,
      matchId: application.matchId,
      sourceResumeVersionId: sourceVersion.id,
      profileFactsHash: hashCanonical(facts),
      jobContentHash: hashCanonical(context.job),
      promptVersion: prompt.promptVersion,
      provider: deps.documents.provider,
      model: deps.documents.model,
      preparationAsOfDate: preparationAsOfDateIso,
    });

    return deps.repo.withApplicationLock(application.id, async () => {
      const fresh = await deps.repo.getApplication(application.id);
      if (fresh === null) throw new NotFoundError(`Application not found: ${application.id}`);
      if (fresh.status !== 'PREPARING') {
        // A concurrent preparation already finished (or raised human action):
        // return the current persisted state without touching documents again.
        const documents = await deps.repo.listDocuments(application.id);
        const answers = await deps.repo.listAnswers(application.id);
        return toPreparationResult(
          application.id,
          inputHash,
          fresh.status,
          false,
          documents,
          derivePreparationBlockers({
            requiresHumanReason: fresh.requiresHumanReason,
            documents,
            answers,
            targetStatus: context.job.applicationTarget?.status ?? null,
          }),
        );
      }
      application = fresh;

      let createdAny = false;

      const existingVariant = await deps.repo.findDocumentByInputHash(
        application.id,
        'resume_variant',
        inputHash,
      );
      if (existingVariant === null) {
        const draft = deps.documents.prepareResumeVariant({
          job: context.job,
          facts,
          sourceResumeVersion: {
            id: sourceVersion.id,
            resumeId: sourceVersion.resumeId,
            versionNumber: sourceVersion.versionNumber,
            kind: sourceVersion.kind,
            highlights: sourceVersion.highlights,
          },
          asOfDate: preparationAsOfDate,
          inputHash,
        });
        let tailored = await deps.repo.findTailoredVersionByParentAndHash(
          sourceVersion.id,
          draft.contentHash,
        );
        if (tailored === null) {
          const storageKey = `applications/${application.id}/resume/${draft.contentHash}.md`;
          await deps.storage.put(storageKey, new TextEncoder().encode(draft.text), {
            contentType: 'text/markdown',
          });
          tailored = await deps.repo.createTailoredResumeVersion({
            id: uuidv7(),
            resumeId: sourceVersion.resumeId,
            parentVersionId: sourceVersion.id,
            storageKey,
            fileHash: draft.contentHash,
            highlights: draft.highlights,
            now,
          });
        }
        const inserted = await deps.repo.insertDocument({
          id: uuidv7(),
          applicationId: application.id,
          kind: 'resume_variant',
          resumeVersionId: tailored.id,
          storageKey: tailored.storageKey,
          contentHash: draft.contentHash,
          claims: draft.claims,
          verification: draft.verification,
          generatedBy: draft.generatedBy,
          now,
        });
        createdAny = createdAny || inserted.created;
      }

      const existingCover = await deps.repo.findDocumentByInputHash(
        application.id,
        'cover_letter',
        inputHash,
      );
      if (existingCover === null) {
        const prepared = await deps.documents.prepareCoverLetter({
          job: context.job,
          facts,
          asOfDate: preparationAsOfDate,
          buildPrompt: options.buildCoverLetterPrompt,
          inputHash,
          trace,
          maxRepairAttempts: deps.policy.maxFactualRepairAttempts,
        });
        if (prepared.kind === 'requires_human') {
          return raiseHumanAction(
            application,
            {
              code: prepared.failures.length > 0 ? 'rejected_claims' : 'ai_unavailable',
              message: prepared.reason,
            },
            trace,
            { inputHash, created: createdAny },
          );
        }
        const draft = prepared.draft;
        const storageKey = `applications/${application.id}/cover-letter/${draft.contentHash}.md`;
        await deps.storage.put(storageKey, new TextEncoder().encode(draft.text), {
          contentType: 'text/markdown',
        });
        const inserted = await deps.repo.insertDocument({
          id: uuidv7(),
          applicationId: application.id,
          kind: 'cover_letter',
          resumeVersionId: null,
          storageKey,
          contentHash: draft.contentHash,
          claims: draft.claims,
          verification: draft.verification,
          generatedBy: draft.generatedBy,
          now,
        });
        createdAny = createdAny || inserted.created;
      }

      const answers = await deps.repo.listAnswers(application.id);
      for (const answer of answers) {
        if (!answer.approved) continue;
        const resolved = deps.documents.resolveAnswer({
          questionText: answer.questionText,
          priorApproved: {
            id: answer.id,
            answerText: answer.answerText,
            sourceRefs: answer.sourceRefs,
            claims: answer.claims,
            verification: answer.verification,
          },
          facts,
          asOfDate: preparationAsOfDate,
        });
        if (resolved.action === 'stale') {
          await deps.repo.upsertAnswer({
            id: answer.id,
            applicationId: application.id,
            questionText: answer.questionText,
            questionHash: answer.questionHash,
            answerText: resolved.answerText,
            answerKind: answer.answerKind,
            sourceRefs: resolved.sourceRefs,
            claims: resolved.claims,
            verification: resolved.verification,
            requiresHumanInput: true,
            approved: false,
            now,
          });
        }
      }

      if (createdAny) {
        await deps.repo.appendEvent({
          applicationId: application.id,
          type: 'application.documents_prepared',
          fromStatus: 'PREPARING',
          toStatus: 'PREPARING',
          actor: 'system',
          payload: { inputHash },
          correlationId: trace.correlationId,
          now,
        });
      }

      // Blockers are always derived from persisted state (Phase 4.1, P5): a
      // cache-hit preparation reports exactly the same blockers as the run that
      // created the documents.
      const documents = await deps.repo.listDocuments(application.id);
      const refreshedAnswers = await deps.repo.listAnswers(application.id);
      return toPreparationResult(
        application.id,
        inputHash,
        'PREPARING',
        createdAny,
        documents,
        derivePreparationBlockers({
          requiresHumanReason: application.requiresHumanReason,
          documents,
          answers: refreshedAnswers,
          targetStatus: context.job.applicationTarget?.status ?? null,
        }),
      );
    });
  }

  async function resolveQuestion(
    applicationId: string,
    input: { questionText: string },
    trace: TraceContext,
  ): Promise<
    | { action: 'reuse' | 'stale'; answer: ApplicationAnswerRecord }
    | { action: 'requires_human'; answer: null; reason: string }
  > {
    const application = await requireApplication(applicationId);
    if (!QUESTION_STATUSES.includes(application.status)) {
      throw new ConflictError(
        `Application status '${application.status}' does not accept question resolution`,
        { context: { applicationId, status: application.status } },
      );
    }
    const context = await deps.repo.getMatchCreationContext(application.matchId);
    if (!context) throw new NotFoundError(`Job match not found: ${application.matchId}`);
    const now = deps.clock.now();
    const facts = deps.documents.buildProfileFactsView(context.candidate, { includeSalary: true });
    const questionHash = deps.documents.hashQuestion(input.questionText);
    const prior = await deps.repo.findApprovedAnswerByQuestionHash(
      application.candidateId,
      questionHash,
    );
    const resolved = deps.documents.resolveAnswer({
      questionText: input.questionText,
      priorApproved:
        prior === null
          ? null
          : {
              id: prior.id,
              answerText: prior.answerText,
              sourceRefs: prior.sourceRefs,
              claims: prior.claims,
              verification: prior.verification,
            },
      facts,
      asOfDate: context.candidate.experiences.some((experience) => experience.endDate === null)
        ? utcDateOnly(now)
        : null,
    });
    if (resolved.action === 'requires_human') {
      return { action: 'requires_human', answer: null, reason: resolved.reason };
    }
    const answer = await deps.repo.upsertAnswer({
      id: uuidv7(),
      applicationId,
      questionText: input.questionText,
      questionHash,
      answerText: resolved.answerText,
      answerKind: prior?.answerKind ?? 'generated',
      sourceRefs: resolved.sourceRefs,
      claims: resolved.claims,
      verification: resolved.verification,
      requiresHumanInput: resolved.requiresHumanInput,
      approved: resolved.action === 'reuse',
      now,
    });
    if (resolved.action === 'stale') {
      await deps.repo.appendAudit({
        actor: 'system',
        action: 'application.answer_stale',
        entityType: 'application',
        entityId: applicationId,
        after: { questionHash },
        correlationId: trace.correlationId,
      });
    }
    return { action: resolved.action, answer };
  }

  async function resolveHumanAction(
    applicationId: string,
    input: { reason: string },
    trace: TraceContext,
  ): Promise<ApplicationRecord> {
    const application = await requireApplication(applicationId);
    if (application.status !== 'REQUIRES_HUMAN_ACTION') {
      throw new ConflictError(
        `Application is not waiting for human action (status ${application.status})`,
        { context: { applicationId, status: application.status } },
      );
    }
    const { application: updated } = await deps.repo.transitionWithEvent({
      applicationId,
      expectedStatus: 'REQUIRES_HUMAN_ACTION',
      toStatus: 'PREPARING',
      actor: 'user',
      eventType: 'application.status_changed',
      reason: input.reason,
      payload: {
        from: 'REQUIRES_HUMAN_ACTION',
        to: 'PREPARING',
        actor: 'user',
        reason: input.reason,
      },
      correlationId: trace.correlationId,
      now: deps.clock.now(),
    });
    await deps.repo.appendAudit({
      actor: 'user',
      action: 'application.human_action_resolved',
      entityType: 'application',
      entityId: applicationId,
      after: { reason: input.reason },
      correlationId: trace.correlationId,
    });
    return updated;
  }

  async function archive(
    applicationId: string,
    input: { reason?: string },
    trace: TraceContext,
  ): Promise<ApplicationRecord> {
    const application = await requireApplication(applicationId);
    const check = canTransition(application.status, 'ARCHIVED', { actor: 'user' });
    if (!check.allowed) {
      throw new ConflictError(`Application cannot be archived: ${check.reason ?? 'unknown'}`, {
        context: { applicationId, status: application.status },
      });
    }
    const { application: updated } = await deps.repo.transitionWithEvent({
      applicationId,
      expectedStatus: application.status,
      toStatus: 'ARCHIVED',
      actor: 'user',
      eventType: 'application.status_changed',
      reason: input.reason ?? null,
      payload: {
        from: application.status,
        to: 'ARCHIVED',
        actor: 'user',
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
      correlationId: trace.correlationId,
      now: deps.clock.now(),
    });
    await deps.repo.appendAudit({
      actor: 'user',
      action: 'application.archived',
      entityType: 'application',
      entityId: applicationId,
      after: { from: application.status, ...(input.reason === undefined ? {} : { reason: input.reason }) },
      correlationId: trace.correlationId,
    });
    return updated;
  }

  async function transition(
    applicationId: string,
    to: ApplicationStatus,
    actor: ApplicationActor,
    reason: string | null,
    trace: TraceContext,
  ): Promise<ApplicationRecord> {
    const application = await requireApplication(applicationId);
    const check = canTransition(application.status, to, {
      actor,
      ...(reason === null ? {} : { reason }),
      ...(application.mode === undefined ? {} : { mode: application.mode }),
    });
    if (!check.allowed) {
      throw new ConflictError(
        `Application transition ${application.status}->${to} denied: ${check.reason ?? 'unknown'}`,
        { context: { applicationId, from: application.status, to, actor } },
      );
    }
    const { application: updated } = await deps.repo.transitionWithEvent({
      applicationId,
      expectedStatus: application.status,
      toStatus: to,
      actor,
      eventType: to === 'REQUIRES_HUMAN_ACTION' ? 'application.requires_human_action' : 'application.status_changed',
      reason,
      payload: { from: application.status, to, actor, ...(reason === null ? {} : { reason }) },
      correlationId: trace.correlationId,
      now: deps.clock.now(),
    });
    return updated;
  }

  return { createFromMatch, prepareDocuments, resolveQuestion, resolveHumanAction, archive, transition };
}
