import {Cause, Clock, Console, Crypto, Effect, Exit, FileSystem, Path, Result} from 'effect';
import {runDetachedCommandEffect} from './effect/command.js';
import {applicationError} from './effect/errors.js';
import {syncDirectoryBestEffort, syncWritableFile} from './effect/file_durability.js';
import {FileLockTimeout, withExclusiveFileLock} from './effect/file_lock.js';
import {SystemInfo} from './effect/system.js';
import {activeInstalledVersion, installationRoot} from './installations.js';
import {redactSensitiveText} from './scrubber.js';
import {sendSystemNotification, type SystemNotificationDelivery} from './system_notification.js';
import type {RuntimeConfig, UpdateOptions} from './types.js';
import {runUpdate} from './update.js';
import {isJsonObject} from './utils.js';
import {isStandaloneThreadnoteBuild} from './version.js';
import {isDevelopmentBuildVersion} from './version_compare.js';

const AUTO_UPDATE_STATE_FILE = 'auto-update.json';
const AUTO_UPDATE_LOCK_FILE = '.auto-update.lock';
const AUTO_UPDATE_STATE_VERSION = 1 as const;
const FAILURE_NOTIFICATION_ATTEMPT = 3;
const AUTO_UPDATE_CHECK_INTERVAL_MILLISECONDS = 6 * 60 * 60 * 1_000;
const AUTO_UPDATE_RUNNING_STALE_MILLISECONDS = 30 * 60 * 1_000;
const AUTO_UPDATE_FAILURE_RETRY_MILLISECONDS = [15 * 60 * 1_000, 60 * 60 * 1_000, 6 * 60 * 60 * 1_000] as const;
const AUTO_UPDATE_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 60_000,
  waitTimeoutMilliseconds: 0,
} as const;
const AUTO_UPDATE_POLICY_LOCK_OPTIONS = {
  ...AUTO_UPDATE_LOCK_OPTIONS,
  waitTimeoutMilliseconds: 10_000,
} as const;

export type AutoUpdatePolicy = 'automatic' | 'notify';

export interface AutoUpdateRun {
  readonly attempt: number;
  readonly fromVersion: string;
  readonly startedAt: string;
}

export interface AutoUpdateSuccess {
  readonly completedAt: string;
  readonly fromVersion: string;
  readonly notification: SystemNotificationDelivery;
  readonly repairRequired: boolean;
  readonly toVersion: string;
}

export interface AutoUpdateFailure {
  readonly attempt: number;
  readonly failedAt: string;
  readonly fromVersion: string;
  readonly notification?: SystemNotificationDelivery;
  readonly summary: string;
}

export interface AutoUpdateState {
  readonly lastCheckAt?: string;
  readonly lastFailure?: AutoUpdateFailure;
  readonly lastSuccess?: AutoUpdateSuccess;
  readonly policy: AutoUpdatePolicy;
  readonly running?: AutoUpdateRun;
  readonly version: typeof AUTO_UPDATE_STATE_VERSION;
}

export interface AutoUpdateStatus extends AutoUpdateState {
  readonly effectivePolicy: AutoUpdatePolicy;
  readonly policySource: 'default' | 'environment' | 'file';
}

export type AutoUpdateWorkerResult = 'busy' | 'current' | 'disabled' | 'failed' | 'updated';

export const readAutoUpdateStatus = Effect.fn('autoUpdate.readStatus')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const statePath = yield* autoUpdateStatePath();
  const hasPersistedState = yield* fs.exists(statePath);
  const persisted = yield* readAutoUpdateState();
  const effective = yield* effectiveAutoUpdatePolicy(persisted);
  return {
    ...persisted,
    effectivePolicy: effective.policy,
    policySource: effective.source === 'environment' ? effective.source : hasPersistedState ? 'file' : 'default',
  } satisfies AutoUpdateStatus;
});

