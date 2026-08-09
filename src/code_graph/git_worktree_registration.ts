import {Effect, FileSystem, Option, Path} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {CommandTimedOut, runBinaryCommandEffect} from '../effect/command.js';
import {
  platformPathFor,
  runtimeDirectoryNamePage,
  runtimeLstat,
  runtimePlatform,
  SystemInfo,
  type RuntimeBigIntStats,
  type SystemInfoShape,
} from '../effect/system.js';
import {CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT} from '../worker_protocol.js';
import type {RepositoryIdentity} from './types.js';

const PROTOCOL_VERSION = 1 as const;
const BATCH_PROTOCOL_VERSION = 2 as const;
const AUTHORITY_PROTOCOL_VERSION = 3 as const;
const HASH_ID = /^[0-9a-f]{64}$/;
const UTF8 = new TextEncoder();

export const CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS = {
  gitDirectoryOutputBytes: 16 * 1_024,
  gitDirectoryTimeoutMilliseconds: 10_000,
  maxAdminNameBytes: 4_096,
  maxAdminNames: 4_096,
  maxBatchTargets: 32,
  maxRegistryNameBytes: 8 * 1_048_576,
  batchWorkerInputBytes: 64 * 1_024,
  workerInputBytes: 16 * 1_024,
  authorityWorkerInputBytes: 1 * 1_048_576,
  workerOutputBytes: 4 * 1_024,
  workerTimeoutMilliseconds: 2_000,
} as const;

export type CodeGraphGitWorktreeRegistration =
  {readonly kind: 'main'} | {readonly adminNameKeys: readonly string[]; readonly kind: 'linked'};

export type CodeGraphGitWorktreeRegistryObservation =
  | {
      readonly contentDigest: string;
      readonly entryCount: number;
      readonly registryRootIdentity: string;
      readonly registryRootKind: 'directory' | 'missing';
      readonly state: 'absent' | 'present';
    }
  | {
      readonly reason: 'ambiguous' | 'invalid' | 'timeout' | 'unavailable';
      readonly state: 'unknown';
    };

export type CodeGraphGitWorktreeRegistryBatchObservation =
  | {
      readonly contentDigest: string;
      readonly entryCount: number;
      readonly registryRootIdentity: string;
      readonly registryRootKind: 'directory' | 'missing';
      readonly states: readonly ('absent' | 'present')[];
      readonly state: 'complete';
    }
  | {
      readonly reason: 'ambiguous' | 'invalid' | 'timeout' | 'unavailable';
      readonly state: 'unknown';
    };

export interface CodeGraphGitWorktreeRegistryRequest {
  readonly adminNameKeys: readonly string[];
  readonly checkoutId: string;
  readonly gitCommonDirectory: string;
  readonly protocol: typeof PROTOCOL_VERSION;
}

export interface CodeGraphGitWorktreeRegistryBatchRequest {
  readonly adminNameKeySets: readonly (readonly string[])[];
  readonly checkoutId: string;
  readonly gitCommonDirectory: string;
  readonly protocol: typeof BATCH_PROTOCOL_VERSION;
}

export interface CodeGraphRecordedWorktreePathBatchRequest {
  readonly canonicalWorktreePaths: readonly string[];
  readonly kind: 'paths';
  readonly protocol: typeof AUTHORITY_PROTOCOL_VERSION;
}

export interface CodeGraphWorktreeReconciliationAuthorityTarget {
  readonly adminNameKeys: readonly string[];
  readonly canonicalWorktreePath: string;
  readonly evidenceToken: string;
}

export interface CodeGraphWorktreeReconciliationAuthorityRequest {
  readonly checkoutId: string;
  readonly gitCommonDirectory: string;
  readonly kind: 'reconciliation-authority';
  readonly protocol: typeof AUTHORITY_PROTOCOL_VERSION;
  readonly targets: readonly CodeGraphWorktreeReconciliationAuthorityTarget[];
}

export type CodeGraphWorktreeAuthorityWorkerRequest =
  CodeGraphRecordedWorktreePathBatchRequest | CodeGraphWorktreeReconciliationAuthorityRequest;

export type CodeGraphRecordedWorktreePathBatchObservation =
  | {readonly pathStates: readonly ('missing' | 'present')[]; readonly state: 'complete'}
  | {readonly reason: 'invalid' | 'timeout' | 'unavailable'; readonly state: 'unknown'};

export type CodeGraphWorktreeReconciliationAuthorityObservation =
  | {
      readonly contentDigest: string;
      readonly entryCount: number;
      readonly pathStates: readonly ('missing' | 'present')[];
      readonly registryRootIdentity: string;
      readonly registryRootKind: 'directory' | 'missing';
      readonly registryStates: readonly ('absent' | 'present')[];
      readonly state: 'complete';
    }
  | {
      readonly reason: 'ambiguous' | 'invalid' | 'timeout' | 'unavailable';
      readonly state: 'unknown';
    };

