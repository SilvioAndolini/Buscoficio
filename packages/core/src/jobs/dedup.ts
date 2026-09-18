import { createHash } from 'node:crypto';

/**
 * Deterministic deduplication primitives (architecture doc 03 §4).
 * L0 (source+externalId) is handled by a database constraint.
 * L1 (canonical URL) and L2 (fingerprint) are computed here — pure functions.
 */

const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref',
  'referrer',
  'source',
  'trk',
  'trackingid',
]);

/** Lowercase + collapse whitespace; local (core cannot depend on shared). */
export function normalizeForDedup(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function sha256HexBytes(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Canonical URL: lowercase host, no hash, no tracking params, sorted query,
 * no trailing slash. Deterministic for equivalent URLs.
 */
export function normalizeCanonicalUrl(input: string): string {
  const url = new URL(input.trim());
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  url.protocol = url.protocol.toLowerCase();

  const params = [...url.searchParams.entries()]
    .filter(([key]) => {
      const lower = key.toLowerCase();
      return !TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix)) && !TRACKING_PARAMS.has(lower);
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = params.length > 0 ? new URLSearchParams(params).toString() : '';

  url.pathname = url.pathname.replace(/\/+$/, '') === '' ? '/' : url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function computeUrlHash(canonicalUrl: string): string {
  return sha256Hex(normalizeCanonicalUrl(canonicalUrl));
}

export interface FingerprintInput {
  company: string;
  title: string;
  location?: string | null;
  description: string;
}

/**
 * L2 fingerprint: sha256(company | title | location | sha256(description)).
 * Exactly the formula approved in Phase 0 (doc 03 §4).
 */
export function computeDescriptionFingerprint(input: FingerprintInput): string {
  const descriptionHash = sha256Hex(normalizeForDedup(input.description));
  const parts = [
    normalizeForDedup(input.company),
    normalizeForDedup(input.title),
    normalizeForDedup(input.location ?? ''),
    descriptionHash,
  ];
  return sha256Hex(parts.join('|'));
}

/** Canonical dedup key stored on the canonical Job (unique constraint). */
export const computeDedupKey = computeDescriptionFingerprint;

export interface JobContentHashInput {
  company: string;
  title: string;
  description: string;
  location?: string | null;
  remoteType?: string | null;
  employmentType?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string | null;
  experienceLevel?: string | null;
  languageRequirements: string[];
}

/**
 * Hash of the canonical fields that affect matching (JobMatch identity, ADR-014).
 * Recomputation is idempotent while the content is unchanged.
 */
export function computeJobContentHash(input: JobContentHashInput): string {
  return sha256Hex(
    [
      normalizeForDedup(input.company),
      normalizeForDedup(input.title),
      sha256Hex(normalizeForDedup(input.description)),
      normalizeForDedup(input.location ?? ''),
      input.remoteType ?? '',
      input.employmentType ?? '',
      input.salaryMin ?? '',
      input.salaryMax ?? '',
      input.currency ?? '',
      input.experienceLevel ?? '',
      [...input.languageRequirements].map(normalizeForDedup).sort().join(','),
    ].join('|'),
  );
}

/* ------------------------------------------------------------------ */
/* Fuzzy (L3) deduplication — deterministic, explainable thresholds    */
/* ------------------------------------------------------------------ */

export interface DedupThresholds {
  high: number;
  medium: number;
}

/** Defaults live here only; callers pass configured thresholds down. */
export const DEFAULT_DEDUP_THRESHOLDS: DedupThresholds = { high: 0.92, medium: 0.75 };

export const FUZZY_TITLE_WEIGHT = 0.6;
export const FUZZY_DESCRIPTION_WEIGHT = 0.4;

export type FuzzyDecision = 'merge' | 'review' | 'distinct';

export function computeFuzzyScore(titleSimilarity: number, descriptionSimilarity: number): number {
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  return clamp(
    titleSimilarity * FUZZY_TITLE_WEIGHT + descriptionSimilarity * FUZZY_DESCRIPTION_WEIGHT,
  );
}

/** HIGH → auto merge, MEDIUM → human review, LOW → distinct jobs. */
export function resolveFuzzyDecision(score: number, thresholds: DedupThresholds): FuzzyDecision {
  if (score >= thresholds.high) return 'merge';
  if (score >= thresholds.medium) return 'review';
  return 'distinct';
}