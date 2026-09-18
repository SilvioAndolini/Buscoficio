import { describe, expect, it } from 'vitest';
import {
  detectAtsFromUrl,
  detectAtsFromUrls,
  htmlToText,
  parseJobType,
  parseSalaryRange,
  positiveOrNull,
} from '../src/util/index.js';

describe('htmlToText', () => {
  it('strips tags, scripts and decodes basic entities', () => {
    const html = '<p>Hello&nbsp;<strong>world</strong></p><script>alert(1)</script><br/>Line 2';
    const text = htmlToText(html);
    expect(text).toContain('Hello world');
    expect(text).toContain('Line 2');
    expect(text).not.toContain('<');
    expect(text).not.toContain('alert');
  });
});

describe('parseJobType', () => {
  it('maps common job types deterministically', () => {
    expect(parseJobType('Full-Time')).toBe('full_time');
    expect(parseJobType('contract')).toBe('contract');
    expect(parseJobType('Internship')).toBe('internship');
    expect(parseJobType('something else')).toBeNull();
    expect(parseJobType(null)).toBeNull();
  });
});

describe('parseSalaryRange', () => {
  it('parses explicit ranges with k suffixes and currency', () => {
    expect(parseSalaryRange('€60k - €80k')).toEqual({ min: 60000, max: 80000, currency: 'EUR' });
    expect(parseSalaryRange('$120,000 - $150,000')).toEqual({
      min: 120000,
      max: 150000,
      currency: 'USD',
    });
  });

  it('never invents a range from a single amount', () => {
    expect(parseSalaryRange('$100k')).toEqual({ min: null, max: null, currency: 'USD' });
    expect(parseSalaryRange('competitive')).toEqual({ min: null, max: null, currency: null });
  });

  it('positiveOrNull rejects zero and negatives', () => {
    expect(positiveOrNull(0)).toBeNull();
    expect(positiveOrNull(-5)).toBeNull();
    expect(positiveOrNull(42000)).toBe(42000);
  });
});

describe('detectAtsFromUrl', () => {
  it('detects greenhouse boards with company slug', () => {
    expect(detectAtsFromUrl('https://boards.greenhouse.io/acme/jobs/123')).toEqual({
      platform: 'greenhouse',
      key: 'greenhouse-acme',
    });
    expect(detectAtsFromUrl('https://job-boards.greenhouse.io/globex/jobs/9')).toEqual({
      platform: 'greenhouse',
      key: 'greenhouse-globex',
    });
  });

  it('detects lever, workday, ashby, workable and smartrecruiters', () => {
    expect(detectAtsFromUrl('https://jobs.lever.co/initech/abc')).toEqual({
      platform: 'lever',
      key: 'lever-initech',
    });
    expect(detectAtsFromUrl('https://umbrella.wd1.myworkdayjobs.com/en-US/careers')).toEqual({
      platform: 'workday',
      key: 'workday-umbrella',
    });
    expect(detectAtsFromUrl('https://jobs.ashbyhq.com/wayne')).toEqual({
      platform: 'ashby',
      key: 'ashby-wayne',
    });
    expect(detectAtsFromUrl('https://apply.workable.com/soylent/j/1')).toEqual({
      platform: 'workable',
      key: 'workable-soylent',
    });
    expect(detectAtsFromUrl('https://jobs.smartrecruiters.com/StarkIndustries/1')).toEqual({
      platform: 'smartrecruiters',
      key: 'smartrecruiters-starkindustries',
    });
  });

  it('returns null for aggregators and invalid urls', () => {
    expect(detectAtsFromUrl('https://remotive.com/remote-jobs/x')).toBeNull();
    expect(detectAtsFromUrl('not-a-url')).toBeNull();
    expect(detectAtsFromUrl(null)).toBeNull();
  });

  it('picks the first ATS signal from a list (redirects first)', () => {
    const detected = detectAtsFromUrls([
      'https://aggregator.example/apply/1',
      'https://boards.greenhouse.io/acme/jobs/1',
    ]);
    expect(detected?.target.key).toBe('greenhouse-acme');
    expect(detected?.sourceUrl).toBe('https://boards.greenhouse.io/acme/jobs/1');
  });
});