import {
  ClaimKindSchema,
  isAppError,
  sha256HexBytes,
  type Claim,
  type ClaimKind,
  type ClaimValidation,
  type CoverLetterDraft,
  type CoverLetterInput,
  type CoverLetterPreparation,
  type GeneratedBy,
  type ProfileFactsView,
  type TextGenerationPort,
} from '@job-system/core';
import { z } from 'zod';
import { computeExperienceMonths, validateClaims } from './claims.js';
import { asFiniteNumber, asRecord, asString } from './value.js';

/**
 * Claim-complete cover letter (Phase 4.1, P1).
 *
 * The provider does NOT write the document: it returns a structured plan
 * (which facts to assert, in which order, and tone/opening/closing variants).
 * The final text is rendered deterministically from the validated claim values
 * plus code-owned templates. There is no free-text channel, so a factual
 * statement cannot enter the document without an explicit, validated claim
 * (task §5–§11). `claim.claim` is a display/audit label only; the authority is
 * always `kind` + `value` + `ProfileFactsView`.
 */

const ClaimPlanSchema = z.object({
  kind: ClaimKindSchema,
  value: z.unknown().optional(),
});

export const CoverLetterOutputSchema = z.object({
  tone: z.enum(['direct', 'warm', 'formal']),
  opening: z.enum(['direct', 'enthusiastic', 'values']),
  closing: z.enum(['thanks', 'available', 'follow_up']),
  /** Every claim listed here is asserted in the rendered document. */
  claims: z.array(ClaimPlanSchema).max(30),
});
export type CoverLetterOutput = z.infer<typeof CoverLetterOutputSchema>;

type PlanClaim = { kind: ClaimKind; value?: unknown };

function formatYears(years: number): string {
  return Number.isInteger(years) ? String(years) : years.toFixed(1);
}

function isoDate(date: Date | null): string | null {
  return date === null ? null : date.toISOString().slice(0, 10);
}

/** Short display/audit label; never used as factual authority. */
export function describeClaim(claim: PlanClaim): string {
  const value = asRecord(claim.value);
  switch (claim.kind) {
    case 'years_experience': {
      const years = value === null ? null : asFiniteNumber(value['years']);
      const skill = value === null ? null : asString(value['skill']);
      if (years === null) return 'years of experience (unstructured)';
      return skill === null
        ? `${formatYears(years)} years of professional experience`
        : `${formatYears(years)} years of experience with ${skill}`;
    }
    case 'date_range': {
      const start = value === null ? null : asString(value['start']);
      const endRaw = value === null ? undefined : value['end'];
      const end = endRaw === null ? 'present' : asString(endRaw);
      return `${start ?? 'unknown'} to ${end ?? 'unknown'}`;
    }
    case 'job_title':
      return `job title: ${(value === null ? null : asString(value['title'])) ?? 'unknown'}`;
    case 'company':
      return `company: ${(value === null ? null : asString(value['company'])) ?? 'unknown'}`;
    case 'degree': {
      const degree = value === null ? null : asString(value['degree']);
      const institution = value === null ? null : asString(value['institution']);
      return institution === null ? `${degree ?? 'unknown'}` : `${degree ?? 'unknown'} at ${institution}`;
    }
    case 'language_level': {
      const language = value === null ? null : asString(value['language']);
      const level = value === null ? null : asString(value['level']);
      return `${language ?? 'unknown'}: ${level ?? 'unknown'}`;
    }
    case 'salary': {
      const amount =
        value === null
          ? null
          : (asFiniteNumber(value['amount']) ?? asFiniteNumber(value['min']) ?? asFiniteNumber(value['max']));
      const currency = value === null ? null : asString(value['currency']);
      return `salary: ${amount ?? 'unknown'} ${currency ?? ''}`.trim();
    }
    case 'certification':
      return `certification: ${(value === null ? null : asString(value['name'])) ?? 'unknown'}`;
    case 'project':
      return `project: ${(value === null ? null : asString(value['name'])) ?? 'unknown'}`;
    case 'seniority':
      return `seniority: ${(value === null ? null : asString(value['level'])) ?? 'unknown'}`;
  }
}

/**
 * Deterministic sentence for a claim. Returns null when the value is not
 * structurally renderable (treated as invalid provider output).
 */
