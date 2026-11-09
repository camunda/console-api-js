/**
 * Package version, injected at build time by tsup (`define`, see tsup.config.ts) from the
 * version semantic-release writes into package.json. Not read from package.json at runtime.
 */
declare const __PACKAGE_VERSION__: string | undefined;

export const VERSION: string =
  typeof __PACKAGE_VERSION__ === 'string' ? __PACKAGE_VERSION__ : '0.0.0-development';

/** Product token, shared by the `console-api-<lang>` family: `camunda8-console-api-<lang>/<version>`. */
export const USER_AGENT_PRODUCT = `camunda8-console-api-js/${VERSION}`;

/** Build the User-Agent value: the product token, then the custom suffix (if any) after a space. */
export function buildUserAgent(custom?: string): string {
  const suffix = custom?.trim();
  return suffix ? `${USER_AGENT_PRODUCT} ${suffix}` : USER_AGENT_PRODUCT;
}
