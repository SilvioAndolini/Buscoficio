import { normalizeForDedup, sha256Hex } from '@job-system/core';
import type {
  MatchCandidateExperience,
  MatchCandidateLanguage,
  MatchCandidateProfile,
  MatchCandidateSkill,
  MatchResume,
} from './types.js';

/**
 * Canonical matching hashes (architecture doc 03 §6). Deterministic: no
 * timestamps, no accidental array order, no random ids. Only fields that
 * actually affect the score are included (education is not scored, so it is
 * intentionally excluded; adding it later means a new engine version).
 */

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

/** Stable JSON: object keys sorted recursively so key order never matters. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, sortValue(entry)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

function dayOf(date: Date | null): string {
  return date === null ? '' : date.toISOString().slice(0, 10);
}

export function computeCandidateProfileHash(input: {
  profile: MatchCandidateProfile;
  skills: MatchCandidateSkill[];
  languages: MatchCandidateLanguage[];
  experiences: MatchCandidateExperience[];
}): string {
  const profile = input.profile;
  // Aliases participate in skillsMatch, so they MUST participate in the hash
  // (normalized, deduplicated and sorted: alias order never changes it).
  const skills = [...input.skills]
    .map(
      (skill) =>
        [
          normalizeForDedup(skill.skillName),
          [...new Set(skill.aliases.map((alias) => normalizeForDedup(alias)))].sort(),
          skill.level,
          skill.years ?? '',
        ] as const,
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const languages = [...input.languages]
    .map((language) => [language.language.toLowerCase(), language.level] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const experiences = [...input.experiences]
    .map(
      (experience) =>
        [
          experience.company.toLowerCase(),
          experience.title.toLowerCase(),
          dayOf(experience.startDate),
          dayOf(experience.endDate),
          [...experience.skills].map((skill) => skill.toLowerCase()).sort().join(','),
        ] as const,
    )
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));

  return sha256Hex(
    canonical({
      locationCity: profile.locationCity?.toLowerCase() ?? null,
      locationCountry: profile.locationCountry?.toLowerCase() ?? null,
      salaryMin: profile.salaryMin,
      salaryMax: profile.salaryMax,
      salaryCurrency: profile.salaryCurrency,
      remotePreference: [...profile.remotePreference].sort(),
      employmentTypes: [...profile.employmentTypes].sort(),
      allowedCountries: [...profile.allowedCountries].map((c) => c.toLowerCase()).sort(),
      relocation: profile.relocation,
      skills,
      languages,
      experiences,
    }),
  );
}

/**
 * Resume set relevant to matching: the latest immutable version of every
 * resume, including canonicalized highlights (they feed skill coverage and the
 * embedding text). Creating a new ResumeVersion changes the hash; the previous
 * version stays untouched.
 */
export function computeResumeSetHash(resumes: MatchResume[]): string {
  const entries = [...resumes]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((resume) => [
      resume.id,
      resume.category,
      resume.language,
      resume.latestVersion?.id ?? null,
      resume.latestVersion?.versionNumber ?? null,
      resume.latestVersion?.fileHash ?? null,
      resume.latestVersion?.kind ?? null,
      resume.latestVersion === null ? null : canonicalJson(resume.latestVersion.highlights),
    ]);
  return sha256Hex(canonical(entries));
}

export interface IdentityHashInput {
  engineVersion: string;
  weightsVersion: string;
  jobContentHash: string;
  candidateProfileHash: string;
  resumeSetHash: string;
  embeddingSpaceId: string | null;
  /**
   * Temporal anchor (YYYY-MM-DD) when open-ended experience exists; null when
   * the score is time-independent (all experiences closed).
   */
  matchingAsOfDate: string | null;
}

/** `'none'` is the explicit canonical token when a component does not apply. */
export function computeIdentityHash(input: IdentityHashInput): string {
  return sha256Hex(
    [
      input.engineVersion,
      input.weightsVersion,
      input.jobContentHash,
      input.candidateProfileHash,
      input.resumeSetHash,
      input.embeddingSpaceId ?? 'none',
      input.matchingAsOfDate ?? 'none',
    ].join('|'),
  );
}
