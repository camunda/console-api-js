import { describe, expect, it } from 'vitest';
import { ConsoleClient } from '../src';
import { CamundaConfigurationError, resolveConfig } from '../src/config';
import { fakeFetch, isApiCall, testConfig } from './helpers';

const creds = { CAMUNDA_CONSOLE_CLIENT_ID: 'a', CAMUNDA_CONSOLE_CLIENT_SECRET: 'b' };

function client(
  handler: Parameters<typeof fakeFetch>[0],
  config: Record<string, unknown> = {},
  fetchOverride?: typeof fetch
) {
  const fake = fakeFetch(handler);
  return {
    ...fake,
    console: new ConsoleClient({
      config: { ...testConfig, CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 1, ...config } as never,
      fetch: fetchOverride ?? fake.fetch,
      env: {},
      sleep: async () => {},
    }),
  };
}

describe('retry limits are validated', () => {
  const keys = [
    'CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS',
    'CAMUNDA_SDK_HTTP_RETRY_BASE_DELAY_MS',
    'CAMUNDA_SDK_HTTP_RETRY_MAX_DELAY_MS',
  ];
  it.each(
    keys.flatMap((k) => [Infinity, Number.NaN, -1, 1.5, 2 ** 60].map((v) => [k, v] as const))
  )('rejects explicit %s = %s', (key, value) => {
    expect(() => resolveConfig({ ...creds, [key]: value } as never, {})).toThrow(
      CamundaConfigurationError
    );
  });
  it.each(keys)('rejects an overflowing environment %s', (key) => {
    expect(() => resolveConfig(creds, { [key]: '9'.repeat(30) })).toThrow(
      CamundaConfigurationError
    );
  });
  it('rejects maxAttempts 0', () => {
    expect(() => resolveConfig({ ...creds, CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 0 }, {})).toThrow(
      CamundaConfigurationError
    );
  });
  it.each([
    { maxAttempts: Infinity },
    { maxAttempts: Number.NaN },
    { maxAttempts: 0 },
    { maxAttempts: 1.5 },
    { baseDelayMs: -1 },
    { maxDelayMs: Infinity },
  ])('rejects per-call retry %o before sending', async (retry) => {
    const { console, calls } = client(() => new Response(null, { status: 429 }));
    await expect(console.getClusters({ retry })).rejects.toThrow(RangeError);
    expect(calls.filter(isApiCall)).toHaveLength(0);
  });
});

describe('error messages never carry response content', () => {
  it.each(['title', 'detail', 'message', 'type', 'instance'])(
    'keeps a Problem Details %s out of the message',
    async (field) => {
      const { console } = client(() =>
        Response.json({ [field]: 'secret-sentinel-7f3a' }, { status: 400 })
      );
      const err = await console.getCluster({ clusterUuid: 'c1' }).catch((e) => e);
      expect(err.name).toBe('HttpSdkError');
      expect(err.message).not.toContain('secret-sentinel-7f3a');
    }
  );
});

describe('request bodies', () => {
  it('sends {} for a body operation called with only path parameters', async () => {
    const { console, calls } = client(() => new Response(null, { status: 204 }));
    await console.updateCluster({ clusterUuid: 'c1' });
    const [call] = calls.filter(isApiCall);
    expect(JSON.parse(call.body)).toEqual({});
  });
  it('sends no body for a path-only operation', async () => {
    const { console, calls } = client(() => Response.json({}));
    await console.getCluster({ clusterUuid: 'c1' }).catch(() => {});
    expect(calls.filter(isApiCall)[0].body).toBe('');
  });
});

describe('fanatical response validation', () => {
  const member = { email: 'e', invitePending: false, name: 'n', roles: ['admin'] };
  it('rejects unknown fields inside array items', async () => {
    const { console } = client(() => Response.json([{ ...member, unexpected: true }]), {
      CAMUNDA_SDK_VALIDATION: 'req:none,res:fanatical',
    });
    const err = await console.getMembers().catch((e) => e);
    expect(err).toMatchObject({ name: 'ValidationSdkError', side: 'response' });
    expect(err.message).toContain('0.unexpected');
  });
  it('rejects unknown top-level object fields', async () => {
    const { console } = client(
      () => Response.json({ name: 'n', schedule: '0 2 * * *', unexpected: 'secret-value-x' }),
      { CAMUNDA_SDK_VALIDATION: 'req:none,res:fanatical' }
    );
    const err = await console.getBackupSchedule({ clusterUuid: 'c1' }).catch((e) => e);
    expect(err).toMatchObject({ name: 'ValidationSdkError', side: 'response' });
    expect(err.message).toContain('unexpected');
    expect(err.message).not.toContain('secret-value-x');
  });
  it('accepts a conforming response and tolerates extras under strict', async () => {
    const ok = client(() => Response.json([member]), {
      CAMUNDA_SDK_VALIDATION: 'req:none,res:fanatical',
    });
    await expect(ok.console.getMembers()).resolves.toHaveLength(1);
    const strict = client(() => Response.json([{ ...member, unexpected: true }]), {
      CAMUNDA_SDK_VALIDATION: 'req:none,res:strict',
    });
    await expect(strict.console.getMembers()).resolves.toHaveLength(1);
  });
});

