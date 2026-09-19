import type { z } from 'zod';
import type { TraceContext } from './trace.js';

/**
 * Provider-agnostic text generation port (architecture docs 05 §2.2, 08 §1).
 * `documents` depends only on this contract; implementations live in
 * `packages/ai` and are injected by the composition root.
 */
export interface CompletionRequest {
  /** System instructions; external content never belongs here. */
  system: string;
  /** User content; untrusted external text must be delimited by the caller. */
  user: string;
  promptVersion: string;
  /** sha256 of the exact prompt input (cache/provenance key). */
  inputHash: string;
  trace: TraceContext;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  promptVersion: string;
  inputHash: string;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  finishReason: string | null;
}

export interface StructuredRequest<T> extends CompletionRequest {
  /** Structured output is mandatory to cross this boundary (Zod). */
  schema: z.ZodType<T>;
  schemaName: string;
}

export interface StructuredResult<T> extends CompletionResult {
  value: T;
}

export interface TextGenerationPort {
  readonly provider: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}
