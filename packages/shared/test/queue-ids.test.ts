import { describe, expect, it } from 'vitest';
import { ingestSourceJobId, safeQueueIdPart, searchRunJobId } from '../src/queue-ids.js';

describe('safeQueueIdPart', () => {
  it('keeps already-safe values untouched', () => {
    expect(safeQueueIdPart('mock')).toBe('mock');
    expect(safeQueueIdPart('989bbf03-e2d6-7c54-a73c-0422f86b0aec')).toBe(
      '989bbf03-e2d6-7c54-a73c-0422f86b0aec',
    );
  });

  it('never returns ":" for unsafe external values', () => {
    for (const value of [
      'provider:example',
      'https://jobs.example.com/source',
      'Provider One / EU',
      'key with spaces',
      'Ünïcode:key',
      'a'.repeat(200),
    ]) {
      const part = safeQueueIdPart(value);
      expect(part).not.toContain(':');
      expect(part.length).toBeGreaterThan(0);
      expect(part.length).toBeLessThanOrEqual(64);
    }
  });

  it('is deterministic and collision-resistant enough for job ids', () => {
    expect(safeQueueIdPart('provider:example')).toBe(safeQueueIdPart('provider:example'));
    expect(safeQueueIdPart('provider:example')).not.toBe(safeQueueIdPart('provider:example2'));
    expect(safeQueueIdPart('provider:example')).toMatch(/^[a-z0-9.-]+$/);
  });
});

describe('queue job id helpers', () => {
  it('searchRunJobId contains no ":" and is deterministic', () => {
    const a = searchRunJobId('config:1', 1_700_000_000_000);
    const b = searchRunJobId('config:1', 1_700_000_000_000);
    expect(a).toBe(b);
    expect(a).not.toContain(':');
    expect(a.startsWith('search-')).toBe(true);
  });

  it('ingestSourceJobId contains no ":" even with unsafe source keys', () => {
    const id = ingestSourceJobId('run-1', 'provider:example');
    expect(id).not.toContain(':');
    expect(id).toBe(ingestSourceJobId('run-1', 'provider:example'));
    expect(id).not.toBe(ingestSourceJobId('run-1', 'provider:example2'));
  });
});