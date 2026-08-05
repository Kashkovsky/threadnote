import {Console, Effect, Fiber, FileSystem, Option, Path, Semaphore} from 'effect';
import {writeFinalCliOutput} from './effect/cli_output.js';
import type {RuntimeConfig} from './types.js';
import {SystemInfo} from './effect/system.js';
import {readLiveStandaloneProcessLeases} from './standalone_process_lease.js';

const PROCESS_DIAGNOSTICS_SCHEMA_VERSION = 1;
const PROCESS_DIAGNOSTICS_LIMIT = 100;
const PROCESS_DIAGNOSTICS_SCAN_LIMIT = 256;
const PROCESS_REGISTRATION_LIMIT_BYTES = 16 * 1024;
const PROCESS_MEMORY_QUERY_TIMEOUT_MS = 5_000;
const SAFE_OPERATION = /^[a-z][a-z0-9-]{0,47}$/;

export type ThreadnoteProcessRole =
  | 'cli'
  | 'graph-builder'
  | 'graph-parser-worker'
  | 'graph-waiter'
  | 'legacy'
  | 'local-model-worker'
  | 'manager'
  | 'mcp';
export type RegisteredThreadnoteProcessRole = Exclude<ThreadnoteProcessRole, 'legacy'>;

interface ProcessRegistrationFile {
  readonly baseRole: RegisteredThreadnoteProcessRole;
  readonly currentOperation?: string;
  readonly parentProcessId: number;
  readonly processId: number;
  readonly processStartIdentity?: string;
  readonly role: RegisteredThreadnoteProcessRole;
  readonly schemaVersion: typeof PROCESS_DIAGNOSTICS_SCHEMA_VERSION;
  readonly startedAt: string;
  readonly token: string;
  readonly updatedAt: string;
}

export interface ThreadnoteProcessDiagnostic {
  readonly ageMilliseconds: number;
  readonly currentOperation?: string;
  readonly parentProcessId: number;
  readonly parentRole?: ThreadnoteProcessRole;
  readonly processId: number;
  readonly releaseVersion?: string;
  readonly role: ThreadnoteProcessRole;
  readonly rssBytes?: number;
  readonly startedAt: string;
}

export interface ThreadnoteProcessDiagnostics {
  readonly processes: readonly ThreadnoteProcessDiagnostic[];
  readonly schemaVersion: typeof PROCESS_DIAGNOSTICS_SCHEMA_VERSION;
  readonly truncated: boolean;
}

interface ActiveProcessRegistration {
  readonly baseOperation?: string;
  readonly baseRole: RegisteredThreadnoteProcessRole;
  readonly directory: string;
  readonly file: string;
  readonly fileSystem: FileSystem.FileSystem;
  idleWriteFiber?: Fiber.Fiber<void>;
  readonly parentProcessId: number;
  readonly processId: number;
  readonly processStartIdentity?: string;
  queuedStateKey?: string;
  readonly originalTitle: string;
  readonly path: Path.Path;
  readonly startedAt: string;
  readonly token: string;
  readonly writeSemaphore: Semaphore.Semaphore;
}

interface ProcessActivity {
  readonly operation: string;
  readonly role: RegisteredThreadnoteProcessRole;
  readonly sequence: number;
}

let registration = Option.none<ActiveProcessRegistration>();
const activities = new Map<symbol, ProcessActivity>();
let activitySequence = 0;

export interface ThreadnoteProcessActivityOptions {
  /** Keep a completed activity visible briefly so adjacent identical work can be coalesced. */
  readonly idleTransitionDelayMilliseconds?: number;
}

