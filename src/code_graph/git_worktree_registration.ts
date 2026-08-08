import {opendir, lstat} from 'node:fs/promises';
import {isAbsolute, join, normalize} from 'node:path';
import type {BigIntStats, Dirent} from 'node:fs';
import {Effect, FileSystem, Option, Path} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {CommandTimedOut, runBinaryCommandEffect} from '../effect/command.js';
import {SystemInfo, type SystemInfoShape} from '../effect/system.js';
import {CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT} from '../worker_protocol.js';
import type {RepositoryIdentity} from './types.js';

const PROTOCOL_VERSION = 1 as const;
const HASH_ID = /^[0-9a-f]{64}$/;
const UTF8 = new TextEncoder();

export const CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS = {
  gitDirectoryOutputBytes: 16 * 1_024,
  gitDirectoryTimeoutMilliseconds: 10_000,
  maxAdminNameBytes: 4_096,
  maxAdminNames: 4_096,
  maxRegistryNameBytes: 8 * 1_048_576,
  workerInputBytes: 16 * 1_024,
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

export interface CodeGraphGitWorktreeRegistryRequest {
  readonly adminNameKeys: readonly string[];
  readonly checkoutId: string;
  readonly gitCommonDirectory: string;
  readonly protocol: typeof PROTOCOL_VERSION;
}

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

/** Worker-side bounded observation. Exported for deterministic filesystem and property tests. */
export async function scanCodeGraphGitWorktreeRegistry(
  request: CodeGraphGitWorktreeRegistryRequest,
): Promise<CodeGraphGitWorktreeRegistryObservation> {
  if (!validWorkerRequest(request)) return {reason: 'invalid', state: 'unknown'};
  try {
    const commonBefore = await lstatStableDirectory(request.gitCommonDirectory);
    const registryRoot = join(request.gitCommonDirectory, 'worktrees');
    let rootBefore: BigIntStats;
    try {
      rootBefore = await lstat(registryRoot, {bigint: true});
    } catch (cause) {
      if (!isNotFound(cause)) return {reason: 'unavailable', state: 'unknown'};
      const commonAfter = await lstatStableDirectory(request.gitCommonDirectory);
      if (!sameStableStats(commonBefore, commonAfter)) return {reason: 'ambiguous', state: 'unknown'};
      return {
        contentDigest: hashParts('threadnote-git-worktree-registry-empty-v1', [request.checkoutId]),
        entryCount: 0,
        registryRootIdentity: statsIdentity('missing', request.checkoutId, commonBefore),
        registryRootKind: 'missing',
        state: 'absent',
      };
    }
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) return {reason: 'ambiguous', state: 'unknown'};

    const exactEntryKeys: string[] = [];
    let entryCount = 0;
    let totalNameBytes = 0;
    let targetPresent = false;
    const targetKeys = new Set(request.adminNameKeys);
    const directory = await opendir(registryRoot, {
      bufferSize: 32,
      // Node and Bun both support the documented buffer sentinel at runtime;
      // the generic Node declaration narrows this field to text encodings.
      encoding: (process.platform === 'win32' ? 'utf8' : 'buffer') as BufferEncoding,
    });
    for await (const entry of directory as AsyncIterable<Dirent<string | Buffer> | Uint8Array>) {
      // Bun 1.3 yields the raw Uint8Array directly for encoding:'buffer'; Node
      // yields a Dirent whose name is a Buffer. Accept both without decoding.
      const name = entry instanceof Uint8Array ? entry : entry.name;
      const nameBytes = typeof name === 'string' ? UTF8.encode(name) : new Uint8Array(name);
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
      const keys = codeGraphGitWorktreeAdminNameKeys(request.checkoutId, nameBytes);
      exactEntryKeys.push(keys[0]!);
      if (keys.some(key => targetKeys.has(key))) targetPresent = true;
    }

    const [rootAfter, commonAfter] = await Promise.all([
      lstat(registryRoot, {bigint: true}),
      lstatStableDirectory(request.gitCommonDirectory),
    ]);
    if (!sameStableStats(rootBefore, rootAfter) || !sameStableStats(commonBefore, commonAfter)) {
      return {reason: 'ambiguous', state: 'unknown'};
    }
    exactEntryKeys.sort();
    return {
      contentDigest: hashParts('threadnote-git-worktree-registry-content-v1', [request.checkoutId, ...exactEntryKeys]),
      entryCount,
      registryRootIdentity: statsIdentity('directory', request.checkoutId, rootBefore),
      registryRootKind: 'directory',
      state: targetPresent ? 'present' : 'absent',
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
    validAdminNameKeys(value.adminNameKeys)
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

async function lstatStableDirectory(candidate: string): Promise<BigIntStats> {
  const info = await lstat(candidate, {bigint: true});
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev === 0n || info.ino === 0n) {
    throw new Error('unavailable');
  }
  return info;
}

function sameStableStats(left: BigIntStats, right: BigIntStats): boolean {
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

function statsIdentity(kind: 'directory' | 'missing', checkoutId: string, stats: BigIntStats): string {
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
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    UTF8.encode(value).byteLength <= 4_096 &&
    isAbsolute(value) &&
    normalize(value) === value &&
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
