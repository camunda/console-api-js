import { describe, expect, it } from 'vitest';
import { ConsoleClient, USER_AGENT_PRODUCT, VERSION } from '../src';
import { fakeFetch } from './helpers';

const creds = { CAMUNDA_CONSOLE_CLIENT_ID: 'id', CAMUNDA_CONSOLE_CLIENT_SECRET: 'secret' };

async function headersFor(config: Record<string, unknown>, env: Record<string, string> = {}) {
  const { fetch, calls } = fakeFetch(() => Response.json([]));
  const client = new ConsoleClient({ config: { ...creds, ...config }, env, fetch });
  await client.getClusters();
  const token = calls.find((c) => c.url.includes('/oauth/token'));
  const api = calls.find((c) => !c.url.includes('/oauth/token'));
  return { token: token?.headers.get('user-agent'), api: api?.headers.get('user-agent') };
}

describe('User-Agent', () => {
  it('product token uses the package version', () => {
    expect(USER_AGENT_PRODUCT).toBe(`camunda8-console-api-js/${VERSION}`);
  });

  it('is sent on API and token requests', async () => {
    const ua = await headersFor({});
    expect(ua.token).toBe(USER_AGENT_PRODUCT);
    expect(ua.api).toBe(USER_AGENT_PRODUCT);
  });

  it('appends the CAMUNDA_CUSTOM_USER_AGENT_STRING config value', async () => {
    const ua = await headersFor({ CAMUNDA_CUSTOM_USER_AGENT_STRING: 'my-app/1.2' });
    expect(ua.token).toBe(`${USER_AGENT_PRODUCT} my-app/1.2`);
    expect(ua.api).toBe(`${USER_AGENT_PRODUCT} my-app/1.2`);
  });

  it('appends CAMUNDA_CUSTOM_USER_AGENT_STRING from the environment', async () => {
    const ua = await headersFor({}, { CAMUNDA_CUSTOM_USER_AGENT_STRING: 'env-app/3' });
    expect(ua.token).toBe(`${USER_AGENT_PRODUCT} env-app/3`);
    expect(ua.api).toBe(`${USER_AGENT_PRODUCT} env-app/3`);
  });

  it('config wins over the environment variable', async () => {
    const ua = await headersFor(
      { CAMUNDA_CUSTOM_USER_AGENT_STRING: 'opt/1' },
      { CAMUNDA_CUSTOM_USER_AGENT_STRING: 'env/1' }
    );
    expect(ua.token).toBe(`${USER_AGENT_PRODUCT} opt/1`);
    expect(ua.api).toBe(`${USER_AGENT_PRODUCT} opt/1`);
  });
});