export interface ObserveCodeGraphGitWorktreeRegistryOptions {
  readonly timeoutMilliseconds?: number;
}

export class CodeGraphGitWorktreeRegistrationError extends Error {
  override readonly name = 'CodeGraphGitWorktreeRegistrationError';

  constructor() {
    super('Unable to verify the Git worktree registration.');
  }
}

/**
 * Capture the current worktree's administrative registration while that worktree is live.
 * Only opaque, checkout-bound hashes of a linked worktree's admin child are returned.
 */
export const captureCodeGraphGitWorktreeRegistration = Effect.fn('codeGraph.captureGitWorktreeRegistration')(function* (
  identity: RepositoryIdentity,
  observedGitDirectory?: string,
) {
  if (!HASH_ID.test(identity.checkoutId)) return yield* Effect.fail(new CodeGraphGitWorktreeRegistrationError());
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rawGitDirectory =
    observedGitDirectory ??
    parseBoundedGitDirectoryOutput(
      (yield* runBinaryCommandEffect(
        'git',
        ['-C', identity.repoRoot, 'rev-parse', '--path-format=absolute', '--git-dir'],
        {
          maxOutputBytes: CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.gitDirectoryOutputBytes,
          timeoutMs: CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.gitDirectoryTimeoutMilliseconds,
        },
      ).pipe(Effect.mapError(() => new CodeGraphGitWorktreeRegistrationError()))).stdout,
    );
  if (rawGitDirectory === undefined || !path.isAbsolute(rawGitDirectory)) {
    return yield* Effect.fail(new CodeGraphGitWorktreeRegistrationError());
  }

  const registration = yield* Effect.gen(function* () {
    const commonDirectory = yield* inspectCanonicalDirectory(fs, identity.gitCommonDirectory);
    const gitDirectory = yield* inspectCanonicalDirectory(fs, rawGitDirectory);
    if (gitDirectory === commonDirectory) return {kind: 'main'} as const;

    const registryRoot = yield* inspectCanonicalDirectory(fs, path.join(commonDirectory, 'worktrees'));
    if (path.dirname(gitDirectory) !== registryRoot) {
      return yield* Effect.fail(new CodeGraphGitWorktreeRegistrationError());
    }
    const adminName = path.basename(gitDirectory);
    const adminNameBytes = UTF8.encode(adminName);
    if (
      adminName.length === 0 ||
      adminNameBytes.byteLength > CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxAdminNameBytes ||
      adminName.includes('\0') ||
      adminName.includes('\r') ||
      adminName.includes('\n')
    ) {
      return yield* Effect.fail(new CodeGraphGitWorktreeRegistrationError());
    }
    const adminNameKeys = codeGraphGitWorktreeAdminNameKeys(identity.checkoutId, adminNameBytes);
    if (!validAdminNameKeys(adminNameKeys)) {
      return yield* Effect.fail(new CodeGraphGitWorktreeRegistrationError());
    }
    return {adminNameKeys, kind: 'linked'} as const;
  }).pipe(Effect.mapError(() => new CodeGraphGitWorktreeRegistrationError()));
  return registration;
});

/**
 * Observe one linked admin registration in a hard-deadline child. The path is sent over stdin,
 * never argv, and neither successful nor failed results contain paths or raw admin names.
 */
export const observeCodeGraphGitWorktreeRegistry = Effect.fn('codeGraph.observeGitWorktreeRegistry')(function* (
  identity: Pick<RepositoryIdentity, 'checkoutId' | 'gitCommonDirectory'>,
  registration: CodeGraphGitWorktreeRegistration,
  options: ObserveCodeGraphGitWorktreeRegistryOptions = {},
) {
  if (registration.kind !== 'linked' || !validAdminNameKeys(registration.adminNameKeys)) {
    return {reason: 'invalid', state: 'unknown'} satisfies CodeGraphGitWorktreeRegistryObservation;
  }
  const system = yield* SystemInfo;
  const request = {
    adminNameKeys: registration.adminNameKeys,
    checkoutId: identity.checkoutId,
    gitCommonDirectory: identity.gitCommonDirectory,
    protocol: PROTOCOL_VERSION,
  } satisfies CodeGraphGitWorktreeRegistryRequest;
  if (!validWorkerRequest(request)) {
    return {reason: 'invalid', state: 'unknown'} satisfies CodeGraphGitWorktreeRegistryObservation;
  }
  const timeoutMilliseconds = boundedWorkerTimeout(options.timeoutMilliseconds);
  const spawn = gitWorktreeRegistrationWorkerSpawnPlan(system);
  const input = UTF8.encode(`${JSON.stringify(request)}\n`);
  const completed = yield* runBinaryCommandEffect(spawn.executable, spawn.arguments, {
    env: spawn.environment,
    input,
    maxOutputBytes: CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.workerOutputBytes,
    timeoutMs: timeoutMilliseconds,
  }).pipe(
    Effect.map(result => parseWorkerResponse(result.stdout)),
    Effect.catch(error =>
      Effect.succeed({
        reason: error instanceof CommandTimedOut ? 'timeout' : 'unavailable',
        state: 'unknown',
      } as const satisfies CodeGraphGitWorktreeRegistryObservation),
    ),
    Effect.timeoutOrElse({
      duration: timeoutMilliseconds,
      orElse: () =>
        Effect.succeed({
          reason: 'timeout',
          state: 'unknown',
        } as const satisfies CodeGraphGitWorktreeRegistryObservation),
    }),
  );
  return completed;
});

