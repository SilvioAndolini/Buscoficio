import { InternalError, normalizeForDedup } from '@job-system/core';
import type { ExperienceLevel } from '@job-system/core';
import type {
  MatchCandidateExperience,
  MatchCandidateLanguage,
  MatchCandidateProfile,
  MatchCandidateSkill,
  MatchJob,
  MatchLanguageLevel,
  SignalResult,
} from './types.js';

const ABSENT = (reason: string, details: string[] = []): SignalResult => ({
  score: null,
  details,
  reason,
  missingRequirements: [],
  matchingSkills: [],
  hardViolations: [],
});

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

export function skillsMatch(job: MatchJob, skills: MatchCandidateSkill[]): SignalResult {
  const required = job.requiredSkills;
  const preferred = job.preferredSkills;
  if (required.length === 0 && preferred.length === 0) {
    return ABSENT('job has no required or preferred skills');
  }

  const index = new Map<string, MatchCandidateSkill>();
  for (const skill of skills) {
    index.set(normalizeForDedup(skill.skillName), skill);
    for (const alias of skill.aliases) index.set(normalizeForDedup(alias), skill);
  }

  const matches = (skillText: string): MatchCandidateSkill | undefined =>
    index.get(normalizeForDedup(skillText));

  const matchingSkills: string[] = [];
  const missingRequirements: string[] = [];
  let requiredMatched = 0;
  for (const skillText of required) {
    if (matches(skillText)) {
      requiredMatched += 1;
      matchingSkills.push(skillText);
    } else {
      missingRequirements.push(`Missing required skill: ${skillText}`);
    }
  }
  let preferredMatched = 0;
  for (const skillText of preferred) {
    if (matches(skillText)) {
      preferredMatched += 1;
      matchingSkills.push(skillText);
    }
  }

  const requiredCoverage = required.length === 0 ? null : requiredMatched / required.length;
  const preferredCoverage = preferred.length === 0 ? null : preferredMatched / preferred.length;
  let score: number;
  if (requiredCoverage !== null && preferredCoverage !== null) {
    score = 0.7 * requiredCoverage + 0.3 * preferredCoverage;
  } else {
    score = requiredCoverage ?? preferredCoverage ?? 0;
  }

  const details = [
    `required matched ${requiredMatched}/${required.length}`,
    `preferred matched ${preferredMatched}/${preferred.length}`,
  ];
  return {
    score: clamp01(round4(score)),
    details,
    reason: null,
    missingRequirements,
    matchingSkills,
    hardViolations: [...missingRequirements],
  };
}

/* ------------------------------------------------------------------ */
/* Experience                                                          */
/* ------------------------------------------------------------------ */

const MIN_YEARS_BY_LEVEL: Record<ExperienceLevel, number> = {
  intern: 0,
  junior: 0,
  mid: 2,
  senior: 5,
  lead: 8,
  principal: 10,
  unknown: 0,
};

const MONTH_MS = 1000 * 60 * 60 * 24 * 30.4375;

function asOfLabel(asOfDate: Date): string {
  return asOfDate.toISOString().slice(0, 10);
}

/**
 * Deterministic years computation from experience ranges (doc 08 §5: only
 * strictly computable values). Closed roles use their `endDate`; open-ended
 * roles use the explicit `asOfDate` provided by the caller (originated in the
 * injected Clock). The pure engine NEVER reads the wall clock, and the anchor
 * participates in the match identity (engine v2).
 *
 * `asOfDate` is required (and validated) when at least one role is open-ended.
 */
