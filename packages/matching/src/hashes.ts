import { sha256Hex } from '@job-system/core';
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
 * actually affect the v1 score are included (education is not scored in v1,
 * so it is intentionally excluded; adding it later means a new engine version).
 */

function canonical(value: unknown): string {
  return JSON.stringify(value);
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
  const skills = [...input.skills]
    .map((skill) => [skill.skillName.toLowerCase(), skill.level, skill.years ?? ''] as const)
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
 * resume. Creating a new ResumeVersion changes the hash (and therefore the
 * match identity); the previous version stays untouched.
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
}

/** `'none'` is the explicit canonical token when no semantic space applies. */
export function computeIdentityHash(input: IdentityHashInput): string {
  return sha256Hex(
    [
      input.engineVersion,
      input.weightsVersion,
      input.jobContentHash,
      input.candidateProfileHash,
      input.resumeSetHash,
      input.embeddingSpaceId ?? 'none',
    ].join('|'),
  );
}
