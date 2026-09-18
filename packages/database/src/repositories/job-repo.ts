import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { IngestFuzzyInfo, IngestResult, NormalizedJob } from '@job-system/core';
import {
  DEFAULT_DEDUP_THRESHOLDS,
  NotFoundError,
  computeFuzzyScore,
  normalizeForDedup,
  resolveFuzzyDecision,
  type DedupThresholds,
  type FilterDecision,
} from '@job-system/core';
import { uuidv7 } from '@job-system/shared';
import type { Db } from '../client.js';
import * as t from '../schema.js';

export interface UpsertSourceData {
  key: string;
  name: string;
  kind: 'api' | 'rss' | 'html' | 'manual';
  capabilities: Record<string, unknown>;
  policyNotes?: string | null;
}

export interface IngestJobData {
  sourceId: string;
  externalId: string;
  applicationTargetId: string | null;
  applicationTargetSignal: string | null;
  normalized: NormalizedJob;
  urlHash: string;
  dedupKey: string;
  contentHash: string;
  discoveredAt: Date;
  raw: unknown;
  /** L3 fuzzy dedup configuration; when absent only L0–L2 run. */
  fuzzy?: { thresholds: DedupThresholds };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

export function createJobRepo(db: Db) {
  const repo = {
    async upsertSource(data: UpsertSourceData) {
      const [row] = await db
        .insert(t.jobSource)
        .values({
          id: uuidv7(),
          key: data.key,
          name: data.name,
          kind: data.kind,
          capabilities: data.capabilities,
          ...(data.policyNotes === undefined ? {} : { policyNotes: data.policyNotes }),
        })
        .onConflictDoUpdate({
          target: t.jobSource.key,
          set: {
            name: data.name,
            capabilities: data.capabilities,
            ...(data.policyNotes === undefined ? {} : { policyNotes: data.policyNotes }),
            updatedAt: new Date(),
          },
        })
        .returning();
      return row!;
    },

    async getSourceByKey(key: string) {
      const [row] = await db.select().from(t.jobSource).where(eq(t.jobSource.key, key)).limit(1);
      return row ?? null;
    },

    async listSources() {
      return db.select().from(t.jobSource).orderBy(t.jobSource.key);
    },

    async updateSourceStatus(key: string, status: 'active' | 'paused' | 'blocked') {
      const [row] = await db
        .update(t.jobSource)
        .set({ status, updatedAt: new Date() })
        .where(eq(t.jobSource.key, key))
        .returning();
      if (!row) throw new NotFoundError(`Source not found: ${key}`);
      return row;
    },

    async upsertTarget(data: {
      key: string;
      kind: string;
      platform: string;
      label: string;
      baseUrl?: string | null;
      capabilities?: Record<string, unknown>;
      policyNotes?: string | null;
    }) {
      const [row] = await db
        .insert(t.applicationTarget)
        .values({
          id: uuidv7(),
          key: data.key,
          kind: data.kind,
          platform: data.platform,
          label: data.label,
          baseUrl: data.baseUrl ?? null,
          capabilities: data.capabilities ?? {},
          ...(data.policyNotes === undefined ? {} : { policyNotes: data.policyNotes }),
        })
        .onConflictDoUpdate({
          target: t.applicationTarget.key,
          set: {
            label: data.label,
            ...(data.policyNotes === undefined ? {} : { policyNotes: data.policyNotes }),
            updatedAt: new Date(),
          },
        })
        .returning();
      return row!;
    },

    /**
     * Deterministic L0–L3 ingest (ADR-003): exact listing identity, canonical
     * URL, description fingerprint and blocked fuzzy similarity (pg_trgm).
     * Constraints are the last line of defense.
     */
    async ingestJob(data: IngestJobData): Promise<IngestResult> {
      const n = data.normalized;
      const companyNorm = normalizeForDedup(n.company);
      const titleNorm = normalizeForDedup(n.title);
      const descriptionNorm = normalizeForDedup(n.description);
      const locationNorm = normalizeForDedup(n.location ?? '');

      const baseValues: typeof t.jobListing.$inferInsert = {
        id: uuidv7(),
        sourceId: data.sourceId,
        externalId: data.externalId,
        applicationTargetId: data.applicationTargetId,
        applicationTargetSignal: data.applicationTargetSignal,
        canonicalUrl: n.canonicalUrl,
        urlHash: data.urlHash,
        company: n.company,
        companyNorm,
        title: n.title,
        titleNorm,
        description: n.description,
        descriptionNorm,
        descriptionFingerprint: data.dedupKey,
        location: n.location,
        remoteType: n.remoteType,
        employmentType: n.employmentType,
        salaryMin: n.salaryMin,
        salaryMax: n.salaryMax,
        currency: n.currency,
        experienceLevel: n.experienceLevel,
        languageRequirements: [...n.languageRequirements],
        publishedAt: n.publishedAt,
        discoveredAt: data.discoveredAt,
        expiresAt: n.expiresAt,
        applicationMethod: n.applicationMethod,
        raw: data.raw,
        status: 'active',
        validated: true,
      };

      try {
        return await db.transaction(async (tx) => {
          // Serialize concurrent ingests of the same canonical URL across
          // workers (multi-source fan-out) — deterministic, transaction-scoped.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${data.urlHash}))`);

          const [existingListing] = await tx
            .select()
            .from(t.jobListing)
            .where(
              and(eq(t.jobListing.sourceId, data.sourceId), eq(t.jobListing.externalId, data.externalId)),
            )
            .limit(1);
          if (existingListing) {
            await tx
              .update(t.jobListing)
              .set({ status: 'active' })
              .where(eq(t.jobListing.id, existingListing.id));
            return {
              outcome: 'duplicate',
              listingId: existingListing.id,
              jobId: existingListing.jobId,
              reasons: ['L0: source+externalId already ingested'],
            };
          }

          const [listingByUrl] = await tx
            .select({ jobId: t.jobListing.jobId })
            .from(t.jobListing)
            .where(eq(t.jobListing.urlHash, data.urlHash))
            .limit(1);
          let targetJobId = listingByUrl?.jobId ?? null;
          let reason = 'L1: canonical URL already associated to a job';
          if (!targetJobId) {
            const [jobByDedup] = await tx
              .select({ id: t.job.id })
              .from(t.job)
              .where(eq(t.job.dedupKey, data.dedupKey))
              .limit(1);
            if (jobByDedup) {
              targetJobId = jobByDedup.id;
              reason = 'L2: description fingerprint matched an existing job';
            }
          }

          let fuzzyInfo: IngestFuzzyInfo | undefined;
          if (!targetJobId && data.fuzzy) {
            const thresholds = data.fuzzy.thresholds ?? DEFAULT_DEDUP_THRESHOLDS;
            const candidates = await tx.execute(sql`
              select id,
                     similarity(title_norm, ${titleNorm}) as title_sim,
                     similarity(description_norm, ${descriptionNorm}) as desc_sim
              from ${t.job}
              where company_norm = ${companyNorm}
                and location_norm = ${locationNorm}
                and status <> 'archived'
              order by (0.6 * similarity(title_norm, ${titleNorm}) + 0.4 * similarity(description_norm, ${descriptionNorm})) desc
              limit 1
            `);
            const candidate = (
              candidates.rows as Array<{ id: string; title_sim: number | string; desc_sim: number | string }>
            )[0];
            if (candidate) {
              const titleSimilarity = Number(candidate.title_sim);
              const descriptionSimilarity = Number(candidate.desc_sim);
              const score = computeFuzzyScore(titleSimilarity, descriptionSimilarity);
              const decision = resolveFuzzyDecision(score, thresholds);
              fuzzyInfo = {
                decision,
                candidateJobId: candidate.id,
                score,
                titleSimilarity,
                descriptionSimilarity,
              };
              if (decision === 'merge') {
                targetJobId = candidate.id;
                reason = `L3: fuzzy merge (score ${score.toFixed(3)} >= high ${thresholds.high})`;
              }
            } else {
              fuzzyInfo = {
                decision: 'distinct',
                candidateJobId: null,
                score: null,
                titleSimilarity: null,
                descriptionSimilarity: null,
              };
            }
          }

          if (targetJobId) {
            const [listing] = await tx
              .insert(t.jobListing)
              .values({ ...baseValues, jobId: targetJobId })
              .returning();
            const [currentJob] = await tx
              .select({
                mergedFrom: t.job.mergedFrom,
                applicationTargetId: t.job.applicationTargetId,
              })
              .from(t.job)
              .where(eq(t.job.id, targetJobId))
              .limit(1);

            const reasons = [reason];
            const targetUpdate: {
              applicationTargetId?: string;
              applicationTargetResolvedAt?: Date;
            } = {};
            if (data.applicationTargetId !== null) {
              const currentTargetId = currentJob?.applicationTargetId ?? null;
              if (currentTargetId === null) {
                targetUpdate.applicationTargetId = data.applicationTargetId;
                targetUpdate.applicationTargetResolvedAt = data.discoveredAt;
                reasons.push('application target promoted from merged listing');
              } else if (currentTargetId !== data.applicationTargetId) {
                reasons.push(
                  `application target conflict kept existing (${currentTargetId}); merged listing offered (${data.applicationTargetId})`,
                );
              }
            }

            await tx
              .update(t.job)
              .set({
                mergedFrom: [...(currentJob?.mergedFrom ?? []), listing!.id],
                updatedAt: new Date(),
                ...targetUpdate,
              })
              .where(eq(t.job.id, targetJobId));
            return {
              outcome: 'merged',
              listingId: listing!.id,
              jobId: targetJobId,
              reasons,
              ...(fuzzyInfo === undefined ? {} : { fuzzy: fuzzyInfo }),
            };
          }

          const [job] = await tx
            .insert(t.job)
            .values({
              id: uuidv7(),
              company: n.company,
              companyNorm,
              title: n.title,
              titleNorm,
              description: n.description,
              descriptionNorm,
              location: n.location,
              locationNorm,
              remoteType: n.remoteType,
              employmentType: n.employmentType,
              salaryMin: n.salaryMin,
              salaryMax: n.salaryMax,
              currency: n.currency,
              experienceLevel: n.experienceLevel,
              languageRequirements: [...n.languageRequirements],
              publishedAt: n.publishedAt,
              discoveredAt: data.discoveredAt,
              expiresAt: n.expiresAt,
              applicationMethod: n.applicationMethod,
              applicationTargetId: data.applicationTargetId,
              applicationTargetResolvedAt: data.applicationTargetId ? data.discoveredAt : null,
              dedupKey: data.dedupKey,
              contentHash: data.contentHash,
            })
            .returning();
          const [listing] = await tx
            .insert(t.jobListing)
            .values({ ...baseValues, jobId: job!.id })
            .returning();
          await tx
            .update(t.job)
            .set({ primaryListingId: listing!.id })
            .where(eq(t.job.id, job!.id));

          const reasons = ['new canonical job created'];
          let reviewId: string | null = null;
          if (fuzzyInfo && fuzzyInfo.decision === 'review' && fuzzyInfo.candidateJobId !== null) {
            const [review] = await tx
              .insert(t.dedupReview)
              .values({
                id: uuidv7(),
                candidateJobId: fuzzyInfo.candidateJobId,
                createdJobId: job!.id,
                listingId: listing!.id,
                sourceId: data.sourceId,
                score: fuzzyInfo.score!.toFixed(4),
                titleSimilarity: fuzzyInfo.titleSimilarity!.toFixed(4),
                descriptionSimilarity: fuzzyInfo.descriptionSimilarity!.toFixed(4),
                reasons: {
                  note: 'L3 gray zone: similarity above medium and below high threshold',
                  score: fuzzyInfo.score,
                  titleSimilarity: fuzzyInfo.titleSimilarity,
                  descriptionSimilarity: fuzzyInfo.descriptionSimilarity,
                },
              })
              .returning();
            reviewId = review!.id;
            reasons.push(
              `L3: gray zone queued for human review (score ${fuzzyInfo.score!.toFixed(3)})`,
            );
          }

          return {
            outcome: 'new',
            listingId: listing!.id,
            jobId: job!.id,
            reasons,
            ...(fuzzyInfo === undefined ? {} : { fuzzy: fuzzyInfo }),
            reviewId,
          };
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          const [existing] = await db
            .select()
            .from(t.jobListing)
            .where(
              and(eq(t.jobListing.sourceId, data.sourceId), eq(t.jobListing.externalId, data.externalId)),
            )
            .limit(1);
          if (existing) {
            return {
              outcome: 'duplicate',
              listingId: existing.id,
              jobId: existing.jobId,
              reasons: ['L0: unique constraint recovered a concurrent duplicate'],
            };
          }
          // Concurrent fan-out lost the canonical job creation race: attach to
          // the winner by dedup key instead of failing the source run.
          const [jobByDedup] = await db
            .select({ id: t.job.id })
            .from(t.job)
            .where(eq(t.job.dedupKey, data.dedupKey))
            .limit(1);
          if (jobByDedup) {
            const [listing] = await db
              .insert(t.jobListing)
              .values({ ...baseValues, jobId: jobByDedup.id })
              .returning();
            return {
              outcome: 'merged',
              listingId: listing!.id,
              jobId: jobByDedup.id,
              reasons: ['L2: unique constraint recovered a concurrent canonical job creation'],
            };
          }
        }
        throw error;
      }
    },

    /** Hard-filter rejection with explicit rule + reason (never silent). */
    async markJobRejected(jobId: string, decision: FilterDecision) {
      const [row] = await db
        .update(t.job)
        .set({
          status: 'rejected',
          metadata: sql`coalesce(${t.job.metadata}, '{}'::jsonb) || ${JSON.stringify({
            filterDecision: {
              allowed: false,
              rejections: decision.rejections,
              decidedAt: new Date().toISOString(),
            },
          })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(t.job.id, jobId))
        .returning();
      if (!row) throw new NotFoundError(`Job not found: ${jobId}`);
      return row;
    },

    /** Quarantine: malformed offer persisted without aborting the batch. */
    async insertQuarantine(data: {
      sourceId: string;
      externalId: string;
      raw: unknown;
      errors: unknown;
    }) {
      const [row] = await db
        .insert(t.jobListing)
        .values({
          id: uuidv7(),
          sourceId: data.sourceId,
          externalId: data.externalId,
          applicationMethod: 'unknown',
          raw: data.raw,
          validated: false,
          validationErrors: data.errors,
          jobId: null,
          status: 'active',
        })
        .onConflictDoNothing({ target: [t.jobListing.sourceId, t.jobListing.externalId] })
        .returning();
      return row ?? null;
    },

    async listJobs(options: { limit: number; offset: number; status?: string }) {
      const where = options.status ? eq(t.job.status, options.status) : undefined;
      const rows = await db
        .select({
          job: t.job,
          primaryListing: t.jobListing,
        })
        .from(t.job)
        .leftJoin(t.jobListing, eq(t.job.primaryListingId, t.jobListing.id))
        .where(where)
        .orderBy(desc(t.job.discoveredAt))
        .limit(options.limit)
        .offset(options.offset);
      return rows;
    },

    async getJobWithListings(id: string) {
      const [jobRow] = await db.select().from(t.job).where(eq(t.job.id, id)).limit(1);
      if (!jobRow) throw new NotFoundError(`Job not found: ${id}`);
      const listings = await db
        .select({
          listing: t.jobListing,
          sourceKey: t.jobSource.key,
        })
        .from(t.jobListing)
        .innerJoin(t.jobSource, eq(t.jobListing.sourceId, t.jobSource.id))
        .where(eq(t.jobListing.jobId, id))
        .orderBy(t.jobListing.discoveredAt);
      const [target] = jobRow.applicationTargetId
        ? await db
            .select()
            .from(t.applicationTarget)
            .where(eq(t.applicationTarget.id, jobRow.applicationTargetId))
            .limit(1)
        : [];
      return { job: jobRow, listings, applicationTarget: target ?? null };
    },

    async listQuarantinedListings(sourceId: string) {
      return db
        .select()
        .from(t.jobListing)
        .where(
          and(eq(t.jobListing.sourceId, sourceId), eq(t.jobListing.validated, false), isNull(t.jobListing.jobId)),
        )
        .orderBy(desc(t.jobListing.discoveredAt));
    },

    async countJobs() {
      const rows = await db.select({ id: t.job.id }).from(t.job);
      return rows.length;
    },
  };
  return repo;
}