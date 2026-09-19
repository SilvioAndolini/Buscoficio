import { describe, expect, it } from 'vitest';
import { canonicalQuestion, hashQuestion } from '../src/question.js';

describe('question hashing (Phase 4)', () => {
  it('canonicalizes case, whitespace and trivial punctuation', () => {
    const variants = [
      'Are you authorized to work?',
      'are you authorized to work',
      '  Are   you  authorized to work?  ',
      'ARE YOU AUTHORIZED TO WORK!!!',
    ];
    const hashes = variants.map(hashQuestion);
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalQuestion(variants[0]!)).toBe('are you authorized to work');
  });

  it('does not merge semantically different questions', () => {
    expect(hashQuestion('Are you authorized to work?')).not.toBe(
      hashQuestion('Are you authorized to work in the EU?'),
    );
    expect(hashQuestion('Do you require sponsorship?')).not.toBe(
      hashQuestion('Do you not require sponsorship?'),
    );
  });
});
