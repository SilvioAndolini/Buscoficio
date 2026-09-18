import type IORedis from 'ioredis';
import type { Logger } from '@job-system/observability';

export interface RateLimiterOptions {
  /** Window size; overridable for fast tests. */
  windowMs?: number;
}

export interface RateLimitAcquireResult {
  waitedMs: number;
  blocked: boolean;
}

export interface RateLimiter {
  acquire(sourceKey: string, operation: string, limitPerMinute: number): Promise<RateLimitAcquireResult>;
  penalize(sourceKey: string, operation: string, retryAfterMs: number | null): Promise<void>;
}

/**
 * Self-imposed rate limiting per source + operation (Redis fixed window with
 * Retry-After penalties). It only throttles our own requests — never bypasses
 * external limits.
 */
export function createRedisRateLimiter(
  redis: IORedis,
  logger: Logger,
  options: RateLimiterOptions = {},
): RateLimiter {
  const windowMs = options.windowMs ?? 60_000;
  const maxWaitMs = Math.max(windowMs, 65_000);

  const sleep = async (ms: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  };

  return {
    async acquire(sourceKey, operation, limitPerMinute): Promise<RateLimitAcquireResult> {
      const bucket = `${sourceKey}:${operation}`;
      let waitedMs = 0;

      for (;;) {
        const blockedTtl = await redis.pttl(`rate:blocked:${bucket}`);
        if (blockedTtl > 0) {
          const wait = Math.min(blockedTtl, maxWaitMs);
          await sleep(wait);
          waitedMs += wait;
          continue;
        }

        const window = Math.floor(Date.now() / windowMs);
        const key = `rate:${bucket}:${window}`;
        const count = await redis.incr(key);
        if (count === 1) await redis.pexpire(key, windowMs * 2);

        if (count <= limitPerMinute) {
          return { waitedMs, blocked: false };
        }

        await redis.incr('rate:limit:blocked:total');
        const wait = Math.max(50, (window + 1) * windowMs - Date.now() + 50);
        logger.warn(
          { sourceKey, operation, limitPerMinute, waitMs: Math.min(wait, maxWaitMs) },
          'self-imposed rate limit reached; delaying source request',
        );
        await sleep(Math.min(wait, maxWaitMs));
        waitedMs += wait;
      }
    },

    async penalize(sourceKey, operation, retryAfterMs): Promise<void> {
      const ms = Math.min(Math.max(1000, retryAfterMs ?? 60_000), 15 * 60_000);
      await redis.set(`rate:blocked:${sourceKey}:${operation}`, '1', 'PX', ms);
      await redis.incr('rate:limit:blocked:total');
      logger.warn({ sourceKey, operation, retryAfterMs: ms }, 'external rate limit penalty applied');
    },
  };
}