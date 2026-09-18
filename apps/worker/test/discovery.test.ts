import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@job-system/shared';
import { uuidv7 } from '@job-system/shared';
import type { CandidateProfileInput } from '@job-system/core';
import { createLogger } from '@job-system/observability';
import {
  createCandidateRepo,
  createJobRepo,
  createSearchRepo,
  type DbHandle,
} from '@job-system/database';
import { createTestDb, truncateAll } from '@job-system/database/testing';
import { createMockJobSource } from '@job-system/job-sources';
import {
  QUEUE_SEARCH,
  createQueues,
  createRedisConnection,
  searchRunJobId,
} from '../src/queues.js';
import { startWorkerRuntime, type WorkerRuntime } from '../src/runtime.js';
import { createRedisRateLimiter } from '../src/services/rate-limiter.js';
import { computeSchedulerStart, createSchedulerService } from '../src/services/scheduler-service.js';
import { createReconciliationService } from '../src/services/reconciliation-service.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? '';
const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? '';
const hasInfrastructure = TEST_DATABASE_URL.length > 0 && TEST_REDIS_URL.length > 0;
const describeIntegration = hasInfrastructure ? describe : describe.skip;

const QUEUE_PREFIX = `job-system-f2-${Date.now()}`;

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
  LOG_LEVEL: 'warn',
  AI_PROVIDER: 'mock',
  DECISION_PROVIDER: 'mock',
  AI_MONTHLY_BUDGET_USD: 0,
  DEDUP_L3_HIGH_THRESHOLD: 0.92,
  DEDUP_L3_MEDIUM_THRESHOLD: 0.75,
  WATCHDOG_TIMEOUT_MS: 900_000,
  SCHEDULER_ENABLED: true,
};

const profileInput: CandidateProfileInput = {
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  remotePreference: ['remote'],
  employmentTypes: ['full_time'],
  allowedCountries: [],
  relocation: false,
  preferences: {},
};

let handle: DbHandle;
let runtime: WorkerRuntime;
let queueEvents: QueueEvents;

async function waitForNewFinishedRun(excludeIds: Set<string>, timeoutMs = 30_000) {
  const searchRepo = createSearchRepo(handle.db);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await searchRepo.listRuns(50);
    const fresh = runs.find((run) => !excludeIds.has(run.id));
    if (fresh && fresh.status !== 'running') return fresh;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for a new finished search run');
}

beforeAll(async () => {
  handle = await createTestDb();
  runtime = await startWorkerRuntime(testEnv, createLogger({ level: 'error' }), {
    queuePrefix: QUEUE_PREFIX,
    adapters: [
      createMockJobSource({ key: 'mock-a' }),
      createMockJobSource({ key: 'mock-b', failSearch: 'transient' }),
      createMockJobSource({ key: 'mock-c' }),
    ],
  });
  queueEvents = new QueueEvents(QUEUE_SEARCH, {
    connection: createRedisConnection(TEST_REDIS_URL),
    prefix: QUEUE_PREFIX,
  });
  await queueEvents.waitUntilReady();
});

afterAll(async () => {
  await queueEvents.close();
  await runtime.close();
  await handle.pool.end();
});

beforeEach(async () => {
  await truncateAll(handle.db);
});

describeIntegration('fan-out: partial runs and per-source isolation', () => {
  it('keeps completed sources when one source fails (partial) and finalizes idempotently', async () => {
    const candidateRepo = createCandidateRepo(handle.db);
    const searchRepo = createSearchRepo(handle.db);
    const profile = await candidateRepo.upsertProfile(profileInput);
    const config = await searchRepo.createConfig({
      candidateId: profile.id,
      name: 'Three sources',
      keywords: [],
      locations: [],
      remote: null,
      sources: ['mock-a', 'mock-b', 'mock-c'],
      intervalMinutes: 1440,
      mode: 'manual',
    });

    const connection = createRedisConnection(TEST_REDIS_URL);
    const queues = createQueues(connection, QUEUE_PREFIX);
    try {
      const job = await queues.search.add(
        'search.run',
        { searchConfigId: config.id, correlationId: uuidv7() },
        { jobId: searchRunJobId(config.id, Date.now()) },
      );
      await job.waitUntilFinished(queueEvents, 40_000);

      const run = await waitForNewFinishedRun(new Set());
      expect(run.status).toBe('partial');
      expect(run.errors).toBeGreaterThanOrEqual(1);
      expect(run.jobsNew).toBeGreaterThan(0);

      const sources = await searchRepo.listSourceRuns(run.id);
      const byKey = new Map(sources.map((entry) => [entry.sourceKey, entry.run]));
      expect(byKey.get('mock-a')?.status).toBe('completed');
      expect(byKey.get('mock-b')?.status).toBe('failed');
      expect(byKey.get('mock-c')?.status).toBe('completed');
      expect(byKey.get('mock-b')?.errorClass).toBeTruthy();
      expect(byKey.get('mock-a')?.jobsNew).toBeGreaterThan(0);
      expect(byKey.get('mock-c')?.status).toBe('completed');

      // Idempotent finalizer: repeated calls keep the same derived state.
      const again = await searchRepo.finalizeRun(run.id);
      expect(again.status).toBe('partial');
      expect(again.jobsNew).toBe(run.jobsNew);
    } finally {
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await connection.quit();
    }
  }, 60_000);
});

