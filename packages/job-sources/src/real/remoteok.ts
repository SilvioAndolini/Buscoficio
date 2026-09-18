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
import { htmlToText, positiveOrNull } from '../util/text.js';
import { detectAtsFromUrls } from '../util/targets.js';
import { evaluateSearchQuery } from '../util/search-query.js';

export const REMOTEOK_POLICY_NOTES = [
  'method: public JSON API (remoteok.com/api)',
  'reviewed: 2026-09-18',
  'terms: Public API available. Attribution/link-back required by the provider. Used for personal job discovery.',
  'no CAPTCHA/anti-bot bypass; client uses an identifying User-Agent as a transparency measure',
  'rate limit: self-imposed 6 req/min (none published)',
].join('; ');

const RemoteOkItemSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  slug: z.string().optional(),
  company: z.string(),
  position: z.string(),
  description: z.string().optional().default(''),
  location: z.string().optional(),
  salary_min: z.number().optional(),
  salary_max: z.number().optional(),
  url: z.string().optional(),
  apply_url: z.string().optional(),
  date: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type RemoteOkItem = z.infer<typeof RemoteOkItemSchema>;

function isJobItem(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'position' in value &&
    'company' in value
  );
}

export interface RemoteOkOptions {
  http?: HttpClient;
  baseUrl?: string;
}

export function createRemoteOkAdapter(options: RemoteOkOptions = {}): JobSourceAdapter {
  const http = options.http ?? createFetchHttpClient();
  const baseUrl = options.baseUrl ?? 'https://remoteok.com';

  const capabilities: SourceCapabilities = {
    requiresHumanLogin: false,
    supportsPagination: false,
    pageSize: 100,
    rateLimitPerMinute: 6,
  };

  async function fetchItems(): Promise<unknown[]> {
    const response = await http.request(`${baseUrl}/api`);
    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new SourcePermanentError('RemoteOK API returned invalid JSON');
    }
    if (!Array.isArray(payload)) {
      throw new SourcePermanentError('RemoteOK API response schema changed (expected array)');
    }
    // First element is the legal/attribution notice, not a job.
    return payload.filter(isJobItem);
  }

  function externalIdOf(item: unknown): string | null {
    if (typeof item !== 'object' || item === null) return null;
    const record = item as Record<string, unknown>;
    const id = record['id'];
    if (typeof id === 'number' || typeof id === 'string') return String(id);
    const slug = record['slug'];
    if (typeof slug === 'string' && slug.length > 0) return slug;
    return null;
  }

  return {
    key: 'remoteok',
    capabilities,

    async searchJobs(query: SourceSearchQuery): Promise<SourceSearchResult> {
      const items = await fetchItems();
      const jobs: RawJob[] = [];
      for (const item of items) {
        const externalId = externalIdOf(item);
        if (!externalId) continue;
        const parsed = RemoteOkItemSchema.safeParse(item);
        if (!parsed.success) continue;
        // No server-side query parameters: deterministic local matcher.
        const matches = evaluateSearchQuery(
          {
            title: parsed.data.position,
            description: htmlToText(parsed.data.description),
            company: parsed.data.company,
            tags: parsed.data.tags ?? [],
            location:
              parsed.data.location && parsed.data.location.length > 0 ? parsed.data.location : null,
            remoteType: 'remote',
          },
          query,
        ).matches;
        if (!matches) continue;
        jobs.push({ sourceKey: 'remoteok', externalId, fetchedAt: new Date(), data: item });
      }
      return { jobs, page: 1, hasMore: false };
    },

    async fetchJob(externalId: string): Promise<RawJob | null> {
      const items = await fetchItems();
      const item = items.find((candidate) => externalIdOf(candidate) === externalId);
      if (!item) return null;
      const parsed = RemoteOkItemSchema.safeParse(item);
      const offerUrl = parsed.success ? parsed.data.url ?? parsed.data.apply_url : undefined;
      const redirects = offerUrl ? await collectRedirects(http, offerUrl) : [];
      return {
        sourceKey: 'remoteok',
        externalId,
        fetchedAt: new Date(),
        data: item,
        ...(redirects.length === 0 ? {} : { redirects }),
      };
    },

    normalizeJob(raw: RawJob): NormalizedJob {
      const parsed = RemoteOkItemSchema.safeParse(raw.data);
      if (!parsed.success) {
        throw new ValidationError('Malformed RemoteOK job payload', {
          context: {
            externalId: raw.externalId,
            issues: parsed.error.issues.map((issue) => issue.path.join('.')),
          },
        });
      }
      const item = parsed.data;
      const url = item.url ?? item.apply_url;
      if (!url) {
        throw new ValidationError('RemoteOK job payload has no url', {
          context: { externalId: raw.externalId },
        });
      }
      return NormalizedJobSchema.parse({
        externalId: raw.externalId,
        canonicalUrl: normalizeCanonicalUrl(url),
        company: item.company,
        title: item.position,
        description: htmlToText(item.description),
        location: item.location && item.location.length > 0 ? item.location : null,
        remoteType: 'remote',
        employmentType: null,
        salaryMin: positiveOrNull(item.salary_min ?? null),
        salaryMax: positiveOrNull(item.salary_max ?? null),
        currency: null,
        experienceLevel: null,
        languageRequirements: [],
        publishedAt: item.date ? new Date(item.date) : new Date(),
        expiresAt: null,
        applicationMethod: 'external_form',
      });
    },

    detectApplicationTarget(raw: RawJob): DetectedApplicationTarget | null {
      const parsed = RemoteOkItemSchema.safeParse(raw.data);
      if (!parsed.success) return null;
      const detected = detectAtsFromUrls([...(raw.redirects ?? []), parsed.data.apply_url, parsed.data.url]);
      return detected ? { platformKey: detected.target.key, signal: 'metadata' } : null;
    },

    resolveTargetUrl(raw: RawJob): string | null {
      const parsed = RemoteOkItemSchema.safeParse(raw.data);
      if (!parsed.success) return null;
      return parsed.data.apply_url ?? parsed.data.url ?? null;
    },
  };
}

/** Best-effort redirect chain capture (used by fetchJob only). */
async function collectRedirects(http: HttpClient, url: string): Promise<string[]> {
  try {
    const response = await http.request(url, { maxRedirects: 5 });
    return response.redirects;
  } catch {
    return [];
  }
}