import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { sha256Hex } from '@job-system/core';
import { uuidv7 } from '@job-system/shared';
import { createDb, createMatchingRepo, type DbHandle } from '../src/index.js';
import { createTestDb, truncateAll } from '../src/testing.js';

const TEST_URL = process.env['TEST_DATABASE_URL'] ?? '';
const hasDatabase = TEST_URL.length > 0;
const describeIntegration = hasDatabase ? describe : describe.skip;

const DIMENSIONS = 1536;

function unitVector(seed: string): number[] {
  let state = Number.parseInt(sha256Hex(seed).slice(0, 8), 16) >>> 0;
  const vector: number[] = [];
  let norm = 0;
  for (let index = 0; index < DIMENSIONS; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const value = (state / 0xffff_ffff) * 2 - 1;
    vector.push(value);
    norm += value * value;
  }
  const length = Math.sqrt(norm);
  return vector.map((value) => value / length);
}

function jsCosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

let handle: DbHandle;

async function insertJob(): Promise<string> {
  const id = uuidv7();
  await handle.db.execute(sql`
    insert into job (id, company, company_norm, title, title_norm, description, dedup_key, content_hash)
    values (${id}, 'Acme', 'acme', 'Developer', 'developer', 'Build things', ${sha256Hex(id)}, ${sha256Hex(`c-${id}`)})
  `);
  return id;
}

beforeAll(async () => {
  handle = await createTestDb();
});

afterAll(async () => {
  await handle.pool.end();
});

beforeEach(async () => {
  await truncateAll(handle.db);
});

describeIntegration('matching persistence with real pgvector', () => {
  it('stores vectors and computes cosine distance in SQL consistent with JS', async () => {
    const repo = createMatchingRepo(handle.db);
    const space = await repo.ensureEmbeddingSpace({
      key: 'space-a',
      provider: 'mock',
      model: 'mock-a',
      dimensions: DIMENSIONS,
      distanceMetric: 'cosine',
      version: 'v1',
    });
    const jobId = await insertJob();
    const vector = unitVector('hello');
    await repo.upsertJobEmbedding(jobId, space.id, { contentHash: sha256Hex('hello'), embedding: vector });

    const other = unitVector('hello');
    const result = await handle.db.execute(sql`
      select 1 - (embedding <=> ${vectorLiteral(other)}::vector) as cosine
      from job_embedding
      where job_id = ${jobId} and embedding_space_id = ${space.id}
    `);
    const cosine = Number((result.rows as Array<{ cosine: number | string }>)[0]!.cosine);
    expect(cosine).toBeCloseTo(jsCosine(vector, other), 5);
    expect(cosine).toBeCloseTo(1, 5);

    const stored = await repo.getJobEmbedding(jobId, space.id);
    expect(stored).not.toBeNull();
    expect(stored!.contentHash).toBe(sha256Hex('hello'));
    expect(stored!.embedding).toHaveLength(DIMENSIONS);
  });

  it('caches embeddings by (entity, space, contentHash) and coexists across spaces', async () => {
    const repo = createMatchingRepo(handle.db);
    const spaceA = await repo.ensureEmbeddingSpace({
      key: 'space-a',
      provider: 'mock',
      model: 'mock-a',
      dimensions: DIMENSIONS,
      distanceMetric: 'cosine',
      version: 'v1',
    });
    const spaceB = await repo.ensureEmbeddingSpace({
      key: 'space-b',
      provider: 'mock',
      model: 'mock-b',
      dimensions: DIMENSIONS,
      distanceMetric: 'cosine',
      version: 'v1',
    });
    const jobId = await insertJob();

    await repo.upsertJobEmbedding(jobId, spaceA.id, {
      contentHash: sha256Hex('content'),
      embedding: unitVector('content'),
    });
    // Cache hit read: same content hash, no rewrite needed.
    const cached = await repo.getJobEmbedding(jobId, spaceA.id);
    expect(cached!.contentHash).toBe(sha256Hex('content'));

    await repo.upsertJobEmbedding(jobId, spaceB.id, {
      contentHash: sha256Hex('content'),
      embedding: unitVector('content'),
    });
    const rows = await handle.db.execute(
      sql`select embedding_space_id from job_embedding where job_id = ${jobId}`,
    );
    expect((rows.rows as unknown[]).length).toBe(2);

    // Changing content replaces the embedding for that space only.
    await repo.upsertJobEmbedding(jobId, spaceA.id, {
      contentHash: sha256Hex('changed'),
      embedding: unitVector('changed'),
    });
    const updated = await repo.getJobEmbedding(jobId, spaceA.id);
    expect(updated!.contentHash).toBe(sha256Hex('changed'));
    expect((await repo.getJobEmbedding(jobId, spaceB.id))!.contentHash).toBe(sha256Hex('content'));
  });

  it('enforces at most one active embedding space via partial unique index', async () => {
    const repo = createMatchingRepo(handle.db);
    const spaceA = await repo.ensureEmbeddingSpace({
      key: 'space-a',
      provider: 'mock',
      model: 'mock-a',
      dimensions: DIMENSIONS,
      distanceMetric: 'cosine',
      version: 'v1',
    });
    expect(spaceA.status).toBe('active');
    const spaceB = await repo.ensureEmbeddingSpace({
      key: 'space-b',
      provider: 'mock',
      model: 'mock-b',
      dimensions: DIMENSIONS,
      distanceMetric: 'cosine',
      version: 'v1',
    });
    expect(spaceB.status).toBe('inactive');

    let caught: unknown;
    try {
      await handle.db.execute(
        sql`update embedding_space set status = 'active' where id = ${spaceB.id}`,
      );
    } catch (error) {
      caught = error;
    }
    const cause = (caught as { cause?: { code?: string } } | undefined)?.cause ?? caught;
    expect((cause as { code?: string } | undefined)?.code).toBe('23505');

    const activated = await repo.activateEmbeddingSpace(spaceB.id);
    expect(activated.status).toBe('active');
    const spaces = await repo.listEmbeddingSpaces();
    expect(spaces.filter((space) => space.status === 'active')).toHaveLength(1);
    expect(spaces.find((space) => space.id === spaceA.id)!.status).toBe('inactive');
  });

  it('connects through the pgvector-enabled database (sanity)', async () => {
    const result = await handle.db.execute(sql`select '[1,2,3]'::vector as v`);
    expect(result.rows.length).toBe(1);
    const admin = createDb(TEST_URL, { max: 1 });
    await admin.pool.end();
  });
});