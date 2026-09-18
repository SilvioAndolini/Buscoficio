import type { Queue } from 'bullmq';
import type { createSearchRepo } from '@job-system/database';
import type { Logger } from '@job-system/observability';
import { schedulerIdForSearchConfig } from '@job-system/shared';

export interface SchedulerServiceDeps {
  queue: Queue;
  searchRepo: ReturnType<typeof createSearchRepo>;
  logger: Logger;
  enabled: boolean;
}

export interface SchedulerSyncResult {
  upserted: number;
  removed: number;
  skipped: boolean;
}

/**
 * Deterministic jitter: derived from the config id (stable across syncs), so
 * scheduled runs are staggered instead of firing in bursts.
 */
export function computeSchedulerStart(configId: string, intervalMs: number, now = Date.now()): Date {
  const maxJitter = Math.min(Math.floor(intervalMs * 0.1), 120_000);
  if (maxJitter <= 0) return new Date(now);
  let hash = 0;
  for (const char of configId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return new Date(now + (hash % maxJitter));
}

/**
 * Postgres (`search_config`) is the source of truth; this service reconciles
 * BullMQ Job Schedulers to match it (startup, create/update/activate/interval).
 */
export function createSchedulerService(deps: SchedulerServiceDeps) {
  return {
    async syncAll(logger: Logger = deps.logger): Promise<SchedulerSyncResult> {
      if (!deps.enabled) {
        logger.info('scheduler disabled (SCHEDULER_ENABLED=false); no schedulers synced');
        return { upserted: 0, removed: 0, skipped: true };
      }

      const configs = await deps.searchRepo.listConfigs();
      const activeSchedulerIds = new Set<string>();
      let upserted = 0;

      for (const config of configs) {
        if (!config.isActive || config.sources.length === 0) continue;
        const schedulerId = schedulerIdForSearchConfig(config.id);
        const intervalMs = config.intervalMinutes * 60_000;
        activeSchedulerIds.add(schedulerId);
        await deps.queue.upsertJobScheduler(
          schedulerId,
          { every: intervalMs, startDate: computeSchedulerStart(config.id, intervalMs) },
          {
            name: 'search.run',
            data: { searchConfigId: config.id },
            opts: { attempts: 2, removeOnComplete: 500, removeOnFail: 1_000 },
          },
        );
        upserted += 1;
      }

      let removed = 0;
      const existing = await deps.queue.getJobSchedulers(0, 1_000, true);
      for (const scheduler of existing) {
        if (!activeSchedulerIds.has(scheduler.key)) {
          await deps.queue.removeJobScheduler(scheduler.key);
          removed += 1;
        }
      }

      logger.info({ upserted, removed }, 'search schedulers synchronized');
      return { upserted, removed, skipped: false };
    },
  };
}

export type SchedulerService = ReturnType<typeof createSchedulerService>;