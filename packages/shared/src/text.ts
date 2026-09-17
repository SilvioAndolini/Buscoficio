/**
 * Deterministic text normalization shared by adapters and persistence.
 * Keep this pure: no environment or I/O access.
 */
export function normalizeText(value: string): string {
  return collapseWhitespace(value).toLowerCase();
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function slugify(value: string): string {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}