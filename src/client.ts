import { TokenProvider } from './auth';
import {
  type ConsoleConfig,
  type ResolvedConfig,
  resolveConfig,
  type ValidationMode,
} from './config';
import {
  httpError,
  isSchemaError,
  isSdkError,
  toValidationIssues,
  validationError,
} from './errors';
import { type Client, createClient } from './gen/client';
import * as api from './gen/sdk.gen';
import type * as T from './gen/types.gen';
import * as zodSchemas from './gen/zod.gen';
import { type Logger, resolveLogger } from './logger';
import { withCustomRootCert } from './tls';
import {
  createConsoleFetch,
  type OperationFetch,
  type OperationOptions,
  resolveRetryPolicy,
  runWithContext,
  type TransportContext,
} from './transport';
import { buildUserAgent } from './version';

export type { HttpRetryPolicy, OperationOptions } from './transport';

// operationId for each generated SDK function, keyed by the function object. Uses export names
// rather than Function.name, which bundlers may rename.
const OPERATION_IDS = new Map<unknown, string>(
  Object.entries(api).map(([name, fn]) => [fn, name.charAt(0).toUpperCase() + name.slice(1)])
);

/**
 * Options for {@link createConsoleClient}. Configuration goes in `config`, keyed by the
 * `CAMUNDA_*` environment variable names, as in `@camunda8/orchestration-cluster-api`;
 * non-configuration hooks (`fetch`, `logger`) stay outside `config`, as OCA keeps them.
 */
export interface ConsoleClientOptions {
  /**
   * Explicit configuration, keyed by environment variable names. Explicit config wins over the
   * environment, which wins over defaults.
   */
  config?: ConsoleConfig;
  /** Custom fetch implementation (for proxies, tests, or custom TLS). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Bring-your-own logger. Defaults to a console logger at `CAMUNDA_SDK_LOG_LEVEL`. */
  logger?: Logger;
  /** Environment to read configuration from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Test hook: replace the retry sleep. Not part of the public contract. */
  sleep?: (ms: number) => Promise<void>;
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

type AnyRecord = Record<string, unknown>;

/** Sentinel thrown by the probe client that reads an operation's generated validators. */
const PROBE = Symbol('validator-probe');

/**
 * Generated zod schemas keyed by operationId: request bodies (`z<Op>Body`, `z<Op>Body2`, ...)
 * and responses (`z<Op>Response`). Used by fanatical mode, which rejects fields the spec does
 * not declare, and to tell operations that take a body from path-only ones.
 */
const BODY_SCHEMAS: ReadonlyMap<string, unknown> = schemasMatching(/^z([A-Z].*?)Body\d*$/);
const RESPONSE_SCHEMAS: ReadonlyMap<string, unknown> = schemasMatching(/^z([A-Z].*?)Response$/);

function schemasMatching(pattern: RegExp): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const [exportName, schema] of Object.entries(zodSchemas)) {
    const m = pattern.exec(exportName);
    if (m) map.set(m[1], schema);
  }
  return map;
}

type ZodDefLike = {
  type?: string;
  shape?: Record<string, unknown>;
  catchall?: unknown;
  innerType?: unknown;
  in?: unknown;
  element?: unknown;
  left?: unknown;
  right?: unknown;
  getter?: () => unknown;
};

function defOf(schema: unknown): ZodDefLike | undefined {
  return (schema as { _zod?: { def?: ZodDefLike } } | undefined)?._zod?.def;
}

/** Strip wrappers (optional, nullable, default, ...) down to the schema that shapes the data. */
function unwrap(schema: unknown, depth = 0): unknown {
  const def = defOf(schema);
  if (!def || depth > 32) return schema;
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
      return unwrap(def.innerType, depth + 1);
    case 'pipe':
      return unwrap(def.in, depth + 1);
    case 'lazy':
      return def.getter ? unwrap(def.getter(), depth + 1) : schema;
    default:
      return schema;
  }
}

/**
 * The declared shape of an object schema (or an intersection of object schemas), or undefined
 * when the schema is not a closed object — records and catchall objects allow any key.
 */
function objectShape(schema: unknown): Record<string, unknown> | undefined {
  const def = defOf(unwrap(schema));
  if (!def) return undefined;
  if (def.type === 'object') {
    const catchall = defOf(def.catchall);
    if (catchall && catchall.type !== 'never') return undefined;
    return def.shape;
  }
  if (def.type === 'intersection') {
    const l = objectShape(def.left);
    const r = objectShape(def.right);
    return l && r ? { ...l, ...r } : undefined;
  }
  return undefined;
}

