import type { z } from 'zod';
import type { TraceContext } from './trace.js';

/**
 * Typed-decision port (Jev / System One): chooses between bounded options with
 * calibrated confidence. It never writes text, never decides business rules
 * (score, eligibility, CV choice, submission) and never executes actions
 * (architecture docs 03 §9, 05 §2.2, 08 §2).
 */
export const DecisionTaskSchema = [
  'map_form_field',
  'choose_action',
  'classify_field_type',
  'route_question',
  'guardrail_check',
  'classify_job_category',
] as const;
export type DecisionTask = (typeof DecisionTaskSchema)[number];

export interface DecisionOption {
  key: string;
  label: string;
}

export interface DecisionRequest<TState, TDecision> {
  task: DecisionTask;
  state: TState;
  schema: z.ZodType<TDecision>;
  /** Bounded options (cardinality <= 255 recommended). */
  options?: DecisionOption[];
  threshold?: number;
  promptVersion: string;
  trace: TraceContext;
}

export interface DecisionResult<TDecision> {
  decision: TDecision;
  confidence: number;
  probabilities?: Record<string, number>;
  metadata: {
    provider: string;
    model: string;
    latencyMs: number;
    inputHash: string;
  };
}

export interface DecisionProvider {
  readonly provider: string;
  readonly model: string;
  evaluate<TState, TDecision>(
    request: DecisionRequest<TState, TDecision>,
  ): Promise<DecisionResult<TDecision>>;
}
