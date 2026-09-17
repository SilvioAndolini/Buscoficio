import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '@job-system/core';
import { LocalStorageAdapter } from '../src/local-storage.js';

describe('LocalStorageAdapter', () => {
  let dir: string;
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'job-storage-'));
    storage = new LocalStorageAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores and retrieves bytes, returning a stable hash', async () => {
    const bytes = new TextEncoder().encode('resume content');
    const ref = await storage.put('candidate/cv/v1.txt', bytes, { contentType: 'text/plain' });
    expect(ref.size).toBe(bytes.byteLength);
    expect(ref.hash).toHaveLength(64);

    const loaded = await storage.get('candidate/cv/v1.txt');
    expect(new TextDecoder().decode(loaded)).toBe('resume content');
    expect(await storage.exists('candidate/cv/v1.txt')).toBe(true);

    const second = await storage.put('candidate/cv/v1-copy.txt', bytes, { contentType: 'text/plain' });
    expect(second.hash).toBe(ref.hash);
  });

  it('deletes artifacts idempotently', async () => {
    await storage.put('a/b.txt', new Uint8Array([1, 2, 3]), { contentType: 'application/octet-stream' });
    await storage.delete('a/b.txt');
    expect(await storage.exists('a/b.txt')).toBe(false);
    await storage.delete('a/b.txt');
  });

  it('rejects path traversal and absolute keys', async () => {
    await expect(
      storage.put('../escape.txt', new Uint8Array([1]), { contentType: 'text/plain' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      storage.put('C:/absolute.txt', new Uint8Array([1]), { contentType: 'text/plain' }),
    ).rejects.toThrow(ValidationError);
    await expect(storage.get('a\\b.txt')).rejects.toThrow(ValidationError);
  });

  it('throws NotFoundError for missing artifacts', async () => {
    await expect(storage.get('missing.txt')).rejects.toThrow(NotFoundError);
  });
});