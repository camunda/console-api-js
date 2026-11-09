import { TokenProvider } from './auth';
import { type ConsoleApiConfig, resolveConfig } from './config';
import { ConsoleApiError } from './errors';
import { type Client, createClient } from './gen/client';
import * as api from './gen/sdk.gen';
import type * as T from './gen/types.gen';
import { createConsoleFetch, type RetryOptions } from './transport';

export interface ConsoleClientOptions extends Partial<ConsoleApiConfig> {
  /** Custom fetch implementation (for proxies, tests, or custom TLS). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Environment to read configuration from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Advanced retry tuning. */
  retry?: Omit<RetryOptions, 'maxRetries'>;
}

/**
 * Maps every operationId in the Console API spec to the ConsoleClient method that calls it.
 * A unit test fails if the spec gains an operation that is missing here, so a spec refresh can
 * never silently leave part of the API unreachable through the client.
 */
export const OPERATION_METHODS = {
  GetClusters: 'getClusters',
  CreateCluster: 'createCluster',
  GetCluster: 'getCluster',
  UpdateCluster: 'updateCluster',
  DeleteCluster: 'deleteCluster',
  GetParameters: 'getParameters',
  UpgradeCluster: 'upgradeCluster',
  Wake: 'wakeCluster',
  UpdateClusterEncryption: 'updateClusterEncryption',
  TriggerFailover: 'triggerFailover',
  UpdateIpAllowlist: 'updateIpAllowlist',
  UpdateIpWhitelist: 'updateIpWhitelist',
  GetClients: 'getClients',
  CreateClient: 'createClient',
  GetClient: 'getClient',
  DeleteClient: 'deleteClient',
  GetSecrets: 'getSecrets',
  CreateSecret: 'createSecret',
  UpdateSecret: 'updateSecret',
  DeleteSecret: 'deleteSecret',
  GetSecureConnectivityStatus: 'getSecureConnectivityStatus',
  ActivateSecureConnectivity: 'activateSecureConnectivity',
  DeactivateSecureConnectivity: 'deactivateSecureConnectivity',
  ActivateMonitoring: 'activateMonitoring',
  DeactivateMonitoring: 'deactivateMonitoring',
  GetMonitoringClients: 'getMonitoringClients',
  CreateMonitoringClient: 'createMonitoringClient',
  RotateMonitoringClientPassword: 'rotateMonitoringClientPassword',
  DeleteMonitoringClient: 'deleteMonitoringClient',
  GetBackups: 'getBackups',
  CreateBackup: 'createBackup',
  DeleteBackup: 'deleteBackup',
  GetSchedule: 'getBackupSchedule',
  UpdateSchedule: 'updateBackupSchedule',
  DeleteSchedule: 'deleteBackupSchedule',
  RestoreFromBackup: 'restoreFromBackup',
  GetRestore: 'getRestoreStatus',
  GetMembers: 'getMembers',
  UpdateMembers: 'createMember',
  DeleteMember: 'deleteMember',
  GetMeta: 'getIpRanges',
  GetJson: 'getActivityEvents',
  GetCsv: 'getActivityEventsCsv',
} as const satisfies Record<string, keyof ConsoleClient>;

type Result = { data?: unknown; error?: unknown; response?: Response; request?: Request };

/**
 * Client for the Camunda 8 SaaS Console (Administration) API.
 *
 * ```ts
 * const console = createConsoleClient(); // reads CAMUNDA_CONSOLE_* from the environment
 * const clusters = await console.getClusters();
 * ```
 *
 * Every method throws {@link ConsoleApiError} on a non-2xx response.
 */
export class ConsoleClient {
  readonly config: Readonly<ConsoleApiConfig>;
  /** The underlying generated client, for advanced use with the functions in `./gen`. */
  readonly client: Client;
  private readonly tokens: TokenProvider;

  constructor(options: ConsoleClientOptions = {}) {
    const { fetch: fetchImpl = globalThis.fetch, env, retry, ...configOptions } = options;
    this.config = Object.freeze(resolveConfig(configOptions, env));
    this.tokens = new TokenProvider(this.config, fetchImpl);
    this.client = createClient({
      baseUrl: this.config.baseUrl,
      throwOnError: false,
      fetch: createConsoleFetch({
        fetch: fetchImpl,
        tokens: this.tokens,
        maxRetries: this.config.maxRetries,
        ...retry,
      }),
    });
  }

  private async call<R>(
    operation: (options: any) => Promise<Result>,
    options: Record<string, unknown> = {}
  ): Promise<R> {
    const overrides: Record<string, unknown> = {};
    if (!this.config.validateRequests) overrides.requestValidator = undefined;
    if (!this.config.validateResponses) overrides.responseValidator = undefined;
    const result = await operation({
      ...options,
      ...overrides,
      client: this.client,
      throwOnError: false,
    });
    if (result.error !== undefined || (result.response && !result.response.ok)) {
      throw ConsoleApiError.from(result.request, result.response, result.error);
    }
    return result.data as R;
  }