export function renderClaimSentence(claim: PlanClaim): string | null {
  const value = asRecord(claim.value);
  switch (claim.kind) {
    case 'years_experience': {
      const years = value === null ? null : asFiniteNumber(value['years']);
      if (years === null) return null;
      const skill = value === null ? null : asString(value['skill']);
      return skill === null
        ? `I bring ${formatYears(years)} years of professional experience.`
        : `I have ${formatYears(years)} years of experience with ${skill}.`;
    }
    case 'date_range': {
      const start = value === null ? null : asString(value['start']);
      const endRaw = value === null ? undefined : value['end'];
      const end = endRaw === null ? 'the present' : asString(endRaw);
      if (start === null || end === null) return null;
      return `My experience spans ${start} to ${end}.`;
    }
    case 'job_title': {
      const title = value === null ? null : asString(value['title']);
      return title === null ? null : `I have worked as ${title}.`;
    }
    case 'company': {
      const company = value === null ? null : asString(value['company']);
      return company === null ? null : `I have worked at ${company}.`;
    }
    case 'degree': {
      const degree = value === null ? null : asString(value['degree']);
      if (degree === null) return null;
      const institution = value === null ? null : asString(value['institution']);
      return institution === null
        ? `I completed ${degree}.`
        : `I completed ${degree} at ${institution}.`;
    }
    case 'language_level': {
      const language = value === null ? null : asString(value['language']);
      const level = value === null ? null : asString(value['level']);
      if (language === null || level === null) return null;
      return `My level of ${language} is ${level}.`;
    }
    case 'salary': {
      const amount =
        value === null
          ? null
          : (asFiniteNumber(value['amount']) ?? asFiniteNumber(value['min']) ?? asFiniteNumber(value['max']));
      const currency = value === null ? null : asString(value['currency']);
      if (amount === null || currency === null) return null;
      return `My salary expectation is ${amount} ${currency}.`;
    }
    case 'seniority': {
      const level = value === null ? null : asString(value['level']);
      return level === null ? null : `I work at a ${level} level.`;
    }
    case 'certification': {
      const name = value === null ? null : asString(value['name']);
      return name === null ? null : `I hold the ${name} certification.`;
    }
    case 'project': {
      const name = value === null ? null : asString(value['name']);
      return name === null ? null : `I worked on ${name}.`;
    }
  }
}

const OPENINGS: Record<CoverLetterOutput['opening'], (title: string) => string> = {
  direct: (title) => `I am writing to apply for the ${title} position.`,
  enthusiastic: (title) => `I am excited to apply for the ${title} position.`,
  values: (title) => `The ${title} role aligns closely with my professional focus.`,
};

const CLOSINGS: Record<CoverLetterOutput['closing'], string> = {
  thanks: 'Thank you for your consideration.',
  available: 'I would welcome the opportunity to discuss how my experience fits your team.',
  follow_up: 'I would be glad to follow up with any additional information.',
};

const TONES: Record<
  CoverLetterOutput['tone'],
  { greeting: (company: string) => string; signoff: string }
> = {
  direct: { greeting: (company) => `Dear ${company} hiring team,`, signoff: 'Sincerely,' },
  warm: { greeting: (company) => `Hello ${company} team,`, signoff: 'Best regards,' },
  formal: { greeting: (company) => `Dear ${company} Hiring Team,`, signoff: 'Yours faithfully,' },
};

/**
 * Deterministic renderer: greeting/opening/closing come from code-owned
 * templates; every factual sentence is generated from one validated claim.
 */
export function renderCoverLetter(input: {
  job: { title: string; company: string };
  displayName: string;
  plan: Pick<CoverLetterOutput, 'tone' | 'opening' | 'closing'>;
  claims: PlanClaim[];
}): { text: string; renderedClaims: number } {
  const sentences = input.claims
    .map((claim) => renderClaimSentence(claim))
    .filter((sentence): sentence is string => sentence !== null);
  const paragraphs = [
    TONES[input.plan.tone].greeting(input.job.company),
    OPENINGS[input.plan.opening](input.job.title),
    ...sentences,
    CLOSINGS[input.plan.closing],
    `${TONES[input.plan.tone].signoff}\n${input.displayName}`,
  ];
  return { text: `${paragraphs.join('\n\n')}\n`, renderedClaims: sentences.length };
}

function toClaim(plan: PlanClaim): Claim {
  return {
    claim: describeClaim(plan),
    kind: plan.kind,
    ...(plan.value === undefined ? {} : { value: plan.value }),
    sourceRefs: [],
    verified: 'unverifiable',
  };
}

function draftFrom(
  input: CoverLetterInput,
  plan: CoverLetterOutput,
  validation: ClaimValidation,
  generatedBy: GeneratedBy,
): CoverLetterDraft {
  const renderable = validation.claims.filter((claim) => claim.verified !== 'rejected');
  const { text } = renderCoverLetter({
    job: input.job,
    displayName: input.facts.displayName,
    plan,
    claims: renderable,
  });
  return {
    kind: 'cover_letter',
    text,
    contentHash: sha256HexBytes(new TextEncoder().encode(text)),
    claims: validation.claims,
    verification: validation.verification,
    generatedBy,
  };
}

