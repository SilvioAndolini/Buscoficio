import { desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { ConflictError, NotFoundError } from '@job-system/core';
import type { Db } from '../client.js';
import * as t from '../schema.js';

export type DedupDecision = 'merged' | 'kept-separate';

/**
 * Human review of L3 gray-zone duplicates. The gray zone never auto-merges;
 * every decision is persisted and audited by the caller.
 */
export function createDedupRepo(db: Db) {
  const candidateJob = alias(t.job, 'candidate_job');
  const createdJob = alias(t.job, 'created_job');

  return {
    async listReviews(status: string | null, limit: number) {
      const where = status === null ? undefined : eq(t.dedupReview.status, status);
      const rows = await db
        .select({
          review: t.dedupReview,
          candidateTitle: candidateJob.title,
          candidateCompany: candidateJob.company,
          candidateStatus: candidateJob.status,
          createdTitle: createdJob.title,
          createdCompany: createdJob.company,
          createdStatus: createdJob.status,
        })
        .from(t.dedupReview)
        .innerJoin(candidateJob, eq(t.dedupReview.candidateJobId, candidateJob.id))
        .innerJoin(createdJob, eq(t.dedupReview.createdJobId, createdJob.id))
        .where(where)
        .orderBy(desc(t.dedupReview.createdAt))
        .limit(limit);
      return rows;
    },

    async getReview(id: string) {
      const [row] = await db.select().from(t.dedupReview).where(eq(t.dedupReview.id, id)).limit(1);
      if (!row) throw new NotFoundError(`Dedup review not found: ${id}`);
      return row;
    },

    async countPending() {
      const rows = await db
        .select({ id: t.dedupReview.id })
        .from(t.dedupReview)
        .where(eq(t.dedupReview.status, 'pending'));
      return rows.length;
    },

    /**
     * Applies a human decision. `merged` moves the created job's listings into
     * the candidate job (promoting target/primary listing when missing) and
     * archives the loser; `kept-separate` only records the decision.
     */
    async decideReview(id: string, decision: DedupDecision, actor: string) {
      return db.transaction(async (tx) => {
        const [review] = await tx
          .select()
          .from(t.dedupReview)
          .where(eq(t.dedupReview.id, id))
          .limit(1);
        if (!review) throw new NotFoundError(`Dedup review not found: ${id}`);
        if (review.status !== 'pending') {
          throw new ConflictError(`Dedup review already decided: ${id}`);
        }

        let mergeSummary: Record<string, unknown> | null = null;
        if (decision === 'merged') {
          const [winner] = await tx
            .select()
            .from(t.job)
            .where(eq(t.job.id, review.candidateJobId))
            .limit(1);
          const [loser] = await tx
            .select()
            .from(t.job)
            .where(eq(t.job.id, review.createdJobId))
            .limit(1);
          if (!winner || !loser) throw new NotFoundError('Review jobs no longer exist');

          const loserListings = await tx
            .select({ id: t.jobListing.id })
            .from(t.jobListing)
            .where(eq(t.jobListing.jobId, loser.id));

          await tx
            .update(t.jobListing)
            .set({ jobId: winner.id })
            .where(eq(t.jobListing.jobId, loser.id));

          await tx
            .update(t.job)
            .set({
              mergedFrom: [...winner.mergedFrom, ...loserListings.map((row) => row.id)],
              updatedAt: new Date(),
              ...(winner.applicationTargetId === null && loser.applicationTargetId !== null
                ? {
                    applicationTargetId: loser.applicationTargetId,
                    applicationTargetResolvedAt: new Date(),
                  }
                : {}),
              ...(winner.primaryListingId === null && loser.primaryListingId !== null
                ? { primaryListingId: loser.primaryListingId }
                : {}),
            })
            .where(eq(t.job.id, winner.id));

          await tx
            .update(t.job)
            .set({ status: 'archived', updatedAt: new Date() })
            .where(eq(t.job.id, loser.id));

          mergeSummary = {
            winnerJobId: winner.id,
            loserJobId: loser.id,
            movedListings: loserListings.length,
          };
        }

        const [updated] = await tx
          .update(t.dedupReview)
          .set({
            status: 'decided',
            decision,
            decidedBy: actor,
            decidedAt: new Date(),
          })
          .where(eq(t.dedupReview.id, review.id))
          .returning();
        return { review: updated!, mergeSummary };
      });
    },
  };
}