describe('retry bookkeeping', () => {
  it('reports the attempts actually sent, not the configured maximum', async () => {
    const { console } = client(() => new Response(null, { status: 400 }), {
      CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 3,
    });
    const err = await console.getClusters().catch((e) => e);
    expect(err.retries).toEqual({ attempt: 1, max: 3 });
  });
  it('counts retries that were sent', async () => {
    const { console } = client(() => new Response(null, { status: 503 }), {
      CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 3,
    });
    const err = await console.getClusters().catch((e) => e);
    expect(err.retries).toEqual({ attempt: 3, max: 3 });
  });
  it('a POST failing with 503 is not retried and reports one attempt', async () => {
    const { console } = client(() => new Response(null, { status: 503 }), {
      CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 3,
    });
    const err = await console
      .createSecret({ clusterUuid: 'c1', secretName: 'n', secretValue: 'v' })
      .catch((e) => e);
    expect(err.retries).toEqual({ attempt: 1, max: 3 });
  });
  it('wraps exhausted network failures as NetworkSdkError', async () => {
    const fake = fakeFetch(() => Response.json([]));
    const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input, init).url;
      if (new URL(url).hostname === 'console.test') throw new TypeError('fetch failed');
      return fake.fetch(input, init);
    }) as typeof fetch;
    const { console } = client(
      () => Response.json([]),
      { CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 2 },
      failing
    );
    const err = await console.getClusters().catch((e) => e);
    expect(err.name).toBe('NetworkSdkError');
  });
});

describe('non-2xx bodies shaped like SdkErrors are still wrapped', () => {
  it.each(['ValidationSdkError', 'NetworkSdkError', 'HttpSdkError'])(
    'wraps a 400 body named %s as an HttpSdkError without leaking its message',
    async (name) => {
      const { console } = client(() =>
        Response.json({ name, message: 'secret-response-content' }, { status: 400 })
      );
      const err = (await console.getClusters().catch((e: unknown) => e)) as Error & {
        status?: number;
      };
      expect(err.name).toBe('HttpSdkError');
      expect(err.status).toBe(400);
      expect(err.message).not.toContain('secret-response-content');
    }
  );
});

describe('unsafe path parameters are rejected before URL construction', () => {
  // encodeURIComponent leaves '', '.' and '..' unchanged, and the WHATWG URL parser then
  // resolves them: '..' would turn DELETE /clusters/{id}/external-idps/.. into a DELETE of
  // the cluster itself. The facade's request validator rejects these before the URL is built,
  // for every operation and validation mode — including values the serializer stringifies.
  it.each(['..', '.', ''])(
    'rejects name %j on deleteExternalIdp and sends nothing',
    async (name) => {
      const { console, calls } = client(() => new Response(null, { status: 204 }));
      const err = await console.deleteExternalIdp({ clusterUuid: 'c1', name }).catch((e) => e);
      expect(err).toMatchObject({ name: 'ValidationSdkError', side: 'request' });
      expect(err.message).not.toContain(`"${name}"`);
      expect(err.issues).toEqual([
        expect.objectContaining({ code: 'invalid_string', path: ['path', 'name'] }),
      ]);
      expect(calls.filter(isApiCall)).toHaveLength(0);
    }
  );
  it.each(['..', '.', ''])('rejects clusterUuid %j on getCluster', async (clusterUuid) => {
    const { console, calls } = client(() => Response.json({}));
    const err = await console.getCluster({ clusterUuid }).catch((e) => e);
    expect(err).toMatchObject({ name: 'ValidationSdkError', side: 'request' });
    expect(calls.filter(isApiCall)).toHaveLength(0);
  });
  it('rejects them even with request validation off', async () => {
    const { console, calls } = client(() => new Response(null, { status: 204 }), {
      CAMUNDA_SDK_VALIDATION: 'req:none,res:none',
    });
    const err = await console
      .putExternalIdpCredential({
        clusterUuid: 'c1',
        name: '..',
        clientSecret: 's',
        type: 'client_secret',
      })
      .catch((e) => e);
    expect(err).toMatchObject({ name: 'ValidationSdkError', side: 'request' });
    expect(err.message).toContain('dot segment');
    expect(calls.filter(isApiCall)).toHaveLength(0);
  });
  it.each([[['..']], [['.']], [['']], [['a', '..']]])(
    'rejects an array path value %j, which the generated serializer would stringify raw',
    async (name) => {
      const { console, calls } = client(() => new Response(null, { status: 204 }), {
        CAMUNDA_SDK_VALIDATION: 'req:none,res:none',
      });
      const err = await console
        .deleteExternalIdp({ clusterUuid: 'c1', name: name as unknown as string })
        .catch((e) => e);
      expect(err).toMatchObject({ name: 'ValidationSdkError', side: 'request' });
      expect(err.message).toContain('dot segment');
      expect(calls.filter(isApiCall)).toHaveLength(0);
    }
  );
  it.each(['a..b', 'a/b', 'a%2Fb', 'a b', '../x'])(
    'sends %j encoded inside its own segment',
    async (name) => {
      const { console, calls } = client(() => new Response(null, { status: 204 }));
      await console.deleteExternalIdp({ clusterUuid: 'c1', name });
      const [call] = calls.filter(isApiCall);
      expect(new URL(call.url).pathname).toBe(
        `/clusters/c1/external-idps/${encodeURIComponent(name)}`
      );
    }
  );
  it('sends an array of safe strings joined inside its own segment', async () => {
    const { console, calls } = client(() => new Response(null, { status: 204 }), {
      CAMUNDA_SDK_VALIDATION: 'req:none,res:none',
    });
    await console.deleteExternalIdp({
      clusterUuid: 'c1',
      name: ['a', 'b'] as unknown as string,
    });
    const [call] = calls.filter(isApiCall);
    expect(new URL(call.url).pathname).toBe('/clusters/c1/external-idps/a,b');
  });
});

