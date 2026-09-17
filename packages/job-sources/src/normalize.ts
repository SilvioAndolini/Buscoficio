import { z } from 'zod';
import {
  ApplicationMethodSchema,
  CurrencySchema,
  EmploymentTypeSchema,
  ExperienceLevelSchema,
  NormalizedJobSchema,
  RemoteTypeSchema,
  ValidationError,
  normalizeCanonicalUrl,
  type NormalizedJob,
  type RawJob,
} from '@job-system/core';

/**
 * Common payload shape for Phase 1 sources. Future adapters may define their
 * own payload schema; the output is always the single NormalizedJob schema.
 */
export const RawJobPayloadSchema = z.object({
  externalId: z.string().trim().min(1),
  url: z.string().url(),
  company: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  location: z.string().trim().min(1).nullable(),
  remote: RemoteTypeSchema.nullable(),
  employmentType: EmploymentTypeSchema.nullable(),
  salaryMin: z.number().int().nonnegative().nullable(),
  salaryMax: z.number().int().nonnegative().nullable(),
  currency: CurrencySchema.nullable(),
  experienceLevel: ExperienceLevelSchema.nullable(),
  languages: z.array(z.string().trim().min(1)).default([]),
  publishedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  applyPlatform: z.string().trim().min(1).nullable().default(null),
});
export type RawJobPayload = z.infer<typeof RawJobPayloadSchema>;

/** Pure mapper: validated payload -> normalized job (deterministic). */
export function buildNormalizedJob(payload: RawJobPayload): NormalizedJob {
  return NormalizedJobSchema.parse({
    externalId: payload.externalId,
    canonicalUrl: normalizeCanonicalUrl(payload.url),
    company: payload.company,
    title: payload.title,
    description: payload.description,
    location: payload.location,
    remoteType: payload.remote,
    employmentType: payload.employmentType,
    salaryMin: payload.salaryMin,
    salaryMax: payload.salaryMax,
    currency: payload.currency,
    experienceLevel: payload.experienceLevel,
    languageRequirements: payload.languages,
    publishedAt: new Date(payload.publishedAt),
    expiresAt: payload.expiresAt === null ? null : new Date(payload.expiresAt),
    applicationMethod: payload.applyPlatform === null ? 'unknown' : 'external_form',
  });
}

/** Raw job -> normalized job. Malformed payloads raise ValidationError. */
export function normalizeJob(raw: RawJob): NormalizedJob {
  const parsed = RawJobPayloadSchema.safeParse(raw.data);
  if (!parsed.success) {
    throw new ValidationError(`Malformed job payload from source '${raw.sourceKey}'`, {
      context: {
        externalId: raw.externalId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }
  return buildNormalizedJob(parsed.data);
}

export { ApplicationMethodSchema };