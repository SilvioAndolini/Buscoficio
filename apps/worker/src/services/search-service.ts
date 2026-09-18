import type { Clock, TraceContext } from '@job-system/core';
import type { IngestService } from './ingest-service.js';
import type { JobRepo } from './ingest-service.js';
import type { createSearchRepo } from '@job-system/database';
import type { SourceRegistry } from '@job-system/job-sources';
import type { Logger } from '@job-system/observability';

export interface SearchServiceDeps {
  searchRepo: ReturnType<typeof createSearchRepo>;
  jobRepo: JobRepo;
  registry: SourceRegistry;
  ingestService: IngestService;
  logger: Logger;
  clock: Clock;
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
  status: 'completed' | 'failed';
  errorClass?: string;
}

const MAX_PAGES = 10;

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
        const sourceRow = await deps.jobRepo.upsertSource({
          key,
          name: key,
          kind: 'api',
          capabilities: { ...adapter.capabilities },
        });
        await deps.searchRepo.createSourceRun(run.id, sourceRow.id, trace.correlationId);
        sources.push({ key, sourceId: sourceRow.id });
      }

      return { searchRunId: run.id, sources };
    },

    /** Executes one source child run: search pages, ingest each raw offer. */
    async runSource(
      input: { searchRunId: string; sourceKey: string },
      trace: TraceContext,
      logger: Logger = deps.logger,
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

      const startedAt = Date.now();
      const counters: SourceCounters = { discovered: 0, new: 0, duplicated: 0, rejected: 0, errors: 0 };

      try {
        let page = 1;
        let hasMore = true;
        while (hasMore && page <= MAX_PAGES) {
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
            );
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
        return { sourceKey: input.sourceKey, status: 'completed', ...counters };
      } catch (error) {
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
          { searchRunId: input.searchRunId, errorClass },
          'source run failed',
        );
        return { sourceKey: input.sourceKey, status: 'failed', errorClass, ...counters };
      }
    },
  };
}

export type SearchService = ReturnType<typeof createSearchService>;