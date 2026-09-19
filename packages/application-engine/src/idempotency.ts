import { sha256Hex, type ApplicationMode } from '@job-system/core';

/**
 * Deterministic identity of application commands (task §16/§67). Same logical
 * request ⇒ same key ⇒ the unique index returns the existing row; never rely
 * on BullMQ ids or SELECT-before-INSERT.
 */

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, sortValue(entry)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export interface ApplicationIdempotencyInput {
  candidateId: string;
  jobId: string;
  matchId: string;
  mode: ApplicationMode;
  supersedesApplicationId: string | null;
}

/** Represents the full creation command: candidate, job, match, mode, supersedes. */
export function computeApplicationIdempotencyKey(input: ApplicationIdempotencyInput): string {
  return sha256Hex(
    canonicalJson({
      candidateId: input.candidateId,
      jobId: input.jobId,
      matchId: input.matchId,
      mode: input.mode,
      supersedesApplicationId: input.supersedesApplicationId ?? 'none',
    }),
  );
}

export interface PreparationInputHashInput {
  applicationId: string;
  matchId: string;
  sourceResumeVersionId: string | null;
  profileFactsHash: string;
  jobContentHash: string;
  promptVersion: string;
  provider: string;
  model: string;
}

/**
 * Document preparation identity: same inputs ⇒ same hash ⇒ existing documents
 * are reused instead of duplicated (task §67).
 */
export function computePreparationInputHash(input: PreparationInputHashInput): string {
  return sha256Hex(
    [
      input.applicationId,
      input.matchId,
      input.sourceResumeVersionId ?? 'none',
      input.profileFactsHash,
      input.jobContentHash,
      input.promptVersion,
      `${input.provider}:${input.model}`,
    ].join('|'),
  );
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
