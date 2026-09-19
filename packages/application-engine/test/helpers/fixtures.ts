import type {
  DocumentsPort,
  MatchCreationContext,
  ProfileFactsSource,
  ResumeVersionRecord,
  StoragePort,
} from '@job-system/core';
import { sha256Hex } from '@job-system/core';

export const CANDIDATE_ID = '00000000-0000-4000-8000-000000000001';
export const JOB_ID = '00000000-0000-4000-8000-000000000002';
export const MATCH_ID = '00000000-0000-4000-8000-000000000003';
export const RESUME_ID = '00000000-0000-4000-8000-000000000004';
export const RESUME_VERSION_ID = '00000000-0000-4000-8000-000000000005';

export function buildCandidateSource(): ProfileFactsSource {
  return {
    profile: {
      id: CANDIDATE_ID,
      fullName: 'Ada Lovelace',
      headline: 'Software Engineer',
      salaryMin: 60_000,
      salaryMax: 80_000,
      salaryCurrency: 'EUR',
    },
    skills: [
      { id: '10000000-0000-4000-8000-000000000001', name: 'TypeScript', aliases: [], level: 'expert', years: 6 },
      { id: '10000000-0000-4000-8000-000000000002', name: 'React', aliases: [], level: 'advanced', years: 5 },
    ],
    experiences: [
      {
        id: '20000000-0000-4000-8000-000000000001',
        company: 'Analytical Engines',
        title: 'Engineer',
        startDate: new Date('2020-01-01T00:00:00Z'),
        endDate: new Date('2024-01-01T00:00:00Z'),
        skills: ['TypeScript'],
      },
    ],
    education: [
      {
        id: '30000000-0000-4000-8000-000000000001',
        institution: 'University of London',
        degree: 'BSc Computer Science',
        field: 'Computer Science',
        startDate: new Date('2015-09-01T00:00:00Z'),
        endDate: new Date('2018-06-01T00:00:00Z'),
        status: 'completed',
      },
    ],
    languages: [
      { id: '40000000-0000-4000-8000-000000000001', language: 'English', level: 'C1' },
    ],
  };
}

export function buildResumeVersion(): ResumeVersionRecord {
  return {
    id: RESUME_VERSION_ID,
    resumeId: RESUME_ID,
    candidateId: CANDIDATE_ID,
    versionNumber: 1,
    kind: 'original',
    storageKey: `resumes/${RESUME_ID}/v1.txt`,
    fileHash: 'f'.repeat(64),
    highlights: { skills: ['TypeScript'] },
  };
}

export function buildMatchContext(overrides: Partial<MatchCreationContext> = {}): MatchCreationContext {
  return {
    matchId: MATCH_ID,
    jobId: JOB_ID,
    candidateId: CANDIDATE_ID,
    overallScore: 0.82,
    isCurrent: true,
    recommendedResumeId: RESUME_ID,
    recommendedResumeVersionId: RESUME_VERSION_ID,
    recommendedResumeLatestVersionId: RESUME_VERSION_ID,
    job: {
      id: JOB_ID,
      title: 'Senior TypeScript Engineer',
      company: 'Acme Corp',
      description: 'Build tools with TypeScript.',
      location: 'Remote (EU)',
      remoteType: 'remote',
      employmentType: 'full_time',
      requiredSkills: ['TypeScript'],
      preferredSkills: ['React'],
      languageRequirements: ['English B2'],
      status: 'active',
      applicationTargetId: null,
      discoverySourceId: null,
      applicationTarget: null,
    },
    candidate: buildCandidateSource(),
    ...overrides,
  };
}

export function buildFakeDocuments(overrides: Partial<DocumentsPort> = {}): DocumentsPort {
  const base: DocumentsPort = {
    provider: 'mock',
    model: 'mock-text-v1',
    validateClaims: (claims) => ({
      claims: claims.map((claim) => ({ ...claim, verified: 'verified' as const })),
      verification: { status: 'verified', failures: [] },
    }),
    buildProfileFactsView: (source) => ({
      candidateId: source.profile.id,
      displayName: source.profile.fullName,
      headline: source.profile.headline,
      skills: source.skills,
      experiences: source.experiences,
      education: source.education,
      languages: source.languages,
      salary: null,
    }),
    hashQuestion: (questionText) => sha256Hex(questionText.trim().toLowerCase()),
    prepareResumeVariant: (input) => ({
      kind: 'resume_variant',
      text: '# Ada Lovelace\n',
      contentHash: 'a'.repeat(64),
      claims: [],
      verification: { status: 'verified', failures: [] },
      generatedBy: {
        provider: 'deterministic',
        model: 'template-v1',
        promptVersion: 'resume-variant/v1',
        inputHash: input.inputHash,
      },
      sourceResumeVersionId: input.sourceResumeVersion.id,
      highlights: {},
    }),
    prepareCoverLetter: async (input) => ({
      kind: 'cover_letter',
      text: 'Dear hiring team,\n',
      contentHash: 'b'.repeat(64),
      claims: [],
      verification: { status: 'verified', failures: [] },
      generatedBy: {
        provider: 'mock',
        model: 'mock-text-v1',
        promptVersion: input.buildPrompt({
          job: input.job,
          facts: input.facts,
          attempt: 0,
          rejectedClaims: [],
        }).promptVersion,
        inputHash: input.inputHash,
      },
    }),
    resolveAnswer: () => ({ action: 'requires_human', reason: 'no approved answer' }),
  };
  return { ...base, ...overrides };
}

export function buildFakeStorage(): StoragePort & { artifacts: Map<string, Uint8Array> } {
  const artifacts = new Map<string, Uint8Array>();
  return {
    artifacts,
    async put(key, bytes) {
      artifacts.set(key, bytes);
      return {
        key,
        size: bytes.byteLength,
        contentType: 'text/markdown',
        hash: sha256Hex(Buffer.from(bytes).toString('utf8')),
      };
    },
    async get(key) {
      const value = artifacts.get(key);
      if (!value) throw new Error(`artifact not found: ${key}`);
      return value;
    },
    async exists(key) {
      return artifacts.has(key);
    },
    async delete(key) {
      artifacts.delete(key);
    },
  };
}
