import {
  computeDedupKey,
  computeJobContentHash,
  computeUrlHash,
  isAppError,
  type IngestResult,
  type JobSourceAdapter,
  type RawJob,
  type TraceContext,
} from '@job-system/core';
import type { Clock } from '@job-system/core';
import type { createJobRepo} from '@job-system/database';
import { type IngestJobData } from '@job-system/database';

export type JobRepo = ReturnType<typeof createJobRepo>;

export interface IngestServiceDeps {
  jobRepo: JobRepo;
  clock: Clock;
}

/**
 * Ingest use case (orchestration lives in the composition root; persistence in
 * `@job-system/database`). Deterministic L0–L2 dedup, quarantine on malformed
 * payloads — a bad offer never aborts the batch.
 */
export function createIngestService(deps: IngestServiceDeps) {
  async function ingestRaw(
    raw: RawJob,
    adapter: JobSourceAdapter,
    sourceId: string,
    _trace: TraceContext,
  ): Promise<IngestResult> {
    let normalized;
    try {
      normalized = adapter.normalizeJob(raw);
    } catch (error) {
      if (isAppError(error) && error.code === 'VALIDATION_ERROR') {
        await deps.jobRepo.insertQuarantine({
          sourceId,
          externalId: raw.externalId,
          raw: raw.data,
          errors: error.context?.['issues'] ?? error.message,
        });
        return {
          outcome: 'rejected',
          listingId: null,
          jobId: null,
          reasons: [error.message],
        };
      }
      throw error;
    }

    const detected = adapter.detectApplicationTarget(raw);
    let applicationTargetId: string | null = null;
    let applicationTargetSignal: string | null = null;
    if (detected) {
      const target = await deps.jobRepo.upsertTarget({
        key: detected.platformKey,
        kind: 'ats_browser',
        platform: detected.platformKey,
        label: detected.platformKey,
        baseUrl: detected.baseUrl ?? null,
      });
      applicationTargetId = target.id;
      applicationTargetSignal = detected.signal;
    }

    const data: IngestJobData = {
      sourceId,
      externalId: normalized.externalId,
      applicationTargetId,
      applicationTargetSignal,
      normalized,
      urlHash: computeUrlHash(normalized.canonicalUrl),
      dedupKey: computeDedupKey(normalized),
      contentHash: computeJobContentHash({
        company: normalized.company,
        title: normalized.title,
        description: normalized.description,
        location: normalized.location,
        remoteType: normalized.remoteType,
        employmentType: normalized.employmentType,
        salaryMin: normalized.salaryMin,
        salaryMax: normalized.salaryMax,
        currency: normalized.currency,
        experienceLevel: normalized.experienceLevel,
        languageRequirements: normalized.languageRequirements,
      }),
      discoveredAt: deps.clock.now(),
      raw: raw.data,
    };
    return deps.jobRepo.ingestJob(data);
  }

  return { ingestRaw };
}

export type IngestService = ReturnType<typeof createIngestService>;