import type { DetectedApplicationTarget, HttpClient } from '@job-system/core';
import { detectAtsFromUrl, detectAtsFromUrls } from '@job-system/job-sources';
import type { Logger } from '@job-system/observability';
import type { RateLimiter } from './rate-limiter.js';

export interface EnrichmentBudget {
  remaining: number;
}

export interface TargetEnrichmentDeps {
  http: HttpClient;
  rateLimiter: RateLimiter;
}

export interface EnrichInput {
  url: string;
  sourceKey: string;
  limitPerMinute: number;
  logger: Logger;
  budget: EnrichmentBudget;
}

export interface TargetEnrichmentService {
  enrich(input: EnrichInput): Promise<DetectedApplicationTarget | null>;
}

/**
 * Optional redirect-based target enrichment. Only runs when metadata detection
 * found nothing, a URL exists and the per-run budget (and rate limiter) allow
 * it. The redirect loop stops as soon as a known ATS host appears in a
 * Location header, so no request is issued to the destination host.
 * Best-effort: failures never break ingestion.
 */
export function createTargetEnrichmentService(deps: TargetEnrichmentDeps): TargetEnrichmentService {
  return {
    async enrich(input: EnrichInput): Promise<DetectedApplicationTarget | null> {
      if (input.budget.remaining <= 0) return null;
      input.budget.remaining -= 1;

      const logger = input.logger.child({ component: 'target-enrichment' });
      const startedAt = Date.now();
      try {
        await deps.rateLimiter.acquire(
          input.sourceKey,
          'target-enrichment',
          input.limitPerMinute,
          logger,
        );
        const response = await deps.http.request(input.url, {
          maxRedirects: 5,
          stopWhen: (nextUrl) => detectAtsFromUrl(nextUrl) !== null,
        });
        const detected = detectAtsFromUrls([...response.redirects, response.finalUrl]);
        if (detected) {
          logger.info(
            {
              sourceKey: input.sourceKey,
              targetKey: detected.target.key,
              signal: 'redirect',
              durationMs: Date.now() - startedAt,
            },
            'target enrichment succeeded',
          );
          return { platformKey: detected.target.key, signal: 'redirect' };
        }
        logger.info(
          { sourceKey: input.sourceKey, durationMs: Date.now() - startedAt },
          'target enrichment unresolved',
        );
        return null;
      } catch (error) {
        logger.warn(
          {
            sourceKey: input.sourceKey,
            err: error,
            durationMs: Date.now() - startedAt,
          },
          'target enrichment failed',
        );
        return null;
      }
    },
  };
}