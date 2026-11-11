import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  aliases,
  type ConsoleConfig,
  type EnvVarKey,
  SCHEMA,
  type ValidationMode,
} from './configSchema';
import type { LogLevel } from './logger';

export { type ConsoleConfig, type EnvVarKey, SCHEMA } from './configSchema';
export type { Logger, LogLevel } from './logger';
export type { ValidationMode };

/**
 * Configuration error, aligned with `@camunda8/orchestration-cluster-api`
 * (`CamundaConfigurationError`): one error carrying every problem found, keyed by the
 * `CAMUNDA_*` name. Messages name the setting and the expected shape, never the value.
 */
export class CamundaConfigurationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join('\n'));
    this.name = 'CamundaConfigurationError';
    this.errors = errors;
  }
}

/** The resolved client configuration, camelCased for internal use. */
export interface ResolvedConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  oauthUrl: string;
  audience: string;
  /** Request validation mode. Default `strict` (see CAMUNDA_SDK_VALIDATION). */
  reqValidation: ValidationMode;
  /** Response validation mode. Default `none` (see CAMUNDA_SDK_VALIDATION). */
  resValidation: ValidationMode;
  retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  logLevel: LogLevel;
  userAgent?: string;
  /** PEM root certificate, after resolution from path or inline string. */
  customRootCert?: string;
  /** Absolute path the PEM was read from, when CAMUNDA_CUSTOM_ROOT_CERT_PATH was used. */
  customRootCertPath?: string;
}

const VALIDATION_MODES = new Set<ValidationMode>(['none', 'warn', 'strict', 'fanatical']);

/**
 * Parse the CAMUNDA_SDK_VALIDATION mini-language (OCA's grammar):
 * `none | warn | strict | fanatical | req:<mode>,res:<mode>` in any order.
 */
export function parseValidation(
  raw: string,
  errors: string[]
): { req: ValidationMode; res: ValidationMode } {
  const val = raw.trim().toLowerCase();
  if (VALIDATION_MODES.has(val as ValidationMode)) {
    return { req: val as ValidationMode, res: val as ValidationMode };
  }
  let req: ValidationMode | undefined;
  let res: ValidationMode | undefined;
  const parts = val
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    const [lhs, rhs] = part.split(':').map((s) => s?.trim());
    if ((lhs !== 'req' && lhs !== 'res') || !rhs || !VALIDATION_MODES.has(rhs as ValidationMode)) {
      errors.push(
        `CAMUNDA_SDK_VALIDATION has invalid syntax "${part}"; expected none | warn | strict | fanatical or req:<mode>,res:<mode>`
      );
      return { req: 'none', res: 'none' };
    }
    if (lhs === 'req') req = rhs as ValidationMode;
    else res = rhs as ValidationMode;
  }
  if (req === undefined && res === undefined) {
    errors.push(
      'CAMUNDA_SDK_VALIDATION must name a mode; expected none | warn | strict | fanatical or req:<mode>,res:<mode>'
    );
    return { req: 'none', res: 'none' };
  }
  return { req: req ?? 'none', res: res ?? 'none' };
}

