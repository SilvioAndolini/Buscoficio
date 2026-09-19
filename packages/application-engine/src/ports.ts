/**
 * The application repository port lives in `core` so the engine (consumer) and
 * `packages/database` (implementer) share one contract without cross-package
 * dependencies (architecture doc 11 §3).
 */
export type {
  AppendEventRecordInput,
  ApplicationAnswerRecord,
  ApplicationDocumentRecord,
  ApplicationEventRecord,
  ApplicationRecord,
  ApplicationRepositoryPort,
  AuditRecordInput,
  CreateApplicationRecordInput,
  CreateTailoredResumeVersionInput,
  InsertDocumentRecordInput,
  MatchCreationContext,
  ResumeVersionRecord,
  TargetView,
  TransitionRecordInput,
  UpsertAnswerRecordInput,
} from '@job-system/core';
