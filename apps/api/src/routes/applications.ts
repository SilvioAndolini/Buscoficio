import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ApplicationStatusSchema,
  ConflictError,
  NotFoundError,
  ProposedClaimSchema,
  toProposedClaim,
  type ApplicationStatus,
  type PreparationBlocker,
  type VerificationResult,
} from '@job-system/core';
import { prepareApplicationJobId, uuidv7 } from '@job-system/shared';
import { loadProfileFactsSource } from '@job-system/database';
import { parse, type ApiCtx } from '../context.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: ApplicationStatusSchema.optional(),
});

const CreateBodySchema = z.object({
  matchId: z.string().uuid(),
  mode: z.enum(['manual', 'assisted', 'auto']),
  supersedesApplicationId: z.string().uuid().optional(),
  confirmReapply: z.boolean().optional(),
});

const AnswerBodySchema = z.object({
  questionText: z.string().trim().min(1).max(2000),
  answerText: z.string().trim().min(1).max(20_000),
  approved: z.boolean().default(false),
  claims: z.array(ProposedClaimSchema).max(30).default([]),
});

const ResolveHumanBodySchema = z.object({
  reason: z.string().trim().min(3).max(1000),
});

const ResolveQuestionBodySchema = z.object({
  questionText: z.string().trim().min(1).max(2000),
});

const ArchiveBodySchema = z
  .object({ reason: z.string().trim().min(1).max(1000).optional() })
  .default({});

/** Statuses where document/answer editing is still meaningful in Phase 4. */
const EDITABLE_STATUSES: readonly ApplicationStatus[] = [
  'DISCOVERED',
  'FILTERED',
  'SHORTLISTED',
  'PREPARING',
  'REQUIRES_HUMAN_ACTION',
];

function truncate(value: string, max = 100): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function pickJob(job: {
  id: string;
  title: string;
  company: string;
  location: string | null;
  remoteType: string | null;
  employmentType: string | null;
  status: string;
  applicationTargetId: string | null;
}) {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    remoteType: job.remoteType,
    employmentType: job.employmentType,
    status: job.status,
    applicationTargetId: job.applicationTargetId,
  };
}

function deriveBlockers(input: {
  requiresHumanReason: string | null;
  documents: Array<{ id: string; kind: string; verification: VerificationResult }>;
  answers: Array<{ id: string; questionText: string; requiresHumanInput: boolean }>;
  targetStatus: string | null;
}): PreparationBlocker[] {
  const blockers: PreparationBlocker[] = [];
  if (input.requiresHumanReason !== null) {
    blockers.push({ code: 'requires_human_input', message: input.requiresHumanReason });
  }
  for (const answer of input.answers) {
    if (answer.requiresHumanInput) {
      blockers.push({
        code: 'stale_answer',
        message: `Answer requires human input: "${truncate(answer.questionText)}"`,
        refId: answer.id,
      });
    }
  }
  for (const document of input.documents) {
    if (document.verification.status === 'rejected') {
      blockers.push({
        code: 'rejected_claims',
        message: `${document.kind} contains rejected claims`,
        refId: document.id,
      });
    } else if (document.verification.status === 'unverifiable') {
      blockers.push({
        code: 'requires_human_input',
        message: `${document.kind} contains unverifiable claims`,
        refId: document.id,
      });
    }
  }
  if (input.targetStatus === 'blocked') {
    blockers.push({
      code: 'target_blocked',
      message:
        'Application target is blocked pending platform policy review; document preparation is still allowed (no submission in Phase 4)',
    });
  }
  return blockers;
}

/**
 * Application endpoints (architecture doc 05 §7). Commands go through the
 * application-engine; preparation is enqueued (202) and never executed inside
 * the request. There is NO submit/reconcile endpoint in Phase 4.
 */
