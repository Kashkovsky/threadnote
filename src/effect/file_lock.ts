import {Clock, Crypto, Effect, FileSystem, Option, Path, PlatformError} from 'effect';
import {sha256Hex} from './digest.js';
import {SystemInfo} from './system.js';

export interface ExclusiveFileLockOptions {
  readonly heartbeatIntervalMilliseconds?: number;
  readonly onAcquired?: (lockPath: string) => Effect.Effect<void, never>;
  readonly onCompleted?: (lockPath: string) => Effect.Effect<void, never>;
  readonly onContention?: (lockPath: string) => Effect.Effect<void, never>;
  readonly retryIntervalMilliseconds: number;
  readonly staleAfterMilliseconds: number;
  readonly waitTimeoutMilliseconds: number;
}

export class FileLockTimeout extends Error {
  override readonly name = 'FileLockTimeout';

  constructor(readonly lockPath: string) {
    super(`Timed out waiting for local lock ${lockPath}.`);
  }
}

interface FileLockOwner {
  readonly processId: number;
  readonly processStartIdentity?: string;
  readonly token: string;
  readonly version: 1;
}

export function isFileLockTimeout(cause: unknown): cause is FileLockTimeout {
  return cause instanceof FileLockTimeout;
}

/**
 * Serializes a small file-backed critical section across local processes.
 * Lock creation is atomic, stale locks are recoverable, and cleanup only
 * removes the caller's own token.
 */
export function withExclusiveFileLock<A, E, R>(
  fs: FileSystem.FileSystem,
  lockPath: string,
  options: ExclusiveFileLockOptions,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    yield* fs.makeDirectory(pathService.dirname(lockPath), {recursive: true});
    const token = yield* fileLockToken();
    const startedAt = yield* Clock.currentTimeMillis;
    let contentionReported = false;
    while (!(yield* tryAcquireFileLock(fs, lockPath, token, options.staleAfterMilliseconds))) {
      if (!contentionReported) {
        yield* options.onContention?.(lockPath) ?? Effect.void;
        contentionReported = true;
      }
      const now = yield* Clock.currentTimeMillis;
      if (now - startedAt >= options.waitTimeoutMilliseconds) {
        return yield* Effect.fail(new FileLockTimeout(lockPath));
      }
      yield* Effect.sleep(options.retryIntervalMilliseconds);
    }
    const heartbeatIntervalMilliseconds =
      options.heartbeatIntervalMilliseconds ?? Math.max(1, Math.floor(options.staleAfterMilliseconds / 3));
    const protectedEffect = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(refreshFileLockLease(fs, lockPath, token, heartbeatIntervalMilliseconds));
        yield* options.onAcquired?.(lockPath) ?? Effect.void;
        return yield* effect.pipe(Effect.ensuring(options.onCompleted?.(lockPath) ?? Effect.void));
      }),
    );
    return yield* protectedEffect.pipe(Effect.ensuring(releaseFileLock(fs, lockPath, token)));
  });
}

function tryAcquireFileLock(
  fs: FileSystem.FileSystem,
  lockPath: string,
  token: string,
  staleAfterMilliseconds: number,
): Effect.Effect<boolean, unknown, Crypto.Crypto | SystemInfo> {
  return Effect.gen(function* () {
    yield* recoverStaleFileLock(fs, lockPath, staleAfterMilliseconds);
    if (!(yield* tryWriteLockToken(fs, lockPath, token))) {
      return false;
    }
    if (yield* fs.exists(recoveryGuardPath(lockPath))) {
      yield* releaseFileLock(fs, lockPath, token);
      return false;
    }
    return true;
  });
}

function recoverStaleFileLock(
  fs: FileSystem.FileSystem,
  lockPath: string,
  staleAfterMilliseconds: number,
): Effect.Effect<void, unknown, Crypto.Crypto | SystemInfo> {
  return Effect.gen(function* () {
    const guardPath = recoveryGuardPath(lockPath);
    const lockNeedsRecovery = yield* staleDeadLockToken(fs, lockPath, staleAfterMilliseconds);
    if (lockNeedsRecovery === undefined && !(yield* fs.exists(guardPath))) {
      return;
    }
    const guardToken = yield* acquireRecoveryGuard(fs, lockPath, guardPath, staleAfterMilliseconds);
    if (guardToken === undefined) {
      return;
    }
    yield* Effect.gen(function* () {
      const observedToken = yield* staleDeadLockToken(fs, lockPath, staleAfterMilliseconds);
      if (observedToken !== undefined) {
        yield* releaseFileLock(fs, lockPath, observedToken);
      }
    }).pipe(Effect.ensuring(releaseFileLock(fs, guardPath, guardToken)));
  }).pipe(Effect.catch(() => Effect.void));
}

