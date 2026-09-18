import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATCH_POLICY,
  MatchingWeightsSchema,
  MATCHING_WEIGHTS_V1,
  runMatchEngine,
  ScoreBreakdownSchema,
  SIGNAL_NAMES,
  type MatchEngineInput,
  type MatchJob,
  type MatchPolicy,
} from '../src/index.js';

const job: MatchJob = {
  company: 'Acme Corp',
  title: 'Senior React Developer',
  description: 'Build internal tools with React and TypeScript. Own the design system.',
  location: 'Remote (EU)',
  remoteType: 'remote',
  employmentType: 'full_time',
  salaryMin: 65000,
  salaryMax: 85000,
  currency: 'EUR',
  experienceLevel: 'senior',
  languageRequirements: ['English C1'],
  requiredSkills: ['React', 'TypeScript'],
  preferredSkills: ['Node.js'],
};

const input: MatchEngineInput = {
  job,
  profile: {
    locationCity: 'Madrid',
    locationCountry: 'Spain',
    salaryMin: 60000,
    salaryMax: 80000,
    salaryCurrency: 'EUR',
    remotePreference: ['remote'],
    employmentTypes: ['full_time'],
    allowedCountries: ['Spain'],
    relocation: false,
  },
  skills: [
    { skillName: 'React', aliases: [], level: 'expert', years: 6 },
    { skillName: 'TypeScript', aliases: [], level: 'advanced', years: 5 },
    { skillName: 'Node.js', aliases: [], level: 'advanced', years: 4 },
  ],
  languages: [
    { language: 'English', level: 'C1' },
    { language: 'Spanish', level: 'native' },
  ],
  experiences: [
    {
      company: 'Acme',
      title: 'Senior Developer',
      startDate: new Date('2018-01-01T00:00:00Z'),
      endDate: new Date('2024-01-01T00:00:00Z'),
      skills: ['React'],
    },
  ],
  resumes: [
    {
      id: '11111111-1111-7111-8111-111111111111',
      category: 'software-engineering',
      language: 'en',
      latestVersion: {
        id: 'aaaaaaaa-1111-7111-8111-111111111111',
        versionNumber: 1,
        fileHash: 'f'.repeat(64),
        kind: 'original',
        highlights: { skills: ['React', 'TypeScript'] },
      },
    },
  ],
  resumeSemantics: [
    {
      resumeId: '11111111-1111-7111-8111-111111111111',
      versionId: 'aaaaaaaa-1111-7111-8111-111111111111',
      similarity: 0.8,
    },
  ],
  asOfDate: null,
};

describe('weights', () => {
  it('are centralized, schema-validated and versioned', () => {
    expect(MatchingWeightsSchema.safeParse(MATCHING_WEIGHTS_V1).success).toBe(true);
    expect(MATCHING_WEIGHTS_V1).toEqual(MatchingWeightsSchema.parse(MATCHING_WEIGHTS_V1));
  });
});

