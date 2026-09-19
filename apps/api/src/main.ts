import { loadEnv } from '@job-system/shared';
import { createLogger } from '@job-system/observability';
import { createDb } from '@job-system/database';
import { LocalStorageAdapter } from '@job-system/storage';
import { buildApp } from './app.js';
import {
  createDocumentsQueue,
  createMaintenanceQueue,
  createMatchQueue,
  createSearchQueue,
} from './search-queue.js';
import { createRedisConnection } from './redis.js';

const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL });

const dbHandle = createDb(env.DATABASE_URL);
const redis = createRedisConnection(env.REDIS_URL);
const searchQueue = createSearchQueue(redis);
const matchQueue = createMatchQueue(redis);
const documentsQueue = createDocumentsQueue(redis);
const maintenanceQueue = createMaintenanceQueue(redis);
const storage = new LocalStorageAdapter(env.STORAGE_LOCAL_DIR);

const app = await buildApp({
  env,
  logger,
  dbHandle,
  redis,
  storage,
  searchQueue,
  matchQueue,
  documentsQueue,
  maintenanceQueue,
});
await app.listen({ host: env.API_HOST, port: env.API_PORT });
logger.info({ host: env.API_HOST, port: env.API_PORT, dryRun: env.DRY_RUN }, 'api ready');

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'graceful shutdown started');
  try {
    await app.close();
    await searchQueue.close();
    await matchQueue.close();
    await documentsQueue.close();
    await maintenanceQueue.close();
    await redis.quit();
    await dbHandle.pool.end();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'graceful shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});