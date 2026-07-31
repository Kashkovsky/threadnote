import {Clock, Crypto, Effect, FileSystem, Option, Path} from 'effect';
import {isFileLockTimeout, withExclusiveFileLock} from '../effect/file_lock.js';
import {SystemInfo} from '../effect/system.js';
import {
  codeGraphDatabaseWriteLockPath,
  codeGraphMaintenanceIntentPath,
  codeGraphMaintenanceLockPath,
  codeGraphWorktreeLockRoot,
} from './layout.js';

interface MaintenanceIntentOwner {
  readonly processId: number;
  readonly processStartIdentity: string;
  readonly token: string;
}

export const withCodeGraphMaintenanceRegistration = Effect.fn('codeGraph.withMaintenanceRegistration')(function* <
  A,
  E,
  R,
>(threadnoteHome: string, effect: Effect.Effect<A, E, R>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withExclusiveFileLock(
    fs,
    codeGraphMaintenanceLockPath(path, threadnoteHome),
    CODE_GRAPH_GATE_LOCK_OPTIONS,
    effect,
  );
});

export const withCodeGraphMaintenanceIntent = Effect.fn('codeGraph.withMaintenanceIntent')(function* <A, E, R>(
  threadnoteHome: string,
  effect: Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const system = yield* SystemInfo;
  const intent = codeGraphMaintenanceIntentPath(path, threadnoteHome);
  const processStartIdentity = yield* system.processStartIdentity(system.processId);
  if (!processStartIdentity) {
    return yield* Effect.fail(new Error('Could not identify the maintenance process instance.'));
  }
  const token = JSON.stringify({
    processId: system.processId,
    processStartIdentity,
    token: yield* crypto.randomUUIDv4,
  } satisfies MaintenanceIntentOwner);
  yield* fs.makeDirectory(path.dirname(intent), {recursive: true, mode: 0o700});
  yield* fs.writeFileString(intent, `${token}\n`, {flag: 'w', mode: 0o600});
  return yield* effect.pipe(Effect.ensuring(removeOwnedIntent(fs, intent, token)));
});

export const codeGraphMaintenanceIntentActive = Effect.fn('codeGraph.maintenanceIntentActive')(function* (
  threadnoteHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const intent = codeGraphMaintenanceIntentPath(path, threadnoteHome);
  if (!(yield* fs.exists(intent))) return false;
  const token = (yield* fs.readFileString(intent)).trim();
  const owner = parseMaintenanceIntentOwner(token);
  if (
    owner &&
    system.isProcessRunning(owner.processId) &&
    (yield* system.processStartIdentity(owner.processId)) === owner.processStartIdentity
  ) {
    return true;
  }
  yield* removeOwnedIntent(fs, intent, token);
  return false;
});

/**
 * Waits until every linked-worktree builder for a checkout has released its
 * collision-safe build lock. Call this only after publishing the maintenance
 * intent so no new builder can enter the shared SQLite store.
 */
export const awaitCodeGraphWorktreeBuilds = Effect.fn('codeGraph.awaitWorktreeBuilds')(function* (
  threadnoteHome: string,
  checkoutId: string,
  waitTimeoutMilliseconds: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = codeGraphWorktreeLockRoot(path, threadnoteHome, checkoutId);
  const startedAt = yield* Clock.currentTimeMillis;
  for (;;) {
    const locks = yield* codeGraphWorktreeLockFiles(fs, path, root);
    if (locks.length === 0) return;
    for (const lock of locks) {
      const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
      yield* withExclusiveFileLock(
        fs,
        lock,
        {
          retryIntervalMilliseconds: 100,
          staleAfterMilliseconds: 120_000,
          waitTimeoutMilliseconds: Math.max(0, waitTimeoutMilliseconds - elapsed),
        },
        Effect.void,
      );
    }
  }
});

export const codeGraphWorktreeBuildActive = Effect.fn('codeGraph.worktreeBuildActive')(function* (
  threadnoteHome: string,
  checkoutId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locks = yield* codeGraphWorktreeLockFiles(
    fs,
    path,
    codeGraphWorktreeLockRoot(path, threadnoteHome, checkoutId),
  );
  for (const lock of locks) {
    const active = yield* withExclusiveFileLock(
      fs,
      lock,
      {...CODE_GRAPH_GATE_LOCK_OPTIONS, waitTimeoutMilliseconds: 0},
      Effect.succeed(false),
    ).pipe(Effect.catch(cause => (isFileLockTimeout(cause) ? Effect.succeed(true) : Effect.fail(cause))));
    if (active) return true;
  }
  return false;
});

/**
 * Serializes the short publication/maintenance phase that mutates a checkout's
 * shared SQLite snapshot catalog. Linked worktrees retain independent build
 * locks, so inventory and extraction still proceed concurrently.
 */
export const withCodeGraphDatabaseWriteLock = Effect.fn('codeGraph.withDatabaseWriteLock')(function* <A, E, R>(
  threadnoteHome: string,
  checkoutId: string,
  effect: Effect.Effect<A, E, R>,
  waitTimeoutMilliseconds = CODE_GRAPH_GATE_LOCK_OPTIONS.waitTimeoutMilliseconds,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withExclusiveFileLock(
    fs,
    codeGraphDatabaseWriteLockPath(path, threadnoteHome, checkoutId),
    {...CODE_GRAPH_GATE_LOCK_OPTIONS, waitTimeoutMilliseconds},
    effect,
  );
});

function codeGraphWorktreeLockFiles(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.Effect<readonly string[], unknown> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(root))) return [];
    if (Option.isSome(yield* fs.readLink(root).pipe(Effect.option))) {
      return yield* Effect.fail(new Error('Code graph worktree lock root is a symbolic link.'));
    }
    if ((yield* fs.stat(root)).type !== 'Directory') {
      return yield* Effect.fail(new Error('Code graph worktree lock root is not a directory.'));
    }
    return (yield* fs.readDirectory(root))
      .filter(name => /^[0-9a-f]{64}\.lock$/.test(name))
      .sort()
      .map(name => path.join(root, name));
  });
}

function parseMaintenanceIntentOwner(value: string): MaintenanceIntentOwner | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<MaintenanceIntentOwner>;
    return Number.isSafeInteger(parsed.processId) &&
      parsed.processId! > 0 &&
      typeof parsed.processStartIdentity === 'string' &&
      parsed.processStartIdentity.length > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0
      ? (parsed as MaintenanceIntentOwner)
      : undefined;
  } catch {
    return undefined;
  }
}

function removeOwnedIntent(fs: FileSystem.FileSystem, intent: string, token: string): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(intent))) return;
    if ((yield* fs.readFileString(intent)).trim() === token) {
      yield* fs.remove(intent, {force: true});
    }
  }).pipe(Effect.catch(() => Effect.void));
}

export const CODE_GRAPH_GATE_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: 10 * 60_000,
} as const;