function parseInt_(key: string, raw: string, errors: string[]): number | undefined {
  const v = raw.trim();
  if (/^[0-9]+$/.test(v)) {
    const n = Number.parseInt(v, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  errors.push(`${key} must be a non-negative integer`);
  return undefined;
}

/** Read the raw string for a key: explicit config first, then the env var, then its aliases. */
function readRaw(
  key: EnvVarKey,
  config: ConsoleConfig,
  env: Record<string, string | undefined>
): string | undefined {
  const explicit = config[key];
  if (explicit !== undefined) return String(explicit);
  const fromEnv = env[key];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  for (const alias of aliases(key)) {
    const v = env[alias];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/**
 * Resolve the custom root certificate. Explicit config wins over the environment; within each
 * source the path wins over the inline string, matching `@camunda8/sdk`.
 */
function resolveCustomRootCert(
  config: ConsoleConfig,
  env: Record<string, string | undefined>,
  errors: string[],
  warn: (message: string) => void
): { customRootCert?: string; customRootCertPath?: string } {
  const explicit =
    config.CAMUNDA_CUSTOM_ROOT_CERT_PATH !== undefined ||
    config.CAMUNDA_CUSTOM_ROOT_CERT_STRING !== undefined;
  const pathOption = explicit
    ? config.CAMUNDA_CUSTOM_ROOT_CERT_PATH
    : readRaw('CAMUNDA_CUSTOM_ROOT_CERT_PATH', {}, env);
  let pem: string | undefined;
  let absPath: string | undefined;
  if (pathOption) {
    absPath = resolvePath(process.cwd(), pathOption);
    try {
      pem = readFileSync(absPath, 'utf8');
    } catch (e) {
      errors.push(
        `Cannot read custom root certificate at ${absPath} (CAMUNDA_CUSTOM_ROOT_CERT_PATH): ${(e as Error).message}`
      );
      return {};
    }
    if (pem.trim() === '') {
      errors.push(`Custom root certificate at ${absPath} (CAMUNDA_CUSTOM_ROOT_CERT_PATH) is empty`);
      return {};
    }
  } else {
    pem = explicit
      ? config.CAMUNDA_CUSTOM_ROOT_CERT_STRING
      : readRaw('CAMUNDA_CUSTOM_ROOT_CERT_STRING', {}, env);
  }
  if (!pem) return {};
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch (e) {
    errors.push(
      `Custom root certificate${absPath ? ` at ${absPath}` : ''} is not a valid PEM certificate: ${(e as Error).message}`
    );
    return {};
  }
  if (cert.issuer !== cert.subject) {
    warn(
      `Custom root certificate${absPath ? ` at ${absPath}` : ''} is not self-issued (issuer "${cert.issuer}" differs from subject "${cert.subject}"); it may not be a root certificate.`
    );
  }
  return absPath ? { customRootCert: pem, customRootCertPath: absPath } : { customRootCert: pem };
}

/**
 * Merge explicit `config` over the environment over defaults, and check required values.
 * Explicit config always wins.
 */
export function resolveConfig(
  config: ConsoleConfig = {},
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
  warn: (message: string) => void = (m) => console.warn(`[@camunda8/console-api] ${m}`)
): ResolvedConfig {
  const errors: string[] = [];

  const str = (key: EnvVarKey): string | undefined => readRaw(key, config, env);
  const int = (key: EnvVarKey): number | undefined => {
    if (config[key] !== undefined) {
      const v = config[key] as unknown;
      // Explicit values get the same checks as environment values: a non-negative safe
      // integer (no Infinity, NaN, fractions or negatives).
      if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
      if (typeof v === 'string') return parseInt_(key, v, errors);
      errors.push(`${key} must be a non-negative integer`);
      return undefined;
    }
    const raw = readRaw(key, {}, env);
    return raw === undefined ? undefined : parseInt_(key, raw, errors);
  };

  const retryMaxAttempts = int('CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS');
  const retryBaseDelayMs = int('CAMUNDA_SDK_HTTP_RETRY_BASE_DELAY_MS');
  const retryMaxDelayMs = int('CAMUNDA_SDK_HTTP_RETRY_MAX_DELAY_MS');
  if (retryMaxAttempts === 0) {
    errors.push(
      'CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS must be at least 1 (it counts the first attempt)'
    );
  }

  const logLevelRaw = str('CAMUNDA_SDK_LOG_LEVEL');
  let logLevel: LogLevel = SCHEMA.CAMUNDA_SDK_LOG_LEVEL.default;
  if (logLevelRaw !== undefined) {
    const v = logLevelRaw.trim().toLowerCase();
    if ((SCHEMA.CAMUNDA_SDK_LOG_LEVEL.choices as readonly string[]).includes(v)) {
      logLevel = v as LogLevel;
    } else {
      errors.push(
        `CAMUNDA_SDK_LOG_LEVEL must be one of ${SCHEMA.CAMUNDA_SDK_LOG_LEVEL.choices.join(', ')}`
      );
    }
  }

  const validationRaw = str('CAMUNDA_SDK_VALIDATION') ?? SCHEMA.CAMUNDA_SDK_VALIDATION.default;
  const validation = parseValidation(validationRaw, errors);

  const resolved: ResolvedConfig = {
    clientId: str('CAMUNDA_CONSOLE_CLIENT_ID') ?? '',
    clientSecret: str('CAMUNDA_CONSOLE_CLIENT_SECRET') ?? '',
    baseUrl: str('CAMUNDA_CONSOLE_BASE_URL') ?? SCHEMA.CAMUNDA_CONSOLE_BASE_URL.default,
    oauthUrl: str('CAMUNDA_CONSOLE_OAUTH_URL') ?? SCHEMA.CAMUNDA_CONSOLE_OAUTH_URL.default,
    audience:
      str('CAMUNDA_CONSOLE_OAUTH_AUDIENCE') ?? SCHEMA.CAMUNDA_CONSOLE_OAUTH_AUDIENCE.default,
    reqValidation: validation.req,
    resValidation: validation.res,
    retry: {
      maxAttempts: retryMaxAttempts ?? SCHEMA.CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS.default,
      baseDelayMs: retryBaseDelayMs ?? SCHEMA.CAMUNDA_SDK_HTTP_RETRY_BASE_DELAY_MS.default,
      maxDelayMs: retryMaxDelayMs ?? SCHEMA.CAMUNDA_SDK_HTTP_RETRY_MAX_DELAY_MS.default,
    },
    logLevel,
    userAgent: str('CAMUNDA_CUSTOM_USER_AGENT_STRING'),
    ...resolveCustomRootCert(config, env, errors, warn),
  };

  if (!resolved.clientId) {
    errors.push('Missing required configuration: CAMUNDA_CONSOLE_CLIENT_ID');
  }
  if (!resolved.clientSecret) {
    errors.push('Missing required configuration: CAMUNDA_CONSOLE_CLIENT_SECRET');
  }
  if (errors.length) throw new CamundaConfigurationError(errors);

  resolved.baseUrl = stripTrailingSlashes(resolved.baseUrl);
  return resolved;
}

/** Remove trailing '/' characters. A loop, not /\/+$/, which backtracks quadratically. */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return url.slice(0, end);
}
