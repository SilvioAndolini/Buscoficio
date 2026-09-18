import {
  RateLimitedError,
  isAppError,
  type Clock,
  type DedupThresholds,
  type HardFilterConfig,
  type TraceContext,
} from '@job-system/core';
import type { IngestService } from './ingest-service.js';
import type { JobRepo } from './ingest-service.js';
import type { createSearchRepo } from '@job-system/database';
import { SOURCE_POLICY_NOTES, type SourceRegistry } from '@job-system/job-sources';
import type { Logger } from '@job-system/observability';
import type { RateLimiter } from './rate-limiter.js';

export interface SearchServiceDeps {
  searchRepo: ReturnType<typeof createSearchRepo>;
  jobRepo: JobRepo;
  registry: SourceRegistry;
  ingestService: IngestService;
  logger: Logger;
  clock: Clock;
  rateLimiter: RateLimiter;
  thresholds: DedupThresholds;
  /** Max redirect-enrichment requests per source run (0 disables). */
  enrichmentMaxPerRun: number;
}

export interface SourceCounters {
  discovered: number;
  new: number;
  duplicated: number;
  rejected: number;
  errors: number;
}

export interface SourceRunOutcome extends SourceCounters {
  sourceKey: string;
  status: 'completed' | 'failed' | 'skipped';
  errorClass?: string;
  reviewIds: string[];
}

export interface RunSourceOptions {
  attempt: number;
  maxAttempts: number;
}

const MAX_PAGES = 10;

function parseFilters(filters: unknown): HardFilterConfig {
  if (typeof filters !== 'object' || filters === null) return {};
  const record = filters as Record<string, unknown>;
  const asStrings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined;
  return {
    ...(asStrings(record['excludedCompanies']) === undefined
      ? {}
      : { excludedCompanies: asStrings(record['excludedCompanies'])! }),
    ...(asStrings(record['excludedKeywords']) === undefined
      ? {}
      : { excludedKeywords: asStrings(record['excludedKeywords'])! }),
    ...(asStrings(record['requiredKeywords']) === undefined
      ? {}
      : { requiredKeywords: asStrings(record['requiredKeywords'])! }),
    ...(asStrings(record['allowedCountries']) === undefined
      ? {}
      : { allowedCountries: asStrings(record['allowedCountries'])! }),
    ...(Array.isArray(record['allowedRemoteTypes'])
      ? { allowedRemoteTypes: record['allowedRemoteTypes'] as HardFilterConfig['allowedRemoteTypes'] }
      : {}),
  };
}

