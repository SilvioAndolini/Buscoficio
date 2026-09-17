import { and, desc, eq, isNull } from 'drizzle-orm';
import type { IngestResult, NormalizedJob } from '@job-system/core';
import { NotFoundError } from '@job-system/core';
import { uuidv7 } from '@job-system/shared';
import type { Db } from '../client.js';
import * as t from '../schema.js';

export interface UpsertSourceData {
  key: string;
  name: string;
  kind: 'api' | 'rss' | 'html' | 'manual';
  capabilities: Record<string, unknown>;
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
        })
        .onConflictDoUpdate({
          target: t.jobSource.key,
          set: { name: data.name, capabilities: data.capabilities, updatedAt: new Date() },
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

    async upsertTarget(data: {
      key: string;
      kind: string;
      platform: string;
      label: string;
      baseUrl?: string | null;
      capabilities?: Record<string, unknown>;
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
        })
        .onConflictDoUpdate({
          target: t.applicationTarget.key,
          set: { label: data.label, updatedAt: new Date() },
        })
        .returning();
      return row!;
    },

    /**
     * Deterministic L0–L2 ingest (ADR-003): exact listing identity, canonical URL
     * and description fingerprint. Constraints are the last line of defense.
     */
    async ingestJob(data: IngestJobData): Promise<IngestResult> {
      try {
        return await db.transaction(async (tx) => {
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

          const n = data.normalized;
          const baseValues: typeof t.jobListing.$inferInsert = {
            id: uuidv7(),
            sourceId: data.sourceId,
            externalId: data.externalId,
            applicationTargetId: data.applicationTargetId,
            applicationTargetSignal: data.applicationTargetSignal,
            canonicalUrl: n.canonicalUrl,
            urlHash: data.urlHash,
            company: n.company,
            companyNorm: n.company.toLowerCase(),
            title: n.title,
            titleNorm: n.title.toLowerCase(),
            description: n.description,
            descriptionNorm: n.description.toLowerCase(),
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

          if (targetJobId) {
            const [listing] = await tx
              .insert(t.jobListing)
              .values({ ...baseValues, jobId: targetJobId })
              .returning();
            const [currentJob] = await tx
              .select({ mergedFrom: t.job.mergedFrom })
              .from(t.job)
              .where(eq(t.job.id, targetJobId))
              .limit(1);
            await tx
              .update(t.job)
              .set({
                mergedFrom: [...(currentJob?.mergedFrom ?? []), listing!.id],
                updatedAt: new Date(),
              })
              .where(eq(t.job.id, targetJobId));
            return { outcome: 'merged', listingId: listing!.id, jobId: targetJobId, reasons: [reason] };
          }

          const [job] = await tx
            .insert(t.job)
            .values({
              id: uuidv7(),
              company: n.company,
              companyNorm: n.company.toLowerCase(),
              title: n.title,
              titleNorm: n.title.toLowerCase(),
              description: n.description,
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
          return {
            outcome: 'new',
            listingId: listing!.id,
            jobId: job!.id,
            reasons: ['new canonical job created'],
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
        }
        throw error;
      }
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