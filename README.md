# @camunda8/console-api

TypeScript client for the [Camunda 8 SaaS Console (Administration) API](https://docs.camunda.io/docs/apis-tools/administration-api/administration-api-reference/): manage clusters, API clients, connector secrets, IP allowlists, backups, monitoring, members and the audit log.

This package replaces `Camunda8.getAdminApiClient()` from `@camunda8/sdk`. For the Orchestration Cluster API (processes, jobs, user tasks), use [`@camunda8/orchestration-cluster-api`](https://www.npmjs.com/package/@camunda8/orchestration-cluster-api).

## Versioning

The Console API is the SaaS control plane. It is versioned independently of Camunda cluster releases, so this package is too. Any version works with clusters of every Camunda version; there is no need to match it to your cluster's 8.x minor.

## Install

<!-- snippet-exempt: shell command -->
```sh
npm install @camunda8/console-api
```

Node.js 22 or later.

## Usage

Create API client credentials in Console (Organization → Administration API), then:

<!-- snippet-source: examples/readme.ts | regions: Import+Usage -->
```ts
import { ConsoleApiError, createConsoleClient } from '@camunda8/console-api';

// Reads CAMUNDA_CONSOLE_CLIENT_ID and CAMUNDA_CONSOLE_CLIENT_SECRET from the environment.
const consoleApi = createConsoleClient();

const clusters = await consoleApi.getClusters();

try {
  await consoleApi.updateIpAllowlist(clusters[0].uuid, {
    ipallowlist: [{ description: 'office', ip: '203.0.113.0/24' }],
  });
} catch (e) {
  if (e instanceof ConsoleApiError) {
    console.error(e.status, e.body);
  }
}
```

Or pass configuration explicitly:

<!-- snippet-source: examples/readme.ts | regions: ExplicitConfig -->
```ts
const consoleApi = createConsoleClient({
  clientId: '...',
  clientSecret: '...',
});
```

## Configuration

| Option              | Environment variable                                  | Default                                      |
| ------------------- | ----------------------------------------------------- | -------------------------------------------- |
| `clientId`          | `CAMUNDA_CONSOLE_CLIENT_ID`                           | required                                     |
| `clientSecret`      | `CAMUNDA_CONSOLE_CLIENT_SECRET`                       | required                                     |
| `baseUrl`           | `CAMUNDA_CONSOLE_BASE_URL`                            | `https://api.cloud.camunda.io`               |
| `oauthUrl`          | `CAMUNDA_CONSOLE_OAUTH_URL`, then `CAMUNDA_OAUTH_URL` | `https://login.cloud.camunda.io/oauth/token` |
| `audience`          | `CAMUNDA_CONSOLE_OAUTH_AUDIENCE`                      | `api.cloud.camunda.io`                       |
| `validateRequests`  | `CAMUNDA_CONSOLE_VALIDATE_REQUESTS`                   | `true`                                       |
| `validateResponses` | `CAMUNDA_CONSOLE_VALIDATE_RESPONSES`                  | `false`                                      |
| `maxRetries`        | `CAMUNDA_CONSOLE_MAX_RETRIES`                         | `3`                                          |
| `fetch`             |                                                       | `globalThis.fetch`                           |

Explicit options override environment variables. The variable names are the same as in `@camunda8/sdk`.

## Behaviour

- **Authentication.** OAuth client credentials. The token is cached in memory and refreshed a minute before it expires. On a 401 the client fetches a new token and retries once.
- **Retries.** `429` is retried for every method, honouring `Retry-After`. `502`/`503`/`504` and network errors are retried only for idempotent methods (GET, PUT, DELETE), so a request such as `createCluster` is never sent twice.
- **Errors.** Every method throws `ConsoleApiError` (with `status`, `method`, `url` and `body`) on a non-2xx response. Token failures throw `ConsoleApiAuthError`, bad configuration throws `ConsoleApiConfigError`.
- **Validation.** Request payloads are validated against the API spec before sending. Response validation is off by default so that a field the server adds or omits does not break your code; turn it on with `validateResponses: true`.

## Migrating from `@camunda8/sdk`

Before:

<!-- snippet-exempt: uses @camunda8/sdk, which is not a dependency of this package -->
```ts
import { Camunda8 } from '@camunda8/sdk';
const admin = new Camunda8().getAdminApiClient();
```

After:

<!-- snippet-source: examples/readme.ts | regions: Migration -->
```ts
const admin = createConsoleClient();
```

Methods take path parameters first, then the request body. Most names are unchanged. The differences:

| `@camunda8/sdk` `AdminApiClient`                         | `@camunda8/console-api` `ConsoleClient`                   |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `createClient({ clusterUuid, clientName, permissions })` | `createClient(clusterUuid, { clientName, permissions })`  |
| `createSecret({ clusterUuid, secretName, secretValue })` | `createSecret(clusterUuid, { secretName, secretValue })`  |
| `createMember(email, orgRoles)`                          | `createMember(email, { orgRoles })`                       |
| `getUsers()`                                             | `getMembers()`                                            |
| `whitelistIPs(clusterUuid, list)`                        | `updateIpAllowlist(clusterUuid, { ipallowlist: list })`   |
| `updateIpAllowlist(clusterUuid, list)`                   | `updateIpAllowlist(clusterUuid, { ipallowlist: list })`   |
| `updateSecret(clusterUuid, name, value)`                 | `updateSecret(clusterUuid, name, { secretValue: value })` |
| `createMonitoringClient(clusterUuid, username)`          | `createMonitoringClient(clusterUuid, { username })`       |

New in this package: `triggerFailover`, `updateClusterEncryption`, `getBackupSchedule`, `updateBackupSchedule`, `deleteBackupSchedule`, `restoreFromBackup`, `getRestoreStatus`.

## Low-level access

The client is generated from the published OpenAPI spec with [`@hey-api/openapi-ts`](https://heyapi.dev). All request and response types are exported, and the zod schemas are available as `schemas`. `consoleClient.client` is the underlying generated client.
