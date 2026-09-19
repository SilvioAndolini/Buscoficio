import { sql } from 'drizzle-orm';
import { desc } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { EMBEDDING_VECTOR_DIMENSIONS } from '@job-system/shared';

/**
 * Fixed pgvector dimension (ADR-018): one vector(N) column per space type.
 * The value comes from the shared config constant so the column and the
 * runtime configuration can never drift apart.
 */
export const VECTOR_DIMENSIONS = EMBEDDING_VECTOR_DIMENSIONS;

/**
 * Phase 1 schema — subset of the approved data model (docs/arquitectura/04).
 * Included now: everything needed for Phase 1 plus the structural tables
 * (application_target, embedding_space, decision_log) required from the start.
 *
 * Deviations from the doc (documented in the Phase 1 report):
 *  - `job_listing` normalization columns are nullable so malformed offers can be
 *    quarantined (validated=false, job_id=null) without aborting the batch.
 *  - `audit_log.entity_id` is `text` to allow non-uuid identifiers.
 */

const emptyTextArray = sql`'{}'::text[]`;
const emptyUuidArray = sql`'{}'::uuid[]`;
const emptyJson = sql`'{}'::jsonb`;
/** JSONB array default: `{}` is an object and breaks array-shaped columns. */
const emptyJsonArray = sql`'[]'::jsonb`;

/* ------------------------------------------------------------------ */
/* Candidate                                                           */
/* ------------------------------------------------------------------ */

