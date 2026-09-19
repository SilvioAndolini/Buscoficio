import type {
  Claim,
  ClaimFailure,
  ClaimValidation,
  CoverLetterDraft,
  GeneratedBy,
  JobDocumentView,
  ResumeVariantDraft,
  SourceRef,
  VerificationResult,
} from '../schemas/application.js';
import type { ProfileFactsSource, ProfileFactsView } from '../schemas/facts.js';
import type { TraceContext } from './trace.js';

/** Versioned prompt payload built by the composition root (prompts live in ai). */
export interface PromptPayload {
  promptVersion: string;
  system: string;
  user: string;
}

export interface SourceResumeVersionView {
  id: string;
  resumeId: string;
  versionNumber: number;
  kind: string;
  highlights: Record<string, unknown>;
}

export interface ResumeVariantInput {
  job: JobDocumentView;
  facts: ProfileFactsView;
  sourceResumeVersion: SourceResumeVersionView;
  /** Explicit temporal anchor; null when every experience range is closed. */
  asOfDate: Date | null;
  /** Preparation identity; persisted inside generatedBy (provenance). */
  inputHash: string;
}

export interface CoverLetterPromptContext {
  job: JobDocumentView;
  facts: ProfileFactsView;
  /** 0 = first generation, 1 = single factual repair attempt. */
  attempt: number;
  rejectedClaims: Claim[];
}

export type CoverLetterPromptBuilder = (context: CoverLetterPromptContext) => PromptPayload;

export interface CoverLetterInput {
  job: JobDocumentView;
  facts: ProfileFactsView;
  /** Explicit temporal anchor; null when every experience range is closed. */
  asOfDate: Date | null;
  buildPrompt: CoverLetterPromptBuilder;
  inputHash: string;
  trace: TraceContext;
  /** Clamped to 1 by policy (never "retry until the model agrees"). */
  maxRepairAttempts?: number;
  timeoutMs?: number;
}

export interface ResolveAnswerInput {
  questionText: string;
  priorApproved: {
    id: string;
    answerText: string | null;
    sourceRefs: SourceRef[];
    claims: Claim[];
    verification: VerificationResult;
  } | null;
  facts: ProfileFactsView;
  /** Explicit temporal anchor; null when every experience range is closed. */
  asOfDate: Date | null;
}

export type ResolveAnswerResult =
  | {
      action: 'reuse' | 'stale';
      answerText: string | null;
      sourceRefs: SourceRef[];
      claims: Claim[];
      verification: VerificationResult;
      requiresHumanInput: boolean;
    }
  | { action: 'requires_human'; reason: string };

/**
 * Claim-complete cover letter preparation (Phase 4.1, P1). The final text is
 * deterministically rendered from validated claims; the model only selects and
 * structures them. `requires_human` means no factually safe document could be
 * produced (rejected claims after the single repair, or invalid structured
 * output): the engine raises REQUIRES_HUMAN_ACTION and nothing is persisted.
 */
export type CoverLetterPreparation =
  | { kind: 'draft'; draft: CoverLetterDraft }
  | { kind: 'requires_human'; reason: string; failures: ClaimFailure[]; generatedBy: GeneratedBy };

export interface DocumentsPort {
  /** Provider/model actually used for text generation (provenance + hash). */
  readonly provider: string;
  readonly model: string;

  /**
   * Deterministic claim validator (authority): no LLM decides whether a fact
   * is true (architecture docs 03 §8, 08 §5).
   */
  validateClaims(
    claims: Claim[],
    facts: ProfileFactsView,
    options: { asOfDate: Date | null },
  ): ClaimValidation;

  /** PII-minimized facts view; salary only when explicitly requested. */
  buildProfileFactsView(
    source: ProfileFactsSource,
    options?: { includeSalary?: boolean },
  ): ProfileFactsView;

  /** Canonical question identity for the answer bank (no fuzzy matching). */
  hashQuestion(questionText: string): string;

  /** Deterministic tailored resume variant (reorder/select/summarize only). */
  prepareResumeVariant(input: ResumeVariantInput): ResumeVariantDraft;

  /** Cover letter: structured claim selection + deterministic rendering + max 1 repair. */
  prepareCoverLetter(input: CoverLetterInput): Promise<CoverLetterPreparation>;

  /** Answer bank: revalidate an approved answer against current facts. */
  resolveAnswer(input: ResolveAnswerInput): ResolveAnswerResult;
}
