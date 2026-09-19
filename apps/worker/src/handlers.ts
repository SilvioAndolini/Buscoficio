import type { Job, Queue } from 'bullmq';
import { matchJobId, uuidv7 } from '@job-system/shared';
import type { Logger } from '@job-system/observability';
import type { SearchService } from './services/search-service.js';
import type { SchedulerService } from './services/scheduler-service.js';
import type { ReconciliationService } from './services/reconciliation-service.js';
import type { MatchingService } from './services/matching-service.js';
import type { ApplicationService } from './services/application-service.js';
import type { createCandidateRepo, createDedupRepo, createSearchRepo } from '@job-system/database';
import type { WorkerQueue } from './queues.js';
import { QUEUE_DEDUP_REVIEW, QUEUE_MATCH, ingestSourceJobId } from './queues.js';

export interface JobHandlerDeps {
  queues: Record<WorkerQueue, Queue>;
  searchService: SearchService;
  searchRepo: ReturnType<typeof createSearchRepo>;
  schedulerService: SchedulerService;
  reconciliationService: ReconciliationService;
  dedupRepo: ReturnType<typeof createDedupRepo>;
  candidateRepo: ReturnType<typeof createCandidateRepo>;
  matchingService: MatchingService;
  applicationService: ApplicationService;
  /** Part of the deterministic BullMQ job id for matching (`match-<job>-<v>`). */
  engineVersion: string;
  logger: Logger;
}

/** Every handler receives the job-scoped child logger (correlationId + jobId). */
export type JobHandler = (job: Job, logger: Logger) => Promise<unknown>;

function readString(data: unknown, key: string): string {
  if (typeof data === 'object' && data !== null && key in data) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  throw new Error(`job payload missing '${key}'`);
}

/** Scheduled jobs carry no correlationId in their template; generate one. */
function readCorrelationId(job: Job): string {
  const data = job.data as Record<string, unknown>;
  const value = data['correlationId'];
  return typeof value === 'string' && value.length > 0 ? value : uuidv7();
}

export function createJobHandlers(deps: JobHandlerDeps) {
  return {
    'maintenance.smoke': async (job: Job, logger: Logger) => {
      logger.debug({ echoed: job.data as unknown }, 'smoke payload received');
      return { ok: true, echoed: job.data as unknown };
    },

    'search.run': async (job: Job, logger: Logger) => {
      const searchConfigId = readString(job.data, 'searchConfigId');
      const correlationId = readCorrelationId(job);
      const run = await deps.searchService.startRun(
        searchConfigId,
        {
          correlationId,
          ...(job.id === undefined ? {} : { jobId: job.id }),
        },
        logger,
      );
      for (const source of run.sources) {
        await deps.queues.ingest.add(
          'ingest.source',
          { searchRunId: run.searchRunId, sourceKey: source.key, correlationId },
          {
            jobId: ingestSourceJobId(run.searchRunId, source.key),
            attempts: 3,
            backoff: { type: 'exponential', delay: 2_000 },
          },
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

    'ingest.source': async (job: Job, logger: Logger) => {
      const searchRunId = readString(job.data, 'searchRunId');
      const sourceKey = readString(job.data, 'sourceKey');
      const correlationId = readCorrelationId(job);
      const attempt = job.attemptsMade + 1;
      const maxAttempts = job.opts.attempts ?? 1;

      let outcome;
      try {
        outcome = await deps.searchService.runSource(
          { searchRunId, sourceKey },
          { correlationId, ...(job.id === undefined ? {} : { jobId: job.id }), sourceId: sourceKey },
          logger,
          { attempt, maxAttempts },
        );
      } catch (error) {
        logger.warn({ sourceKey, attempt, maxAttempts }, 'source run will be retried by BullMQ');
        throw error;
      }

      for (const reviewId of outcome.reviewIds) {
        await deps.queues[QUEUE_DEDUP_REVIEW].add(
          'dedup.review.signal',
          { reviewId, correlationId },
          { jobId: `dedup-signal-${reviewId}`, attempts: 1, removeOnComplete: 500 },
        );
      }

      // Phase 3: decoupled matching enqueue. Discovery must keep working if
      // matching is unavailable; failures here never revert the ingested Job.
      if (outcome.newJobIds.length > 0) {
        const profile = await deps.candidateRepo.getProfile();
        if (profile) {
          for (const jobId of outcome.newJobIds) {
            try {
              await deps.queues[QUEUE_MATCH].add(
                'match.score',
                { jobId, candidateId: profile.id, correlationId },
                {
                  jobId: matchJobId(jobId, deps.engineVersion),
                  attempts: 3,
                  backoff: { type: 'exponential', delay: 3_000 },
                  // Free the deterministic id after completion so later
                  // recomputation is never blocked (Postgres constraints are
                  // the real idempotency defense).
                  removeOnComplete: true,
                },
              );
            } catch (error) {
              logger.warn(
                { jobId, err: error },
                'matching enqueue failed; discovery result kept',
              );
            }
          }
        }
      }

      await deps.queues.search.add(
        'search.finalize',
        { searchRunId, correlationId },
        { attempts: 1 },
      );
      return outcome;
    },

    'match.score': async (job: Job, logger: Logger) => {
      const jobId = readString(job.data, 'jobId');
      const candidateId = readString(job.data, 'candidateId');
      const correlationId = readCorrelationId(job);
      return deps.matchingService.score(
        jobId,
        candidateId,
        {
          correlationId,
          ...(job.id === undefined ? {} : { jobId: job.id }),
        },
        logger,
      );
    },

    'documents.prepare': async (job: Job, logger: Logger) => {
      const applicationId = readString(job.data, 'applicationId');
      const correlationId = readCorrelationId(job);
      const result = await deps.applicationService.prepare(applicationId, {
        correlationId,
        applicationId,
      });
      logger.info(
        {
          applicationId,
          status: result.status,
          created: result.created,
          documents: result.documents.length,
          blockers: result.blockers.map((blocker) => blocker.code),
        },
        'application documents prepared',
      );
      return result;
    },

    'dedup.review.signal': async (job: Job, logger: Logger) => {
      const reviewId = readString(job.data, 'reviewId');
      const pending = await deps.dedupRepo.countPending();
      logger.info({ reviewId, pending }, 'dedup review pending (gray zone)');
      return { reviewId, pending };
    },

    'search.finalize': async (job: Job, logger: Logger) => {
      const searchRunId = readString(job.data, 'searchRunId');
      const result = await deps.searchRepo.finalizeRun(searchRunId);
      logger.info(
        { searchRunId, status: result.status, finalized: result.finalized },
        'search run finalized',
      );
      return { searchRunId, status: result.status, finalized: result.finalized };
    },

    'scheduler.sync': async (_job: Job, logger: Logger) => {
      const result = await deps.schedulerService.syncAll(logger);
      logger.info(result, 'scheduler sync completed');
      return result;
    },

    'maintenance.search-reconcile': async (_job: Job, logger: Logger) => {
      const result = await deps.reconciliationService.reconcileStaleRuns(logger);
      logger.info(result, 'watchdog reconciliation completed');
      return result;
    },
  } satisfies Record<string, JobHandler>;
}

export type JobHandlers = ReturnType<typeof createJobHandlers>;