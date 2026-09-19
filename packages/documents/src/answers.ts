import type { Claim, ResolveAnswerInput, ResolveAnswerResult } from '@job-system/core';
import { validateClaims } from './claims.js';

/**
 * Answer bank resolution (task §15): ONLY a fully verified answer may be
 * reused automatically. `unverifiable` and `rejected` both fail closed into
 * human review (Phase 4.1, P2); stale answers are never reused blindly.
 */
export function resolveAnswer(input: ResolveAnswerInput): ResolveAnswerResult {
  const prior = input.priorApproved;
  if (prior === null || prior.answerText === null || prior.answerText.trim().length === 0) {
    return { action: 'requires_human', reason: 'No approved answer exists for this question' };
  }
  const validation = validateClaims(prior.claims, input.facts, { asOfDate: input.asOfDate });
  const sourceRefs = validation.claims.flatMap((claim: Claim) => claim.sourceRefs);
  if (validation.verification.status !== 'verified') {
    return {
      action: 'stale',
      answerText: prior.answerText,
      sourceRefs,
      claims: validation.claims,
      verification: validation.verification,
      requiresHumanInput: true,
    };
  }
  return {
    action: 'reuse',
    answerText: prior.answerText,
    sourceRefs,
    claims: validation.claims,
    verification: validation.verification,
    requiresHumanInput: false,
  };
}
