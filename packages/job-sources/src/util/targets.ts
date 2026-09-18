/**
 * Deterministic ATS detection from URLs (redirects, apply links, metadata).
 * Discovery source and submission target are different concepts (ADR-013);
 * this helper only maps a URL to the submission platform/key.
 */
export interface DetectedAtsTarget {
  platform: string;
  key: string;
}

function slug(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '');
}

export function detectAtsFromUrl(rawUrl: string | null | undefined): DetectedAtsTarget | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  const first = slug(segments[0]);

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io' || host.endsWith('.greenhouse.io')) {
    return first ? { platform: 'greenhouse', key: `greenhouse-${first}` } : { platform: 'greenhouse', key: 'greenhouse' };
  }
  if (host === 'jobs.lever.co') {
    return first ? { platform: 'lever', key: `lever-${first}` } : { platform: 'lever', key: 'lever' };
  }
  if (host.endsWith('.myworkdayjobs.com')) {
    const tenant = slug(host.split('.')[0]);
    return tenant ? { platform: 'workday', key: `workday-${tenant}` } : { platform: 'workday', key: 'workday' };
  }
  if (host === 'jobs.ashbyhq.com') {
    return first ? { platform: 'ashby', key: `ashby-${first}` } : { platform: 'ashby', key: 'ashby' };
  }
  if (host === 'apply.workable.com' || host === 'jobs.workable.com') {
    return first ? { platform: 'workable', key: `workable-${first}` } : { platform: 'workable', key: 'workable' };
  }
  if (host === 'jobs.smartrecruiters.com') {
    return first
      ? { platform: 'smartrecruiters', key: `smartrecruiters-${first}` }
      : { platform: 'smartrecruiters', key: 'smartrecruiters' };
  }
  return null;
}

/** Picks the first ATS signal from a list of candidate URLs. */
export function detectAtsFromUrls(
  urls: Array<string | null | undefined>,
): { target: DetectedAtsTarget; sourceUrl: string } | null {
  for (const url of urls) {
    const target = detectAtsFromUrl(url);
    if (target && url) return { target, sourceUrl: url };
  }
  return null;
}