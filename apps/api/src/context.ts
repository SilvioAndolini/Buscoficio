import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import type { output, ZodTypeAny } from 'zod';
import {
  ValidationError,
  systemClock,
  type Clock,
  type StoragePort,
} from '@job-system/core';
import type {
  Db,
  createAuditRepo,
  createCandidateRepo,
  createDedupRepo,
  createJobRepo,
  createResumeRepo,
  createSearchRepo,
  createStatsRepo,
} from '@job-system/database';
import type { Logger } from '@job-system/observability';
import type { Env } from '@job-system/shared';

export interface ApiRepos {
  candidate: ReturnType<typeof createCandidateRepo>;
  resume: ReturnType<typeof createResumeRepo>;
  job: ReturnType<typeof createJobRepo>;
  search: ReturnType<typeof createSearchRepo>;
  audit: ReturnType<typeof createAuditRepo>;
  dedup: ReturnType<typeof createDedupRepo>;
  stats: ReturnType<typeof createStatsRepo>;
}

export interface ApiCtx {
  env: Env;
  logger: Logger;
  db: Db;
  pool: Pool;
  redis: IORedis;
  storage: StoragePort;
  searchQueue: Queue;
  maintenanceQueue: Queue;
  clock: Clock;
  repos: ApiRepos;
}

/** Zod validation helper for every external boundary (architecture doc 05 §1). */
export function parse<S extends ZodTypeAny>(schema: S, value: unknown, what = 'request'): output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`Invalid ${what}`, {
      context: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }
  return result.data;
}

export const defaultClock = systemClock;