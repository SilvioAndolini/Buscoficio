import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { searchRunJobId } from '@job-system/shared';
import { parse, type ApiCtx } from '../context.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });

const SearchConfigInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  keywords: z.array(z.string().trim().min(1)).default([]),
  locations: z.array(z.string().trim().min(1)).default([]),
  remote: z.boolean().nullable().default(null),
  sources: z.array(z.string().trim().min(1)).min(1),
  intervalMinutes: z.number().int().min(5).max(10_080).default(1440),
  mode: z.enum(['manual', 'assisted', 'auto']).default('assisted'),
});

export function registerSearchRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  app.get('/v1/search-configs', async () => ({ items: await ctx.repos.search.listConfigs() }));

  app.post('/v1/search-configs', async (request, reply) => {
    const input = parse(SearchConfigInputSchema, request.body, 'search config payload');
    const candidateId = await ctx.repos.candidate.requireProfileId();
    const row = await ctx.repos.search.createConfig({
      candidateId,
      name: input.name,
      keywords: input.keywords,
      locations: input.locations,
      remote: input.remote,
      sources: input.sources,
      intervalMinutes: input.intervalMinutes,
      mode: input.mode,
    });
    reply.status(201);
    return row;
  });

  /**
   * Asynchronous by design: the API only enqueues (architecture doc 02 §1).
   * The worker owns the search lifecycle from here on.
   */
  app.post('/v1/search-configs/:id/run', async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    await ctx.repos.search.getConfig(id);
    const jobId = searchRunJobId(id, ctx.clock.now().getTime());
    await ctx.searchQueue.add(
      'search.run',
      { searchConfigId: id, correlationId: request.id },
      { jobId, attempts: 3, backoff: { type: 'exponential', delay: 1_000 } },
    );
    await ctx.repos.audit.append({
      actor: 'user',
      action: 'search.run_requested',
      entityType: 'search_config',
      entityId: id,
      after: { jobId },
      correlationId: request.id,
    });
    ctx.logger.info({ correlationId: request.id, jobId, searchConfigId: id }, 'search run requested');
    reply.status(202);
    return { jobId, status: 'queued' };
  });

  app.get('/v1/search-runs', async (request) => {
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }), request.query);
    return { items: await ctx.repos.search.listRuns(query.limit) };
  });

  app.get('/v1/search-runs/:id', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    const run = await ctx.repos.search.getRun(id);
    const sources = await ctx.repos.search.listSourceRuns(id);
    return { ...run, sources: sources.map((entry) => ({ ...entry.run, sourceKey: entry.sourceKey })) };
  });
}