import { sha256Hex } from '@job-system/core';
import { collapseWhitespace } from '@job-system/shared';
import type { MatchJob, MatchResumeVersion } from './types.js';

/**
 * Versioned embedding input builders. They are pure, stable and documented:
 * no timestamps, no HTML, no fields that do not carry matching semantics.
 * `contentHash` = sha256(builderVersion | text) is the embedding cache key.
 */

export const JOB_EMBEDDING_TEXT_VERSION = 'job-embedding-text-v1';
export const RESUME_EMBEDDING_TEXT_VERSION = 'resume-embedding-text-v1';

function clean(value: string): string {
  return collapseWhitespace(value.replace(/<[^>]*>/g, ' '));
}

export function buildJobEmbeddingText(job: MatchJob): string {
  const lines = [
    `Title: ${clean(job.title)}`,
    `Company: ${clean(job.company)}`,
    `Description: ${clean(job.description)}`,
    `Location: ${job.location === null ? 'unspecified' : clean(job.location)}`,
    `Remote: ${job.remoteType ?? 'unspecified'}`,
    `Employment: ${job.employmentType ?? 'unspecified'}`,
    `Experience: ${job.experienceLevel ?? 'unspecified'}`,
    `Required skills: ${job.requiredSkills.join(', ')}`,
    `Preferred skills: ${job.preferredSkills.join(', ')}`,
    `Languages: ${job.languageRequirements.join(', ')}`,
  ];
  return lines.join('\n');
}

export function jobEmbeddingContentHash(text: string): string {
  return sha256Hex(`${JOB_EMBEDDING_TEXT_VERSION}|${text}`);
}

/**
 * A ResumeVersion has no parsed full text in Phase 3 (no parser is in scope).
 * The minimal correct representation uses only existing structured data:
 * highlights (when present) plus the immutable version metadata. Documented
 * limitation: semantic quality improves when richer parsed text exists.
 */
export function buildResumeEmbeddingText(version: MatchResumeVersion): string {
  const highlights = version.highlights;
  const asString = (value: unknown): string =>
    typeof value === 'string' ? clean(value) : '';
  const asStringList = (value: unknown): string =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string').map(clean).join(', ')
      : '';
  const lines = [
    `Summary: ${asString(highlights['summary'])}`,
    `Headline: ${asString(highlights['headline'])}`,
    `Skills: ${asStringList(highlights['skills'])}`,
    `Experience: ${asStringList(highlights['experience'])}`,
    `Education: ${asStringList(highlights['education'])}`,
    `Languages: ${asStringList(highlights['languages'])}`,
    `Version kind: ${version.kind}`,
  ];
  return lines.join('\n');
}

export function resumeEmbeddingContentHash(text: string): string {
  return sha256Hex(`${RESUME_EMBEDDING_TEXT_VERSION}|${text}`);
}
