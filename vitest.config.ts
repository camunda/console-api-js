import { defineConfig } from 'vitest/config';

// Unit tests by default; `npm run test:integration` sets CONSOLE_API_INTEGRATION=1 to run the
// live read-only suite instead.
const integration = process.env.CONSOLE_API_INTEGRATION === '1';

export default defineConfig({
  test: {
    include: integration ? ['tests-integration/**/*.test.ts'] : ['tests/**/*.test.ts'],
  },
});