describe('runMatchEngine', () => {
  it('produces a full Zod-valid breakdown with every signal explicit', () => {
    const result = runMatchEngine(input);
    expect(ScoreBreakdownSchema.safeParse(result.breakdown).success).toBe(true);
    expect(Object.keys(result.breakdown.signals).sort()).toEqual([...SIGNAL_NAMES].sort());
    for (const name of SIGNAL_NAMES) {
      const signal = result.breakdown.signals[name];
      expect(signal).toBeDefined();
      expect(signal.weight).toBeGreaterThanOrEqual(0);
      if (!signal.present) expect(signal.score).toBeNull();
    }
  });

  it('is deterministic and never depends on an LLM', () => {
    const first = runMatchEngine(input);
    const second = runMatchEngine(input);
    expect(second.overallScore).toBe(first.overallScore);
    expect(second.reasons).toEqual(first.reasons);
    expect(second.missingRequirements).toEqual(first.missingRequirements);
    expect(second.breakdown).toEqual(first.breakdown);
  });

  it('excludes absent signals from the denominator instead of scoring them 0', () => {
    const withoutSalary = runMatchEngine({
      ...input,
      job: { ...job, salaryMin: null, salaryMax: null },
    });
    const signal = withoutSalary.breakdown.signals.salaryMatch;
    expect(signal.present).toBe(false);
    expect(signal.weightedContribution).toBe(0);
    expect(withoutSalary.breakdown.presentWeightSum).toBeCloseTo(
      Object.values(withoutSalary.breakdown.signals)
        .filter((entry) => entry.present)
        .reduce((sum, entry) => sum + entry.weight, 0),
      6,
    );

    const manual = Object.values(withoutSalary.breakdown.signals)
      .filter((entry) => entry.present)
      .reduce((sum, entry) => sum + entry.weightedContribution, 0);
    expect(withoutSalary.breakdown.rawScore).toBeCloseTo(
      manual / withoutSalary.breakdown.presentWeightSum,
      4,
    );
  });

  it('caps the score when a hard requirement fails and explains it', () => {
    const policy: MatchPolicy = DEFAULT_MATCH_POLICY;
    const result = runMatchEngine({
      ...input,
      languages: [{ language: 'English', level: 'B2' }],
    });
    expect(result.breakdown.capApplied).toBe(true);
    expect(result.overallScore).toBeLessThanOrEqual(policy.hardRequirementCap);
    expect(result.missingRequirements.some((entry) => entry.includes('English C1 required'))).toBe(true);
    expect(result.reasons.some((entry) => entry.includes('capped'))).toBe(true);
  });

  it('does not cap for missing required skills under v1 rules (reported only)', () => {
    const result = runMatchEngine({
      ...input,
      skills: [{ skillName: 'React', aliases: [], level: 'expert', years: 6 }],
    });
    expect(result.missingRequirements).toContain('Missing required skill: TypeScript');
    expect(result.breakdown.capApplied).toBe(false);
  });

  it('selects the recommended resume deterministically with tie-breakers', () => {
    const secondResume = {
      id: '22222222-2222-7222-8222-222222222222',
      category: 'software-engineering',
      language: 'en',
      latestVersion: {
        id: 'bbbbbbbb-2222-7222-8222-222222222222',
        versionNumber: 4,
        fileHash: 'e'.repeat(64),
        kind: 'original',
        highlights: { skills: ['React', 'TypeScript', 'Node.js'] },
      },
    };
    const result = runMatchEngine({
      ...input,
      resumes: [...input.resumes, secondResume],
      resumeSemantics: [
        ...input.resumeSemantics,
        {
          resumeId: secondResume.id,
          versionId: secondResume.latestVersion.id,
          similarity: 0.5,
        },
      ],
    });
    // Second resume has better skill coverage despite lower semantic similarity.
    expect(result.recommendedResumeId).toBe(secondResume.id);
    expect(result.breakdown.resumeSelection.recommendedResumeVersionId).toBe(
      secondResume.latestVersion.id,
    );
    expect(result.breakdown.resumeSelection.reasons.length).toBeGreaterThan(0);
  });

  it('baselines careerRelevance on the deterministic category classifier', () => {
    const matching = runMatchEngine(input);
    expect(matching.breakdown.signals.careerRelevance.present).toBe(true);
    expect(matching.breakdown.signals.careerRelevance.score).toBe(1);

    const noMatch = runMatchEngine({
      ...input,
      resumes: [{ ...input.resumes[0]!, category: 'audiovisual' }],
    });
    expect(noMatch.breakdown.signals.careerRelevance.score).toBeCloseTo(0.35, 6);

    const unclassified = runMatchEngine({
      ...input,
      job: { ...job, title: 'Zookeeper', description: 'Care for animals.' },
    });
    expect(unclassified.breakdown.signals.careerRelevance.present).toBe(false);
  });

  it('is absent semantically without resume semantics and still scores the rest', () => {
    const result = runMatchEngine({ ...input, resumeSemantics: [] });
    expect(result.breakdown.signals.semanticSimilarity.present).toBe(false);
    expect(result.overallScore).toBeGreaterThan(0);
  });

  it('uses the provided asOfDate for open-ended experience (never the wall clock)', () => {
    const openEnded = {
      ...input,
      experiences: [
        {
          company: 'Acme',
          title: 'Senior Developer',
          startDate: new Date('2022-01-01T00:00:00Z'),
          endDate: null,
          skills: ['React'],
        },
      ],
    };
    const earlier = runMatchEngine({ ...openEnded, asOfDate: new Date('2024-01-01T00:00:00Z') });
    const later = runMatchEngine({ ...openEnded, asOfDate: new Date('2026-09-18T00:00:00Z') });
    expect(earlier.breakdown.signals.experienceMatch.present).toBe(true);
    expect(Number(earlier.breakdown.signals.experienceMatch.score)).toBeLessThan(
      Number(later.breakdown.signals.experienceMatch.score),
    );
    expect(later.breakdown.signals.experienceMatch.details?.join(' ')).toContain('as of 2026-09-18');
  });
});
