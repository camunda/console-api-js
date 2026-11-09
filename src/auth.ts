import type { ConsoleApiConfig } from './config';

export class ConsoleApiAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string
  ) {
    super(message);
    this.name = 'ConsoleApiAuthError';
  }
}

/** Refresh tokens this many ms before they expire, so a request never carries a stale token. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * OAuth 2.0 client-credentials token provider for the Console API.
 *
 * - Caches the token in memory until shortly before it expires.
 * - Concurrent callers share one in-flight token request.
 * - `invalidate()` drops the cached token (used after a 401).
 */
export class TokenProvider {
  private token?: { value: string; expiresAt: number };
  private inFlight?: Promise<string>;

  constructor(
    private readonly config: Pick<
      ConsoleApiConfig,
      'clientId' | 'clientSecret' | 'oauthUrl' | 'audience'
    >,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now
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
        },
        body,
      });
    } catch (e) {
      throw new ConsoleApiAuthError(
        `Token request to ${this.config.oauthUrl} failed: ${(e as Error).message}`
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new ConsoleApiAuthError(
        `Token request to ${this.config.oauthUrl} failed with HTTP ${res.status}`,
        res.status,
        text
      );
    }
    let json: { access_token?: unknown; expires_in?: unknown };
    try {
      json = JSON.parse(text);
    } catch {
      throw new ConsoleApiAuthError('Token endpoint returned a non-JSON body', res.status, text);
    }
    if (typeof json.access_token !== 'string' || !json.access_token) {
      throw new ConsoleApiAuthError(
        'Token endpoint response has no access_token',
        res.status,
        text
      );
    }
    const expiresInSec = typeof json.expires_in === 'number' ? json.expires_in : 0;
    this.token = { value: json.access_token, expiresAt: this.now() + expiresInSec * 1000 };
    return json.access_token;
  }
}