/** Observe up to one reconciliation page with one bounded worker/registry scan. */
export const observeCodeGraphGitWorktreeRegistryBatch = Effect.fn('codeGraph.observeGitWorktreeRegistryBatch')(
  function* (
    identity: Pick<RepositoryIdentity, 'checkoutId' | 'gitCommonDirectory'>,
    registrations: readonly CodeGraphGitWorktreeRegistration[],
    options: ObserveCodeGraphGitWorktreeRegistryOptions = {},
  ) {
    if (
      registrations.length === 0 ||
      registrations.length > CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxBatchTargets ||
      registrations.some(registration => registration.kind !== 'linked')
    ) {
      return {reason: 'invalid', state: 'unknown'} satisfies CodeGraphGitWorktreeRegistryBatchObservation;
    }
    const adminNameKeySets = registrations.map(registration =>
      registration.kind === 'linked' ? registration.adminNameKeys : [],
    );
    const request = {
      adminNameKeySets,
      checkoutId: identity.checkoutId,
      gitCommonDirectory: identity.gitCommonDirectory,
      protocol: BATCH_PROTOCOL_VERSION,
    } satisfies CodeGraphGitWorktreeRegistryBatchRequest;
    if (!validBatchWorkerRequest(request)) {
      return {reason: 'invalid', state: 'unknown'} satisfies CodeGraphGitWorktreeRegistryBatchObservation;
    }
    const system = yield* SystemInfo;
    const timeoutMilliseconds = boundedWorkerTimeout(options.timeoutMilliseconds);
    const spawn = gitWorktreeRegistrationWorkerSpawnPlan(system);
    const input = UTF8.encode(`${JSON.stringify(request)}\n`);
    return yield* runBinaryCommandEffect(spawn.executable, spawn.arguments, {
      env: spawn.environment,
      input,
      maxOutputBytes: CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.workerOutputBytes,
      timeoutMs: timeoutMilliseconds,
    }).pipe(
      Effect.map(result => parseBatchWorkerResponse(result.stdout, registrations.length)),
      Effect.catch(error =>
        Effect.succeed({
          reason: error instanceof CommandTimedOut ? 'timeout' : 'unavailable',
          state: 'unknown',
        } as const satisfies CodeGraphGitWorktreeRegistryBatchObservation),
      ),
      Effect.timeoutOrElse({
        duration: timeoutMilliseconds,
        orElse: () =>
          Effect.succeed({
            reason: 'timeout',
            state: 'unknown',
          } as const satisfies CodeGraphGitWorktreeRegistryBatchObservation),
      }),
    );
  },
);

/** Observe remembered paths in a killable one-shot worker; only direct lstat ENOENT is missing. */
export const observeCodeGraphRecordedWorktreePaths = Effect.fn('codeGraph.observeRecordedWorktreePaths')(function* (
  canonicalWorktreePaths: readonly string[],
  options: ObserveCodeGraphGitWorktreeRegistryOptions = {},
) {
  const request = {
    canonicalWorktreePaths,
    kind: 'paths',
    protocol: AUTHORITY_PROTOCOL_VERSION,
  } satisfies CodeGraphRecordedWorktreePathBatchRequest;
  if (!validAuthorityWorkerRequest(request)) {
    return {reason: 'invalid', state: 'unknown'} satisfies CodeGraphRecordedWorktreePathBatchObservation;
  }
  const system = yield* SystemInfo;
  const timeoutMilliseconds = boundedWorkerTimeout(options.timeoutMilliseconds);
  const spawn = gitWorktreeRegistrationWorkerSpawnPlan(system);
  const input = UTF8.encode(`${JSON.stringify(request)}\n`);
  return yield* runBinaryCommandEffect(spawn.executable, spawn.arguments, {
    env: spawn.environment,
    input,
    maxOutputBytes: CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.workerOutputBytes,
    timeoutMs: timeoutMilliseconds,
  }).pipe(
    Effect.map(result => parsePathBatchWorkerResponse(result.stdout, canonicalWorktreePaths.length)),
    Effect.catch(error =>
      Effect.succeed({
        reason: error instanceof CommandTimedOut ? 'timeout' : 'unavailable',
        state: 'unknown',
      } as const satisfies CodeGraphRecordedWorktreePathBatchObservation),
    ),
  );
});

