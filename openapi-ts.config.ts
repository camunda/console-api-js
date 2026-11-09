import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  // Committed snapshot of https://console.cloud.camunda.io/customer-api/openapi/swagger.json.
  // Refresh with `npm run spec:fetch`; CI runs `npm run spec:check` to detect upstream drift.
  input: './spec/console-api.json',
  output: 'src/gen',
  plugins: [
    { name: '@hey-api/client-fetch', throwOnError: true },
    { name: 'zod', metadata: true },
    { name: '@hey-api/sdk', validator: 'zod' },
  ],
});
