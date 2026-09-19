import { describe, expect, it } from 'vitest';
import type { ApplicationAnswerRecord, Claim } from '@job-system/core';
import { resolveAnswer } from '../src/answers.js';
import { buildFacts } from './helpers/fixtures.js';

const asOfDate = new Date('2026-09-18T00:00:00Z');

function priorAnswer(claims: Claim[]): ApplicationAnswerRecord {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    applicationId: '00000000-0000-4000-8000-0000000000c2',
    questionText: 'How many years of React do you have?',
    questionHash: 'q'.repeat(64),
    answerText: 'Five years of React.',
    answerKind: 'generated',
    sourceRefs: [],
    claims,
    verification: { status: 'verified', failures: [] },
    requiresHumanInput: false,
    approved: true,
    createdAt: asOfDate,
    updatedAt: asOfDate,
  };
}

const reactClaim: Claim = {
  claim: '5 years React',
  kind: 'years_experience',
  value: { years: 5, skill: 'React' },
  sourceRefs: [],
  verified: 'unverifiable',
};

describe('answer bank resolution (Phase 4)', () => {
  it('requires human input when no approved answer exists', () => {
    const result = resolveAnswer({
      questionText: 'How many years of React do you have?',
      priorApproved: null,
      facts: buildFacts(),
      asOfDate,
    });
    expect(result.action).toBe('requires_human');
  });

  it('reuses an approved answer after revalidating its claims', () => {
    const result = resolveAnswer({
      questionText: 'How many years of React do you have?',
      priorApproved: priorAnswer([reactClaim]),
      facts: buildFacts(),
      asOfDate,
    });
    expect(result.action).toBe('reuse');
    if (result.action !== 'reuse') throw new Error('unreachable');
    expect(result.answerText).toBe('Five years of React.');
    expect(result.verification.status).toBe('verified');
    expect(result.claims[0]!.verified).toBe('verified');
    expect(result.requiresHumanInput).toBe(false);
  });

  it('marks the answer stale when the profile no longer supports the claim', () => {
    const factsWithoutYears = buildFacts({
      skills: [
        { id: '10000000-0000-4000-8000-000000000001', name: 'React', aliases: [], level: 'expert', years: null },
      ],
    });
    const result = resolveAnswer({
      questionText: 'How many years of React do you have?',
      priorApproved: priorAnswer([reactClaim]),
      facts: factsWithoutYears,
      asOfDate,
    });
    expect(result.action).toBe('stale');
    if (result.action !== 'stale') throw new Error('unreachable');
    expect(result.requiresHumanInput).toBe(true);
    expect(result.verification.status).toBe('rejected');
  });
});
