import { describe, expect, it } from 'vitest';
import {
  createArbeitnowAdapter,
  createRemotiveAdapter,
  createRemoteOkAdapter,
} from '../src/real/index.js';

/**
 * Live suite: hits the real public APIs. NEVER part of CI; run manually with
 * `pnpm test:live` (see scripts/test-live.mjs). One request per source.
 */
const live = process.env['LIVE_TESTS'] === 'true';
const describeLive = live ? describe : describe.skip;

describeLive('live discovery sources (manual, single request each)', () => {
  it('remotive returns normalizable offers', async () => {
    const adapter = createRemotiveAdapter({ pageSize: 3 });
    const result = await adapter.searchJobs({ keywords: [], page: 1 });
    expect(result.jobs.length).toBeGreaterThan(0);
    const normalized = adapter.normalizeJob(result.jobs[0]!);
    expect(normalized.title.length).toBeGreaterThan(0);
    expect(normalized.canonicalUrl.startsWith('http')).toBe(true);
  }, 30_000);

  it('arbeitnow returns normalizable offers', async () => {
    const adapter = createArbeitnowAdapter();
    const result = await adapter.searchJobs({ keywords: [], page: 1 });
    expect(result.jobs.length).toBeGreaterThan(0);
    const normalized = adapter.normalizeJob(result.jobs[0]!);
    expect(normalized.company.length).toBeGreaterThan(0);
  }, 30_000);

  it('remoteok returns normalizable offers', async () => {
    const adapter = createRemoteOkAdapter();
    const result = await adapter.searchJobs({ keywords: [], page: 1 });
    expect(result.jobs.length).toBeGreaterThan(0);
    const normalized = adapter.normalizeJob(result.jobs[0]!);
    expect(normalized.title.length).toBeGreaterThan(0);
  }, 30_000);
});