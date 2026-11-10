import type { ResolvedConfig } from './config';
import { authError } from './errors';
import type { Logger } from './logger';
import { buildUserAgent } from './version';

/** Refresh tokens this many ms before they expire, so a request never carries a stale token. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * OAuth 2.0 client-credentials token provider for the Console API.
 *
 * - Caches the token in memory until shortly before it expires.
 * - Concurrent callers share one in-flight token request.
 * - `invalidate()` drops the cached token (used after a 401).
 * - Throws `AuthSdkError` on failure. The token endpoint's response body is never read into an
 *   error or a log: it can echo back client input, and a token response carries an access token.
 */
export class TokenProvider {
  private token?: { value: string; expiresAt: number };
  private inFlight?: Promise<string>;

  constructor(
    private readonly config: Pick<
      ResolvedConfig,
      'clientId' | 'clientSecret' | 'oauthUrl' | 'audience' | 'userAgent'
    >,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
    private readonly logger?: Logger
  ) {}

  async getToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - EXPIRY_SKEW_MS) {
      return this.token.value;
    }
    this.inFlight ??= this.fetchToken().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  invalidate(): void {
    this.token = undefined;
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      audience: this.config.audience,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.oauthUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': buildUserAgent(this.config.userAgent),
        },
        body,
      });
    } catch (e) {
      this.logger?.debug('auth.token.failed', { reason: 'network-error' });
      throw authError(`Token request to ${this.config.oauthUrl} failed: ${(e as Error).message}`, {
        cause: e,
      });
    }
    if (!res.ok) {
      await res.body?.cancel();
      this.logger?.debug('auth.token.failed', { status: res.status });
      throw authError(`Token request to ${this.config.oauthUrl} failed with HTTP ${res.status}`, {
        status: res.status,
      });
    }
    let json: { access_token?: unknown; expires_in?: unknown };
    try {
      json = await res.json();
    } catch {
      throw authError('Token endpoint returned a non-JSON body', { status: res.status });
    }
    if (typeof json.access_token !== 'string' || !json.access_token) {
      throw authError('Token endpoint response has no access_token', { status: res.status });
    }
    const expiresInSec = typeof json.expires_in === 'number' ? json.expires_in : 0;
    this.token = { value: json.access_token, expiresAt: this.now() + expiresInSec * 1000 };
    this.logger?.debug('auth.token.fetched', { expiresInSec });
    return json.access_token;
  }
}
