import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiError } from '@job-system/core';
import { ConfigError } from '@job-system/shared';
import { MockDecisionProvider, createDecisionProvider } from '../src/decision/index.js';

const schema = z.object({ field: z.enum(['email', 'phone']) });

describe('MockDecisionProvider (Phase 4 infrastructure)', () => {
  it('returns scripted typed decisions with calibrated confidence', async () => {
    const provider = new MockDecisionProvider([
      { decision: { field: 'email' }, confidence: 0.93, probabilities: { email: 0.93, phone: 0.07 } },
    ]);
    const result = await provider.evaluate({
      task: 'classify_field_type',
      state: { label: 'E-mail' },
      schema,
      promptVersion: 'classify-field/v1',
      trace: { correlationId: 'decision-test' },
    });
    expect(result.decision).toEqual({ field: 'email' });
    expect(result.confidence).toBeCloseTo(0.93);
    expect(result.metadata.provider).toBe('mock');
    expect(provider.calls).toEqual([
      { task: 'classify_field_type', promptVersion: 'classify-field/v1' },
    ]);
  });

  it('fails closed without a script or with a schema mismatch', async () => {
    const empty = new MockDecisionProvider();
    await expect(
      empty.evaluate({
        task: 'choose_action',
        state: {},
        schema,
        promptVersion: 'choose/v1',
        trace: { correlationId: 'x' },
      }),
    ).rejects.toBeInstanceOf(AiError);

    const wrong = new MockDecisionProvider([{ decision: { field: 'nope' }, confidence: 0.9 }]);
    await expect(
      wrong.evaluate({
        task: 'choose_action',
        state: {},
        schema,
        promptVersion: 'choose/v1',
        trace: { correlationId: 'x' },
      }),
    ).rejects.toBeInstanceOf(AiError);
  });

  it('refuses unimplemented providers with ConfigError (Jev pilot is Phase 5)', () => {
    expect(createDecisionProvider({ provider: 'mock' }).provider).toBe('mock');
    expect(() => createDecisionProvider({ provider: 'jev' })).toThrow(ConfigError);
    expect(() => createDecisionProvider({ provider: 'llm-adapter' })).toThrow(ConfigError);
  });
});
