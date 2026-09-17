#!/usr/bin/env node
/**
 * Integration test runner: starts the disposable Postgres+Redis test stack
 * (docker/docker-compose.test.yml), exports connection URLs and runs the full
 * turbo test suite against real infrastructure. No mocks substitute Postgres
 * or Redis (architecture doc 10).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = resolve(ROOT, 'docker/docker-compose.test.yml');

const TEST_DATABASE_URL = 'postgres://job:job@localhost:55432/job_system_test';
const TEST_REDIS_URL = 'redis://localhost:56379';

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
}

let teardown = false;
function down() {
  if (teardown) return;
  teardown = true;
  try {
    run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v']);
  } catch (error) {
    console.warn('compose down failed:', error.message);
  }
}

process.on('SIGINT', () => {
  down();
  process.exit(130);
});

try {
  console.log('[integration] starting test infrastructure...');
  run('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait']);

  console.log('[integration] running full test suite (real Postgres + Redis)...');
  run('pnpm', ['turbo', 'test', '--concurrency=1'], {
    env: {
      ...process.env,
      TEST_DATABASE_URL,
      TEST_REDIS_URL,
    },
    shell: process.platform === 'win32',
  });

  console.log('[integration] all tests passed.');
} catch (error) {
  console.error('[integration] failed:', error.message);
  process.exitCode = 1;
} finally {
  if (process.env['KEEP_TEST_INFRA'] !== 'true') down();
}