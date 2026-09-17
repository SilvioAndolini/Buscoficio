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
    await runMigrations(url);
    migrated = true;
  }
  const handle = createDb(url, { max: 5 });
  return handle;
}

export async function truncateAll(db: Db): Promise<void> {
  const result = await db.execute(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename not like '\\_\\_drizzle%' escape '\\'`,
  );
  const rows = result.rows as Array<{ tablename: string }>;
  if (rows.length === 0) return;
  const tables = rows.map((row) => `"public"."${row.tablename}"`).join(', ');
  await db.execute(sql.raw(`truncate table ${tables} restart identity cascade`));
}