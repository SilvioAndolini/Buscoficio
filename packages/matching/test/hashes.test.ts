import { describe, expect, it } from 'vitest';
import {
  computeCandidateProfileHash,
  computeIdentityHash,
  computeResumeSetHash,
  type MatchCandidateExperience,
  type MatchCandidateLanguage,
  type MatchCandidateProfile,
  type MatchCandidateSkill,
  type MatchResume,
} from '../src/index.js';

const profile: MatchCandidateProfile = {
  locationCity: 'Madrid',
  locationCountry: 'Spain',
  salaryMin: 60000,
  salaryMax: 80000,
  salaryCurrency: 'EUR',
  remotePreference: ['remote', 'hybrid'],
  employmentTypes: ['full_time'],
  allowedCountries: ['Spain'],
  relocation: false,
};

const skills: MatchCandidateSkill[] = [
  { skillName: 'TypeScript', aliases: ['ts'], level: 'advanced', years: 5 },
  { skillName: 'React', aliases: [], level: 'advanced', years: 6 },
];

const languages: MatchCandidateLanguage[] = [
  { language: 'Spanish', level: 'native' },
  { language: 'English', level: 'C1' },
];

const experiences: MatchCandidateExperience[] = [
  {
    company: 'Acme',
    title: 'Senior Developer',
    startDate: new Date('2021-01-01T00:00:00Z'),
    endDate: new Date('2023-01-01T00:00:00Z'),
    skills: ['React'],
  },
  {
    company: 'Globex',
    title: 'Developer',
    startDate: new Date('2019-01-01T00:00:00Z'),
    endDate: new Date('2021-06-01T00:00:00Z'),
    skills: [],
  },
];

const resumes: MatchResume[] = [
  {
    id: '11111111-1111-7111-8111-111111111111',
    category: 'software-engineering',
    language: 'en',
    latestVersion: {
      id: 'aaaaaaaa-1111-7111-8111-111111111111',
      versionNumber: 2,
      fileHash: 'f'.repeat(64),
      kind: 'original',
      highlights: {},
    },
  },
];

