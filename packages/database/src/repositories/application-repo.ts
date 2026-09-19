import { and, asc, desc, eq, notInArray, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  ClaimSchema,
  ConflictError,
  GeneratedBySchema,
  NotFoundError,
  ProfileFactsSourceSchema,
  SourceRefSchema,
  VerificationResultSchema,
  type ApplicationActor,
  type ApplicationDocumentKind,
  type ApplicationMode,
  type ApplicationRepositoryPort,
  type ApplicationStatus,
  type AnswerKind,
  type Claim,
  type GeneratedBy,
  type ProfileFactsSource,
  type SourceRef,
  type VerificationResult,
} from '@job-system/core';
import { uuidv7 } from '@job-system/shared';
import { z } from 'zod';
import type { Db } from '../client.js';
import * as t from '../schema.js';

/**
 * Application persistence (Phase 4). No business rules here: the engine owns
 * transitions/guards; this repo owns atomicity (event + status in one tx),
 * compare-and-set concurrency, idempotency constraints and the preparation
 * advisory lock.
 */

export interface ApplicationRecordData {
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

export interface ApplicationEventData {
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

export interface ApplicationAnswerData {
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

export interface ApplicationDocumentData {
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

export interface ResumeVersionData {
  id: string;
  resumeId: string;
  candidateId: string;
  versionNumber: number;
  kind: string;
  storageKey: string;
  fileHash: string;
  highlights: Record<string, unknown>;
}

export interface TargetData {
  id: string;
  key: string;
  label: string;
  platform: string;
  status: string;
}

export interface MatchCreationContextData {
  matchId: string;
  jobId: string;
  candidateId: string;
  overallScore: number;
  isCurrent: boolean;
  recommendedResumeId: string | null;
  recommendedResumeVersionId: string | null;
  job: {
    id: string;
    title: string;
    company: string;
    description: string;
    location: string | null;
    remoteType: string | null;
    employmentType: string | null;
    requiredSkills: string[];
    preferredSkills: string[];
    languageRequirements: string[];
    status: string;
    applicationTargetId: string | null;
    discoverySourceId: string | null;
    applicationTarget: TargetData | null;
  };
  candidate: ProfileFactsSource;
}

export interface CreateApplicationData {
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

export interface TransitionApplicationData {
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

export interface AppendEventData {
  applicationId: string;
  type: string;
  fromStatus: ApplicationStatus | null;
  toStatus: ApplicationStatus | null;
  actor: ApplicationActor;
  payload: Record<string, unknown>;
  correlationId: string | null;
  now: Date;
}

export interface UpsertAnswerData {
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

export interface InsertDocumentData {
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

export interface CreateTailoredVersionData {
  id: string;
  resumeId: string;
  parentVersionId: string;
  storageKey: string;
  fileHash: string;
  highlights: Record<string, unknown>;
  now: Date;
}

export interface AppendAuditData {
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  correlationId: string | null;
}

export interface ApplicationWithJob {
  application: ApplicationRecordData;
  job: t.JobRow;
  resumeName: string | null;
  target: { key: string; label: string; platform: string; status: string } | null;
}

const claimListSchema = z.array(ClaimSchema);
const sourceRefListSchema = z.array(SourceRefSchema);

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

function toApplicationRecord(row: t.ApplicationRow): ApplicationRecordData {
  return {
    id: row.id,
    jobId: row.jobId,
    candidateId: row.candidateId,
    applicationTargetId: row.applicationTargetId,
    discoverySourceId: row.discoverySourceId,
    matchId: row.matchId,
    mode: row.mode as ApplicationMode,
    status: row.status as ApplicationStatus,
    resumeVersionId: row.resumeVersionId,
    idempotencyKey: row.idempotencyKey,
    policyVersion: row.policyVersion,
    scoreAtCreation: Number(row.scoreAtCreation),
    preparationSnapshot: row.preparationSnapshot ?? null,
    supersedesApplicationId: row.supersedesApplicationId,
    submittedAt: row.submittedAt,
    lastTransitionAt: row.lastTransitionAt,
    requiresHumanReason: row.requiresHumanReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEventRecord(row: t.ApplicationEventRow): ApplicationEventData {
  return {
    id: row.id,
    applicationId: row.applicationId,
    type: row.type,
    fromStatus: (row.fromStatus as ApplicationStatus | null) ?? null,
    toStatus: (row.toStatus as ApplicationStatus | null) ?? null,
    actor: row.actor as ApplicationActor,
    payload: (row.payload as Record<string, unknown> | null) ?? {},
    correlationId: row.correlationId,
    occurredAt: row.occurredAt,
  };
}

function toAnswerRecord(row: t.ApplicationAnswerRow): ApplicationAnswerData {
  return {
    id: row.id,
    applicationId: row.applicationId,
    questionText: row.questionText,
    questionHash: row.questionHash,
    answerText: row.answerText,
    answerKind: row.answerKind as AnswerKind,
    sourceRefs: sourceRefListSchema.parse(row.sourceRefs),
    claims: claimListSchema.parse(row.claims),
    verification: VerificationResultSchema.parse(row.verification),
    requiresHumanInput: row.requiresHumanInput,
    approved: row.approved,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDocumentRecord(row: t.ApplicationDocumentRow): ApplicationDocumentData {
  return {
    id: row.id,
    applicationId: row.applicationId,
    kind: row.kind as ApplicationDocumentKind,
    resumeVersionId: row.resumeVersionId,
    storageKey: row.storageKey,
    contentHash: row.contentHash,
    claims: claimListSchema.parse(row.claims),
    verification: VerificationResultSchema.parse(row.verification),
    generatedBy: GeneratedBySchema.parse(row.generatedBy),
    createdAt: row.createdAt,
  };
}

export function createApplicationRepo(db: Db, pool: Pool) {
  const repo = {
    /* --------------------------- creation context -------------------------- */

    async getMatchCreationContext(matchId: string): Promise<MatchCreationContextData | null> {
      const [matchRow] = await db
        .select()
        .from(t.jobMatch)
        .where(eq(t.jobMatch.id, matchId))
        .limit(1);
      if (!matchRow) return null;
      const [jobRow] = await db.select().from(t.job).where(eq(t.job.id, matchRow.jobId)).limit(1);
      if (!jobRow) return null;

      let discoverySourceId: string | null = null;
      if (jobRow.primaryListingId !== null) {
        const [listing] = await db
          .select({ sourceId: t.jobListing.sourceId })
          .from(t.jobListing)
          .where(eq(t.jobListing.id, jobRow.primaryListingId))
          .limit(1);
        discoverySourceId = listing?.sourceId ?? null;
      }

      let applicationTarget: TargetData | null = null;
      if (jobRow.applicationTargetId !== null) {
        const [target] = await db
          .select()
          .from(t.applicationTarget)
          .where(eq(t.applicationTarget.id, jobRow.applicationTargetId))
          .limit(1);
        if (target) {
          applicationTarget = {
            id: target.id,
            key: target.key,
            label: target.label,
            platform: target.platform,
            status: target.status,
          };
        }
      }

      const breakdown = (matchRow.scoreBreakdown ?? {}) as {
        resumeSelection?: { recommendedResumeVersionId?: unknown };
      };
      const recommendedResumeVersionId =
        typeof breakdown.resumeSelection?.recommendedResumeVersionId === 'string'
          ? breakdown.resumeSelection.recommendedResumeVersionId
          : null;

      const candidate = await loadProfileFactsSource(db, matchRow.candidateId);

      return {
        matchId: matchRow.id,
        jobId: jobRow.id,
        candidateId: matchRow.candidateId,
        overallScore: Number(matchRow.overallScore),
        isCurrent: matchRow.isCurrent,
        recommendedResumeId: matchRow.recommendedResumeId,
        recommendedResumeVersionId,
        job: {
          id: jobRow.id,
          title: jobRow.title,
          company: jobRow.company,
          description: jobRow.description,
          location: jobRow.location,
          remoteType: jobRow.remoteType,
          employmentType: jobRow.employmentType,
          requiredSkills: [...jobRow.requiredSkills],
          preferredSkills: [...jobRow.preferredSkills],
          languageRequirements: [...jobRow.languageRequirements],
          status: jobRow.status,
          applicationTargetId: jobRow.applicationTargetId,
          discoverySourceId,
          applicationTarget,
        },
        candidate,
      };
    },

    /* ----------------------------- application ----------------------------- */

    async getApplication(id: string): Promise<ApplicationRecordData | null> {
      const [row] = await db.select().from(t.application).where(eq(t.application.id, id)).limit(1);
      return row ? toApplicationRecord(row) : null;
    },

    async findActiveByJobCandidate(
      candidateId: string,
      jobId: string,
    ): Promise<ApplicationRecordData | null> {
      const [row] = await db
        .select()
        .from(t.application)
        .where(
          and(
            eq(t.application.candidateId, candidateId),
            eq(t.application.jobId, jobId),
            notInArray(t.application.status, ['ARCHIVED', 'REJECTED']),
          ),
        )
        .limit(1);
      return row ? toApplicationRecord(row) : null;
    },

    async findApplicationsByJobCandidate(
      candidateId: string,
      jobId: string,
    ): Promise<ApplicationRecordData[]> {
      const rows = await db
        .select()
        .from(t.application)
        .where(and(eq(t.application.candidateId, candidateId), eq(t.application.jobId, jobId)))
        .orderBy(desc(t.application.createdAt));
      return rows.map(toApplicationRecord);
    },

    async findByIdempotencyKey(key: string): Promise<ApplicationRecordData | null> {
      const [row] = await db
        .select()
        .from(t.application)
        .where(eq(t.application.idempotencyKey, key))
        .limit(1);
      return row ? toApplicationRecord(row) : null;
    },

    /**
     * Atomic bootstrap: INSERT + created event + DISCOVERED→FILTERED→SHORTLISTED
     * events, all in one transaction (task §27). Idempotent by key and by the
     * active partial unique; concurrency serialized per (candidate, job).
     */
    async createWithBootstrap(
      input: CreateApplicationData,
    ): Promise<{ application: ApplicationRecordData; created: boolean }> {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`application-create:${input.candidateId}|${input.jobId}`}))`,
        );
        const [existing] = await tx
          .select()
          .from(t.application)
          .where(eq(t.application.idempotencyKey, input.idempotencyKey))
          .limit(1);
        if (existing) return { application: toApplicationRecord(existing), created: false };

        const [inserted] = await tx
          .insert(t.application)
          .values({
            id: input.id,
            jobId: input.jobId,
            candidateId: input.candidateId,
            applicationTargetId: input.applicationTargetId,
            discoverySourceId: input.discoverySourceId,
            matchId: input.matchId,
            mode: input.mode,
            status: 'DISCOVERED',
            resumeVersionId: input.resumeVersionId,
            idempotencyKey: input.idempotencyKey,
            policyVersion: input.policyVersion,
            scoreAtCreation: input.scoreAtCreation.toFixed(4),
            supersedesApplicationId: input.supersedesApplicationId,
            lastTransitionAt: input.now,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) {
          const [byKey] = await tx
            .select()
            .from(t.application)
            .where(eq(t.application.idempotencyKey, input.idempotencyKey))
            .limit(1);
          if (byKey) return { application: toApplicationRecord(byKey), created: false };
          throw new ConflictError(
            'An active application already exists for this candidate and canonical job',
            { context: { candidateId: input.candidateId, jobId: input.jobId } },
          );
        }

        await tx.insert(t.applicationEvent).values([
          {
            id: uuidv7(input.now.getTime()),
            applicationId: inserted.id,
            type: 'application.created',
            fromStatus: null,
            toStatus: 'DISCOVERED',
            actor: input.actor,
            payload: { mode: input.mode, matchId: input.matchId, jobId: input.jobId },
            correlationId: input.correlationId,
            occurredAt: input.now,
          },
          {
            id: uuidv7(input.now.getTime() + 1),
            applicationId: inserted.id,
            type: 'application.status_changed',
            fromStatus: 'DISCOVERED',
            toStatus: 'FILTERED',
            actor: 'system',
            payload: { from: 'DISCOVERED', to: 'FILTERED', actor: 'system' },
            correlationId: input.correlationId,
            occurredAt: input.now,
          },
          {
            id: uuidv7(input.now.getTime() + 2),
            applicationId: inserted.id,
            type: 'application.status_changed',
            fromStatus: 'FILTERED',
            toStatus: 'SHORTLISTED',
            actor: 'system',
            payload: { from: 'FILTERED', to: 'SHORTLISTED', actor: 'system' },
            correlationId: input.correlationId,
            occurredAt: input.now,
          },
        ]);
        const [updated] = await tx
          .update(t.application)
          .set({ status: 'SHORTLISTED', updatedAt: input.now })
          .where(eq(t.application.id, inserted.id))
          .returning();
        return { application: toApplicationRecord(updated!), created: true };
      });
    },

    /** Status + event in the SAME transaction; compare-and-set on status. */
    async transitionWithEvent(
      input: TransitionApplicationData,
    ): Promise<{ application: ApplicationRecordData; event: ApplicationEventData }> {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(t.application)
          .where(eq(t.application.id, input.applicationId))
          .limit(1);
        if (!current) throw new NotFoundError(`Application not found: ${input.applicationId}`);
        if (current.status !== input.expectedStatus) {
          throw new ConflictError(
            `Application status changed concurrently (expected ${input.expectedStatus}, found ${current.status})`,
            { context: { applicationId: input.applicationId, expected: input.expectedStatus, found: current.status } },
          );
        }
        const [updated] = await tx
          .update(t.application)
          .set({
            status: input.toStatus,
            lastTransitionAt: input.now,
            updatedAt: input.now,
            requiresHumanReason: input.toStatus === 'REQUIRES_HUMAN_ACTION' ? input.reason : null,
            ...(input.toStatus === 'SUBMITTED' ? { submittedAt: input.now } : {}),
          })
          .where(and(eq(t.application.id, input.applicationId), eq(t.application.status, input.expectedStatus)))
          .returning();
        if (!updated) {
          throw new ConflictError('Application status changed concurrently', {
            context: { applicationId: input.applicationId },
          });
        }
        const [event] = await tx
          .insert(t.applicationEvent)
          .values({
            id: uuidv7(),
            applicationId: input.applicationId,
            type: input.eventType,
            fromStatus: input.expectedStatus,
            toStatus: input.toStatus,
            actor: input.actor,
            payload: input.payload,
            correlationId: input.correlationId,
            occurredAt: input.now,
          })
          .returning();
        return { application: toApplicationRecord(updated), event: toEventRecord(event!) };
      });
    },

    async appendEvent(input: AppendEventData): Promise<ApplicationEventData> {
      const [row] = await db
        .insert(t.applicationEvent)
        .values({
          id: uuidv7(),
          applicationId: input.applicationId,
          type: input.type,
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          actor: input.actor,
          payload: input.payload,
          correlationId: input.correlationId,
          occurredAt: input.now,
        })
        .returning();
      return toEventRecord(row!);
    },

    async setResumeVersion(
      applicationId: string,
      resumeVersionId: string,
      now: Date,
    ): Promise<ApplicationRecordData> {
      const [row] = await db
        .update(t.application)
        .set({ resumeVersionId, updatedAt: now })
        .where(eq(t.application.id, applicationId))
        .returning();
      if (!row) throw new NotFoundError(`Application not found: ${applicationId}`);
      return toApplicationRecord(row);
    },

    async listEvents(applicationId: string): Promise<ApplicationEventData[]> {
      const rows = await db
        .select()
        .from(t.applicationEvent)
        .where(eq(t.applicationEvent.applicationId, applicationId))
        .orderBy(asc(t.applicationEvent.occurredAt), asc(t.applicationEvent.id));
      return rows.map(toEventRecord);
    },

    /* ------------------------------- answers ------------------------------- */

    async listAnswers(applicationId: string): Promise<ApplicationAnswerData[]> {
      const rows = await db
        .select()
        .from(t.applicationAnswer)
        .where(eq(t.applicationAnswer.applicationId, applicationId))
        .orderBy(asc(t.applicationAnswer.createdAt));
      return rows.map(toAnswerRecord);
    },

    async findApprovedAnswerByQuestionHash(
      candidateId: string,
      questionHash: string,
    ): Promise<ApplicationAnswerData | null> {
      const [row] = await db
        .select({ answer: t.applicationAnswer })
        .from(t.applicationAnswer)
        .innerJoin(t.application, eq(t.applicationAnswer.applicationId, t.application.id))
        .where(
          and(
            eq(t.application.candidateId, candidateId),
            eq(t.applicationAnswer.questionHash, questionHash),
            eq(t.applicationAnswer.approved, true),
          ),
        )
        .orderBy(desc(t.applicationAnswer.updatedAt))
        .limit(1);
      return row ? toAnswerRecord(row.answer) : null;
    },

    async upsertAnswer(input: UpsertAnswerData): Promise<ApplicationAnswerData> {
      const [row] = await db
        .insert(t.applicationAnswer)
        .values({
          id: input.id,
          applicationId: input.applicationId,
          questionText: input.questionText,
          questionHash: input.questionHash,
          answerText: input.answerText,
          answerKind: input.answerKind,
          sourceRefs: input.sourceRefs,
          claims: input.claims,
          verification: input.verification,
          requiresHumanInput: input.requiresHumanInput,
          approved: input.approved,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [t.applicationAnswer.applicationId, t.applicationAnswer.questionHash],
          set: {
            answerText: input.answerText,
            answerKind: input.answerKind,
            sourceRefs: input.sourceRefs,
            claims: input.claims,
            verification: input.verification,
            requiresHumanInput: input.requiresHumanInput,
            approved: input.approved,
            updatedAt: input.now,
          },
        })
        .returning();
      return toAnswerRecord(row!);
    },

    /* ------------------------------ documents ------------------------------ */

    async listDocuments(applicationId: string): Promise<ApplicationDocumentData[]> {
      const rows = await db
        .select()
        .from(t.applicationDocument)
        .where(eq(t.applicationDocument.applicationId, applicationId))
        .orderBy(asc(t.applicationDocument.createdAt));
      return rows.map(toDocumentRecord);
    },

    /** Append-only insert; same bytes ⇒ reuse the existing row (no duplicate). */
    async insertDocument(
      input: InsertDocumentData,
    ): Promise<{ document: ApplicationDocumentData; created: boolean }> {
      const [inserted] = await db
        .insert(t.applicationDocument)
        .values({
          id: input.id,
          applicationId: input.applicationId,
          kind: input.kind,
          resumeVersionId: input.resumeVersionId,
          storageKey: input.storageKey,
          contentHash: input.contentHash,
          claims: input.claims,
          verification: input.verification,
          generatedBy: input.generatedBy,
          createdAt: input.now,
        })
        .onConflictDoNothing({
          target: [
            t.applicationDocument.applicationId,
            t.applicationDocument.kind,
            t.applicationDocument.contentHash,
          ],
        })
        .returning();
      if (inserted) return { document: toDocumentRecord(inserted), created: true };
      const [existing] = await db
        .select()
        .from(t.applicationDocument)
        .where(
          and(
            eq(t.applicationDocument.applicationId, input.applicationId),
            eq(t.applicationDocument.kind, input.kind),
            eq(t.applicationDocument.contentHash, input.contentHash),
          ),
        )
        .limit(1);
      if (!existing) throw new ConflictError('Document insert conflicted but no existing row was found');
      return { document: toDocumentRecord(existing), created: false };
    },

    async findDocumentByInputHash(
      applicationId: string,
      kind: ApplicationDocumentKind,
      inputHash: string,
    ): Promise<ApplicationDocumentData | null> {
      const [row] = await db
        .select()
        .from(t.applicationDocument)
        .where(
          and(
            eq(t.applicationDocument.applicationId, applicationId),
            eq(t.applicationDocument.kind, kind),
            sql`${t.applicationDocument.generatedBy}->>'inputHash' = ${inputHash}`,
          ),
        )
        .orderBy(desc(t.applicationDocument.createdAt))
        .limit(1);
      return row ? toDocumentRecord(row) : null;
    },

    /* --------------------------- resume versions --------------------------- */

    async getResumeVersion(id: string): Promise<ResumeVersionData | null> {
      const [row] = await db
        .select({ version: t.resumeVersion, candidateId: t.resume.candidateId })
        .from(t.resumeVersion)
        .innerJoin(t.resume, eq(t.resumeVersion.resumeId, t.resume.id))
        .where(eq(t.resumeVersion.id, id))
        .limit(1);
      if (!row) return null;
      return {
        id: row.version.id,
        resumeId: row.version.resumeId,
        candidateId: row.candidateId,
        versionNumber: row.version.versionNumber,
        kind: row.version.kind,
        storageKey: row.version.storageKey,
        fileHash: row.version.fileHash,
        highlights: (row.version.highlights as Record<string, unknown> | null) ?? {},
      };
    },

    async findTailoredVersionByParentAndHash(
      parentVersionId: string,
      fileHash: string,
    ): Promise<ResumeVersionData | null> {
      const [row] = await db
        .select({ version: t.resumeVersion, candidateId: t.resume.candidateId })
        .from(t.resumeVersion)
        .innerJoin(t.resume, eq(t.resumeVersion.resumeId, t.resume.id))
        .where(
          and(
            eq(t.resumeVersion.parentVersionId, parentVersionId),
            eq(t.resumeVersion.fileHash, fileHash),
            eq(t.resumeVersion.kind, 'tailored'),
          ),
        )
        .orderBy(asc(t.resumeVersion.versionNumber))
        .limit(1);
      if (!row) return null;
      return {
        id: row.version.id,
        resumeId: row.version.resumeId,
        candidateId: row.candidateId,
        versionNumber: row.version.versionNumber,
        kind: row.version.kind,
        storageKey: row.version.storageKey,
        fileHash: row.version.fileHash,
        highlights: (row.version.highlights as Record<string, unknown> | null) ?? {},
      };
    },

    /**
     * Tailored version creation. The unique (resume_id, version_number) plus the
     * deterministic fileHash reuse in the engine prevent duplicates; a retry
     * covers concurrent version numbering.
     */
    async createTailoredResumeVersion(input: CreateTailoredVersionData): Promise<ResumeVersionData> {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await db.transaction(async (tx) => {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${`resume-version:${input.resumeId}`}))`,
            );
            const existing = await tx
              .select({ version: t.resumeVersion, candidateId: t.resume.candidateId })
              .from(t.resumeVersion)
              .innerJoin(t.resume, eq(t.resumeVersion.resumeId, t.resume.id))
              .where(
                and(
                  eq(t.resumeVersion.parentVersionId, input.parentVersionId),
                  eq(t.resumeVersion.fileHash, input.fileHash),
                  eq(t.resumeVersion.kind, 'tailored'),
                ),
              )
              .limit(1);
            if (existing[0]) {
              return {
                id: existing[0].version.id,
                resumeId: existing[0].version.resumeId,
                candidateId: existing[0].candidateId,
                versionNumber: existing[0].version.versionNumber,
                kind: existing[0].version.kind,
                storageKey: existing[0].version.storageKey,
                fileHash: existing[0].version.fileHash,
                highlights: (existing[0].version.highlights as Record<string, unknown> | null) ?? {},
              };
            }
            const [latest] = await tx
              .select({ versionNumber: t.resumeVersion.versionNumber })
              .from(t.resumeVersion)
              .where(eq(t.resumeVersion.resumeId, input.resumeId))
              .orderBy(desc(t.resumeVersion.versionNumber))
              .limit(1);
            const next = (latest?.versionNumber ?? 0) + 1;
            const [row] = await tx
              .insert(t.resumeVersion)
              .values({
                id: input.id,
                resumeId: input.resumeId,
                versionNumber: next,
                parentVersionId: input.parentVersionId,
                kind: 'tailored',
                storageKey: input.storageKey,
                fileHash: input.fileHash,
                highlights: input.highlights,
                createdAt: input.now,
              })
              .returning();
            const [resumeRow] = await tx
              .select({ candidateId: t.resume.candidateId })
              .from(t.resume)
              .where(eq(t.resume.id, input.resumeId))
              .limit(1);
            return {
              id: row!.id,
              resumeId: row!.resumeId,
              candidateId: resumeRow?.candidateId ?? '',
              versionNumber: row!.versionNumber,
              kind: row!.kind,
              storageKey: row!.storageKey,
              fileHash: row!.fileHash,
              highlights: (row!.highlights as Record<string, unknown> | null) ?? {},
            };
          });
        } catch (error) {
          if (isUniqueViolation(error) && attempt < 2) continue;
          throw error;
        }
      }
      throw new ConflictError('Could not create the tailored resume version after retries');
    },