export const candidateProfile = pgTable('candidate_profile', {
  id: uuid('id').primaryKey(),
  fullName: text('full_name').notNull(),
  email: text('email').notNull(),
  phone: text('phone'),
  headline: text('headline'),
  summary: text('summary'),
  locationCity: text('location_city'),
  locationCountry: text('location_country'),
  locationTimezone: text('location_timezone'),
  availabilityDate: date('availability_date', { mode: 'date' }),
  salaryMin: integer('salary_min'),
  salaryMax: integer('salary_max'),
  salaryCurrency: text('salary_currency'),
  remotePreference: text('remote_preference').array().notNull().default(emptyTextArray),
  employmentTypes: text('employment_types').array().notNull().default(emptyTextArray),
  allowedCountries: text('allowed_countries').array().notNull().default(emptyTextArray),
  relocation: boolean('relocation').notNull().default(false),
  preferences: jsonb('preferences').notNull().default(emptyJson),
  profileHash: text('profile_hash').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const skill = pgTable(
  'skill',
  {
    id: uuid('id').primaryKey(),
    canonicalName: text('canonical_name').notNull(),
    aliases: text('aliases').array().notNull().default(emptyTextArray),
    category: text('category'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('skill_canonical_name_uq').on(table.canonicalName)],
);

export const candidateSkill = pgTable(
  'candidate_skill',
  {
    id: uuid('id').primaryKey(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfile.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skill.id, { onDelete: 'restrict' }),
    level: text('level').notNull(),
    years: numeric('years', { precision: 4, scale: 1 }),
    evidenceRef: jsonb('evidence_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('candidate_skill_candidate_skill_uq').on(table.candidateId, table.skillId),
    index('candidate_skill_candidate_idx').on(table.candidateId),
  ],
);

export const experience = pgTable(
  'experience',
  {
    id: uuid('id').primaryKey(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfile.id, { onDelete: 'cascade' }),
    company: text('company').notNull(),
    title: text('title').notNull(),
    startDate: date('start_date', { mode: 'date' }).notNull(),
    endDate: date('end_date', { mode: 'date' }),
    description: text('description').notNull().default(''),
    location: text('location'),
    skills: text('skills').array().notNull().default(emptyTextArray),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('experience_candidate_start_idx').on(table.candidateId, table.startDate)],
);

export const education = pgTable(
  'education',
  {
    id: uuid('id').primaryKey(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfile.id, { onDelete: 'cascade' }),
    institution: text('institution').notNull(),
    degree: text('degree').notNull(),
    field: text('field'),
    startDate: date('start_date', { mode: 'date' }),
    endDate: date('end_date', { mode: 'date' }),
    status: text('status').notNull().default('completed'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('education_candidate_idx').on(table.candidateId)],
);

export const candidateLanguage = pgTable(
  'candidate_language',
  {
    id: uuid('id').primaryKey(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfile.id, { onDelete: 'cascade' }),
    language: text('language').notNull(),
    level: text('level').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('candidate_language_candidate_language_uq').on(table.candidateId, table.language),
  ],
);

/* ------------------------------------------------------------------ */
/* Resume                                                              */
/* ------------------------------------------------------------------ */

export const resume = pgTable(
  'resume',
  {
    id: uuid('id').primaryKey(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfile.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category').notNull(),
    language: text('language').notNull().default('en'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Multiple resumes may share category+language (e.g. Full Stack / Frontend /
  // Backend CVs in the same language); no uniqueness on that combination.
  (table) => [index('resume_candidate_idx').on(table.candidateId)],
);

export const resumeVersion = pgTable(
  'resume_version',
  {
    id: uuid('id').primaryKey(),
    resumeId: uuid('resume_id')
      .notNull()
      .references(() => resume.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    parentVersionId: uuid('parent_version_id').references((): AnyPgColumn => resumeVersion.id, {
      onDelete: 'restrict',
    }),
    kind: text('kind').notNull().default('original'),
    storageKey: text('storage_key').notNull(),
    fileHash: text('file_hash').notNull(),
    highlights: jsonb('highlights').notNull().default(emptyJson),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('resume_version_resume_version_uq').on(table.resumeId, table.versionNumber),
    index('resume_version_resume_idx').on(table.resumeId),
    index('resume_version_parent_idx').on(table.parentVersionId),
  ],
);

/* ------------------------------------------------------------------ */
/* JobCatalog — discovery source vs application target (ADR-013)       */
/* ------------------------------------------------------------------ */

export const jobSource = pgTable(
  'job_source',
  {
    id: uuid('id').primaryKey(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('active'),
    capabilities: jsonb('capabilities').notNull().default(emptyJson),
    policyNotes: text('policy_notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('job_source_key_uq').on(table.key)],
);

export const applicationTarget = pgTable(
  'application_target',
  {
    id: uuid('id').primaryKey(),
    key: text('key').notNull(),
    kind: text('kind').notNull(),
    platform: text('platform').notNull(),
    label: text('label').notNull(),
    baseUrl: text('base_url'),
    capabilities: jsonb('capabilities').notNull().default(emptyJson),
    authRequired: boolean('auth_required').notNull().default(false),
    // Auto-detected targets start blocked: detection is not authorization.
    status: text('status').notNull().default('blocked'),
    policyNotes: text('policy_notes'),
    // Explicit policy/ToS review evidence required to authorize submission.
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('application_target_key_uq').on(table.key)],
);

export const jobListing = pgTable(
  'job_listing',
  {
    id: uuid('id').primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => jobSource.id, { onDelete: 'restrict' }),
    externalId: text('external_id').notNull(),
    jobId: uuid('job_id').references((): AnyPgColumn => job.id, { onDelete: 'set null' }),
    applicationTargetId: uuid('application_target_id').references(() => applicationTarget.id, {
      onDelete: 'set null',
    }),
    applicationTargetSignal: text('application_target_signal'),
    canonicalUrl: text('canonical_url'),
    urlHash: text('url_hash'),
    company: text('company'),
    companyNorm: text('company_norm'),
    title: text('title'),
    titleNorm: text('title_norm'),
    description: text('description'),
    descriptionNorm: text('description_norm'),
    descriptionFingerprint: text('description_fingerprint'),
    location: text('location'),
    remoteType: text('remote_type'),
    employmentType: text('employment_type'),
    salaryMin: integer('salary_min'),
    salaryMax: integer('salary_max'),
    currency: text('currency'),
    experienceLevel: text('experience_level'),
    languageRequirements: text('language_requirements').array().notNull().default(emptyTextArray),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    applicationMethod: text('application_method').notNull().default('unknown'),
    raw: jsonb('raw'),
    rawRef: text('raw_ref'),
    status: text('status').notNull().default('active'),
    validated: boolean('validated').notNull().default(true),
    validationErrors: jsonb('validation_errors'),
  },
  (table) => [
    uniqueIndex('job_listing_source_external_uq').on(table.sourceId, table.externalId),
    index('job_listing_job_idx').on(table.jobId),
    index('job_listing_url_hash_idx').on(table.urlHash),
    index('job_listing_fingerprint_idx').on(table.descriptionFingerprint),
    index('job_listing_target_idx').on(table.applicationTargetId),
    index('job_listing_discovered_idx').on(table.discoveredAt),
    index('job_listing_title_trgm_idx').using('gin', sql`${table.titleNorm} gin_trgm_ops`),
    index('job_listing_company_trgm_idx').using('gin', sql`${table.companyNorm} gin_trgm_ops`),
  ],
);

export const job = pgTable(
  'job',
  {
    id: uuid('id').primaryKey(),
    primaryListingId: uuid('primary_listing_id').references((): AnyPgColumn => jobListing.id, {
      onDelete: 'set null',
    }),
    applicationTargetId: uuid('application_target_id').references(() => applicationTarget.id, {
      onDelete: 'set null',
    }),
    applicationTargetResolvedAt: timestamp('application_target_resolved_at', { withTimezone: true }),
    company: text('company').notNull(),
    companyNorm: text('company_norm').notNull(),
    title: text('title').notNull(),
    titleNorm: text('title_norm').notNull(),
    description: text('description').notNull(),
    descriptionNorm: text('description_norm').notNull().default(''),
    location: text('location'),
    locationNorm: text('location_norm').notNull().default(''),
    remoteType: text('remote_type'),
    employmentType: text('employment_type'),
    salaryMin: integer('salary_min'),
    salaryMax: integer('salary_max'),
    currency: text('currency'),
    experienceLevel: text('experience_level'),
    requiredSkills: text('required_skills').array().notNull().default(emptyTextArray),
    preferredSkills: text('preferred_skills').array().notNull().default(emptyTextArray),
    languageRequirements: text('language_requirements').array().notNull().default(emptyTextArray),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    applicationMethod: text('application_method').notNull().default('unknown'),
    dedupKey: text('dedup_key').notNull(),
    contentHash: text('content_hash').notNull(),
    mergedFrom: uuid('merged_from').array().notNull().default(emptyUuidArray),
    status: text('status').notNull().default('active'),
    metadata: jsonb('metadata').notNull().default(emptyJson),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('job_dedup_key_uq').on(table.dedupKey),
    index('job_status_published_idx').on(table.status, table.publishedAt),
    index('job_target_idx').on(table.applicationTargetId),
    index('job_title_trgm_idx').using('gin', sql`${table.titleNorm} gin_trgm_ops`),
    index('job_company_location_idx').on(table.companyNorm, table.locationNorm),
  ],
);

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export const searchConfig = pgTable(
  'search_config',
  {
    id: uuid('id').primaryKey(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfile.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keywords: text('keywords').array().notNull().default(emptyTextArray),
    locations: text('locations').array().notNull().default(emptyTextArray),
    remote: boolean('remote'),
    sources: text('sources').array().notNull().default(emptyTextArray),
    intervalMinutes: integer('interval_minutes').notNull().default(1440),
    filters: jsonb('filters').notNull().default(emptyJson),
    mode: text('mode').notNull().default('assisted'),
    isActive: boolean('is_active').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('search_config_active_idx').on(table.isActive, table.nextRunAt)],
);

export const searchRun = pgTable(
  'search_run',
  {
    id: uuid('id').primaryKey(),
    searchConfigId: uuid('search_config_id')
      .notNull()
      .references(() => searchConfig.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: text('status').notNull().default('running'),
    jobsDiscovered: integer('jobs_discovered').notNull().default(0),
    jobsNew: integer('jobs_new').notNull().default(0),
    jobsDuplicated: integer('jobs_duplicated').notNull().default(0),
    jobsRejected: integer('jobs_rejected').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    correlationId: text('correlation_id').notNull(),
  },
  (table) => [index('search_run_config_started_idx').on(table.searchConfigId, table.startedAt)],
);

export const searchSourceRun = pgTable(
  'search_source_run',
  {
    id: uuid('id').primaryKey(),
    searchRunId: uuid('search_run_id')
      .notNull()
      .references(() => searchRun.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => jobSource.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    jobsDiscovered: integer('jobs_discovered').notNull().default(0),
    jobsNew: integer('jobs_new').notNull().default(0),
    jobsDuplicated: integer('jobs_duplicated').notNull().default(0),
    jobsRejected: integer('jobs_rejected').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    durationMs: integer('duration_ms'),
    errorClass: text('error_class'),
    errorDetail: text('error_detail'),
    correlationId: text('correlation_id').notNull(),
  },
  (table) => [
    uniqueIndex('search_source_run_run_source_uq').on(table.searchRunId, table.sourceId),
    index('search_source_run_source_idx').on(table.sourceId, table.startedAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Structural tables required from Phase 1 (empty until later phases)  */
/* ------------------------------------------------------------------ */

export const embeddingSpace = pgTable(
  'embedding_space',
  {
    id: uuid('id').primaryKey(),
    key: text('key').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    distanceMetric: text('distance_metric').notNull().default('cosine'),
    version: text('version').notNull(),
    status: text('status').notNull().default('inactive'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('embedding_space_key_uq').on(table.key),
    uniqueIndex('embedding_space_provider_model_dim_version_uq').on(
      table.provider,
      table.model,
      table.dimensions,
      table.version,
    ),
    // Phase 3: at most one ACTIVE space (deterministic resolution rule).
    // Inactive/legacy spaces coexist untouched (ADR-018).
    uniqueIndex('embedding_space_active_uq')
      .on(table.status)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const decisionLog = pgTable(
  'decision_log',
  {
    id: uuid('id').primaryKey(),
    task: text('task').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputHash: text('input_hash').notNull(),
    proposed: jsonb('proposed').notNull(),
    chosen: jsonb('chosen'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
    threshold: numeric('threshold', { precision: 5, scale: 4 }),
    outcome: text('outcome').notNull().default('pending'),
    applicationId: uuid('application_id').references(() => application.id, { onDelete: 'set null' }),
    automationRunId: uuid('automation_run_id'),
    correlationId: text('correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('decision_log_task_created_idx').on(table.task, table.createdAt),
    index('decision_log_outcome_idx').on(table.outcome),
  ],
);

/* ------------------------------------------------------------------ */
/* Fuzzy dedup review (Phase 2)                                        */
/* ------------------------------------------------------------------ */

export const dedupReview = pgTable(
  'dedup_review',
  {
    id: uuid('id').primaryKey(),
    candidateJobId: uuid('candidate_job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    createdJobId: uuid('created_job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    listingId: uuid('listing_id').references(() => jobListing.id, { onDelete: 'set null' }),
    sourceId: uuid('source_id').references(() => jobSource.id, { onDelete: 'set null' }),
    score: numeric('score', { precision: 5, scale: 4 }).notNull(),
    titleSimilarity: numeric('title_similarity', { precision: 5, scale: 4 }).notNull(),
    descriptionSimilarity: numeric('description_similarity', { precision: 5, scale: 4 }).notNull(),
    reasons: jsonb('reasons').notNull().default(emptyJson),
    status: text('status').notNull().default('pending'),
    decision: text('decision'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('dedup_review_status_idx').on(table.status, table.createdAt),
    index('dedup_review_candidate_idx').on(table.candidateJobId),
    index('dedup_review_created_idx').on(table.createdJobId),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    correlationId: text('correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_entity_idx').on(table.entityType, table.entityId, table.createdAt),
    index('audit_log_created_idx').on(table.createdAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Matching (Phase 3)                                                  */
/* ------------------------------------------------------------------ */

export const jobMatch = pgTable(
  'job_match',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfile.id, { onDelete: 'cascade' }),
    overallScore: numeric('overall_score', { precision: 5, scale: 4 }).notNull(),
    scoreBreakdown: jsonb('score_breakdown').notNull(),
    reasons: text('reasons').array().notNull().default(emptyTextArray),
    missingRequirements: text('missing_requirements').array().notNull().default(emptyTextArray),
    matchingSkills: text('matching_skills').array().notNull().default(emptyTextArray),
    recommendedResumeId: uuid('recommended_resume_id').references(() => resume.id, {
      onDelete: 'set null',
    }),
    engineVersion: text('engine_version').notNull(),
    weightsVersion: text('weights_version').notNull(),
    jobContentHash: text('job_content_hash').notNull(),
    candidateProfileHash: text('candidate_profile_hash').notNull(),
    resumeSetHash: text('resume_set_hash').notNull(),
    embeddingSpaceId: uuid('embedding_space_id').references(() => embeddingSpace.id, {
      onDelete: 'set null',
    }),
    identityHash: text('identity_hash').notNull(),
    isCurrent: boolean('is_current').notNull().default(false),
    semanticModel: text('semantic_model'),
    /**
     * Temporal anchor used to evaluate open-ended experiences (Phase 3.1).
     * Null when every experience is closed (the score does not depend on
     * time) or for matches computed before this column existed.
     */
    matchingAsOfDate: date('matching_as_of_date', { mode: 'date' }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('job_match_identity_uq').on(table.jobId, table.candidateId, table.identityHash),
    // At most one current match per (job, candidate): DB-enforced, not app-only.
    uniqueIndex('job_match_current_uq')
      .on(table.jobId, table.candidateId)
      .where(sql`${table.isCurrent} = true`),
    index('job_match_ranking_idx')
      .on(table.candidateId, desc(table.overallScore))
      .where(sql`${table.isCurrent} = true`),
    index('job_match_computed_idx').on(desc(table.computedAt)),
  ],
);

export const jobEmbedding = pgTable(
  'job_embedding',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    embeddingSpaceId: uuid('embedding_space_id')
      .notNull()
      .references(() => embeddingSpace.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    embedding: vector('embedding', { dimensions: VECTOR_DIMENSIONS }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.embeddingSpaceId], name: 'job_embedding_pk' }),
    index('job_embedding_hnsw_idx').using('hnsw', sql`${table.embedding} vector_cosine_ops`),
  ],
);

export const resumeEmbedding = pgTable(
  'resume_embedding',
  {
    resumeVersionId: uuid('resume_version_id')
      .notNull()
      .references(() => resumeVersion.id, { onDelete: 'cascade' }),
    embeddingSpaceId: uuid('embedding_space_id')
      .notNull()
      .references(() => embeddingSpace.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    embedding: vector('embedding', { dimensions: VECTOR_DIMENSIONS }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.resumeVersionId, table.embeddingSpaceId], name: 'resume_embedding_pk' }),
    index('resume_embedding_hnsw_idx').using('hnsw', sql`${table.embedding} vector_cosine_ops`),
  ],
);

/** AI usage ledger (doc 04 §2.8); Phase 3 records `operation='embed'`. */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    operation: text('operation').notNull(),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costEstimateUsd: numeric('cost_estimate_usd', { precision: 12, scale: 6 }),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
    latencyMs: integer('latency_ms').notNull(),
    cached: boolean('cached').notNull().default(false),
    applicationId: uuid('application_id').references(() => application.id, { onDelete: 'set null' }),
    jobId: uuid('job_id').references(() => job.id, { onDelete: 'set null' }),
    correlationId: text('correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ai_usage_operation_created_idx').on(table.operation, table.createdAt)],
);

/* ------------------------------------------------------------------ */
/* Application (Phase 4)                                               */
/* ------------------------------------------------------------------ */

/**
 * Application root (doc 04 §2.6). The partial unique `(candidate_id, job_id)
 * WHERE status NOT IN ('ARCHIVED','REJECTED')` is the definitive defense of
 * invariant A1; `preparation_snapshot` stays NULL until Phase 5.
 */
export const application = pgTable(
  'application',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'restrict' }),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidateProfile.id, { onDelete: 'restrict' }),
    applicationTargetId: uuid('application_target_id').references(() => applicationTarget.id, {
      onDelete: 'restrict',
    }),
    discoverySourceId: uuid('discovery_source_id').references(() => jobSource.id, {
      onDelete: 'restrict',
    }),
    matchId: uuid('match_id')
      .notNull()
      .references(() => jobMatch.id, { onDelete: 'restrict' }),
    mode: text('mode').notNull(),
    status: text('status').notNull().default('DISCOVERED'),
    resumeVersionId: uuid('resume_version_id').references(() => resumeVersion.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key').notNull(),
    policyVersion: text('policy_version').notNull(),
    scoreAtCreation: numeric('score_at_creation', { precision: 5, scale: 4 }).notNull(),
    preparationSnapshot: jsonb('preparation_snapshot'),
    supersedesApplicationId: uuid('supersedes_application_id').references(
      (): AnyPgColumn => application.id,
      { onDelete: 'restrict' },
    ),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    lastTransitionAt: timestamp('last_transition_at', { withTimezone: true }).notNull().defaultNow(),
    requiresHumanReason: text('requires_human_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('application_idempotency_key_uq').on(table.idempotencyKey),
    // Invariant A1: at most one active application per canonical Job.
    uniqueIndex('application_active_job_candidate_uq')
      .on(table.candidateId, table.jobId)
      .where(sql`${table.status} NOT IN ('ARCHIVED', 'REJECTED')`),
    index('application_status_transition_idx').on(table.status, table.lastTransitionAt),
    index('application_job_idx').on(table.jobId),
    index('application_target_idx').on(table.applicationTargetId),
    index('application_candidate_status_idx').on(table.candidateId, table.status),
  ],
);

export const applicationAnswer = pgTable(
  'application_answer',
  {
    id: uuid('id').primaryKey(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => application.id, { onDelete: 'cascade' }),
    questionText: text('question_text').notNull(),
    questionHash: text('question_hash').notNull(),
    answerText: text('answer_text'),
    answerKind: text('answer_kind').notNull(),
    sourceRefs: jsonb('source_refs').notNull().default(emptyJsonArray),
    claims: jsonb('claims').notNull().default(emptyJsonArray),
    verification: jsonb('verification').notNull().default(emptyJson),
    requiresHumanInput: boolean('requires_human_input').notNull().default(false),
    approved: boolean('approved').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('application_answer_question_uq').on(table.applicationId, table.questionHash),
    index('application_answer_question_hash_idx').on(table.questionHash),
  ],
);

export const applicationDocument = pgTable(
  'application_document',
  {
    id: uuid('id').primaryKey(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => application.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    resumeVersionId: uuid('resume_version_id').references(() => resumeVersion.id, {
      onDelete: 'restrict',
    }),
    storageKey: text('storage_key').notNull(),
    contentHash: text('content_hash').notNull(),
    claims: jsonb('claims').notNull().default(emptyJsonArray),
    verification: jsonb('verification').notNull().default(emptyJson),
    generatedBy: jsonb('generated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Append-only: same logical document (same bytes) is never duplicated.
    uniqueIndex('application_document_content_uq').on(
      table.applicationId,
      table.kind,
      table.contentHash,
    ),
    index('application_document_application_idx').on(table.applicationId),
    // Preparation identity (inputHash) lives inside generated_by JSONB.
    index('application_document_input_hash_idx').on(sql`(${table.generatedBy}->>'inputHash')`),
  ],
);

export const applicationEvent = pgTable(
  'application_event',
  {
    id: uuid('id').primaryKey(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => application.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    actor: text('actor').notNull(),
    payload: jsonb('payload').notNull().default(emptyJson),
    correlationId: text('correlation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('application_event_application_time_idx').on(table.applicationId, table.occurredAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Row types                                                           */
/* ------------------------------------------------------------------ */

export type CandidateProfileRow = typeof candidateProfile.$inferSelect;
export type ExperienceRow = typeof experience.$inferSelect;
export type EducationRow = typeof education.$inferSelect;
export type CandidateSkillRow = typeof candidateSkill.$inferSelect;
export type SkillRow = typeof skill.$inferSelect;
export type CandidateLanguageRow = typeof candidateLanguage.$inferSelect;
export type ResumeRow = typeof resume.$inferSelect;
export type ResumeVersionRow = typeof resumeVersion.$inferSelect;
export type JobSourceRow = typeof jobSource.$inferSelect;
export type ApplicationTargetRow = typeof applicationTarget.$inferSelect;
export type JobListingRow = typeof jobListing.$inferSelect;
export type JobRow = typeof job.$inferSelect;
export type DedupReviewRow = typeof dedupReview.$inferSelect;
export type SearchConfigRow = typeof searchConfig.$inferSelect;
export type SearchRunRow = typeof searchRun.$inferSelect;
export type SearchSourceRunRow = typeof searchSourceRun.$inferSelect;
export type JobMatchRow = typeof jobMatch.$inferSelect;
export type JobEmbeddingRow = typeof jobEmbedding.$inferSelect;
export type ResumeEmbeddingRow = typeof resumeEmbedding.$inferSelect;
export type EmbeddingSpaceRow = typeof embeddingSpace.$inferSelect;
export type AiUsageRow = typeof aiUsage.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type ApplicationRow = typeof application.$inferSelect;
export type ApplicationAnswerRow = typeof applicationAnswer.$inferSelect;
export type ApplicationDocumentRow = typeof applicationDocument.$inferSelect;
export type ApplicationEventRow = typeof applicationEvent.$inferSelect;