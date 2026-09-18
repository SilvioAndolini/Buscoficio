import { sql } from 'drizzle-orm';
import { createDb, type Db, type DbHandle } from './client.js';
import { runMigrations } from './migrate.js';

/**
 * Integration test utilities. Requires TEST_DATABASE_URL (real PostgreSQL).
 * Tests must not replace Postgres with fakes (architecture doc 10).
 */
export function requireTestDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start docker/docker-compose.test.yml and export it before running integration tests.',
    );
  }
  return url;
}

let migrated = false;

export async function createTestDb(): Promise<DbHandle> {
  const url = requireTestDatabaseUrl();
  if (!migrated) {
    // Serialize migrations across concurrent test processes (advisory lock):
    // CREATE SCHEMA IF NOT EXISTS races are not safe under concurrency.
    const { pool } = createDb(url, { max: 1 });
    try {
      await pool.query('select pg_advisory_lock(727001)');
      await runMigrations(url);
    } finally {
      await pool.query('select pg_advisory_unlock(727001)');
      await pool.end();
    }
    migrated = true;
  }
  const handle = createDb(url, { max: 5 });
  return handle;
}

/**
 * Test cleanup. Background workers may still be writing (e.g. matching jobs
 * enqueued by a just-finished search run), so the truncate uses a bounded
 * lock timeout and retries on deadlock/lock-not-available instead of failing
 * the suite intermittently.
 */
const RETRYABLE_LOCK_CODES = new Set(['40P01', '55P03']);

export async function truncateAll(db: Db): Promise<void> {
  const result = await db.execute(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename not like '\\_\\_drizzle%' escape '\\'`,
  );
  const rows = result.rows as Array<{ tablename: string }>;
  if (rows.length === 0) return;
  const tables = rows.map((row) => `"public"."${row.tablename}"`).join(', ');

  for (let attempt = 1; ; attempt += 1) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '10s'`);
        await tx.execute(sql.raw(`truncate table ${tables} restart identity cascade`));
      });
      return;
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause ?? error;
      const code = (cause as { code?: string }).code;
      if (code !== undefined && RETRYABLE_LOCK_CODES.has(code) && attempt < 5) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 200 * attempt));
        continue;
      }
      throw error;
    }
  }
}