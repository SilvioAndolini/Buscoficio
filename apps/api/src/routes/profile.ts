import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CandidateLanguageInputSchema,
  CandidateProfileInputSchema,
  CandidateSkillInputSchema,
  EducationInputSchema,
  ExperienceInputSchema,
} from '@job-system/core';
import { parse, type ApiCtx } from '../context.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });

export function registerProfileRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  app.get('/v1/profile', async () => {
    const [profile, experiences, educations, skills, languages] = await Promise.all([
      ctx.repos.candidate.getProfile(),
      ctx.repos.candidate.listExperiences(),
      ctx.repos.candidate.listEducations(),
      ctx.repos.candidate.listSkills(),
      ctx.repos.candidate.listLanguages(),
    ]);
    return { profile, experiences, educations, skills, languages };
  });

  app.put('/v1/profile', async (request) => {
    const input = parse(CandidateProfileInputSchema, request.body, 'profile payload');
    const row = await ctx.repos.candidate.upsertProfile(input);
    await ctx.repos.audit.append({
      actor: 'user',
      action: 'profile.updated',
      entityType: 'candidate_profile',
      entityId: row.id,
      after: { profileHash: row.profileHash },
      correlationId: request.id,
    });
    return row;
  });

  /* Experiences ------------------------------------------------------ */

  app.get('/v1/profile/experiences', async () => ({ items: await ctx.repos.candidate.listExperiences() }));

  app.post('/v1/profile/experiences', async (request, reply) => {
    const input = parse(ExperienceInputSchema, request.body, 'experience payload');
    const candidateId = await ctx.repos.candidate.requireProfileId();
    const row = await ctx.repos.candidate.addExperience(candidateId, input);
    await audit(ctx, request.id, 'experience.created', row.id);
    reply.status(201);
    return row;
  });

  app.put('/v1/profile/experiences/:id', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    const input = parse(ExperienceInputSchema, request.body, 'experience payload');
    const row = await ctx.repos.candidate.updateExperience(id, input);
    await audit(ctx, request.id, 'experience.updated', row.id);
    return row;
  });

  app.delete('/v1/profile/experiences/:id', async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    await ctx.repos.candidate.deleteExperience(id);
    await audit(ctx, request.id, 'experience.deleted', id);
    reply.status(204);
    return null;
  });

  /* Skills ----------------------------------------------------------- */

  app.get('/v1/profile/skills', async () => ({ items: await ctx.repos.candidate.listSkills() }));

  app.post('/v1/profile/skills', async (request, reply) => {
    const input = parse(CandidateSkillInputSchema, request.body, 'skill payload');
    const candidateId = await ctx.repos.candidate.requireProfileId();
    const row = await ctx.repos.candidate.addSkill(candidateId, input);
    await audit(ctx, request.id, 'skill.upserted', row.id);
    reply.status(201);
    return row;
  });

  app.delete('/v1/profile/skills/:id', async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    await ctx.repos.candidate.deleteSkill(id);
    await audit(ctx, request.id, 'skill.deleted', id);
    reply.status(204);
    return null;
  });

  /* Educations ------------------------------------------------------- */

  app.get('/v1/profile/educations', async () => ({ items: await ctx.repos.candidate.listEducations() }));

  app.post('/v1/profile/educations', async (request, reply) => {
    const input = parse(EducationInputSchema, request.body, 'education payload');
    const candidateId = await ctx.repos.candidate.requireProfileId();
    const row = await ctx.repos.candidate.addEducation(candidateId, input);
    await audit(ctx, request.id, 'education.created', row.id);
    reply.status(201);
    return row;
  });

  app.delete('/v1/profile/educations/:id', async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    await ctx.repos.candidate.deleteEducation(id);
    await audit(ctx, request.id, 'education.deleted', id);
    reply.status(204);
    return null;
  });

  /* Languages -------------------------------------------------------- */

  app.get('/v1/profile/languages', async () => ({ items: await ctx.repos.candidate.listLanguages() }));

  app.post('/v1/profile/languages', async (request, reply) => {
    const input = parse(CandidateLanguageInputSchema, request.body, 'language payload');
    const candidateId = await ctx.repos.candidate.requireProfileId();
    const row = await ctx.repos.candidate.addLanguage(candidateId, input);
    await audit(ctx, request.id, 'language.upserted', row.id);
    reply.status(201);
    return row;
  });

  app.delete('/v1/profile/languages/:id', async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    await ctx.repos.candidate.deleteLanguage(id);
    await audit(ctx, request.id, 'language.deleted', id);
    reply.status(204);
    return null;
  });
}

async function audit(ctx: ApiCtx, correlationId: string, action: string, entityId: string): Promise<void> {
  await ctx.repos.audit.append({
    actor: 'user',
    action,
    entityType: 'candidate_profile',
    entityId,
    correlationId,
  });
}