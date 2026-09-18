import { z } from 'zod';

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

  AI_PROVIDER: z.enum(['openai', 'anthropic', 'deepseek', 'mock']).default('mock'),
  DECISION_PROVIDER: z.enum(['jev', 'llm-adapter', 'mock']).default('mock'),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().nonnegative().default(20),
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
  return env;
}