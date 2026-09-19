import type {
  ApplicationDocumentRecord,
  ApplicationEventRecord,
  ApplicationRepositoryPort,
  ApplicationAnswerRecord,
  ApplicationRecord,
  CreateApplicationRecordInput,
  MatchCreationContext,
  ResumeVersionRecord,
} from '@job-system/core';
import { uuidv7 } from '@job-system/shared';

/**
 * In-memory repository for engine unit tests. Mirrors the persistence contract
 * (atomic bootstrap, compare-and-set transitions, idempotency, append-only
 * documents) without Postgres; integration tests cover the real constraints.
 */
export interface InMemoryRepoOptions {
  match: MatchCreationContext;
  /** Additional matches (recompute/history scenarios). */
  matches?: MatchCreationContext[];
  resumeVersions?: ResumeVersionRecord[];
}

export function createInMemoryRepo(options: InMemoryRepoOptions): {
  repo: ApplicationRepositoryPort;
  state: {
    applications: ApplicationRecord[];
    events: ApplicationEventRecord[];
    answers: ApplicationAnswerRecord[];
    documents: ApplicationDocumentRecord[];
    resumeVersions: ResumeVersionRecord[];
    audits: Array<{ action: string; entityId: string }>;
  };
} {
  const state = {
    applications: [] as ApplicationRecord[],
    events: [] as ApplicationEventRecord[],
    answers: [] as ApplicationAnswerRecord[],
    documents: [] as ApplicationDocumentRecord[],
    resumeVersions: [...(options.resumeVersions ?? [])],
    audits: [] as Array<{ action: string; entityId: string }>,
  };
  const matches = new Map<string, MatchCreationContext>([
    [options.match.matchId, options.match],
    ...(options.matches ?? []).map(
      (match) => [match.matchId, match] as [string, MatchCreationContext],
    ),
  ]);

  function event(
    applicationId: string,
    type: string,
    fromStatus: ApplicationRecord['status'] | null,
    toStatus: ApplicationRecord['status'] | null,
    actor: 'system' | 'user',
    payload: Record<string, unknown>,
    now: Date,
  ): ApplicationEventRecord {
    const record: ApplicationEventRecord = {
      id: uuidv7(),
      applicationId,
      type,
      fromStatus,
      toStatus,
      actor,
      payload,
      correlationId: null,
      occurredAt: now,
    };
    state.events.push(record);
    return record;
  }

  const repo: ApplicationRepositoryPort = {
    async getMatchCreationContext(matchId) {
      return matches.get(matchId) ?? null;
    },
    async getApplication(id) {
      return state.applications.find((application) => application.id === id) ?? null;
    },
    async findActiveByJobCandidate(candidateId, jobId) {
      return (
        state.applications.find(
          (application) =>
            application.candidateId === candidateId &&
            application.jobId === jobId &&
            application.status !== 'ARCHIVED' &&
            application.status !== 'REJECTED',
        ) ?? null
      );
    },
    async findApplicationsByJobCandidate(candidateId, jobId) {
      return state.applications.filter(
        (application) => application.candidateId === candidateId && application.jobId === jobId,
      );
    },
    async findByIdempotencyKey(key) {
      return state.applications.find((application) => application.idempotencyKey === key) ?? null;
    },
    async createWithBootstrap(input: CreateApplicationRecordInput) {
      const existing = state.applications.find(
        (application) => application.idempotencyKey === input.idempotencyKey,
      );
      if (existing) return { application: existing, created: false };
      const active = state.applications.find(
        (application) =>
          application.candidateId === input.candidateId &&
          application.jobId === input.jobId &&
          application.status !== 'ARCHIVED' &&
          application.status !== 'REJECTED',
      );
      if (active) throw new Error('active application exists');
      const application: ApplicationRecord = {
        id: input.id,
        jobId: input.jobId,
        candidateId: input.candidateId,
        applicationTargetId: input.applicationTargetId,
        discoverySourceId: input.discoverySourceId,
        matchId: input.matchId,
        mode: input.mode,
        status: 'SHORTLISTED',
        resumeVersionId: input.resumeVersionId,
        idempotencyKey: input.idempotencyKey,
        policyVersion: input.policyVersion,
        scoreAtCreation: input.scoreAtCreation,
        preparationSnapshot: null,
        supersedesApplicationId: input.supersedesApplicationId,
        submittedAt: null,
        lastTransitionAt: input.now,
        requiresHumanReason: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      state.applications.push(application);
      event(application.id, 'application.created', null, 'DISCOVERED', input.actor, {}, input.now);
      event(application.id, 'application.status_changed', 'DISCOVERED', 'FILTERED', 'system', {}, input.now);
      event(application.id, 'application.status_changed', 'FILTERED', 'SHORTLISTED', 'system', {}, input.now);
      return { application, created: true };
    },
    async transitionWithEvent(input) {
      const index = state.applications.findIndex((application) => application.id === input.applicationId);
      const current = state.applications[index];
      if (!current) throw new Error('application not found');
      if (current.status !== input.expectedStatus) throw new Error('status changed concurrently');
      const updated: ApplicationRecord = {
        ...current,
        status: input.toStatus,
        lastTransitionAt: input.now,
        updatedAt: input.now,
        requiresHumanReason: input.toStatus === 'REQUIRES_HUMAN_ACTION' ? input.reason : null,
      };
      state.applications[index] = updated;
      const record = event(
        input.applicationId,
        input.eventType,
        input.expectedStatus,
        input.toStatus,
        input.actor,
        input.payload,
        input.now,
      );
      return { application: updated, event: record };
    },
    async appendEvent(input) {
      return event(
        input.applicationId,
        input.type,
        input.fromStatus,
        input.toStatus,
        input.actor,
        input.payload,
        input.now,
      );
    },
    async setResumeVersion(applicationId, resumeVersionId, now) {
      const index = state.applications.findIndex((application) => application.id === applicationId);
      const current = state.applications[index]!;
      const updated = { ...current, resumeVersionId, updatedAt: now };
      state.applications[index] = updated;
      return updated;
    },
    async listEvents(applicationId) {
      return state.events.filter((record) => record.applicationId === applicationId);
    },
    async listAnswers(applicationId) {
      return state.answers.filter((answer) => answer.applicationId === applicationId);
    },
    async listDocuments(applicationId) {
      return state.documents.filter((document) => document.applicationId === applicationId);
    },
    async findApprovedAnswerByQuestionHash(candidateId, questionHash) {
      return (
        state.answers.find((answer) => {
          const application = state.applications.find((entry) => entry.id === answer.applicationId);
          return (
            application?.candidateId === candidateId &&
            answer.questionHash === questionHash &&
            answer.approved
          );
        }) ?? null
      );
    },
    async upsertAnswer(input) {
      const existingIndex = state.answers.findIndex(
        (answer) =>
          answer.applicationId === input.applicationId &&
          answer.questionHash === input.questionHash,
      );
      const record: ApplicationAnswerRecord = {
        id: existingIndex >= 0 ? state.answers[existingIndex]!.id : input.id,
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
        createdAt: existingIndex >= 0 ? state.answers[existingIndex]!.createdAt : input.now,
        updatedAt: input.now,
      };
      if (existingIndex >= 0) state.answers[existingIndex] = record;
      else state.answers.push(record);
      return record;
    },
    async insertDocument(input) {
      const existing = state.documents.find(
        (document) =>
          document.applicationId === input.applicationId &&
          document.kind === input.kind &&
          document.contentHash === input.contentHash,
      );
      if (existing) return { document: existing, created: false };
      const record: ApplicationDocumentRecord = {
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
      };
      state.documents.push(record);
      return { document: record, created: true };
    },
    async findDocumentByInputHash(applicationId, kind, inputHash) {
      return (
        state.documents.find(
          (document) =>
            document.applicationId === applicationId &&
            document.kind === kind &&
            document.generatedBy.inputHash === inputHash,
        ) ?? null
      );
    },
    async getResumeVersion(id) {
      return state.resumeVersions.find((version) => version.id === id) ?? null;
    },
    async findTailoredVersionByParentAndHash(parentVersionId, fileHash) {
      return (
        state.resumeVersions.find(
          (version) =>
            version.kind === 'tailored' &&
            version.fileHash === fileHash &&
            version.id !== parentVersionId,
        ) ?? null
      );
    },
    async createTailoredResumeVersion(input) {
      const record: ResumeVersionRecord = {
        id: input.id,
        resumeId: input.resumeId,
        candidateId: options.match.candidateId,
        versionNumber: state.resumeVersions.length + 1,
        kind: 'tailored',
        storageKey: input.storageKey,
        fileHash: input.fileHash,
        highlights: input.highlights,
      };
      state.resumeVersions.push(record);
      return record;
    },
    async withApplicationLock(_applicationId, fn) {
      return fn();
    },
    async appendAudit(entry) {
      state.audits.push({ action: entry.action, entityId: entry.entityId });
    },
  };

  return { repo, state };
}