export const initializeAutoUpdatePolicy = Effect.fn('autoUpdate.initializePolicy')(function* (
  policy: AutoUpdatePolicy,
) {
  const fs = yield* FileSystem.FileSystem;
  const lockPath = yield* autoUpdateLockPath();
  return yield* withExclusiveFileLock(
    fs,
    lockPath,
    AUTO_UPDATE_POLICY_LOCK_OPTIONS,
    Effect.gen(function* () {
      const statePath = yield* autoUpdateStatePath();
      if (yield* fs.exists(statePath)) return yield* readAutoUpdateState();
      const state = emptyAutoUpdateState(policy);
      yield* writeAutoUpdateState(state);
      return state;
    }),
  );
});

export const setAutoUpdatePolicy = Effect.fn('autoUpdate.setPolicy')(function* (policy: AutoUpdatePolicy) {
  const fs = yield* FileSystem.FileSystem;
  const lockPath = yield* autoUpdateLockPath();
  return yield* withExclusiveFileLock(
    fs,
    lockPath,
    AUTO_UPDATE_POLICY_LOCK_OPTIONS,
    Effect.gen(function* () {
      const current = yield* readAutoUpdateState();
      const next = {
        ...current,
        policy,
        ...(policy === 'notify' ? {running: undefined} : {}),
      } satisfies AutoUpdateState;
      yield* writeAutoUpdateState(next);
      return next;
    }),
  );
});

export const runAutoUpdatePolicyCommand = Effect.fn('autoUpdate.policyCommand')(function* (
  policy: AutoUpdatePolicy,
  dryRun = false,
) {
  if (dryRun) {
    yield* Console.log(
      policy === 'automatic'
        ? 'Would enable automatic Threadnote updates.'
        : 'Would disable automatic Threadnote updates.',
    );
    return;
  }
  yield* setAutoUpdatePolicy(policy);
  yield* Console.log(
    policy === 'automatic'
      ? 'Automatic Threadnote updates are enabled. Stable installations follow stable releases; beta installations follow the beta channel.'
      : 'Automatic Threadnote updates are disabled. Threadnote will continue to report available updates.',
  );
  if (policy === 'automatic') yield* triggerAutoUpdateIfEnabled();
});

export const runAutoUpdateStatusCommand = Effect.fn('autoUpdate.statusCommand')(function* (json: boolean) {
  const status = yield* readAutoUpdateStatus();
  if (json) {
    yield* Console.log(JSON.stringify(status, null, 2));
    return;
  }
  yield* Console.log(`Automatic updates: ${status.effectivePolicy === 'automatic' ? 'enabled' : 'disabled'}`);
  yield* Console.log(`Policy source: ${status.policySource}`);
  if (status.running) {
    yield* Console.log(
      `Update in progress: v${status.running.fromVersion} · attempt ${status.running.attempt} · started ${status.running.startedAt}`,
    );
  } else if (status.lastSuccess) {
    yield* Console.log(
      `Last update: v${status.lastSuccess.fromVersion} -> v${status.lastSuccess.toVersion} · ${status.lastSuccess.completedAt}`,
    );
    yield* Console.log(`System notification: ${status.lastSuccess.notification}`);
    if (status.lastSuccess.repairRequired) yield* Console.log('Local setup repair still requires attention.');
  } else {
    yield* Console.log('No automatic update has completed yet.');
  }
  if (status.lastFailure) {
    yield* Console.log(
      `Last failure: attempt ${status.lastFailure.attempt} · ${status.lastFailure.failedAt} · ${status.lastFailure.summary}`,
    );
  }
});

