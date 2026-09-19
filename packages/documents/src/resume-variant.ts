import {
  normalizeForDedup,
  sha256HexBytes,
  type Claim,
  type ResumeVariantDraft,
  type ResumeVariantInput,
} from '@job-system/core';
import { computeExperienceMonths, validateClaims } from './claims.js';

/**
 * Deterministic tailored resume (task §59–§61): only reorders/selects/summarizes
 * existing facts. No LLM runs here, so a variant can never invent skills, years,
 * companies, education or certifications. Output is canonical Markdown stored
 * via StoragePort; the original ResumeVersion stays immutable.
 */

function relevanceScore(skills: string[], jobSkills: Set<string>): number {
  let score = 0;
  for (const skill of skills) {
    if (jobSkills.has(normalizeForDedup(skill))) score += 1;
  }
  return score;
}

function formatMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function floor1(value: number): number {
  return Math.floor(value * 10) / 10;
}

export function prepareResumeVariant(input: ResumeVariantInput): ResumeVariantDraft {
  const { facts, job, sourceResumeVersion, asOfDate, inputHash } = input;
  const jobSkills = new Set(
    [...job.requiredSkills, ...job.preferredSkills].map((skill) => normalizeForDedup(skill)),
  );

  const skills = [...facts.skills].sort((a, b) => {
    const scoreDiff = relevanceScore(b.aliases.concat(b.name), jobSkills) - relevanceScore(a.aliases.concat(a.name), jobSkills);
    if (scoreDiff !== 0) return scoreDiff;
    return normalizeForDedup(a.name).localeCompare(normalizeForDedup(b.name));
  });

  const experiences = [...facts.experiences].sort((a, b) => {
    const scoreDiff = relevanceScore(b.skills, jobSkills) - relevanceScore(a.skills, jobSkills);
    if (scoreDiff !== 0) return scoreDiff;
    return b.startDate.getTime() - a.startDate.getTime();
  });

  const months = facts.experiences.length > 0 ? computeExperienceMonths(facts.experiences, asOfDate) : 0;
  const years = floor1(months / 12);

  const claims: Claim[] = [];
  if (years > 0) {
    claims.push({
      claim: `~${years} years of professional experience`,
      kind: 'years_experience',
      value: { years },
      sourceRefs: [],
      verified: 'unverifiable',
    });
  }

  const lines: string[] = [];
  lines.push(`# ${facts.displayName}`);
  if (facts.headline !== null && facts.headline.length > 0) lines.push(facts.headline);
  lines.push('', '## Summary');
  if (years > 0) lines.push(`Professional with ~${years} years of experience.`);
  if (skills.length > 0) {
    lines.push(`Core skills: ${skills.slice(0, 8).map((skill) => skill.name).join(', ')}.`);
  }

  if (skills.length > 0) {
    lines.push('', '## Skills');
    for (const skill of skills) {
      lines.push(`- ${skill.name} (${skill.level}${skill.years === null ? '' : `, ${skill.years} years`})`);
    }
  }

  if (experiences.length > 0) {
    lines.push('', '## Experience');
    for (const experience of experiences) {
      const end = experience.endDate === null ? 'Present' : formatMonth(experience.endDate);
      lines.push(`### ${experience.title} — ${experience.company}`);
      lines.push(`${formatMonth(experience.startDate)} – ${end}`);
      if (experience.skills.length > 0) lines.push(`Skills: ${experience.skills.join(', ')}`);
    }
  }

  if (facts.education.length > 0) {
    lines.push('', '## Education');
    for (const education of facts.education) {
      const field = education.field === null ? '' : `, ${education.field}`;
      lines.push(`- ${education.degree}${field} — ${education.institution} (${education.status})`);
    }
  }

  if (facts.languages.length > 0) {
    lines.push('', '## Languages');
    for (const language of facts.languages) {
      lines.push(`- ${language.language}: ${language.level}`);
    }
  }

  const text = `${lines.join('\n')}\n`;
  const contentHash = sha256HexBytes(new TextEncoder().encode(text));
  const validation = validateClaims(claims, facts, { asOfDate });

  return {
    kind: 'resume_variant',
    text,
    contentHash,
    claims: validation.claims,
    verification: validation.verification,
    generatedBy: {
      provider: 'deterministic',
      model: 'template-v1',
      promptVersion: 'resume-variant/v1',
      inputHash,
    },
    sourceResumeVersionId: sourceResumeVersion.id,
    highlights: {
      sourceResumeVersionId: sourceResumeVersion.id,
      applicationInputHash: inputHash,
      skills: skills.slice(0, 12).map((skill) => skill.name),
    },
  };
}
