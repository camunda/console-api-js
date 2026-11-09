/**
 * Read-only checks against a real Camunda SaaS organisation. They verify that real responses
 * match the published spec, which is why response validation is turned on here (except for
 * getSecrets, whose values must never reach a log).
 *
 * Run with: CONSOLE_API_INTEGRATION=1 CAMUNDA_CONSOLE_CLIENT_ID=... CAMUNDA_CONSOLE_CLIENT_SECRET=... npm run test:integration
 */
import { describe, expect, it } from 'vitest';
import { ConsoleApiError, createConsoleClient } from '../src';

describe('Console API (live, read-only)', () => {
  const consoleApi = createConsoleClient({ validateResponses: true });

  it('getParameters matches the spec', async () => {
    const params = await consoleApi.getParameters();
    expect(params).toBeDefined();
  });

  it('getIpRanges matches the spec', async () => {
    await consoleApi.getIpRanges();
  });

  it('getMembers matches the spec', async () => {
    expect(Array.isArray(await consoleApi.getMembers())).toBe(true);
  });

  it('getClusters and per-cluster reads match the spec', async () => {
    const clusters = await consoleApi.getClusters();
    expect(Array.isArray(clusters)).toBe(true);
    const [first] = clusters;
    if (!first) return;
    await consoleApi.getCluster(first.uuid);
    await consoleApi.getClients(first.uuid);
    await consoleApi.getBackups(first.uuid);
  });

  // getSecrets returns real connector secret values. This test must never put them into an
  // assertion diff, error message or log: it checks the shape only, with response validation
  // off, and rethrows any failure without the response data.
  it('getSecrets returns a map of string values (values are never logged)', async () => {
    const [first] = await consoleApi.getClusters();
    if (!first) return;
    const unvalidated = createConsoleClient({ validateResponses: false });
    let secrets: unknown;
    try {
      secrets = await unvalidated.getSecrets(first.uuid);
    } catch (e) {
      const status = e instanceof ConsoleApiError ? e.status : undefined;
      throw new Error(
        `getSecrets failed (${(e as Error).name}, status ${status ?? 'n/a'}); details withheld`
      );
    }
    const isStringMap =
      typeof secrets === 'object' &&
      secrets !== null &&
      !Array.isArray(secrets) &&
      Object.values(secrets).every((v) => typeof v === 'string');
    expect(isStringMap, 'getSecrets response is not a map of string values').toBe(true);
  });

  it('getActivityEvents and getActivityEventsCsv match the spec', async () => {
    await consoleApi.getActivityEvents();
    expect(typeof (await consoleApi.getActivityEventsCsv())).toBe('string');
  });
});
