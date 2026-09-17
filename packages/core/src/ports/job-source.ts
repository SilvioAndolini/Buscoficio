import type { NormalizedJob, RawJob } from '../schemas/job.js';

export interface SourceSearchQuery {
  keywords: string[];
  locations?: string[];
  remote?: boolean;
  page: number;
  pageSize?: number;
}

export interface SourceSearchResult {
  jobs: RawJob[];
  page: number;
  hasMore: boolean;
}

export interface SourceCapabilities {
  requiresHumanLogin: boolean;
  supportsPagination: boolean;
  pageSize: number;
}

/**
 * Detection of the real application destination (ADR-013).
 * Phase 1: mock returns null / metadata-only signals.
 */
export interface DetectedApplicationTarget {
  platformKey: string;
  signal: 'redirect' | 'metadata' | 'pattern' | 'manual';
  baseUrl?: string;
}

/**
 * Common contract for discovery sources (architecture doc 05 §2.1).
 * A source can never touch candidates or applications.
 */
export interface JobSourceAdapter {
  readonly key: string;
  readonly capabilities: SourceCapabilities;
  searchJobs(query: SourceSearchQuery): Promise<SourceSearchResult>;
  fetchJob(externalId: string): Promise<RawJob | null>;
  /** Pure and deterministic: raw payload into the single normalized schema. */
  normalizeJob(raw: RawJob): NormalizedJob;
  detectApplicationTarget(raw: RawJob): DetectedApplicationTarget | null;
}