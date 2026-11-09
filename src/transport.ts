import type { TokenProvider } from './auth';

export interface RetryOptions {
  /** Maximum number of retries after the first attempt. */
  maxRetries: number;
  /** Base delay for exponential backoff, in ms. Default 500. */
  baseDelayMs?: number;
  /** Upper bound for a single backoff delay, in ms. Default 10_000. */
  maxDelayMs?: number;
}

interface TransportOptions extends RetryOptions {
  fetch: typeof fetch;
  tokens: Pick<TokenProvider, 'getToken' | 'invalidate'>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const TRANSIENT = new Set([502, 503, 504]);

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parse a Retry-After header (seconds or HTTP date) into ms, or undefined. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

/**
 * Wrap fetch with Console API transport behaviour:
 *
 * - adds `Authorization: Bearer <token>` to every request;
 * - on 401, drops the cached token and retries once with a fresh one;
 * - retries 429 for any method (the request was not processed), honouring Retry-After;
 * - retries 502/503/504 and network errors only for idempotent methods, so a POST that may
 *   have reached the server (for example createCluster) is never sent twice.
 */
export function createConsoleFetch(options: TransportOptions): typeof fetch {
  const {
    fetch: fetchImpl,
    tokens,
    maxRetries,
    baseDelayMs = 500,
    maxDelayMs = 10_000,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  const backoff = (attempt: number) =>
    Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + random() / 2);

  return async (input, init) => {
    const original = new Request(input, init);
    const idempotent = IDEMPOTENT.has(original.method.toUpperCase());
    let refreshedAfter401 = false;
    let attempt = 0;

    for (;;) {
      const request = original.clone();
      request.headers.set('authorization', `Bearer ${await tokens.getToken()}`);

      let response: Response;
      try {
        response = await fetchImpl(request);
      } catch (error) {
        if (idempotent && attempt < maxRetries) {
          await sleep(backoff(attempt++));
          continue;
        }
        throw error;
      }

      if (response.status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true;
        tokens.invalidate();
        await response.body?.cancel();
        continue;
      }

      const retryable = response.status === 429 || (idempotent && TRANSIENT.has(response.status));
      if (retryable && attempt < maxRetries) {
        const delay = parseRetryAfter(response.headers.get('retry-after')) ?? backoff(attempt);
        attempt++;
        await response.body?.cancel();
        await sleep(Math.min(delay, maxDelayMs));
        continue;
      }
      return response;
    }
  };
}
