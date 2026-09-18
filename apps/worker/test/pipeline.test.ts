import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@job-system/shared';
import { uuidv7 } from '@job-system/shared';
import type { CandidateProfileInput } from '@job-system/core';
import { createLogger, type DestinationStream } from '@job-system/observability';
import {
  createCandidateRepo,
  createJobRepo,
  createSearchRepo,
  type DbHandle,
} from '@job-system/database';
import { createTestDb, truncateAll } from '@job-system/database/testing';
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

const QUEUE_PREFIX = `job-system-test-${Date.now()}`;

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

/** Every job-scoped log line must carry both correlationId and jobId. */
function expectJobScoped(entry: Record<string, unknown> | undefined): void {
  expect(entry).toBeDefined();
  expect(typeof entry!['correlationId']).toBe('string');
  expect((entry!['correlationId'] as string).length).toBeGreaterThan(0);
  expect(typeof entry!['jobId']).toBe('string');
  expect((entry!['jobId'] as string).length).toBeGreaterThan(0);
}

let handle: DbHandle;
let runtime: WorkerRuntime;
let queueEvents: QueueEvents;

async function seed(): Promise<string> {
  const candidateRepo = createCandidateRepo(handle.db);
  const searchRepo = createSearchRepo(handle.db);
  const profile = await candidateRepo.upsertProfile(profileInput);
  const config = await searchRepo.createConfig({
    candidateId: profile.id,
    name: 'Mock search',
    keywords: [],
    locations: [],
    remote: null,
    sources: ['mock'],
    intervalMinutes: 1440,
    mode: 'assisted',
  });
  return config.id;
}

async function waitForFinishedRun(timeoutMs = 30_000) {
  const searchRepo = createSearchRepo(handle.db);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await searchRepo.listRuns(1);
    const run = runs[0];
    if (run && run.status !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for the search run to finish');
}

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
  runtime = await startWorkerRuntime(testEnv, createLogger({ level: 'info', stream: captureStream }), {
    queuePrefix: QUEUE_PREFIX,
  });
  queueEvents = new QueueEvents(QUEUE_SEARCH, {
    connection: createRedisConnection(TEST_REDIS_URL),
    prefix: QUEUE_PREFIX,
  });
});

afterAll(async () => {
  await queueEvents.close();
  await runtime.close();
  await handle.pool.end();
});

beforeEach(async () => {
  await truncateAll(handle.db);
  logLines.length = 0;
});

describeIntegration('search pipeline (real Postgres + Redis)', () => {
  it('runs mock search end to end with deterministic L0–L2 dedup', async () => {
    const jobRepo = createJobRepo(handle.db);
    const configId = await seed();
    const connection = createRedisConnection(TEST_REDIS_URL);
    const queues = createQueues(connection, QUEUE_PREFIX);

    try {
      const correlationId = uuidv7();
      const job = await queues.search.add(
        'search.run',
        { searchConfigId: configId, correlationId },
        { jobId: searchRunJobId(configId, Date.now()) },
      );
      await job.waitUntilFinished(queueEvents, 30_000);

      const run = await waitForFinishedRun();
      expect(run.status).toBe('completed');
      expect(run.jobsDiscovered).toBe(10);
      expect(run.jobsNew).toBe(7);
      expect(run.jobsDuplicated).toBe(2);
      expect(run.jobsRejected).toBe(1);

      expect(await jobRepo.countJobs()).toBe(7);

      const jobs = await jobRepo.listJobs({ limit: 100, offset: 0 });
      const reactJob = jobs.find((row) => row.job.title === 'Senior React Developer');
      expect(reactJob).toBeDefined();
      const { job: canonical, listings } = await jobRepo.getJobWithListings(reactJob!.job.id);
      expect(canonical.title).toBe('Senior React Developer');
      expect(listings.length).toBe(3);

      // Internal service/handler logs keep the job trace context, not only
      // the runtime's "job started"/"job completed" lines.
      const finalized = parsedLogs().find((entry) => entry['msg'] === 'search run finalized');
      expectJobScoped(finalized);
      const completed = parsedLogs().find((entry) => entry['msg'] === 'source run completed');
      expectJobScoped(completed);
    } finally {
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await connection.quit();
    }
  });

  it('is idempotent: re-running the same search creates no duplicate jobs', async () => {
    const jobRepo = createJobRepo(handle.db);
    const configId = await seed();
    const connection = createRedisConnection(TEST_REDIS_URL);
    const queues = createQueues(connection, QUEUE_PREFIX);

    try {
      const first = await queues.search.add(
        'search.run',
        { searchConfigId: configId, correlationId: uuidv7() },
        { jobId: searchRunJobId(configId, Date.now()) },
      );
      await first.waitUntilFinished(queueEvents, 30_000);
      const firstRun = await waitForFinishedRun();
      expect(await jobRepo.countJobs()).toBe(7);

      const second = await queues.search.add(
        'search.run',
        { searchConfigId: configId, correlationId: uuidv7() },
        { jobId: searchRunJobId(configId, Date.now() + 1) },
      );
      await second.waitUntilFinished(queueEvents, 30_000);
      const secondRun = await waitForNewFinishedRun(new Set([firstRun.id]));
      expect(secondRun.status).toBe('completed');
      expect(secondRun.jobsNew).toBe(0);
      expect(secondRun.jobsDuplicated).toBe(9);
      expect(secondRun.jobsRejected).toBe(1);
      expect(await jobRepo.countJobs()).toBe(7);
    } finally {
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await connection.quit();
    }
  });

  it('marks the run as failed when the config has no usable sources', async () => {
    const candidateRepo = createCandidateRepo(handle.db);
    const searchRepo = createSearchRepo(handle.db);
    const profile = await candidateRepo.upsertProfile(profileInput);
    const config = await searchRepo.createConfig({
      candidateId: profile.id,
      name: 'Empty',
      keywords: [],
      locations: [],
      remote: null,
      sources: ['missing-source'],
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
      await job.waitUntilFinished(queueEvents, 30_000);
      const run = await waitForFinishedRun();
      expect(run.status).toBe('failed');

      const missingAdapter = parsedLogs().find(
        (entry) => entry['msg'] === 'configured source has no adapter',
      );
      expectJobScoped(missingAdapter);
    } finally {
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await connection.quit();
    }
  });
});

describeIntegration('maintenance smoke job and tracing', () => {
  it('processes a smoke job and logs correlationId + jobId', async () => {
    const connection = createRedisConnection(TEST_REDIS_URL);
    const queues = createQueues(connection, QUEUE_PREFIX);
    const events = new QueueEvents(QUEUE_MAINTENANCE, {
      connection: createRedisConnection(TEST_REDIS_URL),
      prefix: QUEUE_PREFIX,
    });
    try {
      const correlationId = uuidv7();
      const job = await queues.maintenance.add('maintenance.smoke', { correlationId });
      const result = (await job.waitUntilFinished(events, 15_000)) as { ok: boolean };
      expect(result.ok).toBe(true);

      const logs = logLines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      const started = logs.find((entry) => entry['msg'] === 'job started' && entry['name'] === 'maintenance.smoke');
      expect(started).toBeDefined();
      expect(started!['correlationId']).toBe(correlationId);
      expect(typeof started!['jobId']).toBe('string');
    } finally {
      await events.close();
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await connection.quit();
    }
  });
});