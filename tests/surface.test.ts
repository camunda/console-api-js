import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConsoleClient, OPERATION_METHODS } from '../src';
import { fakeFetch } from './helpers';

type Spec = {
  paths: Record<
    string,
    Record<string, { operationId: string; requestBody?: unknown; deprecated?: boolean }>
  >;
};
const spec: Spec = JSON.parse(
  readFileSync(new URL('../spec/console-api.json', import.meta.url), 'utf8')
);

const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, op]) => ({
    path,
    method: method.toUpperCase(),
    operationId: op.operationId,
    hasBody: op.requestBody !== undefined,
    pathParams: [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
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

  // Convention for every method: path parameters in URL order, then the body if the operation has one.
  it.each(operations)('$operationId sends $method $path with a bearer token', async (op) => {
    const { fetch, calls } = fakeFetch(() => new Response('{}', { status: 200 }));
    const client = new ConsoleClient({
      clientId: 'id',
      clientSecret: 'secret',
      baseUrl: 'https://console.test',
      validateRequests: false,
      fetch,
      env: {},
    });
    const args: unknown[] = op.pathParams.map((p) => `${p}-value`);
    if (op.hasBody) args.push({ marker: op.operationId });

    const methodName = OPERATION_METHODS[op.operationId as keyof typeof OPERATION_METHODS];
    await (client[methodName] as (...a: unknown[]) => Promise<unknown>)(...args);

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
