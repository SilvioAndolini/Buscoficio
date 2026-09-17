import { createHmac, timingSafeEqual } from 'node:crypto';
import { sha256Hex, UnauthorizedError } from '@job-system/core';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function verifyPassword(password: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256Hex(password), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Stateless signed session token: `<expiresAtEpochMs>.<hmacSha256>`. */
export function signSessionToken(secret: string, now: Date = new Date()): string {
  const expiresAt = now.getTime() + SESSION_TTL_MS;
  const signature = createHmac('sha256', secret).update(String(expiresAt)).digest('hex');
  return `${expiresAt}.${signature}`;
}

export function verifySessionToken(secret: string, token: string | undefined): boolean {
  if (!token) return false;
  const [expiresAtRaw, signature] = token.split('.');
  if (!expiresAtRaw || !signature) return false;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = createHmac('sha256', secret).update(String(expiresAt)).digest('hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function requireSession(secret: string, token: string | undefined): void {
  if (!verifySessionToken(secret, token)) {
    throw new UnauthorizedError('Authentication required');
  }
}