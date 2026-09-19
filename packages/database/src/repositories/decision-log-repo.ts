import { uuidv7 } from '@job-system/shared';
import type { Db } from '../client.js';
import * as t from '../schema.js';

/**
 * Decision log plumbing (doc 04 §2.8, task §49). Infrastructure ready for the
 * Phase 5 Jev pilot; Phase 4 only records decisions when a DecisionProvider is
 * exercised (mock in tests).
 */
export interface DecisionLogEntry {
  task: string;
  provider: string;
  model: string;
  inputHash: string;
  proposed: unknown;
  chosen?: unknown;
  confidence?: string | null;
  threshold?: string | null;
  outcome?: string;
  applicationId?: string | null;
  automationRunId?: string | null;
  correlationId?: string | null;
}

export function createDecisionLogRepo(db: Db) {
  return {
    async record(entry: DecisionLogEntry) {
      const [row] = await db
        .insert(t.decisionLog)
        .values({
          id: uuidv7(),
          task: entry.task,
          provider: entry.provider,
          model: entry.model,
          inputHash: entry.inputHash,
          proposed: entry.proposed as Record<string, unknown>,
          chosen: (entry.chosen ?? null) as Record<string, unknown> | null,
          confidence: entry.confidence ?? null,
          threshold: entry.threshold ?? null,
          outcome: entry.outcome ?? 'pending',
          applicationId: entry.applicationId ?? null,
          automationRunId: entry.automationRunId ?? null,
          correlationId: entry.correlationId ?? null,
        })
        .returning();
      return row!;
    },
  };
}
