/**
 * Trace context propagated through every job/operation (docs 01/06).
 * applicationId exists for later phases; Phase 1 never populates it.
 */
export interface TraceContext {
  correlationId: string;
  jobId?: string;
  sourceId?: string;
  applicationId?: string;
}