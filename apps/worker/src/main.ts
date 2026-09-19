import { loadEnv } from '@job-system/shared';
import { createLogger } from '@job-system/observability';
import { startWorkerRuntime } from './runtime.js';

const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL });

const runtime = await startWorkerRuntime(env, logger);
logger.info({ queues: ['search', 'ingest', 'match', 'documents', 'maintenance'] }, 'worker ready');

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'graceful shutdown started');
  try {
    await runtime.close();
    logger.info('graceful shutdown completed');
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