import type {
  ApplicationDocumentKind,
  PreparationBlocker,
  VerificationResult,
} from '@job-system/core';

/**
 * Pure, deterministic blocker derivation (Phase 4.1, P5). Used by the engine
 * (prepare result) and the API (application detail) so a cache-hit preparation
 * can never report fewer blockers than the persisted state actually has.
 *
 * `target_blocked` is informational: it never blocks MANUAL/ASSISTED document
 * preparation (doc 03 J3) and therefore does not set `requiresHumanInput`.
 */

export interface BlockerDocumentView {
  id: string;
  kind: ApplicationDocumentKind;
  verification: VerificationResult;
}

export interface BlockerAnswerView {
  id: string;
  questionText: string;
  requiresHumanInput: boolean;
  claims: unknown[];
  verification: VerificationResult;
}

export interface DerivePreparationBlockersInput {
  requiresHumanReason: string | null;
  documents: BlockerDocumentView[];
  answers: BlockerAnswerView[];
  targetStatus: string | null;
}

function truncate(value: string, max = 100): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function derivePreparationBlockers(
  input: DerivePreparationBlockersInput,
): PreparationBlocker[] {
  const blockers: PreparationBlocker[] = [];
  if (input.requiresHumanReason !== null && input.requiresHumanReason.trim().length > 0) {
    blockers.push({ code: 'requires_human_input', message: input.requiresHumanReason });
  }
  for (const document of input.documents) {
    if (document.verification.status === 'rejected') {
      blockers.push({
        code: 'rejected_claims',
        message: `${document.kind} contains rejected claims`,
        refId: document.id,
      });
    } else if (document.verification.status !== 'verified') {
      blockers.push({
        code: 'requires_human_input',
        message: `${document.kind} contains unverifiable claims`,
        refId: document.id,
      });
    }
  }
  for (const answer of input.answers) {
    if (answer.requiresHumanInput) {
      blockers.push({
        code: 'stale_answer',
        message: `Answer requires human input: "${truncate(answer.questionText)}"`,
        refId: answer.id,
      });
      continue;
    }
    // An answer with factual claims that is not fully verified is never
    // considered resolved (Phase 4.1, P2/§35).
    if (answer.claims.length > 0 && answer.verification.status !== 'verified') {
      blockers.push({
        code: 'requires_human_input',
        message: `Answer is not fully verified: "${truncate(answer.questionText)}"`,
        refId: answer.id,
      });
    }
  }
  if (input.targetStatus === 'blocked') {
    blockers.push({
      code: 'target_blocked',
      message:
        'Application target is blocked pending platform policy review; document preparation is still allowed (no submission in Phase 4)',
    });
  }
  return blockers;
}

/** True when any blocker (other than the informational target) needs a human. */
export function blockersRequireHumanInput(blockers: PreparationBlocker[]): boolean {
  return blockers.some((blocker) => blocker.code !== 'target_blocked');
}
