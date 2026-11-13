# @camunda8/console-api

TypeScript client for the [Camunda 8 SaaS Console (Administration) API](https://docs.camunda.io/docs/apis-tools/administration-api/administration-api-reference/): manage clusters, API clients, connector secrets, IP allowlists, backups, monitoring, members and the audit log.

This package replaces `Camunda8.getAdminApiClient()` from `@camunda8/sdk`. For the Orchestration Cluster API (processes, jobs, user tasks), use [`@camunda8/orchestration-cluster-api`](https://www.npmjs.com/package/@camunda8/orchestration-cluster-api) (OCA). The ergonomics of the two packages are aligned: the same argument style, config keys, error model, and validation, retry and log settings.

## Versioning

The Console API is the SaaS control plane. It is versioned independently of Camunda cluster releases, so this package is too. Any version works with clusters of every Camunda version; there is no need to match it to your cluster's 8.x minor.

## Install

<!-- snippet-exempt: shell command -->
```sh
npm install @camunda8/console-api
```

Node.js 22.15.0 or later.

## Usage

Create API client credentials in Console (Organization → Administration API), then:

<!-- snippet-source: examples/readme.ts | regions: Import+Usage -->
```ts
import { createConsoleClient, isSdkError } from '@camunda8/console-api';

// Reads CAMUNDA_CONSOLE_CLIENT_ID and CAMUNDA_CONSOLE_CLIENT_SECRET from the environment.
const consoleApi = createConsoleClient();

const clusters = await consoleApi.getClusters();

try {
  await consoleApi.updateIpAllowlist({
    clusterUuid: clusters[0].uuid,
    ipallowlist: [{ description: 'office', ip: '203.0.113.0/24' }],
  });
} catch (e) {
  if (isSdkError(e) && e.name === 'HttpSdkError') {
    console.error(e.status, e.operationId);
  }
}
```

Methods take a single object — path parameters and body fields together, as in OCA (`getUserTask({ userTaskKey })`) — plus an optional trailing options argument. Methods without parameters take no arguments.

Or pass configuration explicitly. Keys mirror their `CAMUNDA_*` environment variable names, as in OCA; explicit config wins over the environment, which wins over defaults:

<!-- snippet-source: examples/readme.ts | regions: ExplicitConfig -->
```ts
const consoleApi = createConsoleClient({
  config: {
    CAMUNDA_CONSOLE_CLIENT_ID: '...',
    CAMUNDA_CONSOLE_CLIENT_SECRET: '...',
  },
});
```

## Configuration

All configuration lives under `config`, keyed by environment variable name. Non-configuration hooks (`fetch`, `logger`) sit next to `config`, as in OCA.

| Config key                             | Default                                      |
| -------------------------------------- | -------------------------------------------- |
| `CAMUNDA_CONSOLE_CLIENT_ID`            | required                                     |
| `CAMUNDA_CONSOLE_CLIENT_SECRET`        | required                                     |
| `CAMUNDA_CONSOLE_BASE_URL`             | `https://api.cloud.camunda.io`               |
| `CAMUNDA_CONSOLE_OAUTH_URL`            | `https://login.cloud.camunda.io/oauth/token` |
| `CAMUNDA_CONSOLE_OAUTH_AUDIENCE`       | `api.cloud.camunda.io`                       |
| `CAMUNDA_SDK_VALIDATION`               | `req:strict,res:none`                        |
| `CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS`  | `3`                                          |
| `CAMUNDA_SDK_HTTP_RETRY_BASE_DELAY_MS` | `100`                                        |
| `CAMUNDA_SDK_HTTP_RETRY_MAX_DELAY_MS`  | `10000`                                      |
| `CAMUNDA_SDK_LOG_LEVEL`                | `error`                                      |
| `CAMUNDA_CUSTOM_USER_AGENT_STRING`     | none                                         |
| `CAMUNDA_CUSTOM_ROOT_CERT_PATH`        | none                                         |
| `CAMUNDA_CUSTOM_ROOT_CERT_STRING`      | none                                         |

`CAMUNDA_CONSOLE_OAUTH_URL` falls back to `CAMUNDA_OAUTH_URL` when unset, for compatibility with `@camunda8/sdk`.

`CAMUNDA_CUSTOM_ROOT_CERT_PATH` / `CAMUNDA_CUSTOM_ROOT_CERT_STRING` add a PEM root certificate (for a private or self-signed CA) to the system trust store for both Console API and OAuth token requests. A relative path resolves against `process.cwd()`; the path wins if both are set. A warning is logged if the certificate is not self-issued. This uses an undici `dispatcher`, because built-in `fetch` ignores an `https.Agent`.

Every request, including the OAuth token request, carries `User-Agent: camunda8-console-api-js/<version>`. `CAMUNDA_CUSTOM_USER_AGENT_STRING` is appended after a space, for example `camunda8-console-api-js/1.2.0 my-app/1.0`. Browsers treat `User-Agent` as a forbidden request header and silently drop it (no error), so it is only guaranteed in Node.js and other server runtimes.

## Validation

Requests and responses can be validated against the API spec (zod schemas generated from the published OpenAPI document). Controlled by `CAMUNDA_SDK_VALIDATION` — the same mini-language as OCA:

```
none | warn | strict | fanatical | req:<mode>[,res:<mode>] | res:<mode>[,req:<mode>]
<mode> = none | warn | strict | fanatical
```

- `none` — no validation performed
- `warn` — log a warning on invalid shape, then continue
- `strict` — fail on type mismatch or missing required fields
- `fanatical` — fail on type mismatch, missing required fields, or unknown additional fields

**The default is `req:strict,res:none`, which differs from OCA's default (`req:none,res:none`).** Request payloads are validated before sending because a malformed Console request can create or mutate SaaS resources; response validation is off by default so that a field the server adds or omits does not break your code. Turn it on with `CAMUNDA_SDK_VALIDATION=req:strict,res:strict`.

Validation failures throw a `ValidationSdkError` whose `issues` give the field path and what was expected — never the value itself, because Console responses can contain connector secret values.

## Per-method retry override

Every method accepts an optional trailing `options` argument that overrides or disables the global retry policy for that single call — the same shape as OCA's per-method retry override:

<!-- snippet-source: examples/readme.ts | regions: RetryOverride -->
```ts
// This call will not retry on transient errors
await consoleApi.getClusters({ retry: false });

// More aggressive retry for this operation only
await consoleApi.createBackup(
  { clusterUuid: '...' },
  { retry: { maxAttempts: 8, maxDelayMs: 5000 } }
);
```

| `options.retry` value                         | Behavior                                                            |
| --------------------------------------------- | ------------------------------------------------------------------- |
| omitted / `undefined`                         | Uses the global policy (`CAMUNDA_SDK_HTTP_RETRY_*`)                 |
| `false`                                       | Disables retry entirely (single attempt, no backoff)                |
| `{ maxAttempts?, baseDelayMs?, maxDelayMs? }` | Overrides the given fields; the rest inherit from the global policy |

## Behaviour

- **Authentication.** OAuth client credentials. The token is cached in memory and refreshed a minute before it expires. On a 401 the client fetches a new token and retries once.
- **Retries.** `429` is retried for every method, honouring `Retry-After`. `502`/`503`/`504` and network errors are retried only for idempotent methods (GET, PUT, DELETE), so a request such as `createCluster` is never sent twice. Backoff is exponential with full jitter, bounded by `CAMUNDA_SDK_HTTP_RETRY_BASE_DELAY_MS` and `CAMUNDA_SDK_HTTP_RETRY_MAX_DELAY_MS`.
- **Logging.** `CAMUNDA_SDK_LOG_LEVEL` selects `silent | error | warn | info | debug | trace | silly`, or pass your own `logger`. The SDK logs metadata only — operation ids, statuses, attempt numbers — and **never** request payloads, response bodies or token responses, at any level including `silly`, because Console responses can contain connector secrets and the token endpoint returns access tokens.
- **Errors.** All SDK-thrown operational errors are OCA's discriminated union (`SdkError`); narrow them with `isSdkError`. See below.

## Errors

The error model matches `@camunda8/orchestration-cluster-api` (`src/runtime/errors.ts` there): the same `name` values and the same `isSdkError` guard, so one `catch` block can handle errors from both packages.

<!-- snippet-source: examples/readme.ts | regions: ErrorHandling -->
```ts
try {
  await consoleApi.getCluster({ clusterUuid: '...' });
} catch (e) {
  if (isSdkError(e)) {
    switch (e.name) {
      case 'HttpSdkError':
        console.error('HTTP failure', e.status, e.operationId);
        break;
      case 'ValidationSdkError':
        console.error('Validation issue on', e.operationId, e.side, e.issues);
        break;
      case 'AuthSdkError':
        console.error('Auth problem', e.message, e.status);
        break;
      case 'NetworkSdkError':
        console.error('Network layer error', e.message);
        break;
    }
    return;
  }
  // Non-SDK (programmer) error; rethrow or wrap
  throw e;
}
```

- `HttpSdkError`: a non-2xx response. Carries `status` and `operationId`; when the server returns RFC 9457 Problem Details, `type`, `title`, `detail` and `instance` are passed through. Because Console returns non-RFC error bodies, the parsed response body is also available on `body`. The `message` never contains the body.
- `ValidationSdkError`: a request or response payload that does not match the spec. Carries `side` (`'request' | 'response'`), `operationId` and `issues` (code, path and message — never values).
- `AuthSdkError`: the OAuth token request failed. Carries `status` when there was one; the token endpoint's response body is never included.
- `NetworkSdkError`: the request never reached an HTTP response.
- Bad configuration (missing credentials, an invalid value) throws `CamundaConfigurationError`, which aggregates every problem found.

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

Methods take one object with path parameters and body fields merged. Most names are unchanged. The differences:

| `@camunda8/sdk` `AdminApiClient`                         | `@camunda8/console-api` `ConsoleClient`                               |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `createClient({ clusterUuid, clientName, permissions })` | `createClient({ clusterUuid, clientName, permissions })`              |
| `createSecret({ clusterUuid, secretName, secretValue })` | `createSecret({ clusterUuid, secretName, secretValue })`              |
| `createMember(email, orgRoles)`                          | `createMember({ email, orgRoles })`                                   |
| `getUsers()`                                             | `getMembers()`                                                        |
| `whitelistIPs(clusterUuid, list)`                        | `updateIpAllowlist({ clusterUuid, ipallowlist: list })`               |
| `updateIpAllowlist(clusterUuid, list)`                   | `updateIpAllowlist({ clusterUuid, ipallowlist: list })`               |
| `updateSecret(clusterUuid, name, value)`                 | `updateSecret({ clusterUuid, secretName: name, secretValue: value })` |
| `createMonitoringClient(clusterUuid, username)`          | `createMonitoringClient({ clusterUuid, username })`                   |

New in this package: `triggerFailover`, `updateClusterEncryption`, `getBackupSchedule`, `updateBackupSchedule`, `deleteBackupSchedule`, `restoreFromBackup`, `getRestoreStatus`.

## Migrating from a pre-release checkout of this package

The ergonomics alignment with OCA (issue #13) landed before the first npm release and reshaped the pre-release surface:

| Before (pre-release)                                                          | After                                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `updateIpAllowlist(clusterUuid, { ipallowlist })`                             | `updateIpAllowlist({ clusterUuid, ipallowlist })`                                                                              |
| `createSecret(clusterUuid, body)`                                             | `createSecret({ clusterUuid, ...body })`                                                                                       |
| `createMember(email, body)`                                                   | `createMember({ email, ...body })`                                                                                             |
| `createConsoleClient({ clientId, clientSecret, baseUrl, ... })`               | `createConsoleClient({ config: { CAMUNDA_CONSOLE_CLIENT_ID, CAMUNDA_CONSOLE_CLIENT_SECRET, CAMUNDA_CONSOLE_BASE_URL, ... } })` |
| `validateRequests` / `validateResponses` (`CAMUNDA_CONSOLE_VALIDATE_*`)       | `CAMUNDA_SDK_VALIDATION` (`none \| warn \| strict \| fanatical \| req:<mode>,res:<mode>`)                                      |
| `maxRetries` (`CAMUNDA_CONSOLE_MAX_RETRIES`), retries after the first attempt | `CAMUNDA_SDK_HTTP_RETRY_MAX_ATTEMPTS` / `_BASE_DELAY_MS` / `_MAX_DELAY_MS`, total attempts including the first                 |
| `userAgent` option                                                            | `CAMUNDA_CUSTOM_USER_AGENT_STRING`                                                                                             |
| `customRootCert` / `customRootCertPath` options                               | `CAMUNDA_CUSTOM_ROOT_CERT_STRING` / `CAMUNDA_CUSTOM_ROOT_CERT_PATH`                                                            |
| `ConsoleApiError`                                                             | `HttpSdkError` (`status`, `operationId`, `retries`, RFC 9457 fields, `body`)                                                   |
| `ConsoleApiValidationError` (`phase`, `operation`)                            | `ValidationSdkError` (`side`, `operationId`, `issues`)                                                                         |
| `ConsoleApiAuthError`                                                         | `AuthSdkError` (no response body)                                                                                              |
| `ConsoleApiConfigError`                                                       | `CamundaConfigurationError` (aggregates every problem)                                                                         |
| `instanceof` checks                                                           | `isSdkError(e)` + `e.name` switch                                                                                              |

## Low-level access

The client is generated from the published OpenAPI spec with [`@hey-api/openapi-ts`](https://heyapi.dev). All request and response types are exported, and the zod schemas are available as `schemas`. `consoleClient.client` is the underlying generated client.
