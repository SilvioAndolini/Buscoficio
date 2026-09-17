import type { Job, Queue } from 'bullmq';
import type { Logger } from '@job-system/observability';
import type { SearchService } from './services/search-service.js';
import type { createSearchRepo } from '@job-system/database';
import type { Phase1Queue } from './queues.js';
import { ingestSourceJobId } from './queues.js';

export interface JobHandlerDeps {
  queues: Record<Phase1Queue, Queue>;
  searchService: SearchService;
  searchRepo: ReturnType<typeof createSearchRepo>;
  logger: Logger;
}

function readString(data: unknown, key: string): string {
  if (typeof data === 'object' && data !== null && key in data) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  throw new Error(`job payload missing '${key}'`);
}

export function createJobHandlers(deps: JobHandlerDeps) {
  return {
    'maintenance.smoke': async (job: Job) => {
      return { ok: true, echoed: job.data as unknown };
    },

    'search.run': async (job: Job) => {
      const searchConfigId = readString(job.data, 'searchConfigId');
      const correlationId = readString(job.data, 'correlationId');
      const run = await deps.searchService.startRun(searchConfigId, {
        correlationId,
        ...(job.id === undefined ? {} : { jobId: job.id }),
      });
      for (const source of run.sources) {
        await deps.queues.ingest.add(
          'ingest.source',
          { searchRunId: run.searchRunId, sourceKey: source.key, correlationId },
          { jobId: ingestSourceJobId(run.searchRunId, source.key), attempts: 1 },
        );
      }
      if (run.sources.length === 0) {
        await deps.queues.search.add(
          'search.finalize',
          { searchRunId: run.searchRunId, correlationId },
          { attempts: 1 },
        );
      }
      return { searchRunId: run.searchRunId, sources: run.sources.map((source) => source.key) };
    },

    'ingest.source': async (job: Job) => {
      const searchRunId = readString(job.data, 'searchRunId');
      const sourceKey = readString(job.data, 'sourceKey');
      const correlationId = readString(job.data, 'correlationId');
      const outcome = await deps.searchService.runSource(
        { searchRunId, sourceKey },
        { correlationId, ...(job.id === undefined ? {} : { jobId: job.id }), sourceId: sourceKey },
      );
      await deps.queues.search.add(
        'search.finalize',
        { searchRunId, correlationId },
        { attempts: 1 },
      );
      return outcome;
    },

    'search.finalize': async (job: Job) => {
      const searchRunId = readString(job.data, 'searchRunId');
      const result = await deps.searchRepo.finalizeRun(searchRunId);
      deps.logger.info(
        { searchRunId, status: result.status, finalized: result.finalized },
        'search run finalized',
      );
      return { searchRunId, status: result.status, finalized: result.finalized };
    },
  } satisfies Record<string, (job: Job) => Promise<unknown>>;
}

export type JobHandlers = ReturnType<typeof createJobHandlers>;