/**
 * Paths of fields the schema does not declare, at any depth (fanatical mode). Records, unions
 * and other open shapes are not descended into: their keys are not a fixed set.
 */
export function unknownFields(
  schema: unknown,
  data: unknown,
  path: (string | number)[] = []
): (string | number)[][] {
  const out: (string | number)[][] = [];
  const s = unwrap(schema);
  const def = defOf(s);
  if (!def || data === null || typeof data !== 'object') return out;
  if (def.type === 'array') {
    if (Array.isArray(data)) {
      data.forEach((item, i) => out.push(...unknownFields(def.element, item, [...path, i])));
    }
    return out;
  }
  const shape = objectShape(s);
  if (!shape || Array.isArray(data)) return out;
  for (const [k, v] of Object.entries(data as AnyRecord)) {
    if (!Object.hasOwn(shape, k)) out.push([...path, k]);
    else out.push(...unknownFields(shape[k], v, [...path, k]));
  }
  return out;
}

/**
 * Split a facade argument object into the `{ path, body }` shape the generated client expects.
 * Path parameters are the fields named in `pathParams`; everything else is the request body.
 * A field listed in both is a spec-level defect: it throws rather than silently overwriting
 * one side (guarded for every operation by the clash test in tests/surface.test.ts).
 */
export function splitArgs(
  operationId: string,
  pathParams: readonly string[],
  args: AnyRecord | undefined
): { path?: AnyRecord; body?: AnyRecord } {
  const input = args ?? {};
  const inPath = new Set(pathParams);
  const path: AnyRecord = {};
  const body: AnyRecord = {};
  for (const [k, v] of Object.entries(input)) {
    if (inPath.has(k)) {
      if (k in body) {
        throw new Error(
          `${operationId}: field "${k}" is both a path parameter and a body field; this is a defect in the generated client — please open an issue`
        );
      }
      path[k] = v;
    } else {
      body[k] = v;
    }
  }
  const result: { path?: AnyRecord; body?: AnyRecord } = {};
  if (pathParams.length > 0) result.path = path;
  // An operation that declares a request body gets one even when every field is optional and
  // none was given (`updateCluster({ clusterUuid })` sends `{}`); path-only operations get none.
  if (Object.keys(body).length > 0 || BODY_SCHEMAS.has(operationId)) result.body = body;
  return result;
}

/**
 * Client for the Camunda 8 SaaS Console (Administration) API.
 *
 * ```ts
 * const consoleApi = createConsoleClient(); // reads CAMUNDA_CONSOLE_* from the environment
 * const clusters = await consoleApi.getClusters();
 * ```
 *
 * Methods take a single object — path parameters and body fields together, as in
 * `@camunda8/orchestration-cluster-api` — plus an optional trailing `{ retry }` options
 * argument. Errors are OCA's `SdkError` union; narrow them with `isSdkError`.
 */
