export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/**
 * A fetch double. Token requests (to the OAuth URL) return token-1, token-2, ... in turn;
 * every other request is answered by `handler`. All calls are recorded.
 */
export function fakeFetch(
  handler: (call: RecordedCall, index: number) => Response | Promise<Response>,
  { oauthUrl = 'https://login.cloud.camunda.io/oauth/token', expiresIn = 3600 } = {}
) {
  const calls: RecordedCall[] = [];
  let tokens = 0;
  let apiIndex = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const call: RecordedCall = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    };
    calls.push(call);
    if (request.url === oauthUrl) {
      tokens++;
      return Response.json({ access_token: `token-${tokens}`, expires_in: expiresIn });
    }
    return handler(call, apiIndex++);
  }) as typeof globalThis.fetch;
  return { fetch, calls, tokenRequests: () => tokens };
}

/** Config for a test client: credentials in the `config: { CAMUNDA_* }` shape. */
export const testConfig = {
  CAMUNDA_CONSOLE_CLIENT_ID: 'id',
  CAMUNDA_CONSOLE_CLIENT_SECRET: 'secret',
  CAMUNDA_CONSOLE_BASE_URL: 'https://console.test',
} as const;

/** A logger double that records every event. */
export function fakeLogger() {
  const events: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  const logger = new Proxy(
    {},
    {
      get: (_t, level: string) => (message: string, meta?: Record<string, unknown>) => {
        events.push({ level, message, meta });
      },
    }
  );
  return { logger, events };
}

/** True for calls to the test API host (not the OAuth endpoint). Host check, not prefix. */
export function isApiCall(call: RecordedCall): boolean {
  return new URL(call.url).host === 'console.test';
}
