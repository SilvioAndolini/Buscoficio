import { describe, expect, it } from 'vitest';
import {
  computeExperienceMonths,
  employmentTypeMatch,
  experienceMatch,
  languageMatch,
  locationMatch,
  parseLanguageRequirement,
  salaryMatch,
  skillsMatch,
  type MatchCandidateProfile,
  type MatchJob,
} from '../src/index.js';

const job: MatchJob = {
  company: 'Acme Corp',
  title: 'Senior React Developer',
  description: 'Build internal tools with React and TypeScript.',
  location: 'Remote (EU)',
  remoteType: 'remote',
  employmentType: 'full_time',
  salaryMin: 65000,
  salaryMax: 85000,
  currency: 'EUR',
  experienceLevel: 'senior',
  languageRequirements: ['en'],
  requiredSkills: ['React', 'TypeScript'],
  preferredSkills: ['Node.js'],
};

const profile: MatchCandidateProfile = {
  locationCity: 'Madrid',
  locationCountry: 'Spain',
  salaryMin: 60000,
  salaryMax: 80000,
  salaryCurrency: 'EUR',
  remotePreference: ['remote'],
  employmentTypes: ['full_time'],
  allowedCountries: ['Spain'],
  relocation: false,
};

describe('skillsMatch', () => {
  it('scores required (0.7) and preferred (0.3) coverage with canonical names and aliases', () => {
    const result = skillsMatch(job, [
      { skillName: 'React', aliases: [], level: 'expert', years: 6 },
      { skillName: 'TS', aliases: ['TypeScript'], level: 'advanced', years: 5 },
    ]);
    expect(result.score).toBeCloseTo(0.7, 6);
    expect(result.matchingSkills).toEqual(['React', 'TypeScript']);
    expect(result.missingRequirements).toEqual([]);
  });

  it('reports missing required skills without inventing data', () => {
    const result = skillsMatch(job, [
      { skillName: 'React', aliases: [], level: 'advanced', years: 6 },
    ]);
    expect(result.score).toBeCloseTo(0.35, 6);
    expect(result.missingRequirements).toEqual(['Missing required skill: TypeScript']);
    expect(result.matchingSkills).toEqual(['React']);
  });

  it('is absent when the job has no skill lists', () => {
    const result = skillsMatch({ ...job, requiredSkills: [], preferredSkills: [] }, []);
    expect(result.score).toBeNull();
    expect(result.reason).toContain('no required or preferred skills');
  });
});

describe('experienceMatch', () => {
  it('merges overlapping ranges instead of double counting', () => {
    const months = computeExperienceMonths([
      {
        company: 'A',
        title: 'Dev',
        startDate: new Date('2019-01-01T00:00:00Z'),
        endDate: new Date('2021-01-01T00:00:00Z'),
        skills: [],
      },
      {
        company: 'B',
        title: 'Dev',
        startDate: new Date('2020-06-01T00:00:00Z'),
        endDate: new Date('2022-06-01T00:00:00Z'),
        skills: [],
      },
    ]);
    expect(months / 12).toBeCloseTo(3.41, 1);
  });

  it('uses the latest date present for open-ended roles (never the wall clock)', () => {
    const months = computeExperienceMonths([
      {
        company: 'A',
        title: 'Dev',
        startDate: new Date('2022-01-01T00:00:00Z'),
        endDate: null,
        skills: [],
      },
      {
        company: 'B',
        title: 'Dev',
        startDate: new Date('2021-01-01T00:00:00Z'),
        endDate: new Date('2023-01-01T00:00:00Z'),
        skills: [],
      },
    ]);
    expect(months / 12).toBeCloseTo(2, 1);
  });

  it('scores years against the senior minimum and is absent without level or experience', () => {
    const experiences = [
      {
        company: 'A',
        title: 'Dev',
        startDate: new Date('2019-01-01T00:00:00Z'),
        endDate: new Date('2023-01-01T00:00:00Z'),
        skills: [],
      },
    ];
    const result = experienceMatch(job, experiences, []);
    expect(result.score).toBeCloseTo(0.8, 2);
    expect(experienceMatch({ ...job, experienceLevel: null }, experiences, []).score).toBeNull();
    expect(experienceMatch(job, [], []).score).toBeNull();
  });

  it('only uses candidate_skill.years when present, never infers skill years from jobs', () => {
    const result = experienceMatch(
      job,
      [
        {
          company: 'A',
          title: 'Dev',
          startDate: new Date('2019-01-01T00:00:00Z'),
          endDate: new Date('2023-01-01T00:00:00Z'),
          skills: ['React'],
        },
      ],
      [{ skillName: 'React', aliases: [], level: 'advanced', years: 4 }],
    );
    expect(result.details.some((detail) => detail.includes("candidate_skill 'React': 4 years"))).toBe(true);
  });
});

