import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@job-system/core';
import type { Env } from '@job-system/shared';
import { createLogger } from '@job-system/observability';
import type { DbHandle } from '@job-system/database';
import { createTestDb, truncateAll } from '@job-system/database/testing';
import { LocalStorageAdapter } from '@job-system/storage';
import {
  createArbeitnowAdapter,
  createMockJobSource,
  createRemoteOkAdapter,
  createRemotiveAdapter,
} from '@job-system/job-sources';
import { startWorkerRuntime, type WorkerRuntime } from '@job-system/worker';
import { buildApp } from '../src/app.js';
import { createMaintenanceQueue, createSearchQueue } from '../src/search-queue.js';
import { createRedisConnection } from '../src/redis.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? '';
const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? '';
const hasInfrastructure = TEST_DATABASE_URL.length > 0 && TEST_REDIS_URL.length > 0;
const describeE2e = hasInfrastructure ? describe : describe.skip;

const PASSWORD = 'correct-horse-battery-staple';
// Derived at runtime so no secret-like literal lives in the repository.
const PASSWORD_HASH = sha256Hex(PASSWORD);

function buildEnv(databaseUrl: string, redisUrl: string, storageDir: string): Env {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    API_HOST: '127.0.0.1',
    API_PORT: 0,
    AUTH_PASSWORD_HASH: PASSWORD_HASH,
    AUTH_SECRET: 'e2e-secret-value-1234567890',
    AUTH_COOKIE_SECURE: false,
    DRY_RUN: true,
    AUTO_APPLY_ENABLED: false,
    STORAGE_BACKEND: 'local',
    STORAGE_LOCAL_DIR: storageDir,
    LOG_LEVEL: 'error',
    AI_PROVIDER: 'mock',
    DECISION_PROVIDER: 'mock',
    AI_MONTHLY_BUDGET_USD: 0,
    DEDUP_L3_HIGH_THRESHOLD: 0.92,
    DEDUP_L3_MEDIUM_THRESHOLD: 0.75,
    WATCHDOG_TIMEOUT_MS: 900_000,
    // Scheduled runs are exercised by worker integration tests; the E2E keeps
    // manual runs for determinism (no background runs mid-test).
    SCHEDULER_ENABLED: false,
  };
}

/** Local HTTP server serving recorded fixtures to the real adapters (no internet). */
const CRAFTED_REMOTEOK_JOB = {
  id: 900001,
  slug: 'acme-remote-platform-engineer',
  company: 'Acme Remote',
  position: 'Platform Engineer (Fixture)',
  description: '<p>Operate platform systems.</p>',
  location: 'Remote',
  salary_min: 0,
  salary_max: 0,
  url: 'https://remoteok.com/remote-jobs/900001',
  apply_url: 'https://boards.greenhouse.io/acme/jobs/42',
  date: '2026-01-10T00:00:00Z',
  tags: ['platform'],
};

