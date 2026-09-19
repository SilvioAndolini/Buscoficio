import { AiError, type CompletionRequest, type CompletionResult, type StructuredRequest, type StructuredResult, type TextGenerationPort } from '@job-system/core';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
}

interface AnthropicMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string | null;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Anthropic Messages API adapter (documented endpoint). Anthropic has no
 * embeddings endpoint, but it is a supported text provider (`AI_PROVIDER`).
 */
export class AnthropicTextProvider implements TextGenerationPort {
  readonly provider = 'anthropic';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async post(
    request: CompletionRequest,
  ): Promise<{ text: string; tokensIn: number | null; tokensOut: number | null; finishReason: string | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? this.defaultTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens ?? 2048,
          temperature: request.temperature ?? 0,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const retryable = response.status === 429 || response.status >= 500;
        throw new AiError(`anthropic text generation failed with status ${response.status}`, {
          retryable,
          context: { status: response.status, detail: detail.slice(0, 500) },
        });
      }
      const payload = (await response.json()) as AnthropicMessagesResponse;
      const text = (payload.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
      if (text.trim().length === 0) {
        throw new AiError('anthropic returned an empty completion', { retryable: true });
      }
      return {
        text,
        tokensIn: payload.usage?.input_tokens ?? null,
        tokensOut: payload.usage?.output_tokens ?? null,
        finishReason: payload.stop_reason ?? null,
      };
    } catch (error) {
      if (error instanceof AiError) throw error;
      if ((error as { name?: string }).name === 'AbortError') {
        throw new AiError('anthropic text generation timed out', { retryable: true });
      }
      throw new AiError('anthropic text generation request failed', { retryable: true, cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const startedAt = Date.now();
    const { text, tokensIn, tokensOut, finishReason } = await this.post(request);
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
    const { text, tokensIn, tokensOut, finishReason } = await this.post(request);
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd <= jsonStart) {
      throw new AiError('anthropic structured output did not contain a JSON object', {
        retryable: true,
        context: { schemaName: request.schemaName, invalidOutput: true },
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    } catch (error) {
      throw new AiError('anthropic returned invalid JSON for structured output', {
        retryable: true,
        context: { schemaName: request.schemaName, invalidOutput: true },
        cause: error,
      });
    }
    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) {
      throw new AiError('anthropic structured output failed schema validation', {
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
