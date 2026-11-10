import { getCACertificates } from 'node:tls';
import { Agent } from 'undici';

type CaStore = 'default' | 'system' | 'bundled' | 'extra';

// `engines.node` is >=22.15.0, where `tls.getCACertificates` is always available, so this named
// import is safe and the OS-trusted roots are always enumerable alongside a custom root.
function tryStore(store: CaStore): string[] {
  try {
    return getCACertificates(store);
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
  for (const c of tryStore('default')) ca.add(c);
  for (const c of tryStore('system')) ca.add(c);
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
