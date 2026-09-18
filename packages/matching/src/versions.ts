/**
 * Versioned matching policy (architecture docs 03 §7, 08 §1).
 *
 * Versioning criterion: ANY material change to signal computation, weights,
 * hard-requirement rules or the score cap MUST bump `engineVersion` and/or
 * `weightsVersion`. Those strings are part of the JobMatch identity hash, so a
 * bump produces a new match row while the previous one stays as history.
 */
/**
 * v2 (Phase 3.1 sanitation): open-ended experiences are evaluated against an
 * explicit `matchingAsOfDate` (Clock-provided) instead of the latest date found
 * inside the experience set, and the anchor participates in the identity hash.
 * v1 could report ~0 years for a role that started years ago.
 */
export const ENGINE_VERSION = 'matching-v2';

export const WEIGHTS_VERSION = 'v1';

/** A missing hard requirement caps the final score (never silently ignored). */
export const HARD_REQUIREMENT_CAP_V1 = 0.49;

/**
 * Hard requirement rules v1:
 *  - language requirements are hard (explicit job requirement, MCER level);
 *  - missing required skills are reported but do not cap (job skill lists can
 *    be incomplete; capping every absent skill would make scores meaningless).
 */
export const HARD_REQUIREMENT_RULES_V1 = {
  languageRequirements: true,
  missingRequiredSkills: false,
} as const;

export interface HardRequirementRules {
  languageRequirements: boolean;
  missingRequiredSkills: boolean;
}
