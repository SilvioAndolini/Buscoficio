import { and, desc, eq } from 'drizzle-orm';
import { NotFoundError } from '@job-system/core';
import { uuidv7 } from '@job-system/shared';
import type { Db } from '../client.js';
import * as t from '../schema.js';

export interface SearchConfigData {
  candidateId: string;
  name: string;
  keywords: string[];
  locations: string[];
  remote: boolean | null;
  sources: string[];
  intervalMinutes: number;
  mode: 'manual' | 'assisted' | 'auto';
  filters?: Record<string, unknown>;
}

export interface SourceRunResult {
  status: 'completed' | 'failed' | 'skipped';
  jobsDiscovered: number;
  jobsNew: number;
  jobsDuplicated: number;
  jobsRejected: number;
  errors: number;
  durationMs: number;
  errorClass?: string | null;
  errorDetail?: string | null;
}

export function createSearchRepo(db: Db) {
  return {
    async createConfig(data: SearchConfigData) {
      const [row] = await db
        .insert(t.searchConfig)
        .values({
          id: uuidv7(),
          candidateId: data.candidateId,
          name: data.name,
          keywords: [...data.keywords],
          locations: [...data.locations],
          remote: data.remote,
          sources: [...data.sources],
          intervalMinutes: data.intervalMinutes,
          mode: data.mode,
          filters: data.filters ?? {},
        })
        .returning();
      return row!;
    },

    async listConfigs() {
      return db.select().from(t.searchConfig).orderBy(desc(t.searchConfig.createdAt));
    },

    async getConfig(id: string) {
      const [row] = await db.select().from(t.searchConfig).where(eq(t.searchConfig.id, id)).limit(1);
      if (!row) throw new NotFoundError(`Search config not found: ${id}`);
      return row;
    },

    async createRun(searchConfigId: string, correlationId: string) {
      const [row] = await db
        .insert(t.searchRun)
        .values({ id: uuidv7(), searchConfigId, correlationId })
        .returning();
      return row!;
    },

    async getRun(id: string) {
      const [row] = await db.select().from(t.searchRun).where(eq(t.searchRun.id, id)).limit(1);
      if (!row) throw new NotFoundError(`Search run not found: ${id}`);
      return row;
    },

    async listRuns(limit: number) {
      return db.select().from(t.searchRun).orderBy(desc(t.searchRun.startedAt)).limit(limit);
    },

    async listSourceRuns(searchRunId: string) {
      return db
        .select({ run: t.searchSourceRun, sourceKey: t.jobSource.key })
        .from(t.searchSourceRun)
        .innerJoin(t.jobSource, eq(t.searchSourceRun.sourceId, t.jobSource.id))
        .where(eq(t.searchSourceRun.searchRunId, searchRunId))
        .orderBy(t.jobSource.key);
    },

    async createSourceRun(searchRunId: string, sourceId: string, correlationId: string) {
      const [row] = await db
        .insert(t.searchSourceRun)
        .values({ id: uuidv7(), searchRunId, sourceId, correlationId })
        .onConflictDoNothing({ target: [t.searchSourceRun.searchRunId, t.searchSourceRun.sourceId] })
        .returning();
      if (row) return row;
      const [existing] = await db
        .select()
        .from(t.searchSourceRun)
        .where(
          and(
            eq(t.searchSourceRun.searchRunId, searchRunId),
            eq(t.searchSourceRun.sourceId, sourceId),
          ),
        )
        .limit(1);
      return existing!;
    },

    async finishSourceRun(id: string, result: SourceRunResult) {
      const [row] = await db
        .update(t.searchSourceRun)
        .set({
          status: result.status,
          finishedAt: new Date(),
          jobsDiscovered: result.jobsDiscovered,
          jobsNew: result.jobsNew,
          jobsDuplicated: result.jobsDuplicated,
          jobsRejected: result.jobsRejected,
          errors: result.errors,
          durationMs: result.durationMs,
          errorClass: result.errorClass ?? null,
          errorDetail: result.errorDetail ?? null,
        })
        .where(eq(t.searchSourceRun.id, id))
        .returning();
      if (!row) throw new NotFoundError(`Search source run not found: ${id}`);
      return row;
    },

    /**
     * Idempotent finalizer (ADR-016): derives parent status/counters from children.
     * Safe to call multiple times and from multiple workers.
     */
    async finalizeRun(searchRunId: string) {
      return db.transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(t.searchRun)
          .where(eq(t.searchRun.id, searchRunId))
          .limit(1);
        if (!run) throw new NotFoundError(`Search run not found: ${searchRunId}`);

        const children = await tx
          .select()
          .from(t.searchSourceRun)
          .where(eq(t.searchSourceRun.searchRunId, searchRunId));

        // Vacuously true for zero children: a run without usable sources finalizes as failed.
        const terminal = children.every((child) => child.status !== 'running');
        if (!terminal) return { ...run, finalized: false as const };

        const totals = children.reduce(
          (acc, child) => ({
            jobsDiscovered: acc.jobsDiscovered + child.jobsDiscovered,
            jobsNew: acc.jobsNew + child.jobsNew,
            jobsDuplicated: acc.jobsDuplicated + child.jobsDuplicated,
            jobsRejected: acc.jobsRejected + child.jobsRejected,
            errors: acc.errors + child.errors,
          }),
          { jobsDiscovered: 0, jobsNew: 0, jobsDuplicated: 0, jobsRejected: 0, errors: 0 },
        );

        const completed = children.filter((child) => child.status === 'completed').length;
        const failed = children.filter((child) => child.status === 'failed').length;
        const status =
          children.length === 0 ? 'failed' : failed === 0 ? 'completed' : completed === 0 ? 'failed' : 'partial';

        const [updated] = await tx
          .update(t.searchRun)
          .set({ ...totals, status, finishedAt: new Date() })
          .where(eq(t.searchRun.id, searchRunId))
          .returning();
        return { ...updated!, finalized: true as const };
      });
    },
  };
}