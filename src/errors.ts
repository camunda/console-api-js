/**
 * Error model, aligned with `@camunda8/orchestration-cluster-api` (`src/runtime/errors.ts`
 * there): one discriminated union, one `isSdkError` guard, the same `name` values, so a single
 * `catch` block can handle errors from both packages.
 *
 * Safety contract (Console-specific): errors never carry request payload values, response
 * bodies (beyond the documented `HttpSdkError.body` field) or tokens, because Console
 * responses can contain connector secret values.
 */

/** RFC 9457 / RFC 7807 Problem Details fields are passed through when the server sends them. */
export interface HttpSdkError extends Error {
  /** HTTP status code. */
  status: number;
  /** The Console API operationId that failed. */
  operationId?: string;
  /** Retry bookkeeping: which attempt failed, out of how many were allowed. */
  retries?: { attempt: number; max: number };
  /** Parsed response body. Console returns non-RFC error bodies, so it is kept on this field — it is never interpolated into `message`. */
  body?: unknown;
  cause?: unknown;
  type?: string;
  title?: string;
  detail?: string;
  instance?: string;
  name: 'HttpSdkError';
}

export interface ValidationSdkError extends Error {
  /** Whether the request payload (before sending) or the response payload failed validation. */
  side: 'request' | 'response';
  /** The Console API operationId. */
  operationId: string;
  /** Schema violations: code, path and message only, never the offending value. */
  issues?: unknown;
  name: 'ValidationSdkError';
}

export interface AuthSdkError extends Error {
  status?: number;
  cause?: unknown;
  name: 'AuthSdkError';
}

export interface NetworkSdkError extends Error {
  cause?: unknown;
  name: 'NetworkSdkError';
}

export interface CancelSdkError extends Error {
  operationId?: string;
  name: 'CancelSdkError';
}

export type SdkError =
  | HttpSdkError
  | ValidationSdkError
  | AuthSdkError
  | NetworkSdkError
  | CancelSdkError;

const SDK_ERROR_NAMES = [
  'HttpSdkError',
  'ValidationSdkError',
  'AuthSdkError',
  'NetworkSdkError',
  'CancelSdkError',
];

/** Type guard for every error the SDK throws from its HTTP, auth, network and validation layers. */
export function isSdkError(e: unknown): e is SdkError {
  return (
    !!e &&
    typeof e === 'object' &&
    'name' in e &&
    SDK_ERROR_NAMES.includes((e as { name: unknown }).name as string)
  );
}

/** Build an HttpSdkError. The message carries method, URL, status and operationId — never the body. */
export function httpError(params: {
  status: number;
  method?: string;
  url?: string;
  operationId: string;
  body?: unknown;
  retries?: { attempt: number; max: number };
}): HttpSdkError {
  const { status, method, url, operationId, body, retries } = params;
  // RFC 9457 pass-through when the body is Problem Details; `body` itself is only read for
  // these five string fields, never stringified into the message.
  const pd =
    body && typeof body === 'object'
      ? (body as { type?: unknown; title?: unknown; detail?: unknown; instance?: unknown })
      : undefined;
  const title = typeof pd?.title === 'string' ? pd.title : undefined;
  const detail = typeof pd?.detail === 'string' ? pd.detail : undefined;
  const err = new Error(
    `${method ?? 'Request'} ${url ?? ''} failed with HTTP ${status} (${operationId})` +
      (title ? `: ${title}` : '')
  ) as HttpSdkError;
  err.name = 'HttpSdkError';
  err.status = status;
  err.operationId = operationId;
  if (retries) err.retries = retries;
  if (body !== undefined) err.body = body;
  if (typeof pd?.type === 'string') err.type = pd.type;
  if (title) err.title = title;
  if (detail) err.detail = detail;
  if (typeof pd?.instance === 'string') err.instance = pd.instance;
  return err;
}

/** One schema violation: where it is and what was expected. Never contains the offending value. */
export interface ValidationIssue {
  code: string;
  path: (string | number)[];
  message: string;
}

/**
 * Build a ValidationSdkError. `issues` carry only code, path and message, never values,
 * because responses can contain connector secret values.
 */
export function validationError(params: {
  side: 'request' | 'response';
  operationId: string;
  issues: ValidationIssue[];
  status?: number;
}): ValidationSdkError {
  const { side, operationId, issues, status } = params;
  const summary = issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : '';
  const err = new Error(
    `${operationId}: ${side} does not match the Console API spec: ${summary}${more}` +
      (side === 'response'
        ? " (set CAMUNDA_SDK_VALIDATION to 'req:strict,res:none' or laxer to accept it)"
        : '')
  ) as ValidationSdkError;
  err.name = 'ValidationSdkError';
  err.side = side;
  err.operationId = operationId;
  err.issues = issues;
  if (status !== undefined) (err as { status?: number }).status = status;
  return err;
}

/**
 * Build an AuthSdkError. `status` is allowed; the token endpoint's response body is not,
 * because it can echo back client input.
 */
export function authError(message: string, params: { status?: number; cause?: unknown } = {}) {
  const err = new Error(message) as AuthSdkError;
  err.name = 'AuthSdkError';
  if (params.status !== undefined) err.status = params.status;
  if (params.cause !== undefined) err.cause = params.cause;
  return err;
}

/** True for a zod validation error. */
export function isSchemaError(e: unknown): e is { issues: Array<Record<string, unknown>> } {
  return (
    typeof e === 'object' &&
    e !== null &&
    Array.isArray((e as { issues?: unknown }).issues) &&
    (e as { name?: unknown }).name === 'ZodError'
  );
}

/** Reduce zod issues to code, path and message, dropping any input values. */
export function toValidationIssues(e: {
  issues: Array<Record<string, unknown>>;
}): ValidationIssue[] {
  return e.issues.map((i) => ({
    code: String(i.code),
    path: Array.isArray(i.path)
      ? (i.path as unknown[]).map((p) => (typeof p === 'number' ? p : String(p)))
      : [],
    message: String(i.message),
  }));
}
