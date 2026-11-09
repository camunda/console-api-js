/** Thrown by every ConsoleClient method when the Console API returns a non-2xx response. */
export class ConsoleApiError extends Error {
  constructor(
    message: string,
    /** HTTP status code, or undefined if no response was received. */
    readonly status: number | undefined,
    /** HTTP method of the failed request. */
    readonly method: string | undefined,
    /** URL of the failed request. */
    readonly url: string | undefined,
    /** Parsed response body (JSON when possible, otherwise text). */
    readonly body: unknown
  ) {
    super(message);
    this.name = 'ConsoleApiError';
  }

  static from(request?: Request, response?: Response, body?: unknown): ConsoleApiError {
    const status = response?.status;
    const method = request?.method;
    const url = request?.url;
    const detail =
      body && typeof body === 'object' && 'message' in body
        ? `: ${String((body as { message: unknown }).message)}`
        : typeof body === 'string' && body
          ? `: ${body}`
          : '';
    return new ConsoleApiError(
      `${method ?? 'Request'} ${url ?? ''} failed with HTTP ${status ?? 'unknown'}${detail}`,
      status,
      method,
      url,
      body
    );
  }
}

/** One schema violation: where it is and what was expected. Never contains the offending value. */
export interface ValidationIssue {
  code: string;
  path: (string | number)[];
  message: string;
}

/**
 * Thrown when a request payload (before sending) or a response payload (after a 2xx response)
 * does not match the Console API spec. The request itself did not fail at the HTTP level.
 *
 * Issues carry only code, path and message, never values, because responses can contain
 * connector secret values.
 */
export class ConsoleApiValidationError extends Error {
  constructor(
    /** Whether the request payload or the response payload failed validation. */
    readonly phase: 'request' | 'response',
    /** The Console API operationId. */
    readonly operation: string,
    readonly issues: ValidationIssue[],
    /** HTTP status of the response (response phase only). */
    readonly status?: number
  ) {
    const summary = issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : '';
    super(
      `${operation}: ${phase} does not match the Console API spec: ${summary}${more}` +
        (phase === 'response' ? ' (set validateResponses: false to accept it)' : '')
    );
    this.name = 'ConsoleApiValidationError';
  }
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
