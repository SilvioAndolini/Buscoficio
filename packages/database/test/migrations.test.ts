import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/client.js';
import { runMigrations } from '../src/migrate.js';

const TEST_URL = process.env['TEST_DATABASE_URL'] ?? '';
const hasDatabase = TEST_URL.length > 0;

function adminUrl(): string {
  const url = new URL(TEST_URL);
  url.pathname = '/postgres';
  return url.toString();
}

describe.skipIf(!hasDatabase)('migrations from an empty database', () => {
  const databaseName = `job_system_migcheck_${Date.now()}`;

  beforeAll(async () => {
    const { pool } = createDb(adminUrl(), { max: 1 });
    await pool.query(`CREATE DATABASE ${databaseName}`);
    await pool.end();

    const target = new URL(TEST_URL);
    target.pathname = `/${databaseName}`;
    await runMigrations(target.toString());
  });

  afterAll(async () => {
    const { pool } = createDb(adminUrl(), { max: 1 });
    await pool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await pool.end();
  });

  it('creates the Phase 1 tables with their key constraints', async () => {
    const target = new URL(TEST_URL);
    target.pathname = `/${databaseName}`;
    const { db, pool } = createDb(target.toString(), { max: 1 });
    try {
      const tables = await db.execute(
        sql`select tablename from pg_tables where schemaname = 'public' order by tablename`,
      );
      const names = (tables.rows as Array<{ tablename: string }>).map((row) => row.tablename);
      for (const expected of [
        'application_target',
        'audit_log',
        'candidate_profile',
        'candidate_skill',
        'decision_log',
        'embedding_space',
        'job',
        'job_listing',
        'job_source',
        'resume',
        'resume_version',
        'search_config',
        'search_run',
        'search_source_run',
      ]) {
        expect(names).toContain(expected);
      }

      const indexes = await db.execute(
        sql`select indexname from pg_indexes where schemaname = 'public'`,
      );
      const indexNames = (indexes.rows as Array<{ indexname: string }>).map((row) => row.indexname);
      expect(indexNames).toContain('job_listing_source_external_uq');
      expect(indexNames).toContain('job_dedup_key_uq');
      expect(indexNames).toContain('resume_version_resume_version_uq');
    } finally {
      await pool.end();
    }
  });
});