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