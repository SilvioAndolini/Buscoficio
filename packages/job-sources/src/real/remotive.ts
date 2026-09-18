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
import { htmlToText, parseJobType, parseSalaryRange } from '../util/text.js';
import { detectAtsFromUrl } from '../util/targets.js';
import { evaluateSearchQuery } from '../util/search-query.js';

export const REMOTIVE_POLICY_NOTES = [
  'method: public JSON API (remotive.com/api/remote-jobs)',
  'reviewed: 2026-09-18',
  'terms: Public API available. Usage subject to provider terms and attribution/link-back expectations. Used for personal job discovery.',
  'no CAPTCHA/anti-bot bypass; client uses an identifying User-Agent as a transparency measure',
  'rate limit: self-imposed 10 req/min (none published)',
].join('; ');

const RemotiveJobSchema = z.object({
  id: z.number(),
  url: z.string().url(),
  title: z.string(),
  company_name: z.string(),
  description: z.string(),
  candidate_required_location: z.string().nullish(),
  job_type: z.string().nullish(),
  publication_date: z.string(),
  salary: z.string().nullish(),
  tags: z.array(z.string()).optional(),
});
export type RemotiveJob = z.infer<typeof RemotiveJobSchema>;

const RemotiveResponseSchema = z.object({ jobs: z.array(RemotiveJobSchema) });

export interface RemotiveOptions {
  http?: HttpClient;
  baseUrl?: string;
  pageSize?: number;
}

export function createRemotiveAdapter(options: RemotiveOptions = {}): JobSourceAdapter {
  const http = options.http ?? createFetchHttpClient();
  const baseUrl = options.baseUrl ?? 'https://remotive.com';
  const pageSize = options.pageSize ?? 20;

  const capabilities: SourceCapabilities = {
    requiresHumanLogin: false,
    supportsPagination: false,
    pageSize,
    rateLimitPerMinute: 10,
  };

  async function fetchPage(query: SourceSearchQuery): Promise<RemotiveJob[]> {
    const search =
      query.keywords.length > 0 ? `&search=${encodeURIComponent(query.keywords.join(' '))}` : '';
    const response = await http.request(`${baseUrl}/api/remote-jobs?limit=${pageSize}${search}`);
    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new SourcePermanentError('Remotive API returned invalid JSON');
    }
    const parsed = RemotiveResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new SourcePermanentError('Remotive API response schema changed', {
        context: { issues: parsed.error.issues.length },
      });
    }
    return parsed.data.jobs;
  }

  return {
    key: 'remotive',
    capabilities,

    async searchJobs(query: SourceSearchQuery): Promise<SourceSearchResult> {
      const jobs = await fetchPage(query);
      // Server-side search is used as a hint; the deterministic local matcher
      // is the authority so SearchConfig (keywords/locations/remote) is always
      // respected, even if the provider matches loosely.
      const relevant = jobs.filter(
        (job) =>
          evaluateSearchQuery(
            {
              title: job.title,
              description: htmlToText(job.description),
              company: job.company_name,
              tags: job.tags ?? [],
              location: job.candidate_required_location ?? null,
              remoteType: 'remote',
            },
            query,
          ).matches,
      );
      return {
        jobs: relevant.map((job) => ({
          sourceKey: 'remotive',
          externalId: String(job.id),
          fetchedAt: new Date(),
          data: job,
        })),
        page: query.page,
        hasMore: false,
      };
    },

    async fetchJob(externalId: string): Promise<RawJob | null> {
      const jobs = await fetchPage({ keywords: [], page: 1 });
      const job = jobs.find((candidate) => String(candidate.id) === externalId);
      return job
        ? { sourceKey: 'remotive', externalId, fetchedAt: new Date(), data: job }
        : null;
    },

    normalizeJob(raw: RawJob): NormalizedJob {
      const parsed = RemotiveJobSchema.safeParse(raw.data);
      if (!parsed.success) {
        throw new ValidationError('Malformed Remotive job payload', {
          context: {
            externalId: raw.externalId,
            issues: parsed.error.issues.map((issue) => issue.path.join('.')),
          },
        });
      }
      const job = parsed.data;
      const salary = parseSalaryRange(job.salary);
      return NormalizedJobSchema.parse({
        externalId: String(job.id),
        canonicalUrl: normalizeCanonicalUrl(job.url),
        company: job.company_name,
        title: job.title,
        description: htmlToText(job.description),
        location: job.candidate_required_location ?? null,
        remoteType: 'remote',
        employmentType: parseJobType(job.job_type),
        salaryMin: salary.min,
        salaryMax: salary.max,
        currency: salary.currency,
        experienceLevel: null,
        languageRequirements: [],
        publishedAt: new Date(job.publication_date),
        expiresAt: null,
        applicationMethod: 'external_form',
      });
    },

    detectApplicationTarget(raw: RawJob): DetectedApplicationTarget | null {
      const parsed = RemotiveJobSchema.safeParse(raw.data);
      if (!parsed.success) return null;
      const detected = detectAtsFromUrl(parsed.data.url);
      return detected ? { platformKey: detected.key, signal: 'metadata' } : null;
    },

    resolveTargetUrl(raw: RawJob): string | null {
      const parsed = RemotiveJobSchema.safeParse(raw.data);
      return parsed.success ? parsed.data.url : null;
    },
  };
}