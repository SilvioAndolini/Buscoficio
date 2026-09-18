import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, type ApiCtx } from '../context.js';

const KeyParamsSchema = z.object({ key: z.string().min(1).max(128) });
const TargetStatusSchema = z.object({ status: z.enum(['active', 'blocked', 'paused']) });

/**
 * Application targets are the submission destinations (ADR-013). Auto-detected
 * targets start `blocked` with a pending-review policy note: association to a
 * Job is discovery metadata, NOT submission authorization. Re-enabling a target
 * is an explicit, audited human decision.
 */
export function registerApplicationTargetRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  app.get('/v1/application-targets', async () => ({ items: await ctx.repos.job.listTargets() }));

  app.patch('/v1/application-targets/:key', async (request) => {
    const { key } = parse(KeyParamsSchema, request.params);
    const { status } = parse(TargetStatusSchema, request.body, 'target status payload');
    const row = await ctx.repos.job.updateTargetStatus(key, status);
    await ctx.repos.audit.append({
      actor: 'user',
      action: 'application_target.status_changed',
      entityType: 'application_target',
      entityId: row.id,
      after: { key, status },
      correlationId: request.id,
    });
    ctx.logger.info({ correlationId: request.id, targetKey: key, status }, 'application target status changed');
    return row;
  });
}