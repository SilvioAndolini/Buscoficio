import type { FastifyInstance } from 'fastify';
import type { ApiCtx } from '../context.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const checks: Record<string, string> = {};
    let ready = true;
    try {
      await ctx.pool.query('select 1');
      checks['database'] = 'ok';
    } catch {
      checks['database'] = 'error';
      ready = false;
    }
    try {
      const pong = await ctx.redis.ping();
      checks['redis'] = pong === 'PONG' ? 'ok' : 'error';
      if (pong !== 'PONG') ready = false;
    } catch {
      checks['redis'] = 'error';
      ready = false;
    }
    if (!ready) reply.status(503);
    return { status: ready ? 'ready' : 'not-ready', checks };
  });
}