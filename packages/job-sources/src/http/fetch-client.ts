import {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
  RateLimitedError,
  SourcePermanentError,
  SourceTransientError,
  type HttpClient,
  type HttpRequestOptions,
  type HttpResponse,
} from '@job-system/core';

const USER_AGENT = 'Buscoficio/0.1 (personal job search; +https://github.com/SilvioAndolini/Buscoficio)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * fetch-based HttpClient: manual redirect chain (needed for ATS/target
 * detection), timeouts, Retry-After aware rate-limit errors. No evasion
 * techniques: fixed user agent, no fingerprint spoofing, no proxies.
 */
export function createFetchHttpClient(): HttpClient {
  return {
    async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
      const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
      const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
      const deadline = Date.now() + timeoutMs;
      const redirects: string[] = [];
      let current = url;

      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
        let response: Response;
        try {
          response = await fetch(current, {
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              'user-agent': USER_AGENT,
              accept: 'application/json, text/plain;q=0.9, text/html;q=0.8',
              ...options.headers,
            },
          });
        } catch (error) {
          if (controller.signal.aborted) {
            throw new SourceTransientError(`HTTP timeout after ${timeoutMs}ms: ${current}`);
          }
          throw new SourceTransientError(`HTTP request failed: ${current}`, { cause: error });
        } finally {
          clearTimeout(timer);
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location');
          if (!location) {
            throw new SourcePermanentError(`Redirect without Location header from ${current}`);
          }
          const next = new URL(location, current).toString();
          redirects.push(next);
          current = next;
          continue;
        }

        if (response.status === 429) {
          throw new RateLimitedError(`Rate limited by ${current}`, {
            context: { status: 429, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) },
          });
        }
        if (response.status >= 500) {
          throw new SourceTransientError(`Server error ${response.status} from ${current}`);
        }
        if (response.status >= 400) {
          throw new SourcePermanentError(`HTTP ${response.status} from ${current}`);
        }

        const body = await response.text();
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
          finalUrl: current,
          redirects,
        };
      }

      throw new SourcePermanentError(`Too many redirects (${maxRedirects}) for ${url}`);
    },
  };
}