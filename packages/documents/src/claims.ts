import {
  InternalError,
  LanguageLevelSchema,
  languageLevelRank,
  normalizeForDedup,
  type Claim,
  type ClaimFailure,
  type ClaimValidation,
  type FactExperience,
  type FactSkill,
  type ProfileFactsView,
  type SourceRef,
  type VerificationResult,
  type VerificationStatus,
} from '@job-system/core';
import { asFiniteNumber, asRecord, asString } from './value.js';

/**
 * Deterministic factual authority (architecture docs 03 §8, 08 §5).
 * No LLM/Jev participates: the validator recomputes `verified` for every claim
 * from structured profile entities. `sourceRefs` are built here from the entity
 * that actually matched — provider-proposed refs are never trusted.
 */

const MONTH_MS = 1000 * 60 * 60 * 24 * 30.4375;

function normalizeFact(value: string): string {
  return normalizeForDedup(value)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function parseMonth(value: string): string | null {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value.trim());
  return match ? `${match[1]}-${match[2]}` : null;
}

function floor1(value: number): number {
  return Math.floor(value * 10) / 10;
}

/**
 * Same semantics as the matching engine (closed ranges merged, open-ended uses
 * the explicit anchor). Duplicated because `documents` cannot import `matching`
 * (architecture doc 11 §3); the algorithm is intentionally identical.
 */
export function computeExperienceMonths(
  experiences: FactExperience[],
  asOfDate: Date | null,
): number {
  if (experiences.length === 0) return 0;
  const hasOpenEnded = experiences.some((experience) => experience.endDate === null);
  if (hasOpenEnded && asOfDate === null) {
    throw new InternalError('computeExperienceMonths: asOfDate is required for open-ended experiences');
  }
  const ranges = experiences
    .map((experience) => {
      const start = experience.startDate.getTime();
      const end = (experience.endDate ?? asOfDate!).getTime();
      return end > start ? ([start, end] as const) : null;
    })
    .filter((range): range is readonly [number, number] => range !== null)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor: number | null = null;
  for (const [start, end] of ranges) {
    if (cursor === null || start > cursor) {
      total += end - start;
      cursor = end;
    } else if (end > cursor) {
      total += end - cursor;
      cursor = end;
    }
  }
  return total / MONTH_MS;
}

interface KindResult {
  status: VerificationStatus;
  reason?: string;
  sourceRefs: SourceRef[];
}

const rejected = (reason: string): KindResult => ({ status: 'rejected', reason, sourceRefs: [] });
const unverifiable = (reason: string): KindResult => ({
  status: 'unverifiable',
  reason,
  sourceRefs: [],
});

function findSkill(facts: ProfileFactsView, name: string): FactSkill | null {
  const target = normalizeFact(name);
  for (const skill of facts.skills) {
    if (normalizeFact(skill.name) === target) return skill;
    for (const alias of skill.aliases) {
      if (normalizeFact(alias) === target) return skill;
    }
  }
  return null;
}

function validateYearsExperience(
  value: unknown,
  facts: ProfileFactsView,
  asOfDate: Date | null,
): KindResult {
  const record = asRecord(value);
  const years = record === null ? null : asFiniteNumber(record['years']);
  if (years === null || years < 0 || years > 80) {
    return rejected('years_experience requires value.years as a number between 0 and 80');
  }
  const skillName = record === null ? null : asString(record['skill']);
  if (skillName !== null) {
    const skill = findSkill(facts, skillName);
    if (skill === null) return rejected(`no candidate_skill matches '${skillName}'`);
    if (skill.years === null) {
      return rejected(
        `candidate_skill '${skill.name}' has no structured years; years cannot be inferred from experience descriptions`,
      );
    }
    if (years > skill.years + 1e-9) {
      return rejected(
        `claimed ${years} years exceeds candidate_skill '${skill.name}' years=${skill.years}`,
      );
    }
    return {
      status: 'verified',
      sourceRefs: [{ entityType: 'candidate_skill', entityId: skill.id, field: 'years' }],
    };
  }
  if (facts.experiences.length === 0) {
    return rejected('no structured experience exists to support a general years claim');
  }
  const computed = computeExperienceMonths(facts.experiences, asOfDate) / 12;
  if (years > computed + 1e-9) {
    return rejected(
      `claimed ${years} years exceeds the computable ${floor1(computed)} years from structured experience ranges`,
    );
  }
  return {
    status: 'verified',
    sourceRefs: facts.experiences
      .slice(0, 20)
      .map((experience) => ({
        entityType: 'experience' as const,
        entityId: experience.id,
        field: 'date_range',
      })),
  };
}

