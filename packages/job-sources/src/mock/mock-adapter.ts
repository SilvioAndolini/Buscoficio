import {
  SourceAuthError,
  SourceTransientError,
  ValidationError,
  type DetectedApplicationTarget,
  type JobSourceAdapter,
  type NormalizedJob,
  type RawJob,
  type SourceCapabilities,
  type SourceSearchQuery,
  type SourceSearchResult,
} from '@job-system/core';
import { RawJobPayloadSchema, normalizeJob, type RawJobPayload } from '../normalize.js';
import { MOCK_FIXTURE_FETCHED_AT, MOCK_SOURCE_KEY, MOCK_PAYLOADS } from './fixtures.js';

export interface MockJobSourceOptions {
  /** Deterministic error simulation for tests and failure handling. */
  failSearch?: 'transient' | 'auth' | null;
  pageSize?: number;
  payloads?: RawJobPayload[];
}

const DEFAULT_PAGE_SIZE = 4;

function matchesKeywords(payload: RawJobPayload, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const haystack = `${payload.title} ${payload.description} ${payload.company}`.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword.trim().toLowerCase()));
}

/**
 * Deterministic mock discovery source (Phase 1). Implements the official
 * JobSourceAdapter contract; contains no business logic.
 */
export function createMockJobSource(options: MockJobSourceOptions = {}): JobSourceAdapter {
  const payloads = options.payloads ?? MOCK_PAYLOADS;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const failSearch = options.failSearch ?? null;

  const capabilities: SourceCapabilities = {
    requiresHumanLogin: false,
    supportsPagination: true,
    pageSize,
  };

  const toRawJob = (payload: unknown, externalId: string): RawJob => {
    const parsed = RawJobPayloadSchema.safeParse(payload);
    return {
      sourceKey: MOCK_SOURCE_KEY,
      externalId,
      fetchedAt: MOCK_FIXTURE_FETCHED_AT,
      data: parsed.success ? parsed.data : payload,
    };
  };

  return {
    key: MOCK_SOURCE_KEY,
    capabilities,

    async searchJobs(query: SourceSearchQuery): Promise<SourceSearchResult> {
      if (failSearch === 'transient') {
        throw new SourceTransientError('Mock source: simulated transient failure');
      }
      if (failSearch === 'auth') {
        throw new SourceAuthError('Mock source: simulated authentication failure');
      }
      if (query.page < 1) {
        throw new ValidationError('page must be >= 1');
      }
      const matched = payloads.filter((payload) => matchesKeywords(payload, query.keywords));
      const start = (query.page - 1) * pageSize;
      const pageItems = matched.slice(start, start + pageSize);
      return {
        jobs: pageItems.map((payload) => toRawJob(payload, payload.externalId)),
        page: query.page,
        hasMore: start + pageSize < matched.length,
      };
    },

    async fetchJob(externalId: string): Promise<RawJob | null> {
      const payload = payloads.find((candidate) => candidate.externalId === externalId);
      return payload ? toRawJob(payload, payload.externalId) : null;
    },

    normalizeJob(raw: RawJob): NormalizedJob {
      return normalizeJob(raw);
    },

    detectApplicationTarget(raw: RawJob): DetectedApplicationTarget | null {
      const parsed = RawJobPayloadSchema.safeParse(raw.data);
      if (!parsed.success || parsed.data.applyPlatform === null) return null;
      return {
        platformKey: parsed.data.applyPlatform,
        signal: 'metadata',
      };
    },
  };
}