import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@job-system/shared';
import { uuidv7 } from '@job-system/shared';
import { createLogger, type DestinationStream } from '@job-system/observability';
import {
  createCandidateRepo,
  createJobRepo,
  createSearchRepo,
  type DbHandle,
} from '@job-system/database';
import { createTestDb, truncateAll } from '@job-system/database/testing';
import { createMockJobSource } from '@job-system/job-sources';
import {
  QUEUE_MAINTENANCE,
  QUEUE_SEARCH,
  createQueues,
  createRedisConnection,
  searchRunJobId,
} from '../src/queues.js';
import { startWorkerRuntime, type WorkerRuntime } from '../src/runtime.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? '';
const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? '';
const hasInfrastructure = TEST_DATABASE_URL.length > 0 && TEST_REDIS_URL.length > 0;
const describeIntegration = hasInfrastructure ? describe : describe.skip;

const QUEUE_PREFIX = `job-system-log-${Date.now()}`;

const testEnv: Env = {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: TEST_REDIS_URL,
  API_HOST: '127.0.0.1',
  API_PORT: 0,
  AUTH_PASSWORD_HASH: 'a'.repeat(64),
  AUTH_SECRET: 'test-secret-value-123456',
  AUTH_COOKIE_SECURE: false,
  DRY_RUN: true,
  AUTO_APPLY_ENABLED: false,
  STORAGE_BACKEND: 'local',
  STORAGE_LOCAL_DIR: '.data/test-storage',
  LOG_LEVEL: 'info',
  AI_PROVIDER: 'mock',
  DECISION_PROVIDER: 'mock',
  AI_MONTHLY_BUDGET_USD: 0,
  DEDUP_L3_HIGH_THRESHOLD: 0.92,
  DEDUP_L3_MEDIUM_THRESHOLD: 0.75,
  WATCHDOG_TIMEOUT_MS: 900_000,
  SCHEDULER_ENABLED: true,
  TARGET_ENRICHMENT_MAX_PER_RUN: 25,
};

const logLines: string[] = [];
const captureStream: DestinationStream = { write: (line: string) => void logLines.push(line) };