export const threadnoteHomeForProcess = Effect.fn('processDiagnostics.home')(function* (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const inline = arguments_.find(argument => argument.startsWith('--home='))?.slice('--home='.length);
  const flagIndex = arguments_.findIndex(argument => argument === '--home');
  const configured = inline || (flagIndex >= 0 ? arguments_[flagIndex + 1] : undefined) || environment.THREADNOTE_HOME;
  const candidate = configured || path.join(system.homeDirectory, '.threadnote');
  if (candidate === '~') return system.homeDirectory;
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    return path.join(system.homeDirectory, candidate.slice(2));
  }
  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(environment.THREADNOTE_CALLER_CWD ?? system.currentDirectory(), candidate);
});

export function withThreadnoteProcessRegistration<A, E, R>(
  home: string,
  baseRole: RegisteredThreadnoteProcessRole,
  effect: Effect.Effect<A, E, R>,
  baseOperation?: string,
): Effect.Effect<A, E, R | SystemInfo | FileSystem.FileSystem | Path.Path> {
  return Effect.acquireUseRelease(
    registerThreadnoteProcess(home, baseRole, baseOperation),
    () => effect,
    active => unregisterThreadnoteProcess(active),
  );
}

export function withThreadnoteProcessActivity<A, E, R>(
  role: RegisteredThreadnoteProcessRole,
  operation: string,
  effect: Effect.Effect<A, E, R>,
  options: ThreadnoteProcessActivityOptions = {},
): Effect.Effect<A, E, R> {
  const safeOperation = SAFE_OPERATION.test(operation) ? operation : 'unknown';
  const idleTransitionDelayMilliseconds = positiveSafeInteger(options.idleTransitionDelayMilliseconds);
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      yield* cancelIdleRegistrationWrite();
      const token = Symbol(role);
      activities.set(token, {operation: safeOperation, role, sequence: ++activitySequence});
      yield* writeCurrentRegistration().pipe(Effect.ignore);
      return token;
    }),
    () => effect,
    token =>
      Effect.gen(function* () {
        activities.delete(token);
        if (idleTransitionDelayMilliseconds === 0) {
          yield* writeCurrentRegistration().pipe(Effect.ignore);
        } else {
          yield* scheduleIdleRegistrationWrite(idleTransitionDelayMilliseconds);
        }
      }),
  );
}

