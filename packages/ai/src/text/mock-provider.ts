import { AiError, type CompletionRequest, type CompletionResult, type StructuredRequest, type StructuredResult, type TextGenerationPort } from '@job-system/core';

/**
 * Deterministic offline provider for CI and tests (task §47). It never calls
 * the network and can simulate: valid structured output, schema-invalid output,
 * invented claims (the caller scripts the payload), provider errors/timeouts
 * and repair sequences. CI never depends on internet.
 */
export type MockTextResponse =
  | { kind: 'structured'; value: unknown }
  | { kind: 'invalid-schema'; value: unknown }
  | { kind: 'error'; message?: string; retryable?: boolean }
  | { kind: 'timeout' };

export interface MockTextGenerationProviderOptions {
  provider?: string;
  model?: string;
  /** Scripted responses consumed in order; exhausted ⇒ deterministic default. */
  responses?: MockTextResponse[];
  /** Overrides per schemaName when the script is exhausted. */
  defaultStructured?: Record<string, unknown>;
}

const DEFAULT_COVER_LETTER = {
  text: 'Dear hiring team,\n\nI am writing to apply for this position and would welcome the opportunity to discuss how my background fits your team.\n\nSincerely,',
  claims: [],
};

function defaultStructuredFor(schemaName: string): unknown {
  if (schemaName === 'cover_letter') return DEFAULT_COVER_LETTER;
  throw new AiError(
    `MockTextGenerationProvider has no default structured response for schema '${schemaName}'; script responses explicitly`,
  );
}

export class MockTextGenerationProvider implements TextGenerationPort {
  readonly provider: string;
  readonly model: string;
  /** Recorded calls for assertions (no PII beyond what the caller passed). */
  readonly calls: Array<{ promptVersion: string; inputHash: string; schemaName?: string }> = [];
  private readonly responses: MockTextResponse[];
  private readonly defaults: Record<string, unknown>;

  constructor(options: MockTextGenerationProviderOptions = {}) {
    this.provider = options.provider ?? 'mock';
    this.model = options.model ?? 'mock-text-v1';
    this.responses = [...(options.responses ?? [])];
    this.defaults = options.defaultStructured ?? {};
  }

  private nextResponse(): MockTextResponse | null {
    return this.responses.shift() ?? null;
  }

  private baseResult(request: CompletionRequest, text: string): CompletionResult {
    return {
      text,
      provider: this.provider,
      model: this.model,
      promptVersion: request.promptVersion,
      inputHash: request.inputHash,
      tokensIn: null,
      tokensOut: null,
      latencyMs: 0,
      finishReason: 'stop',
    };
  }

  private consume(request: CompletionRequest, schemaName?: string): MockTextResponse {
    this.calls.push({
      promptVersion: request.promptVersion,
      inputHash: request.inputHash,
      ...(schemaName === undefined ? {} : { schemaName }),
    });
    const response = this.nextResponse();
    if (response === null) {
      throw new AiError('MockTextGenerationProvider script exhausted');
    }
    return response;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = this.consume(request);
    switch (response.kind) {
      case 'structured':
        return this.baseResult(request, typeof response.value === 'string' ? response.value : JSON.stringify(response.value));
      case 'invalid-schema':
        throw new AiError('MockTextGenerationProvider: invalid output (schema)');
      case 'error':
        throw new AiError(response.message ?? 'MockTextGenerationProvider: scripted error', {
          retryable: response.retryable ?? false,
        });
      case 'timeout':
        throw new AiError('MockTextGenerationProvider: scripted timeout', { retryable: true });
    }
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push({
      promptVersion: request.promptVersion,
      inputHash: request.inputHash,
      schemaName: request.schemaName,
    });
    const response = this.nextResponse();
    if (response === null) {
      const fallback = this.defaults[request.schemaName] ?? defaultStructuredFor(request.schemaName);
      const parsed = request.schema.safeParse(fallback);
      if (!parsed.success) {
        throw new AiError('MockTextGenerationProvider: default response failed schema validation', {
          context: { schemaName: request.schemaName },
        });
      }
      return {
        ...this.baseResult(request, JSON.stringify(parsed.data)),
        value: parsed.data,
      };
    }
    switch (response.kind) {
      case 'structured':
      case 'invalid-schema': {
        const parsed = request.schema.safeParse(response.value);
        if (!parsed.success) {
          throw new AiError('MockTextGenerationProvider: response failed schema validation', {
            context: { schemaName: request.schemaName },
          });
        }
        if (response.kind === 'invalid-schema') {
          throw new AiError('MockTextGenerationProvider: scripted schema-invalid output');
        }
        return {
          ...this.baseResult(request, JSON.stringify(parsed.data)),
          value: parsed.data,
        };
      }
      case 'error':
        throw new AiError(response.message ?? 'MockTextGenerationProvider: scripted error', {
          retryable: response.retryable ?? false,
        });
      case 'timeout':
        throw new AiError('MockTextGenerationProvider: scripted timeout', { retryable: true });
    }
  }
}
