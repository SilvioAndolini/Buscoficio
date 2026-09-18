import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '@job-system/core';
import { matchJobId } from '@job-system/shared';
import { parse, type ApiCtx } from '../context.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });

const RankingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  minScore: z.coerce.number().min(0).max(1).optional(),
});

const RecomputeSchema = z
  .object({
    jobIds: z.array(z.string().uuid()).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .default({ limit: 100 });

const MATCH_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 3_000 },
  // The deterministic id deduplicates in-flight work; removing the finished
  // job frees the id so recomputation is never blocked (identity constraints
  // remain the idempotency defense).
  removeOnComplete: true,
};

async function requireCandidate(ctx: ApiCtx) {
  const profile = await ctx.repos.candidate.getProfile();
  if (!profile) {
    throw new ConflictError('Candidate profile does not exist yet; create it before matching');
  }
  return profile;
}

/**
 * Matching endpoints (architecture doc 05 §7). Scoring never runs in the
 * request lifecycle: POST endpoints enqueue and return 202.
 */
export function registerMatchRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  app.post('/v1/jobs/:id/match', async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    const profile = await requireCandidate(ctx);
    const job = await ctx.repos.job.getJobWithListings(id);
    const queueJobId = matchJobId(id, ctx.engineVersion);
    await ctx.matchQueue.add(
      'match.score',
      { jobId: id, candidateId: profile.id, correlationId: request.id },
      { ...MATCH_JOB_OPTIONS, jobId: queueJobId },
    );
    reply.status(202);
    return { jobId: id, queueJobId, jobStatus: job.job.status };
  });

  app.get('/v1/jobs/:id/match', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    const profile = await requireCandidate(ctx);
    const row = await ctx.repos.matching.getCurrentMatchWithResume(id, profile.id);
    if (!row) throw new NotFoundError(`No current match for job ${id}`);
    return row;
  });

  app.get('/v1/jobs/:id/matches', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    const profile = await requireCandidate(ctx);
    const items = await ctx.repos.matching.listMatchHistory(id, profile.id);
    return { items };
  });

  app.get('/v1/matches', async (request) => {
    const query = parse(RankingQuerySchema, request.query, 'matches query');
    const profile = await requireCandidate(ctx);
    const items = await ctx.repos.matching.listCurrentMatches({
      candidateId: profile.id,
      limit: query.limit,
      offset: query.offset,
      ...(query.minScore === undefined ? {} : { minScore: query.minScore }),
    });
    const total =
      query.minScore === undefined
        ? await ctx.repos.matching.countCurrentMatches(profile.id)
        : await ctx.repos.matching.countCurrentMatches(profile.id, query.minScore);
    return { items, total, limit: query.limit, offset: query.offset };
  });

  /**
   * Recompute endpoint: enqueues matching for active jobs (bounded). Jobs
   * already matched with the same identity are reused by the identity
   * constraint, so this is safe to call repeatedly.
   */
  app.post('/v1/matches/recompute', async (request, reply) => {
    const body = parse(RecomputeSchema, request.body ?? {}, 'recompute payload');
    const profile = await requireCandidate(ctx);
    let jobIds: string[];
    if (body.jobIds !== undefined) {
      jobIds = body.jobIds;
    } else {
      const rows = await ctx.repos.job.listJobs({ limit: body.limit, offset: 0, status: 'active' });
      jobIds = rows.map((row) => row.job.id);
    }
    const enqueued: Array<{ jobId: string; queueJobId: string }> = [];
    for (const jobId of jobIds) {
      const queueJobId = matchJobId(jobId, ctx.engineVersion);
      await ctx.matchQueue.add(
        'match.score',
        { jobId, candidateId: profile.id, correlationId: request.id },
        { ...MATCH_JOB_OPTIONS, jobId: queueJobId },
      );
      enqueued.push({ jobId, queueJobId });
    }
    reply.status(202);
    return { enqueued: enqueued.length, items: enqueued };
  });

  app.get('/v1/embedding-spaces', async () => {
    const items = await ctx.repos.matching.listEmbeddingSpaces();
    return { items };
  });

  app.post('/v1/embedding-spaces/:id/activate', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    const row = await ctx.repos.matching.activateEmbeddingSpace(id);
    await ctx.repos.audit.append({
      actor: 'user',
      action: 'embedding_space.activated',
      entityType: 'embedding_space',
      entityId: id,
      after: { key: row.key, provider: row.provider, model: row.model },
      correlationId: request.id,
    });
    return row;
  });
}