    /* ------------------------------- locking ------------------------------- */

    /**
     * Serializes preparation per application across processes. Uses a session
     * advisory lock on a dedicated pooled client (never a long transaction);
     * PostgreSQL remains the idempotency authority.
     */
    async withApplicationLock<T>(applicationId: string, fn: () => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const key = `application-prepare:${applicationId}`;
      try {
        await client.query('select pg_advisory_lock(hashtext($1))', [key]);
        return await fn();
      } finally {
        try {
          await client.query('select pg_advisory_unlock(hashtext($1))', [key]);
        } finally {
          client.release();
        }
      }
    },

    /* -------------------------------- audit -------------------------------- */

    async appendAudit(entry: AppendAuditData): Promise<void> {
      await db.insert(t.auditLog).values({
        id: uuidv7(),
        actor: entry.actor,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.before ?? null,
        after: entry.after ?? null,
        correlationId: entry.correlationId,
      });
    },

    /* ------------------------------ API reads ------------------------------ */

    async listWithJob(options: {
      limit: number;
      offset: number;
      status?: ApplicationStatus;
    }): Promise<ApplicationWithJob[]> {
      const conditions =
        options.status === undefined ? [] : [eq(t.application.status, options.status)];
      const rows = await db
        .select({
          application: t.application,
          job: t.job,
          resumeName: t.resume.name,
          targetKey: t.applicationTarget.key,
          targetLabel: t.applicationTarget.label,
          targetPlatform: t.applicationTarget.platform,
          targetStatus: t.applicationTarget.status,
        })
        .from(t.application)
        .innerJoin(t.job, eq(t.application.jobId, t.job.id))
        .leftJoin(t.resumeVersion, eq(t.application.resumeVersionId, t.resumeVersion.id))
        .leftJoin(t.resume, eq(t.resumeVersion.resumeId, t.resume.id))
        .leftJoin(t.applicationTarget, eq(t.job.applicationTargetId, t.applicationTarget.id))
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(desc(t.application.updatedAt))
        .limit(options.limit)
        .offset(options.offset);
      return rows.map((row) => ({
        application: toApplicationRecord(row.application),
        job: row.job,
        resumeName: row.resumeName,
        target:
          row.targetKey === null
            ? null
            : {
                key: row.targetKey,
                label: row.targetLabel ?? row.targetKey,
                platform: row.targetPlatform ?? 'unknown',
                status: row.targetStatus ?? 'unknown',
              },
      }));
    },

