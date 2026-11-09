import { readFileSync } from 'node:fs';
import * as tls from 'node:tls';
import { Agent } from 'undici';

type CaStore = 'default' | 'system' | 'bundled' | 'extra';
// Read from the namespace, not as a named import: `getCACertificates` only exists from Node 22.15,
// and a missing named ESM export would fail module load on earlier supported Node 22 releases.
const getCACertificates = (tls as { getCACertificates?: (store?: CaStore) => string[] })
  .getCACertificates;

function tryStore(store: CaStore): string[] | undefined {
  if (typeof getCACertificates !== 'function') return undefined;
  try {
    return getCACertificates(store);
  } catch {
    return undefined;
  }
}

/** Certificates from `NODE_EXTRA_CA_CERTS`, for Node versions without `getCACertificates`. */
function extraCaFromEnv(): string[] {
  const file = process.env.NODE_EXTRA_CA_CERTS;
  if (!file) return [];
  try {
    return (
      readFileSync(file, 'utf8').match(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
      ) ?? []
    );
  } catch {
    return [];
  }
}

/**
 * Trust store for a custom root: the custom PEM plus Node's default CAs (bundled roots and
 * `NODE_EXTRA_CA_CERTS`) plus the OS store, so the custom root is added to the default trust
 * rather than replacing it (as in `@camunda8/sdk`).
 */
export function buildCaList(customRootCert: string): string[] {
  const ca = new Set<string>([customRootCert]);
  const defaults = tryStore('default') ?? [...tls.rootCertificates, ...extraCaFromEnv()];
  for (const c of defaults) ca.add(c);
  for (const c of tryStore('system') ?? []) ca.add(c);
  return [...ca];
}

/**
 * Wrap a fetch so every request uses an undici dispatcher that trusts `customRootCert`.
 * Built-in fetch ignores an `https.Agent` passed as `agent`; `dispatcher` is what it honours.
 * A dispatcher supplied by the caller for a specific request wins over the custom-root one.
 */
export function withCustomRootCert(fetchImpl: typeof fetch, customRootCert: string): typeof fetch {
  const dispatcher = new Agent({ connect: { ca: buildCaList(customRootCert) } });
  return (input, init) =>
    fetchImpl(input, {
      ...init,
      dispatcher:
        (init as (RequestInit & { dispatcher?: Agent }) | undefined)?.dispatcher ?? dispatcher,
    } as RequestInit & { dispatcher: Agent });
}
