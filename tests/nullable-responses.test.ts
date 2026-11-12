import { describe, expect, it } from 'vitest';
import { ConsoleApiValidationError, ConsoleClient } from '../src';
import { fakeFetch } from './helpers';

// Live SaaS responses carry nulls and omit fields that an older spec snapshot declared as
// required strings. These fixtures pin the shapes the published spec accepts, with response
// validation on, so a spec refresh that tightens them again fails here rather than only in the
// scheduled live integration run.

function clientReturning(body: unknown) {
  const fake = fakeFetch(() => Response.json(body));
  return new ConsoleClient({
    clientId: 'id',
    clientSecret: 's',
    baseUrl: 'https://console.test',
    maxRetries: 0,
    fetch: fake.fetch,
    env: {},
    validateResponses: true,
  });
}

const ref = { name: 'n', uuid: 'u' };

const cluster = {
  uuid: 'cluster-1',
  name: 'cluster',
  ownerId: 'owner',
  created: '2026-01-01T00:00:00Z',
  planType: ref,
  region: { uuid: 'region-1' },
  generation: ref,
  channel: ref,
  autoUpdate: true,
  status: { ready: 'Healthy' },
  links: {},
  encryption: { type: 'Software' },
};

const audit = {
  service: 'console',
  orgId: 'org',
  audit: 'cluster.created',
  auditType: 'c',
  entity: 'cluster',
  entityId: 'cluster-1',
  userId: 'user',
};

const byomClient = { username: 'monitor', uuid: 'client-1', created: null, createdBy: null };

const byomStatus = {
  metricsEndpoint: { target: 't', scheme: 'https', path: '/metrics' },
  conditions: [],
};

describe('responses with null and omitted fields pass validation', () => {
  it.each([
    ['Cluster with optional fields omitted', cluster],
    [
      'Cluster with null description and allow lists',
      { ...cluster, description: null, ipallowlist: null, ipwhitelist: null },
    ],
    [
      'Cluster with per-key encryption status',
      {
        ...cluster,
        encryption: {
          type: 'External',
          status: 'ExternalEncryptionKeyGrantNotReady',
          primaryKeyArn: 'arn:primary',
          primaryKeyStatus: { reason: 'KeyAccessDenied', message: 'denied' },
        },
      },
    ],
  ])('getClusters: %s', async (_, body) => {
    await expect(clientReturning([body]).getClusters()).resolves.toEqual([body]);
  });

  it.each([
    ['AuditDto with optional fields omitted', audit],
    [
      'AuditDto with null entity fields',
      {
        ...audit,
        entityAttribute: null,
        entityAttributeValueFrom: null,
        entityAttributeValueTo: null,
        parentEntity: null,
        parentEntityId: null,
      },
    ],
  ])('getActivityEvents: %s', async (_, body) => {
    await expect(clientReturning([body]).getActivityEvents()).resolves.toEqual([body]);
  });

  it.each([
    ['ByomClientDto with null timestamps and no name', byomClient],
    [
      'ByomClientDto with every optional field set',
      {
        ...byomClient,
        created: '2026-01-01T00:00:00Z',
        createdBy: 'b',
        createdByName: 'B',
        lastUsed: null,
      },
    ],
  ])('getMonitoringClients: %s', async (_, client) => {
    const body = { clients: [client], status: byomStatus };
    await expect(clientReturning(body).getMonitoringClients('cluster-1')).resolves.toEqual(body);
  });
});

describe('monitoring-client credentials still require a password', () => {
  const calls = {
    createMonitoringClient: (c: ConsoleClient) =>
      c.createMonitoringClient('cluster-1', { username: 'monitor' }),
    rotateMonitoringClientPassword: (c: ConsoleClient) =>
      c.rotateMonitoringClientPassword('cluster-1', 'client-1'),
  };

  it.each(Object.entries(calls))('%s accepts a response with a password', async (_, call) => {
    const body = { ...byomClient, password: 'pw' };
    await expect(call(clientReturning(body))).resolves.toEqual(body);
  });

  it.each(Object.entries(calls))('%s rejects a response without a password', async (_, call) => {
    await expect(call(clientReturning(byomClient))).rejects.toBeInstanceOf(
      ConsoleApiValidationError
    );
  });
});

it('still rejects a wrongly typed value, so validation is really on', async () => {
  await expect(
    clientReturning([{ ...cluster, description: 42 }]).getClusters()
  ).rejects.toBeInstanceOf(ConsoleApiValidationError);
});
