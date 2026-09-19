import { describe, expect, it } from 'vitest';
import type { Claim } from '@job-system/core';
import { CLAIMLESS_ANSWER_REASON, validateAnswerContent } from '../src/answer-content.js';
import { buildFacts } from './helpers/fixtures.js';

const asOfDate = new Date('2026-09-18T00:00:00Z');

const reactClaim: Claim = {
  claim: '5 years React',
  kind: 'years_experience',
  value: { years: 5, skill: 'React' },
  sourceRefs: [],
  verified: 'unverifiable',
};

const awsClaim: Claim = {
  claim: '10 years AWS',
  kind: 'years_experience',
  value: { years: 10, skill: 'AWS' },
  sourceRefs: [],
  verified: 'unverifiable',
};

describe('answer content policy (Phase 4.2)', () => {
  it('fail closed: a factual claimless answer is unverifiable and human-only (§32)', () => {
    const result = validateAnswerContent({
      answerText: 'I have 10 years of AWS experience and I am AWS Certified.',
      claims: [],
      facts: buildFacts(),
      asOfDate,
    });
    expect(result.claims).toEqual([]);
    expect(result.verification.status).toBe('unverifiable');
    expect(result.verification.failures).toEqual([]);
    expect(result.verification.reason).toBe(CLAIMLESS_ANSWER_REASON);
    expect(result.requiresHumanInput).toBe(true);
    expect(result.automaticReuseAllowed).toBe(false);
  });

  it('fail closed even for benign claimless text (§33, deliberately conservative)', () => {
    // Phase 4 cannot know whether the real form field is factual or not, so
    // every claimless free-text answer is human-only until Phase 5 introduces
    // typed question descriptors. The false positive is intentional:
    // factual integrity > automatic reuse convenience.
    const result = validateAnswerContent({
      answerText: 'I would be happy to discuss this further.',
      claims: [],
      facts: buildFacts(),
      asOfDate,
    });
    expect(result.verification.status).toBe('unverifiable');
    expect(result.requiresHumanInput).toBe(true);
    expect(result.automaticReuseAllowed).toBe(false);
  });

  it('a declared claim backed by the profile is verified and reusable (§34)', () => {
    const result = validateAnswerContent({
      answerText: 'I have 5 years of React experience.',
      claims: [reactClaim],
      facts: buildFacts(),
      asOfDate,
    });
    expect(result.verification.status).toBe('verified');
    expect(result.verification.failures).toEqual([]);
    expect(result.claims[0]!.verified).toBe('verified');
    expect(result.claims[0]!.sourceRefs.length).toBeGreaterThan(0);
    expect(result.requiresHumanInput).toBe(false);
    expect(result.automaticReuseAllowed).toBe(true);
  });

  it('a declared claim with no profile source is rejected and human-only (§35)', () => {
    const result = validateAnswerContent({
      answerText: 'I have 10 years of AWS experience.',
      claims: [awsClaim],
      facts: buildFacts(),
      asOfDate,
    });
    expect(result.verification.status).toBe('rejected');
    expect(result.verification.failures).toHaveLength(1);
    expect(result.requiresHumanInput).toBe(true);
    expect(result.automaticReuseAllowed).toBe(false);
  });

  it('a partially unverifiable claimed answer is never automatically reusable', () => {
    const seniorityClaim: Claim = {
      claim: 'seniority: senior',
      kind: 'seniority',
      value: { level: 'senior' },
      sourceRefs: [],
      verified: 'unverifiable',
    };
    const result = validateAnswerContent({
      answerText: 'I am a senior React developer.',
      claims: [reactClaim, seniorityClaim],
      facts: buildFacts(),
      asOfDate,
    });
    expect(result.verification.status).toBe('unverifiable');
    expect(result.requiresHumanInput).toBe(true);
    expect(result.automaticReuseAllowed).toBe(false);
  });
});
