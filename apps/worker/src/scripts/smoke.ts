import { QueueEvents } from 'bullmq';
import { loadEnv, uuidv7 } from '@job-system/shared';
import { createLogger } from '@job-system/observability';
import { QUEUE_MAINTENANCE, createQueues, createRedisConnection } from '../queues.js';
import { startWorkerRuntime } from '../runtime.js';

/** Manual smoke check: enqueues a maintenance job and waits for completion. */
const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL });
const runtime = await startWorkerRuntime(env, logger);

const connection = createRedisConnection(env.REDIS_URL);
const queues = createQueues(connection);
const events = new QueueEvents(QUEUE_MAINTENANCE, {
  connection: createRedisConnection(env.REDIS_URL),
});

try {
  const correlationId = uuidv7();
  const job = await queues.maintenance.add('maintenance.smoke', { correlationId });
  logger.info({ jobId: job.id, correlationId }, 'smoke: job enqueued');
  const result = await job.waitUntilFinished(events);
  logger.info({ result }, 'smoke: job completed');
  process.exitCode = 0;
} catch (error) {
  logger.error({ err: error }, 'smoke: job failed');
  process.exitCode = 1;
} finally {
  await events.close();
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  await connection.quit();
  await runtime.close();
}