/** Combine up to one page of direct path observations with one stable registry scan. */
export const observeCodeGraphWorktreeReconciliationAuthority = Effect.fn(
  'codeGraph.observeWorktreeReconciliationAuthority',
)(function* (
  identity: Pick<RepositoryIdentity, 'checkoutId' | 'gitCommonDirectory'>,
  targets: readonly CodeGraphWorktreeReconciliationAuthorityTarget[],
  options: ObserveCodeGraphGitWorktreeRegistryOptions = {},
) {
  const request = {
    checkoutId: identity.checkoutId,
    gitCommonDirectory: identity.gitCommonDirectory,
    kind: 'reconciliation-authority',
    protocol: AUTHORITY_PROTOCOL_VERSION,
    targets,
  } satisfies CodeGraphWorktreeReconciliationAuthorityRequest;
  if (!validAuthorityWorkerRequest(request)) {
    return {reason: 'invalid', state: 'unknown'} satisfies CodeGraphWorktreeReconciliationAuthorityObservation;
  }
  const system = yield* SystemInfo;
  const timeoutMilliseconds = boundedWorkerTimeout(options.timeoutMilliseconds);
  const spawn = gitWorktreeRegistrationWorkerSpawnPlan(system);
  const input = UTF8.encode(`${JSON.stringify(request)}\n`);
  return yield* runBinaryCommandEffect(spawn.executable, spawn.arguments, {
    env: spawn.environment,
    input,
    maxOutputBytes: CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.workerOutputBytes,
    timeoutMs: timeoutMilliseconds,
  }).pipe(
    Effect.map(result => parseAuthorityWorkerResponse(result.stdout, targets.length)),
    Effect.catch(error =>
      Effect.succeed({
        reason: error instanceof CommandTimedOut ? 'timeout' : 'unavailable',
        state: 'unknown',
      } as const satisfies CodeGraphWorktreeReconciliationAuthorityObservation),
    ),
  );
});

/** Worker-side protocol-v3 observation. */
export async function scanCodeGraphWorktreeAuthorityWorkerRequest(
  request: CodeGraphWorktreeAuthorityWorkerRequest,
): Promise<CodeGraphRecordedWorktreePathBatchObservation | CodeGraphWorktreeReconciliationAuthorityObservation> {
  if (!validAuthorityWorkerRequest(request)) return {reason: 'invalid', state: 'unknown'};
  const paths =
    request.kind === 'paths'
      ? request.canonicalWorktreePaths
      : request.targets.map(target => target.canonicalWorktreePath);
  const pathStates: ('missing' | 'present')[] = [];
  for (const path of paths) {
    const state = await directWorktreePathState(path);
    if (state === 'unknown') return {reason: 'unavailable', state: 'unknown'};
    pathStates.push(state);
  }
  if (request.kind === 'paths') return {pathStates, state: 'complete'};
  const registry = await scanCodeGraphGitWorktreeRegistryTargetSets(
    request.checkoutId,
    request.gitCommonDirectory,
    request.targets.map(target => target.adminNameKeys),
  );
  if (registry.state === 'unknown') return registry;
  return {
    contentDigest: registry.contentDigest,
    entryCount: registry.entryCount,
    pathStates,
    registryRootIdentity: registry.registryRootIdentity,
    registryRootKind: registry.registryRootKind,
    registryStates: registry.states,
    state: 'complete',
  };
}

/** Worker-side bounded observation. Exported for deterministic filesystem and property tests. */
export async function scanCodeGraphGitWorktreeRegistry(
  request: CodeGraphGitWorktreeRegistryRequest,
): Promise<CodeGraphGitWorktreeRegistryObservation> {
  if (!validWorkerRequest(request)) return {reason: 'invalid', state: 'unknown'};
  const observation = await scanCodeGraphGitWorktreeRegistryTargetSets(request.checkoutId, request.gitCommonDirectory, [
    request.adminNameKeys,
  ]);
  if (observation.state === 'unknown') return observation;
  return {
    contentDigest: observation.contentDigest,
    entryCount: observation.entryCount,
    registryRootIdentity: observation.registryRootIdentity,
    registryRootKind: observation.registryRootKind,
    state: observation.states[0]!,
  };
}

/** Worker-side bounded batch observation. Exported for deterministic tests. */
export async function scanCodeGraphGitWorktreeRegistryBatch(
  request: CodeGraphGitWorktreeRegistryBatchRequest,
): Promise<CodeGraphGitWorktreeRegistryBatchObservation> {
  if (!validBatchWorkerRequest(request)) return {reason: 'invalid', state: 'unknown'};
  return await scanCodeGraphGitWorktreeRegistryTargetSets(
    request.checkoutId,
    request.gitCommonDirectory,
    request.adminNameKeySets,
  );
}

