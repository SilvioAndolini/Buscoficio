import {
  computeDedupKey,
  computeJobContentHash,
  computeUrlHash,
  evaluateHardFilters,
  isAppError,
  type HardFilterConfig,
  type IngestResult,
  type JobSourceAdapter,
  type RawJob,
  type TraceContext,
} from '@job-system/core';
import type { Clock, DedupThresholds } from '@job-system/core';
import type { createJobRepo } from '@job-system/database';
import type { IngestJobData } from '@job-system/database';
import type { Logger } from '@job-system/observability';
import type { EnrichmentBudget, TargetEnrichmentService } from './target-enrichment-service.js';

export type JobRepo = ReturnType<typeof createJobRepo>;

export interface IngestPolicy {
  thresholds: DedupThresholds;
  filters: HardFilterConfig;
  /** Present when the run allows redirect-based target enrichment. */
  enrichmentBudget?: EnrichmentBudget;
}

export interface IngestServiceDeps {
  jobRepo: JobRepo;
  clock: Clock;
  enrichment?: TargetEnrichmentService;
}

/**
 * Ingest use case: deterministic L0–L3 dedup, ApplicationTarget resolution,
 * hard eligibility filters (with explicit reasons) and quarantine for
 * malformed payloads — a bad offer never aborts the batch.
 */
export function createIngestService(deps: IngestServiceDeps) {
  async function ingestRaw(
    raw: RawJob,
    adapter: JobSourceAdapter,
    sourceId: string,
    _trace: TraceContext,
    policy: IngestPolicy,
    logger: Logger,
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

    let detected = adapter.detectApplicationTarget(raw);
    if (!detected && deps.enrichment && policy.enrichmentBudget && adapter.resolveTargetUrl) {
      const url = adapter.resolveTargetUrl(raw);
      if (url) {
        detected = await deps.enrichment.enrich({
          url,
          sourceKey: adapter.key,
          limitPerMinute: adapter.capabilities.rateLimitPerMinute ?? 30,
          logger,
          budget: policy.enrichmentBudget,
        });
      }
    }

    let applicationTargetId: string | null = null;
    let applicationTargetSignal: string | null = null;
    if (detected) {
      const target = await deps.jobRepo.upsertTarget({
        key: detected.platformKey,
        kind: 'ats_browser',
        platform: detected.platformKey.split('-')[0] ?? detected.platformKey,
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
      fuzzy: { thresholds: policy.thresholds },
    };
    const result = await deps.jobRepo.ingestJob(data);

    if (result.outcome === 'duplicate' || result.jobId === null) return result;

    const decision = evaluateHardFilters(
      {
        company: normalized.company,
        title: normalized.title,
        description: normalized.description,
        location: normalized.location,
        remoteType: normalized.remoteType,
      },
      policy.filters,
    );
    if (!decision.allowed) {
      await deps.jobRepo.markJobRejected(result.jobId, decision);
      return {
        ...result,
        outcome: 'rejected',
        reasons: [...result.reasons, ...decision.rejections.map((r) => `${r.rule}: ${r.reason}`)],
      };
    }

    return result;
  }

  return { ingestRaw };
}

export type IngestService = ReturnType<typeof createIngestService>;