import {Clock, Crypto, Effect, FileSystem, Path, Predicate, Schema} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {isFileLockTimeout, withExclusiveFileLock} from '../effect/file_lock.js';
import {runtimeTextDirectoryNamePage, SystemInfo, type SystemInfoShape} from '../effect/system.js';
import {
  codeGraphBuilderAdmissionLockPath,
  codeGraphBuilderAdmissionRoot,
  codeGraphBuilderAdmissionSlotPath,
} from './layout.js';

export const CODE_GRAPH_BUILDER_HOME_CAPACITY = 2;
export const CODE_GRAPH_BUILDER_ADMISSION_CLASS_ENV = 'THREADNOTE_CODE_GRAPH_BUILDER_ADMISSION_CLASS';

export type CodeGraphBuilderAdmissionClass = 'background' | 'current-required';

interface BuilderAdmissionTicket {
  readonly admissionClass: CodeGraphBuilderAdmissionClass;
  readonly createdAt: number;
  readonly processId: number;
  readonly processStartIdentity?: string;
  readonly token: string;
  readonly version: 1;
}

interface OwnedTicket extends BuilderAdmissionTicket {
  readonly path: string;
  readonly serialized: string;
}

const TICKET_NAME = /^v1-([0-9a-f]{64})\.json$/;
const TICKET_BYTES_MAXIMUM = 1_024;
const TICKET_COUNT_MAXIMUM = 256;
const ADMISSION_RETRY_MILLISECONDS = 25;
const LEDGER_LOCK_WAIT_MILLISECONDS = 5_000;
const SLOT_STALE_MILLISECONDS = 15_000;

class CodeGraphBuilderAdmissionError extends Schema.TaggedError<CodeGraphBuilderAdmissionError>()(
  'CodeGraphBuilderAdmissionError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

/**
 * Home-global, cross-process builder admission. Tickets are selected current-
 * required before background and FIFO inside each class. A ticket is removed
 * only after one of the two slot locks is held, so no SQL build row is created
 * while a caller waits for home capacity.
 */
export function withCodeGraphBuilderAdmission<A, E, R>(
  options: {
    readonly admissionClass: CodeGraphBuilderAdmissionClass;
    readonly onWaiting?: Effect.Effect<void, never>;
    readonly threadnoteHome: string;
  },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, R | Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const crypto = yield* Crypto.Crypto;
    const ticket = yield* createTicket(fs, path, system, options.threadnoteHome, options.admissionClass);
    let waitingReported = false;
    return yield* Effect.gen(function* () {
      for (;;) {
        const selected = yield* ticketIsSelected(fs, path, system, options.threadnoteHome, ticket);
        if (selected) {
          for (const slot of [0, 1] as const) {
            const result = yield* withExclusiveFileLock(
              fs,
              codeGraphBuilderAdmissionSlotPath(path, options.threadnoteHome, slot),
              {
                heartbeatIntervalMilliseconds: 5_000,
                onAcquired: () =>
                  removeOwnedTicket(fs, path, options.threadnoteHome, ticket).pipe(
                    Effect.provideService(Crypto.Crypto, crypto),
                    Effect.provideService(Path.Path, path),
                    Effect.provideService(SystemInfo, system),
                    Effect.ignore,
                  ),
                recoverReusedProcessIdImmediately: true,
                retryIntervalMilliseconds: 1,
                staleAfterMilliseconds: SLOT_STALE_MILLISECONDS,
                useCanonicalProcessStartIdentity: true,
                waitTimeoutMilliseconds: 0,
              },
              effect,
            ).pipe(
              Effect.map(value => ({state: 'completed' as const, value})),
              Effect.catchIf(isFileLockTimeout, () => Effect.succeed({state: 'contended' as const})),
            );
            if (result.state === 'completed') return result.value;
          }
        }
        if (!waitingReported) {
          yield* options.onWaiting ?? Effect.void;
          waitingReported = true;
        }
        yield* Effect.sleep(ADMISSION_RETRY_MILLISECONDS);
      }
    }).pipe(Effect.ensuring(removeOwnedTicket(fs, path, options.threadnoteHome, ticket).pipe(Effect.ignore)));
  });
}

