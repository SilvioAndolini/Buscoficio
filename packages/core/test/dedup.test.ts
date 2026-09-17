import { describe, expect, it } from 'vitest';
import {
  computeDedupKey,
  computeDescriptionFingerprint,
  computeUrlHash,
  normalizeCanonicalUrl,
} from '../src/jobs/dedup.js';

describe('normalizeCanonicalUrl (L1)', () => {
  it('strips tracking params, hash and trailing slash; sorts query', () => {
    expect(
      normalizeCanonicalUrl('https://Example.com/jobs/123/?utm_source=x&b=2&a=1#fragment'),
    ).toBe('https://example.com/jobs/123?a=1&b=2');
  });

  it('removes fbclid/gclid and other known trackers', () => {
    expect(normalizeCanonicalUrl('https://x.com/j?fbclid=abc&gclid=def&id=7')).toBe(
      'https://x.com/j?id=7',
    );
  });

  it('keeps the root path', () => {
    expect(normalizeCanonicalUrl('https://x.com/')).toBe('https://x.com/');
    expect(normalizeCanonicalUrl('https://x.com')).toBe('https://x.com/');
  });

  it('is case-insensitive on host but preserves path case', () => {
    expect(normalizeCanonicalUrl('HTTPS://X.COM/Path/To/Job')).toBe('https://x.com/Path/To/Job');
  });

  it('produces identical hashes for tracking variants', () => {
    const a = computeUrlHash('https://example.com/jobs/42?utm_campaign=spring');
    const b = computeUrlHash('https://EXAMPLE.com/jobs/42/');
    expect(a).toBe(b);
  });
});

describe('description fingerprint (L2)', () => {
  const base = {
    company: 'Acme Inc',
    title: 'Senior React Developer',
    location: 'Remote',
    description: 'Build things with React and TypeScript.',
  };

  it('is stable under whitespace and casing changes', () => {
    const other = {
      company: '  acme   inc ',
      title: 'senior react   developer',
      location: 'REMOTE',
      description: 'Build things   with React\nand TypeScript.',
    };
    expect(computeDescriptionFingerprint(other)).toBe(computeDescriptionFingerprint(base));
  });

  it('changes when the title changes', () => {
    const variant = { ...base, title: 'Senior Angular Developer' };
    expect(computeDescriptionFingerprint(variant)).not.toBe(computeDescriptionFingerprint(base));
  });

  it('changes when the description changes materially', () => {
    const variant = { ...base, description: 'Build things with Vue.' };
    expect(computeDescriptionFingerprint(variant)).not.toBe(computeDescriptionFingerprint(base));
  });

  it('uses the approved L2 formula and dedup key alias', () => {
    expect(computeDedupKey(base)).toBe(computeDescriptionFingerprint(base));
    expect(computeDedupKey(base)).toHaveLength(64);
  });
});