async function scanCodeGraphGitWorktreeRegistryTargetSets(
  checkoutId: string,
  gitCommonDirectory: string,
  adminNameKeySets: readonly (readonly string[])[],
): Promise<CodeGraphGitWorktreeRegistryBatchObservation> {
  try {
    const path = platformPathFor(runtimePlatform);
    const commonBefore = await lstatStableDirectory(gitCommonDirectory);
    const registryRoot = path.join(gitCommonDirectory, 'worktrees');
    let rootBefore: RuntimeBigIntStats;
    try {
      rootBefore = await runtimeLstat(registryRoot);
    } catch (cause) {
      if (!isNotFound(cause)) return {reason: 'unavailable', state: 'unknown'};
      const commonAfter = await lstatStableDirectory(gitCommonDirectory);
      if (!sameStableStats(commonBefore, commonAfter)) return {reason: 'ambiguous', state: 'unknown'};
      return {
        contentDigest: hashParts('threadnote-git-worktree-registry-empty-v1', [checkoutId]),
        entryCount: 0,
        registryRootIdentity: statsIdentity('missing', checkoutId, commonBefore),
        registryRootKind: 'missing',
        states: adminNameKeySets.map(() => 'absent'),
        state: 'complete',
      };
    }
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
      return {reason: 'ambiguous', state: 'unknown'};
    }

    const exactEntryKeys: string[] = [];
    let entryCount = 0;
    let totalNameBytes = 0;
    const targetPresence = adminNameKeySets.map(() => false);
    const targetIndexesByKey = new Map<string, number[]>();
    for (const [index, keys] of adminNameKeySets.entries()) {
      for (const key of keys) targetIndexesByKey.set(key, [...(targetIndexesByKey.get(key) ?? []), index]);
    }
    const entries = await runtimeDirectoryNamePage(
      registryRoot,
      CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxAdminNames,
    );
    if (entries.overflow) return {reason: 'ambiguous', state: 'unknown'};
    for (const nameBytes of entries.names) {
      entryCount += 1;
      totalNameBytes += nameBytes.byteLength;
      if (
        entryCount > CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxAdminNames ||
        nameBytes.byteLength === 0 ||
        nameBytes.byteLength > CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxAdminNameBytes ||
        totalNameBytes > CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxRegistryNameBytes
      ) {
        return {reason: 'ambiguous', state: 'unknown'};
      }
      const keys = codeGraphGitWorktreeAdminNameKeys(checkoutId, nameBytes);
      exactEntryKeys.push(keys[0]!);
      for (const key of keys) {
        for (const index of targetIndexesByKey.get(key) ?? []) targetPresence[index] = true;
      }
    }

    const [rootAfter, commonAfter] = await Promise.all([
      runtimeLstat(registryRoot),
      lstatStableDirectory(gitCommonDirectory),
    ]);
    if (!sameStableStats(rootBefore, rootAfter) || !sameStableStats(commonBefore, commonAfter)) {
      return {reason: 'ambiguous', state: 'unknown'};
    }
    exactEntryKeys.sort();
    return {
      contentDigest: hashParts('threadnote-git-worktree-registry-content-v1', [checkoutId, ...exactEntryKeys]),
      entryCount,
      registryRootIdentity: statsIdentity('directory', checkoutId, rootBefore),
      registryRootKind: 'directory',
      states: targetPresence.map(present => (present ? 'present' : 'absent')),
      state: 'complete',
    };
  } catch {
    return {reason: 'unavailable', state: 'unknown'};
  }
}

export function codeGraphGitWorktreeAdminNameKeys(
  checkoutId: string,
  adminName: string | Uint8Array,
): readonly string[] {
  if (!HASH_ID.test(checkoutId)) return [];
  const bytes = typeof adminName === 'string' ? UTF8.encode(adminName) : adminName;
  if (bytes.byteLength === 0 || bytes.byteLength > CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxAdminNameBytes) {
    return [];
  }
  const keys = [hashBytes('threadnote-git-worktree-admin-exact-v1', checkoutId, bytes)];
  try {
    const decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
    const folded = UTF8.encode(decoded.normalize('NFC').toLowerCase());
    keys.push(hashBytes('threadnote-git-worktree-admin-folded-v1', checkoutId, folded));
  } catch {
    // Exact raw-byte matching remains available for POSIX names that are not UTF-8.
  }
  return [...new Set(keys)].sort();
}

