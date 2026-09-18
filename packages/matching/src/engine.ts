import { normalizeForDedup } from '@job-system/core';
import { classifyJobCategory, careerRelevanceFromCategory, type JobCategoryClassification } from './category.js';
import { ScoreBreakdownSchema, SIGNAL_NAMES, type ScoreBreakdown } from './schemas.js';
import {
  employmentTypeMatch,
  experienceMatch,
  languageMatch,
  locationMatch,
  salaryMatch,
  skillsMatch,
} from './signals.js';
import { DEFAULT_MATCH_POLICY, type MatchPolicy } from './weights.js';
import type { MatchEngineInput, MatchResume, MatchResumeVersion, SignalResult } from './types.js';

export interface EngineResult {
  overallScore: number;
  breakdown: ScoreBreakdown;
  reasons: string[];
  missingRequirements: string[];
  matchingSkills: string[];
  recommendedResumeId: string | null;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

const SIGNAL_LABELS: Record<(typeof SIGNAL_NAMES)[number], string> = {
  skillsMatch: 'Skills',
  experienceMatch: 'Experience',
  locationMatch: 'Location',
  salaryMatch: 'Salary',
  languageMatch: 'Languages',
  employmentTypeMatch: 'Employment type',
  semanticSimilarity: 'Semantic',
  careerRelevance: 'Career relevance',
};

function highlightSkills(version: MatchResumeVersion): string[] {
  const value = version.highlights['skills'];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

interface ResumeSelection {
  resume: MatchResume;
  version: MatchResumeVersion;
  similarity: number | null;
  reasons: string[];
}

/**
 * Deterministic resume selection (doc 03 §7: the AI may justify it, never
 * decide it). Weighted score + explicit tie-breakers; only resumes with an
 * immutable version participate.
 */
function selectRecommendedResume(
  input: MatchEngineInput,
  classification: JobCategoryClassification | null,
): ResumeSelection | null {
  const candidates = input.resumes.filter(
    (resume): resume is MatchResume & { latestVersion: MatchResumeVersion } =>
      resume.latestVersion !== null,
  );
  if (candidates.length === 0) return null;

  const semanticByResume = new Map(input.resumeSemantics.map((entry) => [entry.resumeId, entry]));
  const jobSkills = [
    ...new Set(
      [...input.job.requiredSkills, ...input.job.preferredSkills].map((skill) => normalizeForDedup(skill)),
    ),
  ];
  const fallbackSkills = input.skills.map((skill) => normalizeForDedup(skill.skillName));

  const evaluated = candidates.map((resume) => {
    const categoryMatch = classification !== null && resume.category === classification.category ? 1 : 0;
    const resumeSkills = highlightSkills(resume.latestVersion);
    const skillPool = new Set((resumeSkills.length > 0 ? resumeSkills : fallbackSkills).map(normalizeForDedup));
    const skillCoverage =
      jobSkills.length === 0
        ? 1
        : jobSkills.filter((skill) => skillPool.has(skill)).length / jobSkills.length;
    const semantic = semanticByResume.get(resume.id)?.similarity ?? null;
    const score = 0.5 * categoryMatch + 0.3 * skillCoverage + 0.2 * (semantic ?? 0);
    return { resume, categoryMatch, skillCoverage, semantic, score };
  });

  evaluated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.resume.latestVersion.versionNumber !== a.resume.latestVersion.versionNumber) {
      return b.resume.latestVersion.versionNumber - a.resume.latestVersion.versionNumber;
    }
    return a.resume.id < b.resume.id ? -1 : a.resume.id > b.resume.id ? 1 : 0;
  });

  const winner = evaluated[0]!;
  const reasons = [
    `selected resume ${winner.resume.id} (category '${winner.resume.category}', v${winner.resume.latestVersion.versionNumber})`,
    classification === null
      ? 'offer category not classified; selection based on skills/semantic/version'
      : winner.categoryMatch === 1
        ? `category matches offer classification '${classification.category}'`
        : `no resume category matches offer classification '${classification.category}'`,
    `skill coverage ${Math.round(winner.skillCoverage * 100)}%`,
    winner.semantic === null
      ? 'no semantic signal for resume selection'
      : `semantic similarity ${winner.semantic.toFixed(4)}`,
  ];
  return {
    resume: winner.resume,
    version: winner.resume.latestVersion,
    similarity: winner.semantic,
    reasons,
  };
}

/**
 * Pure deterministic engine (architecture doc 03 §7).
 * `overallScore = Σ(wᵢ·sᵢ)/Σ(wᵢ present)`; absent signals never enter the
 * denominator. Hard requirement violations add `missingRequirements` and cap
 * the score at the configured limit.
 */
