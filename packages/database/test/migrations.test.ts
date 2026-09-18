import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@job-system/shared';
import { createDb } from '../src/client.js';
import { DEFAULT_MIGRATIONS_FOLDER, runMigrations } from '../src/migrate.js';
import { applicationTarget } from '../src/schema.js';

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
      expect(indexNames).not.toContain('resume_candidate_category_language_uq');

      const constraints = await db.execute(
        sql`select conname, confdeltype from pg_constraint where conrelid = 'resume_version'::regclass and contype = 'f'`,
      );
      const fk = (constraints.rows as Array<{ conname: string; confdeltype: string }>).find((row) =>
        row.conname.includes('parent_version_id'),
      );
      expect(fk).toBeDefined();
      expect(fk!.confdeltype).toBe('r');

      // Phase 2.1: auto-detected targets must default to blocked.
      const defaults = await db.execute(
        sql`select column_default from information_schema.columns where table_name = 'application_target' and column_name = 'status'`,
      );
      const statusDefault = (defaults.rows as Array<{ column_default: string | null }>)[0];
      expect(statusDefault?.column_default).toContain('blocked');
    } finally {
      await pool.end();
    }
  });
});

describe.skipIf(!hasDatabase)('incremental upgrade from a pre-hardening database', () => {
  const databaseName = `job_system_upgrade_${Date.now()}`;
  let partialDir: string;
  let targetUrl: string;

  function adminPool() {
    return createDb(adminUrl(), { max: 1 });
  }

  beforeAll(async () => {
    const admin = adminPool();
    await admin.pool.query(`CREATE DATABASE ${databaseName}`);
    await admin.pool.end();

    const parsed = new URL(TEST_URL);
    parsed.pathname = `/${databaseName}`;
    targetUrl = parsed.toString();

    // Build a migrations folder containing only 0000–0003 (pre-hardening state).
    const journal = JSON.parse(
      readFileSync(join(DEFAULT_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> } & Record<string, unknown>;
    const keptEntries = journal.entries.filter((entry) => entry.idx <= 3);
    partialDir = mkdtempSync(join(tmpdir(), 'job-system-mig-'));
    mkdirSync(join(partialDir, 'meta'), { recursive: true });
    for (const entry of keptEntries) {
      copyFileSync(
        join(DEFAULT_MIGRATIONS_FOLDER, `${entry.tag}.sql`),
        join(partialDir, `${entry.tag}.sql`),
      );
    }
    writeFileSync(
      join(partialDir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: keptEntries }, null, 2),
    );
    await runMigrations(targetUrl, partialDir);

    // Legacy data as it existed in Phase 2 before the safe default (raw SQL:
    // the pre-hardening schema has no reviewed_at/reviewed_by columns yet).
    const { db, pool } = createDb(targetUrl, { max: 1 });
    try {
      await db.execute(sql`
        insert into application_target (id, key, kind, platform, label, status, policy_notes)
        values
          (${uuidv7()}, 'legacy-unreviewed', 'ats_browser', 'greenhouse', 'legacy-unreviewed', 'active', null),
          (${uuidv7()}, 'legacy-reviewed', 'ats_browser', 'lever', 'legacy-reviewed', 'active', 'Reviewed policy 2026-01-01 by user.'),
          (${uuidv7()}, 'legacy-blocked', 'ats_browser', 'workday', 'legacy-blocked', 'blocked', null)
      `);
    } finally {
      await pool.end();
    }

    // Apply the remaining migrations (0004 columns + 0005 sanitization).
    await runMigrations(targetUrl);
  });

  afterAll(async () => {
    const admin = adminPool();
    await admin.pool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.pool.end();
    rmSync(partialDir, { recursive: true, force: true });
  });

  it('blocks unreviewed legacy targets and preserves reviewed/blocked ones', async () => {
    const { db, pool } = createDb(targetUrl, { max: 1 });
    try {
      const rows = await db.select().from(applicationTarget);
      const byKey = new Map(rows.map((row) => [row.key, row]));

      const unreviewed = byKey.get('legacy-unreviewed')!;
      expect(unreviewed.status).toBe('blocked');
      expect(unreviewed.policyNotes).toContain('pending separate platform policy review');
      expect(unreviewed.reviewedAt).toBeNull();
      expect(unreviewed.reviewedBy).toBeNull();

      const reviewed = byKey.get('legacy-reviewed')!;
      expect(reviewed.status).toBe('active');
      expect(reviewed.policyNotes).toBe('Reviewed policy 2026-01-01 by user.');

      const blocked = byKey.get('legacy-blocked')!;
      expect(blocked.status).toBe('blocked');
      expect(blocked.policyNotes).toBeNull();
    } finally {
      await pool.end();
    }
  });

  it('is idempotent when migrations run again', async () => {
    await runMigrations(targetUrl);
    const { db, pool } = createDb(targetUrl, { max: 1 });
    try {
      const rows = await db.select().from(applicationTarget);
      const byKey = new Map(rows.map((row) => [row.key, row]));
      expect(byKey.get('legacy-unreviewed')!.status).toBe('blocked');
      expect(byKey.get('legacy-reviewed')!.status).toBe('active');
      expect(byKey.get('legacy-reviewed')!.policyNotes).toBe('Reviewed policy 2026-01-01 by user.');
      expect(byKey.get('legacy-blocked')!.status).toBe('blocked');
    } finally {
      await pool.end();
    }
  });
});