import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PolicyDeniedError } from '@job-system/core';
import { parse, type ApiCtx } from '../context.js';

const KeyParamsSchema = z.object({ key: z.string().min(1).max(128) });

const PolicyReviewSchema = z.object({
  notes: z.string().trim().min(10, 'policy review notes must be meaningful'),
  reference: z.string().trim().min(1).max(500).optional(),
});

const TargetPatchSchema = z.object({
  status: z.enum(['active', 'blocked', 'paused']),
  policyReview: PolicyReviewSchema.optional(),
});

/**
 * Application targets are the submission destinations (ADR-013).
 *
 * Hard rule: NO POLICY REVIEW → NO ACTIVE TARGET.
 * - blocked → active requires an explicit, system-timestamped policy review
 *   (or an existing valid review, e.g. reactivating a previously reviewed
 *   paused target).
 * - active → paused/blocked and paused → blocked are restrictive and need no
 *   new review.
 * - Re-detection never changes authorization (enforced in the repository).
 */
export function registerApplicationTargetRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  app.get('/v1/application-targets', async () => ({ items: await ctx.repos.job.listTargets() }));

  app.patch('/v1/application-targets/:key', async (request) => {
    const { key } = parse(KeyParamsSchema, request.params);
    const patch = parse(TargetPatchSchema, request.body, 'target patch payload');

    const target = await ctx.repos.job.getTargetByKey(key);
    if (!target) {
      throw new PolicyDeniedError(`Application target not found: ${key}`);
    }

    if (patch.status === 'active') {
      const hasValidReview = target.reviewedAt !== null && target.reviewedBy !== null;
      if (!hasValidReview) {
        if (!patch.policyReview) {
          throw new PolicyDeniedError(
            'Activation requires an explicit policy/ToS review (policyReview.notes)',
            {
              context: {
                targetKey: key,
                required: ['policyReview.notes'],
              },
            },
          );
        }
        const reviewed = await ctx.repos.job.applyPolicyReview(key, {
          notes: patch.policyReview.notes,
          ...(patch.policyReview.reference === undefined
            ? {}
            : { reference: patch.policyReview.reference }),
          actor: 'user',
          now: ctx.clock.now(),
        });
        await ctx.repos.audit.append({
          actor: 'user',
          action: 'application_target.policy_reviewed',
          entityType: 'application_target',
          entityId: reviewed.id,
          before: { status: target.status, policyNotes: target.policyNotes },
          after: {
            targetKey: key,
            previousStatus: target.status,
            newStatus: reviewed.status,
            reviewedBy: reviewed.reviewedBy,
            reviewedAt: reviewed.reviewedAt?.toISOString() ?? null,
            reference: patch.policyReview.reference ?? null,
          },
          correlationId: request.id,
        });
        ctx.logger.info(
          { correlationId: request.id, targetKey: key, previousStatus: target.status },
          'application target policy reviewed and activated',
        );
        return reviewed;
      }
    }

    // Restrictive transitions (or reactivation with an existing valid review).
    const row = await ctx.repos.job.updateTargetStatus(key, patch.status);
    await ctx.repos.audit.append({
      actor: 'user',
      action: 'application_target.status_changed',
      entityType: 'application_target',
      entityId: row.id,
      after: { targetKey: key, previousStatus: target.status, status: row.status },
      correlationId: request.id,
    });
    ctx.logger.info(
      { correlationId: request.id, targetKey: key, status: row.status },
      'application target status changed',
    );
    return row;
  });
}