describe('canonical matching hashes', () => {
  it('candidateProfileHash is stable regardless of array order', () => {
    const reordered = {
      profile: { ...profile, remotePreference: ['hybrid', 'remote'], allowedCountries: ['spain'] },
      skills: [...skills].reverse(),
      languages: [...languages].reverse(),
      experiences: [...experiences].reverse(),
    };
    expect(computeCandidateProfileHash({ profile, skills, languages, experiences })).toBe(
      computeCandidateProfileHash(reordered),
    );
  });

  it('candidateProfileHash changes when a matching-relevant field changes', () => {
    const base = computeCandidateProfileHash({ profile, skills, languages, experiences });
    const changedSkill = computeCandidateProfileHash({
      profile,
      skills: [{ ...skills[0]!, years: 9 }, skills[1]!],
      languages,
      experiences,
    });
    const changedPreference = computeCandidateProfileHash({
      profile: { ...profile, relocation: true },
      skills,
      languages,
      experiences,
    });
    expect(changedSkill).not.toBe(base);
    expect(changedPreference).not.toBe(base);
  });

  it('skill aliases participate in candidateProfileHash (normalized, order-independent)', () => {
    const base = computeCandidateProfileHash({ profile, skills, languages, experiences });
    // Same aliases, different order and casing/whitespace: same hash.
    const reorderedAliases = computeCandidateProfileHash({
      profile,
      skills: [
        { ...skills[0]!, aliases: ['  TS ', 'typescript-lang'] },
        { ...skills[1]!, aliases: ['typescript-lang', 'TS'] },
      ].sort((a, b) => (a.skillName < b.skillName ? -1 : 1)),
      languages,
      experiences,
    });
    expect(reorderedAliases).not.toBe(base);

    const aliasesA = computeCandidateProfileHash({
      profile,
      skills: [{ ...skills[0]!, aliases: ['TS', 'typescript-lang'] }, skills[1]!],
      languages,
      experiences,
    });
    const aliasesB = computeCandidateProfileHash({
      profile,
      skills: [{ ...skills[0]!, aliases: ['typescript-lang', 'TS'] }, skills[1]!],
      languages,
      experiences,
    });
    expect(aliasesA).toBe(aliasesB);
    expect(aliasesA).not.toBe(base);
  });

  it('resumeSetHash covers canonicalized highlights (skill coverage + embedding text)', () => {
    const base = computeResumeSetHash(resumes);
    const withSkills = computeResumeSetHash([
      {
        ...resumes[0]!,
        latestVersion: {
          ...resumes[0]!.latestVersion!,
          highlights: { skills: ['React', 'TypeScript'] },
        },
      },
    ]);
    expect(withSkills).not.toBe(base);
    // Key order inside highlights never changes the hash.
    const reordered = computeResumeSetHash([
      {
        ...resumes[0]!,
        latestVersion: {
          ...resumes[0]!.latestVersion!,
          highlights: { summary: 'Frontend', skills: ['TypeScript', 'React'] },
        },
      },
    ]);
    const sameKeysOtherOrder = computeResumeSetHash([
      {
        ...resumes[0]!,
        latestVersion: {
          ...resumes[0]!.latestVersion!,
          highlights: { skills: ['TypeScript', 'React'], summary: 'Frontend' },
        },
      },
    ]);
    expect(reordered).toBe(sameKeysOtherOrder);
  });

  it('resumeSetHash is stable regardless of resume order and changes with versions', () => {
    const second: MatchResume = {
      id: '22222222-2222-7222-8222-222222222222',
      category: 'design',
      language: 'es',
      latestVersion: null,
    };
    const base = computeResumeSetHash([...resumes, second]);
    expect(computeResumeSetHash([second, ...resumes])).toBe(base);

    const newVersion: MatchResume = {
      ...resumes[0]!,
      latestVersion: {
        id: 'bbbbbbbb-1111-7111-8111-111111111111',
        versionNumber: 3,
        fileHash: 'a'.repeat(64),
        kind: 'tailored',
        highlights: {},
      },
    };
    expect(computeResumeSetHash([newVersion, second])).not.toBe(base);
  });

  it('identityHash covers engine, weights, hashes, embedding space and as-of date', () => {
    const baseInput = {
      engineVersion: 'matching-v2',
      weightsVersion: 'v1',
      jobContentHash: 'a'.repeat(64),
      candidateProfileHash: 'b'.repeat(64),
      resumeSetHash: 'c'.repeat(64),
      embeddingSpaceId: '33333333-3333-7333-8333-333333333333',
      matchingAsOfDate: null,
    };
    const base = computeIdentityHash(baseInput);
    expect(base).toHaveLength(64);
    expect(computeIdentityHash({ ...baseInput, engineVersion: 'matching-v3' })).not.toBe(base);
    expect(computeIdentityHash({ ...baseInput, weightsVersion: 'v2' })).not.toBe(base);
    expect(computeIdentityHash({ ...baseInput, jobContentHash: 'd'.repeat(64) })).not.toBe(base);
    expect(computeIdentityHash({ ...baseInput, candidateProfileHash: 'e'.repeat(64) })).not.toBe(base);
    expect(computeIdentityHash({ ...baseInput, resumeSetHash: 'f'.repeat(64) })).not.toBe(base);
    expect(computeIdentityHash({ ...baseInput, embeddingSpaceId: null })).not.toBe(base);
    expect(computeIdentityHash({ ...baseInput, matchingAsOfDate: '2026-09-18' })).not.toBe(base);
    expect(computeIdentityHash({ ...baseInput, matchingAsOfDate: '2026-09-19' })).not.toBe(
      computeIdentityHash({ ...baseInput, matchingAsOfDate: '2026-09-18' }),
    );
    expect(computeIdentityHash({ ...baseInput, embeddingSpaceId: null })).toBe(
      computeIdentityHash({ ...baseInput, embeddingSpaceId: null }),
    );
  });
});
