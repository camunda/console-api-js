/**
 * Fetch the published Console API OpenAPI spec and write a normalised (key-sorted) snapshot to
 * spec/console-api.json.
 *
 *   tsx scripts/fetch-spec.ts           # refresh the snapshot
 *   tsx scripts/fetch-spec.ts --check   # exit 1 if the published spec differs from the snapshot
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SPEC_URL =
  process.env.CONSOLE_API_SPEC_URL ??
  'https://console.cloud.camunda.io/customer-api/openapi/swagger.json';
const SNAPSHOT = fileURLToPath(new URL('../spec/console-api.json', import.meta.url));

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

const res = await fetch(SPEC_URL);
if (!res.ok) {
  console.error(`Failed to fetch ${SPEC_URL}: HTTP ${res.status}`);
  process.exit(2);
}
const spec = (await res.json()) as { info?: { version?: string } };
const normalised = `${JSON.stringify(sortKeys(spec), null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = readFileSync(SNAPSHOT, 'utf8');
  if (current !== normalised) {
    console.error(
      `Published Console API spec (version ${spec.info?.version}) differs from spec/console-api.json. Run \`npm run spec:fetch && npm run generate\`.`
    );
    process.exit(1);
  }
  console.log(`Spec snapshot is up to date (version ${spec.info?.version}).`);
} else {
  writeFileSync(SNAPSHOT, normalised);
  console.log(`Wrote spec/console-api.json (version ${spec.info?.version}).`);
}