export function runThreadnoteUpdateCommand(config: RuntimeConfig, options: UpdateOptions) {
  const policyMode = options.auto !== undefined;
  const statusMode = options.status === true || options.json === true;
  const updateOnlyOption = Boolean(
    options.allowUntrustedSource ||
    options.beta ||
    options.check ||
    options.force ||
    options.postUpdate === false ||
    options.repair === false ||
    options.source ||
    options.stable ||
    options.yes,
  );
  if ((policyMode && statusMode) || ((policyMode || statusMode) && updateOnlyOption)) {
    return Effect.fail(
      applicationError(
        'validate update command',
        new Error('Choose one update mode: automatic-update policy, status, or release installation.'),
      ),
    );
  }
  if (options.auto) {
    return runAutoUpdatePolicyCommand(options.auto === 'on' ? 'automatic' : 'notify', options.dryRun);
  }
  if (statusMode) return runAutoUpdateStatusCommand(options.json === true);
  return runUpdate(config, options);
}

/**
 * Runs the existing verified updater behind an install-scoped, non-waiting
 * coordinator lock. Duplicate triggers exit immediately; the owner records a
 * durable result and emits a best-effort desktop notification.
 */
export const runAutoUpdateWorker = Effect.fn('autoUpdate.runWorker')(function* (config: RuntimeConfig) {
  if (!isStandaloneThreadnoteBuild()) return 'disabled' as const;
  const fs = yield* FileSystem.FileSystem;
  const lockPath = yield* autoUpdateLockPath();
  return yield* withExclusiveFileLock(fs, lockPath, AUTO_UPDATE_LOCK_OPTIONS, runOwnedAutoUpdate(config)).pipe(
    Effect.catch(error => (error instanceof FileLockTimeout ? Effect.succeed('busy' as const) : Effect.fail(error))),
  );
});

export const triggerAutoUpdateIfEnabled = Effect.fn('autoUpdate.triggerIfEnabled')(function* () {
  if (!isStandaloneThreadnoteBuild()) return false;
  const fs = yield* FileSystem.FileSystem;
  const lockPath = yield* autoUpdateLockPath();
  const claim = yield* withExclusiveFileLock(
    fs,
    lockPath,
    AUTO_UPDATE_LOCK_OPTIONS,
    Effect.gen(function* () {
      const state = yield* readAutoUpdateState();
      const effective = yield* effectiveAutoUpdatePolicy(state);
      const now = yield* Clock.currentTimeMillis;
      const activeVersion = yield* activeInstalledVersion();
      if (
        effective.policy !== 'automatic' ||
        !activeVersion ||
        !isAutoUpdateVersionEligible(activeVersion) ||
        !isAutoUpdateDue(state, now)
      ) {
        return undefined;
      }
      const claimedAt = new Date(now).toISOString();
      yield* writeAutoUpdateState({...state, lastCheckAt: claimedAt, running: undefined});
      return {claimedAt, previousLastCheckAt: state.lastCheckAt};
    }),
  ).pipe(Effect.catch(error => (error instanceof FileLockTimeout ? Effect.succeed(undefined) : Effect.fail(error))));
  if (!claim) return false;
  const spawned = yield* spawnDetachedAutoUpdateWorker();
  if (spawned) return true;
  yield* restoreFailedSpawnClaim(claim);
  return false;
});

export const spawnDetachedAutoUpdateWorker = Effect.fn('autoUpdate.spawnWorker')(function* () {
  if (!isStandaloneThreadnoteBuild()) return false;
  const system = yield* SystemInfo;
  return yield* runDetachedCommandEffect(system.executablePath, ['auto-update-worker']);
});

/** Pure parser used by status readers and state-machine property tests. */
export function parseAutoUpdateState(value: unknown): AutoUpdateState | undefined {
  if (!isJsonObject(value) || value.version !== AUTO_UPDATE_STATE_VERSION || !isAutoUpdatePolicy(value.policy)) {
    return undefined;
  }
  const lastCheckAt = optionalTimestamp(value.lastCheckAt);
  const running = parseRunning(value.running);
  const lastSuccess = parseSuccess(value.lastSuccess);
  const lastFailure = parseFailure(value.lastFailure);
  if (
    (value.lastCheckAt !== undefined && lastCheckAt === undefined) ||
    (value.running !== undefined && running === undefined) ||
    (value.lastSuccess !== undefined && lastSuccess === undefined) ||
    (value.lastFailure !== undefined && lastFailure === undefined)
  ) {
    return undefined;
  }
  return {
    ...(lastCheckAt ? {lastCheckAt} : {}),
    ...(lastFailure ? {lastFailure} : {}),
    ...(lastSuccess ? {lastSuccess} : {}),
    policy: value.policy,
    ...(running ? {running} : {}),
    version: AUTO_UPDATE_STATE_VERSION,
  };
}