function generatedByOf(
  input: CoverLetterInput,
  provider: string,
  model: string,
  promptVersion: string,
): GeneratedBy {
  return {
    provider,
    model,
    promptVersion,
    inputHash: input.inputHash,
    asOfDate: isoDate(input.asOfDate),
  };
}

function isInvalidOutputError(error: unknown): boolean {
  return isAppError(error) && error.code === 'AI_ERROR' && error.context?.['invalidOutput'] === true;
}

/** Facts-derived fallback claims (all exactly match structured profile data). */
function buildFallbackClaims(facts: ProfileFactsView, asOfDate: Date | null): PlanClaim[] {
  if (facts.experiences.length === 0) return [];
  const claims: PlanClaim[] = [];
  const years = Math.floor((computeExperienceMonths(facts.experiences, asOfDate) / 12) * 10) / 10;
  if (years > 0) claims.push({ kind: 'years_experience', value: { years } });
  const latest = facts.experiences[0]!;
  claims.push({ kind: 'company', value: { company: latest.company } });
  claims.push({ kind: 'job_title', value: { title: latest.title } });
  return claims;
}

function fallbackPreparation(input: CoverLetterInput): CoverLetterPreparation {
  const prompt = input.buildPrompt({
    job: input.job,
    facts: input.facts,
    attempt: 0,
    rejectedClaims: [],
  });
  const generatedBy: GeneratedBy = {
    provider: 'deterministic',
    model: 'template-v1',
    promptVersion: `${prompt.promptVersion}+fallback`,
    inputHash: input.inputHash,
    asOfDate: isoDate(input.asOfDate),
  };
  const plan: CoverLetterOutput = {
    tone: 'direct',
    opening: 'direct',
    closing: 'thanks',
    claims: buildFallbackClaims(input.facts, input.asOfDate),
  };
  const validation = validateClaims(plan.claims.map(toClaim), input.facts, {
    asOfDate: input.asOfDate,
  });
  if (validation.verification.status === 'rejected') {
    return {
      kind: 'requires_human',
      reason: 'Deterministic fallback could not be verified against the profile',
      failures: validation.verification.failures,
      generatedBy,
    };
  }
  return { kind: 'draft', draft: draftFrom(input, plan, validation, generatedBy) };
}

export async function prepareCoverLetter(
  textProvider: TextGenerationPort,
  input: CoverLetterInput,
): Promise<CoverLetterPreparation> {
  const maxAttempts = Math.min(input.maxRepairAttempts ?? 1, 1);
  let rejectedClaims: Claim[] = [];
  let lastValidation: ClaimValidation | null = null;
  let lastGeneratedBy: GeneratedBy | null = null;
  let sawInvalidOutput = false;
  let sawProviderFailure = false;

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
      const generatedBy = generatedByOf(
        input,
        result.provider,
        result.model,
        result.promptVersion,
      );
      const validation = validateClaims(result.value.claims.map(toClaim), input.facts, {
        asOfDate: input.asOfDate,
      });
      const renderable = validation.claims.filter((claim) => claim.verified !== 'rejected');
      const unrenderable = renderable.filter((claim) => renderClaimSentence(claim) === null);
      lastValidation = validation;
      lastGeneratedBy = generatedBy;

      if (unrenderable.length > 0) {
        // A non-rejected claim that cannot be expressed deterministically means
        // the plan is not claim-complete: never render a partial document.
        sawInvalidOutput = true;
        rejectedClaims = unrenderable;
        continue;
      }
      if (validation.verification.status === 'rejected') {
        rejectedClaims = validation.claims.filter((claim) => claim.verified === 'rejected');
        continue; // single factual repair
      }
      return { kind: 'draft', draft: draftFrom(input, result.value, validation, generatedBy) };
    } catch (error) {
      if (isInvalidOutputError(error)) sawInvalidOutput = true;
      else sawProviderFailure = true;
    }
  }

  if (lastValidation !== null && lastValidation.verification.status === 'rejected') {
    return {
      kind: 'requires_human',
      reason: `Rejected factual claims after the single repair: ${lastValidation.verification.failures
        .map((failure) => failure.reason)
        .join('; ')}`,
      failures: lastValidation.verification.failures,
      generatedBy: lastGeneratedBy!,
    };
  }
  if (sawInvalidOutput && !sawProviderFailure) {
    const prompt = input.buildPrompt({
      job: input.job,
      facts: input.facts,
      attempt: 0,
      rejectedClaims: [],
    });
    return {
      kind: 'requires_human',
      reason:
        'Provider did not return a claim-complete structured plan after the single repair; refusing to render a document with undeclared facts',
      failures: [],
      generatedBy:
        lastGeneratedBy ??
        generatedByOf(input, textProvider.provider, textProvider.model, prompt.promptVersion),
    };
  }
  // Provider unavailable (timeout/error): deterministic, claim-complete template.
  return fallbackPreparation(input);
}
