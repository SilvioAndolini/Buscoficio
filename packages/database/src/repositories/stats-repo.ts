import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import * as t from '../schema.js';

/** Aggregated operational stats (Phase 2 observability, DB-derived). */
export function createStatsRepo(db: Db) {
  return {
    async sourceStats() {
      const rows = await db
        .select({
          sourceKey: t.jobSource.key,
          status: t.jobSource.status,
          runs: count(t.searchSourceRun.id),
          completed: sql<number>`count(*) filter (where ${t.searchSourceRun.status} = 'completed')`.mapWith(
            Number,
          ),
          failed: sql<number>`count(*) filter (where ${t.searchSourceRun.status} = 'failed')`.mapWith(Number),
          jobsDiscovered: sql<number>`coalesce(sum(${t.searchSourceRun.jobsDiscovered}), 0)`.mapWith(Number),
          jobsNew: sql<number>`coalesce(sum(${t.searchSourceRun.jobsNew}), 0)`.mapWith(Number),
          jobsDuplicated: sql<number>`coalesce(sum(${t.searchSourceRun.jobsDuplicated}), 0)`.mapWith(Number),
          jobsRejected: sql<number>`coalesce(sum(${t.searchSourceRun.jobsRejected}), 0)`.mapWith(Number),
          avgDurationMs: sql<number>`coalesce(round(avg(${t.searchSourceRun.durationMs})), 0)`.mapWith(Number),
          lastRunAt: sql<string | null>`max(${t.searchSourceRun.finishedAt})`,
          lastErrorClass: sql<string | null>`(array_agg(${t.searchSourceRun.errorClass} order by ${t.searchSourceRun.finishedAt} desc))[1]`,
        })
        .from(t.jobSource)
        .leftJoin(t.searchSourceRun, eq(t.searchSourceRun.sourceId, t.jobSource.id))
        .groupBy(t.jobSource.key, t.jobSource.status)
        .orderBy(t.jobSource.key);
      return rows;
    },

    async overview() {
      const jobsByStatus = await db
        .select({ status: t.job.status, total: count(t.job.id) })
        .from(t.job)
        .groupBy(t.job.status);
      const runsByStatus = await db
        .select({ status: t.searchRun.status, total: count(t.searchRun.id) })
        .from(t.searchRun)
        .groupBy(t.searchRun.status);
      const pendingReviews = await db
        .select({ total: count(t.dedupReview.id) })
        .from(t.dedupReview)
        .where(eq(t.dedupReview.status, 'pending'));
      const recentRuns = await db
        .select({ total: count(t.searchRun.id) })
        .from(t.searchRun)
        .where(gte(t.searchRun.startedAt, sql`now() - interval '24 hours'`));
      const lastRun = await db
        .select({ startedAt: t.searchRun.startedAt, status: t.searchRun.status })
        .from(t.searchRun)
        .orderBy(desc(t.searchRun.startedAt))
        .limit(1);
      return {
        jobsByStatus,
        runsByStatus,
        pendingDedupReviews: pendingReviews[0]?.total ?? 0,
        runsLast24h: recentRuns[0]?.total ?? 0,
        lastRun: lastRun[0] ?? null,
      };
    },

    /** Counters for jobs rejected by hard filters (Phase 2). */
    async rejectedJobs(limit: number) {
      return db
        .select({ id: t.job.id, title: t.job.title, company: t.job.company, metadata: t.job.metadata })
        .from(t.job)
        .where(and(eq(t.job.status, 'rejected')))
        .orderBy(desc(t.job.updatedAt))
        .limit(limit);
    },
  };
}