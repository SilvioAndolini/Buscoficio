import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, type ApiCtx } from '../context.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });

export function registerDedupRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  app.get('/v1/dedup-reviews', async (request) => {
    const query = parse(
      z.object({
        status: z.enum(['pending', 'decided']).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      request.query,
    );
    const items = await ctx.repos.dedup.listReviews(query.status ?? 'pending', query.limit);
    return {
      items: items.map((entry) => ({
        ...entry.review,
        candidate: { title: entry.candidateTitle, company: entry.candidateCompany, status: entry.candidateStatus },
        created: { title: entry.createdTitle, company: entry.createdCompany, status: entry.createdStatus },
      })),
    };
  });

  /** Human decision on the gray zone: the system never auto-merges there. */
  app.post('/v1/dedup-reviews/:id/decision', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    const { decision } = parse(
      z.object({ decision: z.enum(['merged', 'kept-separate']) }),
      request.body,
      'dedup decision payload',
    );
    const result = await ctx.repos.dedup.decideReview(id, decision, 'user');
    await ctx.repos.audit.append({
      actor: 'user',
      action: 'dedup_review.decided',
      entityType: 'dedup_review',
      entityId: id,
      after: { decision, mergeSummary: result.mergeSummary },
      correlationId: request.id,
    });
    ctx.logger.info({ correlationId: request.id, reviewId: id, decision }, 'dedup review decided');
    return result.review;
  });
}