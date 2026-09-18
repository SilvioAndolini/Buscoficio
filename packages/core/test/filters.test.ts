import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEDUP_THRESHOLDS,
  computeFuzzyScore,
  evaluateHardFilters,
  resolveFuzzyDecision,
} from '../src/index.js';

describe('fuzzy score and decisions (L3)', () => {
  it('combines title and description similarity with fixed weights', () => {
    expect(computeFuzzyScore(1, 1)).toBe(1);
    expect(computeFuzzyScore(0, 0)).toBe(0);
    expect(computeFuzzyScore(1, 0)).toBeCloseTo(0.6, 5);
    expect(computeFuzzyScore(0, 1)).toBeCloseTo(0.4, 5);
  });

  it('maps scores to merge/review/distinct with configurable thresholds', () => {
    const thresholds = { high: 0.9, medium: 0.7 };
    expect(resolveFuzzyDecision(0.95, thresholds)).toBe('merge');
    expect(resolveFuzzyDecision(0.9, thresholds)).toBe('merge');
    expect(resolveFuzzyDecision(0.8, thresholds)).toBe('review');
    expect(resolveFuzzyDecision(0.7, thresholds)).toBe('review');
    expect(resolveFuzzyDecision(0.69, thresholds)).toBe('distinct');
  });

  it('exposes safe defaults in one place', () => {
    expect(DEFAULT_DEDUP_THRESHOLDS).toEqual({ high: 0.92, medium: 0.75 });
  });
});

describe('hard eligibility filters', () => {
  const job = {
    company: 'Acme Corp',
    title: 'Senior React Developer',
    description: 'Build internal tools with React and TypeScript.',
    location: 'Remote (EU)',
    remoteType: 'remote' as const,
  };

  it('allows everything with an empty configuration', () => {
    expect(evaluateHardFilters(job, {}).allowed).toBe(true);
  });

  it('rejects excluded companies with rule and reason', () => {
    const decision = evaluateHardFilters(job, { excludedCompanies: ['acme'] });
    expect(decision.allowed).toBe(false);
    expect(decision.rejections[0]).toMatchObject({ rule: 'excludedCompanies' });
    expect(decision.rejections[0]!.reason).toContain('Acme Corp');
  });

  it('rejects excluded keywords and missing required keywords', () => {
    const excluded = evaluateHardFilters(job, { excludedKeywords: ['internal tools'] });
    expect(excluded.rejections[0]?.rule).toBe('excludedKeywords');

    const required = evaluateHardFilters(job, { requiredKeywords: ['python', 'golang'] });
    expect(required.rejections[0]?.rule).toBe('requiredKeywords');
    expect(required.rejections[0]!.reason).toContain('python');
  });

  it('rejects locations outside the allowlist and unknown locations', () => {
    const outside = evaluateHardFilters(job, { allowedCountries: ['Spain'] });
    expect(outside.rejections[0]?.rule).toBe('allowedCountries');

    const unknown = evaluateHardFilters({ ...job, location: null }, { allowedCountries: ['Spain'] });
    expect(unknown.rejections[0]!.reason).toContain('location unknown');
  });

  it('rejects disallowed remote types only when the type is known', () => {
    const rejected = evaluateHardFilters(job, { allowedRemoteTypes: ['onsite'] });
    expect(rejected.rejections[0]?.rule).toBe('allowedRemoteTypes');

    const unknown = evaluateHardFilters({ ...job, remoteType: null }, { allowedRemoteTypes: ['onsite'] });
    expect(unknown.allowed).toBe(true);
  });
});