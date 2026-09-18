import { z } from 'zod';
import {
  NormalizedJobSchema,
  SourcePermanentError,
  ValidationError,
  normalizeCanonicalUrl,
  type DetectedApplicationTarget,
  type HttpClient,
  type JobSourceAdapter,
  type NormalizedJob,
  type RawJob,
  type SourceCapabilities,
  type SourceSearchQuery,
  type SourceSearchResult,
} from '@job-system/core';
import { createFetchHttpClient } from '../http/fetch-client.js';
import { htmlToText, parseJobType } from '../util/text.js';
import { detectAtsFromUrl } from '../util/targets.js';
import { evaluateSearchQuery } from '../util/search-query.js';

export const ARBEITNOW_POLICY_NOTES = [
  'method: public JSON API (arbeitnow.com/api/job-board-api, paginated)',
  'reviewed: 2026-09-18',
  'terms: Public API available. Usage subject to provider terms and link-back expectations. Used for personal job discovery.',
  'no CAPTCHA/anti-bot bypass; client uses an identifying User-Agent as a transparency measure',
  'rate limit: self-imposed 10 req/min (none published)',
].join('; ');

const ArbeitnowJobSchema = z.object({
  slug: z.string(),
  company_name: z.string(),
  title: z.string(),
  description: z.string(),
  remote: z.boolean(),
  url: z.string().url(),
  tags: z.array(z.string()).default([]),
  job_types: z.array(z.string()).default([]),
  location: z.string(),
  created_at: z.number(),
});
export type ArbeitnowJob = z.infer<typeof ArbeitnowJobSchema>;

const ArbeitnowResponseSchema = z.object({
  data: z.array(ArbeitnowJobSchema),
  links: z
    .object({ next: z.string().nullable().optional() })
    .optional(),
});

export interface ArbeitnowOptions {
  http?: HttpClient;
  baseUrl?: string;
  pageSize?: number;
}

export function createArbeitnowAdapter(options: ArbeitnowOptions = {}): JobSourceAdapter {
  const http = options.http ?? createFetchHttpClient();
  const baseUrl = options.baseUrl ?? 'https://www.arbeitnow.com';
  const pageSize = options.pageSize ?? 25;

  const capabilities: SourceCapabilities = {
    requiresHumanLogin: false,
    supportsPagination: true,
    pageSize,
    rateLimitPerMinute: 10,
  };

  async function fetchPage(page: number): Promise<{ jobs: ArbeitnowJob[]; hasMore: boolean }> {
    const response = await http.request(`${baseUrl}/api/job-board-api?page=${page}`);
    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new SourcePermanentError('Arbeitnow API returned invalid JSON');
    }
    const parsed = ArbeitnowResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new SourcePermanentError('Arbeitnow API response schema changed', {
        context: { issues: parsed.error.issues.length },
      });
    }
    return {
      jobs: parsed.data.data,
      hasMore: Boolean(parsed.data.links?.next) && parsed.data.data.length > 0,
    };
  }

  return {
    key: 'arbeitnow',
    capabilities,

    async searchJobs(query: SourceSearchQuery): Promise<SourceSearchResult> {
      const page = query.page < 1 ? 1 : query.page;
      const result = await fetchPage(page);
      // The provider has no server-side query parameters: apply the
      // deterministic local matcher so SearchConfig is respected.
      const relevant = result.jobs.filter(
        (job) =>
          evaluateSearchQuery(
            {
              title: job.title,
              description: htmlToText(job.description),
              company: job.company_name,
              tags: job.tags,
              location: job.location.length > 0 ? job.location : null,
              remoteType: job.remote ? 'remote' : 'onsite',
            },
            query,
          ).matches,
      );
      return {
        jobs: relevant.map((job) => ({
          sourceKey: 'arbeitnow',
          externalId: job.slug,
          fetchedAt: new Date(),
          data: job,
        })),
        page,
        hasMore: result.hasMore,
      };
    },

    async fetchJob(externalId: string): Promise<RawJob | null> {
      for (let page = 1; page <= 5; page += 1) {
        const result = await fetchPage(page);
        const job = result.jobs.find((candidate) => candidate.slug === externalId);
        if (job) {
          return { sourceKey: 'arbeitnow', externalId, fetchedAt: new Date(), data: job };
        }
        if (!result.hasMore) break;
      }
      return null;
    },

    normalizeJob(raw: RawJob): NormalizedJob {
      const parsed = ArbeitnowJobSchema.safeParse(raw.data);
      if (!parsed.success) {
        throw new ValidationError('Malformed Arbeitnow job payload', {
          context: {
            externalId: raw.externalId,
            issues: parsed.error.issues.map((issue) => issue.path.join('.')),
          },
        });
      }
      const job = parsed.data;
      return NormalizedJobSchema.parse({
        externalId: job.slug,
        canonicalUrl: normalizeCanonicalUrl(job.url),
        company: job.company_name,
        title: job.title,
        description: htmlToText(job.description),
        location: job.location.length > 0 ? job.location : null,
        remoteType: job.remote ? 'remote' : 'onsite',
        employmentType: parseJobType(job.job_types[0]),
        salaryMin: null,
        salaryMax: null,
        currency: null,
        experienceLevel: null,
        languageRequirements: [],
        publishedAt: new Date(job.created_at * 1000),
        expiresAt: null,
        applicationMethod: 'external_form',
      });
    },

    detectApplicationTarget(raw: RawJob): DetectedApplicationTarget | null {
      const parsed = ArbeitnowJobSchema.safeParse(raw.data);
      if (!parsed.success) return null;
      const detected = detectAtsFromUrl(parsed.data.url);
      return detected ? { platformKey: detected.key, signal: 'metadata' } : null;
    },

    resolveTargetUrl(raw: RawJob): string | null {
      const parsed = ArbeitnowJobSchema.safeParse(raw.data);
      return parsed.success ? parsed.data.url : null;
    },
  };
}