export function parseBoundedGitDirectoryOutput(output: Uint8Array): string | undefined {
  if (
    output.byteLength === 0 ||
    output.byteLength > CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.gitDirectoryOutputBytes
  ) {
    return undefined;
  }
  try {
    const decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(output);
    if (!decoded.endsWith('\n')) return undefined;
    const value = decoded.slice(0, -1);
    if (!value || value.includes('\0') || value.includes('\r') || value.includes('\n')) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function parseCodeGraphGitWorktreeRegistration(value: unknown): CodeGraphGitWorktreeRegistration | undefined {
  if (!isRecord(value) || (value.kind !== 'main' && value.kind !== 'linked')) return undefined;
  if (value.kind === 'main') return {kind: 'main'};
  if (!validAdminNameKeys(value.adminNameKeys)) return undefined;
  return {adminNameKeys: [...value.adminNameKeys], kind: 'linked'};
}

export function sameCodeGraphGitWorktreeRegistration(
  left: CodeGraphGitWorktreeRegistration,
  right: CodeGraphGitWorktreeRegistration,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'main' ||
      (right.kind === 'linked' &&
        left.adminNameKeys.length === right.adminNameKeys.length &&
        left.adminNameKeys.every((key, index) => key === right.adminNameKeys[index])))
  );
}

function validWorkerRequest(value: unknown): value is CodeGraphGitWorktreeRegistryRequest {
  if (!isRecord(value)) return false;
  return (
    value.protocol === PROTOCOL_VERSION &&
    typeof value.checkoutId === 'string' &&
    HASH_ID.test(value.checkoutId) &&
    isSafeAbsolutePath(value.gitCommonDirectory) &&
    validAdminNameKeys(value.adminNameKeys) &&
    UTF8.encode(`${JSON.stringify(value)}\n`).byteLength <= CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.workerInputBytes
  );
}

export function validCodeGraphWorktreeAuthorityWorkerRequest(
  value: unknown,
): value is CodeGraphWorktreeAuthorityWorkerRequest {
  return validAuthorityWorkerRequest(value);
}

function validAuthorityWorkerRequest(value: unknown): value is CodeGraphWorktreeAuthorityWorkerRequest {
  if (!isRecord(value) || value.protocol !== AUTHORITY_PROTOCOL_VERSION) return false;
  const validPaths = (paths: unknown): paths is readonly string[] =>
    Array.isArray(paths) &&
    paths.length >= 1 &&
    paths.length <= CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxBatchTargets &&
    paths.every(isSafeAbsolutePath);
  const valid =
    value.kind === 'paths'
      ? validPaths(value.canonicalWorktreePaths)
      : value.kind === 'reconciliation-authority' &&
        typeof value.checkoutId === 'string' &&
        HASH_ID.test(value.checkoutId) &&
        isSafeAbsolutePath(value.gitCommonDirectory) &&
        Array.isArray(value.targets) &&
        value.targets.length >= 1 &&
        value.targets.length <= CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxBatchTargets &&
        value.targets.every(
          target =>
            isRecord(target) &&
            isHash(target.evidenceToken) &&
            isSafeAbsolutePath(target.canonicalWorktreePath) &&
            validAdminNameKeys(target.adminNameKeys),
        );
  return (
    valid &&
    UTF8.encode(`${JSON.stringify(value)}\n`).byteLength <=
      CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.authorityWorkerInputBytes
  );
}

export function validCodeGraphGitWorktreeRegistryBatchRequest(
  value: unknown,
): value is CodeGraphGitWorktreeRegistryBatchRequest {
  return validBatchWorkerRequest(value);
}

function validBatchWorkerRequest(value: unknown): value is CodeGraphGitWorktreeRegistryBatchRequest {
  if (!isRecord(value)) return false;
  return (
    value.protocol === BATCH_PROTOCOL_VERSION &&
    typeof value.checkoutId === 'string' &&
    HASH_ID.test(value.checkoutId) &&
    isSafeAbsolutePath(value.gitCommonDirectory) &&
    Array.isArray(value.adminNameKeySets) &&
    value.adminNameKeySets.length >= 1 &&
    value.adminNameKeySets.length <= CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxBatchTargets &&
    value.adminNameKeySets.every(validAdminNameKeys) &&
    UTF8.encode(`${JSON.stringify(value)}\n`).byteLength <=
      CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.batchWorkerInputBytes
  );
}

function validAdminNameKeys(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 4 &&
    value.every(key => typeof key === 'string' && HASH_ID.test(key)) &&
    new Set(value).size === value.length &&
    value.every((key, index) => index === 0 || value[index - 1]! < key)
  );
}

function parseWorkerResponse(output: Uint8Array): CodeGraphGitWorktreeRegistryObservation {
  try {
    const decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(output);
    if (!decoded.endsWith('\n') || decoded.slice(0, -1).includes('\n')) {
      return {reason: 'unavailable', state: 'unknown'};
    }
    const value: unknown = JSON.parse(decoded.slice(0, -1));
    if (!isRecord(value)) return {reason: 'unavailable', state: 'unknown'};
    if (value.state === 'unknown') {
      return value.reason === 'ambiguous' || value.reason === 'invalid' || value.reason === 'unavailable'
        ? {reason: value.reason, state: 'unknown'}
        : {reason: 'unavailable', state: 'unknown'};
    }
    if (
      (value.state !== 'absent' && value.state !== 'present') ||
      (value.registryRootKind !== 'directory' && value.registryRootKind !== 'missing') ||
      !isHash(value.registryRootIdentity) ||
      !isHash(value.contentDigest) ||
      !Number.isSafeInteger(value.entryCount) ||
      Number(value.entryCount) < 0 ||
      Number(value.entryCount) > CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxAdminNames
    ) {
      return {reason: 'unavailable', state: 'unknown'};
    }
    return {
      contentDigest: value.contentDigest,
      entryCount: Number(value.entryCount),
      registryRootIdentity: value.registryRootIdentity,
      registryRootKind: value.registryRootKind,
      state: value.state,
    };
  } catch {
    return {reason: 'unavailable', state: 'unknown'};
  }
}

