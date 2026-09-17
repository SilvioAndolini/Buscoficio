import { pino, type DestinationStream, type Logger } from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Trace context required by the architecture (docs 01/06). */
export interface LogContext {
  correlationId?: string;
  jobId?: string;
  sourceId?: string;
  applicationId?: string;
}

/**
 * Fields that must never reach the logs (security doc 09 §2).
 * Keep this list intentional: passwords, tokens, sessions and unnecessary PII.
 */
export const REDACT_PATHS: string[] = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'set-cookie',
  'storageState',
  'storage_state_ciphertext',
  'email',
  'phone',
  'resumeContent',
  'cvContent',
  '*.password',
  '*.token',
  '*.email',
  '*.phone',
  '*.authorization',
  '*.cookie',
  '*.storageState',
];

export interface CreateLoggerOptions {
  level?: LogLevel;
  /** Test seam: capture structured output instead of stdout. */
  stream?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const config = {
    level: options.level ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return options.stream ? pino(config, options.stream) : pino(config);
}

export function createJobLogger(base: Logger, context: LogContext): Logger {
  return base.child({ ...context });
}

export type { DestinationStream, Logger } from 'pino';
export { pino };