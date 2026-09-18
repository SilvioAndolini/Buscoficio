import { describe, expect, it } from 'vitest';
import {
  buildJobEmbeddingText,
  buildResumeEmbeddingText,
  jobEmbeddingContentHash,
  resumeEmbeddingContentHash,
  type MatchJob,
  type MatchResumeVersion,
} from '../src/index.js';

const job: MatchJob = {
  company: 'Acme Corp',
  title: 'Senior React Developer',
  description: '<p>Build <b>internal</b> tools</p>',
  location: 'Remote (EU)',
  remoteType: 'remote',
  employmentType: 'full_time',
  salaryMin: 1,
  salaryMax: 2,
  currency: 'EUR',
  experienceLevel: 'senior',
  languageRequirements: ['en'],
  requiredSkills: ['React'],
  preferredSkills: ['Node.js'],
};

const version: MatchResumeVersion = {
  id: 'aaaaaaaa-1111-7111-8111-111111111111',
  versionNumber: 1,
  fileHash: 'f'.repeat(64),
  kind: 'original',
  highlights: { skills: ['React', 'TypeScript'], summary: 'Frontend engineer' },
};

describe('embedding input builders', () => {
  it('are stable, deterministic and strip HTML', () => {
    const first = buildJobEmbeddingText(job);
    expect(first).toBe(buildJobEmbeddingText(job));
    expect(first).not.toContain('<p>');
    expect(first).toContain('Build internal tools');
  });

  it('contentHash is versioned and changes with the text', () => {
    const text = buildJobEmbeddingText(job);
    const hash = jobEmbeddingContentHash(text);
    expect(hash).toHaveLength(64);
    expect(jobEmbeddingContentHash(text)).toBe(hash);
    expect(jobEmbeddingContentHash(`${text} extra`)).not.toBe(hash);
  });

  it('resume text uses only existing structured data (documented limitation)', () => {
    const text = buildResumeEmbeddingText(version);
    expect(text).toContain('React, TypeScript');
    expect(text).toContain('Frontend engineer');
    expect(resumeEmbeddingContentHash(text)).toHaveLength(64);
  });
});
