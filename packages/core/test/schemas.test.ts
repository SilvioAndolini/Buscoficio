import { describe, expect, it } from 'vitest';
import { CandidateProfileInputSchema } from '../src/schemas/candidate.js';
import { NormalizedJobSchema } from '../src/schemas/job.js';
import { ResumeInputSchema } from '../src/schemas/resume.js';

describe('NormalizedJobSchema', () => {
  const valid = {
    externalId: 'ext-1',
    canonicalUrl: 'https://example.com/jobs/1',
    company: 'Acme',
    title: 'Developer',
    description: 'A job.',
    location: null,
    remoteType: 'remote',
    employmentType: 'full_time',
    salaryMin: 50000,
    salaryMax: 70000,
    currency: 'EUR',
    experienceLevel: 'mid',
    languageRequirements: ['en'],
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: null,
    applicationMethod: 'external_form',
  };

  it('accepts a valid normalized job', () => {
    expect(NormalizedJobSchema.parse(valid).title).toBe('Developer');
  });

  it('rejects malformed jobs (missing title)', () => {
    const { title: _title, ...malformed } = valid;
    expect(NormalizedJobSchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects invalid salary ranges', () => {
    expect(NormalizedJobSchema.safeParse({ ...valid, salaryMin: 90000 }).success).toBe(false);
  });

  it('rejects empty descriptions', () => {
    expect(NormalizedJobSchema.safeParse({ ...valid, description: '   ' }).success).toBe(false);
  });
});

describe('CandidateProfileInputSchema', () => {
  it('applies safe defaults', () => {
    const profile = CandidateProfileInputSchema.parse({
      fullName: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    expect(profile.remotePreference).toEqual([]);
    expect(profile.employmentTypes).toEqual([]);
    expect(profile.relocation).toBe(false);
    expect(profile.preferences).toEqual({});
  });

  it('rejects invalid emails', () => {
    const result = CandidateProfileInputSchema.safeParse({
      fullName: 'Ada',
      email: 'not-an-email',
    });
    expect(result.success).toBe(false);
  });
});

describe('ResumeInputSchema', () => {
  it('validates slugs and applies defaults', () => {
    const resume = ResumeInputSchema.parse({ name: 'Engineering CV', category: 'software-engineering' });
    expect(resume.language).toBe('en');
    expect(resume.isDefault).toBe(false);
    expect(ResumeInputSchema.safeParse({ name: 'x', category: 'Not A Slug' }).success).toBe(false);
  });
});