describeIntegration('scheduler: Postgres is the source of truth', () => {
  it('upserts and removes BullMQ job schedulers from search_config', async () => {
    const candidateRepo = createCandidateRepo(handle.db);
    const searchRepo = createSearchRepo(handle.db);
    const jobRepo = createJobRepo(handle.db);
    const profile = await candidateRepo.upsertProfile(profileInput);
    await jobRepo.upsertSource({ key: 'mock-a', name: 'mock-a', kind: 'api', capabilities: {} });
    const config = await searchRepo.createConfig({
      candidateId: profile.id,
      name: 'Scheduled',
      keywords: [],
      locations: [],
      remote: null,
      sources: ['mock-a'],
      intervalMinutes: 120,
      mode: 'assisted',
    });

    const connection = createRedisConnection(TEST_REDIS_URL);
    const queues = createQueues(connection, QUEUE_PREFIX);
    const service = createSchedulerService({
      queue: queues.search,
      searchRepo,
      logger: createLogger({ level: 'error' }),
      enabled: true,
    });
    try {
      const first = await service.syncAll();
      expect(first.upserted).toBeGreaterThanOrEqual(1);
      const schedulers = await queues.search.getJobSchedulers(0, 1_000, true);
      const created = schedulers.find((scheduler) => scheduler.key.endsWith(config.id));
      expect(created).toBeDefined();

      await searchRepo.updateConfig(config.id, { isActive: false });
      const second = await service.syncAll();
      expect(second.removed).toBeGreaterThanOrEqual(1);
      const after = await queues.search.getJobSchedulers(0, 1_000, true);
      expect(after.find((scheduler) => scheduler.key.endsWith(config.id))).toBeUndefined();
    } finally {
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await connection.quit();
    }
  });

  it('computes deterministic jittered start times', () => {
    const now = 1_700_000_000_000;
    const intervalMs = 60 * 60_000;
    const a = computeSchedulerStart('config-a', intervalMs, now);
    const b = computeSchedulerStart('config-a', intervalMs, now);
    const c = computeSchedulerStart('config-b', intervalMs, now);
    expect(a.getTime()).toBe(b.getTime());
    expect(a.getTime()).toBeGreaterThanOrEqual(now + 5_000);
    expect(a.getTime()).toBeLessThanOrEqual(now + Math.min(intervalMs * 0.1, 120_000));
    expect(c.getTime()).toBeGreaterThanOrEqual(now + 5_000);
  });

  it('skips reconciliation when disabled', async () => {
    const searchRepo = createSearchRepo(handle.db);
    const connection = createRedisConnection(TEST_REDIS_URL);
    const queues = createQueues(connection, QUEUE_PREFIX);
    const service = createSchedulerService({
      queue: queues.search,
      searchRepo,
      logger: createLogger({ level: 'error' }),
      enabled: false,
    });
    try {
      const result = await service.syncAll();
      expect(result.skipped).toBe(true);
    } finally {
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await connection.quit();
    }
  });
});