    async countApplications(status?: ApplicationStatus): Promise<number> {
      const rows = await db
        .select({ id: t.application.id })
        .from(t.application)
        .where(status === undefined ? undefined : eq(t.application.status, status));
      return rows.length;
    },

    async getWithJob(id: string): Promise<ApplicationWithJob | null> {
      const [row] = await db
        .select({
          application: t.application,
          job: t.job,
          resumeName: t.resume.name,
          targetKey: t.applicationTarget.key,
          targetLabel: t.applicationTarget.label,
          targetPlatform: t.applicationTarget.platform,
          targetStatus: t.applicationTarget.status,
        })
        .from(t.application)
        .innerJoin(t.job, eq(t.application.jobId, t.job.id))
        .leftJoin(t.resumeVersion, eq(t.application.resumeVersionId, t.resumeVersion.id))
        .leftJoin(t.resume, eq(t.resumeVersion.resumeId, t.resume.id))
        .leftJoin(t.applicationTarget, eq(t.job.applicationTargetId, t.applicationTarget.id))
        .where(eq(t.application.id, id))
        .limit(1);
      if (!row) return null;
      return {
        application: toApplicationRecord(row.application),
        job: row.job,
        resumeName: row.resumeName,
        target:
          row.targetKey === null
            ? null
            : {
                key: row.targetKey,
                label: row.targetLabel ?? row.targetKey,
                platform: row.targetPlatform ?? 'unknown',
                status: row.targetStatus ?? 'unknown',
              },
      };
    },

