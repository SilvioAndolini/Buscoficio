import { z } from 'zod';
import {
  ApplicationMethodSchema,
  CurrencySchema,
  EmploymentTypeSchema,
  ExperienceLevelSchema,
  RemoteTypeSchema,
  nonEmptyString,
  nonNegativeInt,
} from './common.js';

/** Raw payload as returned by a source adapter, before normalization. */
export const RawJobSchema = z.object({
  sourceKey: nonEmptyString,
  externalId: nonEmptyString,
  fetchedAt: z.date(),
  data: z.unknown(),
  /** Redirect chain observed while fetching the offer (target detection). */
  redirects: z.array(z.string()).optional(),
});
export type RawJob = z.infer<typeof RawJobSchema>;

/**
 * Single normalized offer schema (architecture doc 04 §2.3).
 * Hashes (urlHash, fingerprint, dedupKey) are derived later by the ingest layer.
 */
export const NormalizedJobSchema = z
  .object({
    externalId: nonEmptyString,
    canonicalUrl: z.string().url(),
    company: nonEmptyString.max(300),
    title: nonEmptyString.max(300),
    description: z.string().trim().min(1).max(100_000),
    location: z.string().trim().min(1).max(300).nullable(),
    remoteType: RemoteTypeSchema.nullable(),
    employmentType: EmploymentTypeSchema.nullable(),
    salaryMin: nonNegativeInt.nullable(),
    salaryMax: nonNegativeInt.nullable(),
    currency: CurrencySchema.nullable(),
    experienceLevel: ExperienceLevelSchema.nullable(),
    languageRequirements: z.array(nonEmptyString.max(40)),
    publishedAt: z.date(),
    expiresAt: z.date().nullable(),
    applicationMethod: ApplicationMethodSchema,
  })
  .refine(
    (job) => job.salaryMin === null || job.salaryMax === null || job.salaryMax >= job.salaryMin,
    { message: 'salaryMax must be greater than or equal to salaryMin', path: ['salaryMax'] },
  );
export type NormalizedJob = z.infer<typeof NormalizedJobSchema>;

export const IngestOutcomeSchema = z.enum(['new', 'merged', 'duplicate', 'rejected']);
export type IngestOutcome = z.infer<typeof IngestOutcomeSchema>;

export interface IngestFuzzyInfo {
  decision: 'merge' | 'review' | 'distinct';
  candidateJobId: string | null;
  score: number | null;
  titleSimilarity: number | null;
  descriptionSimilarity: number | null;
}

export interface IngestResult {
  outcome: IngestOutcome;
  listingId: string | null;
  jobId: string | null;
  reasons: string[];
  /** Present when L3 fuzzy dedup evaluated candidates. */
  fuzzy?: IngestFuzzyInfo;
  /** Present when the gray zone created a dedup_review row. */
  reviewId?: string | null;
}