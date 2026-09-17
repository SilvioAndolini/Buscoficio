import { desc, eq, and } from 'drizzle-orm';
import { uuidv7 } from '@job-system/shared';
import type { Db } from '../client.js';
import * as t from '../schema.js';

export interface AuditEntry {
  actor: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  correlationId?: string | null;
}

export function createAuditRepo(db: Db) {
  return {
    async append(entry: AuditEntry) {
      const [row] = await db
        .insert(t.auditLog)
        .values({
          id: uuidv7(),
          actor: entry.actor,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          before: entry.before ?? null,
          after: entry.after ?? null,
          ip: entry.ip ?? null,
          correlationId: entry.correlationId ?? null,
        })
        .returning();
      return row!;
    },

    async listForEntity(entityType: string, entityId: string) {
      return db
        .select()
        .from(t.auditLog)
        .where(and(eq(t.auditLog.entityType, entityType), eq(t.auditLog.entityId, entityId)))
        .orderBy(desc(t.auditLog.createdAt));
    },
  };
}