function parseBatchWorkerResponse(
  output: Uint8Array,
  targetCount: number,
): CodeGraphGitWorktreeRegistryBatchObservation {
  try {
    const decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(output);
    if (!decoded.endsWith('\n') || decoded.slice(0, -1).includes('\n')) {
      return {reason: 'unavailable', state: 'unknown'};
    }
    const value: unknown = JSON.parse(decoded.slice(0, -1));
    if (!isRecord(value)) return {reason: 'unavailable', state: 'unknown'};
    if (value.state === 'unknown') {
      return value.reason === 'ambiguous' || value.reason === 'invalid' || value.reason === 'unavailable'
        ? {reason: value.reason, state: 'unknown'}
        : {reason: 'unavailable', state: 'unknown'};
    }
    if (
      value.state !== 'complete' ||
      (value.registryRootKind !== 'directory' && value.registryRootKind !== 'missing') ||
      !isHash(value.registryRootIdentity) ||
      !isHash(value.contentDigest) ||
      !Number.isSafeInteger(value.entryCount) ||
      Number(value.entryCount) < 0 ||
      Number(value.entryCount) > CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxAdminNames ||
      !Array.isArray(value.states) ||
      value.states.length !== targetCount ||
      value.states.some(state => state !== 'absent' && state !== 'present')
    ) {
      return {reason: 'unavailable', state: 'unknown'};
    }
    return {
      contentDigest: value.contentDigest,
      entryCount: Number(value.entryCount),
      registryRootIdentity: value.registryRootIdentity,
      registryRootKind: value.registryRootKind,
      states: [...value.states] as readonly ('absent' | 'present')[],
      state: 'complete',
    };
  } catch {
    return {reason: 'unavailable', state: 'unknown'};
  }
}

/** @internal Strict protocol-v3 parser retained for malformed-boundary tests. */
export function parseCodeGraphRecordedWorktreePathBatchResponse(
  output: Uint8Array,
  targetCount: number,
): CodeGraphRecordedWorktreePathBatchObservation {
  return parsePathBatchWorkerResponse(output, targetCount);
}

function parsePathBatchWorkerResponse(
  output: Uint8Array,
  targetCount: number,
): CodeGraphRecordedWorktreePathBatchObservation {
  const value = parseWorkerJson(output);
  if (value === undefined) return {reason: 'unavailable', state: 'unknown'};
  if (value.state === 'unknown') {
    return hasExactKeys(value, ['reason', 'state']) && (value.reason === 'invalid' || value.reason === 'unavailable')
      ? {reason: value.reason, state: 'unknown'}
      : {reason: 'unavailable', state: 'unknown'};
  }
  if (
    !hasExactKeys(value, ['pathStates', 'state']) ||
    value.state !== 'complete' ||
    !Array.isArray(value.pathStates) ||
    value.pathStates.length !== targetCount ||
    value.pathStates.some(state => state !== 'missing' && state !== 'present')
  ) {
    return {reason: 'unavailable', state: 'unknown'};
  }
  return {pathStates: [...value.pathStates] as readonly ('missing' | 'present')[], state: 'complete'};
}

/** @internal Strict protocol-v3 parser retained for malformed-boundary tests. */
export function parseCodeGraphWorktreeReconciliationAuthorityResponse(
  output: Uint8Array,
  targetCount: number,
): CodeGraphWorktreeReconciliationAuthorityObservation {
  return parseAuthorityWorkerResponse(output, targetCount);
}

