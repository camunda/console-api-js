import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConsoleClient, isSdkError, OPERATION_METHODS } from '../src';
import { fakeFetch, fakeLogger, testConfig } from './helpers';

// Validation failures must be reported as ValidationSdkError for every operation: never as an
// HTTP error (a 200 response is not a failed request), and never with payload values in the
// message, the issues, or the logs (responses can hold connector secret values).

type Spec = {
  paths: Record<string, Record<string, { operationId: string; requestBody?: unknown }>>;
};
const spec: Spec = JSON.parse(
  readFileSync(new URL('../spec/console-api.json', import.meta.url), 'utf8')
);
const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.values(methods).map((op) => ({
    operationId: op.operationId,
    hasBody: op.requestBody !== undefined,
    pathParams: [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
  }))
);

const SENTINEL = 'leak-me-7f3a';

function call(
  client: ConsoleClient,
  op: (typeof operations)[number],
  body: Record<string, unknown> = { marker: true }
) {
  const name = OPERATION_METHODS[op.operationId as keyof typeof OPERATION_METHODS];
  const args: Record<string, unknown> = {};
  for (const p of op.pathParams) args[p] = `${p}-value`;
  if (op.hasBody) Object.assign(args, body);
  return (client[name] as (...a: unknown[]) => Promise<unknown>).call(
    client,
    ...(op.hasBody || op.pathParams.length > 0 ? [args] : [])
  );
}

function makeClient(response: () => Response, config: Record<string, unknown> = {}) {
  const fake = fakeFetch(response);
  const { logger, events } = fakeLogger();
  const client = new ConsoleClient({
    config: {
      ...testConfig,
      CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 1,
      CAMUNDA_SDK_LOG_LEVEL: 'silly', // even the noisiest level must never leak values
      CAMUNDA_SDK_VALIDATION: 'req:none,res:none',
      ...config,
    },
    fetch: fake.fetch,
    logger: logger as never,
    env: {},
  });
  return {
    client,
    events,
    apiCalls: () => fake.calls.filter((c) => c.url.startsWith('https://console.test')),
  };
}

function expectNoLeak(err: { message: string; issues?: unknown }, events: unknown[]) {
  expect(err.message).not.toContain(SENTINEL);
  expect(JSON.stringify(err.issues)).not.toContain(SENTINEL);
  expect(JSON.stringify(events)).not.toContain(SENTINEL);
}

describe('response validation failures', () => {
  // A body no response schema accepts: an object for array/scalar/void responses, and an object
  // with every required field missing for object responses.
  const offSpec = () => Response.json({ [SENTINEL]: SENTINEL });

  it.each(operations)('$operationId reports a response validation error', async (op) => {
    const { client, events } = makeClient(offSpec, {
      CAMUNDA_SDK_VALIDATION: 'req:none,res:strict',
    });
    const err = await call(client, op).then(
      () => undefined,
      (e) => e
    );
    if (err === undefined) return; // this operation's schema accepts any object
    expect(isSdkError(err)).toBe(true);
    expect(err.name).toBe('ValidationSdkError');
    expect(err).toMatchObject({ side: 'response', operationId: op.operationId });
    expectNoLeak(err, events);
  });

  it('rejects off-spec responses for most operations (guards against a vacuous test)', async () => {
    const { client } = makeClient(offSpec, { CAMUNDA_SDK_VALIDATION: 'req:none,res:strict' });
    const results = await Promise.allSettled(operations.map((op) => call(client, op)));
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(rejected).toBeGreaterThan(operations.length / 2);
  });
});

describe('request validation failures', () => {
  const withBody = operations.filter((op) => op.hasBody);

  it.each(withBody)(
    '$operationId reports a request validation error and sends nothing',
    async (op) => {
      const { client, apiCalls, events } = makeClient(() => Response.json({}), {
        CAMUNDA_SDK_VALIDATION: 'req:strict,res:none',
      });
      const err: unknown = await call(client, op, { [SENTINEL]: SENTINEL }).catch((e) => e);
      // A non-SDK error means the request was sent and failed at the HTTP layer: this
      // operation's body schema accepted the extra field, so there is nothing to check.
      if (!isSdkError(err)) return;
      expect(err.name).toBe('ValidationSdkError');
      expect(err).toMatchObject({ side: 'request', operationId: op.operationId });
      expectNoLeak(err, events);
      expect(apiCalls()).toHaveLength(0);
    }
  );

  it('rejects off-spec requests for most operations (guards against a vacuous test)', async () => {
    const { client } = makeClient(() => Response.json({}), {
      CAMUNDA_SDK_VALIDATION: 'req:strict,res:none',
    });
    const results = await Promise.allSettled(
      withBody.map((op) => call(client, op, { [SENTINEL]: SENTINEL }))
    );
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(rejected).toBeGreaterThan(withBody.length / 2);
  });
});

describe('HTTP errors', () => {
  it.each(operations)(
    '$operationId throws HttpSdkError, never with the body in the message',
    async (op) => {
      const { client, events } = makeClient(() =>
        Response.json({ message: SENTINEL }, { status: 400 })
      );
      const err: unknown = await call(client, op).then(
        () => undefined,
        (e) => e
      );
      expect(isSdkError(err)).toBe(true);
      if (!isSdkError(err)) throw new Error('unreachable');
      expect(err.name).toBe('HttpSdkError');
      expect(err).toMatchObject({ status: 400, operationId: op.operationId });
      // The parsed body stays available on the documented field, but the message and the logs
      // never carry it.
      expect((err as { body?: unknown }).body).toEqual({ message: SENTINEL });
      expect(err.message).not.toContain(SENTINEL);
      expect(JSON.stringify(events)).not.toContain(SENTINEL);
    }
  );
});
