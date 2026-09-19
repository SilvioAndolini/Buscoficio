import { AiError, type DecisionProvider, type DecisionRequest, type DecisionResult } from '@job-system/core';
import { ConfigError } from '@job-system/shared';

export interface MockDecision {
  decision: unknown;
  confidence: number;
  probabilities?: Record<string, number>;
}

/**
 * Deterministic decision provider for tests (task §49). It chooses between the
 * scripted bounded options only; it never writes text and never decides
 * business rules (score, CV, submission).
 */
export class MockDecisionProvider implements DecisionProvider {
  readonly provider = 'mock';
  readonly model = 'mock-decision-v1';
  private readonly queue: MockDecision[];
  readonly calls: Array<{ task: string; promptVersion: string }> = [];

  constructor(decisions: MockDecision[] = []) {
    this.queue = [...decisions];
  }

  async evaluate<TState, TDecision>(
    request: DecisionRequest<TState, TDecision>,
  ): Promise<DecisionResult<TDecision>> {
    this.calls.push({ task: request.task, promptVersion: request.promptVersion });
    const next = this.queue.shift();
    if (next === undefined) {
      throw new AiError('MockDecisionProvider has no scripted decision');
    }
    const parsed = request.schema.safeParse(next.decision);
    if (!parsed.success) {
      throw new AiError('MockDecisionProvider decision failed schema validation', {
        context: { task: request.task },
      });
    }
    return {
      decision: parsed.data,
      confidence: next.confidence,
      ...(next.probabilities === undefined ? {} : { probabilities: next.probabilities }),
      metadata: {
        provider: this.provider,
        model: this.model,
        latencyMs: 0,
        inputHash: `${request.task}:${request.promptVersion}`,
      },
    };
  }
}

export interface DecisionProviderFactoryConfig {
  provider: string;
}

/**
 * Decision infrastructure is ready for Phase 5 (Jev pilot). Phase 4 only
 * implements the mock; a configured `jev`/`llm-adapter` fails clearly instead
 * of silently degrading.
 */
export function createDecisionProvider(config: DecisionProviderFactoryConfig): DecisionProvider {
  if (config.provider === 'mock') return new MockDecisionProvider();
  throw new ConfigError([
    `DECISION_PROVIDER=${config.provider} is not implemented in Phase 4 (Jev pilot belongs to Phase 5); use mock`,
  ]);
}