function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const fixturesDir = resolve(process.cwd(), '../../packages/job-sources/test/fixtures');
  const remotive = JSON.parse(readFileSync(join(fixturesDir, 'remotive/search-page.json'), 'utf8'));
  const arbeitnow = JSON.parse(readFileSync(join(fixturesDir, 'arbeitnow/search-page.json'), 'utf8'));
  const remoteokRaw = JSON.parse(readFileSync(join(fixturesDir, 'remoteok/search-page.json'), 'utf8')) as unknown[];
  const remoteok = [...remoteokRaw, CRAFTED_REMOTEOK_JOB];

  const server = createServer((request, response) => {
    const url = request.url ?? '';
    response.setHeader('content-type', 'application/json');
    if (url.startsWith('/api/remote-jobs')) response.end(JSON.stringify(remotive));
    else if (url.startsWith('/api/job-board-api')) response.end(JSON.stringify(arbeitnow));
    else if (url.startsWith('/api')) response.end(JSON.stringify(remoteok));
    else {
      response.statusCode = 404;
      response.end('{}');
    }
  });

  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolvePromise({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function multipart(
  filename: string,
  content: string,
  contentType = 'text/plain',
): { payload: Buffer; contentType: string } {
  const boundary = `----jobsystem${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.from(content), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

const QUEUE_PREFIX = `job-system-e2e-${Date.now()}`;

let handle: DbHandle;
let app: FastifyInstance;
let runtime: WorkerRuntime;
let queue: ReturnType<typeof createSearchQueue>;
let maintenanceQueue: ReturnType<typeof createMaintenanceQueue>;
let redis: ReturnType<typeof createRedisConnection>;
let storageDir: string;
let fixtureServer: Server;
let cookie = '';

function withCookie(headers: Record<string, string> = {}): Record<string, string> {
  return { ...headers, cookie };
}

async function login(): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const session = response.cookies.find((entry) => entry.name === 'session');
  expect(session).toBeDefined();
  cookie = `session=${session!.value}`;
}

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'job-system-e2e-storage-'));
  handle = await createTestDb();
  const env = buildEnv(TEST_DATABASE_URL, TEST_REDIS_URL, storageDir);
  const fixtures = await startFixtureServer();
  fixtureServer = fixtures.server;
  runtime = await startWorkerRuntime(env, createLogger({ level: 'error' }), {
    queuePrefix: QUEUE_PREFIX,
    adapters: [
      createMockJobSource(),
      createRemotiveAdapter({ baseUrl: fixtures.baseUrl }),
      createArbeitnowAdapter({ baseUrl: fixtures.baseUrl }),
      createRemoteOkAdapter({ baseUrl: fixtures.baseUrl }),
    ],
  });
  redis = createRedisConnection(TEST_REDIS_URL);
  queue = createSearchQueue(redis, QUEUE_PREFIX);
  maintenanceQueue = createMaintenanceQueue(redis, QUEUE_PREFIX);
  const storage = new LocalStorageAdapter(storageDir);
  app = await buildApp({
    env,
    logger: createLogger({ level: 'error' }),
    dbHandle: handle,
    redis,
    storage,
    searchQueue: queue,
    maintenanceQueue,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await queue.close();
  await maintenanceQueue.close();
  await redis.quit();
  await runtime.close();
  await handle.pool.end();
  await rm(storageDir, { recursive: true, force: true });
  await new Promise((resolvePromise) => fixtureServer.close(resolvePromise));
});

beforeEach(async () => {
  await truncateAll(handle.db);
  cookie = '';
});

describeE2e('Phase 1 foundation E2E (API + worker + Postgres + Redis)', () => {
  it('rejects invalid credentials and unauthenticated requests', async () => {
    const badLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { password: 'wrong-password' },
    });
    expect(badLogin.statusCode).toBe(401);
    expect(badLogin.json()).toMatchObject({ code: 'UNAUTHORIZED' });

    const unauth = await app.inject({ method: 'GET', url: '/v1/profile' });
    expect(unauth.statusCode).toBe(401);
  });

  it('runs the full foundation flow: profile → CV → version → mock search → jobs', async () => {
    await login();

    // 1. profile
    const profileResponse = await app.inject({
      method: 'PUT',
      url: '/v1/profile',
      headers: withCookie(),
      payload: {
        fullName: 'Ada Lovelace',
        email: 'ada@example.com',
        headline: 'Software Engineer',
        remotePreference: ['remote'],
      },
    });
    expect(profileResponse.statusCode).toBe(200);

    const experienceResponse = await app.inject({
      method: 'POST',
      url: '/v1/profile/experiences',
      headers: withCookie(),
      payload: {
        company: 'Analytical Engines',
        title: 'Engineer',
        startDate: '2020-01-01',
        description: 'Built engines',
        skills: ['typescript'],
      },
    });
    expect(experienceResponse.statusCode).toBe(201);

    const skillResponse = await app.inject({
      method: 'POST',
      url: '/v1/profile/skills',
      headers: withCookie(),
      payload: { skillName: 'TypeScript', level: 'expert', years: 6 },
    });
    expect(skillResponse.statusCode).toBe(201);

    // 2. resume + immutable versions
    const resumeResponse = await app.inject({
      method: 'POST',
      url: '/v1/resumes',
      headers: withCookie(),
      payload: { name: 'Engineering CV', category: 'software-engineering', isDefault: true },
    });
    expect(resumeResponse.statusCode).toBe(201);
    const resumeId = (resumeResponse.json() as { id: string }).id;

    const firstFile = multipart('cv-v1.txt', 'CV version one');
    const v1Response = await app.inject({
      method: 'POST',
      url: `/v1/resumes/${resumeId}/versions`,
      headers: withCookie({ 'content-type': firstFile.contentType }),
      payload: firstFile.payload,
    });
    expect(v1Response.statusCode).toBe(201);
    const v1 = v1Response.json() as { id: string; versionNumber: number; fileHash: string };

    const secondFile = multipart('cv-v2.txt', 'CV version two');
    const v2Response = await app.inject({
      method: 'POST',
      url: `/v1/resumes/${resumeId}/versions`,
      headers: withCookie({ 'content-type': secondFile.contentType }),
      payload: secondFile.payload,
    });
    expect(v2Response.statusCode).toBe(201);
    const v2 = v2Response.json() as { versionNumber: number };

    expect(v1.versionNumber).toBe(1);
    expect(v2.versionNumber).toBe(2);

    const versionsResponse = await app.inject({
      method: 'GET',
      url: `/v1/resumes/${resumeId}/versions`,
      headers: withCookie(),
    });
    const versions = versionsResponse.json() as { items: Array<{ id: string; fileHash: string }> };
    expect(versions.items).toHaveLength(2);
    expect(versions.items.find((version) => version.id === v1.id)?.fileHash).toBe(v1.fileHash);

    // 3. search config + async run
    const configResponse = await app.inject({
      method: 'POST',
      url: '/v1/search-configs',
      headers: withCookie(),
      payload: { name: 'Mock search', sources: ['mock'], keywords: [] },
    });
    expect(configResponse.statusCode).toBe(201);
    const configId = (configResponse.json() as { id: string }).id;

    const runResponse = await app.inject({
      method: 'POST',
      url: `/v1/search-configs/${configId}/run`,
      headers: withCookie(),
    });
    expect(runResponse.statusCode).toBe(202);
    const { jobId } = runResponse.json() as { jobId: string };
    expect(await queue.getJob(jobId)).toBeTruthy();

    // 4. wait for the worker to finish the run (via public API)
    const deadline = Date.now() + 30_000;
    let runStatus = 'running';
    let counters = { jobsDiscovered: 0, jobsNew: 0, jobsDuplicated: 0, jobsRejected: 0 };
    while (Date.now() < deadline && runStatus === 'running') {
      const runsResponse = await app.inject({
        method: 'GET',
        url: '/v1/search-runs?limit=1',
        headers: withCookie(),
      });
      const runs = runsResponse.json() as {
        items: Array<{
          status: string;
          jobsDiscovered: number;
          jobsNew: number;
          jobsDuplicated: number;
          jobsRejected: number;
        }>;
      };
      const run = runs.items[0];
      if (run) {
        runStatus = run.status;
        counters = run;
      }
      if (runStatus === 'running') await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(runStatus).toBe('completed');
    expect(counters.jobsDiscovered).toBe(10);
    expect(counters.jobsNew).toBe(7);
    expect(counters.jobsDuplicated).toBe(2);
    expect(counters.jobsRejected).toBe(1);

    // 5. jobs are exposed through the API
    const jobsResponse = await app.inject({ method: 'GET', url: '/v1/jobs', headers: withCookie() });
    expect(jobsResponse.statusCode).toBe(200);
    const jobs = jobsResponse.json() as { items: Array<{ id: string; title: string }> };
    expect(jobs.items).toHaveLength(7);
    const reactJob = jobs.items.find((job) => job.title === 'Senior React Developer');
    expect(reactJob).toBeDefined();

    const jobDetailResponse = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${reactJob!.id}`,
      headers: withCookie(),
    });
    expect(jobDetailResponse.statusCode).toBe(200);
    const detail = jobDetailResponse.json() as {
      listings: unknown[];
      applicationTarget: { key: string; kind: string } | null;
    };
    expect(detail.listings.length).toBeGreaterThanOrEqual(2);
    expect(detail.applicationTarget?.key).toBe('greenhouse');
  });

  it('is idempotent across two runs (no duplicate jobs)', async () => {
    await login();
    await app.inject({
      method: 'PUT',
      url: '/v1/profile',
      headers: withCookie(),
      payload: { fullName: 'Ada Lovelace', email: 'ada@example.com' },
    });
    const configResponse = await app.inject({
      method: 'POST',
      url: '/v1/search-configs',
      headers: withCookie(),
      payload: { name: 'Mock search', sources: ['mock'], keywords: [] },
    });
    const configId = (configResponse.json() as { id: string }).id;

    const seenRunIds = new Set<string>();

    async function waitForCompletedNewRun(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const runsResponse = await app.inject({
          method: 'GET',
          url: '/v1/search-runs?limit=100',
          headers: withCookie(),
        });
        const runs = runsResponse.json() as {
          items: Array<{
            id: string;
            status: string;
            jobsNew: number;
            jobsDuplicated: number;
            jobsRejected: number;
          }>;
        };
        for (const run of runs.items) seenRunIds.add(run.id);
        const fresh = runs.items.find((run) => !seenRunIdsBefore.has(run.id));
        if (fresh && fresh.status !== 'running') return fresh;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error('Timed out waiting for a new completed run');
    }

    const seenRunIdsBefore = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await app.inject({ method: 'GET', url: '/v1/search-runs?limit=100', headers: withCookie() });
      for (const run of (before.json() as { items: Array<{ id: string }> }).items) {
        seenRunIdsBefore.add(run.id);
      }
      await app.inject({
        method: 'POST',
        url: `/v1/search-configs/${configId}/run`,
        headers: withCookie(),
      });
      const run = await waitForCompletedNewRun();
      expect(run.status).toBe('completed');
      seenRunIds.add(run.id);
      seenRunIdsBefore.add(run.id);
    }

    const jobsResponse = await app.inject({ method: 'GET', url: '/v1/jobs?limit=100', headers: withCookie() });
    const jobs = jobsResponse.json() as { items: unknown[] };
    expect(jobs.items).toHaveLength(7);

    const runsResponse = await app.inject({ method: 'GET', url: '/v1/search-runs?limit=100', headers: withCookie() });
    const runs = runsResponse.json() as {
      items: Array<{ id: string; jobsNew: number; jobsDuplicated: number }>;
    };
    const latest = runs.items.find((run) => seenRunIds.has(run.id) && run.jobsNew === 0);
    expect(latest).toBeDefined();
    expect(latest!.jobsDuplicated).toBe(9);
  });

  it('discovers via a real adapter (local fixture server) and resolves the ATS target', async () => {
    await login();
    await app.inject({
      method: 'PUT',
      url: '/v1/profile',
      headers: withCookie(),
      payload: { fullName: 'Ada Lovelace', email: 'ada@example.com' },
    });

    const configResponse = await app.inject({
      method: 'POST',
      url: '/v1/search-configs',
      headers: withCookie(),
      payload: { name: 'Fixture discovery', sources: ['remoteok'], keywords: [], intervalMinutes: 60 },
    });
    expect(configResponse.statusCode).toBe(201);
    const configId = (configResponse.json() as { id: string }).id;

    // Scheduler sync is requested via the maintenance queue (SCHEDULER_ENABLED
    // is false in this suite, so the handler logs the skip; the sync job itself
    // must have been consumed without leaving the config without a scheduler).
    const syncJobs = await maintenanceQueue.getJobs(['waiting', 'active', 'completed'], 0, 50);
    expect(syncJobs.some((job) => job.name === 'scheduler.sync')).toBe(true);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/v1/search-configs/${configId}/run`,
      headers: withCookie(),
    });
    expect(runResponse.statusCode).toBe(202);

    const deadline = Date.now() + 30_000;
    let run: { id: string; status: string; jobsDiscovered: number } | null = null;
    while (Date.now() < deadline) {
      const runsResponse = await app.inject({
        method: 'GET',
        url: '/v1/search-runs?limit=1',
        headers: withCookie(),
      });
      const runs = runsResponse.json() as {
        items: Array<{ id: string; status: string; jobsDiscovered: number }>;
      };
      const candidate = runs.items[0] ?? null;
      if (candidate && candidate.status !== 'running') {
        run = candidate;
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(run!.jobsDiscovered).toBeGreaterThan(0);

    // Discovery source and submission target stay distinct (ADR-013).
    const runDetail = await app.inject({
      method: 'GET',
      url: `/v1/search-runs/${run!.id}`,
      headers: withCookie(),
    });
    const sources = (runDetail.json() as { sources: Array<{ sourceKey: string; status: string }> }).sources;
    expect(sources).toHaveLength(1);
    expect(sources[0]!.sourceKey).toBe('remoteok');
    expect(sources[0]!.status).toBe('completed');

    const jobsResponse = await app.inject({
      method: 'GET',
      url: '/v1/jobs?limit=100&status=active',
      headers: withCookie(),
    });
    const jobs = jobsResponse.json() as { items: Array<{ id: string; title: string }> };
    const fixtureJob = jobs.items.find((job) => job.title === 'Platform Engineer (Fixture)');
    expect(fixtureJob).toBeDefined();

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${fixtureJob!.id}`,
      headers: withCookie(),
    });
    const detail = detailResponse.json() as {
      applicationTarget: { key: string; platform: string } | null;
      listings: Array<{ sourceKey: string }>;
    };
    expect(detail.applicationTarget?.key).toBe('greenhouse-acme');
    expect(detail.listings.map((entry) => entry.sourceKey)).toContain('remoteok');

    // Source registry exposes the reviewed policy notes for real sources.
    const sourcesResponse = await app.inject({ method: 'GET', url: '/v1/sources', headers: withCookie() });
    const sourceRows = (sourcesResponse.json() as { items: Array<{ key: string; policyNotes: string | null }> }).items;
    const remoteok = sourceRows.find((row) => row.key === 'remoteok');
    expect(remoteok?.policyNotes).toContain('reviewed:');
  });
});