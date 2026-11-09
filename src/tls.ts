import { getCACertificates, rootCertificates } from 'node:tls';
import { Agent } from 'undici';

/**
 * Trust store for a custom root: the custom PEM plus Node's bundled roots plus the OS store, so
 * the custom root is added to the default trust rather than replacing it (as in `@camunda8/sdk`).
 */
export function buildCaList(customRootCert: string): string[] {
  const ca = new Set<string>([customRootCert, ...rootCertificates]);
  if (typeof getCACertificates === 'function') {
    try {
      for (const c of getCACertificates('system')) ca.add(c);
    } catch {
      // System store unavailable on this platform; bundled roots still apply.
    }
  }
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
