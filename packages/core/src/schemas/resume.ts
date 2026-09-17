import { z } from 'zod';
import { SlugSchema, nonEmptyString } from './common.js';

export const ResumeKindSchema = z.enum(['original', 'tailored', 'generated']);

export const ResumeInputSchema = z.object({
  name: nonEmptyString.max(200),
  category: SlugSchema,
  language: z.string().trim().min(2).max(16).default('en'),
  isDefault: z.boolean().default(false),
});
export type ResumeInput = z.infer<typeof ResumeInputSchema>;

export const ResumeSchema = ResumeInputSchema.extend({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Resume = z.infer<typeof ResumeSchema>;

export const ResumeVersionInputSchema = z.object({
  kind: ResumeKindSchema.default('original'),
  parentVersionId: z.string().uuid().nullable().optional(),
  highlights: z.record(z.unknown()).default({}),
});
export type ResumeVersionInput = z.infer<typeof ResumeVersionInputSchema>;

export const ResumeVersionSchema = ResumeVersionInputSchema.extend({
  id: z.string().uuid(),
  resumeId: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  storageKey: nonEmptyString,
  fileHash: z.string().length(64),
  createdAt: z.date(),
});
export type ResumeVersion = z.infer<typeof ResumeVersionSchema>;