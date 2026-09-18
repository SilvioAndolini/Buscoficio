import { normalizeForDedup, type RemoteType, type SourceSearchQuery } from '@job-system/core';

/**
 * Deterministic, explainable SearchConfig semantics (SearchQuery).
 *
 * - keywords: an offer belongs to the search when AT LEAST ONE configured
 *   keyword (normalized) appears in company + title + description + tags.
 * - locations: when configured, the offer location must match one of them
 *   (normalized substring, either direction). Exception (explicit rule):
 *   offers with unknown location remain eligible only when `remote === true`
 *   (remote boards frequently omit location).
 * - remote: `true` excludes clearly onsite offers; `false` excludes clearly
 *   remote ones; unknown/absent remote type never excludes (documented).
 *
 * SearchQuery decides which offers belong to the search; hard policy filters
 * (excludedCompanies/requiredKeywords/...) decide which belong to the candidate.
 */

export interface SearchableView {
  title: string;
  description: string;
  company: string;
  tags?: string[];
  location?: string | null;
  remoteType?: RemoteType | null;
}

export interface SearchQueryMatch {
  matches: boolean;
  reasons: string[];
}

function keywordHaystack(view: SearchableView): string {
  return normalizeForDedup(
    [view.company, view.title, view.description, ...(view.tags ?? [])].join(' '),
  );
}

export function evaluateSearchQuery(
  view: SearchableView,
  query: SourceSearchQuery,
): SearchQueryMatch {
  const reasons: string[] = [];

  const keywords = query.keywords.map((keyword) => keyword.trim()).filter(Boolean);
  if (keywords.length > 0) {
    const haystack = keywordHaystack(view);
    const matched = keywords.some((keyword) => haystack.includes(normalizeForDedup(keyword)));
    if (!matched) reasons.push(`no configured keyword matched (${keywords.join(', ')})`);
  }

  const locations = (query.locations ?? []).map((location) => location.trim()).filter(Boolean);
  if (locations.length > 0) {
    const offerLocation = view.location === null || view.location === undefined ? '' : view.location;
    const normalizedOffer = normalizeForDedup(offerLocation);
    const matched =
      normalizedOffer.length > 0 &&
      locations.some((location) => {
        const normalizedQuery = normalizeForDedup(location);
        return normalizedOffer.includes(normalizedQuery) || normalizedQuery.includes(normalizedOffer);
      });
    if (!matched) {
      if (normalizedOffer.length === 0) {
        if (query.remote !== true) {
          reasons.push('offer location is unknown and the search is not remote-only');
        }
      } else {
        reasons.push(`location '${offerLocation}' is outside the configured locations`);
      }
    }
  }

  if (query.remote === true && view.remoteType === 'onsite') {
    reasons.push('offer is onsite while the search requires remote');
  }
  if (query.remote === false && view.remoteType === 'remote') {
    reasons.push('offer is remote while the search requires onsite');
  }

  return { matches: reasons.length === 0, reasons };
}