export interface ArtifactMeta {
  contentType: string;
}

export interface ArtifactRef {
  key: string;
  size: number;
  contentType: string;
  hash: string;
}

/**
 * Storage of binaries (CVs, screenshots, traces). Never blobs in Postgres.
 * Phase 1 implementation: local filesystem; S3-compatible later (ADR-011).
 */
export interface StoragePort {
  put(key: string, bytes: Uint8Array, meta: ArtifactMeta): Promise<ArtifactRef>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}