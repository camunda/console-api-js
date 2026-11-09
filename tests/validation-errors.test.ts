import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ConsoleApiError,
  ConsoleApiValidationError,
  ConsoleClient,
  OPERATION_METHODS,
} from '../src';
import { fakeFetch } from './helpers';

// Validation failures must be reported as validation failures for every operation: never as an
// HTTP error (a 200 response is not a failed request), and never with response data in the
// message (responses can hold connector secret values).

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
  body: unknown = { marker: true }
) {
  const name = OPERATION_METHODS[op.operationId as keyof typeof OPERATION_METHODS];
  const args: unknown[] = op.pathParams.map((p) => `${p}-value`);
  if (op.hasBody) args.push(body);
  return (client[name] as (...a: unknown[]) => Promise<unknown>)(...args);
}

function makeClient(response: () => Response, extra = {}) {
  const fake = fakeFetch(response);
  const client = new ConsoleClient({
    clientId: 'id',
    clientSecret: 's',
    baseUrl: 'https://console.test',
    maxRetries: 0,
    fetch: fake.fetch,
    env: {},
    ...extra,
  });
  return {
    client,
    apiCalls: () => fake.calls.filter((c) => c.url.startsWith('https://console.test')),
  };
}

describe('response validation failures', () => {
  // A body no response schema accepts: an object for array/scalar/void responses, and an object
  // with every required field missing for object responses.
  const offSpec = () => Response.json({ [SENTINEL]: SENTINEL });

  it.each(operations)('$operationId reports a response validation error', async (op) => {
    const { client } = makeClient(offSpec, { validateResponses: true, validateRequests: false });
    const err = await call(client, op).then(
      () => undefined,
      (e) => e
    );
    if (err === undefined) return; // this operation's schema accepts any object
    expect(err).toBeInstanceOf(ConsoleApiValidationError);
    expect(err).not.toBeInstanceOf(ConsoleApiError);
    expect(err).toMatchObject({ phase: 'response', operation: op.operationId });
    expect(err.message).not.toContain(SENTINEL);
    expect(JSON.stringify(err.issues)).not.toContain(SENTINEL);
  });

  it('rejects off-spec responses for most operations (guards against a vacuous test)', async () => {
    const { client } = makeClient(offSpec, { validateResponses: true, validateRequests: false });
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
      const { client, apiCalls } = makeClient(() => Response.json({}));
      const err = (await call(client, op, SENTINEL).catch((e) => e)) as ConsoleApiValidationError;
      expect(err).toBeInstanceOf(ConsoleApiValidationError);
      expect(err).toMatchObject({ phase: 'request', operation: op.operationId });
      expect(err.message).not.toContain(SENTINEL);
      expect(apiCalls()).toHaveLength(0);
    }
  );
});
