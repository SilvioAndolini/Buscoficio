/**
 * `documents`: CV variants, cover letters, answers, claims and deterministic
 * factual validation (Phase 4). Pure: no database, no AI SDKs, no apps.
 * It consumes core ports (TextGenerationPort) injected by the composition root
 * (architecture doc 11 §3).
 */
export { resolveAnswer } from './answers.js';
export { CLAIMLESS_ANSWER_REASON, validateAnswerContent } from './answer-content.js';
export { computeExperienceMonths, validateClaims } from './claims.js';
export { CoverLetterOutputSchema, prepareCoverLetter } from './cover-letter.js';
export { buildProfileFactsView } from './facts.js';
export { canonicalQuestion, hashQuestion } from './question.js';
export { prepareResumeVariant } from './resume-variant.js';
export { createDocumentsService, type DocumentsServiceDeps } from './service.js';
