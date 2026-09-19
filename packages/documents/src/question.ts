import { normalizeForDedup, sha256Hex } from '@job-system/core';

/**
 * Canonical question identity for the answer bank (task §70). Deterministic
 * normalization only: lowercase, whitespace collapse and trivial punctuation.
 * No fuzzy/semantic matching — different questions stay different.
 */
export function canonicalQuestion(questionText: string): string {
  return normalizeForDedup(questionText)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hashQuestion(questionText: string): string {
  return sha256Hex(canonicalQuestion(questionText));
}