export function nextAutoUpdateAttempt(state: AutoUpdateState, fromVersion: string): number {
  return state.lastFailure?.fromVersion === fromVersion ? state.lastFailure.attempt + 1 : 1;
}

export function isAutoUpdateVersionEligible(version: string): boolean {
  return !isDevelopmentBuildVersion(version);
}

export function terminalAutoUpdateState(
  state: AutoUpdateState,
  changes: Omit<Partial<AutoUpdateState>, 'running'>,
): AutoUpdateState {
  return {...state, ...changes, running: undefined};
}

export function stateAfterFailedAutoUpdateSpawn(
  current: AutoUpdateState,
  claim: {readonly claimedAt: string; readonly previousLastCheckAt?: string},
): AutoUpdateState | undefined {
  if (current.lastCheckAt !== claim.claimedAt || current.running) return undefined;
  return {...current, lastCheckAt: claim.previousLastCheckAt, running: undefined};
}

export function isAutoUpdateDue(state: AutoUpdateState, nowMilliseconds: number): boolean {
  if (state.running) {
    return elapsedMilliseconds(state.running.startedAt, nowMilliseconds) >= AUTO_UPDATE_RUNNING_STALE_MILLISECONDS;
  }
  const lastAttemptAt = state.lastFailure?.failedAt ?? state.lastCheckAt;
  if (!lastAttemptAt) return true;
  const delay = state.lastFailure
    ? AUTO_UPDATE_FAILURE_RETRY_MILLISECONDS[
        Math.min(state.lastFailure.attempt - 1, AUTO_UPDATE_FAILURE_RETRY_MILLISECONDS.length - 1)
      ]
    : AUTO_UPDATE_CHECK_INTERVAL_MILLISECONDS;
  return elapsedMilliseconds(lastAttemptAt, nowMilliseconds) >= delay;
}

