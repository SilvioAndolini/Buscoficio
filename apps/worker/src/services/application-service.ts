import {
  createApplicationEngine,
  buildPolicyVersion,
  MAX_FACTUAL_REPAIR_ATTEMPTS,
  type ApplicationEngine,
  type CreateApplicationCommand,
} from '@job-system/application-engine';
import { createTextGenerationProvider } from '@job-system/ai';
import { buildCoverLetterPromptV1 } from '@job-system/ai/prompts';
import { createDocumentsService } from '@job-system/documents';
import {
  resolveTextRuntime,
  textApiKey,
  type Env,
} from '@job-system/shared';
import type {
  ApplicationRecord,
  Clock,
  CompletionResult,
  PreparationResult,
  StoragePort,
  StructuredRequest,
  StructuredResult,
  TextGenerationPort,
  TraceContext,
} from '@job-system/core';
import type { AiUsageRepo, ApplicationRepo } from '@job-system/database';
import { createApplicationRepositoryPort } from '@job-system/database';
import type { Logger } from '@job-system/observability';

/**
 * Composition of the Phase 4 application subsystem: database adapter + documents
 * + text provider + engine. Used by `apps/worker`; the API composes the same
 * factory for command endpoints (create/resolve/archive).
 */

function operationForSchema(schemaName: string | undefined): string {
  if (schemaName === 'cover_letter') return 'cover_letter';
  if (schemaName === 'answer') return 'answer';
  return 'other';
}

/**
 * Records every real text-generation call in `ai_usage` (task §55): provider,
 * model, latency, tokens when known, cost only when known (never invented),
 * applicationId/correlationId from the trace.
 */
export function createUsageRecordingTextProvider(
  inner: TextGenerationPort,
  aiUsageRepo: AiUsageRepo,
): TextGenerationPort {
  async function record(
    result: CompletionResult,
    operation: string,
    trace: TraceContext,
  ): Promise<void> {
    await aiUsageRepo.record({
      provider: result.provider,
      model: result.model,
      operation,
      latencyMs: result.latencyMs,
      cached: false,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costEstimateUsd: result.provider === 'mock' ? '0.000000' : null,
      applicationId: trace.applicationId ?? null,
      correlationId: trace.correlationId,
    });
  }
  return {
    provider: inner.provider,
    model: inner.model,
    async complete(request): Promise<CompletionResult> {
      const result = await inner.complete(request);
      await record(result, 'other', request.trace);
      return result;
    },
    async completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
      const result = await inner.completeStructured(request);
      await record(result, operationForSchema(request.schemaName), request.trace);
      return result;
    },
  };
}

export interface ApplicationServiceDeps {
  repo: ApplicationRepo;
  aiUsageRepo: AiUsageRepo;
  storage: StoragePort;
  clock: Clock;
  env: Env;
  logger: Logger;
  /** Test seam: scripted/alternative text provider. */
  textProvider?: TextGenerationPort;
}

export interface ApplicationService {
  engine: ApplicationEngine;
  createFromMatch(
    command: CreateApplicationCommand,
    trace: TraceContext,
  ): Promise<{ application: ApplicationRecord; created: boolean }>;
  prepare(applicationId: string, trace: TraceContext): Promise<PreparationResult>;
  resolveQuestion(
    applicationId: string,
    questionText: string,
    trace: TraceContext,
  ): ReturnType<ApplicationEngine['resolveQuestion']>;
  resolveHumanAction(applicationId: string, reason: string, trace: TraceContext): Promise<ApplicationRecord>;
  archive(applicationId: string, reason: string | undefined, trace: TraceContext): Promise<ApplicationRecord>;
}

export function createApplicationService(deps: ApplicationServiceDeps): ApplicationService {
  const textRuntime = resolveTextRuntime(deps.env);
  const baseProvider =
    deps.textProvider ??
    createTextGenerationProvider({
      provider: textRuntime.provider,
      model: textRuntime.model,
      apiKey: textApiKey(deps.env),
      baseUrl: deps.env.AI_BASE_URL,
    });
  const textProvider = createUsageRecordingTextProvider(baseProvider, deps.aiUsageRepo);
  const documents = createDocumentsService({ textProvider });
  const engine = createApplicationEngine({
    repo: createApplicationRepositoryPort(deps.repo),
    documents,
    storage: deps.storage,
    clock: deps.clock,
    policy: {
      version: buildPolicyVersion(
        deps.env.APPLICATION_PREPARATION_POLICY_VERSION,
        deps.env.REAPPLICATION_COOLDOWN_DAYS,
      ),
      reapplicationCooldownDays: deps.env.REAPPLICATION_COOLDOWN_DAYS,
      maxFactualRepairAttempts: MAX_FACTUAL_REPAIR_ATTEMPTS,
    },
  });

  return {
    engine,
    createFromMatch: (command, trace) => engine.createFromMatch(command, trace),
    prepare: (applicationId, trace) =>
      engine.prepareDocuments(applicationId, { buildCoverLetterPrompt: buildCoverLetterPromptV1 }, trace),
    resolveQuestion: (applicationId, questionText, trace) =>
      engine.resolveQuestion(applicationId, { questionText }, trace),
    resolveHumanAction: (applicationId, reason, trace) =>
      engine.resolveHumanAction(applicationId, { reason }, trace),
    archive: (applicationId, reason, trace) =>
      engine.archive(applicationId, reason === undefined ? {} : { reason }, trace),
  };
}
