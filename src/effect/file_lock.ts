import {Clock, Crypto, Effect, FileSystem, Option, Path, PlatformError} from 'effect';
import {sha256Hex} from './digest.js';
import {SystemInfo} from './system.js';

export interface ExclusiveFileLockOptions {
  readonly heartbeatIntervalMilliseconds?: number;
  readonly retryIntervalMilliseconds: number;
  readonly staleAfterMilliseconds: number;
  readonly waitTimeoutMilliseconds: number;
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
    const crypto = yield* Crypto.Crypto;
    const system = yield* SystemInfo;
    const token = `${system.processId}:${yield* crypto.randomUUIDv4}`;
    const startedAt = yield* Clock.currentTimeMillis;
    while (!(yield* tryAcquireFileLock(fs, lockPath, token, options.staleAfterMilliseconds))) {
      const now = yield* Clock.currentTimeMillis;
      if (now - startedAt >= options.waitTimeoutMilliseconds) {
        return yield* Effect.fail(new Error(`Timed out waiting for local lock ${lockPath}.`));
      }
      yield* Effect.sleep(options.retryIntervalMilliseconds);
    }
    const heartbeatIntervalMilliseconds =
      options.heartbeatIntervalMilliseconds ?? Math.max(1, Math.floor(options.staleAfterMilliseconds / 3));
    const protectedEffect = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(refreshFileLockLease(fs, lockPath, token, heartbeatIntervalMilliseconds));
        return yield* effect;
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
    const crypto = yield* Crypto.Crypto;
    const system = yield* SystemInfo;
    const token = `${system.processId}:${yield* crypto.randomUUIDv4}`;
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
    const ownerPid = fileLockOwnerPid(token);
    if (ownerPid !== undefined && !system.isProcessRunning(ownerPid)) {
      return token;
    }
    const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime();
    const now = yield* Clock.currentTimeMillis;
    if (modifiedAt === undefined || now - modifiedAt <= staleAfterMilliseconds) {
      return undefined;
    }
    return ownerPid === undefined ? token : undefined;
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

function fileLockOwnerPid(token: string): number | undefined {
  const value = Number.parseInt(token.split(':', 1)[0] ?? '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
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
