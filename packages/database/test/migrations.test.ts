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

  /** Builds a migrations folder containing only entries up to maxIdx. */
  function buildPartialFolder(maxIdx: number): string {
    const journal = JSON.parse(
      readFileSync(join(DEFAULT_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> } & Record<string, unknown>;
    const keptEntries = journal.entries.filter((entry) => entry.idx <= maxIdx);
    const dir = mkdtempSync(join(tmpdir(), 'job-system-mig-'));
    mkdirSync(join(dir, 'meta'), { recursive: true });
    for (const entry of keptEntries) {
      copyFileSync(
        join(DEFAULT_MIGRATIONS_FOLDER, `${entry.tag}.sql`),
        join(dir, `${entry.tag}.sql`),
      );
    }
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: keptEntries }, null, 2),
    );
    return dir;
  }

  beforeAll(async () => {
    const admin = adminPool();
    await admin.pool.query(`CREATE DATABASE ${databaseName}`);
    await admin.pool.end();

    const parsed = new URL(TEST_URL);
    parsed.pathname = `/${databaseName}`;
    targetUrl = parsed.toString();

    // Stage 1: schema as it was before the hardening (0000–0003).
    partialDir = buildPartialFolder(3);
    await runMigrations(targetUrl, partialDir);

    // Pre-0004 legacy rows (schema has no reviewed_at/reviewed_by yet).
    const stage1 = createDb(targetUrl, { max: 1 });
    try {
      await stage1.db.execute(sql`
        insert into application_target (id, key, kind, platform, label, status, policy_notes)
        values
          (${uuidv7()}, 'legacy-unreviewed', 'ats_browser', 'greenhouse', 'legacy-unreviewed', 'active', null),
          (${uuidv7()}, 'legacy-reviewed', 'ats_browser', 'lever', 'legacy-reviewed', 'active', 'Reviewed policy 2026-01-01 by user.'),
          (${uuidv7()}, 'legacy-blocked', 'ats_browser', 'workday', 'legacy-blocked', 'blocked', null)
      `);
    } finally {
      await stage1.pool.end();
    }

    // Stage 2: apply 0004 (columns) + 0005 (first sanitization), then insert
    // the Phase 2.1-era rows: a target could be active with the auto-generated
    // pending-review note and no structured review evidence.
    const stage2Dir = buildPartialFolder(5);
    await runMigrations(targetUrl, stage2Dir);
    rmSync(stage2Dir, { recursive: true, force: true });

    const stage2 = createDb(targetUrl, { max: 1 });
    try {
      await stage2.db.execute(sql`
        insert into application_target (id, key, kind, platform, label, status, policy_notes, reviewed_at, reviewed_by)
        values
          (${uuidv7()}, 'f21-pending', 'ats_browser', 'greenhouse', 'f21-pending', 'active',
            'Detected ATS target (greenhouse). Discovery association allowed. Submission authorization pending separate platform policy review.', null, null),
          (${uuidv7()}, 'structured-reviewed', 'ats_browser', 'lever', 'structured-reviewed', 'active',
            'Auto-detected.
Review completed 2026-09-18T10:00:00.000Z by user.
Reviewed provider/platform terms for personal discovery.', '2026-09-18T10:00:00Z', 'user'),
          (${uuidv7()}, 'textual-legacy', 'ats_browser', 'workable', 'textual-legacy', 'active',
            'Reviewed policy 2026-01-01 by user.', null, null),
          (${uuidv7()}, 'blocked-1', 'ats_browser', 'ashby', 'blocked-1', 'blocked', null, null, null),
          (${uuidv7()}, 'paused-1', 'ats_browser', 'smartrecruiters', 'paused-1', 'paused',
            'Submission authorization pending separate platform policy review.', null, null)
      `);
    } finally {
      await stage2.pool.end();
    }

    // Stage 3: apply 0006 (active without structured review → blocked).
    await runMigrations(targetUrl);
  });

  afterAll(async () => {
    const admin = adminPool();
    await admin.pool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.pool.end();
    rmSync(partialDir, { recursive: true, force: true });
  });

  it('0005 blocks unreviewed pre-hardening targets and preserves reviewed/blocked ones', async () => {
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

  it('0006 blocks active targets without structured review (all legacy cases)', async () => {
    const { db, pool } = createDb(targetUrl, { max: 1 });
    try {
      const rows = await db.select().from(applicationTarget);
      const byKey = new Map(rows.map((row) => [row.key, row]));

      // Case C: Phase 2.1 legacy (active + pending-review note, no review).
      const pending = byKey.get('f21-pending')!;
      expect(pending.status).toBe('blocked');
      expect(pending.policyNotes).toContain('pending separate platform policy review');

      // Case A: structured review stays active, evidence untouched.
      const structured = byKey.get('structured-reviewed')!;
      expect(structured.status).toBe('active');
      expect(structured.reviewedBy).toBe('user');
      expect(structured.reviewedAt?.toISOString()).toBe('2026-09-18T10:00:00.000Z');
      expect(structured.policyNotes).toContain('Review completed');

      // Case D: textual legacy evidence is conservatively preserved (cannot
      // derive reviewedAt/reviewedBy deterministically; never invent data).
      const textual = byKey.get('textual-legacy')!;
      expect(textual.status).toBe('active');
      expect(textual.policyNotes).toBe('Reviewed policy 2026-01-01 by user.');
      expect(textual.reviewedAt).toBeNull();
      expect(textual.reviewedBy).toBeNull();

      // Blocked and paused rows are untouched by design.
      expect(byKey.get('blocked-1')!.status).toBe('blocked');
      expect(byKey.get('paused-1')!.status).toBe('paused');

      // Previous stages remain consistent.
      expect(byKey.get('legacy-unreviewed')!.status).toBe('blocked');
      expect(byKey.get('legacy-reviewed')!.status).toBe('active');
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

      expect(byKey.get('f21-pending')!.status).toBe('blocked');
      expect(byKey.get('structured-reviewed')!.status).toBe('active');
      expect(byKey.get('structured-reviewed')!.reviewedAt?.toISOString()).toBe(
        '2026-09-18T10:00:00.000Z',
      );
      expect(byKey.get('textual-legacy')!.status).toBe('active');
      expect(byKey.get('textual-legacy')!.policyNotes).toBe('Reviewed policy 2026-01-01 by user.');
      expect(byKey.get('blocked-1')!.status).toBe('blocked');
      expect(byKey.get('paused-1')!.status).toBe('paused');
    } finally {
      await pool.end();
    }
  });
});