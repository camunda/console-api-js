import { describe, expect, it } from 'vitest';
import { CamundaConfigurationError, parseValidation, resolveConfig, SCHEMA } from '../src/config';

const creds = { CAMUNDA_CONSOLE_CLIENT_ID: 'a', CAMUNDA_CONSOLE_CLIENT_SECRET: 'b' };

describe('resolveConfig', () => {
  it('applies SaaS defaults', () => {
    expect(
      resolveConfig({ CAMUNDA_CONSOLE_CLIENT_ID: 'a', CAMUNDA_CONSOLE_CLIENT_SECRET: 'b' }, {})
    ).toEqual({
      clientId: 'a',
      clientSecret: 'b',
      baseUrl: SCHEMA.CAMUNDA_CONSOLE_BASE_URL.default,
      oauthUrl: SCHEMA.CAMUNDA_CONSOLE_OAUTH_URL.default,
      audience: SCHEMA.CAMUNDA_CONSOLE_OAUTH_AUDIENCE.default,
      reqValidation: 'strict',
      resValidation: 'none',
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000 },
      logLevel: 'error',
      userAgent: undefined,
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
      {},
      {
        ...creds,
        CAMUNDA_OAUTH_URL: 'https://generic',
        CAMUNDA_CONSOLE_OAUTH_URL: 'https://console',
      }
    );
    expect(c.oauthUrl).toBe('https://console');
  });

  it('prefers explicit config over the environment', () => {
    const c = resolveConfig(
      { CAMUNDA_CONSOLE_CLIENT_ID: 'explicit', CAMUNDA_SDK_VALIDATION: 'none' },
      { ...creds, CAMUNDA_SDK_VALIDATION: 'strict' }
    );
    expect(c.clientId).toBe('explicit');
    expect(c.reqValidation).toBe('none');
    expect(c.resValidation).toBe('none');
  });

  it('names every missing credential', () => {
    expect(() => resolveConfig({}, {})).toThrow(
      /CAMUNDA_CONSOLE_CLIENT_ID[\s\S]*CAMUNDA_CONSOLE_CLIENT_SECRET/
    );
  });

  it('aggregates configuration errors into one CamundaConfigurationError', () => {
    const err = (() => {
      try {
        resolveConfig(
          {},
          {
            CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 'many',
            CAMUNDA_SDK_LOG_LEVEL: 'chatty',
            CAMUNDA_SDK_VALIDATION: 'req:strict,res:pedantic',
          }
        );
      } catch (e) {
        return e as CamundaConfigurationError;
      }
      throw new Error('expected resolveConfig to throw');
    })();
    expect(err).toBeInstanceOf(CamundaConfigurationError);
    expect(err.name).toBe('CamundaConfigurationError');
    expect(err.errors.length).toBeGreaterThanOrEqual(4);
    expect(err.message).toContain('CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS');
    expect(err.message).toContain('CAMUNDA_SDK_LOG_LEVEL');
    expect(err.message).toContain('CAMUNDA_SDK_VALIDATION');
    expect(err.message).toContain('CAMUNDA_CONSOLE_CLIENT_ID');
  });

  it.each([
    ['CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS', '-1'],
    ['CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS', '1.5'],
    ['CAMUNDA_SDK_HTTP_RETRY_BASE_DELAY_MS', 'soon'],
  ])('rejects invalid %s=%s', (name, value) => {
    expect(() => resolveConfig({}, { ...creds, [name]: value })).toThrow(CamundaConfigurationError);
  });

  it.each([
    ['https://api.example.test', 'https://api.example.test'],
    ['https://api.example.test/', 'https://api.example.test'],
    ['https://api.example.test///', 'https://api.example.test'],
    ['https://api.example.test/v1/', 'https://api.example.test/v1'],
  ])('strips trailing slashes from baseUrl %s', (input, expected) => {
    expect(resolveConfig({ ...creds, CAMUNDA_CONSOLE_BASE_URL: input }, {}).baseUrl).toBe(expected);
    expect(resolveConfig({}, { ...creds, CAMUNDA_CONSOLE_BASE_URL: input }).baseUrl).toBe(expected);
  });

  // CodeQL js/polynomial-redos: a regex like /\/+$/ backtracks quadratically on a long run of
  // slashes that is not at the end. Normalisation must stay linear for any input.
  it('normalises a pathological baseUrl in linear time', () => {
    const hostile = `https://x${'/'.repeat(50_000)}y`;
    const start = performance.now();
    expect(resolveConfig({ ...creds, CAMUNDA_CONSOLE_BASE_URL: hostile }, {}).baseUrl).toBe(
      hostile
    );
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe('CAMUNDA_SDK_VALIDATION', () => {
  it.each([
    ['none', { req: 'none', res: 'none' }],
    ['warn', { req: 'warn', res: 'warn' }],
    ['strict', { req: 'strict', res: 'strict' }],
    ['fanatical', { req: 'fanatical', res: 'fanatical' }],
    ['req:strict,res:none', { req: 'strict', res: 'none' }],
    ['res:warn,req:none', { req: 'none', res: 'warn' }],
    ['req:fanatical', { req: 'fanatical', res: 'none' }],
    ['res:strict', { req: 'none', res: 'strict' }],
  ] as const)('parses %s', (raw, expected) => {
    const errors: string[] = [];
    expect(parseValidation(raw, errors)).toEqual(expected);
    expect(errors).toEqual([]);
  });

  it.each(['sometimes', 'req:strict,res:pedantic', 'request:strict', 'req:'])(
    'rejects %s',
    (raw) => {
      const errors: string[] = [];
      parseValidation(raw, errors);
      expect(errors.length).toBeGreaterThan(0);
    }
  );

  it.each(['req:strict,req:none', 'res:warn,res:none', 'req:strict,res:none,req:none'])(
    'rejects duplicate scope in %s (OCA alignment)',
    (raw) => {
      const errors: string[] = [];
      const parsed = parseValidation(raw, errors);
      expect(errors.some((e) => /duplicate scope/.test(e))).toBe(true);
      expect(parsed).toEqual({ req: 'none', res: 'none' });
    }
  );

  it('does not silently disable request validation on req:strict,req:none', () => {
    expect(() =>
      resolveConfig({}, { ...creds, CAMUNDA_SDK_VALIDATION: 'req:strict,req:none' })
    ).toThrow(CamundaConfigurationError);
  });

  it('defaults to req:strict,res:none (stricter than OCA, on purpose)', () => {
    const c = resolveConfig({}, creds);
    expect([c.reqValidation, c.resValidation]).toEqual(['strict', 'none']);
  });
});

describe('CAMUNDA_SDK_LOG_LEVEL', () => {
  it.each(['silent', 'error', 'warn', 'info', 'debug', 'trace', 'silly'] as const)(
    'accepts %s',
    (level) => {
      expect(resolveConfig({}, { ...creds, CAMUNDA_SDK_LOG_LEVEL: level }).logLevel).toBe(level);
    }
  );

  it('accepts an explicit config value over the environment', () => {
    expect(
      resolveConfig(
        { CAMUNDA_SDK_LOG_LEVEL: 'debug' },
        { ...creds, CAMUNDA_SDK_LOG_LEVEL: 'silly' }
      ).logLevel
    ).toBe('debug');
  });
});
