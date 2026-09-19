import { z } from 'zod';
import {
  EducationStatusSchema,
  LanguageLevelSchema,
  SkillLevelSchema,
  nonEmptyString,
} from './common.js';

/**
 * Minimal facts view handed to documents/AI (doc 08 §5). Deliberately excludes
 * unnecessary PII: email, phone, exact address and full CV files never travel
 * to prompts unless a future, explicit need justifies it.
 */
export const FactSkillSchema = z.object({
  id: z.string().uuid(),
  name: nonEmptyString.max(120),
  aliases: z.array(nonEmptyString.max(120)).default([]),
  level: SkillLevelSchema,
  years: z.number().min(0).max(60).nullable(),
});
export type FactSkill = z.infer<typeof FactSkillSchema>;

export const FactExperienceSchema = z.object({
  id: z.string().uuid(),
  company: nonEmptyString.max(200),
  title: nonEmptyString.max(200),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullable(),
  skills: z.array(nonEmptyString.max(80)).default([]),
});
export type FactExperience = z.infer<typeof FactExperienceSchema>;

export const FactEducationSchema = z.object({
  id: z.string().uuid(),
  institution: nonEmptyString.max(200),
  degree: nonEmptyString.max(200),
  field: z.string().max(200).nullable(),
  startDate: z.coerce.date().nullable(),
  endDate: z.coerce.date().nullable(),
  status: EducationStatusSchema,
});
export type FactEducation = z.infer<typeof FactEducationSchema>;

export const FactLanguageSchema = z.object({
  id: z.string().uuid(),
  language: nonEmptyString.max(80),
  level: LanguageLevelSchema,
});
export type FactLanguage = z.infer<typeof FactLanguageSchema>;

export const FactSalarySchema = z.object({
  min: z.number().int().nonnegative().nullable(),
  max: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
});
export type FactSalary = z.infer<typeof FactSalarySchema>;

export const ProfileFactsViewSchema = z.object({
  candidateId: z.string().uuid(),
  displayName: nonEmptyString.max(200),
  headline: z.string().max(200).nullable(),
  skills: z.array(FactSkillSchema),
  experiences: z.array(FactExperienceSchema),
  education: z.array(FactEducationSchema),
  languages: z.array(FactLanguageSchema),
  /** Null unless the caller explicitly needs salary facts (question-driven). */
  salary: FactSalarySchema.nullable(),
});
export type ProfileFactsView = z.infer<typeof ProfileFactsViewSchema>;

/** Raw aggregate consumed by `buildProfileFactsView` (no I/O). */
export const ProfileFactsSourceSchema = z.object({
  profile: z.object({
    id: z.string().uuid(),
    fullName: nonEmptyString.max(200),
    headline: z.string().max(200).nullable(),
    salaryMin: z.number().int().nonnegative().nullable(),
    salaryMax: z.number().int().nonnegative().nullable(),
    salaryCurrency: z.string().length(3).nullable(),
  }),
  skills: z.array(FactSkillSchema),
  experiences: z.array(FactExperienceSchema),
  education: z.array(FactEducationSchema),
  languages: z.array(FactLanguageSchema),
});
export type ProfileFactsSource = z.infer<typeof ProfileFactsSourceSchema>;

/**
 * Language level ordering used by factual validation: a claim may never
 * elevate the profile level (doc 03 §8 rule 2).
 */
export const LANGUAGE_LEVEL_ORDER: readonly z.infer<typeof LanguageLevelSchema>[] = [
  'A1',
  'A2',
  'B1',
  'B2',
  'C1',
  'C2',
  'native',
];

export function languageLevelRank(level: z.infer<typeof LanguageLevelSchema>): number {
  return LANGUAGE_LEVEL_ORDER.indexOf(level);
}
