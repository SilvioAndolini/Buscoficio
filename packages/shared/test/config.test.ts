import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from '../src/config.js';

const validEnv = {
  DATABASE_URL: 'postgres://job:job@localhost:5432/job_system',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_PASSWORD_HASH: 'a'.repeat(64),
  AUTH_SECRET: 'super-secret-value-123456',
};

describe('loadEnv', () => {
  it('applies safe defaults when optional variables are absent', () => {
    const env = loadEnv(validEnv);
    expect(env.DRY_RUN).toBe(true);
    expect(env.AUTO_APPLY_ENABLED).toBe(false);
    expect(env.AUTH_COOKIE_SECURE).toBe(false);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.STORAGE_BACKEND).toBe('local');
    expect(env.API_PORT).toBe(3001);
  });

  it('parses explicit false values correctly (string coercion trap)', () => {
    const env = loadEnv({ ...validEnv, DRY_RUN: 'false', AUTO_APPLY_ENABLED: 'true' });
    expect(env.DRY_RUN).toBe(false);
    expect(env.AUTO_APPLY_ENABLED).toBe(true);
  });

  it('rejects an invalid password hash', () => {
    expect(() => loadEnv({ ...validEnv, AUTH_PASSWORD_HASH: 'not-a-hash' })).toThrow(ConfigError);
  });

  it('rejects a missing database url', () => {
    const { DATABASE_URL: _omitted, ...rest } = validEnv;
    expect(() => loadEnv(rest)).toThrow(ConfigError);
  });

  it('rejects non-boolean flag values', () => {
    expect(() => loadEnv({ ...validEnv, DRY_RUN: 'yes' })).toThrow(ConfigError);
  });
});