  // --- Clusters -------------------------------------------------------------------------------

  /** List all clusters in the organisation. */
  getClusters(): Promise<T.GetClustersResponse> {
    return this.call(api.getClusters);
  }

  /** Create a cluster. Use {@link getParameters} to discover valid plan types, channels, generations and regions. */
  createCluster(body: T.CreateClusterBody): Promise<T.CreateClusterResponse> {
    return this.call(api.createCluster, { body });
  }

  getCluster(clusterUuid: string): Promise<T.GetClusterResponse> {
    return this.call(api.getCluster, { path: { clusterUuid } });
  }

  updateCluster(clusterUuid: string, body: T.UpdateClusterBody): Promise<T.UpdateClusterResponse> {
    return this.call(api.updateCluster, { path: { clusterUuid }, body });
  }

  deleteCluster(clusterUuid: string): Promise<T.DeleteClusterResponse> {
    return this.call(api.deleteCluster, { path: { clusterUuid } });
  }

  /** Get the options available for creating a cluster (channels, generations, plan types, regions). */
  getParameters(): Promise<T.GetParametersResponse> {
    return this.call(api.getParameters);
  }

  upgradeCluster(clusterUuid: string): Promise<T.UpgradeClusterResponse> {
    return this.call(api.upgradeCluster, { path: { clusterUuid } });
  }

  /** Resume a cluster that has been put to sleep. */
  wakeCluster(clusterUuid: string): Promise<T.WakeResponse> {
    return this.call(api.wake, { path: { clusterUuid } });
  }

  updateClusterEncryption(
    clusterUuid: string,
    body: T.UpdateClusterEncryptionBody
  ): Promise<T.UpdateClusterEncryptionResponse> {
    return this.call(api.updateClusterEncryption, { path: { clusterUuid }, body });
  }

  triggerFailover(
    clusterUuid: string,
    body: T.TriggerFailoverBody
  ): Promise<T.TriggerFailoverResponse> {
    return this.call(api.triggerFailover, { path: { clusterUuid }, body });
  }

  updateIpAllowlist(
    clusterUuid: string,
    body: T.IpAllowListBody
  ): Promise<T.UpdateIpAllowlistResponse> {
    return this.call(api.updateIpAllowlist, { path: { clusterUuid }, body });
  }

  /** @deprecated Deprecated in the Console API. Use {@link updateIpAllowlist}. */
  updateIpWhitelist(
    clusterUuid: string,
    body: T.IpWhiteListBody
  ): Promise<T.UpdateIpWhitelistResponse> {
    return this.call(api.updateIpWhitelist, { path: { clusterUuid }, body });
  }

  // --- API clients ----------------------------------------------------------------------------

  getClients(clusterUuid: string): Promise<T.GetClientsResponse> {
    return this.call(api.getClients, { path: { clusterUuid } });
  }

  createClient(
    clusterUuid: string,
    body: T.CreateClusterClientBody
  ): Promise<T.CreateClientResponse> {
    return this.call(api.createClient, { path: { clusterUuid }, body });
  }

  getClient(clusterUuid: string, clientId: string): Promise<T.GetClientResponse> {
    return this.call(api.getClient, { path: { clusterUuid, clientId } });
  }

  deleteClient(clusterUuid: string, clientId: string): Promise<T.DeleteClientResponse> {
    return this.call(api.deleteClient, { path: { clusterUuid, clientId } });
  }

  // --- Connector secrets ----------------------------------------------------------------------

  getSecrets(clusterUuid: string): Promise<T.GetSecretsResponse> {
    return this.call(api.getSecrets, { path: { clusterUuid } });
  }

  createSecret(clusterUuid: string, body: T.CreateSecretBody): Promise<T.CreateSecretResponse> {
    return this.call(api.createSecret, { path: { clusterUuid }, body });
  }

  updateSecret(
    clusterUuid: string,
    secretName: string,
    body: T.UpdateSecretBody
  ): Promise<T.UpdateSecretResponse> {
    return this.call(api.updateSecret, { path: { clusterUuid, secretName }, body });
  }

  deleteSecret(clusterUuid: string, secretName: string): Promise<T.DeleteSecretResponse> {
    return this.call(api.deleteSecret, { path: { clusterUuid, secretName } });
  }

  // --- Secure connectivity --------------------------------------------------------------------

  getSecureConnectivityStatus(clusterUuid: string): Promise<T.GetSecureConnectivityStatusResponse> {
    return this.call(api.getSecureConnectivityStatus, { path: { clusterUuid } });
  }