export function registerApplicationRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  app.post('/v1/applications', async (request, reply) => {
    const body = parse(CreateBodySchema, request.body, 'application payload');
    const result = await ctx.applicationEngine.createFromMatch(
      {
        matchId: body.matchId,
        mode: body.mode,
        actor: 'user',
        ...(body.supersedesApplicationId === undefined
          ? {}
          : { supersedesApplicationId: body.supersedesApplicationId }),
        ...(body.confirmReapply === undefined ? {} : { confirmReapply: body.confirmReapply }),
      },
      { correlationId: request.id },
    );
    reply.status(result.created ? 201 : 200);
    return { application: result.application, created: result.created };
  });

  app.get('/v1/applications', async (request) => {
    const query = parse(ListQuerySchema, request.query, 'applications query');
    const items = await ctx.repos.applications.listWithJob({
      limit: query.limit,
      offset: query.offset,
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    const total = await ctx.repos.applications.countApplications(query.status);
    return {
      items: items.map((row) => ({
        application: row.application,
        job: pickJob(row.job),
        resumeName: row.resumeName,
        target: row.target,
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  });

  app.get('/v1/applications/:id', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    const application = await ctx.repos.applications.getApplication(id);
    if (!application) throw new NotFoundError(`Application not found: ${id}`);
    const withJob = await ctx.repos.applications.getWithJob(id);
    const match = await ctx.repos.matching.getMatchById(application.matchId);
    const resumeVersion =
      application.resumeVersionId === null
        ? null
        : await ctx.repos.resume.getVersion(application.resumeVersionId);
    const documents = await ctx.repos.applications.listDocuments(id);
    const answers = await ctx.repos.applications.listAnswers(id);
    const events = await ctx.repos.applications.listEvents(id);
    const target = withJob?.target ?? null;
    const blockers = deriveBlockers({
      requiresHumanReason: application.requiresHumanReason,
      documents,
      answers,
      targetStatus: target?.status ?? null,
    });
    return {
      application,
      job: withJob === null ? null : pickJob(withJob.job),
      resumeName: withJob?.resumeName ?? null,
      match:
        match === null
          ? null
          : {
              id: match.id,
              overallScore: Number(match.overallScore),
              identityHash: match.identityHash,
              engineVersion: match.engineVersion,
              weightsVersion: match.weightsVersion,
              computedAt: match.computedAt,
              recommendedResumeId: match.recommendedResumeId,
            },
      resumeVersion,
      documents,
      answers,
      events,
      target,
      blockers,
    };
  });

  /** 202 only: generation happens in the worker (`documents` queue). */
  app.post('/v1/applications/:id/prepare', async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    const application = await ctx.repos.applications.getApplication(id);
    if (!application) throw new NotFoundError(`Application not found: ${id}`);
    if (application.status !== 'SHORTLISTED' && application.status !== 'PREPARING') {
      throw new ConflictError(
        `Application status '${application.status}' cannot be prepared in Phase 4`,
        { context: { applicationId: id, status: application.status } },
      );
    }
    const queueJobId = prepareApplicationJobId(id);
    await ctx.documentsQueue.add(
      'documents.prepare',
      { applicationId: id, correlationId: request.id },
      {
        jobId: queueJobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 3_000 },
        // Postgres (advisory lock + constraints) is the idempotency authority;
        // freeing the id after completion keeps re-preparation possible.
        removeOnComplete: true,
      },
    );
    reply.status(202);
    return { applicationId: id, queueJobId };
  });

  app.get('/v1/applications/:id/answers', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    const application = await ctx.repos.applications.getApplication(id);
    if (!application) throw new NotFoundError(`Application not found: ${id}`);
    return { items: await ctx.repos.applications.listAnswers(id) };
  });

  /**
   * User answers: `answerKind=user`. Answers without factual claims may be
   * approved directly; answers with claims are validated deterministically
   * before approval (task §72).
   */
  app.put('/v1/applications/:id/answers', async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    const application = await ctx.repos.applications.getApplication(id);
    if (!application) throw new NotFoundError(`Application not found: ${id}`);
    if (!EDITABLE_STATUSES.includes(application.status)) {
      throw new ConflictError(`Application status '${application.status}' does not accept answer edits`, {
        context: { applicationId: id, status: application.status },
      });
    }
    const body = parse(AnswerBodySchema, request.body, 'answer payload');
    const now = ctx.clock.now();
    const source = await loadProfileFactsSource(ctx.db, application.candidateId);
    const facts = ctx.documents.buildProfileFactsView(source, { includeSalary: true });
    const validation = ctx.documents.validateClaims(body.claims.map(toProposedClaim), facts, {
      asOfDate: now,
    });
    const rejected = validation.verification.status === 'rejected';
    const claims = validation.claims;
    const answer = await ctx.repos.applications.upsertAnswer({
      id: uuidv7(),
      applicationId: id,
      questionText: body.questionText,
      questionHash: ctx.documents.hashQuestion(body.questionText),
      answerText: body.answerText,
      answerKind: 'user',
      sourceRefs: claims.flatMap((claim) => claim.sourceRefs),
      claims,
      verification: validation.verification,
      requiresHumanInput: rejected,
      approved: body.approved && !rejected,
      now,
    });
    await ctx.repos.audit.append({
      actor: 'user',
      action: 'application.answer_upserted',
      entityType: 'application',
      entityId: id,
      after: {
        questionHash: answer.questionHash,
        approved: answer.approved,
        requiresHumanInput: answer.requiresHumanInput,
        verification: answer.verification.status,
      },
      correlationId: request.id,
    });
    reply.status(201);
    return answer;
  });

  /** Answer bank resolution: reuse only after deterministic revalidation. */
  app.post('/v1/applications/:id/answers/resolve', async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    const body = parse(ResolveQuestionBodySchema, request.body, 'question payload');
    const result = await ctx.applicationEngine.resolveQuestion(
      id,
      { questionText: body.questionText },
      { correlationId: request.id, applicationId: id },
    );
    reply.status(result.answer === null ? 200 : 201);
    return result;
  });

  /** Human resolution of REQUIRES_HUMAN_ACTION → PREPARING (audited). */
  app.post('/v1/applications/:id/resolve-human', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    const body = parse(ResolveHumanBodySchema, request.body, 'resolution payload');
    return ctx.applicationEngine.resolveHumanAction(
      id,
      { reason: body.reason },
      { correlationId: request.id, applicationId: id },
    );
  });

  app.post('/v1/applications/:id/archive', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    const body = parse(ArchiveBodySchema, request.body ?? {}, 'archive payload');
    return ctx.applicationEngine.archive(
      id,
      body.reason === undefined ? {} : { reason: body.reason },
      { correlationId: request.id, applicationId: id },
    );
  });

  // Phase 4 intentionally exposes NO submit/reconcile endpoints and no stubs
  // that pretend success: SubmissionPort belongs to Phase 5.
}
