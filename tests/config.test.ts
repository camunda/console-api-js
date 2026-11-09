import { describe, expect, it } from 'vitest';
import { ConsoleApiConfigError, DEFAULTS, resolveConfig } from '../src/config';

describe('resolveConfig', () => {
  it('applies SaaS defaults', () => {
    expect(resolveConfig({ clientId: 'a', clientSecret: 'b' }, {})).toEqual({
      clientId: 'a',
      clientSecret: 'b',
      ...DEFAULTS,
    });
  });

  it('reads the same environment variables as @camunda8/sdk', () => {
    const c = resolveConfig(
      {},
      {
        CAMUNDA_CONSOLE_CLIENT_ID: 'env-id',
        CAMUNDA_CONSOLE_CLIENT_SECRET: 'env-secret',
        CAMUNDA_CONSOLE_BASE_URL: 'https://example.test/',
        CAMUNDA_OAUTH_URL: 'https://login.example.test/oauth/token',
        CAMUNDA_CONSOLE_OAUTH_AUDIENCE: 'aud',
      }
    );
    expect(c).toMatchObject({
      clientId: 'env-id',
      clientSecret: 'env-secret',
      baseUrl: 'https://example.test',
      oauthUrl: 'https://login.example.test/oauth/token',
      audience: 'aud',
    });
  });

  it('prefers CAMUNDA_CONSOLE_OAUTH_URL over CAMUNDA_OAUTH_URL', () => {
    const c = resolveConfig(
      { clientId: 'a', clientSecret: 'b' },
      { CAMUNDA_OAUTH_URL: 'https://generic', CAMUNDA_CONSOLE_OAUTH_URL: 'https://console' }
    );
    expect(c.oauthUrl).toBe('https://console');
  });

  it('prefers explicit options over the environment', () => {
    const c = resolveConfig(
      { clientId: 'explicit', clientSecret: 'b', validateResponses: false },
      { CAMUNDA_CONSOLE_CLIENT_ID: 'env', CAMUNDA_CONSOLE_VALIDATE_RESPONSES: 'true' }
    );
    expect(c.clientId).toBe('explicit');
    expect(c.validateResponses).toBe(false);
  });

  it('names every missing credential', () => {
    expect(() => resolveConfig({}, {})).toThrow(
      /CAMUNDA_CONSOLE_CLIENT_ID.*CAMUNDA_CONSOLE_CLIENT_SECRET/
    );
  });

  it.each([
    ['CAMUNDA_CONSOLE_VALIDATE_RESPONSES', 'yes'],
    ['CAMUNDA_CONSOLE_VALIDATE_REQUESTS', 'maybe'],
    ['CAMUNDA_CONSOLE_MAX_RETRIES', '-1'],
    ['CAMUNDA_CONSOLE_MAX_RETRIES', '1.5'],
  ])('rejects invalid %s=%s', (name, value) => {
    expect(() =>
      resolveConfig(
        {},
        { CAMUNDA_CONSOLE_CLIENT_ID: 'a', CAMUNDA_CONSOLE_CLIENT_SECRET: 'b', [name]: value }
      )
    ).toThrow(ConsoleApiConfigError);
  });

  it('rejects an invalid explicit maxRetries', () => {
    expect(() => resolveConfig({ clientId: 'a', clientSecret: 'b', maxRetries: -2 }, {})).toThrow(
      ConsoleApiConfigError
    );
  });
});
