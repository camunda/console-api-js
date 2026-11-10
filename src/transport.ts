import { AsyncLocalStorage } from 'node:async_hooks';
import type { TokenProvider } from './auth';
import type { Logger } from './logger';

/**
 * HTTP retry policy, aligned with `@camunda8/orchestration-cluster-api` (`HttpRetryPolicy`):
 * `maxAttempts` counts the initial attempt, backoff is exponential with full jitter.
 */
export interface HttpRetryPolicy {
  /** Total attempts, including the first. Default `CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS` (3). */
  maxAttempts: number;
  /** Base delay for exponential backoff, in ms. Default `CAMUNDA_SDK_HTTP_RETRY_BASE_DELAY_MS` (100). */
  baseDelayMs: number;
  /** Upper bound for a single backoff delay, in ms. Default `CAMUNDA_SDK_HTTP_RETRY_MAX_DELAY_MS` (10_000). */
  maxDelayMs: number;
}

/**
 * Per-call options accepted as the optional last argument of every ConsoleClient method,
 * aligned with OCA's `OperationOptions`.
 */
export interface OperationOptions {
  /**
   * Override retry behaviour for this call: `false` disables retry entirely (single attempt);
   * a partial policy overrides individual fields of the global configuration.
   */
  retry?: false | Partial<HttpRetryPolicy>;
}

interface TransportOptions {
  fetch: typeof fetch;
  tokens: Pick<TokenProvider, 'getToken' | 'invalidate'>;
  retry: HttpRetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Value for the `User-Agent` header. */
  userAgent?: string;
  logger?: Logger;
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

/** The fetch the transport wraps. Per-call context rides on `transportContext`, not the init. */
export type OperationFetch = typeof fetch;

interface TransportContext {
  retryPolicy: HttpRetryPolicy;
  operationId: string;
}

/**
 * Per-call transport context. The generated client builds a `Request` from its options, which
 * drops unknown properties, so the per-call retry policy and operationId cannot ride on the
 * request init; they are carried here instead. The facade runs each operation inside
 * `runWithContext`, so concurrent calls never see each other's policy.
 */
export const transportContext = new AsyncLocalStorage<TransportContext>();

/** Run `fn` with the given per-call transport context. */
export function runWithContext<R>(ctx: TransportContext, fn: () => R): R {
  return transportContext.run(ctx, fn);
}

/**
 * Wrap fetch with Console API transport behaviour:
 *
 * - sets `User-Agent` (when given) and adds `Authorization: Bearer <token>` to every request;
 * - on 401, drops the cached token and retries once with a fresh one;
 * - retries 429 for any method (the request was not processed), honouring Retry-After;
 * - retries 502/503/504 and network errors only for idempotent methods, so a POST that may
 *   have reached the server (for example createCluster) is never sent twice;
 * - logs attempt metadata (never payloads, bodies or tokens) through the SDK logger.
 */
export function createConsoleFetch(options: TransportOptions): OperationFetch {
  const {
    fetch: fetchImpl,
    tokens,
    retry,
    sleep = defaultSleep,
    random = Math.random,
    userAgent,
    logger,
  } = options;

  // Exponential backoff with full jitter: uniform in [0, min(cap, base * 2^attempt)].
  const backoff = (policy: HttpRetryPolicy, attempt: number) => {
    const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
    return Math.floor(random() * cap);
  };

  return async (input, init) => {
    const ctx = transportContext.getStore();
    const retryPolicy = ctx?.retryPolicy ?? retry;
    const operationId = ctx?.operationId ?? 'unknown';
    const original = new Request(input, init);
    const idempotent = IDEMPOTENT.has(original.method.toUpperCase());
    let refreshedAfter401 = false;
    let attempt = 0; // retries performed so far
    const maxAttempts = Math.max(1, retryPolicy.maxAttempts);

    for (;;) {
      const request = original.clone();
      if (userAgent) request.headers.set('user-agent', userAgent);
      request.headers.set('authorization', `Bearer ${await tokens.getToken()}`);

      let response: Response;
      try {
        response = await fetchImpl(request);
      } catch (error) {
        if (idempotent && attempt < maxAttempts - 1) {
          const delay = backoff(retryPolicy, attempt++);
          logger?.debug('http.retry.scheduled', {
            operationId,
            attempt,
            maxAttempts,
            delayMs: delay,
            reason: 'network-error',
          });
          await sleep(delay);
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
      if (retryable && attempt < maxAttempts - 1) {
        const delay = Math.min(
          parseRetryAfter(response.headers.get('retry-after')) ?? backoff(retryPolicy, attempt),
          retryPolicy.maxDelayMs
        );
        attempt++;
        logger?.debug('http.retry.scheduled', {
          operationId,
          attempt,
          maxAttempts,
          delayMs: delay,
          reason: `http-${response.status}`,
        });
        await response.body?.cancel();
        await sleep(delay);
        continue;
      }
      return response;
    }
  };
}

/** Resolve the effective per-call policy: `false` disables retry, a partial policy merges. */
export function resolveRetryPolicy(
  global: HttpRetryPolicy,
  override: OperationOptions['retry']
): HttpRetryPolicy {
  if (override === false) return { ...global, maxAttempts: 1 };
  if (override === undefined) return global;
  return {
    maxAttempts: override.maxAttempts ?? global.maxAttempts,
    baseDelayMs: override.baseDelayMs ?? global.baseDelayMs,
    maxDelayMs: override.maxDelayMs ?? global.maxDelayMs,
  };
}
