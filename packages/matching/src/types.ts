import type { EmploymentType, ExperienceLevel, RemoteType } from '@job-system/core';

/** Normalized Job view consumed by the deterministic engine (no I/O). */
export interface MatchJob {
  company: string;
  title: string;
  description: string;
  location: string | null;
  remoteType: RemoteType | null;
  employmentType: EmploymentType | null;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  experienceLevel: ExperienceLevel | null;
  languageRequirements: string[];
  requiredSkills: string[];
  preferredSkills: string[];
}

export interface MatchCandidateSkill {
  skillName: string;
  aliases: string[];
  level: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  years: number | null;
}

export type MatchLanguageLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2' | 'native';

export interface MatchCandidateLanguage {
  language: string;
  level: MatchLanguageLevel;
}

export interface MatchCandidateExperience {
  company: string;
  title: string;
  startDate: Date;
  endDate: Date | null;
  skills: string[];
}

export interface MatchCandidateProfile {
  locationCity: string | null;
  locationCountry: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  remotePreference: string[];
  employmentTypes: string[];
  allowedCountries: string[];
  relocation: boolean;
}

export interface MatchResumeVersion {
  id: string;
  versionNumber: number;
  fileHash: string;
  kind: string;
  highlights: Record<string, unknown>;
}

export interface MatchResume {
  id: string;
  category: string;
  language: string;
  latestVersion: MatchResumeVersion | null;
}

/** Semantic similarity per resume, resolved by the service (cache-aware). */
export interface MatchResumeSemantic {
  resumeId: string;
  versionId: string;
  /** Normalized cosine similarity in [0,1]. */
  similarity: number;
}

export interface MatchEngineInput {
  job: MatchJob;
  profile: MatchCandidateProfile;
  skills: MatchCandidateSkill[];
  languages: MatchCandidateLanguage[];
  experiences: MatchCandidateExperience[];
  resumes: MatchResume[];
  resumeSemantics: MatchResumeSemantic[];
  /**
   * Explicit temporal anchor for open-ended experiences (from the injected
   * Clock). Null when every experience is closed: the score is then
   * time-independent and the identity does not include a date.
   */
  asOfDate: Date | null;
}

export type SignalName =
  | 'skillsMatch'
  | 'experienceMatch'
  | 'locationMatch'
  | 'salaryMatch'
  | 'languageMatch'
  | 'employmentTypeMatch'
  | 'semanticSimilarity'
  | 'careerRelevance';

export interface SignalResult {
  /** null means absent: the signal is excluded from the weighted average. */
  score: number | null;
  details: string[];
  /** Required when score is null. */
  reason: string | null;
  missingRequirements: string[];
  matchingSkills: string[];
  hardViolations: string[];
}
