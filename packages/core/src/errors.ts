/**
 * Application error taxonomy (architecture doc 05 §5).
 * The domain never throws bare `Error` for known failure modes.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'POLICY_DENIED'
  | 'SOURCE_TRANSIENT'
  | 'SOURCE_PERMANENT'
  | 'SOURCE_AUTH'
  | 'CAPTCHA_DETECTED'
  | 'AI_ERROR'
  | 'DECISION_LOW_CONFIDENCE'
  | 'BROWSER_ERROR'
  | 'SUBMISSION_UNCERTAIN'
  | 'BUDGET_EXCEEDED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface AppErrorOptions {
  retryable?: boolean;
  context?: Record<string, unknown>;
  cause?: unknown;
}

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;
  readonly retryable: boolean;
  readonly context: Record<string, unknown> | undefined;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.retryable = options.retryable ?? false;
    this.context = options.context;
  }

  toJSON(): { code: ErrorCode; message: string; context?: Record<string, unknown> } {
    return this.context === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, context: this.context };
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR' as const;
  readonly httpStatus = 400;
}

/** HTTP 401 for the single-user session (taxonomy extension, Phase 1 report). */
export class UnauthorizedError extends AppError {
  readonly code = 'UNAUTHORIZED' as const;
  readonly httpStatus = 401;
}

export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND' as const;
  readonly httpStatus = 404;
}

export class ConflictError extends AppError {
  readonly code = 'CONFLICT' as const;
  readonly httpStatus = 409;
}

export class PolicyDeniedError extends AppError {
  readonly code = 'POLICY_DENIED' as const;
  readonly httpStatus = 422;
}

export class SourceTransientError extends AppError {
  readonly code = 'SOURCE_TRANSIENT' as const;
  readonly httpStatus = 502;
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { ...options, retryable: true });
  }
}

export class SourcePermanentError extends AppError {
  readonly code = 'SOURCE_PERMANENT' as const;
  readonly httpStatus = 422;
}

export class SourceAuthError extends AppError {
  readonly code = 'SOURCE_AUTH' as const;
  readonly httpStatus = 401;
}

export class CaptchaDetectedError extends AppError {
  readonly code = 'CAPTCHA_DETECTED' as const;
  readonly httpStatus = 409;
}

export class AiError extends AppError {
  readonly code = 'AI_ERROR' as const;
  readonly httpStatus = 502;
}

export class DecisionLowConfidenceError extends AppError {
  readonly code = 'DECISION_LOW_CONFIDENCE' as const;
  readonly httpStatus = 422;
}

export class BrowserError extends AppError {
  readonly code = 'BROWSER_ERROR' as const;
  readonly httpStatus = 502;
}

export class SubmissionUncertainError extends AppError {
  readonly code = 'SUBMISSION_UNCERTAIN' as const;
  readonly httpStatus = 409;
}

export class BudgetExceededError extends AppError {
  readonly code = 'BUDGET_EXCEEDED' as const;
  readonly httpStatus = 429;
}

export class RateLimitedError extends AppError {
  readonly code = 'RATE_LIMITED' as const;
  readonly httpStatus = 429;
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { ...options, retryable: true });
  }
}

export class InternalError extends AppError {
  readonly code = 'INTERNAL' as const;
  readonly httpStatus = 500;
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Maps any thrown value into an AppError, preserving known errors. */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return new InternalError(error.message, { cause: error });
  }
  return new InternalError('Unknown error', { cause: error });
}