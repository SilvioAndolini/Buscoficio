/**
 * Deterministic BullMQ job id helpers shared by API (producer) and worker
 * (consumer). Format follows doc 06 §3: no ':' allowed; hashed/truncated
 * external identifiers.
 */
export function searchRunJobId(searchConfigId: string, scheduledEpochMs: number): string {
  return `search-${searchConfigId}-${scheduledEpochMs}`;
}

export function ingestSourceJobId(searchRunId: string, sourceKey: string): string {
  return `search-src-${searchRunId}-${sourceKey}`;
}