export function runMatchEngine(
  input: MatchEngineInput,
  policy: MatchPolicy = DEFAULT_MATCH_POLICY,
): EngineResult {
  const classification = classifyJobCategory(input.job);
  const career = careerRelevanceFromCategory(
    classification,
    input.resumes.map((resume) => ({ id: resume.id, category: resume.category })),
  );

  const results: Record<(typeof SIGNAL_NAMES)[number], SignalResult> = {
    skillsMatch: skillsMatch(input.job, input.skills),
    experienceMatch: experienceMatch(input.job, input.experiences, input.skills),
    locationMatch: locationMatch(input.job, input.profile),
    salaryMatch: salaryMatch(input.job, input.profile),
    languageMatch: languageMatch(input.job, input.languages),
    employmentTypeMatch: employmentTypeMatch(input.job, input.profile),
    semanticSimilarity: { score: null, details: [], reason: null, missingRequirements: [], matchingSkills: [], hardViolations: [] },
    careerRelevance: {
      score: career.score,
      details: career.details,
      reason: career.reason,
      missingRequirements: [],
      matchingSkills: [],
      hardViolations: [],
    },
  };

  const selection = selectRecommendedResume(input, classification);
  if (selection === null) {
    results.semanticSimilarity = {
      score: null,
      details: [],
      reason: 'candidate has no resume versions to embed',
      missingRequirements: [],
      matchingSkills: [],
      hardViolations: [],
    };
  } else if (selection.similarity === null) {
    results.semanticSimilarity = {
      score: null,
      details: [],
      reason: 'no embeddings available for the active space',
      missingRequirements: [],
      matchingSkills: [],
      hardViolations: [],
    };
  } else {
    results.semanticSimilarity = {
      score: selection.similarity,
      details: [`normalized cosine (c+1)/2 vs resume ${selection.resume.id}`],
      reason: null,
      missingRequirements: [],
      matchingSkills: [],
      hardViolations: [],
    };
  }

  const signals = Object.fromEntries(
    SIGNAL_NAMES.map((name) => {
      const result = results[name];
      const weight = policy.weights[name];
      if (result.score === null) {
        return [
          name,
          {
            present: false as const,
            score: null,
            weight,
            weightedContribution: 0 as const,
            reason: result.reason ?? 'absent',
            details: result.details,
          },
        ];
      }
      return [
        name,
        {
          present: true as const,
          score: result.score,
          weight,
          weightedContribution: round6(weight * result.score),
          details: result.details,
        },
      ];
    }),
  ) as ScoreBreakdown['signals'];

  let presentWeightSum = 0;
  let contributionSum = 0;
  for (const name of SIGNAL_NAMES) {
    const signal = signals[name];
    if (signal.present) {
      presentWeightSum += signal.weight;
      contributionSum += signal.weightedContribution;
    }
  }

  const rawScore = presentWeightSum === 0 ? 0 : round4(contributionSum / presentWeightSum);
  const hardViolations = [
    ...(policy.hardRules.languageRequirements ? results.languageMatch.hardViolations : []),
    ...(policy.hardRules.missingRequiredSkills ? results.skillsMatch.hardViolations : []),
  ];
  const capApplied = hardViolations.length > 0;
  const finalScore = capApplied ? Math.min(rawScore, policy.hardRequirementCap) : rawScore;

  const missingRequirements = [
    ...new Set(SIGNAL_NAMES.flatMap((name) => results[name].missingRequirements)),
  ];
  const matchingSkills = results.skillsMatch.matchingSkills;

  const reasons: string[] = [];
  for (const name of SIGNAL_NAMES) {
    const result = results[name];
    const label = SIGNAL_LABELS[name];
    if (result.score === null) {
      reasons.push(`${label}: N/A (${result.reason ?? 'absent'})`);
    } else {
      reasons.push(`${label}: ${result.score.toFixed(2)} — ${result.details.join('; ')}`);
    }
  }
  if (capApplied) {
    reasons.push(
      `Score capped at ${policy.hardRequirementCap.toFixed(2)}: ${hardViolations.length} hard requirement(s) failed`,
    );
  }
  if (selection !== null) {
    for (const reason of selection.reasons) reasons.push(`Resume selection: ${reason}`);
  }

  const breakdown: ScoreBreakdown = ScoreBreakdownSchema.parse({
    engineVersion: policy.engineVersion,
    weightsVersion: policy.weightsVersion,
    signals,
    presentWeightSum: round6(presentWeightSum),
    rawScore,
    hardRequirementCap: policy.hardRequirementCap,
    capApplied,
    finalScore,
    missingRequiredSkills: results.skillsMatch.missingRequirements,
    resumeSelection: {
      recommendedResumeId: selection?.resume.id ?? null,
      recommendedResumeVersionId: selection?.version.id ?? null,
      reasons: selection?.reasons ?? ['no resume versions available'],
    },
  });

  return {
    overallScore: finalScore,
    breakdown,
    reasons,
    missingRequirements,
    matchingSkills,
    recommendedResumeId: selection?.resume.id ?? null,
  };
}