describe('locationMatch', () => {
  it('remote job + remote preference scores 1', () => {
    expect(locationMatch(job, profile).score).toBe(1);
  });

  it('remote job with no candidate preference is absent (no automatic penalty)', () => {
    const result = locationMatch(job, { ...profile, remotePreference: [] });
    expect(result.score).toBeNull();
  });

  it('onsite in the same country scores 1 and relocation 0.6', () => {
    const onsite: MatchJob = { ...job, remoteType: 'onsite', location: 'Madrid, Spain' };
    expect(locationMatch(onsite, profile).score).toBe(1);
    const abroad: MatchJob = { ...job, remoteType: 'onsite', location: 'Berlin, Germany' };
    expect(locationMatch(abroad, { ...profile, relocation: true }).score).toBe(0.6);
  });

  it('onsite incompatible reports a missing requirement', () => {
    const onsite: MatchJob = { ...job, remoteType: 'onsite', location: 'Berlin, Germany' };
    const result = locationMatch(onsite, profile);
    expect(result.score).toBeCloseTo(0.1, 6);
    expect(result.missingRequirements[0]).toContain('Location');
  });
});

describe('salaryMatch', () => {
  it('scores range overlap', () => {
    const result = salaryMatch(job, profile);
    expect(result.score).toBeGreaterThan(0.5);
    expect(result.details.join(' ')).toContain('overlap');
  });

  it('job below candidate minimum scores 0 and reports it', () => {
    const lowJob: MatchJob = { ...job, salaryMin: 30000, salaryMax: 45000 };
    const result = salaryMatch(lowJob, profile);
    expect(result.score).toBe(0);
    expect(result.missingRequirements[0]).toContain('Salary');
  });

  it('absent when data is missing or currencies differ', () => {
    expect(salaryMatch({ ...job, salaryMin: null, salaryMax: null }, profile).score).toBeNull();
    expect(salaryMatch(job, { ...profile, salaryMin: null, salaryMax: null }).score).toBeNull();
    expect(salaryMatch({ ...job, currency: 'USD' }, profile).score).toBeNull();
  });
});

describe('languageMatch', () => {
  it('parses free-text requirements deterministically', () => {
    expect(parseLanguageRequirement('English B2')).toEqual({
      language: 'english',
      level: 'B2',
      source: 'English B2',
    });
    expect(parseLanguageRequirement('en')).toEqual({ language: 'english', level: null, source: 'en' });
  });

  it('meets requirements at or above the level', () => {
    const result = languageMatch(job, [
      { language: 'en', level: 'C1' },
      { language: 'Spanish', level: 'native' },
    ]);
    expect(result.score).toBe(1);
    expect(result.hardViolations).toEqual([]);
  });

  it('reports a hard violation when the profile level is insufficient', () => {
    const result = languageMatch({ ...job, languageRequirements: ['English C1'] }, [
      { language: 'English', level: 'B2' },
    ]);
    expect(result.score).toBe(0);
    expect(result.hardViolations[0]).toContain('English C1 required; profile indicates B2');
  });

  it('reports a hard violation when the language is missing', () => {
    const result = languageMatch({ ...job, languageRequirements: ['German B1'] }, [
      { language: 'English', level: 'C1' },
    ]);
    expect(result.score).toBe(0);
    expect(result.hardViolations[0]).toContain('profile has no german');
  });

  it('is absent when the job has no language requirements', () => {
    expect(languageMatch({ ...job, languageRequirements: [] }, []).score).toBeNull();
  });
});

describe('employmentTypeMatch', () => {
  it('matches preferences', () => {
    expect(employmentTypeMatch(job, profile).score).toBe(1);
  });

  it('scores 0 on mismatch and is absent without data', () => {
    expect(employmentTypeMatch(job, { ...profile, employmentTypes: ['contract'] }).score).toBe(0);
    expect(employmentTypeMatch({ ...job, employmentType: null }, profile).score).toBeNull();
    expect(employmentTypeMatch(job, { ...profile, employmentTypes: [] }).score).toBeNull();
  });
});
