import { createHash } from 'node:crypto';

/**
 * Deterministic, compact, BullMQ-safe id component.
 * BullMQ custom job ids must not contain ':' and must not embed raw external
 * values; unsafe values are slugified + hashed (deterministic).
 * Final idempotency always relies on Postgres constraints, never on BullMQ ids.
 */
export function safeQueueIdPart(value: string): string {
  if (/^[A-Za-z0-9._-]{1,64}$/.test(value)) return value;
  const hash = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug.length > 0 ? `${slug}-${hash}` : hash;
}

/**
 * Deterministic BullMQ job id helpers shared by API (producer) and worker
 * (consumer). Format follows doc 06 §3.
 */
export function searchRunJobId(searchConfigId: string, scheduledEpochMs: number): string {
  return `search-${safeQueueIdPart(searchConfigId)}-${scheduledEpochMs}`;
}

export function ingestSourceJobId(searchRunId: string, sourceKey: string): string {
  return `search-src-${safeQueueIdPart(searchRunId)}-${safeQueueIdPart(sourceKey)}`;
}

/** BullMQ Job Scheduler id for a SearchConfig (one scheduler per config). */
export function schedulerIdForSearchConfig(searchConfigId: string): string {
  return `search-config-${safeQueueIdPart(searchConfigId)}`;
}