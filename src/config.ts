/**
 * Configuration for the Console API client.
 *
 * Every option can be supplied explicitly or read from the environment. The environment variable
 * names match the ones used by `@camunda8/sdk`, so existing deployments keep working when they move
 * from `Camunda8.getAdminApiClient()` to this package.
 */
export interface ConsoleApiConfig {
  /** Console API client id. Env: `CAMUNDA_CONSOLE_CLIENT_ID`. */
  clientId: string;
  /** Console API client secret. Env: `CAMUNDA_CONSOLE_CLIENT_SECRET`. */
  clientSecret: string;
  /** Base URL of the Console API. Env: `CAMUNDA_CONSOLE_BASE_URL`. */
  baseUrl: string;
  /** OAuth token endpoint. Env: `CAMUNDA_CONSOLE_OAUTH_URL`, then `CAMUNDA_OAUTH_URL`. */
  oauthUrl: string;
  /** OAuth audience for Console tokens. Env: `CAMUNDA_CONSOLE_OAUTH_AUDIENCE`. */
  audience: string;
  /** Validate request payloads against the spec before sending. Default `true`. */
  validateRequests: boolean;
  /**
   * Validate response payloads against the spec. Default `false`: the published spec is not
   * guaranteed to match every server response, and a mismatch should not break callers.
   * Env: `CAMUNDA_CONSOLE_VALIDATE_RESPONSES=true`.
   */
  validateResponses: boolean;
  /** Maximum retries for throttled (429) and transient (502/503/504) responses. Default `3`. */
  maxRetries: number;
  /**
   * Appended, after a space, to the `User-Agent` sent on every request
   * (`camunda8-console-api-js/<version> <userAgent>`). Env: `CAMUNDA_CUSTOM_USER_AGENT_STRING`,
   * as in `@camunda8/sdk`. Optional.
   */
  userAgent?: string;
}

export const DEFAULTS = {
  baseUrl: 'https://api.cloud.camunda.io',
  oauthUrl: 'https://login.cloud.camunda.io/oauth/token',
  audience: 'api.cloud.camunda.io',
  validateRequests: true,
  validateResponses: false,
  maxRetries: 3,
} as const;

export class ConsoleApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleApiConfigError';
  }
}

function parseBool(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new ConsoleApiConfigError(`${name} must be true or false, got "${value}"`);
}

function parseNonNegativeInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ConsoleApiConfigError(`${name} must be a non-negative integer, got "${value}"`);
  }
  return n;
}

/**
 * Merge explicit options over environment variables over defaults, and check required values.
 * Explicit options always win.
 */
export function resolveConfig(
  options: Partial<ConsoleApiConfig> = {},
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {}
): ConsoleApiConfig {
  const pick = (...names: string[]) => {
    for (const n of names) {
      const v = env[n];
      if (v !== undefined && v !== '') return v;
    }
    return undefined;
  };

  const config: ConsoleApiConfig = {
    clientId: options.clientId ?? pick('CAMUNDA_CONSOLE_CLIENT_ID') ?? '',
    clientSecret: options.clientSecret ?? pick('CAMUNDA_CONSOLE_CLIENT_SECRET') ?? '',
    baseUrl: options.baseUrl ?? pick('CAMUNDA_CONSOLE_BASE_URL') ?? DEFAULTS.baseUrl,
    oauthUrl:
      options.oauthUrl ??
      pick('CAMUNDA_CONSOLE_OAUTH_URL', 'CAMUNDA_OAUTH_URL') ??
      DEFAULTS.oauthUrl,
    audience: options.audience ?? pick('CAMUNDA_CONSOLE_OAUTH_AUDIENCE') ?? DEFAULTS.audience,
    validateRequests:
      options.validateRequests ??
      parseBool('CAMUNDA_CONSOLE_VALIDATE_REQUESTS', env.CAMUNDA_CONSOLE_VALIDATE_REQUESTS) ??
      DEFAULTS.validateRequests,
    validateResponses:
      options.validateResponses ??
      parseBool('CAMUNDA_CONSOLE_VALIDATE_RESPONSES', env.CAMUNDA_CONSOLE_VALIDATE_RESPONSES) ??
      DEFAULTS.validateResponses,
    maxRetries:
      options.maxRetries ??
      parseNonNegativeInt('CAMUNDA_CONSOLE_MAX_RETRIES', env.CAMUNDA_CONSOLE_MAX_RETRIES) ??
      DEFAULTS.maxRetries,
    userAgent: options.userAgent ?? pick('CAMUNDA_CUSTOM_USER_AGENT_STRING'),
  };

  const missing: string[] = [];
  if (!config.clientId) missing.push('clientId (CAMUNDA_CONSOLE_CLIENT_ID)');
  if (!config.clientSecret) missing.push('clientSecret (CAMUNDA_CONSOLE_CLIENT_SECRET)');
  if (missing.length) {
    throw new ConsoleApiConfigError(`Missing required configuration: ${missing.join(', ')}`);
  }
  if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0) {
    throw new ConsoleApiConfigError(
      `maxRetries must be a non-negative integer, got ${config.maxRetries}`
    );
  }
  config.baseUrl = stripTrailingSlashes(config.baseUrl);
  return config;
}

/** Remove trailing '/' characters. A loop, not /\/+$/, which backtracks quadratically. */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return url.slice(0, end);
}
