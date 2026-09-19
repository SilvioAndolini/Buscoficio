import { describe, expect, it } from 'vitest';
import { sha256HexBytes } from '@job-system/core';
import { prepareResumeVariant } from '../src/resume-variant.js';
import { buildFacts, JOB_VIEW } from './helpers/fixtures.js';

const sourceVersion = {
  id: '00000000-0000-4000-8000-0000000000b1',
  resumeId: '00000000-0000-4000-8000-0000000000b2',
  versionNumber: 1,
  kind: 'original',
  highlights: { skills: ['React'] },
};
const asOfDate = new Date('2026-09-18T00:00:00Z');
const input = { job: JOB_VIEW, facts: buildFacts(), sourceResumeVersion: sourceVersion, asOfDate, inputHash: 'i'.repeat(64) };

describe('deterministic resume variant (Phase 4)', () => {
  it('is byte-deterministic for the same input', () => {
    const first = prepareResumeVariant(input);
    const second = prepareResumeVariant(input);
    expect(first.text).toBe(second.text);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.contentHash).toBe(sha256HexBytes(new TextEncoder().encode(first.text)));
  });

  it('only contains existing facts (no invented skills, companies or degrees)', () => {
    const draft = prepareResumeVariant(input);
    expect(draft.text).toContain('Ada Lovelace');
    expect(draft.text).toContain('Acme Corp');
    expect(draft.text).toContain('BSc Computer Science');
    expect(draft.text).toContain('English: C1');
    expect(draft.text).not.toContain('AWS');
    expect(draft.text).not.toContain('Google');
    expect(draft.text).not.toContain('PhD');
  });

  it('produces a verified general-years claim never above the computable value', () => {
    const draft = prepareResumeVariant(input);
    expect(draft.verification.status).toBe('verified');
    const yearsClaim = draft.claims.find((claim) => claim.kind === 'years_experience');
    expect(yearsClaim).toBeDefined();
    const value = yearsClaim!.value as { years: number };
    expect(value.years).toBeLessThanOrEqual(7.5);
    expect(yearsClaim!.verified).toBe('verified');
    expect(yearsClaim!.sourceRefs.length).toBeGreaterThan(0);
  });

  it('references the exact source version and stays independent from it', () => {
    const draft = prepareResumeVariant(input);
    expect(draft.sourceResumeVersionId).toBe(sourceVersion.id);
    expect(draft.generatedBy).toMatchObject({
      provider: 'deterministic',
      promptVersion: 'resume-variant/v1',
      inputHash: input.inputHash,
    });
    // The original version object is untouched (immutability).
    expect(sourceVersion).toEqual({
      id: '00000000-0000-4000-8000-0000000000b1',
      resumeId: '00000000-0000-4000-8000-0000000000b2',
      versionNumber: 1,
      kind: 'original',
      highlights: { skills: ['React'] },
    });
  });

  it('orders job-relevant skills first without adding any', () => {
    const draft = prepareResumeVariant(input);
    const reactIndex = draft.text.indexOf('- React');
    const typeScriptIndex = draft.text.indexOf('- TypeScript');
    expect(reactIndex).toBeGreaterThan(-1);
    expect(typeScriptIndex).toBeGreaterThan(-1);
    expect(reactIndex).toBeLessThan(typeScriptIndex);
  });
});