export const readThreadnoteProcessDiagnostics = Effect.fn('processDiagnostics.read')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const directory = processDiagnosticsDirectory(path, config.agentContextHome);
  const names = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([] as string[])));
  const eligibleNames = names.filter(name => /^[1-9]\d*\.json$/.test(name));
  const candidateNames = eligibleNames.slice(0, PROCESS_DIAGNOSTICS_SCAN_LIMIT);
  const files = yield* Effect.forEach(
    candidateNames,
    name =>
      readRegistrationFile(fs, path.join(directory, name)).pipe(
        Effect.map(value => ({file: path.join(directory, name), value})),
      ),
    {concurrency: 8},
  );
  const live: ProcessRegistrationFile[] = [];
  for (const candidate of files) {
    if (Option.isNone(candidate.value)) {
      yield* removeRegistrationFile(fs, candidate.file);
      continue;
    }
    const value = candidate.value.value;
    const running = system.isProcessRunning(value.processId);
    const identity =
      running && value.processStartIdentity
        ? yield* system.processStartIdentity(value.processId).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined;
    const identityMatches =
      value.processStartIdentity === undefined || identity === undefined || identity === value.processStartIdentity;
    if (!running || !identityMatches) {
      yield* removeRegistrationFile(fs, candidate.file);
      continue;
    }
    live.push(value);
  }

  // Standalone releases before the runtime registry still retain a private,
  // PID/start-identity-bound lease so updates do not delete their executable.
  // Merge only that bounded installation evidence; never inspect or expose
  // arbitrary process command lines, which may contain memory text or paths.
  const releaseLeaseDiagnostics = yield* readLiveStandaloneProcessLeases().pipe(
    Effect.catch(() => Effect.succeed({leases: [] as const, truncated: false})),
  );
  const releaseLeases = releaseLeaseDiagnostics.leases;
  const releaseLeaseByProcess = new Map(releaseLeases.map(lease => [lease.processId, lease] as const));
  const registeredProcessIds = new Set(live.map(value => value.processId));
  const now = Date.now();
  const legacy = releaseLeases
    .filter(lease => !registeredProcessIds.has(lease.processId))
    .map(lease => {
      const startedAt = Option.getOrElse(lease.startedAt, () => new Date(now).toISOString());
      return {
        ageMilliseconds: Math.max(0, now - Date.parse(startedAt)),
        parentProcessId: Option.getOrElse(lease.parentProcessId, () => 0),
        processId: lease.processId,
        releaseVersion: lease.version,
        role: 'legacy' as const,
        startedAt,
      };
    });

  const roleByProcess = new Map(live.map(value => [value.processId, value.role] as const));
  const current = live
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.processId - right.processId)
    .map(value => ({
      ageMilliseconds: Math.max(0, now - Date.parse(value.startedAt)),
      ...(value.currentOperation === undefined ? {} : {currentOperation: value.currentOperation}),
      parentProcessId: value.parentProcessId,
      ...(roleByProcess.get(value.parentProcessId) === undefined
        ? {}
        : {parentRole: roleByProcess.get(value.parentProcessId)}),
      processId: value.processId,
      ...(releaseLeaseByProcess.get(value.processId) === undefined
        ? {}
        : {releaseVersion: releaseLeaseByProcess.get(value.processId)!.version}),
      role: value.role,
      startedAt: value.startedAt,
    }));
  const candidates = [...current, ...legacy].sort(
    (left, right) => left.startedAt.localeCompare(right.startedAt) || left.processId - right.processId,
  );
  // Bound the OS memory query to the same privacy-safe rows the command can
  // return. A damaged private lease tree must not turn diagnostics into an
  // unbounded command line or PowerShell query.
  const selected = candidates.slice(0, PROCESS_DIAGNOSTICS_LIMIT);
  const memoryByProcess = new Map(
    processMemoryBytes(
      selected.map(value => value.processId),
      system.platform,
      system.environment(),
    ),
  );
  if (selected.some(value => value.processId === system.processId) && !memoryByProcess.has(system.processId)) {
    const rssBytes = system.memoryUsage().rss;
    if (Number.isSafeInteger(rssBytes) && rssBytes >= 0) memoryByProcess.set(system.processId, rssBytes);
  }
  const sorted = selected.map(value => ({
    ...value,
    ...(memoryByProcess.get(value.processId) === undefined ? {} : {rssBytes: memoryByProcess.get(value.processId)}),
  }));
  return {
    processes: sorted,
    schemaVersion: PROCESS_DIAGNOSTICS_SCHEMA_VERSION,
    truncated:
      releaseLeaseDiagnostics.truncated ||
      live.length + legacy.length > PROCESS_DIAGNOSTICS_LIMIT ||
      candidateNames.length < eligibleNames.length,
  } satisfies ThreadnoteProcessDiagnostics;
});

export const runProcessDiagnostics = Effect.fn('processDiagnostics.run')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  options: {readonly json?: boolean},
) {
  const system = yield* SystemInfo;
  const observed = yield* readThreadnoteProcessDiagnostics(config);
  const diagnostics: ThreadnoteProcessDiagnostics = {
    ...observed,
    processes: observed.processes.filter(process => process.processId !== system.processId),
  };
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(diagnostics));
    return;
  }
  if (diagnostics.processes.length === 0) {
    yield* Console.log('No live Threadnote processes found.');
    return;
  }
  yield* Console.log(renderProcessDiagnosticsTable(diagnostics.processes));
  if (diagnostics.processes.some(process => process.role === 'legacy')) {
    yield* Console.log(
      'Legacy entries predate runtime registration; restart their owning agent sessions to retire old releases safely.',
    );
  }
  if (diagnostics.truncated) yield* Console.log(`Showing the first ${PROCESS_DIAGNOSTICS_LIMIT} live processes.`);
});

