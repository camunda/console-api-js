import { describe, expect, it } from 'vitest';
import { TokenProvider } from '../src/auth';
import { createConsoleFetch, parseRetryAfter, resolveRetryPolicy } from '../src/transport';
import { fakeFetch } from './helpers';

const OAUTH = 'https://login.cloud.camunda.io/oauth/token';
const cfg = {
  clientId: 'id',
  clientSecret: 's',
  oauthUrl: OAUTH,
  audience: 'api.cloud.camunda.io',
};

const POLICY = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 10_000 };

function setup(
  handler: Parameters<typeof fakeFetch>[0],
  retry: Partial<typeof POLICY> = {}
): ReturnType<typeof fakeFetch> & { send: typeof fetch; sleeps: number[] } {
  const fake = fakeFetch(handler);
  const sleeps: number[] = [];
  const send = createConsoleFetch({
    fetch: fake.fetch,
    tokens: new TokenProvider(cfg, fake.fetch),
    retry: { ...POLICY, ...retry },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
  });
  return { ...fake, send: send as unknown as typeof fetch, sleeps };
}

const api = <C extends { url: string }>(calls: C[]) => calls.filter((c) => c.url !== OAUTH);

describe('transport', () => {
  it('refreshes the token once on 401 and retries', async () => {
    const t = setup((_c, i) => new Response(null, { status: i === 0 ? 401 : 200 }));
    const res = await t.send('https://console.test/clusters');
    expect(res.status).toBe(200);
    expect(api(t.calls).map((c) => c.headers.get('authorization'))).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
  });

  it('returns a second 401 rather than looping', async () => {
    const t = setup(() => new Response(null, { status: 401 }));
    const res = await t.send('https://console.test/clusters');
    expect(res.status).toBe(401);
    expect(api(t.calls)).toHaveLength(2);
  });

  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])(
    'retries 429 for %s and honours Retry-After',
    async (method) => {
      const t = setup(
        (_c, i) =>
          new Response(null, { status: i < 2 ? 429 : 200, headers: { 'retry-after': '2' } })
      );
      const res = await t.send('https://console.test/x', {
        method,
        body: method === 'GET' ? undefined : '{}',
      });
      expect(res.status).toBe(200);
      expect(t.sleeps).toEqual([2000, 2000]);
    }
  );

  it.each(['POST', 'PATCH'])('does not retry 503 for non-idempotent %s', async (method) => {
    const t = setup(() => new Response(null, { status: 503 }));
    const res = await t.send('https://console.test/clusters', { method, body: '{}' });
    expect(res.status).toBe(503);
    expect(api(t.calls)).toHaveLength(1);
  });

  it.each(['GET', 'PUT', 'DELETE'])('retries 502/503/504 for idempotent %s', async (method) => {
    const statuses = [502, 503, 504, 200];
    const t = setup((_c, i) => new Response(null, { status: statuses[i] }));
    const res = await t.send('https://console.test/x', { method });
    expect(res.status).toBe(200);
    expect(api(t.calls)).toHaveLength(4);
  });

  it('stops after maxAttempts total attempts and returns the last response', async () => {
    const t = setup(() => new Response(null, { status: 429 }), { maxAttempts: 3 });
    const res = await t.send('https://console.test/x');
    expect(res.status).toBe(429);
    expect(api(t.calls)).toHaveLength(3);
  });

  it('retries network errors for GET but not for POST', async () => {
    const fail = () => {
      throw new TypeError('fetch failed');
    };
    const get = setup((_c, i) => (i === 0 ? fail() : new Response(null, { status: 200 })));
    expect((await get.send('https://console.test/x')).status).toBe(200);

    const post = setup(fail);
    await expect(
      post.send('https://console.test/x', { method: 'POST', body: '{}' })
    ).rejects.toMatchObject({
      name: 'NetworkSdkError',
      cause: expect.objectContaining({ message: 'fetch failed' }),
    });
    expect(api(post.calls)).toHaveLength(1);
  });

  it('resends the full request body on retry', async () => {
    const t = setup((_c, i) => new Response(null, { status: i === 0 ? 429 : 200 }));
    await t.send('https://console.test/x', { method: 'POST', body: '{"a":1}' });
    expect(api(t.calls).map((c) => c.body)).toEqual(['{"a":1}', '{"a":1}']);
  });

  it('backs off with full jitter bounded by base * 2^attempt and the cap', async () => {
    const t = setup(() => new Response(null, { status: 429 }), {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 250,
    });
    await t.send('https://console.test/x');
    // random() === 1, so each delay is the full capped window: 100, 200, 250 (cap).
    expect(t.sleeps).toEqual([100, 200, 250]);
  });

  it('parses Retry-After as seconds or HTTP date', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('nonsense')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('resolveRetryPolicy', () => {
  it('returns the global policy when no override is given', () => {
    expect(resolveRetryPolicy(POLICY, undefined)).toBe(POLICY);
  });

  it('retry: false means a single attempt', () => {
    expect(resolveRetryPolicy(POLICY, false)).toEqual({ ...POLICY, maxAttempts: 1 });
  });

  it('a partial override merges with the global policy', () => {
    expect(resolveRetryPolicy(POLICY, { maxAttempts: 8 })).toEqual({ ...POLICY, maxAttempts: 8 });
    expect(resolveRetryPolicy(POLICY, { baseDelayMs: 50, maxDelayMs: 500 })).toEqual({
      maxAttempts: POLICY.maxAttempts,
      baseDelayMs: 50,
      maxDelayMs: 500,
    });
  });
});
