import { AiError, type CompletionRequest, type CompletionResult, type StructuredRequest, type StructuredResult, type TextGenerationPort } from '@job-system/core';

export interface OpenAiCompatibleProviderOptions {
  /** `openai` | `deepseek` (documented OpenAI-compatible chat completions). */
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * OpenAI-compatible chat completions adapter (documented endpoints only).
 * Used by `openai` and `deepseek`; the composition root never guesses a URL.
 */
export class OpenAiCompatibleTextProvider implements TextGenerationPort {
  readonly provider: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async post(
    request: CompletionRequest,
    body: Record<string, unknown>,
  ): Promise<{ text: string; tokensIn: number | null; tokensOut: number | null; finishReason: string | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? this.defaultTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const retryable = response.status === 429 || response.status >= 500;
        throw new AiError(
          `${this.provider} text generation failed with status ${response.status}`,
          { retryable, context: { status: response.status, detail: detail.slice(0, 500) } },
        );
      }
      const payload = (await response.json()) as ChatCompletionResponse;
      const text = payload.choices?.[0]?.message?.content ?? '';
      if (text.trim().length === 0) {
        throw new AiError(`${this.provider} returned an empty completion`, { retryable: true });
      }
      return {
        text,
        tokensIn: payload.usage?.prompt_tokens ?? null,
        tokensOut: payload.usage?.completion_tokens ?? null,
        finishReason: payload.choices?.[0]?.finish_reason ?? null,
      };
    } catch (error) {
      if (error instanceof AiError) throw error;
      if ((error as { name?: string }).name === 'AbortError') {
        throw new AiError(`${this.provider} text generation timed out`, { retryable: true });
      }
      throw new AiError(`${this.provider} text generation request failed`, {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const startedAt = Date.now();
    const { text, tokensIn, tokensOut, finishReason } = await this.post(request, {
      model: this.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      temperature: request.temperature ?? 0,
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    });
    return {
      text,
      provider: this.provider,
      model: this.model,
      promptVersion: request.promptVersion,
      inputHash: request.inputHash,
      tokensIn,
      tokensOut,
      latencyMs: Date.now() - startedAt,
      finishReason,
    };
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const startedAt = Date.now();
    const { text, tokensIn, tokensOut, finishReason } = await this.post(request, {
      model: this.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      temperature: request.temperature ?? 0,
      response_format: { type: 'json_object' },
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new AiError(`${this.provider} returned invalid JSON for structured output`, {
        retryable: true,
        context: { schemaName: request.schemaName, invalidOutput: true },
        cause: error,
      });
    }
    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) {
      throw new AiError(`${this.provider} structured output failed schema validation`, {
        retryable: false,
        context: {
          schemaName: request.schemaName,
          invalidOutput: true,
          issues: parsed.error.issues.map((issue) => issue.path.join('.')),
        },
      });
    }
    return {
      text,
      value: parsed.data,
      provider: this.provider,
      model: this.model,
      promptVersion: request.promptVersion,
      inputHash: request.inputHash,
      tokensIn,
      tokensOut,
      latencyMs: Date.now() - startedAt,
      finishReason,
    };
  }
}