export function renderProcessDiagnosticsTable(processes: readonly ThreadnoteProcessDiagnostic[]): string {
  const rows = [
    ['PID', 'PPID', 'ROLE', 'VERSION', 'AGE', 'RSS', 'OPERATION'],
    ...processes.map(process => [
      String(process.processId),
      process.parentProcessId === 0 ? '-' : String(process.parentProcessId),
      process.role,
      process.releaseVersion ?? '-',
      formatDuration(process.ageMilliseconds),
      process.rssBytes === undefined ? 'unknown' : formatBytes(process.rssBytes),
      process.currentOperation ?? '-',
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)));
  return rows
    .map(row =>
      row.map((value, column) => (column === row.length - 1 ? value : value.padEnd(widths[column]! + 2))).join(''),
    )
    .join('\n');
}

export const legacyProcessDoctorCheck = Effect.fn('processDiagnostics.doctorCheck')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const diagnostics = yield* readThreadnoteProcessDiagnostics(config);
  const legacy = diagnostics.processes.filter(process => process.role === 'legacy');
  if (legacy.length === 0) {
    return {
      detail: 'no unregistered standalone processes detected',
      name: 'standalone process lifecycle',
      status: 'ok' as const,
    };
  }
  const versions = [...new Set(legacy.flatMap(process => (process.releaseVersion ? [process.releaseVersion] : [])))]
    .sort()
    .join(', ');
  return {
    detail:
      `${legacy.length} live pre-registry process(es)${versions ? ` from ${versions}` : ''}; ` +
      'restart their owning agent sessions to retire old releases safely',
    name: 'standalone process lifecycle',
    status: 'warn' as const,
  };
});

function registerThreadnoteProcess(home: string, baseRole: RegisteredThreadnoteProcessRole, baseOperation?: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const writeSemaphore = yield* Semaphore.make(1);
    const directory = processDiagnosticsDirectory(path, home);
    const active: ActiveProcessRegistration = {
      ...(baseOperation !== undefined && SAFE_OPERATION.test(baseOperation) ? {baseOperation} : {}),
      baseRole,
      directory,
      file: path.join(directory, `${system.processId}.json`),
      fileSystem: fs,
      parentProcessId: process.ppid,
      processId: system.processId,
      processStartIdentity: yield* system
        .processStartIdentity(system.processId)
        .pipe(Effect.catch(() => Effect.succeed(undefined))),
      originalTitle: process.title,
      path,
      startedAt: new Date().toISOString(),
      token: crypto.randomUUID(),
      writeSemaphore,
    };
    registration = Option.some(active);
    setBestEffortProcessTitle(baseRole);
    yield* writeCurrentRegistration();
    return active;
  }).pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        registration = Option.none();
        activities.clear();
        return undefined;
      }),
    ),
    Effect.map(active => Option.fromUndefinedOr(active)),
  );
}

function unregisterThreadnoteProcess(active: Option.Option<ActiveProcessRegistration>) {
  return Effect.gen(function* () {
    if (Option.isNone(active)) return;
    yield* cancelIdleRegistrationWrite(active.value);
    if (Option.isSome(registration) && registration.value.token === active.value.token) registration = Option.none();
    activities.clear();
    setBestEffortProcessTitleValue(active.value.originalTitle);
    yield* active.value.writeSemaphore.withPermit(
      Effect.gen(function* () {
        const current = yield* readRegistrationFile(active.value.fileSystem, active.value.file);
        if (Option.isSome(current) && current.value.token === active.value.token) {
          yield* active.value.fileSystem.remove(active.value.file, {force: true});
        }
      }),
    );
  }).pipe(Effect.ignore);
}

