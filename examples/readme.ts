/**
 * README examples. Code between region tags is injected into README.md by
 * `npm run sync-readme`. This file is typechecked, so README examples always compile.
 */
//#region Import
import { createConsoleClient, isSdkError } from '@camunda8/console-api';
//#endregion Import

export async function usage() {
  //#region Usage
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
  //#endregion Usage
}

export function explicitConfig() {
  //#region ExplicitConfig
  const consoleApi = createConsoleClient({
    config: {
      CAMUNDA_CONSOLE_CLIENT_ID: '...',
      CAMUNDA_CONSOLE_CLIENT_SECRET: '...',
    },
  });
  //#endregion ExplicitConfig
  return consoleApi;
}

export async function retryOverride() {
  const consoleApi = createConsoleClient();
  //#region RetryOverride
  // This call will not retry on transient errors
  await consoleApi.getClusters({ retry: false });

  // More aggressive retry for this operation only
  await consoleApi.createBackup(
    { clusterUuid: '...' },
    { retry: { maxAttempts: 8, maxDelayMs: 5000 } }
  );
  //#endregion RetryOverride
}

export async function errorHandling() {
  const consoleApi = createConsoleClient();
  //#region ErrorHandling
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
  //#endregion ErrorHandling
}

export function migration() {
  //#region Migration
  const admin = createConsoleClient();
  //#endregion Migration
  return admin;
}
