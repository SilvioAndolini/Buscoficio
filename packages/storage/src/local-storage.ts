import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import {
  NotFoundError,
  ValidationError,
  sha256HexBytes,
  type ArtifactMeta,
  type ArtifactRef,
  type StoragePort,
} from '@job-system/core';

const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

/**
 * Local filesystem implementation of StoragePort (ADR-011).
 * Binaries never live in Postgres; callers persist the returned key + hash.
 */
export class LocalStorageAdapter implements StoragePort {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  private resolveKey(key: string): string {
    if (!KEY_PATTERN.test(key) || key.includes('..') || key.includes('\\')) {
      throw new ValidationError(`Invalid storage key: ${key}`);
    }
    const full = resolve(this.baseDir, key);
    if (full !== this.baseDir && !full.startsWith(this.baseDir + sep)) {
      throw new ValidationError('Storage key escapes base directory');
    }
    return full;
  }

  async put(key: string, bytes: Uint8Array, meta: ArtifactMeta): Promise<ArtifactRef> {
    const full = this.resolveKey(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
    return {
      key,
      size: bytes.byteLength,
      contentType: meta.contentType,
      hash: sha256HexBytes(bytes),
    };
  }

  async get(key: string): Promise<Uint8Array> {
    const full = this.resolveKey(key);
    try {
      const buffer = await readFile(full);
      return new Uint8Array(buffer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`Artifact not found: ${key}`);
      }
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }
}