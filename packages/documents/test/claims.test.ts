import { describe, expect, it } from 'vitest';
import type { Claim, ProfileFactsView } from '@job-system/core';
import { computeExperienceMonths, validateClaims } from '../src/claims.js';
import { buildFacts } from './helpers/fixtures.js';

const AS_OF = new Date('2026-09-18T00:00:00Z');

function claim(partial: Partial<Claim> & Pick<Claim, 'kind'>): Claim {
  return {
    claim: partial.claim ?? 'claim text',
    kind: partial.kind,
    ...(partial.value === undefined ? {} : { value: partial.value }),
    sourceRefs: partial.sourceRefs ?? [],
    verified: partial.verified ?? 'unverifiable',
  };
}

function validate(claims: Claim[], facts: ProfileFactsView = buildFacts()) {
  return validateClaims(claims, facts, { asOfDate: AS_OF });
}

describe('deterministic claim validation (Phase 4)', () => {
  it('accepts "5 years React" only with candidate_skill.years = 5', () => {
    const result = validate([
      claim({ kind: 'years_experience', claim: '5 years React', value: { years: 5, skill: 'React' } }),
    ]);
    expect(result.verification.status).toBe('verified');
    expect(result.claims[0]!.sourceRefs[0]).toMatchObject({
      entityType: 'candidate_skill',
      field: 'years',
    });
  });

  it('rejects skill years when candidate_skill.years is NULL (never inferred)', () => {
    const result = validate([
      claim({
        kind: 'years_experience',
        claim: '5 years TypeScript',
        value: { years: 5, skill: 'TypeScript' },
      }),
    ]);
    expect(result.verification.status).toBe('rejected');
    expect(result.verification.failures[0]!.reason).toMatch(/no structured years/i);
  });

  it('rejects a claim above the structured value (6 vs 5)', () => {
    const result = validate([
      claim({ kind: 'years_experience', claim: '6 years React', value: { years: 6, skill: 'React' } }),
    ]);
    expect(result.verification.status).toBe('rejected');
    expect(result.verification.failures[0]!.reason).toMatch(/exceeds candidate_skill/);
  });

  it('accepts an unknown skill alias match (React.js)', () => {
    const result = validate([
      claim({ kind: 'years_experience', claim: '5 years React.js', value: { years: 5, skill: 'React.js' } }),
    ]);
    expect(result.verification.status).toBe('verified');
  });

  it('computes general experience conservatively (5.7 computed ⇒ 5 ok, 6 rejected)', () => {
    // Overlapping ranges: 2016-01..2017-06 (1.42y) + 2018-01..2024-01 (6y) = 7.4y
    const five = validate([
      claim({ kind: 'years_experience', claim: '5 years of experience', value: { years: 5 } }),
    ]);
    expect(five.verification.status).toBe('verified');
    const over = validate([
      claim({ kind: 'years_experience', claim: '9 years of experience', value: { years: 9 } }),
    ]);
    expect(over.verification.status).toBe('rejected');
    expect(over.verification.failures[0]!.reason).toMatch(/computable/);
  });

  it('never double counts overlapping ranges and honours the asOfDate anchor', () => {
    const facts = buildFacts({
      experiences: [
        {
          id: '20000000-0000-4000-8000-000000000010',
          company: 'A',
          title: 'Dev',
          startDate: new Date('2020-01-01T00:00:00Z'),
          endDate: null,
          skills: [],
        },
      ],
    });
    const months = computeExperienceMonths(facts.experiences, AS_OF);
    expect(months / 12).toBeGreaterThan(6);
    const result = validate(
      [claim({ kind: 'years_experience', claim: '6 years', value: { years: 6 } })],
      facts,
    );
    expect(result.verification.status).toBe('verified');
  });

  it('verifies an exact company and rejects an invented one', () => {
    const exact = validate([claim({ kind: 'company', claim: 'Acme Corp', value: { company: 'Acme Corp' } })]);
    expect(exact.verification.status).toBe('verified');
    const invented = validate([
      claim({ kind: 'company', claim: 'Initech', value: { company: 'Initech' } }),
    ]);
    expect(invented.verification.status).toBe('rejected');
  });

  it('verifies an exact job title and rejects a semantic upgrade', () => {
    const exact = validate([
      claim({ kind: 'job_title', claim: 'Senior Developer', value: { title: 'Senior Developer' } }),
    ]);
    expect(exact.verification.status).toBe('verified');
    const upgraded = validate([
      claim({ kind: 'job_title', claim: 'Principal Architect', value: { title: 'Principal Architect' } }),
    ]);
    expect(upgraded.verification.status).toBe('rejected');
  });

  it('verifies an existing degree and rejects an invented certification', () => {
    const degree = validate([
      claim({
        kind: 'degree',
        claim: 'BSc Computer Science',
        value: { degree: 'BSc Computer Science', institution: 'University of London' },
      }),
    ]);
    expect(degree.verification.status).toBe('verified');

    const certification = validate([
      claim({ kind: 'certification', claim: 'AWS Certified', value: { name: 'AWS Certified' } }),
    ]);
    expect(certification.verification.status).toBe('rejected');
    expect(certification.verification.failures[0]!.reason).toMatch(/certification/);

    const project = validate([claim({ kind: 'project', claim: 'Apollo', value: { name: 'Apollo' } })]);
    expect(project.verification.status).toBe('rejected');
  });

  it('never elevates language level (C1 ok, C2 rejected against profile B2/C1)', () => {
    const c1 = validate([
      claim({ kind: 'language_level', claim: 'English C1', value: { language: 'English', level: 'C1' } }),
    ]);
    expect(c1.verification.status).toBe('verified');
    const c2 = validate([
      claim({ kind: 'language_level', claim: 'English C2', value: { language: 'English', level: 'C2' } }),
    ]);
    expect(c2.verification.status).toBe('rejected');
    expect(c2.verification.failures[0]!.reason).toMatch(/exceeds/);
    const b2 = validate([
      claim({ kind: 'language_level', claim: 'English B2', value: { language: 'English', level: 'B2' } }),
    ]);
    expect(b2.verification.status).toBe('verified');
  });

  it('validates salary only against explicit profile fields and currency', () => {
    const ok = validate([
      claim({
        kind: 'salary',
        claim: '70k EUR',
        value: { amount: 70_000, currency: 'EUR' },
      }),
    ]);
    expect(ok.verification.status).toBe('verified');

    const currency = validate([
      claim({ kind: 'salary', claim: '70k USD', value: { amount: 70_000, currency: 'USD' } }),
    ]);
    expect(currency.verification.status).toBe('unverifiable');

    const low = validate([
      claim({ kind: 'salary', claim: '10k EUR', value: { amount: 10_000, currency: 'EUR' } }),
    ]);
    expect(low.verification.status).toBe('rejected');

    const withoutFacts = buildFacts({
      profile: {
        id: '00000000-0000-4000-8000-000000000001',
        fullName: 'Ada Lovelace',
        headline: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
      },
    });
    const missing = validate(
      [claim({ kind: 'salary', claim: '70k EUR', value: { amount: 70_000, currency: 'EUR' } })],
      withoutFacts,
    );
    expect(missing.verification.status).toBe('unverifiable');
  });

  it('marks seniority as unverifiable (no explicit source)', () => {
    const result = validate([claim({ kind: 'seniority', claim: 'Senior engineer', value: { level: 'senior' } })]);
    expect(result.verification.status).toBe('unverifiable');
  });

  it('rejects malformed structured values instead of trusting the LLM', () => {
    const result = validate([
      claim({ kind: 'years_experience', claim: 'many years', value: { years: 'lots' } }),
      claim({ kind: 'date_range', claim: 'since 2020', value: { start: 'not-a-date', end: null } }),
    ]);
    expect(result.verification.status).toBe('rejected');
    expect(result.verification.failures).toHaveLength(2);
  });

  it('verifies an exact date range and rejects a mismatched one', () => {
    const ok = validate([
      claim({
        kind: 'date_range',
        claim: '2018-01 to 2024-01',
        value: { start: '2018-01', end: '2024-01' },
      }),
    ]);
    expect(ok.verification.status).toBe('verified');
    const wrong = validate([
      claim({
        kind: 'date_range',
        claim: '2019-01 to 2024-01',
        value: { start: '2019-01', end: '2024-01' },
      }),
    ]);
    expect(wrong.verification.status).toBe('rejected');
  });

  it('aggregates status: any rejected ⇒ rejected, else any unverifiable ⇒ unverifiable', () => {
    const mixed = validate([
      claim({ kind: 'company', claim: 'Acme Corp', value: { company: 'Acme Corp' } }),
      claim({ kind: 'seniority', claim: 'Senior', value: {} }),
    ]);
    expect(mixed.verification.status).toBe('unverifiable');

    const withRejected = validate([
      claim({ kind: 'company', claim: 'Acme Corp', value: { company: 'Acme Corp' } }),
      claim({ kind: 'company', claim: 'Initech', value: { company: 'Initech' } }),
    ]);
    expect(withRejected.verification.status).toBe('rejected');
  });
});
