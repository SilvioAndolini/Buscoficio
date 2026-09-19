import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import {
  isAppError,
  systemClock,
  toAppError,
  type Clock,
  type StoragePort,
} from '@job-system/core';
import {
  createApplicationRepo,
  createApplicationRepositoryPort,
  createAuditRepo,
  createCandidateRepo,
  createDedupRepo,
  createJobRepo,
  createMatchingRepo,
  createResumeRepo,
  createSearchRepo,
  createStatsRepo,
  type DbHandle,
} from '@job-system/database';
import {
  MAX_FACTUAL_REPAIR_ATTEMPTS,
  buildPolicyVersion,
  createApplicationEngine,
} from '@job-system/application-engine';
import { createTextGenerationProvider } from '@job-system/ai';
import { createDocumentsService } from '@job-system/documents';
import { ENGINE_VERSION } from '@job-system/matching';
import type { Logger } from '@job-system/observability';
import { resolveEmbeddingRuntime, resolveTextRuntime, textApiKey, type Env } from '@job-system/shared';
import { uuidv7 } from '@job-system/shared';
import { requireSession } from './auth.js';
import type { ApiCtx } from './context.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerResumeRoutes } from './routes/resumes.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerSourceRoutes } from './routes/sources.js';
import { registerApplicationTargetRoutes } from './routes/application-targets.js';
import { registerDedupRoutes } from './routes/dedup.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerMatchRoutes } from './routes/matches.js';
import { registerApplicationRoutes } from './routes/applications.js';

export interface AppDeps {
  env: Env;
  logger: Logger;
  dbHandle: DbHandle;
  redis: IORedis;
  storage: StoragePort;
  searchQueue: Queue;
  matchQueue: Queue;
  documentsQueue: Queue;
  maintenanceQueue: Queue;
  clock?: Clock;
}

/**
 * API composition root. Transport only: validation, auth, queries and queue
 * enqueueing. Long-running work never executes inside the request lifecycle.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ genReqId: () => uuidv7() });

  await app.register(cookie, { secret: deps.env.AUTH_SECRET });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  const clock = deps.clock ?? systemClock;
  const applicationRepo = createApplicationRepo(deps.dbHandle.db, deps.dbHandle.pool);
  const textRuntime = resolveTextRuntime(deps.env);
  const textProvider = createTextGenerationProvider({
    provider: textRuntime.provider,
    model: textRuntime.model,
    apiKey: textApiKey(deps.env),
    baseUrl: deps.env.AI_BASE_URL,
  });
  const documents = createDocumentsService({ textProvider });
  const applicationEngine = createApplicationEngine({
    repo: createApplicationRepositoryPort(applicationRepo),
    documents,
    storage: deps.storage,
    clock,
    policy: {
      version: buildPolicyVersion(
        deps.env.APPLICATION_PREPARATION_POLICY_VERSION,
        deps.env.REAPPLICATION_COOLDOWN_DAYS,
      ),
      reapplicationCooldownDays: deps.env.REAPPLICATION_COOLDOWN_DAYS,
      maxFactualRepairAttempts: MAX_FACTUAL_REPAIR_ATTEMPTS,
    },
  });

  const ctx: ApiCtx = {
    env: deps.env,
    logger: deps.logger,
    db: deps.dbHandle.db,
    pool: deps.dbHandle.pool,
    redis: deps.redis,
    storage: deps.storage,
    searchQueue: deps.searchQueue,
    matchQueue: deps.matchQueue,
    documentsQueue: deps.documentsQueue,
    maintenanceQueue: deps.maintenanceQueue,
    engineVersion: ENGINE_VERSION,
    embeddingRuntime: resolveEmbeddingRuntime(deps.env),
    applicationEngine,
    documents,
    clock,
    repos: {
      candidate: createCandidateRepo(deps.dbHandle.db),
      resume: createResumeRepo(deps.dbHandle.db),
      job: createJobRepo(deps.dbHandle.db),
      search: createSearchRepo(deps.dbHandle.db),
      audit: createAuditRepo(deps.dbHandle.db),
      dedup: createDedupRepo(deps.dbHandle.db),
      stats: createStatsRepo(deps.dbHandle.db),
      matching: createMatchingRepo(deps.dbHandle.db),
      applications: applicationRepo,
    },
  };

  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/v1/')) return;
    if (path === '/v1/auth/login') return;
    requireSession(deps.env.AUTH_SECRET, request.cookies['session']);
  });

  app.setErrorHandler((error, request, reply) => {
    // Framework-level 4xx (bad JSON, unsupported media type, ...) must not be
    // reported as INTERNAL/500.
    if (!isAppError(error)) {
      const statusCode = (error as { statusCode?: unknown }).statusCode;
      if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
        void reply.status(statusCode).send({
          code: 'VALIDATION_ERROR',
          message: error instanceof Error ? error.message : 'Request error',
          correlationId: request.id,
        });
        return;
      }
    }
    const appError = isAppError(error) ? error : toAppError(error);
    if (!isAppError(error)) {
      ctx.logger.error({ correlationId: request.id, err: error }, 'unhandled error');
    }
    void reply.status(appError.httpStatus).send({
      code: appError.code,
      message: appError.message,
      ...(appError.context === undefined ? {} : { details: appError.context }),
      correlationId: request.id,
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({ code: 'NOT_FOUND', message: 'Route not found' });
  });

  registerHealthRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerProfileRoutes(app, ctx);
  registerResumeRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerSourceRoutes(app, ctx);
  registerApplicationTargetRoutes(app, ctx);
  registerDedupRoutes(app, ctx);
  registerStatsRoutes(app, ctx);
  registerMatchRoutes(app, ctx);
  registerApplicationRoutes(app, ctx);

  return app;
}