  activateSecureConnectivity(
    clusterUuid: string,
    body: T.ActivateSecureConnectivityData['body']
  ): Promise<T.ActivateSecureConnectivityResponse> {
    return this.call(api.activateSecureConnectivity, { path: { clusterUuid }, body });
  }

  deactivateSecureConnectivity(
    clusterUuid: string
  ): Promise<T.DeactivateSecureConnectivityResponse> {
    return this.call(api.deactivateSecureConnectivity, { path: { clusterUuid } });
  }

  // --- Monitoring -----------------------------------------------------------------------------

  activateMonitoring(clusterUuid: string): Promise<T.ActivateMonitoringResponse> {
    return this.call(api.activateMonitoring, { path: { clusterUuid } });
  }

  deactivateMonitoring(clusterUuid: string): Promise<T.DeactivateMonitoringResponse> {
    return this.call(api.deactivateMonitoring, { path: { clusterUuid } });
  }

  getMonitoringClients(clusterUuid: string): Promise<T.GetMonitoringClientsResponse> {
    return this.call(api.getMonitoringClients, { path: { clusterUuid } });
  }

  createMonitoringClient(
    clusterUuid: string,
    body: T.CreateMonitoringClientData['body']
  ): Promise<T.CreateMonitoringClientResponse> {
    return this.call(api.createMonitoringClient, { path: { clusterUuid }, body });
  }

  rotateMonitoringClientPassword(
    clusterUuid: string,
    clientUuid: string
  ): Promise<T.RotateMonitoringClientPasswordResponse> {
    return this.call(api.rotateMonitoringClientPassword, { path: { clusterUuid, clientUuid } });
  }

  deleteMonitoringClient(
    clusterUuid: string,
    clientUuid: string
  ): Promise<T.DeleteMonitoringClientResponse> {
    return this.call(api.deleteMonitoringClient, { path: { clusterUuid, clientUuid } });
  }

  // --- Backups --------------------------------------------------------------------------------

  getBackups(clusterUuid: string): Promise<T.GetBackupsResponse> {
    return this.call(api.getBackups, { path: { clusterUuid } });
  }

  createBackup(clusterUuid: string): Promise<T.CreateBackupResponse> {
    return this.call(api.createBackup, { path: { clusterUuid } });
  }

  deleteBackup(clusterUuid: string, backupId: string): Promise<T.DeleteBackupResponse> {
    return this.call(api.deleteBackup, { path: { clusterUuid, backupId } });
  }

  getBackupSchedule(clusterUuid: string): Promise<T.GetScheduleResponse> {
    return this.call(api.getSchedule, { path: { clusterUuid } });
  }

  updateBackupSchedule(
    clusterUuid: string,
    body: T.BackupScheduleBody
  ): Promise<T.UpdateScheduleResponse> {
    return this.call(api.updateSchedule, { path: { clusterUuid }, body });
  }

  deleteBackupSchedule(clusterUuid: string): Promise<T.DeleteScheduleResponse> {
    return this.call(api.deleteSchedule, { path: { clusterUuid } });
  }

  restoreFromBackup(clusterUuid: string, backupId: string): Promise<T.RestoreFromBackupResponse> {
    return this.call(api.restoreFromBackup, { path: { clusterUuid, backupId } });
  }

  getRestoreStatus(clusterUuid: string, backupId: string): Promise<T.GetRestoreResponse> {
    return this.call(api.getRestore, { path: { clusterUuid, backupId } });
  }

  // --- Organisation ---------------------------------------------------------------------------

  getMembers(): Promise<T.GetMembersResponse> {
    return this.call(api.getMembers);
  }

  /** Add a member to the organisation, or update the roles of an existing member. */
  createMember(email: string, body: T.PostMemberBody): Promise<T.UpdateMembersResponse> {
    return this.call(api.updateMembers, { path: { email }, body });
  }

  deleteMember(email: string): Promise<T.DeleteMemberResponse> {
    return this.call(api.deleteMember, { path: { email } });
  }

  /** Get the egress IP ranges used by Camunda SaaS components (for firewall allowlisting). */
  getIpRanges(): Promise<T.GetMetaResponse> {
    return this.call(api.getMeta);
  }

  /** Get the organisation's audit log (activity events) as JSON. */
  getActivityEvents(): Promise<T.GetJsonResponse> {
    return this.call(api.getJson);
  }

  /** Get the organisation's audit log (activity events) as CSV. */
  getActivityEventsCsv(): Promise<T.GetCsvResponse> {
    return this.call(api.getCsv, { parseAs: 'text' });
  }
}

/** Create a {@link ConsoleClient}. Options not given are read from `CAMUNDA_CONSOLE_*` environment variables. */
export function createConsoleClient(options: ConsoleClientOptions = {}): ConsoleClient {
  return new ConsoleClient(options);
}
