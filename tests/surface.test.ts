import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConsoleClient, OPERATION_METHODS } from '../src';
import { fakeFetch, testConfig } from './helpers';

type Schema = {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  $ref?: string;
};
type Spec = {
  paths: Record<
    string,
    Record<
      string,
      {
        operationId: string;
        requestBody?: { content: { 'application/json'?: { schema: Schema } } };
        deprecated?: boolean;
      }
    >
  >;
  components: { schemas: Record<string, Schema> };
};
const spec: Spec = JSON.parse(
  readFileSync(new URL('../spec/console-api.json', import.meta.url), 'utf8')
);

const deref = (schema: Schema): Schema =>
  schema.$ref ? spec.components.schemas[schema.$ref.split('/').pop() as string] : schema;

const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, op]) => ({
    path,
    method: method.toUpperCase(),
    operationId: op.operationId,
    hasBody: op.requestBody !== undefined,
    pathParams: [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
    bodySchema: op.requestBody?.content?.['application/json']?.schema
      ? deref(op.requestBody.content['application/json'].schema as Schema)
      : undefined,
  }))
);

describe('API surface', () => {
  it('maps every operation in the spec to a ConsoleClient method', () => {
    const unmapped = operations
      .map((o) => o.operationId)
      .filter((id) => !(id in OPERATION_METHODS));
    expect(unmapped).toEqual([]);
  });

  it('has no mappings for operations that are no longer in the spec', () => {
    const specIds = new Set(operations.map((o) => o.operationId));
    expect(Object.keys(OPERATION_METHODS).filter((id) => !specIds.has(id))).toEqual([]);
  });

  it('maps each operation to a distinct method', () => {
    const methods = Object.values(OPERATION_METHODS);
    expect(new Set(methods).size).toBe(methods.length);
  });

  // The facade merges path parameters and body fields into one argument object, so a spec that
  // gives both the same name would silently drop one side. Fail loudly instead: a future spec
  // version with such a clash must be handled deliberately (a generation-time error), never
  // papered over.
  it.each(operations)(
    '$operationId has no field that is both a path parameter and a body field',
    (op) => {
      const bodyProps = Object.keys(op.bodySchema?.properties ?? {});
      expect(op.pathParams.filter((p) => bodyProps.includes(p))).toEqual([]);
    }
  );

  // Convention for every method: one object argument with path parameters and body fields
  // merged (OCA style), then an optional per-call options argument.
  it.each(operations)('$operationId sends $method $path with a bearer token', async (op) => {
    const { fetch, calls } = fakeFetch(() => new Response('{}', { status: 200 }));
    const client = new ConsoleClient({
      config: {
        ...testConfig,
        CAMUNDA_SDK_VALIDATION: 'req:none,res:none',
        CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS: 1,
      },
      fetch,
      env: {},
    });
    const args: Record<string, unknown> = {};
    for (const p of op.pathParams) args[p] = `${p}-value`;
    if (op.hasBody) args.marker = op.operationId;

    const methodName = OPERATION_METHODS[op.operationId as keyof typeof OPERATION_METHODS];
    const method = client[methodName] as (...a: unknown[]) => Promise<unknown>;
    await (op.hasBody || op.pathParams.length > 0
      ? method.call(client, args)
      : method.call(client));

    const apiCalls = calls.filter((c) => c.url.startsWith('https://console.test'));
    expect(apiCalls).toHaveLength(1);
    const [call] = apiCalls;
    const expectedPath = op.path.replace(/\{(\w+)\}/g, (_, p) => `${p}-value`);
    expect(call.method).toBe(op.method);
    expect(new URL(call.url).pathname).toBe(expectedPath);
    expect(call.headers.get('authorization')).toBe('Bearer token-1');
    if (op.hasBody) {
      expect(JSON.parse(call.body)).toEqual({ marker: op.operationId });
    }
  });
});