function parsedLogs(): Array<Record<string, unknown>> {
  return logLines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

function expectJobScoped(entry: Record<string, unknown> | undefined): void {
  expect(entry).toBeDefined();
  expect(typeof entry!['correlationId']).toBe('string');
  expect(typeof entry!['jobId']).toBe('string');
}

let handle: DbHandle;
let runtime: WorkerRuntime;

beforeAll(async () => {
  handle = await createTestDb();
  runtime = await startWorkerRuntime(testEnv, createLogger({ level: 'info', stream: captureStream }), {
    queuePrefix: QUEUE_PREFIX,
    rateLimitWindowMs: 400,
    adapters: [
      createMockJobSource({ key: 'mock' }),
      // Low limit forces the rate limiter to wait between pages (3 pages).
      createMockJobSource({ key: 'mock-rate', rateLimitPerMinute: 1, pageSize: 4 }),
    ],
  });
});

afterAll(async () => {
  await runtime.close();
  await handle.pool.end();
});

beforeEach(async () => {
  await truncateAll(handle.db);
  logLines.length = 0;
});

describeIntegration('job-scoped logging reaches Phase 2 services', () => {
  it('scheduler.sync keeps correlationId + jobId in service logs', async () => {
    const redis = createRedisConnection(TEST_REDIS_URL);
    const queues = createQueues(redis, QUEUE_PREFIX);
    const events = new QueueEvents(QUEUE_MAINTENANCE, {
      connection: createRedisConnection(TEST_REDIS_URL),
      prefix: QUEUE_PREFIX,
    });
    await events.waitUntilReady();
    try {
      const job = await queues.maintenance.add('scheduler.sync', { correlationId: uuidv7() });
      await job.waitUntilFinished(events, 20_000);

      const synchronized = parsedLogs().find(
        (entry) => entry['msg'] === 'search schedulers synchronized',
      );
      expectJobScoped(synchronized);
      const completed = parsedLogs().find((entry) => entry['msg'] === 'scheduler sync completed');
      expectJobScoped(completed);
    } finally {
      await events.close();
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await redis.quit();
    }
  });

  it('maintenance.search-reconcile keeps correlationId + jobId', async () => {
    const redis = createRedisConnection(TEST_REDIS_URL);
    const queues = createQueues(redis, QUEUE_PREFIX);
    const events = new QueueEvents(QUEUE_MAINTENANCE, {
      connection: createRedisConnection(TEST_REDIS_URL),
      prefix: QUEUE_PREFIX,
    });
    await events.waitUntilReady();
    try {
      const job = await queues.maintenance.add('maintenance.search-reconcile', {
        correlationId: uuidv7(),
      });
      await job.waitUntilFinished(events, 20_000);
      const completed = parsedLogs().find(
        (entry) => entry['msg'] === 'watchdog reconciliation completed',
      );
      expectJobScoped(completed);
    } finally {
      await events.close();
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await redis.quit();
    }
  });

  it('rate-limit waits inside a job include correlationId + jobId + sourceId', async () => {
    const candidateRepo = createCandidateRepo(handle.db);
    const searchRepo = createSearchRepo(handle.db);
    const profile = await candidateRepo.upsertProfile({
      fullName: 'Ada',
      email: 'ada@example.com',
      remotePreference: [],
      employmentTypes: [],
      allowedCountries: [],
      relocation: false,
      preferences: {},
    });
    await createJobRepo(handle.db).upsertSource({
      key: 'mock-rate',
      name: 'mock-rate',
      kind: 'api',
      capabilities: {},
    });
    const config = await searchRepo.createConfig({
      candidateId: profile.id,
      name: 'Rate limited',
      keywords: [],
      locations: [],
      remote: null,
      sources: ['mock-rate'],
      intervalMinutes: 1440,
      mode: 'manual',
    });

    const redis = createRedisConnection(TEST_REDIS_URL);
    const queues = createQueues(redis, QUEUE_PREFIX);
    const events = new QueueEvents(QUEUE_SEARCH, {
      connection: createRedisConnection(TEST_REDIS_URL),
      prefix: QUEUE_PREFIX,
    });
    await events.waitUntilReady();
    try {
      const job = await queues.search.add(
        'search.run',
        { searchConfigId: config.id, correlationId: uuidv7() },
        { jobId: searchRunJobId(config.id, Date.now()) },
      );
      await job.waitUntilFinished(events, 30_000);

      // Wait for the full run (ingest.source performs the rate-limited pages).
      const deadline = Date.now() + 30_000;
      let finished = false;
      while (Date.now() < deadline) {
        const runs = await searchRepo.listRuns(1);
        if (runs[0] && runs[0].status !== 'running') {
          finished = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(finished).toBe(true);

      const rateLimitLog = parsedLogs().find(
        (entry) => entry['msg'] === 'self-imposed rate limit reached; delaying source request',
      );
      expectJobScoped(rateLimitLog);
      expect(rateLimitLog!['sourceId']).toBe('mock-rate');
      expect(rateLimitLog!['operation']).toBe('search');
    } finally {
      await events.close();
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await redis.quit();
    }
  }, 60_000);

  it('blocked sources are skipped with an explicit reason (no execution)', async () => {
    const candidateRepo = createCandidateRepo(handle.db);
    const searchRepo = createSearchRepo(handle.db);
    const jobRepo = createJobRepo(handle.db);
    const profile = await candidateRepo.upsertProfile({
      fullName: 'Ada',
      email: 'ada@example.com',
      remotePreference: [],
      employmentTypes: [],
      allowedCountries: [],
      relocation: false,
      preferences: {},
    });
    await jobRepo.upsertSource({
      key: 'mock-rate',
      name: 'mock-rate',
      kind: 'api',
      capabilities: {},
    });
    await jobRepo.updateSourceStatus('mock-rate', 'blocked');
    const config = await searchRepo.createConfig({
      candidateId: profile.id,
      name: 'Blocked source',
      keywords: [],
      locations: [],
      remote: null,
      sources: ['mock-rate'],
      intervalMinutes: 1440,
      mode: 'manual',
    });

    const redis = createRedisConnection(TEST_REDIS_URL);
    const queues = createQueues(redis, QUEUE_PREFIX);
    try {
      await queues.search.add(
        'search.run',
        { searchConfigId: config.id, correlationId: uuidv7() },
        { jobId: searchRunJobId(config.id, Date.now()) },
      );
      const deadline = Date.now() + 20_000;
      let run: { id: string; status: string } | null = null;
      while (Date.now() < deadline) {
        const runs = await searchRepo.listRuns(1);
        if (runs[0] && runs[0].status !== 'running') {
          run = runs[0];
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(run).not.toBeNull();

      const sources = await searchRepo.listSourceRuns(run!.id);
      expect(sources).toHaveLength(1);
      expect(sources[0]!.run.status).toBe('skipped');
      expect(sources[0]!.run.errorDetail).toContain("source status is 'blocked'");
    } finally {
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await redis.quit();
    }
  });
});