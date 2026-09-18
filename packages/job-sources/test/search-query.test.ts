import { describe, expect, it } from 'vitest';
import { evaluateSearchQuery } from '../src/util/search-query.js';

const view = {
  title: 'Senior TypeScript Developer',
  description: 'Build React and TypeScript tools for a data platform.',
  company: 'Acme Corp',
  tags: ['typescript', 'react'],
  location: 'Remote (EU)',
  remoteType: 'remote' as const,
};

const baseQuery = { keywords: [], page: 1 };

describe('evaluateSearchQuery (SearchConfig semantics)', () => {
  it('an offer with no configured filters always belongs to the search', () => {
    expect(evaluateSearchQuery(view, baseQuery).matches).toBe(true);
  });

  it('keywords: at least one keyword must appear (title/description/company/tags)', () => {
    expect(evaluateSearchQuery(view, { ...baseQuery, keywords: ['typescript'] }).matches).toBe(true);
    expect(evaluateSearchQuery(view, { ...baseQuery, keywords: ['REACT', 'go'] }).matches).toBe(true);
    expect(evaluateSearchQuery(view, { ...baseQuery, keywords: ['python'] }).matches).toBe(false);
    expect(
      evaluateSearchQuery(view, { ...baseQuery, keywords: ['python'] }).reasons[0],
    ).toContain('python');
  });

  it('locations: normalized match required when configured', () => {
    expect(evaluateSearchQuery(view, { ...baseQuery, locations: ['EU'] }).matches).toBe(true);
    expect(evaluateSearchQuery(view, { ...baseQuery, locations: ['Spain'] }).matches).toBe(false);
    expect(
      evaluateSearchQuery(view, { ...baseQuery, locations: ['Spain'] }).reasons[0],
    ).toContain('outside');
  });

  it('locations: unknown location is allowed only for remote-only searches (documented rule)', () => {
    const unknown = { ...view, location: null };
    expect(
      evaluateSearchQuery(unknown, { ...baseQuery, locations: ['Spain'], remote: true }).matches,
    ).toBe(true);
    expect(
      evaluateSearchQuery(unknown, { ...baseQuery, locations: ['Spain'], remote: false }).matches,
    ).toBe(false);
  });

  it('remote=true excludes clearly onsite offers; unknown never excludes', () => {
    expect(evaluateSearchQuery(view, { ...baseQuery, remote: true }).matches).toBe(true);
    const onsite = { ...view, remoteType: 'onsite' as const };
    expect(evaluateSearchQuery(onsite, { ...baseQuery, remote: true }).matches).toBe(false);
    const unknownType = { ...view, remoteType: null };
    expect(evaluateSearchQuery(unknownType, { ...baseQuery, remote: true }).matches).toBe(true);
  });

  it('remote=false excludes clearly remote offers', () => {
    expect(evaluateSearchQuery(view, { ...baseQuery, remote: false }).matches).toBe(false);
    const onsite = { ...view, remoteType: 'onsite' as const };
    expect(evaluateSearchQuery(onsite, { ...baseQuery, remote: false }).matches).toBe(true);
  });

  it('combines all filters (the SearchConfig example)', () => {
    expect(
      evaluateSearchQuery(view, {
        keywords: ['typescript'],
        locations: ['Spain'],
        remote: true,
        page: 1,
      }).matches,
    ).toBe(false);
    expect(
      evaluateSearchQuery(view, {
        keywords: ['typescript'],
        locations: ['EU'],
        remote: true,
        page: 1,
      }).matches,
    ).toBe(true);
  });
});