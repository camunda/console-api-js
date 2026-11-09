import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConsoleClient } from '../src/client';
import { ConsoleApiConfigError, resolveConfig } from '../src/config';
import { buildCaList } from '../src/tls';

// A throwaway CA and a localhost leaf certificate it signs, generated per run.
// Requires an `openssl` binary on PATH; the suite is skipped when it is missing.
let dir: string;
let caPem: string;
let leafPem: string;
let caPath: string;
let server: Server;
let baseUrl: string;

function openssl(...args: string[]) {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  if (!hasOpenssl) return;
  dir = mkdtempSync(join(tmpdir(), 'console-api-tls-'));
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '1',
    '-subj',
    '/CN=console-api test CA'
  );
  openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'leaf.key',
    '-out',
    'leaf.csr',
    '-subj',
    '/CN=localhost'
  );
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  openssl(
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'leaf.pem',
    '-days',
    '1',
    '-extfile',
    'ext.cnf'
  );
  caPath = join(dir, 'ca.pem');
  caPem = readFileSync(caPath, 'utf8');
  leafPem = readFileSync(join(dir, 'leaf.pem'), 'utf8');

  server = createServer({ key: readFileSync(join(dir, 'leaf.key')), cert: leafPem }, (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/oauth/token') {
      res.end(JSON.stringify({ access_token: 'tls-token', expires_in: 3600 }));
    } else if (req.headers.authorization === 'Bearer tls-token') {
      res.end(JSON.stringify([]));
    } else {
      res.statusCode = 401;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `https://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) {
    await new Promise<void>((r) => server.close(() => r()));
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const creds = { CAMUNDA_CONSOLE_CLIENT_ID: 'a', CAMUNDA_CONSOLE_CLIENT_SECRET: 'b' };

describe.skipIf(!hasOpenssl)('custom root certificate config', () => {
  it('an explicit customRootCert wins over an inherited (even unreadable) env path', () => {
    const c = resolveConfig(
      { customRootCert: caPem },
      { ...creds, CAMUNDA_CUSTOM_ROOT_CERT_PATH: join(dir, 'missing.pem') }
    );
    expect(c.customRootCert).toBe(caPem);
    expect(c.customRootCertPath).toBeUndefined();
  });

  it('an explicit customRootCertPath wins over the env path', () => {
    const c = resolveConfig(
      { customRootCertPath: caPath },
      { ...creds, CAMUNDA_CUSTOM_ROOT_CERT_PATH: join(dir, 'missing.pem') }
    );
    expect(c.customRootCert).toBe(caPem);
  });

  it('reads the PEM from CAMUNDA_CUSTOM_ROOT_CERT_STRING', () => {
    const c = resolveConfig({}, { ...creds, CAMUNDA_CUSTOM_ROOT_CERT_STRING: caPem });
    expect(c.customRootCert).toBe(caPem);
    expect(c.customRootCertPath).toBeUndefined();
  });

  it('reads the PEM from CAMUNDA_CUSTOM_ROOT_CERT_PATH, resolving relative paths against cwd', () => {
    const rel = relative(process.cwd(), caPath);
    const c = resolveConfig({}, { ...creds, CAMUNDA_CUSTOM_ROOT_CERT_PATH: rel });
    expect(c.customRootCert).toBe(caPem);
    expect(c.customRootCertPath).toBe(caPath);
  });

  it('prefers the path over the string', () => {
    const c = resolveConfig(
      {},
      { ...creds, CAMUNDA_CUSTOM_ROOT_CERT_PATH: caPath, CAMUNDA_CUSTOM_ROOT_CERT_STRING: leafPem },
      () => {}
    );
    expect(c.customRootCert).toBe(caPem);
  });

  it('explicit options win over the environment', () => {
    const c = resolveConfig(
      { customRootCert: caPem },
      { ...creds, CAMUNDA_CUSTOM_ROOT_CERT_STRING: leafPem }
    );
    expect(c.customRootCert).toBe(caPem);
  });

  it('throws ConsoleApiConfigError for an unreadable path', () => {
    expect(() =>
      resolveConfig({}, { ...creds, CAMUNDA_CUSTOM_ROOT_CERT_PATH: join(dir, 'missing.pem') })
    ).toThrow(ConsoleApiConfigError);
    expect(() =>
      resolveConfig({}, { ...creds, CAMUNDA_CUSTOM_ROOT_CERT_PATH: join(dir, 'missing.pem') })
    ).toThrow(/missing\.pem/);
  });

  it('throws ConsoleApiConfigError for content that is not a certificate', () => {
    expect(() =>
      resolveConfig({}, { ...creds, CAMUNDA_CUSTOM_ROOT_CERT_STRING: 'not a cert' })
    ).toThrow(ConsoleApiConfigError);
  });

  it('warns when the certificate is not self-issued, and not for a root', () => {
    const warn = vi.fn();
    resolveConfig({}, { ...creds, CAMUNDA_CUSTOM_ROOT_CERT_STRING: leafPem }, warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/not self-issued/);
    warn.mockClear();
    resolveConfig({}, { ...creds, CAMUNDA_CUSTOM_ROOT_CERT_STRING: caPem }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves the config unchanged when no cert is configured', () => {
    const c = resolveConfig({}, creds);
    expect('customRootCert' in c).toBe(false);
    expect('customRootCertPath' in c).toBe(false);
  });
});

describe.skipIf(!hasOpenssl)('custom root certificate transport (local HTTPS server)', () => {
  const client = (extra: Record<string, string>) =>
    new ConsoleClient({
      env: {
        ...creds,
        CAMUNDA_CONSOLE_BASE_URL: baseUrl,
        CAMUNDA_CONSOLE_OAUTH_URL: `${baseUrl}/oauth/token`,
        ...extra,
      },
      maxRetries: 0,
    });

  it('token and API requests succeed with the custom root configured', async () => {
    const c = client({ CAMUNDA_CUSTOM_ROOT_CERT_PATH: caPath });
    await expect(c.getClusters()).resolves.toEqual([]);
  });

  it('works with the inline string too', async () => {
    const c = client({ CAMUNDA_CUSTOM_ROOT_CERT_STRING: caPem });
    await expect(c.getClusters()).resolves.toEqual([]);
  });

  it('fails without the custom root', async () => {
    const c = client({});
    await expect(c.getClusters()).rejects.toThrow();
  });
});

describe('withCustomRootCert dispatcher handling', () => {
  it('lets a caller-supplied per-request dispatcher win over the custom-root one', async () => {
    const { Agent } = await import('undici');
    const { withCustomRootCert } = await import('../src/tls');
    const callerDispatcher = new Agent();
    let seen: unknown;
    const fakeFetch = (async (_input: unknown, init?: { dispatcher?: unknown }) => {
      seen = init?.dispatcher;
      return new Response('[]');
    }) as typeof fetch;
    const wrapped = withCustomRootCert(fakeFetch, 'placeholder');
    await wrapped('https://example.test', { dispatcher: callerDispatcher } as never);
    expect(seen).toBe(callerDispatcher);
    await callerDispatcher.close();
  });

  it('applies the custom-root dispatcher when the caller supplies none', async () => {
    const { withCustomRootCert } = await import('../src/tls');
    let seen: unknown;
    const fakeFetch = (async (_input: unknown, init?: { dispatcher?: unknown }) => {
      seen = init?.dispatcher;
      return new Response('[]');
    }) as typeof fetch;
    const wrapped = withCustomRootCert(fakeFetch, 'placeholder');
    await wrapped('https://example.test');
    expect(seen).toBeDefined();
  });
});

describe('custom root certificate edge cases (no openssl needed)', () => {
  it('rejects an empty certificate file instead of silently ignoring it', () => {
    const d = mkdtempSync(join(tmpdir(), 'console-api-empty-ca-'));
    try {
      for (const body of ['', '  \n']) {
        const p = join(d, 'empty.pem');
        writeFileSync(p, body);
        expect(() => resolveConfig({}, { ...creds, CAMUNDA_CUSTOM_ROOT_CERT_PATH: p })).toThrow(
          ConsoleApiConfigError
        );
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('keeps NODE_EXTRA_CA_CERTS / default CAs in the trust list', async () => {
    const tls = await import('node:tls');
    const list = buildCaList('CUSTOM');
    expect(list[0]).toBe('CUSTOM');
    const getCA = (tls as { getCACertificates?: (s: string) => string[] }).getCACertificates;
    const defaults = typeof getCA === 'function' ? getCA('default') : tls.rootCertificates;
    for (const c of defaults) expect(list).toContain(c);
  });
});
