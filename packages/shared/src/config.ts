import { z } from 'zod';

/**
 * pgvector column dimension (ADR-018). The database schema imports this value,
 * so the vector(N) column and the runtime config can never drift apart.
 */
export const EMBEDDING_VECTOR_DIMENSIONS = 1536;

/** Providers with a real, documented embeddings endpoint implementation. */
export const SUPPORTED_EMBEDDING_PROVIDERS = ['mock', 'openai'] as const;
export type EmbeddingProviderName = (typeof SUPPORTED_EMBEDDING_PROVIDERS)[number];

/**
 * Centralized environment configuration (architecture doc 05 §8).
 * Safe defaults are non-negotiable: DRY_RUN=true, AUTO_APPLY_ENABLED=false.
 */
const booleanFromEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  }, z.boolean());

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(3001),

  AUTH_PASSWORD_HASH: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'AUTH_PASSWORD_HASH must be a sha256 hex digest'),
  AUTH_SECRET: z.string().min(16, 'AUTH_SECRET must be at least 16 characters'),
  AUTH_COOKIE_SECURE: booleanFromEnv(false),

  DRY_RUN: booleanFromEnv(true),
  AUTO_APPLY_ENABLED: booleanFromEnv(false),

  STORAGE_BACKEND: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().min(1).default('.data/storage'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * AI providers are independent ports: text generation (`AI_PROVIDER`) and
   * embeddings (`EMBEDDING_PROVIDER`) are configured separately. A provider
   * with a chat API does NOT automatically provide embeddings.
   */
  AI_PROVIDER: z.enum(['openai', 'anthropic', 'deepseek', 'mock']).default('mock'),
  DECISION_PROVIDER: z.enum(['jev', 'llm-adapter', 'mock']).default('mock'),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().nonnegative().default(20),

  /** Phase 3 embeddings (defaults keep CI/dev fully offline with the mock). */
  EMBEDDING_PROVIDER: z.enum(['mock', 'openai', 'anthropic', 'deepseek']).default('mock'),
  EMBEDDING_MODEL: z.string().min(1).max(120).optional(),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(EMBEDDING_VECTOR_DIMENSIONS),
  EMBEDDING_SPACE_VERSION: z.string().min(1).max(40).default('v1'),
  EMBEDDING_BASE_URL: z.string().url().optional(),
  /** Embeddings credential; falls back to OPENAI_API_KEY for compatibility. */
  EMBEDDING_API_KEY: z.string().min(1).optional(),
  /** Only required for real providers; never set in CI. */
  OPENAI_API_KEY: z.string().min(1).optional(),

  /** Phase 2 discovery tuning (single source of truth for thresholds). */
  DEDUP_L3_HIGH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
  DEDUP_L3_MEDIUM_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
  WATCHDOG_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(900_000),
  SCHEDULER_ENABLED: booleanFromEnv(true),
  /** Max redirect-enrichment requests per source run (0 disables it). */
  TARGET_ENRICHMENT_MAX_PER_RUN: z.coerce.number().int().min(0).default(25),
});

export type Env = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && !env.AUTH_COOKIE_SECURE) {
    throw new ConfigError([
      'AUTH_COOKIE_SECURE: insecure session cookie in production (set AUTH_COOKIE_SECURE=true behind TLS)',
    ]);
  }
  if (env.DEDUP_L3_MEDIUM_THRESHOLD >= env.DEDUP_L3_HIGH_THRESHOLD) {
    throw new ConfigError([
      'DEDUP_L3_MEDIUM_THRESHOLD must be lower than DEDUP_L3_HIGH_THRESHOLD',
    ]);
  }
  if (env.EMBEDDING_DIMENSIONS !== EMBEDDING_VECTOR_DIMENSIONS) {
    throw new ConfigError([
      `EMBEDDING_DIMENSIONS must be ${EMBEDDING_VECTOR_DIMENSIONS} (pgvector column is fixed; dimension changes require the ADR-018 migration)`,
    ]);
  }
  assertSupportedEmbeddingProvider(env.EMBEDDING_PROVIDER);
  return env;
}

/**
 * Embedding runtime descriptor: the single source of truth shared by the
 * worker (bootstrap + service), the API (activation endpoint) and tests.
 */
export interface EmbeddingRuntime {
  provider: EmbeddingProviderName;
  model: string;
  dimensions: number;
}

function assertSupportedEmbeddingProvider(
  provider: Env['EMBEDDING_PROVIDER'],
): asserts provider is EmbeddingProviderName {
  if (provider === 'anthropic') {
    throw new ConfigError([
      'EMBEDDING_PROVIDER=anthropic: Anthropic does not provide an embeddings API; use EMBEDDING_PROVIDER=openai|mock (AI_PROVIDER is independent)',
    ]);
  }
  if (provider === 'deepseek') {
    throw new ConfigError([
      'EMBEDDING_PROVIDER=deepseek: no documented embeddings endpoint is implemented; use EMBEDDING_PROVIDER=openai|mock',
    ]);
  }
  if (!SUPPORTED_EMBEDDING_PROVIDERS.includes(provider)) {
    throw new ConfigError([`EMBEDDING_PROVIDER=${provider} is not supported`]);
  }
}

/**
 * Resolves the embedding runtime from configuration only (never from
 * AI_PROVIDER). The mock default keeps CI/dev fully offline.
 */
export function resolveEmbeddingRuntime(env: Env): EmbeddingRuntime {
  assertSupportedEmbeddingProvider(env.EMBEDDING_PROVIDER);
  const model =
    env.EMBEDDING_MODEL ??
    (env.EMBEDDING_PROVIDER === 'mock' ? 'mock-deterministic-v1' : undefined);
  if (model === undefined) {
    throw new ConfigError([
      `EMBEDDING_MODEL is required when EMBEDDING_PROVIDER=${env.EMBEDDING_PROVIDER}`,
    ]);
  }
  if (env.EMBEDDING_DIMENSIONS !== EMBEDDING_VECTOR_DIMENSIONS) {
    throw new ConfigError([
      `EMBEDDING_DIMENSIONS must be ${EMBEDDING_VECTOR_DIMENSIONS} (pgvector column is fixed)`,
    ]);
  }
  return {
    provider: env.EMBEDDING_PROVIDER,
    model,
    dimensions: env.EMBEDDING_DIMENSIONS,
  };
}

/** Embedding credential with documented fallback; never logged. */
export function embeddingApiKey(env: Env): string | undefined {
  return env.EMBEDDING_API_KEY ?? env.OPENAI_API_KEY;
}