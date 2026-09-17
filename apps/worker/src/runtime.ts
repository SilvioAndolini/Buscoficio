import { Worker, type Job, type WorkerOptions } from 'bullmq';
import type { Env } from '@job-system/shared';
import { uuidv7 } from '@job-system/shared';
import { systemClock } from '@job-system/core';
import { createDb, createJobRepo, createSearchRepo, type DbHandle } from '@job-system/database';
import { SourceRegistry, createMockJobSource } from '@job-system/job-sources';
import { createJobLogger, type Logger } from '@job-system/observability';
import { PHASE1_QUEUES, createQueues, createRedisConnection, type Phase1Queue } from './queues.js';
import { createIngestService } from './services/ingest-service.js';
import { createSearchService } from './services/search-service.js';
import { createJobHandlers, type JobHandlers } from './handlers.js';

export interface WorkerRuntimeOptions {
  /** Isolates queues between test runs / environments. */
  queuePrefix?: string;
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

  const registry = new SourceRegistry();
  registry.register(createMockJobSource());

  for (const adapter of registry.list()) {
    await jobRepo.upsertSource({
      key: adapter.key,
      name: adapter.key,
      kind: 'api',
      capabilities: { ...adapter.capabilities },
    });
  }

  const ingestService = createIngestService({ jobRepo, clock: systemClock });
  const searchService = createSearchService({
    searchRepo,
    jobRepo,
    registry,
    ingestService,
    logger,
    clock: systemClock,
  });

  const connection = createRedisConnection(env.REDIS_URL);
  const queues = createQueues(connection, options.queuePrefix);
  const handlers = createJobHandlers({ queues, searchService, searchRepo, logger });

  const workers = PHASE1_QUEUES.map((queueName: Phase1Queue) => {
    const workerOptions: WorkerOptions = {
      connection: createRedisConnection(env.REDIS_URL),
      concurrency: queueName === 'maintenance' ? 1 : 2,
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
          const result = await handler(job);
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
      logger.warn({ queue: queueName, jobId: job?.id, err: error }, 'worker job failure');
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
      await db.pool.end();
    },
  };
}

function readCorrelationId(job: Job): string {
  const data = job.data as Record<string, unknown>;
  const value = data['correlationId'];
  return typeof value === 'string' && value.length > 0 ? value : uuidv7();
}