/** @internal Deterministic ordering model for admission property tests. */
export function orderCodeGraphBuilderAdmissionTickets<
  T extends Pick<BuilderAdmissionTicket, 'admissionClass' | 'createdAt' | 'token'>,
>(tickets: readonly T[]): readonly T[] {
  return [...tickets].sort(
    (left, right) =>
      admissionRank(left.admissionClass) - admissionRank(right.admissionClass) ||
      left.createdAt - right.createdAt ||
      left.token.localeCompare(right.token),
  );
}

function admissionRank(admissionClass: CodeGraphBuilderAdmissionClass): number {
  return admissionClass === 'current-required' ? 0 : 1;
}

const createTicket = Effect.fn('codeGraph.builderAdmission.createTicket')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  threadnoteHome: string,
  admissionClass: CodeGraphBuilderAdmissionClass,
) {
  const crypto = yield* Crypto.Crypto;
  const root = codeGraphBuilderAdmissionRoot(path, threadnoteHome);
  yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  if (system.platform !== 'win32') yield* fs.chmod(root, 0o700);
  const token = sha256HexSync(`${system.processId}\0${yield* crypto.randomUUIDv4}`);
  const processStartIdentity = yield* system.canonicalProcessStartIdentity?.(system.processId) ??
    system.processStartIdentity(system.processId);
  const ticket: OwnedTicket = {
    admissionClass,
    createdAt: yield* Clock.currentTimeMillis,
    path: path.join(root, `v1-${token}.json`),
    processId: system.processId,
    ...(processStartIdentity === undefined ? {} : {processStartIdentity}),
    serialized: '',
    token,
    version: 1,
  };
  const serialized = JSON.stringify({...ticket, path: undefined, serialized: undefined});
  const owned = {...ticket, serialized};
  const temporaryPath = `${owned.path}.${token.slice(0, 16)}.tmp`;
  yield* withLedgerLock(
    fs,
    codeGraphBuilderAdmissionLockPath(path, threadnoteHome),
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(temporaryPath, {flag: 'wx', mode: 0o600});
        yield* file.writeAll(new TextEncoder().encode(serialized));
        yield* file.sync;
      }),
    ).pipe(
      Effect.andThen(fs.rename(temporaryPath, owned.path)),
      Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)),
    ),
  );
  if (system.platform !== 'win32') yield* fs.chmod(owned.path, 0o600);
  return owned;
});

const ticketIsSelected = Effect.fn('codeGraph.builderAdmission.select')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  threadnoteHome: string,
  owned: OwnedTicket,
) {
  return yield* withLedgerLock(
    fs,
    codeGraphBuilderAdmissionLockPath(path, threadnoteHome),
    Effect.gen(function* () {
      const tickets = yield* scanTickets(fs, path, system, threadnoteHome);
      return orderCodeGraphBuilderAdmissionTickets(tickets)[0]?.token === owned.token;
    }),
  );
});

