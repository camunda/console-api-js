import { describe, expect, it } from 'vitest';
import { ConsoleApiError, ConsoleClient } from '../src';
import { fakeFetch } from './helpers';

function client(
  handler: Parameters<typeof fakeFetch>[0],
  extra: Partial<ConstructorParameters<typeof ConsoleClient>[0]> = {}
) {
  const fake = fakeFetch(handler);
  return {
    ...fake,
    console: new ConsoleClient({
      clientId: 'id',
      clientSecret: 's',
      baseUrl: 'https://console.test',
      maxRetries: 0,
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

  it.each([400, 403, 404, 409, 500])('throws ConsoleApiError for HTTP %i', async (status) => {
    const { console } = client(() => Response.json({ message: 'nope' }, { status }));
    const err = await console.getCluster('c1').catch((e) => e);
    expect(err).toBeInstanceOf(ConsoleApiError);
    expect(err).toMatchObject({
      status,
      method: 'GET',
      url: 'https://console.test/clusters/c1',
      body: { message: 'nope' },
    });
    expect(err.message).toContain('nope');
  });

  it('throws ConsoleApiError for a non-2xx response with an empty body', async () => {
    const { console } = client(() => new Response(null, { status: 403 }));
    await expect(console.deleteCluster('c1')).rejects.toMatchObject({ status: 403 });
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
    await expect(console.createMonitoringClient('c1', { username: 42 } as never)).rejects.toThrow();
    expect(calls.filter((c) => c.url.startsWith('https://console.test'))).toHaveLength(0);
  });

  it('can turn request validation off', async () => {
    const { console, calls } = client(() => Response.json({}), { validateRequests: false });
    await console.createMonitoringClient('c1', { username: 42 } as never);
    expect(calls.filter((c) => c.url.startsWith('https://console.test'))).toHaveLength(1);
  });

  it('tolerates responses that do not match the spec unless response validation is on', async () => {
    const offSpec = () => Response.json({ unexpected: true });
    await expect(client(offSpec).console.getCluster('c1')).resolves.toEqual({ unexpected: true });
    await expect(
      client(offSpec, { validateResponses: true }).console.getCluster('c1')
    ).rejects.toThrow();
  });
});
