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
        'ai_usage',
        'application_target',
        'audit_log',
        'candidate_profile',
        'candidate_skill',
        'decision_log',
        'embedding_space',
        'job',
        'job_embedding',
        'job_listing',
        'job_match',
        'job_source',
        'resume',
        'resume_embedding',
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

      // Phase 3: identity/current constraints, ranking index and HNSW vectors.
      expect(indexNames).toContain('job_match_identity_uq');
      expect(indexNames).toContain('job_match_current_uq');
      expect(indexNames).toContain('job_match_ranking_idx');
      expect(indexNames).toContain('job_embedding_hnsw_idx');
      expect(indexNames).toContain('resume_embedding_hnsw_idx');
      expect(indexNames).toContain('embedding_space_active_uq');

      const extension = await db.execute(
        sql`select extname from pg_extension where extname = 'vector'`,
      );
      expect((extension.rows as Array<{ extname: string }>).length).toBe(1);

      const embeddingColumn = await db.execute(
        sql`select format_type(atttypid, atttypmod) as type from pg_attribute where attrelid = 'job_embedding'::regclass and attname = 'embedding'`,
      );
      expect((embeddingColumn.rows as Array<{ type: string }>)[0]?.type).toBe('vector(1536)');

      // Phase 3.1: temporal anchor is nullable (pre-existing history stays valid).
      const asOfColumn = await db.execute(
        sql`select is_nullable from information_schema.columns where table_name = 'job_match' and column_name = 'matching_as_of_date'`,
      );
      expect((asOfColumn.rows as Array<{ is_nullable: string }>)[0]?.is_nullable).toBe('YES');

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
    const stage3Dir = buildPartialFolder(6);
    await runMigrations(targetUrl, stage3Dir);
    rmSync(stage3Dir, { recursive: true, force: true });

    // Stage 4: apply 0007 (pgvector + job_match) to reach a Phase 3 database,
    // then seed derived data (embeddings) and match history that the 0008
    // sanitation must preserve/invalidate respectively.
    const stage4Dir = buildPartialFolder(7);
    await runMigrations(targetUrl, stage4Dir);
    rmSync(stage4Dir, { recursive: true, force: true });

    const stage4 = createDb(targetUrl, { max: 1 });
    try {
      const candidateId = uuidv7();
      const jobId = uuidv7();
      const resumeId = uuidv7();
      const resumeVersionId = uuidv7();
      const spaceId = uuidv7();
      await stage4.db.execute(sql`
        insert into candidate_profile (id, full_name, email)
        values (${candidateId}, 'Ada Lovelace', 'ada@example.com')
      `);
      await stage4.db.execute(sql`
        insert into job (id, company, company_norm, title, title_norm, description, dedup_key, content_hash)
        values (${jobId}, 'Acme', 'acme', 'Developer', 'developer', 'Build things', ${'d'.repeat(64)}, ${'c'.repeat(64)})
      `);
      await stage4.db.execute(sql`
        insert into resume (id, candidate_id, name, category)
        values (${resumeId}, ${candidateId}, 'Engineering CV', 'software-engineering')
      `);
      await stage4.db.execute(sql`
        insert into resume_version (id, resume_id, version_number, storage_key, file_hash)
        values (${resumeVersionId}, ${resumeId}, 1, 'resumes/x/v1.txt', ${'a'.repeat(64)})
      `);
      await stage4.db.execute(sql`
        insert into embedding_space (id, key, provider, model, dimensions, version, status)
        values (${spaceId}, 'mock-deterministic-v1-1536-v1', 'mock', 'mock-deterministic-v1', 1536, 'v1', 'active')
      `);
      await stage4.db.execute(sql`
        insert into job_match (id, job_id, candidate_id, overall_score, score_breakdown, engine_version,
          weights_version, job_content_hash, candidate_profile_hash, resume_set_hash, identity_hash, is_current)
        values (${uuidv7()}, ${jobId}, ${candidateId}, 0.7500, '{}'::jsonb, 'matching-v1', 'v1',
          ${'c'.repeat(64)}, ${'b'.repeat(64)}, ${'e'.repeat(64)}, ${'f'.repeat(64)}, true)
      `);
      const legacyVector = sql.raw(`'[${Array(1536).fill('0.01').join(',')}]'::vector`);
      await stage4.db.execute(sql`
        insert into job_embedding (job_id, embedding_space_id, content_hash, embedding)
        values (${jobId}, ${spaceId}, 'legacy-hash', ${legacyVector})
      `);
      await stage4.db.execute(sql`
        insert into resume_embedding (resume_version_id, embedding_space_id, content_hash, embedding)
        values (${resumeVersionId}, ${spaceId}, 'legacy-hash', ${legacyVector})
      `);
    } finally {
      await stage4.pool.end();
    }

    // Stage 5: apply 0008 (temporal column + legacy embedding invalidation).
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

  it('0007 upgrades the Phase 2.3 database with matching tables and real pgvector', async () => {
    const { db, pool } = createDb(targetUrl, { max: 1 });
    try {
      const tables = await db.execute(
        sql`select tablename from pg_tables where schemaname = 'public' order by tablename`,
      );
      const names = (tables.rows as Array<{ tablename: string }>).map((row) => row.tablename);
      expect(names).toContain('job_match');
      expect(names).toContain('job_embedding');
      expect(names).toContain('resume_embedding');
      expect(names).toContain('ai_usage');

      const extension = await db.execute(
        sql`select extname from pg_extension where extname = 'vector'`,
      );
      expect((extension.rows as Array<{ extname: string }>).length).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('0008 preserves JobMatch history, adds the temporal column and invalidates legacy embeddings', async () => {
    const { db, pool } = createDb(targetUrl, { max: 1 });
    try {
      // Historical JobMatch (matching-v1) survives the sanitation untouched.
      const matches = await db.execute(
        sql`select id, engine_version, identity_hash, is_current, matching_as_of_date from job_match`,
      );
      const rows = matches.rows as Array<{
        engine_version: string;
        identity_hash: string;
        is_current: boolean;
        matching_as_of_date: string | null;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.engine_version).toBe('matching-v1');
      expect(rows[0]!.identity_hash).toBe('f'.repeat(64));
      expect(rows[0]!.is_current).toBe(true);
      // Nullable for pre-existing history (no retroactive invention of dates).
      expect(rows[0]!.matching_as_of_date).toBeNull();

      // Derived embedding caches are invalidated (regenerable, not source data).
      const embeddings = await db.execute(
        sql`select
              (select count(*) from job_embedding) as jobs,
              (select count(*) from resume_embedding) as resumes`,
      );
      const counts = embeddings.rows[0] as { jobs: string; resumes: string };
      expect(Number(counts.jobs)).toBe(0);
      expect(Number(counts.resumes)).toBe(0);

      // pgvector is preserved.
      const extension = await db.execute(
        sql`select extname from pg_extension where extname = 'vector'`,
      );
      expect((extension.rows as Array<{ extname: string }>).length).toBe(1);

      // Source data is never touched by the sanitation.
      const sources = await db.execute(
        sql`select
              (select count(*) from job) as jobs,
              (select count(*) from resume_version) as versions`,
      );
      const sourceCounts = sources.rows[0] as { jobs: string; versions: string };
      expect(Number(sourceCounts.jobs)).toBeGreaterThan(0);
      expect(Number(sourceCounts.versions)).toBeGreaterThan(0);
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