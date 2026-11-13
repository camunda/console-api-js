/**
 * Configuration schema: the single source of truth for every `CAMUNDA_*` setting the client
 * understands. Mirrors the pattern of `@camunda8/orchestration-cluster-api`
 * (`src/runtime/configSchema.ts`): each entry describes one environment variable, and the
 * `config` object passed to `createConsoleClient` uses the same env-var names as keys.
 *
 * The `CAMUNDA_CONSOLE_*` names stay compatible with `@camunda8/sdk`; the `CAMUNDA_SDK_*`
 * names match OCA exactly.
 */

export type ValidationMode = 'none' | 'warn' | 'strict' | 'fanatical';

export const SCHEMA = {
  CAMUNDA_CONSOLE_CLIENT_ID: {
    type: 'string',
    secret: true,
    doc: 'Console API OAuth client id (Organization → Administration API).',
  },
  CAMUNDA_CONSOLE_CLIENT_SECRET: {
    type: 'string',
    secret: true,
    doc: 'Console API OAuth client secret.',
  },
  CAMUNDA_CONSOLE_BASE_URL: {
    type: 'string',
    default: 'https://api.cloud.camunda.io',
    doc: 'Base URL of the Console API.',
  },
  CAMUNDA_CONSOLE_OAUTH_URL: {
    type: 'string',
    default: 'https://login.cloud.camunda.io/oauth/token',
    aliases: ['CAMUNDA_OAUTH_URL'],
    doc: 'OAuth token endpoint. Legacy alias: CAMUNDA_OAUTH_URL (used only when CAMUNDA_CONSOLE_OAUTH_URL is unset).',
  },
  CAMUNDA_CONSOLE_OAUTH_AUDIENCE: {
    type: 'string',
    default: 'api.cloud.camunda.io',
    doc: 'OAuth audience for Console tokens.',
  },
  CAMUNDA_SDK_VALIDATION: {
    type: 'string',
    default: 'req:strict,res:none',
    doc: 'Validation mini-language: none | warn | strict | fanatical, or req:<mode>,res:<mode>. Default differs from OCA (req:none,res:none): request payloads are validated before sending because a malformed Console request can create or mutate SaaS resources.',
  },
  CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: {
    type: 'int',
    default: 3,
    doc: 'Maximum total HTTP attempts (including the initial attempt) for transient failures (429 always; 502/503/504 and network errors for idempotent methods only).',
  },
  CAMUNDA_SDK_HTTP_RETRY_BASE_DELAY_MS: {
    type: 'int',
    default: 100,
    doc: 'Base delay in milliseconds for exponential backoff (full jitter) for HTTP retries.',
  },
  CAMUNDA_SDK_HTTP_RETRY_MAX_DELAY_MS: {
    type: 'int',
    default: 10_000,
    doc: 'Maximum delay cap in milliseconds for HTTP retry backoff.',
  },
  CAMUNDA_SDK_LOG_LEVEL: {
    type: 'enum',
    choices: ['silent', 'error', 'warn', 'info', 'debug', 'trace', 'silly'] as const,
    default: 'error',
    doc: 'SDK log level. Unlike OCA, "silly" never logs response bodies or token responses: Console responses can contain connector secrets.',
  },
  CAMUNDA_CUSTOM_USER_AGENT_STRING: {
    type: 'string',
    doc: 'Appended, after a space, to the User-Agent sent on every request (camunda8-console-api-js/<version> <value>).',
  },
  CAMUNDA_CUSTOM_ROOT_CERT_PATH: {
    type: 'string',
    doc: 'Path to a PEM root certificate to trust in addition to the system trust store. Wins over CAMUNDA_CUSTOM_ROOT_CERT_STRING within the same source.',
  },
  CAMUNDA_CUSTOM_ROOT_CERT_STRING: {
    type: 'string',
    secret: true,
    doc: 'Inline PEM root certificate to trust in addition to the system trust store.',
  },
} as const;

export type EnvVarKey = keyof typeof SCHEMA;

type PrimitiveType<T> = T extends { type: 'string' }
  ? string
  : T extends { type: 'int' }
    ? number
    : T extends { type: 'enum'; choices: readonly (infer C)[] }
      ? C
      : never;

export type EnvVarValue<K extends EnvVarKey> = PrimitiveType<(typeof SCHEMA)[K]>;

/**
 * The `config` object of `createConsoleClient({ config: { ... } })`: strongly typed overrides
 * keyed by their environment variable names, as in OCA. Explicit config wins over the
 * environment, which wins over defaults.
 */
export type ConsoleConfig = Partial<{ [K in EnvVarKey]: EnvVarValue<K> }>;

export function isSecret(key: EnvVarKey): boolean {
  return 'secret' in SCHEMA[key] && SCHEMA[key].secret === true;
}

export function aliases(key: EnvVarKey): readonly string[] {
  const entry = SCHEMA[key];
  return 'aliases' in entry ? entry.aliases : [];
}

export function defaultValue<K extends EnvVarKey>(key: K): EnvVarValue<K> | undefined {
  return 'default' in SCHEMA[key] ? (SCHEMA[key].default as EnvVarValue<K>) : undefined;
}

export function allKeys(): EnvVarKey[] {
  return Object.keys(SCHEMA) as EnvVarKey[];
}
