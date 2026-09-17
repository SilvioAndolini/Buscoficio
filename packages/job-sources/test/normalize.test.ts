import { describe, expect, it } from 'vitest';
import { ValidationError } from '@job-system/core';
import { buildNormalizedJob, normalizeJob, RawJobPayloadSchema } from '../src/normalize.js';
import { MOCK_PAYLOADS, MOCK_SOURCE_KEY } from '../src/mock/fixtures.js';

const validPayload = MOCK_PAYLOADS[0]!;

describe('normalizeJob', () => {
  it('maps a valid payload into the single normalized schema', () => {
    const normalized = normalizeJob({
      sourceKey: MOCK_SOURCE_KEY,
      externalId: validPayload.externalId,
      fetchedAt: new Date(),
      data: validPayload,
    });
    expect(normalized.company).toBe('Acme Corp');
    expect(normalized.remoteType).toBe('remote');
    expect(normalized.applicationMethod).toBe('external_form');
    expect(normalized.publishedAt).toBeInstanceOf(Date);
  });

  it('normalizes the canonical URL (strips tracking params)', () => {
    const normalized = buildNormalizedJob(validPayload);
    expect(normalized.canonicalUrl).toBe('https://jobs.example.com/acme/senior-react-developer');
  });

  it('is deterministic: same payload, same output', () => {
    const first = buildNormalizedJob(validPayload);
    const second = buildNormalizedJob(RawJobPayloadSchema.parse(validPayload));
    expect(first).toEqual(second);
  });

  it('rejects malformed payloads with ValidationError (quarantine path)', () => {
    const malformed = MOCK_PAYLOADS.find((payload) => payload.externalId === 'm-007')!;
    expect(() =>
      normalizeJob({
        sourceKey: MOCK_SOURCE_KEY,
        externalId: malformed.externalId,
        fetchedAt: new Date(),
        data: malformed,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects invalid salary ranges', () => {
    const invalid = { ...validPayload, salaryMin: 99000, salaryMax: 1000 };
    expect(() => buildNormalizedJob(RawJobPayloadSchema.parse(invalid))).toThrow();
  });
});