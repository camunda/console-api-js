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