export function createSearchService(deps: SearchServiceDeps) {
  return {
    /** Creates the parent run and one child row per configured source. */
    async startRun(searchConfigId: string, trace: TraceContext, logger: Logger = deps.logger) {
      const config = await deps.searchRepo.getConfig(searchConfigId);
      const run = await deps.searchRepo.createRun(searchConfigId, trace.correlationId);
      const sources: Array<{ key: string; sourceId: string }> = [];

      for (const key of config.sources) {
        const adapter = deps.registry.get(key);
        if (!adapter) {
          logger.warn({ searchRunId: run.id, sourceKey: key }, 'configured source has no adapter');
          continue;
        }
        const existing = await deps.jobRepo.getSourceByKey(key);
        const sourceRow =
          existing ??
          (await deps.jobRepo.upsertSource({
            key,
            name: key,
            kind: 'api',
            capabilities: { ...adapter.capabilities },
            policyNotes: SOURCE_POLICY_NOTES[key] ?? null,
          }));
        const sourceRun = await deps.searchRepo.createSourceRun(run.id, sourceRow.id, trace.correlationId);

        if (sourceRow.status !== 'active') {
          await deps.searchRepo.finishSourceRun(sourceRun.id, {
            status: 'skipped',
            jobsDiscovered: 0,
            jobsNew: 0,
            jobsDuplicated: 0,
            jobsRejected: 0,
            errors: 0,
            durationMs: 0,
            errorClass: `Source${sourceRow.status}`,
            errorDetail: `source status is '${sourceRow.status}'; execution skipped`,
          });
          logger.warn({ searchRunId: run.id, sourceKey: key, status: sourceRow.status }, 'source skipped by policy');
          continue;
        }

        sources.push({ key, sourceId: sourceRow.id });
      }

      return { searchRunId: run.id, sources };
    },

    /** Executes one source child run: rate-limited pages, ingest each offer. */
    async runSource(
      input: { searchRunId: string; sourceKey: string },
      trace: TraceContext,
      logger: Logger = deps.logger,
      options: RunSourceOptions = { attempt: 1, maxAttempts: 1 },
    ): Promise<SourceRunOutcome> {
      const sourceLogger = logger.child({ sourceId: input.sourceKey });
      const run = await deps.searchRepo.getRun(input.searchRunId);
      const config = await deps.searchRepo.getConfig(run.searchConfigId);
      const adapter = deps.registry.require(input.sourceKey);
      const sourceRow = await deps.jobRepo.getSourceByKey(input.sourceKey);
      if (!sourceRow) throw new Error(`Source row missing for '${input.sourceKey}'`);

      const sourceRuns = await deps.searchRepo.listSourceRuns(input.searchRunId);
      const sourceRun = sourceRuns.find((entry) => entry.sourceKey === input.sourceKey)?.run;
      if (!sourceRun) throw new Error(`Source run missing for '${input.sourceKey}'`);

      const policy = {
        thresholds: deps.thresholds,
        filters: parseFilters(config.filters),
        ...(deps.enrichmentMaxPerRun > 0
          ? { enrichmentBudget: { remaining: deps.enrichmentMaxPerRun } }
          : {}),
      };
      const limitPerMinute = adapter.capabilities.rateLimitPerMinute ?? 30;
      const startedAt = Date.now();
      const counters: SourceCounters = { discovered: 0, new: 0, duplicated: 0, rejected: 0, errors: 0 };
      const reviewIds: string[] = [];

      try {
        let page = 1;
        let hasMore = true;
        while (hasMore && page <= MAX_PAGES) {
          await deps.rateLimiter.acquire(input.sourceKey, 'search', limitPerMinute, sourceLogger);
          const result = await adapter.searchJobs({
            keywords: config.keywords,
            locations: config.locations,
            ...(config.remote === null ? {} : { remote: config.remote }),
            page,
            pageSize: adapter.capabilities.pageSize,
          });
          for (const raw of result.jobs) {
            counters.discovered += 1;
            const ingestResult = await deps.ingestService.ingestRaw(
              raw,
              adapter,
              sourceRow.id,
              trace,
              policy,
              sourceLogger,
            );
            if (ingestResult.reviewId) reviewIds.push(ingestResult.reviewId);
            if (ingestResult.outcome === 'new') counters.new += 1;
            else if (ingestResult.outcome === 'rejected') counters.rejected += 1;
            else counters.duplicated += 1;
          }
          hasMore = result.hasMore;
          page += 1;
        }

        sourceLogger.info(
          {
            searchRunId: input.searchRunId,
            discovered: counters.discovered,
            new: counters.new,
            duplicated: counters.duplicated,
            rejected: counters.rejected,
            durationMs: Date.now() - startedAt,
          },
          'source run completed',
        );
        await deps.searchRepo.finishSourceRun(sourceRun.id, {
          status: 'completed',
          jobsDiscovered: counters.discovered,
          jobsNew: counters.new,
          jobsDuplicated: counters.duplicated,
          jobsRejected: counters.rejected,
          errors: 0,
          durationMs: Date.now() - startedAt,
        });
        return { sourceKey: input.sourceKey, status: 'completed', reviewIds, ...counters };
      } catch (error) {
        const retryable = isAppError(error) && error.retryable;
        if (error instanceof RateLimitedError) {
          const retryAfterMs = error.context?.['retryAfterMs'];
          await deps.rateLimiter.penalize(
            input.sourceKey,
            'search',
            typeof retryAfterMs === 'number' ? retryAfterMs : null,
            sourceLogger,
          );
        }

        if (retryable && options.attempt < options.maxAttempts) {
          sourceLogger.warn(
            { searchRunId: input.searchRunId, attempt: options.attempt, maxAttempts: options.maxAttempts, errorClass: error.name },
            'retryable source failure; BullMQ will retry with backoff',
          );
          throw error;
        }

        counters.errors += 1;
        const errorClass = error instanceof Error ? error.name : 'UnknownError';
        const errorDetail = error instanceof Error ? error.message : String(error);
        await deps.searchRepo.finishSourceRun(sourceRun.id, {
          status: 'failed',
          jobsDiscovered: counters.discovered,
          jobsNew: counters.new,
          jobsDuplicated: counters.duplicated,
          jobsRejected: counters.rejected,
          errors: counters.errors,
          durationMs: Date.now() - startedAt,
          errorClass,
          errorDetail,
        });
        sourceLogger.warn(
          { searchRunId: input.searchRunId, errorClass, attempt: options.attempt },
          'source run failed',
        );
        return { sourceKey: input.sourceKey, status: 'failed', errorClass, reviewIds, ...counters };
      }
    },
  };
}

export type SearchService = ReturnType<typeof createSearchService>;