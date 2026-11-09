import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Read at build time only; the bundle carries the version as a literal.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  define: { __PACKAGE_VERSION__: JSON.stringify(version) },
});
