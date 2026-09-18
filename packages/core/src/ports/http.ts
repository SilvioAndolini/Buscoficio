/**
 * HTTP client port used by source adapters. Implementations are infrastructure
 * (fetch in `packages/job-sources`); the domain only sees this contract.
 */
export interface HttpRequestOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Final URL after following redirects (used for ATS/target detection). */
  finalUrl: string;
  /** Redirect chain (each Location, resolved). Empty when no redirects. */
  redirects: string[];
}

export interface HttpClient {
  request(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
}

export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_REDIRECTS = 5;