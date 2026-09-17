import { desc, eq } from 'drizzle-orm';
import { ConflictError, NotFoundError, type ResumeInput } from '@job-system/core';
import { uuidv7 } from '@job-system/shared';
import type { Db } from '../client.js';
import * as t from '../schema.js';

export interface CreateVersionData {
  kind: 'original' | 'tailored' | 'generated';
  parentVersionId?: string | null;
  highlights?: Record<string, unknown>;
  storageKey: string;
  fileHash: string;
}

export function createResumeRepo(db: Db) {
  return {
    async createResume(candidateId: string, input: ResumeInput) {
      return db.transaction(async (tx) => {
        if (input.isDefault) {
          await tx
            .update(t.resume)
            .set({ isDefault: false })
            .where(eq(t.resume.candidateId, candidateId));
        }
        const [row] = await tx
          .insert(t.resume)
          .values({
            id: uuidv7(),
            candidateId,
            name: input.name,
            category: input.category,
            language: input.language,
            isDefault: input.isDefault,
          })
          .returning();
        return row!;
      });
    },

    async listResumes() {
      return db.select().from(t.resume).orderBy(desc(t.resume.createdAt));
    },

    async getResume(id: string) {
      const [row] = await db.select().from(t.resume).where(eq(t.resume.id, id)).limit(1);
      if (!row) throw new NotFoundError(`Resume not found: ${id}`);
      return row;
    },

    async listVersions(resumeId: string) {
      return db
        .select()
        .from(t.resumeVersion)
        .where(eq(t.resumeVersion.resumeId, resumeId))
        .orderBy(desc(t.resumeVersion.versionNumber));
    },

    /**
     * Versions are append-only: content is never updated, only inserted.
     * The unique (resume_id, version_number) constraint is the last defense.
     */
    async createVersion(resumeId: string, data: CreateVersionData) {
      await this.getResume(resumeId);
      try {
        return await db.transaction(async (tx) => {
          const existing = await tx
            .select({ versionNumber: t.resumeVersion.versionNumber })
            .from(t.resumeVersion)
            .where(eq(t.resumeVersion.resumeId, resumeId))
            .orderBy(desc(t.resumeVersion.versionNumber))
            .limit(1);
          const next = (existing[0]?.versionNumber ?? 0) + 1;
          const [row] = await tx
            .insert(t.resumeVersion)
            .values({
              id: uuidv7(),
              resumeId,
              versionNumber: next,
              parentVersionId: data.parentVersionId ?? null,
              kind: data.kind,
              storageKey: data.storageKey,
              fileHash: data.fileHash,
              highlights: data.highlights ?? {},
            })
            .returning();
          return row!;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError('Concurrent resume version creation; retry the operation');
        }
        throw error;
      }
    },

    async getVersion(id: string) {
      const [row] = await db.select().from(t.resumeVersion).where(eq(t.resumeVersion.id, id)).limit(1);
      if (!row) throw new NotFoundError(`Resume version not found: ${id}`);
      return row;
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}