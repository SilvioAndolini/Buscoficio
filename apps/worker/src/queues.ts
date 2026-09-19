import IORedis from 'ioredis';
import { Queue, type JobsOptions } from 'bullmq';
import { ingestSourceJobId, matchJobId, searchRunJobId } from '@job-system/shared';

export { ingestSourceJobId, matchJobId, searchRunJobId };

/**
 * Queue topology (architecture doc 06):
 *  - search: run orchestration + idempotent finalizer
 *  - ingest: per-source fan-out (writes only its own SearchSourceRun row)
 *  - match: deterministic scoring (Phase 3)
 *  - documents: application document preparation (Phase 4)
 *  - maintenance: smoke/periodic jobs
 */
export const QUEUE_SEARCH = 'search';
export const QUEUE_INGEST = 'ingest';
export const QUEUE_MATCH = 'match';
export const QUEUE_DOCUMENTS = 'documents';
export const QUEUE_MAINTENANCE = 'maintenance';
export const QUEUE_DEDUP_REVIEW = 'dedup-review';
export const WORKER_QUEUES = [
  QUEUE_SEARCH,
  QUEUE_INGEST,
  QUEUE_MATCH,
  QUEUE_DOCUMENTS,
  QUEUE_MAINTENANCE,
  QUEUE_DEDUP_REVIEW,
] as const;

export type WorkerQueue = (typeof WORKER_QUEUES)[number];

/** Backwards-compatible alias (Phase 1 name). */
export const PHASE1_QUEUES = WORKER_QUEUES;

export function createRedisConnection(url: string): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export function createQueues(connection: IORedis, prefix?: string): Record<WorkerQueue, Queue> {
  const options = prefix === undefined ? {} : { prefix };
  return {
    [QUEUE_SEARCH]: new Queue(QUEUE_SEARCH, { connection, ...options }),
    [QUEUE_INGEST]: new Queue(QUEUE_INGEST, { connection, ...options }),
    [QUEUE_MATCH]: new Queue(QUEUE_MATCH, { connection, ...options }),
    [QUEUE_DOCUMENTS]: new Queue(QUEUE_DOCUMENTS, { connection, ...options }),
    [QUEUE_MAINTENANCE]: new Queue(QUEUE_MAINTENANCE, { connection, ...options }),
    [QUEUE_DEDUP_REVIEW]: new Queue(QUEUE_DEDUP_REVIEW, { connection, ...options }),
  };
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: 500,
  removeOnFail: 1_000,
};

/**
 * BullMQ job ids must not contain ':' (doc 06 §3).
 * Deterministic ids for logical exactly-once; Postgres constraints remain the
 * final idempotency defense.
 *
 * Note: the finalizer job intentionally does NOT use a deterministic custom id.
 * It is idempotent by design (ADR-016) and multiple runs are safe; BullMQ job
 * ids are never the idempotency mechanism (doc 06 §3).
 */
export function finalizeJobName(): string {
  return 'search.finalize';
}