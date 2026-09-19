import { z } from 'zod';
import { nonEmptyString } from './common.js';

/* ------------------------------------------------------------------ */
/* Application lifecycle contracts (architecture doc 03 §2/§4, 04 §2.6) */
/* ------------------------------------------------------------------ */

export const ApplicationModeSchema = z.enum(['manual', 'assisted', 'auto']);
export type ApplicationMode = z.infer<typeof ApplicationModeSchema>;

/**
 * Full approved state machine. Phase 4 executes only the preparation segment
 * (DISCOVERED…PREPARING/REQUIRES_HUMAN_ACTION/ARCHIVED); the future states
 * exist so the machine is complete and cannot be bypassed later.
 */
export const ApplicationStatusSchema = z.enum([
  'DISCOVERED',
  'FILTERED',
  'SHORTLISTED',
  'PREPARING',
  'READY_FOR_REVIEW',
  'APPROVED',
  'SUBMITTING',
  'SUBMITTED',
  'REJECTED',
  'INTERVIEW',
  'OFFER',
  'FAILED',
  'REQUIRES_HUMAN_ACTION',
  'ARCHIVED',
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;
export const APPLICATION_STATUSES: readonly ApplicationStatus[] = ApplicationStatusSchema.options;

export const ApplicationActorSchema = z.enum(['system', 'user']);
export type ApplicationActor = z.infer<typeof ApplicationActorSchema>;

/* ------------------------------------------------------------------ */
/* Claims + provenance (doc 03 §8)                                     */
/* ------------------------------------------------------------------ */

export const ClaimKindSchema = z.enum([
  'years_experience',
  'date_range',
  'job_title',
  'company',
  'certification',
  'degree',
  'language_level',
  'salary',
  'project',
  'seniority',
]);
export type ClaimKind = z.infer<typeof ClaimKindSchema>;

export const SourceRefEntityTypeSchema = z.enum([
  'candidate_profile',
  'candidate_skill',
  'experience',
  'education',
  'candidate_language',
  'resume_version',
]);
export type SourceRefEntityType = z.infer<typeof SourceRefEntityTypeSchema>;

/** Every factual claim must be able to point at the profile entity backing it. */
export const SourceRefSchema = z.object({
  entityType: SourceRefEntityTypeSchema,
  entityId: z.string().uuid(),
  field: z.string().trim().min(1).max(80).optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const VerificationStatusSchema = z.enum(['verified', 'unverifiable', 'rejected']);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/**
 * The LLM may propose claims, but `verified` is always recomputed by the
 * deterministic validator (doc 08 §5). `value` is kind-specific and validated
 * structurally by the validator, never trusted from the provider.
 */
export const ClaimSchema = z.object({
  claim: z.string().trim().min(1).max(1000),
  kind: ClaimKindSchema,
  value: z.unknown().optional(),
  sourceRefs: z.array(SourceRefSchema).max(20).default([]),
  verified: VerificationStatusSchema,
});
export type Claim = z.infer<typeof ClaimSchema>;

/**
 * Provider/user-proposed claim: no `verified` and no trusted sourceRefs — the
 * deterministic validator recomputes both (task §34/§35).
 */
export const ProposedClaimSchema = z.object({
  claim: z.string().trim().min(1).max(1000),
  kind: ClaimKindSchema,
  value: z.unknown().optional(),
});
export type ProposedClaim = z.infer<typeof ProposedClaimSchema>;

export function toProposedClaim(claim: ProposedClaim): Claim {
  return {
    claim: claim.claim,
    kind: claim.kind,
    ...(claim.value === undefined ? {} : { value: claim.value }),
    sourceRefs: [],
    verified: 'unverifiable',
  };
}

export const ClaimFailureSchema = z.object({
  claim: z.string(),
  kind: ClaimKindSchema,
  reason: z.string().min(1),
});
export type ClaimFailure = z.infer<typeof ClaimFailureSchema>;

export const VerificationResultSchema = z.object({
  status: VerificationStatusSchema,
  failures: z.array(ClaimFailureSchema).default([]),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

/** Deterministic validator output: claims rewritten with real verification. */
export interface ClaimValidation {
  claims: Claim[];
  verification: VerificationResult;
}

/* ------------------------------------------------------------------ */
/* Answers / documents / preparation                                   */
/* ------------------------------------------------------------------ */

export const AnswerKindSchema = z.enum(['profile', 'resume', 'user', 'generated']);
export type AnswerKind = z.infer<typeof AnswerKindSchema>;

export const ApplicationAnswerSchema = z.object({
  id: z.string().uuid(),
  applicationId: z.string().uuid(),
  questionText: z.string().trim().min(1).max(2000),
  questionHash: z.string().length(64),
  answerText: z.string().max(20_000).nullable(),
  answerKind: AnswerKindSchema,
  sourceRefs: z.array(SourceRefSchema).default([]),
  claims: z.array(ClaimSchema).default([]),
  verification: VerificationResultSchema,
  requiresHumanInput: z.boolean(),
  approved: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ApplicationAnswer = z.infer<typeof ApplicationAnswerSchema>;

export const ApplicationDocumentKindSchema = z.enum(['cover_letter', 'resume_variant', 'other']);
export type ApplicationDocumentKind = z.infer<typeof ApplicationDocumentKindSchema>;

/** Provenance of generated content; never contains keys or prompt bodies. */
export const GeneratedBySchema = z.object({
  provider: nonEmptyString.max(80),
  model: nonEmptyString.max(120),
  promptVersion: nonEmptyString.max(80),
  inputHash: z.string().length(64),
  /**
   * Temporal anchor used to render/evaluate open-ended experience (Phase 4.1).
   * Null/absent when every experience range is closed (time-independent).
   */
  asOfDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'asOfDate must be YYYY-MM-DD')
    .nullable()
    .optional(),
});
export type GeneratedBy = z.infer<typeof GeneratedBySchema>;

export const ApplicationDocumentSchema = z.object({
  id: z.string().uuid(),
  applicationId: z.string().uuid(),
  kind: ApplicationDocumentKindSchema,
  resumeVersionId: z.string().uuid().nullable(),
  storageKey: nonEmptyString.max(500),
  contentHash: z.string().length(64),
  claims: z.array(ClaimSchema).default([]),
  verification: VerificationResultSchema,
  generatedBy: GeneratedBySchema,
  createdAt: z.date(),
});
export type ApplicationDocument = z.infer<typeof ApplicationDocumentSchema>;

export const PreparationBlockerCodeSchema = z.enum([
  'requires_human_input',
  'stale_answer',
  'rejected_claims',
  'missing_resume',
  'target_blocked',
  'ai_unavailable',
]);
export type PreparationBlockerCode = z.infer<typeof PreparationBlockerCodeSchema>;

export const PreparationBlockerSchema = z.object({
  code: PreparationBlockerCodeSchema,
  message: z.string().min(1),
  refId: z.string().optional(),
});
export type PreparationBlocker = z.infer<typeof PreparationBlockerSchema>;

/* ------------------------------------------------------------------ */
/* Job view used by document generation (untrusted external content)   */
/* ------------------------------------------------------------------ */

export const JobDocumentViewSchema = z.object({
  id: z.string().uuid(),
  title: nonEmptyString.max(300),
  company: nonEmptyString.max(300),
  description: z.string().max(100_000),
  location: z.string().max(300).nullable(),
  remoteType: z.string().max(40).nullable(),
  employmentType: z.string().max(40).nullable(),
  requiredSkills: z.array(nonEmptyString.max(120)).default([]),
  preferredSkills: z.array(nonEmptyString.max(120)).default([]),
  languageRequirements: z.array(nonEmptyString.max(80)).default([]),
});
export type JobDocumentView = z.infer<typeof JobDocumentViewSchema>;

/* ------------------------------------------------------------------ */
/* Drafts produced by `documents` (no persistence inside the package)  */
/* ------------------------------------------------------------------ */

export const ResumeVariantDraftSchema = z.object({
  kind: z.literal('resume_variant'),
  text: z.string().min(1),
  contentHash: z.string().length(64),
  claims: z.array(ClaimSchema),
  verification: VerificationResultSchema,
  generatedBy: GeneratedBySchema,
  sourceResumeVersionId: z.string().uuid(),
  highlights: z.record(z.unknown()).default({}),
});
export type ResumeVariantDraft = z.infer<typeof ResumeVariantDraftSchema>;

export const CoverLetterDraftSchema = z.object({
  kind: z.literal('cover_letter'),
  text: z.string().min(1),
  contentHash: z.string().length(64),
  claims: z.array(ClaimSchema),
  verification: VerificationResultSchema,
  generatedBy: GeneratedBySchema,
});
export type CoverLetterDraft = z.infer<typeof CoverLetterDraftSchema>;

export const PreparationResultSchema = z.object({
  applicationId: z.string().uuid(),
  inputHash: z.string().length(64),
  status: ApplicationStatusSchema,
  created: z.boolean(),
  documents: z.array(
    z.object({
      id: z.string().uuid(),
      kind: ApplicationDocumentKindSchema,
      contentHash: z.string().length(64),
      storageKey: z.string(),
      verification: VerificationResultSchema,
    }),
  ),
  blockers: z.array(PreparationBlockerSchema),
  requiresHumanInput: z.boolean(),
});
export type PreparationResult = z.infer<typeof PreparationResultSchema>;

/** Public shape returned by application commands (API/UI contract). */
export const ApplicationViewSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  candidateId: z.string().uuid(),
  applicationTargetId: z.string().uuid().nullable(),
  discoverySourceId: z.string().uuid().nullable(),
  matchId: z.string().uuid(),
  mode: ApplicationModeSchema,
  status: ApplicationStatusSchema,
  resumeVersionId: z.string().uuid().nullable(),
  idempotencyKey: z.string().length(64),
  policyVersion: nonEmptyString.max(80),
  scoreAtCreation: z.number().min(0).max(1),
  preparationSnapshot: z.unknown().nullable(),
  supersedesApplicationId: z.string().uuid().nullable(),
  submittedAt: z.date().nullable(),
  lastTransitionAt: z.date(),
  requiresHumanReason: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ApplicationView = z.infer<typeof ApplicationViewSchema>;
