#!/usr/bin/env node
/**
 * Playwright UI smoke runner:
 *  1. disposable Postgres+Redis (docker compose test)
 *  2. migrations + clean state
 *  3. builds api/worker and boots api, worker and web against the test stack
 *  4. runs the Playwright smoke suite
 *  5. tears everything down
 */
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = resolve(ROOT, 'docker/docker-compose.test.yml');
const PG_CONTAINER = 'job-system-test-postgres-1';

const TEST_DATABASE_URL = 'postgres://job:job@localhost:55432/job_system_test';
const TEST_REDIS_URL = 'redis://localhost:56379';
const API_PORT = 3101;
const WEB_PORT = 3100;
const PASSWORD = 'e2e-password';
const PASSWORD_HASH = execFileSync(
  process.execPath,
  ['-e', `process.stdout.write(require('crypto').createHash('sha256').update('${PASSWORD}').digest('hex'))`],
  { encoding: 'utf8' },
).trim();

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
}

const children = [];
function spawnService(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    ...options,
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.warn(`[e2e] ${name} exited with code ${code}`);
  });
  children.push(child);
  return child;
}

let teardown = false;
function down() {
  if (teardown) return;
  teardown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
  try {
    run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v']);
  } catch (error) {
    console.warn('[e2e] compose down failed:', error.message);
  }
}

process.on('SIGINT', () => {
  down();
  process.exit(130);
});

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

try {
  console.log('[e2e] starting test infrastructure...');
  run('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait']);

  console.log('[e2e] applying migrations...');
  run('pnpm', ['--filter', '@job-system/database', 'db:migrate'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    shell: process.platform === 'win32',
  });

  console.log('[e2e] cleaning database state...');
  run('docker', [
    'exec',
    PG_CONTAINER,
    'psql',
    '-U',
    'job',
    '-d',
    'job_system_test',
    '-c',
    'TRUNCATE candidate_profile, job_source, application_target CASCADE;',
  ]);

  console.log('[e2e] building api + worker...');
  run('pnpm', ['--filter', '@job-system/api', '--filter', '@job-system/worker', 'build'], {
    shell: process.platform === 'win32',
  });

  console.log('[e2e] building web (API_URL is baked into production rewrites)...');
  run('pnpm', ['--filter', '@job-system/web', 'build'], {
    env: { ...process.env, API_URL: `http://127.0.0.1:${API_PORT}` },
    shell: process.platform === 'win32',
  });

  const serviceEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    AUTH_PASSWORD_HASH: PASSWORD_HASH,
    AUTH_SECRET: 'e2e-secret-value-1234567890',
    AUTH_COOKIE_SECURE: 'false',
    DRY_RUN: 'true',
    AUTO_APPLY_ENABLED: 'false',
    STORAGE_BACKEND: 'local',
    STORAGE_LOCAL_DIR: '.data/e2e-storage',
    LOG_LEVEL: 'warn',
  };

  console.log('[e2e] starting api and worker...');
  spawnService('api', process.execPath, ['dist/main.js'], {
    cwd: resolve(ROOT, 'apps/api'),
    env: { ...serviceEnv, API_HOST: '127.0.0.1', API_PORT: String(API_PORT) },
  });
  spawnService('worker', process.execPath, ['dist/main.js'], {
    cwd: resolve(ROOT, 'apps/worker'),
    env: serviceEnv,
  });

  console.log('[e2e] starting web...');
  spawnService('web', process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(WEB_PORT)], {
    cwd: resolve(ROOT, 'apps/web'),
    env: { ...serviceEnv, API_URL: `http://127.0.0.1:${API_PORT}` },
  });

  await waitFor(`http://127.0.0.1:${API_PORT}/readyz`);
  await waitFor(`http://127.0.0.1:${WEB_PORT}/`);

  console.log('[e2e] running Playwright smoke suite...');
  run('pnpm', ['exec', 'playwright', 'test'], {
    env: {
      ...process.env,
      E2E_BASE_URL: `http://127.0.0.1:${WEB_PORT}`,
      E2E_PASSWORD: PASSWORD,
    },
    shell: process.platform === 'win32',
  });

  console.log('[e2e] smoke suite passed.');
} catch (error) {
  console.error('[e2e] failed:', error.message);
  process.exitCode = 1;
} finally {
  down();
}