describe('putExternalIdpCredential is retried only on 429', () => {
  // Every accepted write restarts the cluster's pods, so although PUT is idempotent in the
  // HTTP sense this operation is not: a transient retry after a lost response could start a
  // second restart or surface the 409 of the first, still-running change.
  const args = { clusterUuid: 'c1', name: 'n', clientSecret: 's', type: 'client_secret' as const };
  it('does not retry a transient 503', async () => {
    const { console, calls } = client(() => new Response(null, { status: 503 }), {
      CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 3,
    });
    const err = await console.putExternalIdpCredential(args).catch((e) => e);
    expect(err).toMatchObject({ name: 'HttpSdkError', status: 503 });
    expect(calls.filter(isApiCall)).toHaveLength(1);
  });
  it('does not retry a network error', async () => {
    const fake = fakeFetch(() => new Response(null, { status: 204 }));
    const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input, init).url;
      if (new URL(url).hostname === 'console.test') throw new TypeError('fetch failed');
      return fake.fetch(input, init);
    }) as typeof fetch;
    const { console } = client(
      () => new Response(null, { status: 204 }),
      { CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 3 },
      failing
    );
    const err = await console.putExternalIdpCredential(args).catch((e) => e);
    expect(err.name).toBe('NetworkSdkError');
    expect(fake.calls.filter(isApiCall)).toHaveLength(0);
  });
  it('still retries 429, which was rate-limited before processing', async () => {
    const { console, calls } = client(
      (_c, i) => new Response(null, { status: i === 0 ? 429 : 204 }),
      { CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 3 }
    );
    await console.putExternalIdpCredential(args);
    expect(calls.filter(isApiCall)).toHaveLength(2);
  });
  it('keeps transient retries for other PUTs such as putExternalIdp', async () => {
    const { console, calls } = client(
      (_c, i) => (i === 0 ? new Response(null, { status: 503 }) : Response.json({})),
      { CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 3 }
    );
    await console
      .putExternalIdp({
        clusterUuid: 'c1',
        name: 'n',
        clientId: 'x',
        clientName: 'N',
        enabled: true,
        issuerUri: 'https://idp.example.com',
        protocol: 'oidc',
      })
      .catch(() => {});
    expect(calls.filter(isApiCall).length).toBeGreaterThan(1);
  });
  it('applies to a low-level generated-client PUT to the credential URL, recognized by URL', async () => {
    const { console, calls } = client(() => new Response(null, { status: 503 }), {
      CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 3,
    });
    await console.client
      .put({
        url: '/clusters/{clusterUuid}/external-idps/{name}/credential',
        path: { clusterUuid: 'c1', name: 'n' },
        body: { clientSecret: 's', type: 'client_secret' },
        throwOnError: false,
      })
      .catch(() => {});
    expect(calls.filter(isApiCall)).toHaveLength(1);
  });
  it('still retries 429 on the low-level credential PUT, rate-limited before processing', async () => {
    const { console, calls } = client(
      (_c, i) => new Response(null, { status: i === 0 ? 429 : 204 }),
      { CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 3 }
    );
    await console.client
      .put({
        url: '/clusters/{clusterUuid}/external-idps/{name}/credential',
        path: { clusterUuid: 'c1', name: 'n' },
        body: { clientSecret: 's', type: 'client_secret' },
        throwOnError: false,
      })
      .catch(() => {});
    expect(calls.filter(isApiCall)).toHaveLength(2);
  });
});
