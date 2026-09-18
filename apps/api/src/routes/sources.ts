import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, type ApiCtx } from '../context.js';

const SourceStatusSchema = z.object({ status: z.enum(['active', 'paused', 'blocked']) });
const KeyParamsSchema = z.object({ key: z.string().min(1).max(64) });

export function registerSourceRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  app.get('/v1/sources', async () => ({ items: await ctx.repos.job.listSources() }));

  /**
   * Source status is the operational allowlist: `blocked` sources are never
   * executed (ToS review recorded in policy_notes at registration time).
   */
  app.patch('/v1/sources/:key', async (request) => {
    const { key } = parse(KeyParamsSchema, request.params);
    const { status } = parse(SourceStatusSchema, request.body, 'source status payload');
    const row = await ctx.repos.job.updateSourceStatus(key, status);
    await ctx.repos.audit.append({
      actor: 'user',
      action: 'source.status_changed',
      entityType: 'job_source',
      entityId: row.id,
      after: { key, status },
      correlationId: request.id,
    });
    return row;
  });
}