export class ConsoleClient {
  readonly config: Readonly<ResolvedConfig>;
  /** The underlying generated client, for advanced use with the functions in `./gen`. */
  readonly client: Client;
  private readonly tokens: TokenProvider;
  private readonly transport: OperationFetch;
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ConsoleClientOptions = {}) {
    const { fetch: baseFetch = globalThis.fetch, logger, env, config, sleep } = options;
    this.logger = resolveLogger(
      // Resolve the level leniently first so an invalid level does not mask the config error.
      resolveConfigLenient(config, env).logLevel,
      logger
    );
    this.config = Object.freeze(resolveConfig(config, env, (m) => this.logger.warn(m)));
    const fetchImpl = this.config.customRootCert
      ? withCustomRootCert(baseFetch, this.config.customRootCert)
      : baseFetch;
    this.tokens = new TokenProvider(this.config, fetchImpl, Date.now, this.logger);
    this.sleep = sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.transport = createConsoleFetch({
      fetch: fetchImpl,
      tokens: this.tokens,
      retry: this.config.retry,
      userAgent: buildUserAgent(this.config.userAgent),
      logger: this.logger,
      sleep: this.sleep,
    });
    this.client = createClient({
      baseUrl: this.config.baseUrl,
      throwOnError: false,
      fetch: this.transport as typeof fetch,
    });
    this.logger.debug('config.hydrated', { config: redactedConfig(this.config) });
  }

  private async call<R>(
    // The facade erases the generated per-operation option types (each operation's Options
    // type differs; the facade handles them uniformly).
    operation: (options: any) => Promise<Result>,
    args: AnyRecord | undefined,
    pathParams: readonly string[],
    options?: OperationOptions,
    extra?: AnyRecord
  ): Promise<R> {
    const operationId = OPERATION_IDS.get(operation) ?? 'unknown operation';
    const retryPolicy = resolveRetryPolicy(this.config.retry, options?.retry);
    const maxAttempts = Math.max(1, retryPolicy.maxAttempts);
    const reqMode = this.config.reqValidation;
    const resMode = this.config.resValidation;

    // The generated SDK functions define per-operation zod validators and then spread the
    // options we pass over them, so the modes are applied by passing a replacement validator:
    // `none` disables it, `strict` keeps it as-is, `warn` logs and continues, and `fanatical`
    // additionally rejects fields the spec does not declare, at any depth, on either side. Validation issues never carry
    // values (see errors.ts), and warn-mode logs carry only the issues.
    const wrapValidator = (
      side: 'request' | 'response',
      mode: ValidationMode,
      validator: unknown
    ): unknown => {
      if (mode === 'none') return undefined;
      if (typeof validator !== 'function' || mode === 'strict') return validator;
      const strict = validator as (data: unknown) => Promise<unknown>;
      return async (data: unknown) => {
        try {
          await strict(data);
        } catch (e) {
          if (!isSchemaError(e)) throw e;
          if (mode === 'warn') {
            this.logger.warn('validation.failed', {
              operationId,
              side,
              issues: toValidationIssues(e),
            });
            return;
          }
          throw e; // fanatical: everything strict rejects, plus unknown fields below
        }
        if (mode !== 'fanatical' || !data || typeof data !== 'object') return;
        // The request validator receives the request options (`{ body, path, ... }`); the
        // response validator receives the parsed response data.
        const unknown =
          side === 'request'
            ? 'body' in data
              ? unknownFields(BODY_SCHEMAS.get(operationId), (data as AnyRecord).body, ['body'])
              : []
            : unknownFields(RESPONSE_SCHEMAS.get(operationId), data);
        if (unknown.length > 0) {
          throw validationError({
            side,
            operationId,
            issues: unknown.map((p) => ({
              code: 'unrecognized_keys',
              path: p,
              message: `Unknown field "${String(p[p.length - 1])}"`,
            })),
          });
        }
      };
    };

    // Read the operation's generated validators off a probe client (the operation spreads its
    // own defaults first, so a client-level validator would win over them), wrap them for the
    // configured modes, and pass the wrapped ones back in the real call.
    const needsWrap = reqMode !== 'strict' || resMode !== 'strict';
    let validatorOverrides: AnyRecord = {};
    if (needsWrap) {
      const probeHandler = (opts: AnyRecord) => {
        validatorOverrides = {
          requestValidator: wrapValidator('request', reqMode, opts.requestValidator),
          responseValidator: wrapValidator('response', resMode, opts.responseValidator),
        };
        throw PROBE;
      };
      const probe = {
        get: probeHandler,
        post: probeHandler,
        put: probeHandler,
        patch: probeHandler,
        delete: probeHandler,
        head: probeHandler,
        options: probeHandler,
        request: probeHandler,
      };
      try {
        await operation({ ...splitArgs(operationId, pathParams, args), ...extra, client: probe });
      } catch (e) {
        if (e !== PROBE) throw e;
      }
    }

    const ctx: TransportContext = { retryPolicy, operationId, attempts: 0 };
    let result: Result;
    try {
      result = await runWithContext(ctx, () =>
        operation({
          ...splitArgs(operationId, pathParams, args),
          ...extra,
          client: this.client,
          throwOnError: false,
          ...validatorOverrides,
        })
      );
    } catch (e) {
      // Older generated clients let the request validator throw directly.
      if (isSchemaError(e)) {
        throw validationError({
          side: 'request',
          operationId,
          issues: toValidationIssues(e),
        });
      }
      throw e;
    }
    // Request validation runs before sending, so a schema error without a response is a request
    // validation failure.
    if (!result.response && isSchemaError(result.error)) {
      throw validationError({
        side: 'request',
        operationId,
        issues: toValidationIssues(result.error),
      });
    }
    if (result.response?.ok && isSchemaError(result.error)) {
      throw validationError({
        side: 'response',
        operationId,
        issues: toValidationIssues(result.error),
        status: result.response.status,
      });
    }
    // An SDK error thrown by a wrapped validator (fanatical) or by the transport (network
    // failure) surfaces in `error`; pass it through rather than wrapping it as an HTTP error.
    if (isSdkError(result.error)) {
      throw result.error;
    }
    if (result.error !== undefined || (result.response && !result.response.ok)) {
      const status = result.response?.status ?? 0;
      throw httpError({
        status,
        method: result.request?.method,
        url: result.request?.url,
        operationId,
        body: result.error,
        retries: { attempt: ctx.attempts, max: maxAttempts },
      });
    }
    return result.data as R;
  }

  // --- Clusters -------------------------------------------------------------------------------

  /** List all clusters in the organisation. */
  getClusters(options?: OperationOptions): Promise<T.GetClustersResponse> {
    return this.call(api.getClusters, undefined, [], options);
  }

  /** Create a cluster. Use {@link getParameters} to discover valid plan types, channels, generations and regions. */
  createCluster(
    args: T.CreateClusterBody,
    options?: OperationOptions
  ): Promise<T.CreateClusterResponse> {
    return this.call(api.createCluster, args, [], options);
  }

  getCluster(
    args: { clusterUuid: string },
    options?: OperationOptions
  ): Promise<T.GetClusterResponse> {
    return this.call(api.getCluster, args, ['clusterUuid'], options);
  }

  updateCluster(
    args: { clusterUuid: string } & T.UpdateClusterBody,
    options?: OperationOptions
  ): Promise<T.UpdateClusterResponse> {
    return this.call(api.updateCluster, args, ['clusterUuid'], options);
  }

  deleteCluster(
    args: { clusterUuid: string },
    options?: OperationOptions
  ): Promise<T.DeleteClusterResponse> {
    return this.call(api.deleteCluster, args, ['clusterUuid'], options);
  }

  /** Get the options available for creating a cluster (channels, generations, plan types, regions). */
  getParameters(options?: OperationOptions): Promise<T.GetParametersResponse> {
    return this.call(api.getParameters, undefined, [], options);
  }

  upgradeCluster(
    args: { clusterUuid: string },
    options?: OperationOptions
  ): Promise<T.UpgradeClusterResponse> {
    return this.call(api.upgradeCluster, args, ['clusterUuid'], options);
  }

  /** Resume a cluster that has been put to sleep. */
  wakeCluster(args: { clusterUuid: string }, options?: OperationOptions): Promise<T.WakeResponse> {
    return this.call(api.wake, args, ['clusterUuid'], options);
  }

  updateClusterEncryption(
    args: { clusterUuid: string } & T.UpdateClusterEncryptionBody,
    options?: OperationOptions
  ): Promise<T.UpdateClusterEncryptionResponse> {
    return this.call(api.updateClusterEncryption, args, ['clusterUuid'], options);
  }

  triggerFailover(
    args: { clusterUuid: string } & T.TriggerFailoverBody,
    options?: OperationOptions
  ): Promise<T.TriggerFailoverResponse> {
    return this.call(api.triggerFailover, args, ['clusterUuid'], options);
  }

  updateIpAllowlist(
    args: { clusterUuid: string } & T.IpAllowListBody,
    options?: OperationOptions
  ): Promise<T.UpdateIpAllowlistResponse> {
    return this.call(api.updateIpAllowlist, args, ['clusterUuid'], options);
  }

  /** @deprecated Deprecated in the Console API. Use {@link updateIpAllowlist}. */
  updateIpWhitelist(
    args: { clusterUuid: string } & T.IpWhiteListBody,
    options?: OperationOptions
  ): Promise<T.UpdateIpWhitelistResponse> {
    return this.call(api.updateIpWhitelist, args, ['clusterUuid'], options);
  }

  // --- API clients ----------------------------------------------------------------------------

  getClients(
    args: { clusterUuid: string },
    options?: OperationOptions
  ): Promise<T.GetClientsResponse> {
    return this.call(api.getClients, args, ['clusterUuid'], options);
  }

  createClient(
    args: { clusterUuid: string } & T.CreateClusterClientBody,
    options?: OperationOptions
  ): Promise<T.CreateClientResponse> {
    return this.call(api.createClient, args, ['clusterUuid'], options);
  }

  getClient(
    args: { clusterUuid: string; clientId: string },
    options?: OperationOptions
  ): Promise<T.GetClientResponse> {
    return this.call(api.getClient, args, ['clusterUuid', 'clientId'], options);
  }

  deleteClient(
    args: { clusterUuid: string; clientId: string },
    options?: OperationOptions
  ): Promise<T.DeleteClientResponse> {
    return this.call(api.deleteClient, args, ['clusterUuid', 'clientId'], options);
  }

  // --- Connector secrets ----------------------------------------------------------------------

  getSecrets(
    args: { clusterUuid: string },
    options?: OperationOptions
  ): Promise<T.GetSecretsResponse> {
    return this.call(api.getSecrets, args, ['clusterUuid'], options);
  }

  createSecret(
    args: { clusterUuid: string } & T.CreateSecretBody,
    options?: OperationOptions
  ): Promise<T.CreateSecretResponse> {
    return this.call(api.createSecret, args, ['clusterUuid'], options);
  }

  updateSecret(
    args: { clusterUuid: string; secretName: string } & T.UpdateSecretBody,
    options?: OperationOptions
  ): Promise<T.UpdateSecretResponse> {
    return this.call(api.updateSecret, args, ['clusterUuid', 'secretName'], options);
  }

  deleteSecret(
    args: { clusterUuid: string; secretName: string },
    options?: OperationOptions
  ): Promise<T.DeleteSecretResponse> {
    return this.call(api.deleteSecret, args, ['clusterUuid', 'secretName'], options);
  }

  // --- Secure connectivity --------------------------------------------------------------------

  getSecureConnectivityStatus(
    args: { clusterUuid: string },
    options?: OperationOptions
  ): Promise<T.GetSecureConnectivityStatusResponse> {
    return this.call(api.getSecureConnectivityStatus, args, ['clusterUuid'], options);
  }

  activateSecureConnectivity(
    args: { clusterUuid: string } & NonNullable<T.ActivateSecureConnectivityData['body']>,
    options?: OperationOptions
  ): Promise<T.ActivateSecureConnectivityResponse> {
    return this.call(api.activateSecureConnectivity, args, ['clusterUuid'], options);
  }

  deactivateSecureConnectivity(
    args: { clusterUuid: string },
    options?: OperationOptions
  ): Promise<T.DeactivateSecureConnectivityResponse> {
    return this.call(api.deactivateSecureConnectivity, args, ['clusterUuid'], options);
  }

  // --- Monitoring -----------------------------------------------------------------------------

  activateMonitoring(
    args: { clusterUuid: string },
    options?: OperationOptions
  ): Promise<T.ActivateMonitoringResponse> {
    return this.call(api.activateMonitoring, args, ['clusterUuid'], options);
  }

  deactivateMonitoring(
    args: { clusterUuid: string },
    options?: OperationOptions
  ): Promise<T.DeactivateMonitoringResponse> {
    return this.call(api.deactivateMonitoring, args, ['clusterUuid'], options);
  }

  getMonitoringClients(
    args: { clusterUuid: string },
    options?: OperationOptions
  ): Promise<T.GetMonitoringClientsResponse> {
    return this.call(api.getMonitoringClients, args, ['clusterUuid'], options);
  }

  createMonitoringClient(
    args: { clusterUuid: string } & NonNullable<T.CreateMonitoringClientData['body']>,
    options?: OperationOptions
  ): Promise<T.CreateMonitoringClientResponse> {
    return this.call(api.createMonitoringClient, args, ['clusterUuid'], options);
  }

  rotateMonitoringClientPassword(
    args: { clusterUuid: string; clientUuid: string },
    options?: OperationOptions
  ): Promise<T.RotateMonitoringClientPasswordResponse> {
    return this.call(
      api.rotateMonitoringClientPassword,
      args,
      ['clusterUuid', 'clientUuid'],
      options
    );
  }

  deleteMonitoringClient(
    args: { clusterUuid: string; clientUuid: string },
    options?: OperationOptions
  ): Promise<T.DeleteMonitoringClientResponse> {
    return this.call(api.deleteMonitoringClient, args, ['clusterUuid', 'clientUuid'], options);
  }

  // --- Backups --------------------------------------------------------------------------------

  getBackups(
    args: { clusterUuid: string },
    options?: OperationOptions
  ): Promise<T.GetBackupsResponse> {
    return this.call(api.getBackups, args, ['clusterUuid'], options);
  }

  createBackup(
    args: { clusterUuid: string },
    options?: OperationOptions
  ): Promise<T.CreateBackupResponse> {
    return this.call(api.createBackup, args, ['clusterUuid'], options);
  }

  deleteBackup(
    args: { clusterUuid: string; backupId: string },
    options?: OperationOptions
  ): Promise<T.DeleteBackupResponse> {
    return this.call(api.deleteBackup, args, ['clusterUuid', 'backupId'], options);
  }

  getBackupSchedule(
    args: { clusterUuid: string },
    options?: OperationOptions
  ): Promise<T.GetScheduleResponse> {
    return this.call(api.getSchedule, args, ['clusterUuid'], options);
  }

  updateBackupSchedule(
    args: { clusterUuid: string } & T.BackupScheduleBody,
    options?: OperationOptions
  ): Promise<T.UpdateScheduleResponse> {
    return this.call(api.updateSchedule, args, ['clusterUuid'], options);
  }

  deleteBackupSchedule(
    args: { clusterUuid: string },
    options?: OperationOptions
  ): Promise<T.DeleteScheduleResponse> {
    return this.call(api.deleteSchedule, args, ['clusterUuid'], options);
  }

  restoreFromBackup(
    args: { clusterUuid: string; backupId: string },
    options?: OperationOptions
  ): Promise<T.RestoreFromBackupResponse> {
    return this.call(api.restoreFromBackup, args, ['clusterUuid', 'backupId'], options);
  }

  getRestoreStatus(
    args: { clusterUuid: string; backupId: string },
    options?: OperationOptions
  ): Promise<T.GetRestoreResponse> {
    return this.call(api.getRestore, args, ['clusterUuid', 'backupId'], options);
  }

  // --- Organisation ---------------------------------------------------------------------------

  getMembers(options?: OperationOptions): Promise<T.GetMembersResponse> {
    return this.call(api.getMembers, undefined, [], options);
  }

  /** Add a member to the organisation, or update the roles of an existing member. */
  createMember(
    args: { email: string } & T.PostMemberBody,
    options?: OperationOptions
  ): Promise<T.UpdateMembersResponse> {
    return this.call(api.updateMembers, args, ['email'], options);
  }

  deleteMember(
    args: { email: string },
    options?: OperationOptions
  ): Promise<T.DeleteMemberResponse> {
    return this.call(api.deleteMember, args, ['email'], options);
  }

  /** Get the egress IP ranges used by Camunda SaaS components (for firewall allowlisting). */
  getIpRanges(options?: OperationOptions): Promise<T.GetMetaResponse> {
    return this.call(api.getMeta, undefined, [], options);
  }

  /** Get the organisation's audit log (activity events) as JSON. */
  getActivityEvents(options?: OperationOptions): Promise<T.GetJsonResponse> {
    return this.call(api.getJson, undefined, [], options);
  }

  /** Get the organisation's audit log (activity events) as CSV. */
  getActivityEventsCsv(options?: OperationOptions): Promise<T.GetCsvResponse> {
    return this.call(api.getCsv, undefined, [], options, { parseAs: 'text' });
  }
}

/** Create a {@link ConsoleClient}. Configuration is read from `config` first, then the `CAMUNDA_*` environment variables, then defaults. */
export function createConsoleClient(options: ConsoleClientOptions = {}): ConsoleClient {
  return new ConsoleClient(options);
}

/**
 * Resolve config without throwing, for logger construction. The real `resolveConfig` call in
 * the constructor re-checks and throws `CamundaConfigurationError` on any problem.
 */
function resolveConfigLenient(
  config: ConsoleConfig | undefined,
  env: Record<string, string | undefined> | undefined
): { logLevel: ResolvedConfig['logLevel'] } {
  try {
    return resolveConfig(config, env, () => {});
  } catch {
    return { logLevel: 'error' };
  }
}

/** The effective config for logging, with secrets masked. */
function redactedConfig(config: ResolvedConfig): Record<string, unknown> {
  return {
    ...config,
    clientId: mask(config.clientId),
    clientSecret: mask(config.clientSecret),
    customRootCert: config.customRootCert ? '[present]' : undefined,
  };
}

function mask(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}
