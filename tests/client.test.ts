import { describe, expect, it } from 'vitest';
import { ConsoleClient, isSdkError } from '../src';
import { fakeFetch, isApiCall, testConfig } from './helpers';

function client(
  handler: Parameters<typeof fakeFetch>[0],
  extra: Partial<ConstructorParameters<typeof ConsoleClient>[0]> = {}
) {
  const fake = fakeFetch(handler);
  return {
    ...fake,
    console: new ConsoleClient({
      config: {
        ...testConfig,
        CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 1,
      },
      fetch: fake.fetch,
      env: {},
      ...extra,
    }),
  };
}

describe('ConsoleClient', () => {
  it('returns the parsed response body', async () => {
    const { console } = client(() => Response.json([{ uuid: 'c1', name: 'one' }]));
    expect(await console.getClusters()).toEqual([{ uuid: 'c1', name: 'one' }]);
  });

  it.each([400, 403, 404, 409, 500])('throws HttpSdkError for HTTP %i', async (status) => {
    const { console } = client(() => Response.json({ message: 'nope' }, { status }));
    const err = await console.getCluster({ clusterUuid: 'c1' }).catch((e) => e);
    expect(isSdkError(err)).toBe(true);
    expect(err).toMatchObject({
      name: 'HttpSdkError',
      status,
      operationId: 'GetCluster',
      body: { message: 'nope' },
    });
    // The message carries method, URL, status and operationId — never the body.
    expect(err.message).toContain('GET');
    expect(err.message).toContain('https://console.test/clusters/c1');
    expect(err.message).toContain(String(status));
    expect(err.message).toContain('GetCluster');
    expect(err.message).not.toContain('nope');
  });

  it('passes RFC 9457 Problem Details fields through on HttpSdkError', async () => {
    const problem = {
      type: 'https://console.test/problems/rate-limited',
      title: 'Rate limited',
      detail: 'Too many requests',
      instance: '/clusters/c1',
    };
    const { console } = client(() => Response.json(problem, { status: 429 }));
    const err = await console.getCluster({ clusterUuid: 'c1' }).catch((e) => e);
    expect(err).toMatchObject({ name: 'HttpSdkError', status: 429, ...problem });
  });

  it('throws HttpSdkError for a non-2xx response with an empty body', async () => {
    const { console } = client(() => new Response(null, { status: 403 }));
    await expect(console.deleteCluster({ clusterUuid: 'c1' })).rejects.toMatchObject({
      name: 'HttpSdkError',
      status: 403,
    });
  });

  it('returns the activity CSV as text', async () => {
    const csv = 'time,event\n1,created\n';
    const { console } = client(
      () => new Response(csv, { headers: { 'content-type': 'text/csv' } })
    );
    expect(await console.getActivityEventsCsv()).toBe(csv);
  });

  it('validates request bodies by default and does not send an invalid request', async () => {
    const { console, calls } = client(() => Response.json({}));
    await expect(
      console.createMonitoringClient({ clusterUuid: 'c1', username: 42 } as never)
    ).rejects.toMatchObject({ name: 'ValidationSdkError', side: 'request' });
    expect(calls.filter(isApiCall)).toHaveLength(0);
  });

  it('can turn request validation off', async () => {
    const { console, calls } = client(() => Response.json({}), {
      config: { ...testConfig, CAMUNDA_SDK_VALIDATION: 'req:none,res:none' },
    });
    await console.createMonitoringClient({ clusterUuid: 'c1', username: 42 } as never);
    expect(calls.filter(isApiCall)).toHaveLength(1);
  });

  it('tolerates responses that do not match the spec unless response validation is on', async () => {
    const offSpec = () => Response.json({ unexpected: true });
    await expect(client(offSpec).console.getCluster({ clusterUuid: 'c1' })).resolves.toEqual({
      unexpected: true,
    });
    await expect(
      client(offSpec, {
        config: { ...testConfig, CAMUNDA_SDK_VALIDATION: 'req:strict,res:strict' },
      }).console.getCluster({ clusterUuid: 'c1' })
    ).rejects.toMatchObject({ name: 'ValidationSdkError', side: 'response' });
  });

  it('warns instead of throwing in warn mode', async () => {
    const { console, calls } = client(() => Response.json({}), {
      config: { ...testConfig, CAMUNDA_SDK_VALIDATION: 'req:warn,res:none' },
    });
    // An unknown field is off-spec for the generated strict request validator; warn mode logs
    // the issues (never values) and still sends the request.
    await console.createMonitoringClient({ clusterUuid: 'c1', bogusField: 1 } as never);
    expect(calls.filter(isApiCall)).toHaveLength(1);
  });

  it('fanatical rejects unknown body fields that strict tolerates', async () => {
    const { console, calls } = client(() => Response.json({}), {
      config: { ...testConfig, CAMUNDA_SDK_VALIDATION: 'req:fanatical,res:none' },
    });
    const err = await console
      .createSecret({ clusterUuid: 'c1', secretName: 'n', secretValue: 'v', bogus: 1 } as never)
      .catch((e) => e);
    expect(err).toMatchObject({
      name: 'ValidationSdkError',
      side: 'request',
      operationId: 'CreateSecret',
    });
    expect(err.message).toContain('bogus');
    expect(calls.filter(isApiCall)).toHaveLength(0);
  });
});

describe('per-call retry override', () => {
  const flaky429 = (_c: unknown, i: number) => new Response(null, { status: i < 2 ? 429 : 200 });

  it('retries with the global policy by default', async () => {
    const { console, calls } = client(flaky429, {
      config: { ...testConfig, CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 3 },
      sleep: async () => {},
    });
    await console.getClusters();
    expect(calls.filter(isApiCall)).toHaveLength(3);
  });

  it('retry: false disables retry for that call', async () => {
    const { console, calls } = client(flaky429, {
      config: { ...testConfig, CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 3 },
      sleep: async () => {},
    });
    await expect(console.getClusters({ retry: false })).rejects.toMatchObject({
      name: 'HttpSdkError',
      status: 429,
      retries: { attempt: 1, max: 1 },
    });
    expect(calls.filter(isApiCall)).toHaveLength(1);
  });

  it('a partial policy overrides individual fields for that call', async () => {
    const { console, calls } = client(() => new Response(null, { status: 429 }), {
      config: { ...testConfig, CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 3 },
      sleep: async () => {},
    });
    await expect(console.getClusters({ retry: { maxAttempts: 5 } })).rejects.toMatchObject({
      name: 'HttpSdkError',
      status: 429,
      retries: { attempt: 5, max: 5 },
    });
    expect(calls.filter(isApiCall)).toHaveLength(5);
  });
});