function writeCurrentRegistration(): Effect.Effect<void, unknown> {
  return Effect.suspend(() => {
    if (Option.isNone(registration)) return Effect.void;
    const active = registration.value;
    return active.writeSemaphore.withPermit(
      Effect.suspend(() => {
        if (Option.isNone(registration) || registration.value.token !== active.token) return Effect.void;
        const current = currentProcessActivity();
        const role = current?.role ?? active.baseRole;
        setBestEffortProcessTitle(role);
        const currentOperation = current?.operation ?? active.baseOperation;
        const stateKey = `${role}\0${currentOperation ?? ''}`;
        if (active.queuedStateKey === stateKey) return Effect.void;
        const value: ProcessRegistrationFile = {
          baseRole: active.baseRole,
          ...(currentOperation === undefined ? {} : {currentOperation}),
          parentProcessId: active.parentProcessId,
          processId: active.processId,
          processStartIdentity: active.processStartIdentity,
          role,
          schemaVersion: PROCESS_DIAGNOSTICS_SCHEMA_VERSION,
          startedAt: active.startedAt,
          token: active.token,
          updatedAt: new Date().toISOString(),
        };
        active.queuedStateKey = stateKey;
        return writeRegistrationFile(active, value).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              if (active.queuedStateKey === stateKey) active.queuedStateKey = undefined;
            }),
          ),
        );
      }),
    );
  });
}

function scheduleIdleRegistrationWrite(delayMilliseconds: number): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (Option.isNone(registration)) return;
    const active = registration.value;
    yield* cancelIdleRegistrationWrite(active);
    active.idleWriteFiber = yield* Effect.sleep(delayMilliseconds).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          active.idleWriteFiber = undefined;
          if (Option.isNone(registration) || registration.value.token !== active.token) return Effect.void;
          return writeCurrentRegistration().pipe(Effect.ignore);
        }),
      ),
      Effect.forkDetach({startImmediately: true}),
    );
  });
}

function cancelIdleRegistrationWrite(active = Option.getOrUndefined(registration)): Effect.Effect<void> {
  if (!active || active.idleWriteFiber === undefined) return Effect.void;
  const fiber = active.idleWriteFiber;
  active.idleWriteFiber = undefined;
  return Fiber.interrupt(fiber).pipe(Effect.asVoid);
}

function currentProcessActivity(): ProcessActivity | undefined {
  return [...activities.values()].sort(
    (left, right) => activityPriority(right.role) - activityPriority(left.role) || right.sequence - left.sequence,
  )[0];
}

function activityPriority(role: ProcessActivity['role']): number {
  return role === 'graph-builder' ? 3 : role === 'graph-waiter' ? 2 : 1;
}

function writeRegistrationFile(
  active: ActiveProcessRegistration,
  value: ProcessRegistrationFile,
): Effect.Effect<void, unknown> {
  const temporary = active.path.join(active.directory, `.${active.processId}.${active.token}.tmp`);
  return Effect.gen(function* () {
    yield* active.fileSystem.makeDirectory(active.directory, {recursive: true, mode: 0o700});
    yield* active.fileSystem.remove(temporary, {force: true});
    yield* active.fileSystem.writeFileString(temporary, `${JSON.stringify(value, undefined, 2)}\n`, {mode: 0o600});
    yield* active.fileSystem.rename(temporary, active.file);
  }).pipe(Effect.ensuring(active.fileSystem.remove(temporary, {force: true}).pipe(Effect.ignore)));
}

function processDiagnosticsDirectory(path: Path.Path, home: string): string {
  return path.join(home, 'runtime', 'processes');
}

function readRegistrationFile(
  fs: FileSystem.FileSystem,
  file: string,
): Effect.Effect<Option.Option<ProcessRegistrationFile>> {
  return Effect.gen(function* () {
    if (Number((yield* fs.stat(file)).size) > PROCESS_REGISTRATION_LIMIT_BYTES) return Option.none();
    const source = yield* fs.readFileString(file);
    const value = yield* Effect.try(() => JSON.parse(source) as unknown);
    return isProcessRegistrationFile(value) ? Option.some(value) : Option.none();
  }).pipe(Effect.catch(() => Effect.succeed(Option.none())));
}