function validateDateRange(value: unknown, facts: ProfileFactsView): KindResult {
  const record = asRecord(value);
  const start = record === null ? null : asString(record['start']);
  const startMonth = start === null ? null : parseMonth(start);
  if (startMonth === null) return rejected('date_range requires value.start as YYYY-MM');
  const endRaw = record === null ? undefined : record['end'];
  let endMonth: string | null;
  if (endRaw === null) {
    endMonth = null;
  } else {
    const endString = endRaw === undefined ? null : asString(endRaw);
    const parsedEnd = endString === null ? null : parseMonth(endString);
    if (parsedEnd === null) return rejected('date_range requires value.end as YYYY-MM or null');
    endMonth = parsedEnd;
  }

  for (const experience of facts.experiences) {
    if (monthKey(experience.startDate) !== startMonth) continue;
    const profileEnd = experience.endDate === null ? null : monthKey(experience.endDate);
    if (profileEnd === endMonth) {
      return {
        status: 'verified',
        sourceRefs: [{ entityType: 'experience', entityId: experience.id, field: 'date_range' }],
      };
    }
  }
  for (const education of facts.education) {
    if (education.startDate === null) continue;
    if (monthKey(education.startDate) !== startMonth) continue;
    const profileEnd = education.endDate === null ? null : monthKey(education.endDate);
    if (profileEnd === endMonth) {
      return {
        status: 'verified',
        sourceRefs: [{ entityType: 'education', entityId: education.id, field: 'date_range' }],
      };
    }
  }
  return rejected('date_range does not match any structured experience or education range');
}

function validateJobTitle(value: unknown, facts: ProfileFactsView): KindResult {
  const record = asRecord(value);
  const title = (record === null ? null : asString(record['title'])) ?? asString(value);
  if (title === null) return rejected('job_title requires a title value');
  const target = normalizeFact(title);
  for (const experience of facts.experiences) {
    if (normalizeFact(experience.title) === target) {
      return {
        status: 'verified',
        sourceRefs: [{ entityType: 'experience', entityId: experience.id, field: 'title' }],
      };
    }
  }
  return rejected(`no experience matches the title '${title}'`);
}

function validateCompany(value: unknown, facts: ProfileFactsView): KindResult {
  const record = asRecord(value);
  const company = (record === null ? null : asString(record['company'])) ?? asString(value);
  if (company === null) return rejected('company requires a company value');
  const target = normalizeFact(company);
  for (const experience of facts.experiences) {
    if (normalizeFact(experience.company) === target) {
      return {
        status: 'verified',
        sourceRefs: [{ entityType: 'experience', entityId: experience.id, field: 'company' }],
      };
    }
  }
  return rejected(`no experience matches the company '${company}'`);
}

function validateDegree(value: unknown, facts: ProfileFactsView): KindResult {
  const record = asRecord(value);
  const degree = (record === null ? null : asString(record['degree'])) ?? asString(value);
  if (degree === null) return rejected('degree requires a degree value');
  const institution = record === null ? null : asString(record['institution']);
  const target = normalizeFact(degree);
  for (const education of facts.education) {
    if (normalizeFact(education.degree) !== target) continue;
    if (institution !== null && normalizeFact(education.institution) !== normalizeFact(institution)) {
      continue;
    }
    return {
      status: 'verified',
      sourceRefs: [{ entityType: 'education', entityId: education.id, field: 'degree' }],
    };
  }
  return rejected(`no education entry matches the degree '${degree}'`);
}

