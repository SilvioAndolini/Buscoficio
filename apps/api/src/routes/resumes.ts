import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ResumeInputSchema, ValidationError } from '@job-system/core';
import { uuidv7 } from '@job-system/shared';
import { parse, type ApiCtx } from '../context.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });
const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt', '.md'];

function extensionOf(filename: string): string {
  const index = filename.lastIndexOf('.');
  const extension = index === -1 ? '' : filename.slice(index).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(extension) ? extension : '.bin';
}

export function registerResumeRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  app.get('/v1/resumes', async () => ({ items: await ctx.repos.resume.listResumes() }));

  app.post('/v1/resumes', async (request, reply) => {
    const input = parse(ResumeInputSchema, request.body, 'resume payload');
    const candidateId = await ctx.repos.candidate.requireProfileId();
    const row = await ctx.repos.resume.createResume(candidateId, input);
    await ctx.repos.audit.append({
      actor: 'user',
      action: 'resume.created',
      entityType: 'resume',
      entityId: row.id,
      correlationId: request.id,
    });
    reply.status(201);
    return row;
  });

  app.get('/v1/resumes/:id', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    const resume = await ctx.repos.resume.getResume(id);
    const versions = await ctx.repos.resume.listVersions(id);
    return { ...resume, versions };
  });

  app.get('/v1/resumes/:id/versions', async (request) => {
    const { id } = parse(IdParamsSchema, request.params);
    await ctx.repos.resume.getResume(id);
    return { items: await ctx.repos.resume.listVersions(id) };
  });

  /**
   * Creates an immutable version. The uploaded file goes to StoragePort
   * (never blobs in Postgres); only storage_key + hash are persisted.
   */
  app.post('/v1/resumes/:id/versions', async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    await ctx.repos.resume.getResume(id);

    const file = await request.file();
    if (!file) throw new ValidationError('A file is required (multipart field "file")');

    const kindField = file.fields['kind'] as { value?: string } | undefined;
    const kindRaw = kindField?.value;
    const kind = kindRaw === 'tailored' || kindRaw === 'generated' ? kindRaw : 'original';

    const buffer = await file.toBuffer();
    const key = `resumes/${id}/${uuidv7()}${extensionOf(file.filename)}`;
    const ref = await ctx.storage.put(key, new Uint8Array(buffer), { contentType: file.mimetype });

    const version = await ctx.repos.resume.createVersion(id, {
      kind,
      storageKey: ref.key,
      fileHash: ref.hash,
    });
    await ctx.repos.audit.append({
      actor: 'user',
      action: 'resume.version_created',
      entityType: 'resume_version',
      entityId: version.id,
      after: { resumeId: id, versionNumber: version.versionNumber, fileHash: version.fileHash },
      correlationId: request.id,
    });
    reply.status(201);
    return version;
  });
}