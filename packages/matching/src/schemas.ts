import { z } from 'zod';

export const SignalNameSchema = z.enum([
  'skillsMatch',
  'experienceMatch',
  'locationMatch',
  'salaryMatch',
  'languageMatch',
  'employmentTypeMatch',
  'semanticSimilarity',
  'careerRelevance',
]);
export type SignalNameValue = z.infer<typeof SignalNameSchema>;

export const SIGNAL_NAMES: readonly SignalNameValue[] = SignalNameSchema.options;

/**
 * Every persisted score carries a full breakdown (invariant M3).
 * Present signals expose score/weight/weightedContribution; absent signals are
 * explicit (`present=false`, `score=null`) and never become a silent zero.
 */
export const PresentSignalSchema = z.object({
  present: z.literal(true),
  score: z.number().min(0).max(1),
  weight: z.number().min(0).max(1),
  weightedContribution: z.number().min(0).max(1),
  details: z.array(z.string()).default([]),
});

export const AbsentSignalSchema = z.object({
  present: z.literal(false),
  score: z.null(),
  weight: z.number().min(0).max(1),
  weightedContribution: z.literal(0),
  reason: z.string().min(1),
  details: z.array(z.string()).default([]),
});

export const SignalBreakdownSchema = z.discriminatedUnion('present', [
  PresentSignalSchema,
  AbsentSignalSchema,
]);

export const ResumeSelectionSchema = z.object({
  recommendedResumeId: z.string().uuid().nullable(),
  recommendedResumeVersionId: z.string().uuid().nullable(),
  reasons: z.array(z.string()),
});

/** All eight signals are always present in the breakdown (explicability M3). */
export const SignalsBreakdownSchema = z.object({
  skillsMatch: SignalBreakdownSchema,
  experienceMatch: SignalBreakdownSchema,
  locationMatch: SignalBreakdownSchema,
  salaryMatch: SignalBreakdownSchema,
  languageMatch: SignalBreakdownSchema,
  employmentTypeMatch: SignalBreakdownSchema,
  semanticSimilarity: SignalBreakdownSchema,
  careerRelevance: SignalBreakdownSchema,
});
export type SignalsBreakdown = z.infer<typeof SignalsBreakdownSchema>;

export const ScoreBreakdownSchema = z.object({
  engineVersion: z.string().min(1),
  weightsVersion: z.string().min(1),
  signals: SignalsBreakdownSchema,
  presentWeightSum: z.number().min(0).max(8),
  rawScore: z.number().min(0).max(1),
  hardRequirementCap: z.number().min(0).max(1),
  capApplied: z.boolean(),
  finalScore: z.number().min(0).max(1),
  missingRequiredSkills: z.array(z.string()),
  resumeSelection: ResumeSelectionSchema,
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;
