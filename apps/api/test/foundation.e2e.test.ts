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
import { createAuditRepo, createMatchingRepo } from '@job-system/database';
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
import { createMaintenanceQueue, createMatchQueue, createSearchQueue, createDocumentsQueue } from '../src/search-queue.js';
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
    TARGET_ENRICHMENT_MAX_PER_RUN: 25,
    EMBEDDING_DIMENSIONS: 1536,
    EMBEDDING_SPACE_VERSION: 'v1',
    EMBEDDING_PROVIDER: 'mock',
    APPLICATION_PREPARATION_POLICY_VERSION: 'application-prep-v1',
    REAPPLICATION_COOLDOWN_DAYS: 30,
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

/** Offer whose target is only discoverable by following redirects (enrichment). */
function craftedRedirectJob(baseUrl: string): Record<string, unknown> {
  return {
    id: 900002,
    slug: 'acme-redirect-engineer',
    company: 'Acme Remote',
    position: 'Redirect Engineer (Fixture)',
    description: '<p>Redirect-only application flow.</p>',
    location: 'Remote',
    url: `${baseUrl}/redirect/step1`,
    date: '2026-01-11T00:00:00Z',
    tags: ['platform'],
  };
}

function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const fixturesDir = resolve(process.cwd(), '../../packages/job-sources/test/fixtures');
  const remotive = JSON.parse(readFileSync(join(fixturesDir, 'remotive/search-page.json'), 'utf8'));
  const arbeitnow = JSON.parse(readFileSync(join(fixturesDir, 'arbeitnow/search-page.json'), 'utf8'));
  const remoteokRaw = JSON.parse(readFileSync(join(fixturesDir, 'remoteok/search-page.json'), 'utf8')) as unknown[];

  let base = '';
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    if (url.startsWith('/redirect/step1')) {
      response.statusCode = 302;
      response.setHeader('location', `${base}/redirect/step2`);
      response.end();
      return;
    }
    if (url.startsWith('/redirect/step2')) {
      response.statusCode = 302;
      response.setHeader('location', 'https://boards.greenhouse.io/acme/jobs/777');
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (url.startsWith('/api/remote-jobs')) response.end(JSON.stringify(remotive));
    else if (url.startsWith('/api/job-board-api')) response.end(JSON.stringify(arbeitnow));
    else if (url.startsWith('/api')) {
      response.end(JSON.stringify([...remoteokRaw, CRAFTED_REMOTEOK_JOB, craftedRedirectJob(base)]));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });

  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolvePromise({ server, baseUrl: base });
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
let matchQueue: ReturnType<typeof createMatchQueue>;
let documentsQueue: ReturnType<typeof createDocumentsQueue>;
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
  matchQueue = createMatchQueue(redis, QUEUE_PREFIX);
  documentsQueue = createDocumentsQueue(redis, QUEUE_PREFIX);
  maintenanceQueue = createMaintenanceQueue(redis, QUEUE_PREFIX);
  const storage = new LocalStorageAdapter(storageDir);
  app = await buildApp({
    env,
    logger: createLogger({ level: 'error' }),
    dbHandle: handle,
    redis,
    storage,
    searchQueue: queue,
    matchQueue,
    documentsQueue,
    maintenanceQueue,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await queue.close();
  await matchQueue.close();
  await documentsQueue.close();
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
  // The worker bootstraps the active space once at startup; truncation between
  // tests removes it, so the same deterministic bootstrap runs again here.
  await createMatchingRepo(handle.db).ensureEmbeddingSpace({
    key: 'mock-deterministic-v1-1536-v1',
    provider: 'mock',
    model: 'mock-deterministic-v1',
    dimensions: 1536,
    distanceMetric: 'cosine',
    version: 'v1',
  });
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

    // 6. Phase 3: discovery auto-enqueued matching; ranking is ordered by score.
    interface MatchItem {
      match: {
        id: string;
        overallScore: string;
        isCurrent: boolean;
        reasons: string[];
        missingRequirements: string[];
        scoreBreakdown: { signals: Record<string, { present: boolean }> };
      };
      job: { id: string; title: string };
      recommendedResume: { id: string; name: string } | null;
    }
    async function loadMatches(): Promise<MatchItem[]> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/matches?limit=100',
          headers: withCookie(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as { items: MatchItem[]; total: number };
        if (body.items.length >= 7) return body.items;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
      throw new Error('Timed out waiting for current matches');
    }
    const matches = await loadMatches();
    expect(matches.length).toBe(7);
    for (let index = 1; index < matches.length; index += 1) {
      expect(Number(matches[index - 1]!.match.overallScore)).toBeGreaterThanOrEqual(
        Number(matches[index]!.match.overallScore),
      );
    }
    for (const item of matches) {
      expect(item.match.isCurrent).toBe(true);
      expect(item.match.reasons.length).toBeGreaterThan(0);
      expect(Object.keys(item.match.scoreBreakdown.signals)).toHaveLength(8);
    }

    const best = matches[0]!;
    const currentResponse = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${best.job.id}/match`,
      headers: withCookie(),
    });
    expect(currentResponse.statusCode).toBe(200);
    const current = currentResponse.json() as { match: { id: string } };
    expect(current.match.id).toBe(best.match.id);

    // 7. Recompute is idempotent for the same identity (same row, no duplicate).
    const enqueueResponse = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${best.job.id}/match`,
      headers: withCookie(),
    });
    expect(enqueueResponse.statusCode).toBe(202);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
    const historyAfterRecompute = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${best.job.id}/matches`,
      headers: withCookie(),
    });
    expect((historyAfterRecompute.json() as { items: unknown[] }).items).toHaveLength(1);

    // 8. Changing a relevant profile field produces a new current match and
    //    keeps the previous one as history.
    const addSkillResponse = await app.inject({
      method: 'POST',
      url: '/v1/profile/skills',
      headers: withCookie(),
      payload: { skillName: 'Kubernetes', level: 'advanced', years: 3 },
    });
    expect(addSkillResponse.statusCode).toBe(201);
    await app.inject({
      method: 'POST',
      url: `/v1/jobs/${best.job.id}/match`,
      headers: withCookie(),
    });
    let history: Array<{ id: string; isCurrent: boolean }> = [];
    const historyDeadline = Date.now() + 30_000;
    while (Date.now() < historyDeadline) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${best.job.id}/matches`,
        headers: withCookie(),
      });
      history = (response.json() as { items: Array<{ id: string; isCurrent: boolean }> }).items;
      if (history.length === 2) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    expect(history).toHaveLength(2);
    expect(history.filter((row) => row.isCurrent)).toHaveLength(1);
    expect(history[0]!.isCurrent).toBe(true);
    expect(history[0]!.id).not.toBe(best.match.id);

    // 9. Embedding spaces are exposed; exactly one is active.
    const spacesResponse = await app.inject({
      method: 'GET',
      url: '/v1/embedding-spaces',
      headers: withCookie(),
    });
    expect(spacesResponse.statusCode).toBe(200);
    const spaces = (spacesResponse.json() as { items: Array<{ status: string; provider: string }> })
      .items;
    expect(spaces.length).toBeGreaterThanOrEqual(1);
    expect(spaces.filter((space) => space.status === 'active')).toHaveLength(1);
    expect(spaces[0]!.provider).toBe('mock');

    // 10. Activating a space incompatible with the runtime is refused (409),
    //     and the current active space stays untouched.
    const incompatible = await createMatchingRepo(handle.db).ensureEmbeddingSpace({
      key: 'mock-incompatible-1536-v9',
      provider: 'mock',
      model: 'mock-other-model',
      dimensions: 1536,
      distanceMetric: 'cosine',
      version: 'v9',
    });
    expect(incompatible.status).toBe('inactive');
    const refused = await app.inject({
      method: 'POST',
      url: `/v1/embedding-spaces/${incompatible.id}/activate`,
      headers: withCookie(),
    });
    expect(refused.statusCode).toBe(409);
    const refusedBody = refused.json() as { code: string; details?: { mismatches?: string[] } };
    expect(refusedBody.code).toBe('CONFLICT');
    expect(refusedBody.details?.mismatches?.some((entry) => entry.includes('model'))).toBe(true);
    const spacesAfter = await app.inject({
      method: 'GET',
      url: '/v1/embedding-spaces',
      headers: withCookie(),
    });
    const activeAfter = (
      spacesAfter.json() as { items: Array<{ status: string; model: string }> }
    ).items.filter((space) => space.status === 'active');
    expect(activeAfter).toHaveLength(1);
    expect(activeAfter[0]!.model).toBe('mock-deterministic-v1');
  }, 120_000);

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

    // Redirect-only offer: target resolved by enrichment (follow redirect chain
    // without ever fetching the ATS host, which is not served locally).
    const redirectJob = jobs.items.find((job) => job.title === 'Redirect Engineer (Fixture)');
    expect(redirectJob).toBeDefined();
    const redirectDetailResponse = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${redirectJob!.id}`,
      headers: withCookie(),
    });
    const redirectDetail = redirectDetailResponse.json() as {
      applicationTarget: { key: string } | null;
    };
    expect(redirectDetail.applicationTarget?.key).toBe('greenhouse-acme');

    // Auto-detected targets are blocked pending policy review; authorizing is
    // an explicit audited action.
    const targetsResponse = await app.inject({
      method: 'GET',
      url: '/v1/application-targets',
      headers: withCookie(),
    });
    const targets = (targetsResponse.json() as {
      items: Array<{ key: string; status: string; policyNotes: string | null }>;
    }).items;
    const greenhouse = targets.find((target) => target.key === 'greenhouse-acme');
    expect(greenhouse?.status).toBe('blocked');
    expect(greenhouse?.policyNotes).toContain('pending separate platform policy review');

    // No policy review → activation is denied with a typed error.
    const denied = await app.inject({
      method: 'PATCH',
      url: '/v1/application-targets/greenhouse-acme',
      headers: withCookie(),
      payload: { status: 'active' },
    });
    expect(denied.statusCode).toBe(422);
    expect((denied.json() as { code: string }).code).toBe('POLICY_DENIED');

    // Explicit review activates the target and persists the evidence.
    const reviewNotes =
      'E2E policy review fixture: provider terms reviewed for personal discovery.';
    const authorize = await app.inject({
      method: 'PATCH',
      url: '/v1/application-targets/greenhouse-acme',
      headers: withCookie(),
      payload: { status: 'active', policyReview: { notes: reviewNotes } },
    });
    expect(authorize.statusCode).toBe(200);
    const authorized = authorize.json() as {
      id: string;
      status: string;
      reviewedBy: string | null;
      reviewedAt: string | null;
      policyNotes: string | null;
    };
    expect(authorized.status).toBe('active');
    expect(authorized.reviewedBy).toBe('user');
    expect(authorized.reviewedAt).toBeTruthy();
    expect(authorized.policyNotes).toContain('Review completed');
    expect(authorized.policyNotes).toContain(reviewNotes);

    const audits = await createAuditRepo(handle.db).listForEntity(
      'application_target',
      authorized.id,
    );
    expect(audits.some((entry) => entry.action === 'application_target.policy_reviewed')).toBe(true);

    // Pause → reactivate reuses the existing valid review (restrictive
    // transitions never demand a new one).
    const paused = await app.inject({
      method: 'PATCH',
      url: '/v1/application-targets/greenhouse-acme',
      headers: withCookie(),
      payload: { status: 'paused' },
    });
    expect(paused.statusCode).toBe(200);
    expect((paused.json() as { status: string }).status).toBe('paused');

    const reactivated = await app.inject({
      method: 'PATCH',
      url: '/v1/application-targets/greenhouse-acme',
      headers: withCookie(),
      payload: { status: 'active' },
    });
    expect(reactivated.statusCode).toBe(200);
    const reactivatedBody = reactivated.json() as {
      status: string;
      policyNotes: string | null;
      reviewedAt: string | null;
    };
    expect(reactivatedBody.status).toBe('active');
    expect(reactivatedBody.policyNotes).toBe(authorized.policyNotes);
    expect(reactivatedBody.reviewedAt).toBe(authorized.reviewedAt);

    // Source registry exposes the reviewed policy notes for real sources.
    const sourcesResponse = await app.inject({ method: 'GET', url: '/v1/sources', headers: withCookie() });
    const sourceRows = (sourcesResponse.json() as { items: Array<{ key: string; policyNotes: string | null }> }).items;
    const remoteok = sourceRows.find((row) => row.key === 'remoteok');
    expect(remoteok?.policyNotes).toContain('reviewed:');
  }, 90_000);

  it('prepares a Phase 4 application: documents, claims, answers, timeline, archive (no submit)', async () => {
    await login();

    // 1. Candidate with structured facts (skill years are the only valid source
    //    for a skill-specific years claim).
    await app.inject({
      method: 'PUT',
      url: '/v1/profile',
      headers: withCookie(),
      payload: {
        fullName: 'Ada Lovelace',
        email: 'ada@example.com',
        headline: 'Software Engineer',
        remotePreference: ['remote'],
        employmentTypes: ['full_time'],
        allowedCountries: ['Spain'],
        relocation: false,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/profile/skills',
      headers: withCookie(),
      payload: { skillName: 'React', level: 'expert', years: 5 },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/profile/experiences',
      headers: withCookie(),
      payload: {
        company: 'Acme Corp',
        title: 'Senior Developer',
        startDate: '2018-01-01',
        endDate: '2024-01-01',
        description: 'Built internal tools',
        skills: ['React'],
      },
    });
    const resumeResponse = await app.inject({
      method: 'POST',
      url: '/v1/resumes',
      headers: withCookie(),
      payload: { name: 'Engineering CV', category: 'software-engineering', isDefault: true },
    });
    const resumeId = (resumeResponse.json() as { id: string }).id;
    const file = multipart('cv-v1.txt', 'CV version one');
    await app.inject({
      method: 'POST',
      url: `/v1/resumes/${resumeId}/versions`,
      headers: withCookie({ 'content-type': file.contentType }),
      payload: file.payload,
    });

    // 2. Mock discovery → matching.
    const configResponse = await app.inject({
      method: 'POST',
      url: '/v1/search-configs',
      headers: withCookie(),
      payload: { name: 'Mock search', sources: ['mock'], keywords: [], intervalMinutes: 60 },
    });
    const configId = (configResponse.json() as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: `/v1/search-configs/${configId}/run`,
      headers: withCookie(),
    });
    const runDeadline = Date.now() + 30_000;
    let runStatus = 'running';
    while (Date.now() < runDeadline && runStatus === 'running') {
      const runs = await app.inject({
        method: 'GET',
        url: '/v1/search-runs?limit=1',
        headers: withCookie(),
      });
      runStatus = (runs.json() as { items: Array<{ status: string }> }).items[0]?.status ?? 'running';
      if (runStatus === 'running') await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    expect(runStatus).toBe('completed');

    await app.inject({ method: 'POST', url: '/v1/matches/recompute', headers: withCookie(), payload: {} });
    const matchDeadline = Date.now() + 30_000;
    let match: { match: { id: string; recommendedResumeId: string | null } } | null = null;
    while (Date.now() < matchDeadline) {
      const matches = await app.inject({
        method: 'GET',
        url: '/v1/matches?limit=100',
        headers: withCookie(),
      });
      const items = (matches.json() as { items: Array<{ match: { id: string; recommendedResumeId: string | null } }> }).items;
      match = items.find((item) => item.match.recommendedResumeId !== null) ?? null;
      if (match) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
    }
    expect(match).not.toBeNull();

    // 3. Create from match: idempotent, frozen score, AUTO denied.
    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/applications',
      headers: withCookie(),
      payload: { matchId: match!.match.id, mode: 'assisted' },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json() as {
      application: { id: string; status: string; scoreAtCreation: number; preparationSnapshot: unknown };
      created: boolean;
    };
    expect(created.created).toBe(true);
    expect(created.application.status).toBe('SHORTLISTED');
    expect(created.application.preparationSnapshot).toBeNull();

    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/applications',
      headers: withCookie(),
      payload: { matchId: match!.match.id, mode: 'assisted' },
    });
    expect(duplicate.statusCode).toBe(200);
    expect((duplicate.json() as { application: { id: string } }).application.id).toBe(
      created.application.id,
    );

    const auto = await app.inject({
      method: 'POST',
      url: '/v1/applications',
      headers: withCookie(),
      payload: { matchId: match!.match.id, mode: 'auto' },
    });
    expect(auto.statusCode).toBe(422);
    expect((auto.json() as { code: string }).code).toBe('POLICY_DENIED');

    // 4. Prepare (202 + worker) and poll the detail.
    const prepareResponse = await app.inject({
      method: 'POST',
      url: `/v1/applications/${created.application.id}/prepare`,
      headers: withCookie(),
    });
    expect(prepareResponse.statusCode).toBe(202);
    expect((prepareResponse.json() as { queueJobId: string }).queueJobId).toContain(
      'prepare-',
    );

    const prepareDeadline = Date.now() + 30_000;
    type Phase4Detail = {
      application: { status: string; preparationSnapshot: unknown; resumeVersionId: string | null };
      documents: Array<{
        id: string;
        kind: string;
        contentHash: string;
        verification: { status: string };
        claims: Array<{ claim: string; kind: string; verified: string; sourceRefs: unknown[] }>;
        generatedBy: { provider: string; promptVersion: string };
      }>;
      answers: Array<{ id: string; approved: boolean }>;
      events: Array<{ type: string; fromStatus: string | null; toStatus: string | null }>;
      blockers: Array<{ code: string }>;
    };
    let detail: Phase4Detail | null = null;
    while (Date.now() < prepareDeadline) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/applications/${created.application.id}`,
        headers: withCookie(),
      });
      const candidate = response.json() as Phase4Detail;
      if (candidate.documents.length >= 2) {
        detail = candidate;
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
    }
    expect(detail).not.toBeNull();
    expect(detail!.application.status).toBe('PREPARING');
    expect(detail!.application.preparationSnapshot).toBeNull();
    expect(detail!.application.resumeVersionId).not.toBeNull();
    const kinds = detail!.documents.map((document) => document.kind).sort();
    expect(kinds).toEqual(['cover_letter', 'resume_variant']);
    const variant = detail!.documents.find((document) => document.kind === 'resume_variant')!;
    expect(variant.verification.status).toBe('verified');
    expect(variant.generatedBy.provider).toBe('deterministic');
    expect(variant.claims.length).toBeGreaterThan(0);
    expect(variant.claims.every((claim) => claim.verified === 'verified')).toBe(true);
    expect(variant.claims[0]!.sourceRefs.length).toBeGreaterThan(0);
    const timeline = detail!.events.map((event) => `${event.fromStatus}->${event.toStatus}`);
    expect(timeline).toContain('SHORTLISTED->PREPARING');
    expect(detail!.events.some((event) => event.type === 'application.documents_prepared')).toBe(true);
    expect(detail!.blockers.some((blocker) => blocker.code === 'rejected_claims')).toBe(false);

    // 5. Answers: user answer with a verified claim, then bank reuse.
    const answerResponse = await app.inject({
      method: 'PUT',
      url: `/v1/applications/${created.application.id}/answers`,
      headers: withCookie(),
      payload: {
        questionText: 'How many years of React do you have?',
        answerText: 'Five years of React.',
        approved: true,
        claims: [
          { claim: '5 years React', kind: 'years_experience', value: { years: 5, skill: 'React' } },
        ],
      },
    });
    expect(answerResponse.statusCode).toBe(201);
    const answer = answerResponse.json() as {
      id: string;
      approved: boolean;
      requiresHumanInput: boolean;
      verification: { status: string };
    };
    expect(answer.approved).toBe(true);
    expect(answer.requiresHumanInput).toBe(false);
    expect(answer.verification.status).toBe('verified');

    const resolved = await app.inject({
      method: 'POST',
      url: `/v1/applications/${created.application.id}/answers/resolve`,
      headers: withCookie(),
      payload: { questionText: 'How many years of React do you have?' },
    });
    expect(resolved.statusCode).toBe(201);
    expect((resolved.json() as { action: string }).action).toBe('reuse');

    const answersList = await app.inject({
      method: 'GET',
      url: `/v1/applications/${created.application.id}/answers`,
      headers: withCookie(),
    });
    expect((answersList.json() as { items: unknown[] }).items).toHaveLength(1);

    // P2: a user answer with an unverifiable claim is never approved and stays
    // visible as a blocker (only fully verified facts are safe to reuse).
    const unverifiableAnswer = await app.inject({
      method: 'PUT',
      url: `/v1/applications/${created.application.id}/answers`,
      headers: withCookie(),
      payload: {
        questionText: 'What is your seniority level?',
        answerText: 'Senior engineer.',
        approved: true,
        claims: [{ claim: 'Senior engineer', kind: 'seniority', value: { level: 'senior' } }],
      },
    });
    expect(unverifiableAnswer.statusCode).toBe(201);
    const blockedAnswer = unverifiableAnswer.json() as {
      approved: boolean;
      requiresHumanInput: boolean;
      verification: { status: string };
    };
    expect(blockedAnswer.approved).toBe(false);
    expect(blockedAnswer.requiresHumanInput).toBe(true);
    expect(blockedAnswer.verification.status).toBe('unverifiable');

    const detailWithBlocker = await app.inject({
      method: 'GET',
      url: `/v1/applications/${created.application.id}`,
      headers: withCookie(),
    });
    const blockerCodes = (detailWithBlocker.json() as { blockers: Array<{ code: string }> }).blockers.map(
      (blocker) => blocker.code,
    );
    expect(blockerCodes).toContain('stale_answer');

    // 6. No submit/reconcile endpoints exist in Phase 4; READY_FOR_REVIEW is unreachable.
    const submit = await app.inject({
      method: 'POST',
      url: `/v1/applications/${created.application.id}/submit`,
      headers: withCookie(),
      payload: {},
    });
    expect(submit.statusCode).toBe(404);
    const reconcile = await app.inject({
      method: 'POST',
      url: `/v1/applications/${created.application.id}/reconcile`,
      headers: withCookie(),
      payload: {},
    });
    expect(reconcile.statusCode).toBe(404);

    const resolveHuman = await app.inject({
      method: 'POST',
      url: `/v1/applications/${created.application.id}/resolve-human`,
      headers: withCookie(),
      payload: { reason: 'not waiting for human action' },
    });
    expect(resolveHuman.statusCode).toBe(409);

    // 7. Archive is audited and the list reflects it.
    const archived = await app.inject({
      method: 'POST',
      url: `/v1/applications/${created.application.id}/archive`,
      headers: withCookie(),
      payload: { reason: 'E2E archive' },
    });
    expect(archived.statusCode).toBe(200);
    expect((archived.json() as { status: string }).status).toBe('ARCHIVED');
    const audits = await createAuditRepo(handle.db).listForEntity('application', created.application.id);
    expect(audits.some((entry) => entry.action === 'application.archived')).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/applications?limit=10',
      headers: withCookie(),
    });
    const listBody = list.json() as {
      total: number;
      items: Array<{ application: { status: string }; resumeName: string | null }>;
    };
    expect(listBody.total).toBe(1);
    expect(listBody.items[0]!.application.status).toBe('ARCHIVED');
    expect(listBody.items[0]!.resumeName).toBe('Engineering CV');
  }, 90_000);
});