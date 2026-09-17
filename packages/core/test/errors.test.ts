import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  NotFoundError,
  SourceTransientError,
  ValidationError,
  isAppError,
  toAppError,
} from '../src/errors.js';

describe('error taxonomy', () => {
  it('exposes code, http status and retryability', () => {
    const validation = new ValidationError('bad input');
    expect(validation.code).toBe('VALIDATION_ERROR');
    expect(validation.httpStatus).toBe(400);
    expect(validation.retryable).toBe(false);

    const conflict = new ConflictError('duplicate');
    expect(conflict.httpStatus).toBe(409);

    const notFound = new NotFoundError('missing');
    expect(notFound.httpStatus).toBe(404);

    const transient = new SourceTransientError('timeout');
    expect(transient.retryable).toBe(true);
    expect(transient.httpStatus).toBe(502);
  });

  it('serializes without leaking internals', () => {
    const error = new ValidationError('bad input', { context: { field: 'email' } });
    expect(error.toJSON()).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'bad input',
      context: { field: 'email' },
    });
  });

  it('maps unknown errors to INTERNAL', () => {
    const mapped = toAppError(new Error('boom'));
    expect(mapped.code).toBe('INTERNAL');
    expect(mapped.cause).toBeInstanceOf(Error);
  });

  it('preserves known app errors', () => {
    const original = new NotFoundError('missing');
    expect(toAppError(original)).toBe(original);
    expect(isAppError(original)).toBe(true);
  });
});