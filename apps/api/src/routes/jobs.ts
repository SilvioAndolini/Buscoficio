import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, type ApiCtx } from '../context.js';

const JobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().min(1).max(40).optional(),
});

const IdParamsSchema = z.object({ id: z.string().uuid() });

export function registerJobRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  app.get('/v1/jobs', async (request) => {
    const query = parse(JobsQuerySchema, request.query, 'jobs query');
    const rows = await ctx.repos.job.listJobs({
      limit: query.limit,
      offset: query.offset,
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    return {
      items: rows.map((row) => ({
        ...row.job,
        primaryListing: row.primaryListing,
      })),
    };
  });

  app.get('/v1/jobs/:id', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    return ctx.repos.job.getJobWithListings(id);
  });
}