describeIntegration('watchdog: stale runs are recovered with evidence', () => {
  it('fails stuck source runs and finalizes the parent idempotently', async () => {
    const candidateRepo = createCandidateRepo(handle.db);
    const searchRepo = createSearchRepo(handle.db);
    const jobRepo = createJobRepo(handle.db);
    const profile = await candidateRepo.upsertProfile(profileInput);
    const source = await jobRepo.upsertSource({
      key: 'mock-a',
      name: 'mock-a',
      kind: 'api',
      capabilities: {},
    });
    const config = await searchRepo.createConfig({
      candidateId: profile.id,
      name: 'Stuck',
      keywords: [],
      locations: [],
      remote: null,
      sources: ['mock-a'],
      intervalMinutes: 1440,
      mode: 'manual',
    });
    const run = await searchRepo.createRun(config.id, 'corr-stuck');
    await searchRepo.createSourceRun(run.id, source.id, 'corr-stuck');

    const service = createReconciliationService({
      searchRepo,
      logger: createLogger({ level: 'warn' }),
      // Negative timeout: everything created before now+1s is considered stale
      // (deterministic; avoids same-millisecond flakiness).
      timeoutMs: -1_000,
    });
    const result = await service.reconcileStaleRuns();
    expect(result.stale).toBeGreaterThanOrEqual(1);
    expect(result.failedSources).toBeGreaterThanOrEqual(1);

    const updated = await searchRepo.getRun(run.id);
    expect(updated.status).toBe('failed');
    const sources = await searchRepo.listSourceRuns(run.id);
    expect(sources[0]!.run.errorClass).toBe('WatchdogTimeout');

    // Idempotent: second pass finds nothing stale and does not corrupt state.
    const second = await service.reconcileStaleRuns();
    expect(second.stale).toBe(0);
    expect((await searchRepo.getRun(run.id)).status).toBe('failed');
  });
});

describeIntegration('rate limiter: per source+operation with Retry-After penalties', () => {
  it('waits when the window is exhausted and respects penalties', async () => {
    const redis = createRedisConnection(TEST_REDIS_URL);
    // Wide window so both acquires deterministically land in the same window
    // even on slow CI machines; penalty test is independent of the window.
    const limiter = createRedisRateLimiter(redis, createLogger({ level: 'warn' }), {
      windowMs: 2_000,
    });
    try {
      const first = await limiter.acquire('src', 'search', 1);
      expect(first.waitedMs).toBe(0);

      // Same window is exhausted: the limiter must wait until it rolls over.
      const second = await limiter.acquire('src', 'search', 1);
      expect(second.waitedMs).toBeGreaterThan(0);

      await limiter.penalize('src', 'search', 250);
      const penaltyStartedAt = Date.now();
      await limiter.acquire('src', 'search', 10);
      expect(Date.now() - penaltyStartedAt).toBeGreaterThanOrEqual(200);
    } finally {
      await redis.quit();
    }
  });
});

describeIntegration('hard filters: rejections are explained and persisted', () => {
  it('marks filtered jobs as rejected with rule + reason metadata', async () => {
    const candidateRepo = createCandidateRepo(handle.db);
    const searchRepo = createSearchRepo(handle.db);
    const profile = await candidateRepo.upsertProfile(profileInput);
    const config = await searchRepo.createConfig({
      candidateId: profile.id,
      name: 'Filtered',
      keywords: [],
      locations: [],
      remote: null,
      sources: ['mock-a'],
      intervalMinutes: 1440,
      mode: 'manual',
      filters: { excludedCompanies: ['Acme Corp'] },
    });

    const connection = createRedisConnection(TEST_REDIS_URL);
    const queues = createQueues(connection, QUEUE_PREFIX);
    try {
      const job = await queues.search.add(
        'search.run',
        { searchConfigId: config.id, correlationId: uuidv7() },
        { jobId: searchRunJobId(config.id, Date.now()) },
      );
      await job.waitUntilFinished(queueEvents, 40_000);
      const run = await waitForNewFinishedRun(new Set());
      expect(run.status).toBe('completed');
      expect(run.jobsRejected).toBeGreaterThan(0);

      const jobs = await createJobRepo(handle.db).listJobs({ limit: 100, offset: 0, status: 'rejected' });
      expect(jobs.length).toBeGreaterThan(0);
      const metadata = jobs[0]!.job.metadata as { filterDecision?: { rejections: Array<{ rule: string }> } };
      expect(metadata.filterDecision?.rejections[0]?.rule).toBe('excludedCompanies');
    } finally {
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await connection.quit();
    }
  }, 60_000);
});