import {
  AiError,
  computeJobContentHash,
  type Clock,
  type EmbeddingProvider,
  type TraceContext,
} from '@job-system/core';
import type { AiUsageRepo, MatchingRepo } from '@job-system/database';
import {
  MatchCandidateExperienceSchema,
  MatchCandidateLanguageSchema,
  MatchCandidateProfileSchema,
  MatchCandidateSkillSchema,
  MatchJobSchema,
  MatchResumeContextSchema,
  buildJobEmbeddingText,
  buildResumeEmbeddingText,
  computeCandidateProfileHash,
  computeIdentityHash,
  computeResumeSetHash,
  DEFAULT_MATCH_POLICY,
  jobEmbeddingContentHash,
  resumeEmbeddingContentHash,
  runMatchEngine,
  semanticSimilarity,
  type MatchPolicy,
  type MatchResumeSemantic,
} from '@job-system/matching';
import type { Logger } from '@job-system/observability';

export interface MatchingServiceDeps {
  matchingRepo: MatchingRepo;
  aiUsageRepo: AiUsageRepo;
  embeddingProvider: EmbeddingProvider;
  clock: Clock;
  logger: Logger;
  /** Overridable only in tests; production uses the versioned v1 policy. */
  policy?: MatchPolicy;
}

export interface MatchRef {
  matchId: string;
  jobId: string;
  candidateId: string;
  identityHash: string;
  overallScore: number;
  isCurrent: boolean;
  created: boolean;
  embeddingSpaceId: string | null;
  engineVersion: string;
  weightsVersion: string;
}

const VECTOR_COLUMN_DIMENSIONS = 1536;

