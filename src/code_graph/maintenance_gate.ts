import {Crypto, Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {SystemInfo} from '../effect/system.js';
import {codeGraphMaintenanceIntentPath, codeGraphMaintenanceLockPath} from './layout.js';

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
