import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, type CandidateProfileInput } from '@job-system/core';
import type { DbHandle } from '../src/client.js';
import {
  createAuditRepo,
  createCandidateRepo,
  createJobRepo,
  createResumeRepo,
  createSearchRepo,
} from '../src/repositories/index.js';
import { createTestDb, truncateAll } from '../src/testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']);
const describeDb = hasDatabase ? describe : describe.skip;

let handle: DbHandle;

const profileInput: CandidateProfileInput = {
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  headline: 'Software Engineer',
  locationCity: 'Madrid',
  locationCountry: 'Spain',
  salaryMin: 50000,
  salaryMax: 70000,
  salaryCurrency: 'EUR',
  remotePreference: ['remote', 'hybrid'],
  employmentTypes: ['full_time'],
  allowedCountries: ['Spain'],
  relocation: false,
  preferences: {},
};

beforeEach(async () => {
  handle = await createTestDb();
  await truncateAll(handle.db);
});

afterAll(async () => {
  if (handle) await handle.pool.end();
});

describeDb('candidate repository', () => {
  it('creates and updates the single profile with a stable hash', async () => {
    const repo = createCandidateRepo(handle.db);
    const created = await repo.upsertProfile(profileInput);
    expect(created.fullName).toBe('Ada Lovelace');
    expect(created.profileHash).toHaveLength(64);

    const updated = await repo.upsertProfile({ ...profileInput, headline: 'Staff Engineer' });
    expect(updated.id).toBe(created.id);
    expect(updated.headline).toBe('Staff Engineer');
    expect(updated.profileHash).not.toBe(created.profileHash);

    const profile = await repo.getProfile();
    expect(profile?.id).toBe(created.id);
  });

  it('manages experiences, educations, skills and languages', async () => {
    const repo = createCandidateRepo(handle.db);
    const profile = await repo.upsertProfile(profileInput);

    const experience = await repo.addExperience(profile.id, {
      company: 'Analytical Engines Ltd',
      title: 'Senior Engineer',
      startDate: new Date('2020-01-01'),
      endDate: new Date('2023-01-01'),
      description: 'Built things',
      skills: ['typescript'],
    });
    expect(experience.candidateId).toBe(profile.id);

    const skill = await repo.addSkill(profile.id, {
      skillName: 'TypeScript',
      level: 'expert',
      years: 6,
    });
    expect(skill.skillName).toBe('TypeScript');
    expect(skill.years).toBe(6);
    const upgraded = await repo.addSkill(profile.id, {
      skillName: '  TypeScript ',
      level: 'advanced',
      years: 7,
    });
    expect(upgraded.id).toBe(skill.id);
    expect(upgraded.level).toBe('advanced');

    const language = await repo.addLanguage(profile.id, { language: 'English', level: 'C2' });
    expect(language.level).toBe('C2');

    const education = await repo.addEducation(profile.id, {
      institution: 'University of London',
      degree: 'BSc Mathematics',
      status: 'completed',
    });
    expect(education.degree).toBe('BSc Mathematics');

    const aggregate = await Promise.all([
      repo.listExperiences(),
      repo.listEducations(),
      repo.listSkills(),
      repo.listLanguages(),
    ]);
    expect(aggregate[0]).toHaveLength(1);
    expect(aggregate[1]).toHaveLength(1);
    expect(aggregate[2]).toHaveLength(1);
    expect(aggregate[3]).toHaveLength(1);

    await repo.deleteExperience(experience.id);
    await expect(repo.deleteExperience(experience.id)).rejects.toThrow();
  });
});

