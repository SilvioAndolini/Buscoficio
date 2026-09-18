import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { NotFoundError } from '@job-system/core';
import { uuidv7 } from '@job-system/shared';
import type { Db } from '../client.js';
import * as t from '../schema.js';

export interface EnsureEmbeddingSpaceData {
  key: string;
  provider: string;
  model: string;
  dimensions: number;
  distanceMetric: 'cosine' | 'l2' | 'ip';
  version: string;
}

export interface UpsertEmbeddingData {
  contentHash: string;
  embedding: number[];
}

export interface UpsertMatchData {
  jobId: string;
  candidateId: string;
  overallScore: number;
  scoreBreakdown: unknown;
  reasons: string[];
  missingRequirements: string[];
  matchingSkills: string[];
  recommendedResumeId: string | null;
  engineVersion: string;
  weightsVersion: string;
  jobContentHash: string;
  candidateProfileHash: string;
  resumeSetHash: string;
  embeddingSpaceId: string | null;
  identityHash: string;
  semanticModel: string | null;
  /** Temporal anchor for open-ended experiences; null when time-independent. */
  matchingAsOfDate: Date | null;
  computedAt: Date;
}

export interface MatchWithJob {
  match: t.JobMatchRow;
  job: t.JobRow;
  recommendedResume: t.ResumeRow | null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

export function createMatchingRepo(db: Db) {
  const repo = {
    /* ----------------------------- spaces ----------------------------- */

    async listEmbeddingSpaces() {
      return db.select().from(t.embeddingSpace).orderBy(desc(t.embeddingSpace.createdAt));
    },

    async getEmbeddingSpaceById(id: string) {
      const [row] = await db
        .select()
        .from(t.embeddingSpace)
        .where(eq(t.embeddingSpace.id, id))
        .limit(1);
      return row ?? null;
    },

    /** Deterministic active-space resolution (partial unique guarantees ≤1). */
    async getActiveEmbeddingSpace() {
      const [row] = await db
        .select()
        .from(t.embeddingSpace)
        .where(eq(t.embeddingSpace.status, 'active'))
        .orderBy(desc(t.embeddingSpace.createdAt), desc(t.embeddingSpace.id))
        .limit(1);
      return row ?? null;
    },

    /**
     * Bootstrap rule: the configured space is created if missing and becomes
     * active only when no space is active. Deterministic and idempotent.
     */
    async ensureEmbeddingSpace(data: EnsureEmbeddingSpaceData) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('embedding-space-bootstrap'))`);
        const [existing] = await tx
          .select()
          .from(t.embeddingSpace)
          .where(
            and(
              eq(t.embeddingSpace.provider, data.provider),
              eq(t.embeddingSpace.model, data.model),
              eq(t.embeddingSpace.dimensions, data.dimensions),
              eq(t.embeddingSpace.version, data.version),
            ),
          )
          .limit(1);
        let row = existing;
        if (!row) {
          [row] = await tx
            .insert(t.embeddingSpace)
            .values({
              id: uuidv7(),
              key: data.key,
              provider: data.provider,
              model: data.model,
              dimensions: data.dimensions,
              distanceMetric: data.distanceMetric,
              version: data.version,
              status: 'inactive',
            })
            .onConflictDoNothing({ target: t.embeddingSpace.key })
            .returning();
          if (!row) {
            [row] = await tx
              .select()
              .from(t.embeddingSpace)
              .where(eq(t.embeddingSpace.key, data.key))
              .limit(1);
          }
        }
        const [active] = await tx
          .select()
          .from(t.embeddingSpace)
          .where(eq(t.embeddingSpace.status, 'active'))
          .limit(1);
        if (!active && row) {
          [row] = await tx
            .update(t.embeddingSpace)
            .set({ status: 'active' })
            .where(eq(t.embeddingSpace.id, row.id))
            .returning();
        }
        return row!;
      });
    },

    /** Activates one space and deactivates the previous active one (same tx). */
    async activateEmbeddingSpace(id: string) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(t.embeddingSpace)
          .where(eq(t.embeddingSpace.id, id))
          .limit(1);
        if (!row) throw new NotFoundError(`Embedding space not found: ${id}`);
        await tx
          .update(t.embeddingSpace)
          .set({ status: 'inactive' })
          .where(eq(t.embeddingSpace.status, 'active'));
        const [updated] = await tx
          .update(t.embeddingSpace)
          .set({ status: 'active' })
          .where(eq(t.embeddingSpace.id, id))
          .returning();
        return updated!;
      });
    },

    /* --------------------------- embeddings --------------------------- */

    async getJobEmbedding(jobId: string, embeddingSpaceId: string) {
      const [row] = await db
        .select()
        .from(t.jobEmbedding)
        .where(
          and(eq(t.jobEmbedding.jobId, jobId), eq(t.jobEmbedding.embeddingSpaceId, embeddingSpaceId)),
        )
        .limit(1);
      return row ?? null;
    },

    /** Cache write: only called on miss/different contentHash (no blind rewrites). */
    async upsertJobEmbedding(jobId: string, embeddingSpaceId: string, data: UpsertEmbeddingData) {
      const [row] = await db
        .insert(t.jobEmbedding)
        .values({
          jobId,
          embeddingSpaceId,
          contentHash: data.contentHash,
          embedding: data.embedding,
        })
        .onConflictDoUpdate({
          target: [t.jobEmbedding.jobId, t.jobEmbedding.embeddingSpaceId],
          set: { contentHash: data.contentHash, embedding: data.embedding, createdAt: new Date() },
        })
        .returning();
      return row!;
    },

    async getResumeEmbedding(resumeVersionId: string, embeddingSpaceId: string) {
      const [row] = await db
        .select()
        .from(t.resumeEmbedding)
        .where(
          and(
            eq(t.resumeEmbedding.resumeVersionId, resumeVersionId),
            eq(t.resumeEmbedding.embeddingSpaceId, embeddingSpaceId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async upsertResumeEmbedding(
      resumeVersionId: string,
      embeddingSpaceId: string,
      data: UpsertEmbeddingData,
    ) {
      const [row] = await db
        .insert(t.resumeEmbedding)
        .values({
          resumeVersionId,
          embeddingSpaceId,
          contentHash: data.contentHash,
          embedding: data.embedding,
        })
        .onConflictDoUpdate({
          target: [t.resumeEmbedding.resumeVersionId, t.resumeEmbedding.embeddingSpaceId],
          set: { contentHash: data.contentHash, embedding: data.embedding, createdAt: new Date() },
        })
        .returning();
      return row!;
    },

    /* ------------------------- candidate context ---------------------- */

    async getMatchJob(jobId: string) {
      const [row] = await db.select().from(t.job).where(eq(t.job.id, jobId)).limit(1);
      if (!row) throw new NotFoundError(`Job not found: ${jobId}`);
      return row;
    },

    async getCandidateMatchContext(candidateId: string) {
      const [profile] = await db
        .select()
        .from(t.candidateProfile)
        .where(eq(t.candidateProfile.id, candidateId))
        .limit(1);
      if (!profile) throw new NotFoundError(`Candidate profile not found: ${candidateId}`);
      const skills = await db
        .select({
          skillName: t.skill.canonicalName,
          aliases: t.skill.aliases,
          level: t.candidateSkill.level,
          years: t.candidateSkill.years,
        })
        .from(t.candidateSkill)
        .innerJoin(t.skill, eq(t.candidateSkill.skillId, t.skill.id))
        .where(eq(t.candidateSkill.candidateId, candidateId))
        .orderBy(t.skill.canonicalName);
      const languages = await db
        .select({
          language: t.candidateLanguage.language,
          level: t.candidateLanguage.level,
        })
        .from(t.candidateLanguage)
        .where(eq(t.candidateLanguage.candidateId, candidateId))
        .orderBy(t.candidateLanguage.language);
      const experiences = await db
        .select({
          company: t.experience.company,
          title: t.experience.title,
          startDate: t.experience.startDate,
          endDate: t.experience.endDate,
          skills: t.experience.skills,
        })
        .from(t.experience)
        .where(eq(t.experience.candidateId, candidateId))
        .orderBy(desc(t.experience.startDate));
      return {
        profile,
        skills: skills.map((row) => ({
          ...row,
          years: row.years === null ? null : Number(row.years),
        })),
        languages,
        experiences,
      };
    },

    async listResumesWithLatestVersion(candidateId: string) {
      const resumes = await db
        .select()
        .from(t.resume)
        .where(eq(t.resume.candidateId, candidateId))
        .orderBy(t.resume.createdAt, t.resume.id);
      const result: Array<{ resume: t.ResumeRow; latestVersion: t.ResumeVersionRow | null }> = [];
      for (const resume of resumes) {
        const [version] = await db
          .select()
          .from(t.resumeVersion)
          .where(eq(t.resumeVersion.resumeId, resume.id))
          .orderBy(desc(t.resumeVersion.versionNumber))
          .limit(1);
        result.push({ resume, latestVersion: version ?? null });
      }
      return result;
    },

    /* ---------------------------- job_match --------------------------- */

    async findMatchByIdentity(jobId: string, candidateId: string, identityHash: string) {
      const [row] = await db
        .select()
        .from(t.jobMatch)
        .where(
          and(
            eq(t.jobMatch.jobId, jobId),
            eq(t.jobMatch.candidateId, candidateId),
            eq(t.jobMatch.identityHash, identityHash),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async getCurrentMatch(jobId: string, candidateId: string) {
      const [row] = await db
        .select()
        .from(t.jobMatch)
        .where(
          and(
            eq(t.jobMatch.jobId, jobId),
            eq(t.jobMatch.candidateId, candidateId),
            eq(t.jobMatch.isCurrent, true),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async getCurrentMatchWithResume(jobId: string, candidateId: string) {
      const [row] = await db
        .select({ match: t.jobMatch, recommendedResume: t.resume })
        .from(t.jobMatch)
        .leftJoin(t.resume, eq(t.jobMatch.recommendedResumeId, t.resume.id))
        .where(
          and(
            eq(t.jobMatch.jobId, jobId),
            eq(t.jobMatch.candidateId, candidateId),
            eq(t.jobMatch.isCurrent, true),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async getMatchById(id: string) {
      const [row] = await db.select().from(t.jobMatch).where(eq(t.jobMatch.id, id)).limit(1);
      return row ?? null;
    },

    /**
     * Makes an existing historical row current again (same input recomputed).
     * Transactional; the previous current row is unset in the same operation.
     */
    async setCurrentMatch(jobId: string, candidateId: string, matchId: string) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${jobId}|${candidateId}`}))`,
        );
        const [target] = await tx
          .select()
          .from(t.jobMatch)
          .where(eq(t.jobMatch.id, matchId))
          .limit(1);
        if (!target) throw new NotFoundError(`Job match not found: ${matchId}`);
        if (target.isCurrent) return target;
        await tx
          .update(t.jobMatch)
          .set({ isCurrent: false })
          .where(
            and(
              eq(t.jobMatch.jobId, jobId),
              eq(t.jobMatch.candidateId, candidateId),
              eq(t.jobMatch.isCurrent, true),
            ),
          );
        const [updated] = await tx
          .update(t.jobMatch)
          .set({ isCurrent: true })
          .where(eq(t.jobMatch.id, matchId))
          .returning();
        return updated!;
      });
    },

    async listMatchHistory(jobId: string, candidateId: string) {
      return db
        .select()
        .from(t.jobMatch)
        .where(and(eq(t.jobMatch.jobId, jobId), eq(t.jobMatch.candidateId, candidateId)))
        .orderBy(desc(t.jobMatch.computedAt));
    },

    async listCurrentMatches(options: {
      candidateId: string;
      limit: number;
      offset: number;
      minScore?: number;
    }): Promise<MatchWithJob[]> {
      const conditions = [
        eq(t.jobMatch.candidateId, options.candidateId),
        eq(t.jobMatch.isCurrent, true),
      ];
      if (options.minScore !== undefined) {
        conditions.push(gte(t.jobMatch.overallScore, options.minScore.toFixed(4)));
      }
      return db
        .select({ match: t.jobMatch, job: t.job, recommendedResume: t.resume })
        .from(t.jobMatch)
        .innerJoin(t.job, eq(t.jobMatch.jobId, t.job.id))
        .leftJoin(t.resume, eq(t.jobMatch.recommendedResumeId, t.resume.id))
        .where(and(...conditions))
        .orderBy(desc(t.jobMatch.overallScore), desc(t.jobMatch.computedAt))
        .limit(options.limit)
        .offset(options.offset);
    },

    async countCurrentMatches(candidateId: string, minScore?: number) {
      const conditions = [eq(t.jobMatch.candidateId, candidateId), eq(t.jobMatch.isCurrent, true)];
      if (minScore !== undefined) {
        conditions.push(gte(t.jobMatch.overallScore, minScore.toFixed(4)));
      }
      const [row] = await db
        .select({ total: count() })
        .from(t.jobMatch)
        .where(and(...conditions));
      return Number(row?.total ?? 0);
    },

    /**
     * Idempotent current-match persistence (invariant M1/M4):
     *  - same identity  -> reuse the existing row (never a duplicate);
     *  - new identity   -> unset the previous current row and insert the new
     *    one in the same transaction;
     *  - concurrency    -> advisory lock per (job, candidate) + unique
     *    constraint recovery.
     */
    async upsertCurrentMatch(input: UpsertMatchData): Promise<{ row: t.JobMatchRow; created: boolean }> {
      const lockKey = `${input.jobId}|${input.candidateId}`;
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
          const [existing] = await tx
            .select()
            .from(t.jobMatch)
            .where(
              and(
                eq(t.jobMatch.jobId, input.jobId),
                eq(t.jobMatch.candidateId, input.candidateId),
                eq(t.jobMatch.identityHash, input.identityHash),
              ),
            )
            .limit(1);
          if (existing) {
            if (!existing.isCurrent) {
              await tx
                .update(t.jobMatch)
                .set({ isCurrent: false })
                .where(
                  and(
                    eq(t.jobMatch.jobId, input.jobId),
                    eq(t.jobMatch.candidateId, input.candidateId),
                    eq(t.jobMatch.isCurrent, true),
                  ),
                );
              const [updated] = await tx
                .update(t.jobMatch)
                .set({ isCurrent: true })
                .where(eq(t.jobMatch.id, existing.id))
                .returning();
              return { row: updated!, created: false };
            }
            return { row: existing, created: false };
          }

          await tx
            .update(t.jobMatch)
            .set({ isCurrent: false })
            .where(
              and(
                eq(t.jobMatch.jobId, input.jobId),
                eq(t.jobMatch.candidateId, input.candidateId),
                eq(t.jobMatch.isCurrent, true),
              ),
            );
          const [row] = await tx
            .insert(t.jobMatch)
            .values({
              id: uuidv7(),
              jobId: input.jobId,
              candidateId: input.candidateId,
              overallScore: input.overallScore.toFixed(4),
              scoreBreakdown: input.scoreBreakdown,
              reasons: [...input.reasons],
              missingRequirements: [...input.missingRequirements],
              matchingSkills: [...input.matchingSkills],
              recommendedResumeId: input.recommendedResumeId,
              engineVersion: input.engineVersion,
              weightsVersion: input.weightsVersion,
              jobContentHash: input.jobContentHash,
              candidateProfileHash: input.candidateProfileHash,
              resumeSetHash: input.resumeSetHash,
              embeddingSpaceId: input.embeddingSpaceId,
              identityHash: input.identityHash,
              isCurrent: true,
              semanticModel: input.semanticModel,
              matchingAsOfDate: input.matchingAsOfDate,
              computedAt: input.computedAt,
            })
            .returning();
          return { row: row!, created: true };
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Concurrent worker created the same identity first: reuse its row.
          const existing = await repo.findMatchByIdentity(
            input.jobId,
            input.candidateId,
            input.identityHash,
          );
          if (existing) return { row: existing, created: false };
        }
        throw error;
      }
    },
  };
  return repo;
}

export type MatchingRepo = ReturnType<typeof createMatchingRepo>;
