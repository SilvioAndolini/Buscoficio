import { uuidv7 } from '@job-system/shared';
import type { Db } from '../client.js';
import * as t from '../schema.js';

export interface AiUsageEntry {
  provider: string;
  model: string;
  operation: string;
  latencyMs: number;
  cached: boolean;
  jobId?: string | null;
  applicationId?: string | null;
  correlationId?: string | null;
  costEstimateUsd?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  confidence?: string | null;
}

/**
 * AI usage ledger (doc 04 §2.8). Phase 3 records embedding operations; Phase 4
 * adds `cover_letter`/`answer` with `applicationId`. Costs are only persisted
 * when actually known (never invented).
 */
export function createAiUsageRepo(db: Db) {
  return {
    async record(entry: AiUsageEntry) {
      const [row] = await db
        .insert(t.aiUsage)
        .values({
          id: uuidv7(),
          provider: entry.provider,
          model: entry.model,
          operation: entry.operation,
          latencyMs: entry.latencyMs,
          cached: entry.cached,
          jobId: entry.jobId ?? null,
          applicationId: entry.applicationId ?? null,
          correlationId: entry.correlationId ?? null,
          costEstimateUsd: entry.costEstimateUsd ?? null,
          tokensIn: entry.tokensIn ?? null,
          tokensOut: entry.tokensOut ?? null,
          confidence: entry.confidence ?? null,
        })
        .returning();
      return row!;
    },
  };
}

export type AiUsageRepo = ReturnType<typeof createAiUsageRepo>;
