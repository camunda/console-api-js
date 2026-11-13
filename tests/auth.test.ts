import { describe, expect, it } from 'vitest';
import { TokenProvider } from '../src/auth';
import { isSdkError } from '../src/errors';
import { fakeFetch } from './helpers';

const OAUTH = 'https://login.cloud.camunda.io/oauth/token';
const cfg = {
  clientId: 'id',
  clientSecret: 's',
  oauthUrl: OAUTH,
  audience: 'api.cloud.camunda.io',
};

describe('TokenProvider', () => {
  it('sends a client-credentials request with the Console audience', async () => {
    const fake = fakeFetch(() => new Response());
    await new TokenProvider(cfg, fake.fetch).getToken();
    const params = new URLSearchParams(fake.calls[0].body);
    expect(Object.fromEntries(params)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'id',
      client_secret: 's',
      audience: 'api.cloud.camunda.io',
    });
  });

  it('caches the token until shortly before expiry', async () => {
    let now = 0;
    const fake = fakeFetch(() => new Response(), { expiresIn: 300 });
    const p = new TokenProvider(cfg, fake.fetch, () => now);
    expect(await p.getToken()).toBe('token-1');
    now = 239_000; // 300s - 60s skew - 1s
    expect(await p.getToken()).toBe('token-1');
    now = 240_000;
    expect(await p.getToken()).toBe('token-2');
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const fake = fakeFetch(() => new Response());
    const p = new TokenProvider(cfg, fake.fetch);
    const tokens = await Promise.all([p.getToken(), p.getToken(), p.getToken()]);
    expect(tokens).toEqual(['token-1', 'token-1', 'token-1']);
    expect(fake.tokenRequests()).toBe(1);
  });

  it('fetches a new token after invalidate()', async () => {
    const fake = fakeFetch(() => new Response());
    const p = new TokenProvider(cfg, fake.fetch);
    await p.getToken();
    p.invalidate();
    expect(await p.getToken()).toBe('token-2');
  });

  it.each([
    ['an error status', new Response('denied', { status: 401 }), /HTTP 401/],
    ['a non-JSON body', new Response('<html>'), /non-JSON/],
    ['no access_token', Response.json({ expires_in: 1 }), /no access_token/],
  ])('throws AuthSdkError on %s', async (_name, response, message) => {
    const p = new TokenProvider(cfg, (async () => response) as typeof fetch);
    const err = await p.getToken().catch((e) => e);
    expect(isSdkError(err)).toBe(true);
    expect(err.name).toBe('AuthSdkError');
    expect(err.message).toMatch(message);
  });

  it('never puts the token endpoint response body into the error', async () => {
    const secret = 'super-secret-token-endpoint-body';
    const p = new TokenProvider(
      cfg,
      (async () => new Response(secret, { status: 400 })) as typeof fetch
    );
    const err = await p.getToken().catch((e) => e);
    expect(err.name).toBe('AuthSdkError');
    expect(JSON.stringify(err)).not.toContain(secret);
    expect(err.message).not.toContain(secret);
  });

  it('does not cache a failed token request', async () => {
    let fail = true;
    const p = new TokenProvider(cfg, (async () =>
      fail
        ? new Response('', { status: 500 })
        : Response.json({ access_token: 'ok', expires_in: 60 })) as typeof fetch);
    await expect(p.getToken()).rejects.toThrow();
    fail = false;
    expect(await p.getToken()).toBe('ok');
  });
});
