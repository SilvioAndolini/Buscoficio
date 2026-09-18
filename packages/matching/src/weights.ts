import { z } from 'zod';
import { ENGINE_VERSION, HARD_REQUIREMENT_CAP_V1, HARD_REQUIREMENT_RULES_V1, WEIGHTS_VERSION, type HardRequirementRules } from './versions.js';

/** Centralized matching weights (architecture doc 03 §7). */
export const MatchingWeightsSchema = z.object({
  skillsMatch: z.number().min(0).max(1),
  experienceMatch: z.number().min(0).max(1),
  locationMatch: z.number().min(0).max(1),
  salaryMatch: z.number().min(0).max(1),
  languageMatch: z.number().min(0).max(1),
  employmentTypeMatch: z.number().min(0).max(1),
  semanticSimilarity: z.number().min(0).max(1),
  careerRelevance: z.number().min(0).max(1),
});
export type MatchingWeights = z.infer<typeof MatchingWeightsSchema>;

/**
 * v1 weights. They sum to 1 for readability only: the formula divides by the
 * sum of PRESENT weights, so changing one value does not require rebalancing
 * the rest. Changing any value requires a new `weightsVersion`.
 */
export const MATCHING_WEIGHTS_V1: MatchingWeights = {
  skillsMatch: 0.25,
  experienceMatch: 0.15,
  locationMatch: 0.1,
  salaryMatch: 0.05,
  languageMatch: 0.1,
  employmentTypeMatch: 0.05,
  semanticSimilarity: 0.2,
  careerRelevance: 0.1,
};

export const MatchPolicySchema = z.object({
  engineVersion: z.string().min(1),
  weightsVersion: z.string().min(1),
  weights: MatchingWeightsSchema,
  hardRequirementCap: z.number().min(0).max(1),
  hardRules: z.object({
    languageRequirements: z.boolean(),
    missingRequiredSkills: z.boolean(),
  }),
});
export type MatchPolicy = z.infer<typeof MatchPolicySchema>;

export const DEFAULT_MATCH_POLICY: MatchPolicy = {
  engineVersion: ENGINE_VERSION,
  weightsVersion: WEIGHTS_VERSION,
  weights: MATCHING_WEIGHTS_V1,
  hardRequirementCap: HARD_REQUIREMENT_CAP_V1,
  hardRules: HARD_REQUIREMENT_RULES_V1 satisfies HardRequirementRules,
};
