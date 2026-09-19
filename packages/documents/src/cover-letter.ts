import {
  ClaimKindSchema,
  sha256HexBytes,
  type Claim,
  type ClaimValidation,
  type CoverLetterDraft,
  type CoverLetterInput,
  type GeneratedBy,
  type TextGenerationPort,
} from '@job-system/core';
import { z } from 'zod';
import { computeExperienceMonths, validateClaims } from './claims.js';

/**
 * Cover letter pipeline (architecture doc 08 §5): structured generation via
 * TextGenerationPort → deterministic claim validation → at most ONE factual
 * repair → `requiresHumanInput`/REQUIRES_HUMAN_ACTION if rejected claims remain.
 * The binary CV is never sent; only the minimal facts view plus the job text
 * (delimited as untrusted by the prompt builder).
 */

const ProposedClaimSchema = z.object({
  claim: z.string().trim().min(1).max(1000),
  kind: ClaimKindSchema,
  value: z.unknown().optional(),
});

export const CoverLetterOutputSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  claims: z.array(ProposedClaimSchema).max(30),
});
export type CoverLetterOutput = z.infer<typeof CoverLetterOutputSchema>;

function toClaims(output: CoverLetterOutput): Claim[] {
  return output.claims.map((proposed) => ({
    claim: proposed.claim,
    kind: proposed.kind,
    ...(proposed.value === undefined ? {} : { value: proposed.value }),
    sourceRefs: [],
    verified: 'unverifiable' as const,
  }));
}

function draftFrom(
  text: string,
  validation: ClaimValidation,
  generatedBy: GeneratedBy,
): CoverLetterDraft {
  return {
    kind: 'cover_letter',
    text,
    contentHash: sha256HexBytes(new TextEncoder().encode(text)),
    claims: validation.claims,
    verification: validation.verification,
    generatedBy,
  };
}

/** Deterministic degradation when the provider is unavailable (task §102/§103). */
function fallbackCoverLetter(input: CoverLetterInput): CoverLetterDraft {
  const { facts, job } = input;
  const prompt = input.buildPrompt({ job, facts, attempt: 0, rejectedClaims: [] });
  const claims: Claim[] = [];
  if (facts.experiences.length > 0) {
    const years = Math.floor((computeExperienceMonths(facts.experiences, input.asOfDate) / 12) * 10) / 10;
    if (years > 0) {
      claims.push({
        claim: `~${years} years of professional experience`,
        kind: 'years_experience',
        value: { years },
        sourceRefs: [],
        verified: 'unverifiable',
      });
    }
  }
  const paragraphs = [
    `Dear ${job.company} hiring team,`,
    `I am writing to apply for the ${job.title} position.`,
  ];
  const latest = facts.experiences[0];
  if (latest !== undefined) {
    paragraphs.push(`In my role as ${latest.title} at ${latest.company}, I worked on projects directly relevant to this opening.`);
  }
  const skills = facts.skills.slice(0, 6).map((skill) => skill.name);
  if (skills.length > 0) {
    paragraphs.push(`My background includes ${skills.join(', ')}.`);
  }
  paragraphs.push('I would welcome the opportunity to discuss how my experience fits your team.', 'Sincerely,', facts.displayName);
  const text = paragraphs.join('\n\n');
  const validation = validateClaims(claims, facts, { asOfDate: input.asOfDate });
  return draftFrom(text, validation, {
    provider: 'deterministic',
    model: 'template-v1',
    promptVersion: `${prompt.promptVersion}+fallback`,
    inputHash: input.inputHash,
  });
}

export async function prepareCoverLetter(
  textProvider: TextGenerationPort,
  input: CoverLetterInput,
): Promise<CoverLetterDraft> {
  const maxAttempts = Math.min(input.maxRepairAttempts ?? 1, 1);
  let rejectedClaims: Claim[] = [];
  let lastValidation: ClaimValidation | null = null;
  let lastText = '';
  let lastGeneratedBy: GeneratedBy | null = null;

  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    const prompt = input.buildPrompt({
      job: input.job,
      facts: input.facts,
      attempt,
      rejectedClaims,
    });
    try {
      const result = await textProvider.completeStructured({
        system: prompt.system,
        user: prompt.user,
        promptVersion: prompt.promptVersion,
        inputHash: input.inputHash,
        trace: input.trace,
        schema: CoverLetterOutputSchema,
        schemaName: 'cover_letter',
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });
      const validation = validateClaims(toClaims(result.value), input.facts, {
        asOfDate: input.asOfDate,
      });
      lastText = result.value.text;
      lastValidation = validation;
      lastGeneratedBy = {
        provider: result.provider,
        model: result.model,
        promptVersion: result.promptVersion,
        inputHash: result.inputHash,
      };
      if (validation.verification.status !== 'rejected') {
        return draftFrom(lastText, validation, lastGeneratedBy);
      }
      rejectedClaims = validation.claims.filter((claim) => claim.verified === 'rejected');
    } catch {
      // Provider/parse failure: continue to the single repair attempt; if it
      // also fails, degrade to the deterministic template below.
    }
  }

  if (lastValidation !== null && lastValidation.verification.status === 'rejected' && lastGeneratedBy !== null) {
    // Second factual failure: return the invalid draft so the engine can raise
    // REQUIRES_HUMAN_ACTION. It is never persisted as a valid document.
    return draftFrom(lastText, lastValidation, lastGeneratedBy);
  }
  return fallbackCoverLetter(input);
}
