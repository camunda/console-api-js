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
