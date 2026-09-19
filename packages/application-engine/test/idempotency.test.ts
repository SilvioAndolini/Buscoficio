import { describe, expect, it } from 'vitest';
import {
  computeApplicationIdempotencyKey,
  computePreparationInputHash,
} from '../src/idempotency.js';

describe('application idempotency keys (Phase 4)', () => {
  const base = {
    candidateId: '00000000-0000-4000-8000-000000000001',
    jobId: '00000000-0000-4000-8000-000000000002',
    matchId: '00000000-0000-4000-8000-000000000003',
    mode: 'assisted' as const,
    supersedesApplicationId: null,
  };

  it('same logical command ⇒ same key', () => {
    const first = computeApplicationIdempotencyKey(base);
    const second = computeApplicationIdempotencyKey({ ...base });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('mode, match and supersedes are part of the identity', () => {
    expect(computeApplicationIdempotencyKey({ ...base, mode: 'manual' })).not.toBe(
      computeApplicationIdempotencyKey(base),
    );
    expect(
      computeApplicationIdempotencyKey({
        ...base,
        matchId: '00000000-0000-4000-8000-000000000099',
      }),
    ).not.toBe(computeApplicationIdempotencyKey(base));
    expect(
      computeApplicationIdempotencyKey({
        ...base,
        supersedesApplicationId: '00000000-0000-4000-8000-000000000098',
      }),
    ).not.toBe(computeApplicationIdempotencyKey(base));
  });

  it('preparation hash covers every material input', () => {
    const input = {
      applicationId: '00000000-0000-4000-8000-000000000010',
      matchId: base.matchId,
      sourceResumeVersionId: '00000000-0000-4000-8000-000000000011',
      profileFactsHash: 'p'.repeat(64),
      jobContentHash: 'j'.repeat(64),
      promptVersion: 'cover-letter/v1',
      provider: 'mock',
      model: 'mock-text-v1',
    };
    const first = computePreparationInputHash(input);
    expect(computePreparationInputHash({ ...input })).toBe(first);
    expect(computePreparationInputHash({ ...input, promptVersion: 'cover-letter/v2' })).not.toBe(first);
    expect(computePreparationInputHash({ ...input, model: 'other-model' })).not.toBe(first);
    expect(computePreparationInputHash({ ...input, profileFactsHash: 'x'.repeat(64) })).not.toBe(first);
    expect(
      computePreparationInputHash({ ...input, sourceResumeVersionId: null }),
    ).not.toBe(first);
  });
});
