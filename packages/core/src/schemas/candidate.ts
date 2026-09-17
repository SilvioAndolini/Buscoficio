import { z } from 'zod';
import {
  CurrencySchema,
  EducationStatusSchema,
  EmploymentTypeSchema,
  LanguageLevelSchema,
  RemoteTypeSchema,
  SkillLevelSchema,
  nonEmptyString,
  nonNegativeInt,
} from './common.js';

/* ------------------------------------------------------------------ */
/* Candidate profile                                                   */
/* ------------------------------------------------------------------ */

export const CandidateProfileInputSchema = z.object({
  fullName: nonEmptyString.max(200),
  email: z.string().email(),
  phone: z.string().trim().min(3).max(40).nullable().optional(),
  headline: z.string().trim().max(200).nullable().optional(),
  summary: z.string().trim().max(5000).nullable().optional(),
  locationCity: z.string().trim().max(120).nullable().optional(),
  locationCountry: z.string().trim().max(120).nullable().optional(),
  locationTimezone: z.string().trim().max(64).nullable().optional(),
  availabilityDate: z.coerce.date().nullable().optional(),
  salaryMin: nonNegativeInt.nullable().optional(),
  salaryMax: nonNegativeInt.nullable().optional(),
  salaryCurrency: CurrencySchema.nullable().optional(),
  remotePreference: z.array(RemoteTypeSchema).default([]),
  employmentTypes: z.array(EmploymentTypeSchema).default([]),
  allowedCountries: z.array(nonEmptyString).default([]),
  relocation: z.boolean().default(false),
  preferences: z.record(z.unknown()).default({}),
});
export type CandidateProfileInput = z.infer<typeof CandidateProfileInputSchema>;

export const CandidateProfileSchema = CandidateProfileInputSchema.extend({
  id: z.string().uuid(),
  profileHash: z.string().length(64),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type CandidateProfile = z.infer<typeof CandidateProfileSchema>;

/* ------------------------------------------------------------------ */
/* Experience / Education / Skills / Languages                         */
/* ------------------------------------------------------------------ */

const ExperienceObjectSchema = z.object({
  company: nonEmptyString.max(200),
  title: nonEmptyString.max(200),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullable().optional(),
  description: z.string().trim().max(10_000).default(''),
  location: z.string().trim().max(200).nullable().optional(),
  skills: z.array(nonEmptyString.max(80)).default([]),
});

export const ExperienceInputSchema = ExperienceObjectSchema.refine(
  (value) => value.endDate === null || value.endDate === undefined || value.endDate >= value.startDate,
  { message: 'endDate must be greater than or equal to startDate', path: ['endDate'] },
);
export type ExperienceInput = z.infer<typeof ExperienceInputSchema>;

export const ExperienceSchema = ExperienceObjectSchema.extend({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
});
export type Experience = z.infer<typeof ExperienceSchema>;

export const EducationInputSchema = z.object({
  institution: nonEmptyString.max(200),
  degree: nonEmptyString.max(200),
  field: z.string().trim().max(200).nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
  status: EducationStatusSchema.default('completed'),
});
export type EducationInput = z.infer<typeof EducationInputSchema>;

export const EducationSchema = EducationInputSchema.extend({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
});
export type Education = z.infer<typeof EducationSchema>;

export const CandidateSkillInputSchema = z.object({
  skillName: nonEmptyString.max(120),
  level: SkillLevelSchema.default('intermediate'),
  years: z.number().min(0).max(60).nullable().optional(),
});
export type CandidateSkillInput = z.infer<typeof CandidateSkillInputSchema>;

export const CandidateSkillSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  skillId: z.string().uuid(),
  skillName: nonEmptyString,
  level: SkillLevelSchema,
  years: z.number().nullable(),
});
export type CandidateSkill = z.infer<typeof CandidateSkillSchema>;

export const CandidateLanguageInputSchema = z.object({
  language: nonEmptyString.max(80),
  level: LanguageLevelSchema,
});
export type CandidateLanguageInput = z.infer<typeof CandidateLanguageInputSchema>;

export const CandidateLanguageSchema = CandidateLanguageInputSchema.extend({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
});
export type CandidateLanguage = z.infer<typeof CandidateLanguageSchema>;