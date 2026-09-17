import IORedis from 'ioredis';
import { Queue, type JobsOptions } from 'bullmq';
import { ingestSourceJobId, searchRunJobId } from '@job-system/shared';

export { ingestSourceJobId, searchRunJobId };

/**
 * Queue topology for Phase 1 (architecture doc 06):
 *  - search: run orchestration + idempotent finalizer
 *  - ingest: per-source fan-out (writes only its own SearchSourceRun row)
 *  - maintenance: smoke/periodic jobs
 */
export const QUEUE_SEARCH = 'search';
export const QUEUE_INGEST = 'ingest';
export const QUEUE_MAINTENANCE = 'maintenance';
export const PHASE1_QUEUES = [QUEUE_SEARCH, QUEUE_INGEST, QUEUE_MAINTENANCE] as const;

export type Phase1Queue = (typeof PHASE1_QUEUES)[number];

export function createRedisConnection(url: string): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export function createQueues(connection: IORedis, prefix?: string): Record<Phase1Queue, Queue> {
  const options = prefix === undefined ? {} : { prefix };
  return {
    [QUEUE_SEARCH]: new Queue(QUEUE_SEARCH, { connection, ...options }),
    [QUEUE_INGEST]: new Queue(QUEUE_INGEST, { connection, ...options }),
    [QUEUE_MAINTENANCE]: new Queue(QUEUE_MAINTENANCE, { connection, ...options }),
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