export function computeExperienceMonths(
  experiences: MatchCandidateExperience[],
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

export function experienceMatch(
  job: MatchJob,
  experiences: MatchCandidateExperience[],
  skills: MatchCandidateSkill[],
  asOfDate: Date | null,
): SignalResult {
  if (job.experienceLevel === null || job.experienceLevel === 'unknown') {
    return ABSENT('job does not specify an experience level');
  }
  if (experiences.length === 0) {
    return ABSENT('candidate has no structured experience');
  }
  const hasOpenEnded = experiences.some((experience) => experience.endDate === null);
  const months = computeExperienceMonths(experiences, asOfDate);
  const years = round4(months / 12);
  const minimum = MIN_YEARS_BY_LEVEL[job.experienceLevel];
  const details = [
    hasOpenEnded && asOfDate !== null
      ? `candidate ~${years} years as of ${asOfLabel(asOfDate)} (open-ended experience)`
      : `candidate ~${years} years from closed experience ranges`,
    `level '${job.experienceLevel}' minimum ${minimum} years`,
  ];

  const requiredSkills = new Set(job.requiredSkills.map((skill) => normalizeForDedup(skill)));
  for (const skill of skills) {
    if (skill.years !== null && requiredSkills.has(normalizeForDedup(skill.skillName))) {
      details.push(`candidate_skill '${skill.skillName}': ${skill.years} years`);
    }
  }

  const score = minimum === 0 ? 1 : clamp01(years / minimum);
  return {
    score: clamp01(round4(score)),
    details,
    reason: null,
    missingRequirements: [],
    matchingSkills: [],
    hardViolations: [],
  };
}

/* ------------------------------------------------------------------ */
/* Location                                                            */
/* ------------------------------------------------------------------ */

export function locationMatch(job: MatchJob, profile: MatchCandidateProfile): SignalResult {
  const country = profile.locationCountry === null ? null : normalizeForDedup(profile.locationCountry);
  const jobLocation = job.location === null ? null : normalizeForDedup(job.location);
  const preferences = profile.remotePreference;

  if (job.remoteType === null && jobLocation === null) {
    return ABSENT('job has no location or modality');
  }

  if (job.remoteType === 'remote') {
    if (preferences.length === 0) return ABSENT('candidate has no remote preference');
    if (preferences.includes('remote')) {
      return {
        score: 1,
        details: ['remote job', 'candidate prefers remote'],
        reason: null,
        missingRequirements: [],
        matchingSkills: [],
        hardViolations: [],
      };
    }
    return {
      score: 0.2,
      details: ['remote job', `candidate preferences: ${preferences.join(', ')}`],
      reason: null,
      missingRequirements: [],
      matchingSkills: [],
      hardViolations: [],
    };
  }

  if (jobLocation !== null && country !== null && jobLocation.includes(country)) {
    return {
      score: 1,
      details: ['same country', `job location: ${job.location}`],
      reason: null,
      missingRequirements: [],
      matchingSkills: [],
      hardViolations: [],
    };
  }
  if (profile.relocation) {
    return {
      score: 0.6,
      details: ['candidate accepts relocation', job.location === null ? 'job location unspecified' : `job location: ${job.location}`],
      reason: null,
      missingRequirements: [],
      matchingSkills: [],
      hardViolations: [],
    };
  }
  if (jobLocation !== null && country !== null) {
    return {
      score: 0.1,
      details: ['onsite/hybrid incompatible with candidate location', `job location: ${job.location}`],
      reason: null,
      missingRequirements: [`Location: job requires onsite/hybrid in '${job.location}' and candidate is in '${profile.locationCountry}'`],
      matchingSkills: [],
      hardViolations: [],
    };
  }
  return ABSENT('not enough location data to compare');
}

/* ------------------------------------------------------------------ */
/* Salary                                                              */
/* ------------------------------------------------------------------ */

export function salaryMatch(job: MatchJob, profile: MatchCandidateProfile): SignalResult {
  if (job.salaryMin === null || job.salaryMax === null || profile.salaryMin === null || profile.salaryMax === null) {
    return ABSENT('job or candidate salary range is unknown');
  }
  if (
    job.currency !== null &&
    profile.salaryCurrency !== null &&
    job.currency !== profile.salaryCurrency
  ) {
    return ABSENT(`currency mismatch (${job.currency} vs ${profile.salaryCurrency})`);
  }
  const jobMin = Math.min(job.salaryMin, job.salaryMax);
  const jobMax = Math.max(job.salaryMin, job.salaryMax);
  const candidateMin = Math.min(profile.salaryMin, profile.salaryMax);
  const candidateMax = Math.max(profile.salaryMin, profile.salaryMax);
  const overlap = Math.max(0, Math.min(jobMax, candidateMax) - Math.max(jobMin, candidateMin));
  const union = Math.max(jobMax, candidateMax) - Math.min(jobMin, candidateMin);
  const score = union <= 0 ? 1 : clamp01(overlap / union);
  const currency = job.currency ?? profile.salaryCurrency ?? '';
  const details = [
    `job range ${jobMin}-${jobMax} ${currency}`,
    `candidate range ${candidateMin}-${candidateMax} ${currency}`,
    `overlap ${Math.round((overlap / Math.max(1, jobMax - jobMin || 1)) * 100)}% of job range`,
  ];
  const missingRequirements =
    jobMax < candidateMin
      ? [`Salary: job maximum ${jobMax} ${currency} is below candidate minimum ${candidateMin} ${currency}`]
      : [];
  return {
    score: round4(score),
    details,
    reason: null,
    missingRequirements,
    matchingSkills: [],
    hardViolations: [],
  };
}

/* ------------------------------------------------------------------ */
/* Language                                                            */
/* ------------------------------------------------------------------ */

const LANGUAGE_ALIASES: Record<string, string> = {
  en: 'english',
  eng: 'english',
  es: 'spanish',
  spa: 'spanish',
  de: 'german',
  ger: 'german',
  fr: 'french',
  fra: 'french',
  pt: 'portuguese',
  por: 'portuguese',
  it: 'italian',
  ita: 'italian',
  ca: 'catalan',
  nl: 'dutch',
};

const LEVEL_ORDER: Record<MatchLanguageLevel, number> = {
  A1: 1,
  A2: 2,
  B1: 3,
  B2: 4,
  C1: 5,
  C2: 6,
  native: 7,
};

function canonicalLanguage(value: string): string {
  const normalized = normalizeForDedup(value);
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

export interface ParsedLanguageRequirement {
  language: string;
  level: MatchLanguageLevel | null;
  source: string;
}

/** Deterministic parser for free-text requirements like "English B2". */
export function parseLanguageRequirement(text: string): ParsedLanguageRequirement {
  const match = /^(.*?)[\s(:-]*(native|A1|A2|B1|B2|C1|C2)?[\s)]*$/i.exec(text.trim());
  const languagePart = (match?.[1] ?? text).trim();
  const levelPart = match?.[2];
  const level =
    levelPart === undefined
      ? null
      : (levelPart.charAt(0).toUpperCase() + levelPart.slice(1).toLowerCase()) as MatchLanguageLevel;
  return { language: canonicalLanguage(languagePart), level, source: text };
}

export function languageMatch(job: MatchJob, languages: MatchCandidateLanguage[]): SignalResult {
  if (job.languageRequirements.length === 0) return ABSENT('job has no explicit language requirements');
  const index = new Map<string, MatchLanguageLevel>();
  for (const entry of languages) {
    index.set(canonicalLanguage(entry.language), entry.level);
  }

  let met = 0;
  const hardViolations: string[] = [];
  const details: string[] = [];
  for (const requirement of job.languageRequirements) {
    const parsed = parseLanguageRequirement(requirement);
    const candidateLevel = index.get(parsed.language);
    if (candidateLevel === undefined) {
      hardViolations.push(`Language requirement not met: ${requirement}; profile has no ${parsed.language}`);
      details.push(`${requirement}: not present in profile`);
      continue;
    }
    if (parsed.level !== null && LEVEL_ORDER[candidateLevel] < LEVEL_ORDER[parsed.level]) {
      const label = parsed.language.charAt(0).toUpperCase() + parsed.language.slice(1);
      hardViolations.push(
        `${label} ${parsed.level} required; profile indicates ${candidateLevel}`,
      );
      details.push(`${requirement}: profile indicates ${candidateLevel}`);
      continue;
    }
    met += 1;
    details.push(`${requirement}: met (${candidateLevel})`);
  }

  return {
    score: clamp01(round4(met / job.languageRequirements.length)),
    details,
    reason: null,
    missingRequirements: [...hardViolations],
    matchingSkills: [],
    hardViolations,
  };
}

/* ------------------------------------------------------------------ */
/* Employment type                                                     */
/* ------------------------------------------------------------------ */

export function employmentTypeMatch(
  job: MatchJob,
  profile: MatchCandidateProfile,
): SignalResult {
  if (job.employmentType === null) return ABSENT('job does not specify an employment type');
  if (profile.employmentTypes.length === 0) return ABSENT('candidate has no employment type preferences');
  if (profile.employmentTypes.includes(job.employmentType)) {
    return {
      score: 1,
      details: [`job '${job.employmentType}' matches candidate preferences`],
      reason: null,
      missingRequirements: [],
      matchingSkills: [],
      hardViolations: [],
    };
  }
  return {
    score: 0,
    details: [`job '${job.employmentType}' is not in candidate preferences: ${profile.employmentTypes.join(', ')}`],
    reason: null,
    missingRequirements: [],
    matchingSkills: [],
    hardViolations: [],
  };
}