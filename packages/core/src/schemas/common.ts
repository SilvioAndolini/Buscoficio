import { z } from 'zod';

export const RemoteTypeSchema = z.enum(['onsite', 'hybrid', 'remote', 'unknown']);
export type RemoteType = z.infer<typeof RemoteTypeSchema>;

export const EmploymentTypeSchema = z.enum([
  'full_time',
  'part_time',
  'contract',
  'internship',
  'temporary',
  'other',
]);
export type EmploymentType = z.infer<typeof EmploymentTypeSchema>;

export const ExperienceLevelSchema = z.enum([
  'intern',
  'junior',
  'mid',
  'senior',
  'lead',
  'principal',
  'unknown',
]);
export type ExperienceLevel = z.infer<typeof ExperienceLevelSchema>;

export const ApplicationMethodSchema = z.enum(['api', 'external_form', 'email', 'unknown']);
export type ApplicationMethod = z.infer<typeof ApplicationMethodSchema>;
export const SkillLevelSchema = z.enum(['beginner', 'intermediate', 'advanced', 'expert']);
export const LanguageLevelSchema = z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native']);
export const EducationStatusSchema = z.enum(['completed', 'in_progress', 'dropped']);

export const CurrencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'currency must be an ISO 4217 code');

export const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase slug');

export const nonEmptyString = z.string().trim().min(1);

export const nonNegativeInt = z.number().int().nonnegative();