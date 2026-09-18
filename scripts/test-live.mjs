#!/usr/bin/env node
/**
 * Manual live suite: hits the real public job APIs once per source.
 * NOT part of CI (network + third-party availability). Usage: pnpm test:live
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  execFileSync(
    'pnpm',
    ['--filter', '@job-system/job-sources', 'exec', 'vitest', 'run', 'test/live.test.ts'],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, LIVE_TESTS: 'true' },
      shell: process.platform === 'win32',
    },
  );
} catch {
  process.exitCode = 1;
}