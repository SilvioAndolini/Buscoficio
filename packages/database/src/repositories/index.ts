export { createCandidateRepo, listProfileAggregate } from './candidate-repo.js';
export { createResumeRepo, type CreateVersionData } from './resume-repo.js';
export { createJobRepo, type IngestJobData, type UpsertSourceData } from './job-repo.js';
export { createDedupRepo, type DedupDecision } from './dedup-repo.js';
export { createStatsRepo } from './stats-repo.js';
export {
  createSearchRepo,
  type SearchConfigData,
  type SourceRunResult,
} from './search-repo.js';
export { createAuditRepo, type AuditEntry } from './audit-repo.js';
export {
  createMatchingRepo,
  type EnsureEmbeddingSpaceData,
  type MatchWithJob,
  type MatchingRepo,
  type UpsertEmbeddingData,
  type UpsertMatchData,
} from './matching-repo.js';
export { createAiUsageRepo, type AiUsageEntry, type AiUsageRepo } from './ai-usage-repo.js';
export {
  createApplicationRepo,
  createApplicationRepositoryPort,
  loadProfileFactsSource,
  type AppendAuditData,
  type AppendEventData,
  type ApplicationAnswerData,
  type ApplicationDocumentData,
  type ApplicationEventData,
  type ApplicationRecordData,
  type ApplicationRepo,
  type ApplicationWithJob,
  type CreateApplicationData,
  type CreateTailoredVersionData,
  type InsertDocumentData,
  type MatchCreationContextData,
  type ResumeVersionData,
  type TargetData,
  type TransitionApplicationData,
  type UpsertAnswerData,
} from './application-repo.js';
export { createDecisionLogRepo, type DecisionLogEntry } from './decision-log-repo.js';