function validateLanguageLevel(value: unknown, facts: ProfileFactsView): KindResult {
  const record = asRecord(value);
  const language = record === null ? null : asString(record['language']);
  const levelRaw = record === null ? null : record['level'];
  const level = typeof levelRaw === 'string' ? LanguageLevelSchema.safeParse(levelRaw) : null;
  if (language === null || level === null || !level.success) {
    return rejected('language_level requires value.language and a valid CEFR level');
  }
  const target = normalizeFact(language);
  for (const entry of facts.languages) {
    if (normalizeFact(entry.language) !== target) continue;
    if (languageLevelRank(level.data) > languageLevelRank(entry.level)) {
      return rejected(
        `claimed level ${level.data} exceeds candidate_language '${entry.language}' level ${entry.level}`,
      );
    }
    return {
      status: 'verified',
      sourceRefs: [{ entityType: 'candidate_language', entityId: entry.id, field: 'level' }],
    };
  }
  return rejected(`no candidate_language matches '${language}'`);
}

function validateSalary(value: unknown, facts: ProfileFactsView): KindResult {
  const salary = facts.salary;
  if (salary === null || (salary.min === null && salary.max === null)) {
    return unverifiable('no explicit salary fields exist in the candidate profile');
  }
  const record = asRecord(value);
  if (record === null) return rejected('salary requires a structured value with amount/currency');
  const currency = asString(record['currency']);
  if (currency === null || (salary.currency ?? '').toUpperCase() !== currency.toUpperCase()) {
    return unverifiable(
      'salary currency does not match the profile salary currency (no automatic conversion in Phase 4)',
    );
  }
  const amount = asFiniteNumber(record['amount']) ?? asFiniteNumber(record['min']);
  if (amount === null) return unverifiable('salary claim has no numeric amount');
  if (salary.min !== null && amount < salary.min) {
    return rejected(`claimed amount ${amount} is below the profile salary minimum ${salary.min}`);
  }
  if (salary.max !== null && amount > salary.max) {
    return rejected(`claimed amount ${amount} exceeds the profile salary maximum ${salary.max}`);
  }
  return {
    status: 'verified',
    sourceRefs: [{ entityType: 'candidate_profile', entityId: facts.candidateId, field: 'salary' }],
  };
}

function validateClaim(claim: Claim, facts: ProfileFactsView, asOfDate: Date | null): KindResult {
  switch (claim.kind) {
    case 'years_experience':
      return validateYearsExperience(claim.value, facts, asOfDate);
    case 'date_range':
      return validateDateRange(claim.value, facts);
    case 'job_title':
      return validateJobTitle(claim.value, facts);
    case 'company':
      return validateCompany(claim.value, facts);
    case 'degree':
      return validateDegree(claim.value, facts);
    case 'language_level':
      return validateLanguageLevel(claim.value, facts);
    case 'salary':
      return validateSalary(claim.value, facts);
    case 'certification':
      return rejected('no structured certification entity exists in the candidate profile');
    case 'project':
      return rejected('no structured project entity exists in the candidate profile');
    case 'seniority':
      return unverifiable('no explicit seniority source exists in the candidate profile');
  }
}

export function validateClaims(
  claims: Claim[],
  facts: ProfileFactsView,
  options: { asOfDate: Date | null },
): ClaimValidation {
  const validated: Claim[] = [];
  const failures: ClaimFailure[] = [];
  let sawRejected = false;
  let sawUnverifiable = false;
  for (const claim of claims) {
    const result = validateClaim(claim, facts, options.asOfDate);
    validated.push({ ...claim, verified: result.status, sourceRefs: result.sourceRefs });
    if (result.status === 'rejected') sawRejected = true;
    if (result.status === 'unverifiable') sawUnverifiable = true;
    if (result.status !== 'verified') {
      failures.push({
        claim: claim.claim,
        kind: claim.kind,
        reason: result.reason ?? 'claim could not be verified',
      });
    }
  }
  const status: VerificationStatus = sawRejected ? 'rejected' : sawUnverifiable ? 'unverifiable' : 'verified';
  const verification: VerificationResult = { status, failures };
  return { claims: validated, verification };
}
