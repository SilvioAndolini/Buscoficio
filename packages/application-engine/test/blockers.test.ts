import { describe, expect, it } from 'vitest';
import { blockersRequireHumanInput, derivePreparationBlockers } from '../src/blockers.js';

const base = {
  requiresHumanReason: null,
  documents: [],
  answers: [],
  targetStatus: null,
} satisfies {
  requiresHumanReason: string | null;
  documents: Array<{ id: string; kind: 'cover_letter' | 'resume_variant' | 'other'; verification: { status: 'verified' | 'unverifiable' | 'rejected'; failures: Array<{ claim: string; kind: string; reason: string }> } }>;
  answers: Array<{ id: string; questionText: string; requiresHumanInput: boolean; claims: unknown[]; verification: { status: 'verified' | 'unverifiable' | 'rejected'; failures: Array<{ claim: string; kind: string; reason: string }> } }>;
  targetStatus: string | null;
};

describe('derivePreparationBlockers (Phase 4.1, P5)', () => {
  it('reports unverifiable and rejected documents', () => {
    const blockers = derivePreparationBlockers({
      ...base,
      documents: [
        {
          id: 'd1',
          kind: 'cover_letter',
          verification: { status: 'unverifiable', failures: [] },
        },
        {
          id: 'd2',
          kind: 'resume_variant',
          verification: { status: 'rejected', failures: [] },
        },
      ],
    });
    expect(blockers).toEqual([
      { code: 'requires_human_input', message: 'cover_letter contains unverifiable claims', refId: 'd1' },
      { code: 'rejected_claims', message: 'resume_variant contains rejected claims', refId: 'd2' },
    ]);
    expect(blockersRequireHumanInput(blockers)).toBe(true);
  });

  it('treats any non-verified answer as unresolved', () => {
    const blockers = derivePreparationBlockers({
      ...base,
      answers: [
        {
          id: 'a1',
          questionText: 'What is your seniority?',
          requiresHumanInput: true,
          claims: [],
          verification: { status: 'unverifiable', failures: [] },
        },
        {
          id: 'a2',
          questionText: 'Years of React?',
          requiresHumanInput: false,
          claims: [{ kind: 'years_experience' }],
          verification: { status: 'unverifiable', failures: [] },
        },
        {
          id: 'a3',
          questionText: 'Start date?',
          requiresHumanInput: false,
          claims: [],
          verification: { status: 'verified', failures: [] },
        },
      ],
    });
    expect(blockers.map((blocker) => blocker.code)).toEqual(['stale_answer', 'requires_human_input']);
    expect(blockers.every((blocker) => blocker.refId !== 'a3')).toBe(true);
  });

  it('keeps target_blocked informational (does not require human input)', () => {
    const blockers = derivePreparationBlockers({ ...base, targetStatus: 'blocked' });
    expect(blockers).toEqual([
      {
        code: 'target_blocked',
        message:
          'Application target is blocked pending platform policy review; document preparation is still allowed (no submission in Phase 4)',
      },
    ]);
    expect(blockersRequireHumanInput(blockers)).toBe(false);
  });

  it('includes the persisted human reason', () => {
    const blockers = derivePreparationBlockers({
      ...base,
      requiresHumanReason: 'rejected factual claims after repair',
    });
    expect(blockers[0]).toMatchObject({
      code: 'requires_human_input',
      message: 'rejected factual claims after repair',
    });
  });
});
