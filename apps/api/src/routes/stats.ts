import type { FastifyInstance } from 'fastify';
import type { ApiCtx } from '../context.js';

export function registerStatsRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  app.get('/v1/stats/overview', async () => ctx.repos.stats.overview());
  app.get('/v1/stats/sources', async () => ({ items: await ctx.repos.stats.sourceStats() }));
}