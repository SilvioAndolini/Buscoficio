import type { AnswerContentInput, AnswerValidation } from '@job-system/core';
import { validateClaims } from './claims.js';

/**
 * Answer factual policy (Phase 4.2): the generic `validateClaims([])` result
 * ("vacuously verified") is deliberately NOT enough for free-text answers.
 * Phase 4 has no typed question/field semantics yet, so a claimless answer is
 * conservatively `unverifiable` and human-only: no automatic approval, no
 * automatic reuse. Phase 5 may introduce QuestionDescriptor/semanticType and
 * allow claimless answers for explicitly non-factual categories.
 *
 * Deterministic on purpose: no heuristics, no LLM fact extraction, no NLP.
 */
export const CLAIMLESS_ANSWER_REASON =
  'Free-text answer contains no structured claims/evidence and cannot be automatically verified in Phase 4.';

export function validateAnswerContent(input: AnswerContentInput): AnswerValidation {
  if (input.claims.length === 0) {
    return {
      claims: [],
      verification: {
        status: 'unverifiable',
        failures: [],
        reason: CLAIMLESS_ANSWER_REASON,
      },
      requiresHumanInput: true,
      automaticReuseAllowed: false,
    };
  }
  const validation = validateClaims(input.claims, input.facts, { asOfDate: input.asOfDate });
  const fullyVerified = validation.verification.status === 'verified';
  return {
    claims: validation.claims,
    verification: validation.verification,
    requiresHumanInput: !fullyVerified,
    automaticReuseAllowed: fullyVerified,
  };
}