const scanTickets = Effect.fn('codeGraph.builderAdmission.scan')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  threadnoteHome: string,
) {
  const root = codeGraphBuilderAdmissionRoot(path, threadnoteHome);
  if (!(yield* fs.exists(root))) return [] as OwnedTicket[];
  const page = yield* runtimeTextDirectoryNamePage(root, TICKET_COUNT_MAXIMUM);
  if (page.overflow) return yield* CodeGraphBuilderAdmissionError.make({message: 'Builder ticket bound exceeded.'});
  const tickets: OwnedTicket[] = [];
  for (const name of [...page.names].sort()) {
    const token = TICKET_NAME.exec(name)?.[1];
    if (!token) return yield* CodeGraphBuilderAdmissionError.make({message: 'Builder ticket name is invalid.'});
    const ticketPath = path.join(root, name);
    if ((yield* fs.readLink(ticketPath).pipe(Effect.option))._tag === 'Some') {
      return yield* CodeGraphBuilderAdmissionError.make({message: 'Builder ticket is symbolic.'});
    }
    const info = yield* fs.stat(ticketPath);
    if (info.type !== 'File' || Number(info.size) > TICKET_BYTES_MAXIMUM) {
      return yield* CodeGraphBuilderAdmissionError.make({message: 'Builder ticket is invalid.'});
    }
    const serialized = yield* fs.readFileString(ticketPath);
    const parsed = parseTicket(serialized, token);
    if (!parsed) return yield* CodeGraphBuilderAdmissionError.make({message: 'Builder ticket content is invalid.'});
    if (yield* ticketOwnerIsDead(system, parsed)) {
      yield* fs.remove(ticketPath, {force: true});
      continue;
    }
    tickets.push({...parsed, path: ticketPath, serialized});
  }
  return tickets;
});

function parseTicket(serialized: string, token: string): BuilderAdmissionTicket | undefined {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Predicate.isObject(parsed)) return undefined;
    const value = parsed;
    if (
      value.version !== 1 ||
      value.token !== token ||
      (value.admissionClass !== 'background' && value.admissionClass !== 'current-required') ||
      typeof value.createdAt !== 'number' ||
      !Number.isSafeInteger(value.createdAt) ||
      typeof value.processId !== 'number' ||
      !Number.isSafeInteger(value.processId) ||
      value.processId <= 0 ||
      ((value.processStartIdentity !== undefined || Object.hasOwn(value, 'processStartIdentity')) &&
        typeof value.processStartIdentity !== 'string')
    ) {
      return undefined;
    }
    return {
      admissionClass: value.admissionClass,
      createdAt: value.createdAt,
      processId: value.processId,
      ...(value.processStartIdentity === undefined ? {} : {processStartIdentity: value.processStartIdentity}),
      token: value.token,
      version: 1,
    };
  } catch {
    return undefined;
  }
}

const ticketOwnerIsDead = Effect.fn('codeGraph.builderAdmission.ownerDead')(function* (
  system: SystemInfoShape,
  ticket: BuilderAdmissionTicket,
) {
  if (!system.isProcessRunning(ticket.processId)) return true;
  if (ticket.processStartIdentity === undefined) return false;
  const current = yield* system.canonicalProcessStartIdentity?.(ticket.processId) ??
    system.processStartIdentity(ticket.processId);
  return current !== undefined && current !== ticket.processStartIdentity;
});

function withLedgerLock<A, E, R>(fs: FileSystem.FileSystem, lockPath: string, effect: Effect.Effect<A, E, R>) {
  return withExclusiveFileLock(
    fs,
    lockPath,
    {
      heartbeatIntervalMilliseconds: 5_000,
      recoverReusedProcessIdImmediately: true,
      retryIntervalMilliseconds: 10,
      staleAfterMilliseconds: 15_000,
      useCanonicalProcessStartIdentity: true,
      waitTimeoutMilliseconds: LEDGER_LOCK_WAIT_MILLISECONDS,
    },
    effect,
  );
}

const removeOwnedTicket = Effect.fn('codeGraph.builderAdmission.removeTicket')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  ticket: OwnedTicket,
) {
  yield* withLedgerLock(
    fs,
    codeGraphBuilderAdmissionLockPath(path, threadnoteHome),
    Effect.gen(function* () {
      if (!(yield* fs.exists(ticket.path))) return;
      if ((yield* fs.readLink(ticket.path).pipe(Effect.option))._tag === 'Some') return;
      const content = yield* fs.readFileString(ticket.path);
      if (content === ticket.serialized) yield* fs.remove(ticket.path, {force: true});
    }),
  );
});