    async listAnswersForCandidateQuestion(
      candidateId: string,
      questionHash: string,
    ): Promise<ApplicationAnswerData[]> {
      const rows = await db
        .select({ answer: t.applicationAnswer })
        .from(t.applicationAnswer)
        .innerJoin(t.application, eq(t.applicationAnswer.applicationId, t.application.id))
        .where(
          and(
            eq(t.application.candidateId, candidateId),
            eq(t.applicationAnswer.questionHash, questionHash),
          ),
        )
        .orderBy(desc(t.applicationAnswer.updatedAt));
      return rows.map((row) => toAnswerRecord(row.answer));
    },
  };

  return repo;
}

/** Profile facts source for documents/AI (validated at the DB boundary). */
export async function loadProfileFactsSource(
  db: Db,
  candidateId: string,
): Promise<ProfileFactsSource> {
  const [profile] = await db
    .select()
    .from(t.candidateProfile)
    .where(eq(t.candidateProfile.id, candidateId))
    .limit(1);
  if (!profile) throw new NotFoundError(`Candidate profile not found: ${candidateId}`);
  const skills = await db
    .select({
      id: t.candidateSkill.id,
      name: t.skill.canonicalName,
      aliases: t.skill.aliases,
      level: t.candidateSkill.level,
      years: t.candidateSkill.years,
    })
    .from(t.candidateSkill)
    .innerJoin(t.skill, eq(t.candidateSkill.skillId, t.skill.id))
    .where(eq(t.candidateSkill.candidateId, candidateId))
    .orderBy(asc(t.skill.canonicalName));
  const experiences = await db
    .select()
    .from(t.experience)
    .where(eq(t.experience.candidateId, candidateId))
    .orderBy(desc(t.experience.startDate));
  const education = await db
    .select()
    .from(t.education)
    .where(eq(t.education.candidateId, candidateId))
    .orderBy(asc(t.education.degree));
  const languages = await db
    .select()
    .from(t.candidateLanguage)
    .where(eq(t.candidateLanguage.candidateId, candidateId))
    .orderBy(asc(t.candidateLanguage.language));
  return ProfileFactsSourceSchema.parse({
    profile: {
      id: profile.id,
      fullName: profile.fullName,
      headline: profile.headline,
      salaryMin: profile.salaryMin,
      salaryMax: profile.salaryMax,
      salaryCurrency: profile.salaryCurrency,
    },
    skills: skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      aliases: [...skill.aliases],
      level: skill.level,
      years: skill.years === null ? null : Number(skill.years),
    })),
    experiences: experiences.map((experience) => ({
      id: experience.id,
      company: experience.company,
      title: experience.title,
      startDate: experience.startDate,
      endDate: experience.endDate,
      skills: [...experience.skills],
    })),
    education: education.map((entry) => ({
      id: entry.id,
      institution: entry.institution,
      degree: entry.degree,
      field: entry.field,
      startDate: entry.startDate,
      endDate: entry.endDate,
      status: entry.status,
    })),
    languages: languages.map((language) => ({
      id: language.id,
      language: language.language,
      level: language.level,
    })),
  });
}

export type ApplicationRepo = ReturnType<typeof createApplicationRepo>;

/**
 * Adapts the Drizzle repo to the `core` port consumed by `application-engine`.
 * Structural typing keeps both sides honest: a port change breaks this file at
 * typecheck time.
 */
export function createApplicationRepositoryPort(repo: ApplicationRepo): ApplicationRepositoryPort {
  return {
    getMatchCreationContext: (matchId) => repo.getMatchCreationContext(matchId),
    getApplication: (id) => repo.getApplication(id),
    findActiveByJobCandidate: (candidateId, jobId) =>
      repo.findActiveByJobCandidate(candidateId, jobId),
    findApplicationsByJobCandidate: (candidateId, jobId) =>
      repo.findApplicationsByJobCandidate(candidateId, jobId),
    findByIdempotencyKey: (key) => repo.findByIdempotencyKey(key),
    createWithBootstrap: (input) => repo.createWithBootstrap(input),
    transitionWithEvent: (input) => repo.transitionWithEvent(input),
    appendEvent: (input) => repo.appendEvent(input),
    setResumeVersion: (applicationId, resumeVersionId, now) =>
      repo.setResumeVersion(applicationId, resumeVersionId, now),
    listEvents: (applicationId) => repo.listEvents(applicationId),
    listAnswers: (applicationId) => repo.listAnswers(applicationId),
    listDocuments: (applicationId) => repo.listDocuments(applicationId),
    findApprovedAnswerByQuestionHash: (candidateId, questionHash) =>
      repo.findApprovedAnswerByQuestionHash(candidateId, questionHash),
    upsertAnswer: (input) => repo.upsertAnswer(input),
    insertDocument: (input) => repo.insertDocument(input),
    findDocumentByInputHash: (applicationId, kind, inputHash) =>
      repo.findDocumentByInputHash(applicationId, kind, inputHash),
    getResumeVersion: (id) => repo.getResumeVersion(id),
    findTailoredVersionByParentAndHash: (parentVersionId, fileHash) =>
      repo.findTailoredVersionByParentAndHash(parentVersionId, fileHash),
    createTailoredResumeVersion: (input) => repo.createTailoredResumeVersion(input),
    withApplicationLock: (applicationId, fn) => repo.withApplicationLock(applicationId, fn),
    appendAudit: (entry) =>
      repo.appendAudit({
        actor: entry.actor,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.before ?? null,
        after: entry.after ?? null,
        correlationId: entry.correlationId,
      }),
  };
}
