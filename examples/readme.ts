/**
 * README examples. Code between region tags is injected into README.md by
 * `npm run sync-readme`. This file is typechecked, so README examples always compile.
 */
//#region Import
import { ConsoleApiError, createConsoleClient } from '@camunda8/console-api';
//#endregion Import

export async function usage() {
  //#region Usage
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
  //#endregion Usage
}

export function explicitConfig() {
  //#region ExplicitConfig
  const consoleApi = createConsoleClient({
    clientId: '...',
    clientSecret: '...',
  });
  //#endregion ExplicitConfig
  return consoleApi;
}

export function migration() {
  //#region Migration
  const admin = createConsoleClient();
  //#endregion Migration
  return admin;
}
