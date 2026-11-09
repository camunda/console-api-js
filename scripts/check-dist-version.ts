/**
 * Release-build check: the User-Agent product token baked into dist/ must carry the version in
 * package.json (which semantic-release has set by the time `npm publish` runs `prepack`).
 */
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const expected = `camunda8-console-api-js/${version}`;
let failed = false;
for (const file of ['dist/index.js', 'dist/index.cjs']) {
  const mod = await import(new URL(`../${file}`, import.meta.url).href);
  const ua: string = mod.USER_AGENT_PRODUCT ?? mod.default?.USER_AGENT_PRODUCT;
  if (ua !== expected) {
    console.error(`${file}: User-Agent product token is "${ua}", expected "${expected}"`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`dist User-Agent: ${expected}`);
