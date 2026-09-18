import { z } from 'zod';
import {
  EmploymentTypeSchema,
  ExperienceLevelSchema,
  LanguageLevelSchema,
  RemoteTypeSchema,
  SkillLevelSchema,
} from '@job-system/core';

/**
 * Zod contracts for the DB -> engine boundary (architecture doc 05 §1: every
 * boundary validates). Repositories return loosely typed rows; the matching
 * service parses them into engine inputs.
 */

export const MatchJobSchema = z.object({
  company: z.string(),
  title: z.string(),
  description: z.string(),
  location: z.string().nullable(),
  remoteType: RemoteTypeSchema.nullable(),
  employmentType: EmploymentTypeSchema.nullable(),
  salaryMin: z.number().int().nullable(),
  salaryMax: z.number().int().nullable(),
  currency: z.string().length(3).nullable(),
  experienceLevel: ExperienceLevelSchema.nullable(),
  languageRequirements: z.array(z.string()),
  requiredSkills: z.array(z.string()),
  preferredSkills: z.array(z.string()),
});
export type MatchJobRowInput = z.infer<typeof MatchJobSchema>;

export const MatchCandidateProfileSchema = z.object({
  locationCity: z.string().nullable(),
  locationCountry: z.string().nullable(),
  salaryMin: z.number().int().nullable(),
  salaryMax: z.number().int().nullable(),
  salaryCurrency: z.string().length(3).nullable(),
  remotePreference: z.array(RemoteTypeSchema),
  employmentTypes: z.array(EmploymentTypeSchema),
  allowedCountries: z.array(z.string()),
  relocation: z.boolean(),
});
export type MatchCandidateProfileRowInput = z.infer<typeof MatchCandidateProfileSchema>;

export const MatchCandidateSkillSchema = z.object({
  skillName: z.string(),
  aliases: z.array(z.string()),
  level: SkillLevelSchema,
  years: z.number().nullable(),
});

export const MatchCandidateLanguageSchema = z.object({
  language: z.string(),
  level: LanguageLevelSchema,
});

export const MatchCandidateExperienceSchema = z.object({
  company: z.string(),
  title: z.string(),
  startDate: z.date(),
  endDate: z.date().nullable(),
  skills: z.array(z.string()),
});

export const MatchResumeContextSchema = z.object({
  id: z.string().uuid(),
  category: z.string(),
  language: z.string(),
  latestVersion: z
    .object({
      id: z.string().uuid(),
      versionNumber: z.number().int().positive(),
      fileHash: z.string(),
      kind: z.string(),
      highlights: z.record(z.unknown()),
    })
    .nullable(),
});
export type MatchResumeContextRowInput = z.infer<typeof MatchResumeContextSchema>;
