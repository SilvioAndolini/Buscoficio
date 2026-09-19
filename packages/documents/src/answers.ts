import type { Claim, ResolveAnswerInput, ResolveAnswerResult } from '@job-system/core';
import { validateAnswerContent } from './answer-content.js';

/**
 * Answer bank resolution (task §15; Phase 4.2): reuse requires ALL of
 *   - the prior answer is approved (guaranteed by `priorApproved`),
 *   - it declares structured claims (`claims.length > 0`),
 *   - revalidation against current facts is fully `verified`.
 * Claimless free-text answers (including legacy rows with `approved=true`)
 * always fail closed into human review: legacy flags are never trusted.
 */
export function resolveAnswer(input: ResolveAnswerInput): ResolveAnswerResult {
  const prior = input.priorApproved;
  if (prior === null || prior.answerText === null || prior.answerText.trim().length === 0) {
    return { action: 'requires_human', reason: 'No approved answer exists for this question' };
  }
  const validation = validateAnswerContent({
    answerText: prior.answerText,
    claims: prior.claims,
    facts: input.facts,
    asOfDate: input.asOfDate,
  });
  const sourceRefs = validation.claims.flatMap((claim: Claim) => claim.sourceRefs);
  if (!validation.automaticReuseAllowed) {
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