describeDb('resume repository (immutability)', () => {
  it('creates immutable versions with increasing numbers and preserved hashes', async () => {
    const candidateRepo = createCandidateRepo(handle.db);
    const resumeRepo = createResumeRepo(handle.db);
    const profile = await candidateRepo.upsertProfile(profileInput);

    const resume = await resumeRepo.createResume(profile.id, {
      name: 'Engineering CV',
      category: 'software-engineering',
      language: 'en',
      isDefault: true,
    });

    const v1 = await resumeRepo.createVersion(resume.id, {
      kind: 'original',
      storageKey: 'resumes/eng/v1.txt',
      fileHash: 'a'.repeat(64),
    });
    const v2 = await resumeRepo.createVersion(resume.id, {
      kind: 'tailored',
      parentVersionId: v1.id,
      storageKey: 'resumes/eng/v2.txt',
      fileHash: 'b'.repeat(64),
    });

    expect(v1.versionNumber).toBe(1);
    expect(v2.versionNumber).toBe(2);
    expect(v2.parentVersionId).toBe(v1.id);

    const versions = await resumeRepo.listVersions(resume.id);
    expect(versions).toHaveLength(2);
    const original = versions.find((version) => version.id === v1.id)!;
    expect(original.fileHash).toBe('a'.repeat(64));
    expect(original.storageKey).toBe('resumes/eng/v1.txt');
    expect(original.parentVersionId).toBeNull();
  });

  it('rejects unknown resumes', async () => {
    const resumeRepo = createResumeRepo(handle.db);
    await expect(
      resumeRepo.createVersion('00000000-0000-7000-8000-000000000000', {
        kind: 'original',
        storageKey: 'x',
        fileHash: 'c'.repeat(64),
      }),
    ).rejects.toThrow();
  });

  it('allows multiple resumes with the same category and language', async () => {
    const candidateRepo = createCandidateRepo(handle.db);
    const resumeRepo = createResumeRepo(handle.db);
    const profile = await candidateRepo.upsertProfile(profileInput);

    const fullStack = await resumeRepo.createResume(profile.id, {
      name: 'CV Full Stack EN',
      category: 'software-engineering',
      language: 'en',
      isDefault: true,
    });
    const frontend = await resumeRepo.createResume(profile.id, {
      name: 'CV Frontend EN',
      category: 'software-engineering',
      language: 'en',
      isDefault: false,
    });
    const backend = await resumeRepo.createResume(profile.id, {
      name: 'CV Backend EN',
      category: 'software-engineering',
      language: 'en',
      isDefault: false,
    });

    expect(new Set([fullStack.id, frontend.id, backend.id]).size).toBe(3);
    const names = (await resumeRepo.listResumes()).map((row) => row.name).sort();
    expect(names).toEqual(['CV Backend EN', 'CV Frontend EN', 'CV Full Stack EN']);
  });

  it('enforces the self-referencing parent_version_id foreign key', async () => {
    const candidateRepo = createCandidateRepo(handle.db);
    const resumeRepo = createResumeRepo(handle.db);
    const profile = await candidateRepo.upsertProfile(profileInput);
    const resume = await resumeRepo.createResume(profile.id, {
      name: 'Engineering CV',
      category: 'software-engineering',
      language: 'en',
      isDefault: true,
    });

    const v1 = await resumeRepo.createVersion(resume.id, {
      kind: 'original',
      storageKey: 'resumes/v1.txt',
      fileHash: 'a'.repeat(64),
    });
    const v2 = await resumeRepo.createVersion(resume.id, {
      kind: 'tailored',
      parentVersionId: v1.id,
      storageKey: 'resumes/v2.txt',
      fileHash: 'b'.repeat(64),
    });
    expect(v2.parentVersionId).toBe(v1.id);

    await expect(
      resumeRepo.createVersion(resume.id, {
        kind: 'tailored',
        parentVersionId: '00000000-0000-7000-8000-000000000000',
        storageKey: 'resumes/v3.txt',
        fileHash: 'd'.repeat(64),
      }),
    ).rejects.toThrow();
  });
});

describeDb('search repository', () => {
  it('derives parent run status from source runs (idempotent finalizer)', async () => {
    const candidateRepo = createCandidateRepo(handle.db);
    const jobRepo = createJobRepo(handle.db);
    const searchRepo = createSearchRepo(handle.db);
    const profile = await candidateRepo.upsertProfile(profileInput);
    const sourceA = await jobRepo.upsertSource({
      key: 'mock-a',
      name: 'Mock A',
      kind: 'api',
      capabilities: {},
    });
    const sourceB = await jobRepo.upsertSource({
      key: 'mock-b',
      name: 'Mock B',
      kind: 'api',
      capabilities: {},
    });
    const config = await searchRepo.createConfig({
      candidateId: profile.id,
      name: 'Default search',
      keywords: ['react'],
      locations: [],
      remote: true,
      sources: ['mock-a', 'mock-b'],
      intervalMinutes: 1440,
      mode: 'assisted',
    });

    const run = await searchRepo.createRun(config.id, 'corr-1');
    const runA = await searchRepo.createSourceRun(run.id, sourceA.id, 'corr-1');
    const runB = await searchRepo.createSourceRun(run.id, sourceB.id, 'corr-1');

    expect((await searchRepo.finalizeRun(run.id)).finalized).toBe(false);

    await searchRepo.finishSourceRun(runA.id, {
      status: 'completed',
      jobsDiscovered: 5,
      jobsNew: 3,
      jobsDuplicated: 1,
      jobsRejected: 1,
      errors: 0,
      durationMs: 120,
    });
    await searchRepo.finishSourceRun(runB.id, {
      status: 'failed',
      jobsDiscovered: 0,
      jobsNew: 0,
      jobsDuplicated: 0,
      jobsRejected: 0,
      errors: 1,
      durationMs: 40,
      errorClass: 'SourceTransientError',
    });

    const first = await searchRepo.finalizeRun(run.id);
    expect(first.finalized).toBe(true);
    expect(first.status).toBe('partial');
    expect(first.jobsDiscovered).toBe(5);
    expect(first.jobsNew).toBe(3);

    const second = await searchRepo.finalizeRun(run.id);
    expect(second.status).toBe('partial');
    expect(second.jobsDiscovered).toBe(5);

    const sourceRuns = await searchRepo.listSourceRuns(run.id);
    expect(sourceRuns).toHaveLength(2);
    expect(sourceRuns.map((entry) => entry.sourceKey)).toEqual(['mock-a', 'mock-b']);
  });
});

describeDb('audit repository', () => {
  it('appends immutable audit records', async () => {
    const audit = createAuditRepo(handle.db);
    const entry = await audit.append({
      actor: 'user',
      action: 'profile.updated',
      entityType: 'candidate_profile',
      entityId: 'entity-1',
      after: { headline: 'Engineer' },
      correlationId: 'corr-9',
    });
    expect(entry.id).toMatch(/[0-9a-f-]{36}/);
    const listed = await audit.listForEntity('candidate_profile', 'entity-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.action).toBe('profile.updated');
  });

  it('reports conflicts explicitly when a required profile is missing', async () => {
    const repo = createCandidateRepo(handle.db);
    await expect(repo.requireProfileId()).rejects.toThrow(ConflictError);
  });
});