function runOwnedAutoUpdate(config: RuntimeConfig) {
  return Effect.gen(function* () {
    const state = yield* readAutoUpdateState();
    const effective = yield* effectiveAutoUpdatePolicy(state);
    if (effective.policy !== 'automatic') return 'disabled' as const;
    const fromVersion = yield* activeInstalledVersion();
    if (!fromVersion || !isAutoUpdateVersionEligible(fromVersion)) return 'disabled' as const;
    const startedAt = yield* nowIso();
    const attempt = nextAutoUpdateAttempt(state, fromVersion);
    yield* writeAutoUpdateState({
      ...state,
      lastCheckAt: startedAt,
      running: {attempt, fromVersion, startedAt},
    });

    const update = yield* Effect.exit(runUpdate(config, {yes: true}));
    const toVersion = (yield* activeInstalledVersion()) ?? fromVersion;
    if (Exit.isSuccess(update) && toVersion === fromVersion) {
      yield* writeAutoUpdateState(
        terminalAutoUpdateState(state, {
          lastCheckAt: yield* nowIso(),
          lastFailure: undefined,
          policy: state.policy,
        }),
      );
      return 'current' as const;
    }

    if (toVersion !== fromVersion) {
      const repairRequired = Exit.isFailure(update);
      const completedAt = yield* nowIso();
      const pending = {
        completedAt,
        fromVersion,
        notification: 'unavailable' as const,
        repairRequired,
        toVersion,
      } satisfies AutoUpdateSuccess;
      yield* writeAutoUpdateState(
        terminalAutoUpdateState(state, {
          lastCheckAt: completedAt,
          ...(repairRequired
            ? {
                lastFailure: {
                  attempt,
                  failedAt: completedAt,
                  fromVersion,
                  summary: failureSummary(update.cause),
                } satisfies AutoUpdateFailure,
              }
            : {lastFailure: undefined}),
          lastSuccess: pending,
          policy: state.policy,
        }),
      );
      const notification = yield* sendSystemNotification({
        body: repairRequired
          ? `Version ${toVersion} is active, but local setup repair needs attention. Run threadnote update --status.`
          : `Updated from ${fromVersion}. New CLI invocations and the next MCP request will use version ${toVersion}.`,
        title: repairRequired ? 'Threadnote updated — action required' : `Threadnote updated to v${toVersion}`,
      });
      yield* writeAutoUpdateState(
        terminalAutoUpdateState(state, {
          lastCheckAt: completedAt,
          ...(repairRequired
            ? {
                lastFailure: {
                  attempt,
                  failedAt: completedAt,
                  fromVersion,
                  summary: failureSummary(update.cause),
                } satisfies AutoUpdateFailure,
              }
            : {lastFailure: undefined}),
          lastSuccess: {...pending, notification},
          policy: state.policy,
        }),
      );
      return 'updated' as const;
    }

    if (Exit.isSuccess(update)) return 'current' as const;

    const failedAt = yield* nowIso();
    const failure = {
      attempt,
      failedAt,
      fromVersion,
      summary: failureSummary(update.cause),
    } satisfies AutoUpdateFailure;
    yield* writeAutoUpdateState(
      terminalAutoUpdateState(state, {lastCheckAt: failedAt, lastFailure: failure, policy: state.policy}),
    );
    if (attempt === FAILURE_NOTIFICATION_ATTEMPT) {
      const notification = yield* sendSystemNotification({
        body: `Your current version ${fromVersion} remains active. Run threadnote update --status for details.`,
        title: 'Threadnote could not update',
      });
      yield* writeAutoUpdateState(
        terminalAutoUpdateState(state, {
          lastCheckAt: failedAt,
          lastFailure: {...failure, notification},
          policy: state.policy,
        }),
      );
    }
    return 'failed' as const;
  });
}

function restoreFailedSpawnClaim(claim: {readonly claimedAt: string; readonly previousLastCheckAt?: string}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lockPath = yield* autoUpdateLockPath();
    yield* withExclusiveFileLock(
      fs,
      lockPath,
      AUTO_UPDATE_POLICY_LOCK_OPTIONS,
      Effect.gen(function* () {
        const current = yield* readAutoUpdateState();
        const restored = stateAfterFailedAutoUpdateSpawn(current, claim);
        if (restored) yield* writeAutoUpdateState(restored);
      }),
    );
  }).pipe(Effect.ignore);
}

const readAutoUpdateState = Effect.fn('autoUpdate.readState')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const statePath = yield* autoUpdateStatePath();
  const raw = yield* fs.readFileString(statePath).pipe(Effect.option);
  if (raw._tag === 'None') return emptyAutoUpdateState('notify');
  const decoded = Result.try((): unknown => JSON.parse(raw.value));
  return Result.isSuccess(decoded)
    ? (parseAutoUpdateState(decoded.success) ?? emptyAutoUpdateState('notify'))
    : emptyAutoUpdateState('notify');
});

