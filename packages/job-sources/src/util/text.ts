import type { EmploymentType } from '@job-system/core';

/** Minimal, dependency-free HTML to text conversion for job descriptions. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const JOB_TYPE_MAP: Record<string, EmploymentType> = {
  'full time': 'full_time',
  'full-time': 'full_time',
  fulltime: 'full_time',
  'part time': 'part_time',
  'part-time': 'part_time',
  parttime: 'part_time',
  contract: 'contract',
  contractor: 'contract',
  freelance: 'contract',
  internship: 'internship',
  intern: 'internship',
  temporary: 'temporary',
  temp: 'temporary',
};

export function parseJobType(value: string | null | undefined): EmploymentType | null {
  if (!value) return null;
  return JOB_TYPE_MAP[value.trim().toLowerCase()] ?? null;
}

export interface ParsedSalary {
  min: number | null;
  max: number | null;
  currency: string | null;
}

const CURRENCY_BY_SYMBOL: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' };

/**
 * Conservative salary parsing: only explicit ranges are accepted; a single
 * amount is not turned into a range (never invent data).
 */
export function parseSalaryRange(input: string | null | undefined): ParsedSalary {
  if (!input) return { min: null, max: null, currency: null };
  const text = input.replace(/,/g, '');
  const amounts = [...text.matchAll(/([$€£])?\s*(\d{2,9}(?:\.\d+)?)\s*([kK])?/g)].map((match) => {
    const symbol = match[1] ?? null;
    const base = Number(match[2]);
    const multiplier = match[3] ? 1000 : 1;
    return { value: Math.round(base * multiplier), symbol };
  });
  if (amounts.length < 2) return { min: null, max: null, currency: amounts[0]?.symbol ? CURRENCY_BY_SYMBOL[amounts[0].symbol] ?? null : null };
  const [first, second] = amounts as [{ value: number; symbol: string | null }, { value: number; symbol: string | null }];
  const currency = CURRENCY_BY_SYMBOL[first.symbol ?? second.symbol ?? ''] ?? null;
  return {
    min: Math.min(first.value, second.value),
    max: Math.max(first.value, second.value),
    currency,
  };
}

/** Positive integer salary or null (0 and negatives are treated as unknown). */
export function positiveOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}