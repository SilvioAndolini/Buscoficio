import {
  AiError,
  computeJobContentHash,
  embeddingRuntimeMatchesSpace,
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
  matchingAsOfDate: string | null;
}

/** UTC date-only anchor (no time component) derived from the injected Clock. */
function utcDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function createMatchingService(deps: MatchingServiceDeps) {
  const policy = deps.policy ?? DEFAULT_MATCH_POLICY;

  async function recordEmbeddingUsage(
    latencyMs: number,
    jobId: string | null,
    trace: TraceContext,
  ): Promise<void> {
    try {
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
    } catch (error) {
      // Usage is observability, never the source of truth: a transient DB/FK
      // failure must not abort a scoring run that already persisted its vectors.
      deps.logger.warn({ jobId, err: error }, 'embedding usage record failed');
    }
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
    if (space) {
      // Strict binding: a vector written into a space MUST come from the same
      // provider+model+dimensions the space declares. Fail closed BEFORE any
      // cache lookup, embed() call or write (never contaminate a space).
      const compatibility = embeddingRuntimeMatchesSpace(space, deps.embeddingProvider);
      if (!compatibility.compatible) {
        throw new AiError(
          'Active EmbeddingSpace is incompatible with the runtime embedding provider; refusing to read or write vectors',
          {
            context: {
              embeddingSpaceId: space.id,
              spaceProvider: space.provider,
              spaceModel: space.model,
              spaceDimensions: space.dimensions,
              runtimeProvider: deps.embeddingProvider.provider,
              runtimeModel: deps.embeddingProvider.model,
              runtimeDimensions: deps.embeddingProvider.dimensions,
              mismatches: compatibility.mismatches,
            },
          },
        );
      }
    }

    // Temporal anchor: only open-ended experiences make the score
    // time-dependent. Closed careers keep a stable (time-independent) identity.
    const hasOpenEnded = experiences.some((experience) => experience.endDate === null);
    const asOfDate = hasOpenEnded ? utcDateOnly(deps.clock.now()) : null;
    const matchingAsOfDate = asOfDate === null ? null : asOfDate.toISOString().slice(0, 10);

    const identityHash = computeIdentityHash({
      engineVersion: policy.engineVersion,
      weightsVersion: policy.weightsVersion,
      jobContentHash,
      candidateProfileHash,
      resumeSetHash,
      embeddingSpaceId: space?.id ?? null,
      matchingAsOfDate,
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
        matchingAsOfDate: row.matchingAsOfDate === null ? null : row.matchingAsOfDate.toISOString().slice(0, 10),
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
      {
        job,
        profile,
        skills,
        languages,
        experiences,
        resumes,
        resumeSemantics,
        asOfDate,
      },
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
      matchingAsOfDate: asOfDate,
      computedAt: deps.clock.now(),
    });

    logger.info(
      {
        jobId,
        candidateId,
        matchId: row.id,
        identityHash,
        embeddingSpaceId: space?.id ?? null,
        matchingAsOfDate,
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
      matchingAsOfDate,
    };
  }

  return { score };
}

export type MatchingService = ReturnType<typeof createMatchingService>;