export function createMatchingService(deps: MatchingServiceDeps) {
  const policy = deps.policy ?? DEFAULT_MATCH_POLICY;

  async function recordEmbeddingUsage(
    latencyMs: number,
    jobId: string | null,
    trace: TraceContext,
  ): Promise<void> {
    await deps.aiUsageRepo.record({
      provider: deps.embeddingProvider.provider,
      model: deps.embeddingProvider.model,
      operation: 'embed',
      latencyMs,
      cached: false,
      jobId,
      correlationId: trace.correlationId,
      costEstimateUsd:
        deps.embeddingProvider.provider === 'mock' ? '0.000000' : null,
    });
  }

  async function ensureJobEmbedding(
    jobId: string,
    text: string,
    embeddingSpaceId: string,
    trace: TraceContext,
    logger: Logger,
  ): Promise<number[]> {
    const contentHash = jobEmbeddingContentHash(text);
    const cached = await deps.matchingRepo.getJobEmbedding(jobId, embeddingSpaceId);
    if (cached && cached.contentHash === contentHash) {
      logger.debug({ jobId, embeddingSpaceId }, 'job embedding cache hit');
      return cached.embedding;
    }
    const startedAt = Date.now();
    const vector = await deps.embeddingProvider.embed({
      text,
      contentHash,
      embeddingSpaceId,
      trace,
    });
    await deps.matchingRepo.upsertJobEmbedding(jobId, embeddingSpaceId, { contentHash, embedding: vector });
    await recordEmbeddingUsage(Date.now() - startedAt, jobId, trace);
    return vector;
  }

  async function ensureResumeEmbedding(
    resumeVersionId: string,
    text: string,
    embeddingSpaceId: string,
    trace: TraceContext,
    logger: Logger,
  ): Promise<number[]> {
    const contentHash = resumeEmbeddingContentHash(text);
    const cached = await deps.matchingRepo.getResumeEmbedding(resumeVersionId, embeddingSpaceId);
    if (cached && cached.contentHash === contentHash) {
      logger.debug({ resumeVersionId, embeddingSpaceId }, 'resume embedding cache hit');
      return cached.embedding;
    }
    const startedAt = Date.now();
    const vector = await deps.embeddingProvider.embed({
      text,
      contentHash,
      embeddingSpaceId,
      trace,
    });
    await deps.matchingRepo.upsertResumeEmbedding(resumeVersionId, embeddingSpaceId, {
      contentHash,
      embedding: vector,
    });
    await recordEmbeddingUsage(Date.now() - startedAt, null, trace);
    return vector;
  }

  /**
   * Deterministic, idempotent, explainable scoring (architecture doc 03 §6–7).
   * Embedding failures abort before any JobMatch write, so `isCurrent` can
   * never become inconsistent (doc 06 §4 / task §64).
   */
  async function score(
    jobId: string,
    candidateId: string,
    trace: TraceContext,
    logger: Logger = deps.logger,
  ): Promise<MatchRef> {
    const jobRow = await deps.matchingRepo.getMatchJob(jobId);
    const job = MatchJobSchema.parse(jobRow);
    const context = await deps.matchingRepo.getCandidateMatchContext(candidateId);
    const profile = MatchCandidateProfileSchema.parse(context.profile);
    const skills = context.skills.map((skill) => MatchCandidateSkillSchema.parse(skill));
    const languages = context.languages.map((language) =>
      MatchCandidateLanguageSchema.parse(language),
    );
    const experiences = context.experiences.map((experience) =>
      MatchCandidateExperienceSchema.parse(experience),
    );
    const resumes = (await deps.matchingRepo.listResumesWithLatestVersion(candidateId)).map(
      (entry) =>
        MatchResumeContextSchema.parse({
          id: entry.resume.id,
          category: entry.resume.category,
          language: entry.resume.language,
          latestVersion: entry.latestVersion,
        }),
    );

    const jobContentHash = computeJobContentHash({
      company: job.company,
      title: job.title,
      description: job.description,
      location: job.location,
      remoteType: job.remoteType,
      employmentType: job.employmentType,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      currency: job.currency,
      experienceLevel: job.experienceLevel,
      languageRequirements: job.languageRequirements,
      requiredSkills: job.requiredSkills,
      preferredSkills: job.preferredSkills,
    });
    const candidateProfileHash = computeCandidateProfileHash({
      profile,
      skills,
      languages,
      experiences,
    });
    const resumeSetHash = computeResumeSetHash(
      resumes.map((resume) => ({
        id: resume.id,
        category: resume.category,
        language: resume.language,
        latestVersion: resume.latestVersion,
      })),
    );

    const space = await deps.matchingRepo.getActiveEmbeddingSpace();
    if (space && space.dimensions !== deps.embeddingProvider.dimensions) {
      throw new AiError(
        `Embedding space '${space.key}' expects ${space.dimensions} dimensions but provider '${deps.embeddingProvider.model}' produces ${deps.embeddingProvider.dimensions}`,
      );
    }
    if (space && space.dimensions !== VECTOR_COLUMN_DIMENSIONS) {
      throw new AiError(
        `Embedding space dimension ${space.dimensions} does not match the vector(${VECTOR_COLUMN_DIMENSIONS}) column; dimension changes require the ADR-018 migration`,
      );
    }

    const identityHash = computeIdentityHash({
      engineVersion: policy.engineVersion,
      weightsVersion: policy.weightsVersion,
      jobContentHash,
      candidateProfileHash,
      resumeSetHash,
      embeddingSpaceId: space?.id ?? null,
    });

    const existing = await deps.matchingRepo.findMatchByIdentity(jobId, candidateId, identityHash);
    if (existing) {
      // Same identity: reuse the row (idempotent, no recompute, no re-embed).
      const row = existing.isCurrent
        ? existing
        : await deps.matchingRepo.setCurrentMatch(jobId, candidateId, existing.id);
      logger.info(
        { jobId, candidateId, identityHash, matchId: row.id, created: false },
        'match identity already exists; reused',
      );
      return {
        matchId: row.id,
        jobId,
        candidateId,
        identityHash,
        overallScore: Number(row.overallScore),
        isCurrent: row.isCurrent,
        created: false,
        embeddingSpaceId: row.embeddingSpaceId,
        engineVersion: row.engineVersion,
        weightsVersion: row.weightsVersion,
      };
    }

    let resumeSemantics: MatchResumeSemantic[] = [];
    if (space) {
      const jobText = buildJobEmbeddingText(job);
      const jobVector = await ensureJobEmbedding(jobId, jobText, space.id, trace, logger);
      const entries: MatchResumeSemantic[] = [];
      for (const resume of resumes) {
        if (resume.latestVersion === null) continue;
        const text = buildResumeEmbeddingText(resume.latestVersion);
        const vector = await ensureResumeEmbedding(
          resume.latestVersion.id,
          text,
          space.id,
          trace,
          logger,
        );
        entries.push({
          resumeId: resume.id,
          versionId: resume.latestVersion.id,
          similarity: semanticSimilarity(jobVector, vector),
        });
      }
      resumeSemantics = entries;
    }

    const result = runMatchEngine(
      { job, profile, skills, languages, experiences, resumes, resumeSemantics },
      policy,
    );

    const { row, created } = await deps.matchingRepo.upsertCurrentMatch({
      jobId,
      candidateId,
      overallScore: result.overallScore,
      scoreBreakdown: result.breakdown,
      reasons: result.reasons,
      missingRequirements: result.missingRequirements,
      matchingSkills: result.matchingSkills,
      recommendedResumeId: result.recommendedResumeId,
      engineVersion: policy.engineVersion,
      weightsVersion: policy.weightsVersion,
      jobContentHash,
      candidateProfileHash,
      resumeSetHash,
      embeddingSpaceId: space?.id ?? null,
      identityHash,
      semanticModel: space ? `${space.provider}:${space.model}@${space.version}` : null,
      computedAt: deps.clock.now(),
    });

    logger.info(
      {
        jobId,
        candidateId,
        matchId: row.id,
        identityHash,
        embeddingSpaceId: space?.id ?? null,
        overallScore: result.overallScore,
        created,
        capApplied: result.breakdown.capApplied,
      },
      'match computed',
    );

    return {
      matchId: row.id,
      jobId,
      candidateId,
      identityHash,
      overallScore: result.overallScore,
      isCurrent: row.isCurrent,
      created,
      embeddingSpaceId: space?.id ?? null,
      engineVersion: policy.engineVersion,
      weightsVersion: policy.weightsVersion,
    };
  }

  return { score };
}

export type MatchingService = ReturnType<typeof createMatchingService>;