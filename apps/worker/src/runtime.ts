import { Worker, type Job, type WorkerOptions } from 'bullmq';
import type { Env } from '@job-system/shared';
import { uuidv7 } from '@job-system/shared';
import { systemClock, type JobSourceAdapter } from '@job-system/core';
import {
  createDb,
  createDedupRepo,
  createJobRepo,
  createSearchRepo,
  type DbHandle,
} from '@job-system/database';
import {
  SOURCE_POLICY_NOTES,
  SourceRegistry,
  createMockJobSource,
  createRealSourceAdapters,
} from '@job-system/job-sources';
import { createJobLogger, type Logger } from '@job-system/observability';
import { WORKER_QUEUES, createQueues, createRedisConnection, type WorkerQueue } from './queues.js';
import { createIngestService } from './services/ingest-service.js';
import { createSearchService } from './services/search-service.js';
import { createRedisRateLimiter } from './services/rate-limiter.js';
import { createSchedulerService } from './services/scheduler-service.js';
import { createReconciliationService } from './services/reconciliation-service.js';
import { createJobHandlers, type JobHandlers } from './handlers.js';

export interface WorkerRuntimeOptions {
  /** Isolates queues between test runs / environments. */
  queuePrefix?: string;
  /** Override the adapter registry (tests / E2E local fixture servers). */
  adapters?: JobSourceAdapter[];
}

export interface WorkerRuntime {
  db: DbHandle;
  handlers: JobHandlers;
  workers: Worker[];
  close: () => Promise<void>;
}

/**
 * Worker composition root: builds repos, adapters, services and BullMQ workers.
 * Handlers dispatch by job name and never bypass the services layer.
 */
export async function startWorkerRuntime(
  env: Env,
  logger: Logger,
  options: WorkerRuntimeOptions = {},
): Promise<WorkerRuntime> {
  const db = createDb(env.DATABASE_URL);
  const jobRepo = createJobRepo(db.db);
  const searchRepo = createSearchRepo(db.db);
  const dedupRepo = createDedupRepo(db.db);

  const registry = new SourceRegistry();
  const adapters = options.adapters ?? [createMockJobSource(), ...createRealSourceAdapters()];
  for (const adapter of adapters) registry.register(adapter);

  for (const adapter of registry.list()) {
    await jobRepo.upsertSource({
      key: adapter.key,
      name: adapter.key,
      kind: 'api',
      capabilities: { ...adapter.capabilities },
      policyNotes:
        SOURCE_POLICY_NOTES[adapter.key] ??
        (adapter.key.startsWith('mock')
          ? 'mock source: deterministic fixtures for tests/dev; no external service'
          : null),
    });
  }

  const rateLimiterRedis = createRedisConnection(env.REDIS_URL);
  const rateLimiter = createRedisRateLimiter(rateLimiterRedis, logger);
  const thresholds = {
    high: env.DEDUP_L3_HIGH_THRESHOLD,
    medium: env.DEDUP_L3_MEDIUM_THRESHOLD,
  };

  const ingestService = createIngestService({ jobRepo, clock: systemClock });
  const searchService = createSearchService({
    searchRepo,
    jobRepo,
    registry,
    ingestService,
    logger,
    clock: systemClock,
    rateLimiter,
    thresholds,
  });

  const connection = createRedisConnection(env.REDIS_URL);
  const queues = createQueues(connection, options.queuePrefix);

  const schedulerService = createSchedulerService({
    queue: queues.search,
    searchRepo,
    logger,
    enabled: env.SCHEDULER_ENABLED,
  });
  const reconciliationService = createReconciliationService({
    searchRepo,
    logger,
    timeoutMs: env.WATCHDOG_TIMEOUT_MS,
  });

  const handlers = createJobHandlers({
    queues,
    searchService,
    searchRepo,
    schedulerService,
    reconciliationService,
    dedupRepo,
    logger,
  });

  // Reconcile schedulers from Postgres (source of truth) and register watchdog.
  await schedulerService.syncAll();
  await queues.maintenance.upsertJobScheduler(
    'maintenance-search-reconcile',
    { every: 300_000 },
    {
      name: 'maintenance.search-reconcile',
      opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
    },
  );

  const workers = WORKER_QUEUES.map((queueName: WorkerQueue) => {
    const workerOptions: WorkerOptions = {
      connection: createRedisConnection(env.REDIS_URL),
      concurrency: queueName === 'maintenance' || queueName === 'dedup-review' ? 1 : 2,
      ...(options.queuePrefix === undefined ? {} : { prefix: options.queuePrefix }),
    };
    const worker = new Worker(
      queueName,
      async (job: Job) => {
        const handler = handlers[job.name as keyof JobHandlers];
        if (!handler) throw new Error(`No handler for job '${job.name}' on queue '${queueName}'`);

        const correlationId = readCorrelationId(job);
        const jobLogger = createJobLogger(logger, {
          correlationId,
          ...(job.id === undefined ? {} : { jobId: job.id }),
        });
        jobLogger.info({ queue: queueName, name: job.name, attempt: job.attemptsMade + 1 }, 'job started');
        const startedAt = Date.now();
        try {
          const result = await handler(job, jobLogger);
          jobLogger.info({ queue: queueName, name: job.name, durationMs: Date.now() - startedAt }, 'job completed');
          return result;
        } catch (error) {
          jobLogger.error(
            { queue: queueName, name: job.name, err: error, durationMs: Date.now() - startedAt },
            'job failed',
          );
          throw error;
        }
      },
      workerOptions,
    );
    worker.on('failed', (job, error) => {
      logger.warn(
        {
          queue: queueName,
          jobId: job?.id,
          correlationId: readCorrelationIdFromData(job?.data),
          err: error,
        },
        'worker job failure',
      );
    });
    return worker;
  });

  return {
    db,
    handlers,
    workers,
    close: async () => {
      await Promise.all(workers.map((worker) => worker.close()));
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await connection.quit();
      await rateLimiterRedis.quit();
      await db.pool.end();
    },
  };
}

function readCorrelationId(job: Job): string {
  const value = readCorrelationIdFromData(job.data);
  return value ?? uuidv7();
}

function readCorrelationIdFromData(data: unknown): string | undefined {
  if (typeof data === 'object' && data !== null && 'correlationId' in data) {
    const value = (data as Record<string, unknown>)['correlationId'];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}