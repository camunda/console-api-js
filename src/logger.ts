/**
 * Minimal leveled logger, aligned with `@camunda8/orchestration-cluster-api`'s log levels
 * (`CAMUNDA_SDK_LOG_LEVEL`). The SDK logs metadata only — operation ids, statuses, attempt
 * numbers, durations — and never request payloads, response bodies or token responses at any
 * level, including `silly`, because Console responses can contain connector secret values and
 * the token endpoint returns access tokens.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silly';

const ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
  silly: 6,
};

export interface Logger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  trace(message: string, meta?: Record<string, unknown>): void;
  silly(message: string, meta?: Record<string, unknown>): void;
}

const noop = () => {};

/** A logger that drops everything. */
export const silentLogger: Logger = {
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  silly: noop,
};

/**
 * Console transport for the SDK logger. `error`/`warn` go to `console.error`/`console.warn`,
 * everything below to `console.log`. Callers can bring their own logger instead (see the
 * `logger` option of `createConsoleClient`).
 */
export function createConsoleLogger(level: LogLevel): Logger {
  const enabled = (l: LogLevel) => ORDER[level] >= ORDER[l];
  const write =
    (l: Exclude<LogLevel, 'silent'>, sink: (msg: string, meta?: unknown) => void) =>
    (message: string, meta?: Record<string, unknown>) => {
      if (enabled(l)) sink(`[@camunda8/console-api] ${message}`, meta);
    };
  return {
    error: write('error', (m, meta) => console.error(m, ...(meta ? [meta] : []))),
    warn: write('warn', (m, meta) => console.warn(m, ...(meta ? [meta] : []))),
    info: write('info', (m, meta) => console.log(m, ...(meta ? [meta] : []))),
    debug: write('debug', (m, meta) => console.log(m, ...(meta ? [meta] : []))),
    trace: write('trace', (m, meta) => console.log(m, ...(meta ? [meta] : []))),
    silly: write('silly', (m, meta) => console.log(m, ...(meta ? [meta] : []))),
  };
}

/** Resolve the effective logger: an explicit one wins; otherwise a console logger at `level`. */
export function resolveLogger(level: LogLevel, logger?: Logger): Logger {
  if (logger) return logger;
  if (level === 'silent') return silentLogger;
  return createConsoleLogger(level);
}
