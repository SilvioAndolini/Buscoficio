import { normalizeForDedup } from '@job-system/core';
import type { MatchJob } from './types.js';

/**
 * Deterministic offer-category classifier (careerRelevance baseline, doc 03 §7).
 * No LLM: ordered keyword rules over title + description. Changing this map is
 * a material engine change (bump `engineVersion`).
 *
 * Order matters: more specific categories are evaluated before the broad
 * software-engineering one (e.g. "Data Engineer" → data, not software).
 */
export const CATEGORY_KEYWORDS: ReadonlyArray<{ category: string; terms: readonly string[] }> = [
  {
    category: 'audiovisual',
    terms: ['audiovisual', 'motion graphics', 'video editor', 'animation', 'video production'],
  },
  {
    category: 'data',
    terms: [
      'data engineer',
      'data scientist',
      'data analyst',
      'analytics engineer',
      'machine learning',
      'business intelligence',
      'etl',
      'data platform',
    ],
  },
  {
    category: 'design',
    terms: ['product designer', 'ux designer', 'ui designer', 'design system', 'graphic design'],
  },
  {
    category: 'management',
    terms: ['engineering manager', 'product manager', 'project manager', 'operations lead', 'head of', 'director of'],
  },
  {
    category: 'marketing',
    terms: ['marketing', 'growth', 'seo', 'content strategist'],
  },
  {
    category: 'software-engineering',
    terms: [
      'software engineer',
      'software developer',
      'full stack',
      'frontend',
      'front-end',
      'backend',
      'back-end',
      'react',
      'typescript',
      'javascript',
      'node.js',
      'python developer',
      'java developer',
      'devops',
      'platform engineer',
      'qa engineer',
      'developer',
      'engineer',
    ],
  },
];

export interface JobCategoryClassification {
  category: string;
  matchedTerms: string[];
}

/** Returns null when no rule matches (careerRelevance is then absent). */
export function classifyJobCategory(job: MatchJob): JobCategoryClassification | null {
  const title = normalizeForDedup(job.title);
  const description = normalizeForDedup(job.description);
  // Title is the strongest signal: it is evaluated on its own first so a
  // description mention (e.g. "design system" in a software job) cannot
  // override the title category.
  const byTitle = matchTerms(title);
  if (byTitle !== null) return byTitle;
  return matchTerms(description);
}

function matchTerms(text: string): JobCategoryClassification | null {
  for (const rule of CATEGORY_KEYWORDS) {
    const matched = rule.terms.filter((term) => text.includes(term));
    if (matched.length > 0) {
      return { category: rule.category, matchedTerms: matched };
    }
  }
  return null;
}

export interface ResumeCategoryFit {
  score: number;
  details: string[];
  matchedResumeId: string | null;
}

/**
 * careerRelevance v1 baseline: 1.0 when some resume category matches the
 * classified offer category; 0.35 when the offer is classified but no resume
 * covers it; absent when the offer cannot be classified or there are no resumes.
 */
export function careerRelevanceFromCategory(
  classification: JobCategoryClassification | null,
  resumes: ReadonlyArray<{ id: string; category: string }>,
): { score: number | null; details: string[]; reason: string | null } {
  if (classification === null) {
    return { score: null, details: [], reason: 'job category could not be classified deterministically' };
  }
  if (resumes.length === 0) {
    return { score: null, details: [], reason: 'candidate has no resumes' };
  }
  const match = resumes.find((resume) => resume.category === classification.category);
  if (match) {
    return {
      score: 1,
      details: [
        `job classified as '${classification.category}' (terms: ${classification.matchedTerms.join(', ')})`,
        `resume ${match.id} has the same category`,
      ],
      reason: null,
    };
  }
  return {
    score: 0.35,
    details: [
      `job classified as '${classification.category}' (terms: ${classification.matchedTerms.join(', ')})`,
      `no resume has category '${classification.category}'`,
    ],
    reason: null,
  };
}
