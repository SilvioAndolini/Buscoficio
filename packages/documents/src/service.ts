import type {
  Claim,
  ClaimValidation,
  CoverLetterInput,
  CoverLetterPreparation,
  DocumentsPort,
  ProfileFactsSource,
  ProfileFactsView,
  ResolveAnswerInput,
  ResolveAnswerResult,
  ResumeVariantDraft,
  ResumeVariantInput,
  TextGenerationPort,
} from '@job-system/core';
import { resolveAnswer } from './answers.js';
import { validateClaims } from './claims.js';
import { prepareCoverLetter } from './cover-letter.js';
import { buildProfileFactsView } from './facts.js';
import { hashQuestion } from './question.js';
import { prepareResumeVariant } from './resume-variant.js';

export interface DocumentsServiceDeps {
  textProvider: TextGenerationPort;
}

/**
 * Documents service (task §64): produces validated drafts and never persists.
 * Persistence and orchestration belong to `application-engine` + the
 * composition root.
 */
export function createDocumentsService(deps: DocumentsServiceDeps): DocumentsPort {
  return {
    provider: deps.textProvider.provider,
    model: deps.textProvider.model,
    validateClaims(
      claims: Claim[],
      facts: ProfileFactsView,
      options: { asOfDate: Date | null },
    ): ClaimValidation {
      return validateClaims(claims, facts, options);
    },
    buildProfileFactsView(source: ProfileFactsSource, options?: { includeSalary?: boolean }): ProfileFactsView {
      return buildProfileFactsView(source, options ?? {});
    },
    hashQuestion,
    prepareResumeVariant(input: ResumeVariantInput): ResumeVariantDraft {
      return prepareResumeVariant(input);
    },
    prepareCoverLetter(input: CoverLetterInput): Promise<CoverLetterPreparation> {
      return prepareCoverLetter(deps.textProvider, input);
    },
    resolveAnswer(input: ResolveAnswerInput): ResolveAnswerResult {
      return resolveAnswer(input);
    },
  };
}