function acquireRecoveryGuard(
  fs: FileSystem.FileSystem,
  lockPath: string,
  guardPath: string,
  staleAfterMilliseconds: number,
): Effect.Effect<string | undefined, unknown, Crypto.Crypto | SystemInfo> {
  return Effect.gen(function* () {
    const token = yield* fileLockToken();
    if (yield* tryWriteLockToken(fs, guardPath, token)) {
      return token;
    }
    const staleGuardToken = yield* staleDeadLockToken(fs, guardPath, staleAfterMilliseconds);
    if (staleGuardToken === undefined) {
      return undefined;
    }
    const nestedDigest = yield* sha256Hex(`${guardPath}\n${staleGuardToken}`);
    const nestedGuardPath = `${lockPath}.recovery-${nestedDigest}`;
    const nestedToken = yield* acquireRecoveryGuard(fs, lockPath, nestedGuardPath, staleAfterMilliseconds);
    if (nestedToken === undefined) {
      return undefined;
    }
    yield* Effect.gen(function* () {
      const currentStaleToken = yield* staleDeadLockToken(fs, guardPath, staleAfterMilliseconds);
      if (currentStaleToken === staleGuardToken) {
        yield* releaseFileLock(fs, guardPath, staleGuardToken);
      }
    }).pipe(Effect.ensuring(releaseFileLock(fs, nestedGuardPath, nestedToken)));
    return (yield* tryWriteLockToken(fs, guardPath, token)) ? token : undefined;
  });
}

function staleDeadLockToken(
  fs: FileSystem.FileSystem,
  path: string,
  staleAfterMilliseconds: number,
): Effect.Effect<string | undefined, unknown, SystemInfo> {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    if (!(yield* fs.exists(path))) {
      return undefined;
    }
    const info = yield* fs.stat(path);
    const token = (yield* fs.readFileString(path)).trim();
    const owner = fileLockOwner(token);
    if (owner && !system.isProcessRunning(owner.processId)) {
      return token;
    }
    const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime();
    const now = yield* Clock.currentTimeMillis;
    if (modifiedAt === undefined || now - modifiedAt <= staleAfterMilliseconds) {
      return undefined;
    }
    if (owner?.processStartIdentity) {
      const currentStartIdentity = yield* system.processStartIdentity(owner.processId);
      if (currentStartIdentity !== undefined && currentStartIdentity !== owner.processStartIdentity) {
        return token;
      }
    }
    return owner === undefined ? token : undefined;
  });
}

function tryWriteLockToken(fs: FileSystem.FileSystem, path: string, token: string): Effect.Effect<boolean, unknown> {
  return fs.writeFileString(path, `${token}\n`, {flag: 'wx', mode: 0o600}).pipe(
    Effect.as(true),
    Effect.catch(error =>
      error instanceof PlatformError.PlatformError && error.reason._tag === 'AlreadyExists'
        ? Effect.succeed(false)
        : Effect.fail(error),
    ),
  );
}

function recoveryGuardPath(lockPath: string): string {
  return `${lockPath}.recovery`;
}

function refreshFileLockLease(
  fs: FileSystem.FileSystem,
  lockPath: string,
  token: string,
  intervalMilliseconds: number,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(intervalMilliseconds);
      if (!(yield* fs.exists(lockPath))) {
        return;
      }
      const content = yield* fs.readFileString(lockPath);
      if (content.trim() !== token) {
        return;
      }
      const now = new Date(yield* Clock.currentTimeMillis);
      yield* fs.utimes(lockPath, now, now);
    }
  }).pipe(Effect.catch(() => Effect.void));
}

const fileLockToken = Effect.fn('fileLock.token')(function* () {
  const crypto = yield* Crypto.Crypto;
  const system = yield* SystemInfo;
  const processStartIdentity = yield* system.processStartIdentity(system.processId);
  return JSON.stringify({
    processId: system.processId,
    ...(processStartIdentity ? {processStartIdentity} : {}),
    token: yield* crypto.randomUUIDv4,
    version: 1,
  } satisfies FileLockOwner);
});

function fileLockOwner(token: string): FileLockOwner | undefined {
  try {
    const parsed = JSON.parse(token) as Partial<FileLockOwner>;
    if (
      parsed.version === 1 &&
      Number.isSafeInteger(parsed.processId) &&
      parsed.processId! > 0 &&
      (parsed.processStartIdentity === undefined ||
        (typeof parsed.processStartIdentity === 'string' && parsed.processStartIdentity.length > 0)) &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0
    ) {
      return parsed as FileLockOwner;
    }
  } catch {
    // Threadnote 4 beta lock tokens used the legacy "<pid>:<nonce>" format.
  }
  const legacyProcessId = Number.parseInt(token.split(':', 1)[0] ?? '', 10);
  return Number.isSafeInteger(legacyProcessId) && legacyProcessId > 0
    ? {processId: legacyProcessId, token, version: 1}
    : undefined;
}

function releaseFileLock(fs: FileSystem.FileSystem, lockPath: string, token: string): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(lockPath))) {
      return;
    }
    const content = yield* fs.readFileString(lockPath);
    if (content.trim() === token) {
      yield* fs.remove(lockPath, {force: true});
    }
  }).pipe(Effect.catch(() => Effect.void));
}