function isProcessRegistrationFile(value: unknown): value is ProcessRegistrationFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ProcessRegistrationFile>;
  return (
    candidate.schemaVersion === PROCESS_DIAGNOSTICS_SCHEMA_VERSION &&
    isRegisteredThreadnoteProcessRole(candidate.baseRole) &&
    isRegisteredThreadnoteProcessRole(candidate.role) &&
    Number.isSafeInteger(candidate.processId) &&
    (candidate.processId ?? 0) > 0 &&
    Number.isSafeInteger(candidate.parentProcessId) &&
    (candidate.parentProcessId ?? -1) >= 0 &&
    typeof candidate.startedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.startedAt)) &&
    typeof candidate.updatedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.updatedAt)) &&
    typeof candidate.token === 'string' &&
    candidate.token.length >= 16 &&
    (candidate.currentOperation === undefined || SAFE_OPERATION.test(candidate.currentOperation)) &&
    (candidate.processStartIdentity === undefined || typeof candidate.processStartIdentity === 'string')
  );
}

function isRegisteredThreadnoteProcessRole(value: unknown): value is RegisteredThreadnoteProcessRole {
  return (
    value === 'cli' ||
    value === 'graph-builder' ||
    value === 'graph-parser-worker' ||
    value === 'graph-waiter' ||
    value === 'local-model-worker' ||
    value === 'manager' ||
    value === 'mcp'
  );
}

function removeRegistrationFile(fs: FileSystem.FileSystem, file: string) {
  return fs.remove(file, {force: true}).pipe(Effect.catch(() => Effect.void));
}

function processMemoryBytes(
  processIds: readonly number[],
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): ReadonlyMap<number, number> {
  if (processIds.length === 0) return new Map();
  try {
    if (platform === 'win32') return windowsProcessMemoryBytes(processIds, environment);
    const result = Bun.spawnSync({
      cmd: ['ps', '-o', 'pid=,rss=', '-p', processIds.join(',')],
      env: environment,
      stderr: 'pipe',
      stdout: 'pipe',
      timeout: PROCESS_MEMORY_QUERY_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return new Map();
    const memory = new Map<number, number>();
    for (const line of result.stdout.toString().split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      memory.set(Number(match[1]), Number(match[2]) * 1024);
    }
    return memory;
  } catch {
    return new Map();
  }
}

function windowsProcessMemoryBytes(
  processIds: readonly number[],
  environment: NodeJS.ProcessEnv,
): ReadonlyMap<number, number> {
  const result = Bun.spawnSync({
    cmd: [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$ids=$env:THREADNOTE_PROCESS_IDS -split ","; ' +
        'Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress',
    ],
    env: {...environment, THREADNOTE_PROCESS_IDS: processIds.join(',')},
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: PROCESS_MEMORY_QUERY_TIMEOUT_MS,
  });
  if (result.exitCode !== 0 || !result.stdout.length) return new Map();
  const parsed = JSON.parse(result.stdout.toString()) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const memory = new Map<number, number>();
  for (const row of rows) {
    if (
      typeof row === 'object' &&
      row !== null &&
      'Id' in row &&
      'WorkingSet64' in row &&
      Number.isSafeInteger(Number(row.Id)) &&
      Number.isSafeInteger(Number(row.WorkingSet64))
    ) {
      memory.set(Number(row.Id), Number(row.WorkingSet64));
    }
  }
  return memory;
}

function setBestEffortProcessTitle(role: ThreadnoteProcessRole): void {
  setBestEffortProcessTitleValue(`threadnote:${role}`);
}

function setBestEffortProcessTitleValue(title: string): void {
  try {
    process.title = title;
  } catch {
    // Bun and the host OS may not expose mutable process titles. The private
    // runtime registry remains authoritative for Threadnote diagnostics.
  }
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h${minutes}m` : minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function positiveSafeInteger(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
