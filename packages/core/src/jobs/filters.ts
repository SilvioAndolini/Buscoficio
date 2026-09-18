import { z } from 'zod';
import { RemoteTypeSchema, type RemoteType } from '../schemas/common.js';
import { normalizeForDedup } from './dedup.js';

/** Validation schema for `search_config.filters` (API boundary). */
export const HardFilterConfigSchema = z.object({
  excludedCompanies: z.array(z.string().trim().min(1)).optional(),
  excludedKeywords: z.array(z.string().trim().min(1)).optional(),
  requiredKeywords: z.array(z.string().trim().min(1)).optional(),
  allowedCountries: z.array(z.string().trim().min(1)).optional(),
  allowedRemoteTypes: z.array(RemoteTypeSchema).optional(),
});

/**
 * Hard eligibility filters (Phase 2). Pure and deterministic: every rejection
 * carries the applied rule and a human-readable reason.
 */
export type HardFilterConfig = z.infer<typeof HardFilterConfigSchema>;

export interface JobFilterView {
  company: string;
  title: string;
  description: string;
  location: string | null;
  remoteType: RemoteType | null;
}

export interface FilterRejection {
  rule: string;
  reason: string;
}

export interface FilterDecision {
  allowed: boolean;
  rejections: FilterRejection[];
}

function matchesKeyword(haystack: string, keyword: string): boolean {
  return haystack.includes(normalizeForDedup(keyword));
}

export function evaluateHardFilters(job: JobFilterView, config: HardFilterConfig): FilterDecision {
  const rejections: FilterRejection[] = [];
  const company = normalizeForDedup(job.company);
  const haystack = `${normalizeForDedup(job.company)} ${normalizeForDedup(job.title)} ${normalizeForDedup(job.description)}`;

  const excludedCompanies = (config.excludedCompanies ?? []).map(normalizeForDedup).filter(Boolean);
  if (excludedCompanies.length > 0 && excludedCompanies.some((name) => company.includes(name))) {
    rejections.push({
      rule: 'excludedCompanies',
      reason: `company '${job.company}' matches an excluded company`,
    });
  }

  for (const keyword of config.excludedKeywords ?? []) {
    if (keyword.trim().length > 0 && matchesKeyword(haystack, keyword)) {
      rejections.push({
        rule: 'excludedKeywords',
        reason: `offer contains excluded keyword '${keyword}'`,
      });
    }
  }

  const requiredKeywords = (config.requiredKeywords ?? []).filter((keyword) => keyword.trim().length > 0);
  if (requiredKeywords.length > 0 && !requiredKeywords.some((keyword) => matchesKeyword(haystack, keyword))) {
    rejections.push({
      rule: 'requiredKeywords',
      reason: `none of the required keywords matched (${requiredKeywords.join(', ')})`,
    });
  }

  const allowedCountries = (config.allowedCountries ?? []).map(normalizeForDedup).filter(Boolean);
  if (allowedCountries.length > 0) {
    const location = job.location === null ? '' : normalizeForDedup(job.location);
    const countryMatch = location.length > 0 && allowedCountries.some((country) => location.includes(country));
    if (!countryMatch) {
      rejections.push({
        rule: 'allowedCountries',
        reason:
          job.location === null
            ? 'location unknown while allowedCountries is configured'
            : `location '${job.location}' is outside allowed countries (${allowedCountries.join(', ')})`,
      });
    }
  }

  const allowedRemoteTypes = config.allowedRemoteTypes ?? [];
  if (
    allowedRemoteTypes.length > 0 &&
    job.remoteType !== null &&
    !allowedRemoteTypes.includes(job.remoteType)
  ) {
    rejections.push({
      rule: 'allowedRemoteTypes',
      reason: `remote type '${job.remoteType}' is not allowed (${allowedRemoteTypes.join(', ')})`,
    });
  }

  return { allowed: rejections.length === 0, rejections };
}