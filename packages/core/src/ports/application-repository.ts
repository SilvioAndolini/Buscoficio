import type {
  ApplicationActor,
  ApplicationDocumentKind,
  ApplicationMode,
  ApplicationStatus,
  AnswerKind,
  Claim,
  GeneratedBy,
  JobDocumentView,
  SourceRef,
  VerificationResult,
} from '../schemas/application.js';
import type { ProfileFactsSource } from '../schemas/facts.js';

/**
 * Application persistence port (architecture doc 05 §1). Declared in `core` so
 * both `application-engine` (consumer) and `packages/database` (implementer)
 * depend only on core; the composition roots inject the adapter. No business
 * rules here: atomicity, constraints and locking are persistence concerns.
 */

export interface ApplicationRecord {
  id: string;
  jobId: string;
  candidateId: string;
  applicationTargetId: string | null;
  discoverySourceId: string | null;
  matchId: string;
  mode: ApplicationMode;
  status: ApplicationStatus;
  resumeVersionId: string | null;
  idempotencyKey: string;
  policyVersion: string;
  scoreAtCreation: number;
  preparationSnapshot: unknown | null;
  supersedesApplicationId: string | null;
  submittedAt: Date | null;
  lastTransitionAt: Date;
  requiresHumanReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApplicationEventRecord {
  id: string;
  applicationId: string;
  type: string;
  fromStatus: ApplicationStatus | null;
  toStatus: ApplicationStatus | null;
  actor: ApplicationActor;
  payload: Record<string, unknown>;
  correlationId: string | null;
  occurredAt: Date;
}

export interface ApplicationAnswerRecord {
  id: string;
  applicationId: string;
  questionText: string;
  questionHash: string;
  answerText: string | null;
  answerKind: AnswerKind;
  sourceRefs: SourceRef[];
  claims: Claim[];
  verification: VerificationResult;
  requiresHumanInput: boolean;
  approved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApplicationDocumentRecord {
  id: string;
  applicationId: string;
  kind: ApplicationDocumentKind;
  resumeVersionId: string | null;
  storageKey: string;
  contentHash: string;
  claims: Claim[];
  verification: VerificationResult;
  generatedBy: GeneratedBy;
  createdAt: Date;
}

export interface ResumeVersionRecord {
  id: string;
  resumeId: string;
  candidateId: string;
  versionNumber: number;
  kind: string;
  storageKey: string;
  fileHash: string;
  highlights: Record<string, unknown>;
}

export interface TargetView {
  id: string;
  key: string;
  label: string;
  platform: string;
  status: string;
}

export interface MatchCreationContext {
  matchId: string;
  jobId: string;
  candidateId: string;
  overallScore: number;
  isCurrent: boolean;
  recommendedResumeId: string | null;
  /**
   * Exact version the match used for its recommendation. `null` means the
   * match is legacy/incomplete: creation must fail closed instead of silently
   * substituting the current latest version (Phase 4.1, P4).
   */
  recommendedResumeVersionId: string | null;
  job: JobDocumentView & {
    status: string;
    applicationTargetId: string | null;
    discoverySourceId: string | null;
    applicationTarget: TargetView | null;
  };
  candidate: ProfileFactsSource;
}

export interface CreateApplicationRecordInput {
  id: string;
  jobId: string;
  candidateId: string;
  applicationTargetId: string | null;
  discoverySourceId: string | null;
  matchId: string;
  mode: ApplicationMode;
  resumeVersionId: string | null;
  idempotencyKey: string;
  policyVersion: string;
  scoreAtCreation: number;
  supersedesApplicationId: string | null;
  actor: ApplicationActor;
  correlationId: string | null;
  now: Date;
}

export interface TransitionRecordInput {
  applicationId: string;
  expectedStatus: ApplicationStatus;
  toStatus: ApplicationStatus;
  actor: ApplicationActor;
  eventType: string;
  reason: string | null;
  payload: Record<string, unknown>;
  correlationId: string | null;
  now: Date;
}

export interface AppendEventRecordInput {
  applicationId: string;
  type: string;
  fromStatus: ApplicationStatus | null;
  toStatus: ApplicationStatus | null;
  actor: ApplicationActor;
  payload: Record<string, unknown>;
  correlationId: string | null;
  now: Date;
}

export interface UpsertAnswerRecordInput {
  id: string;
  applicationId: string;
  questionText: string;
  questionHash: string;
  answerText: string | null;
  answerKind: AnswerKind;
  sourceRefs: SourceRef[];
  claims: Claim[];
  verification: VerificationResult;
  requiresHumanInput: boolean;
  approved: boolean;
  now: Date;
}

export interface InsertDocumentRecordInput {
  id: string;
  applicationId: string;
  kind: ApplicationDocumentKind;
  resumeVersionId: string | null;
  storageKey: string;
  contentHash: string;
  claims: Claim[];
  verification: VerificationResult;
  generatedBy: GeneratedBy;
  now: Date;
}

export interface CreateTailoredResumeVersionInput {
  id: string;
  resumeId: string;
  parentVersionId: string;
  storageKey: string;
  fileHash: string;
  highlights: Record<string, unknown>;
  now: Date;
}

export interface AuditRecordInput {
  actor: ApplicationActor;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  correlationId: string | null;
}

export interface ApplicationRepositoryPort {
  getMatchCreationContext(matchId: string): Promise<MatchCreationContext | null>;
  getApplication(id: string): Promise<ApplicationRecord | null>;
  findActiveByJobCandidate(candidateId: string, jobId: string): Promise<ApplicationRecord | null>;
  findApplicationsByJobCandidate(candidateId: string, jobId: string): Promise<ApplicationRecord[]>;
  findByIdempotencyKey(key: string): Promise<ApplicationRecord | null>;
  createWithBootstrap(
    input: CreateApplicationRecordInput,
  ): Promise<{ application: ApplicationRecord; created: boolean }>;
  transitionWithEvent(
    input: TransitionRecordInput,
  ): Promise<{ application: ApplicationRecord; event: ApplicationEventRecord }>;
  appendEvent(input: AppendEventRecordInput): Promise<ApplicationEventRecord>;
  setResumeVersion(applicationId: string, resumeVersionId: string, now: Date): Promise<ApplicationRecord>;
  listEvents(applicationId: string): Promise<ApplicationEventRecord[]>;
  listAnswers(applicationId: string): Promise<ApplicationAnswerRecord[]>;
  listDocuments(applicationId: string): Promise<ApplicationDocumentRecord[]>;
  findApprovedAnswerByQuestionHash(
    candidateId: string,
    questionHash: string,
  ): Promise<ApplicationAnswerRecord | null>;
  upsertAnswer(input: UpsertAnswerRecordInput): Promise<ApplicationAnswerRecord>;
  insertDocument(
    input: InsertDocumentRecordInput,
  ): Promise<{ document: ApplicationDocumentRecord; created: boolean }>;
  findDocumentByInputHash(
    applicationId: string,
    kind: ApplicationDocumentKind,
    inputHash: string,
  ): Promise<ApplicationDocumentRecord | null>;
  getResumeVersion(id: string): Promise<ResumeVersionRecord | null>;
  findTailoredVersionByParentAndHash(
    parentVersionId: string,
    fileHash: string,
  ): Promise<ResumeVersionRecord | null>;
  createTailoredResumeVersion(input: CreateTailoredResumeVersionInput): Promise<ResumeVersionRecord>;
  /**
   * Serializes preparation per application across processes (Postgres advisory
   * lock on a dedicated connection). PostgreSQL stays the idempotency authority.
   */
  withApplicationLock<T>(applicationId: string, fn: () => Promise<T>): Promise<T>;
  appendAudit(entry: AuditRecordInput): Promise<void>;
}
