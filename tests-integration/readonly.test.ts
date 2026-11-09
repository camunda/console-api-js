/**
 * Read-only checks against a real Camunda SaaS organisation. They verify that real responses
 * match the published spec, which is why response validation is turned on here.
 *
 * Run with: CONSOLE_API_INTEGRATION=1 CAMUNDA_CONSOLE_CLIENT_ID=... CAMUNDA_CONSOLE_CLIENT_SECRET=... npm run test:integration
 */
import { describe, expect, it } from 'vitest';
import { createConsoleClient } from '../src';

describe('Console API (live, read-only)', () => {
  const console = createConsoleClient({ validateResponses: true });

  it('getParameters matches the spec', async () => {
    const params = await console.getParameters();
    expect(params).toBeDefined();
  });

  it('getIpRanges matches the spec', async () => {
    await console.getIpRanges();
  });

  it('getMembers matches the spec', async () => {
    expect(Array.isArray(await console.getMembers())).toBe(true);
  });

  it('getClusters and per-cluster reads match the spec', async () => {
    const clusters = await console.getClusters();
    expect(Array.isArray(clusters)).toBe(true);
    const [first] = clusters;
    if (!first) return;
    await console.getCluster(first.uuid);
    await console.getClients(first.uuid);
    await console.getSecrets(first.uuid);
    await console.getBackups(first.uuid);
  });

  it('getActivityEvents and getActivityEventsCsv match the spec', async () => {
    await console.getActivityEvents();
    expect(typeof (await console.getActivityEventsCsv())).toBe('string');
  });
});