const writeAutoUpdateState = Effect.fn('autoUpdate.writeState')(function* (state: AutoUpdateState) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const target = yield* autoUpdateStatePath();
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${yield* crypto.randomUUIDv4}.tmp`);
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, `${JSON.stringify(state, null, 2)}\n`, {flag: 'wx', mode: 0o600});
    yield* syncWritableFile(fs, temporary);
    yield* fs.rename(temporary, target);
    yield* syncDirectoryBestEffort(fs, directory);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.catch(() => Effect.void))));
});

const autoUpdateStatePath = Effect.fn('autoUpdate.statePath')(function* () {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  return path.join(installationRoot(path, system), AUTO_UPDATE_STATE_FILE);
});

const autoUpdateLockPath = Effect.fn('autoUpdate.lockPath')(function* () {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  return path.join(installationRoot(path, system), AUTO_UPDATE_LOCK_FILE);
});

const effectiveAutoUpdatePolicy = Effect.fn('autoUpdate.effectivePolicy')(function* (state: AutoUpdateState) {
  const environment = (yield* SystemInfo).environment();
  if (
    environment.CI !== undefined ||
    environment.NO_UPDATE_NOTIFIER !== undefined ||
    environment.THREADNOTE_NO_UPDATE_CHECK !== undefined
  ) {
    return {policy: 'notify' as const, source: 'environment' as const};
  }
  const override = environment.THREADNOTE_AUTO_UPDATE?.trim().toLowerCase();
  if (override === '1' || override === 'true' || override === 'yes' || override === 'on') {
    return {policy: 'automatic' as const, source: 'environment' as const};
  }
  if (override === '0' || override === 'false' || override === 'no' || override === 'off') {
    return {policy: 'notify' as const, source: 'environment' as const};
  }
  return {policy: state.policy, source: 'file' as const};
});

const nowIso = Effect.fn('autoUpdate.nowIso')(function* () {
  return new Date(yield* Clock.currentTimeMillis).toISOString();
});

function emptyAutoUpdateState(policy: AutoUpdatePolicy): AutoUpdateState {
  return {policy, version: AUTO_UPDATE_STATE_VERSION};
}

function failureSummary(cause: Cause.Cause<unknown>): string {
  return redactSensitiveText(Cause.pretty(cause)).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function isAutoUpdatePolicy(value: unknown): value is AutoUpdatePolicy {
  return value === 'automatic' || value === 'notify';
}

function optionalTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function versionString(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function elapsedMilliseconds(timestamp: string, nowMilliseconds: number): number {
  return Math.max(0, nowMilliseconds - Date.parse(timestamp));
}

function parseRunning(value: unknown): AutoUpdateRun | undefined {
  if (!isJsonObject(value)) return undefined;
  const attempt = positiveInteger(value.attempt);
  const fromVersion = versionString(value.fromVersion);
  const startedAt = optionalTimestamp(value.startedAt);
  return attempt && fromVersion && startedAt ? {attempt, fromVersion, startedAt} : undefined;
}

function parseSuccess(value: unknown): AutoUpdateSuccess | undefined {
  if (!isJsonObject(value)) return undefined;
  const completedAt = optionalTimestamp(value.completedAt);
  const fromVersion = versionString(value.fromVersion);
  const toVersion = versionString(value.toVersion);
  const notification = notificationDelivery(value.notification);
  return completedAt && fromVersion && toVersion && notification && typeof value.repairRequired === 'boolean'
    ? {completedAt, fromVersion, notification, repairRequired: value.repairRequired, toVersion}
    : undefined;
}

function parseFailure(value: unknown): AutoUpdateFailure | undefined {
  if (!isJsonObject(value)) return undefined;
  const attempt = positiveInteger(value.attempt);
  const failedAt = optionalTimestamp(value.failedAt);
  const fromVersion = versionString(value.fromVersion);
  const notification = value.notification === undefined ? undefined : notificationDelivery(value.notification);
  return attempt &&
    failedAt &&
    fromVersion &&
    typeof value.summary === 'string' &&
    value.summary.length <= 500 &&
    (value.notification === undefined || notification !== undefined)
    ? {
        attempt,
        failedAt,
        fromVersion,
        ...(notification ? {notification} : {}),
        summary: value.summary,
      }
    : undefined;
}

function notificationDelivery(value: unknown): SystemNotificationDelivery | undefined {
  return value === 'failed' || value === 'sent' || value === 'unavailable' ? value : undefined;
}