function parseAuthorityWorkerResponse(
  output: Uint8Array,
  targetCount: number,
): CodeGraphWorktreeReconciliationAuthorityObservation {
  const value = parseWorkerJson(output);
  if (value === undefined) return {reason: 'unavailable', state: 'unknown'};
  if (value.state === 'unknown') {
    return hasExactKeys(value, ['reason', 'state']) &&
      (value.reason === 'ambiguous' || value.reason === 'invalid' || value.reason === 'unavailable')
      ? {reason: value.reason, state: 'unknown'}
      : {reason: 'unavailable', state: 'unknown'};
  }
  if (
    !hasExactKeys(value, [
      'contentDigest',
      'entryCount',
      'pathStates',
      'registryRootIdentity',
      'registryRootKind',
      'registryStates',
      'state',
    ]) ||
    value.state !== 'complete' ||
    (value.registryRootKind !== 'directory' && value.registryRootKind !== 'missing') ||
    !isHash(value.registryRootIdentity) ||
    !isHash(value.contentDigest) ||
    !Number.isSafeInteger(value.entryCount) ||
    Number(value.entryCount) < 0 ||
    Number(value.entryCount) > CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxAdminNames ||
    !Array.isArray(value.pathStates) ||
    value.pathStates.length !== targetCount ||
    value.pathStates.some(state => state !== 'missing' && state !== 'present') ||
    !Array.isArray(value.registryStates) ||
    value.registryStates.length !== targetCount ||
    value.registryStates.some(state => state !== 'absent' && state !== 'present')
  ) {
    return {reason: 'unavailable', state: 'unknown'};
  }
  return {
    contentDigest: value.contentDigest,
    entryCount: Number(value.entryCount),
    pathStates: [...value.pathStates] as readonly ('missing' | 'present')[],
    registryRootIdentity: value.registryRootIdentity,
    registryRootKind: value.registryRootKind,
    registryStates: [...value.registryStates] as readonly ('absent' | 'present')[],
    state: 'complete',
  };
}

function parseWorkerJson(output: Uint8Array): Record<string, unknown> | undefined {
  try {
    if (output.byteLength > CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.workerOutputBytes) return undefined;
    const decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(output);
    if (!decoded.endsWith('\n') || decoded.slice(0, -1).includes('\n')) return undefined;
    const value: unknown = JSON.parse(decoded.slice(0, -1));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const observed = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return observed.length === sortedExpected.length && observed.every((key, index) => key === sortedExpected[index]);
}

function gitWorktreeRegistrationWorkerSpawnPlan(system: SystemInfoShape) {
  const executableName = system.executablePath.replaceAll('\\', '/').split('/').at(-1);
  const candidate = system.processArguments[1];
  const script =
    executableName === 'bun' || executableName === 'bun.exe'
      ? candidate && /(?:^|[/\\])(?:standalone\.(?:js|ts)|threadnote\.cjs)$/i.test(candidate)
        ? candidate
        : Bun.fileURLToPath(new URL('../standalone.ts', import.meta.url))
      : undefined;
  return {
    arguments: [...(script === undefined ? [] : [script]), CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT],
    environment: {...system.environment(), THREADNOTE_CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER: '1'},
    executable: system.executablePath,
  };
}

function inspectCanonicalDirectory(fs: FileSystem.FileSystem, candidate: string) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(candidate).pipe(Effect.option))) {
      return yield* Effect.fail(new CodeGraphGitWorktreeRegistrationError());
    }
    const info = yield* fs.stat(candidate);
    if (info.type !== 'Directory') return yield* Effect.fail(new CodeGraphGitWorktreeRegistrationError());
    const canonical = yield* fs.realPath(candidate);
    if (canonical !== candidate) return yield* Effect.fail(new CodeGraphGitWorktreeRegistrationError());
    return canonical;
  });
}

async function lstatStableDirectory(candidate: string): Promise<RuntimeBigIntStats> {
  const info = await runtimeLstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev === 0n || info.ino === 0n) {
    throw new Error('unavailable');
  }
  return info;
}

async function directWorktreePathState(candidate: string): Promise<'missing' | 'present' | 'unknown'> {
  try {
    await runtimeLstat(candidate);
    return 'present';
  } catch (cause) {
    return isNotFound(cause) ? 'missing' : 'unknown';
  }
}

function sameStableStats(left: RuntimeBigIntStats, right: RuntimeBigIntStats): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function statsIdentity(kind: 'directory' | 'missing', checkoutId: string, stats: RuntimeBigIntStats): string {
  return hashParts(`threadnote-git-worktree-registry-${kind}-identity-v1`, [
    checkoutId,
    String(stats.dev),
    String(stats.ino),
    String(stats.mode),
  ]);
}

function hashBytes(domain: string, checkoutId: string, bytes: Uint8Array): string {
  const prefix = UTF8.encode(`${domain}\0${checkoutId}\0`);
  const input = new Uint8Array(prefix.byteLength + bytes.byteLength);
  input.set(prefix);
  input.set(bytes, prefix.byteLength);
  return sha256HexSync(input);
}

function hashParts(domain: string, parts: readonly string[]): string {
  return sha256HexSync(`${domain}\0${parts.join('\0')}`);
}

function isSafeAbsolutePath(value: unknown): value is string {
  const path = platformPathFor(runtimePlatform);
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    UTF8.encode(value).byteLength <= 4_096 &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    !value.includes('\0') &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_ID.test(value);
}

function isNotFound(cause: unknown): boolean {
  return isRecord(cause) && cause.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedWorkerTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), 10_000)
    : CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.workerTimeoutMilliseconds;
}
