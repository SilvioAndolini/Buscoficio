import type { createSearchRepo } from '@job-system/database';
import type { Logger } from '@job-system/observability';

export interface ReconciliationServiceDeps {
  searchRepo: ReturnType<typeof createSearchRepo>;
  logger: Logger;
  timeoutMs: number;
}

export interface ReconciliationResult {
  stale: number;
  recovered: number;
  failedSources: number;
}

/**
 * Watchdog: a SearchRun can never stay `running` forever. Stale runs get their
 * still-running source children failed with evidence and are finalized
 * idempotently (safe to run concurrently / repeatedly).
 */
export function createReconciliationService(deps: ReconciliationServiceDeps) {
  return {
    async reconcileStaleRuns(logger: Logger = deps.logger): Promise<ReconciliationResult> {
      const staleRuns = await deps.searchRepo.listStaleRuns(deps.timeoutMs);
      let recovered = 0;
      let failedSources = 0;

      for (const run of staleRuns) {
        const children = await deps.searchRepo.listSourceRuns(run.id);
        const running = children.filter((entry) => entry.run.status === 'running');
        if (running.length > 0) {
          await deps.searchRepo.failRunningSourceRuns(
            run.id,
            'WatchdogTimeout',
            `source run exceeded watchdog timeout (${deps.timeoutMs}ms)`,
          );
          failedSources += running.length;
        }
        const result = await deps.searchRepo.finalizeRun(run.id);
        recovered += 1;
        logger.warn(
          {
            searchRunId: run.id,
            failedSources: running.length,
            status: result.status,
            startedAt: run.startedAt.toISOString(),
          },
          'stale search run reconciled by watchdog',
        );
      }

      return { stale: staleRuns.length, recovered, failedSources };
    },
  };
}

export type ReconciliationService = ReturnType<typeof createReconciliationService>;