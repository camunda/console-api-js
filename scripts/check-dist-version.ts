/**
 * Release-build check: the User-Agent product token baked into dist/ must carry the version in
 * package.json (which semantic-release has set by the time `npm publish` runs `prepack`).
 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { version } = pkg;
// Resolve the published entry points from package.json rather than hard-coding tsup's file names.
const entry = pkg.exports?.['.'] ?? {};
const files = [...new Set([entry.import, entry.require, pkg.module, pkg.main].filter(Boolean))].map(
  (f: string) => f.replace(/^\.\//, '')
);
if (files.length === 0) {
  console.error('package.json declares no entry points to check');
  process.exit(1);
}
const expected = `camunda8-console-api-js/${version}`;
let failed = false;
for (const file of files) {
  const mod = await import(new URL(`../${file}`, import.meta.url).href);
  const ua: string = mod.USER_AGENT_PRODUCT ?? mod.default?.USER_AGENT_PRODUCT;
  if (ua !== expected) {
    console.error(`${file}: User-Agent product token is "${ua}", expected "${expected}"`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`dist User-Agent: ${expected}`);
