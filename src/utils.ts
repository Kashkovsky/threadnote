import * as BunSocket from '@effect/platform-bun/BunSocket';
import {Console, Deferred, Effect, FileSystem, Option, Path, Stdio, Stream} from 'effect';
import {failure, success, warning} from './cli_ui.js';
import {maybeRunEffect, runCommandEffect, runStreamingCommandEffect, type CommandOptions} from './effect/command.js';
import {getStatusEffect, getTextEffect} from './effect/http.js';
import {sha256Hex} from './effect/digest.js';
import {SystemInfo, type SystemInfoShape} from './effect/system.js';
import {
  boundedMemoryAuthority,
  boundedMemoryTrust,
  isSharedMemoryUri,
  type MemoryRecord,
  type MemoryRelation,
} from './memory_document.js';
import {
  rankRecallCandidates,
  type RecallCandidate,
  type RecallConfidence,
  type RecallCorpusStatistics,
  type RecallReason,
  type RecallSignals,
} from './recall/rank.js';
import {redactSensitiveText} from './scrubber.js';
import {parseResourceId} from './storage/resource-id.js';
import {isThreadnoteStorageLayoutReceipt} from './storage/layout.js';
import type {CommandStatus, JsonObject} from './types.js';
import {getThreadnoteVersion} from './version.js';

export {formatShellCommand, shellQuote, withoutGitEnvironment} from './effect/command.js';

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonConfigObject(content: string): JsonObject | undefined {
  const parsed = Option.getOrUndefined(parseJson(content));
  return isJsonObject(parsed) ? parsed : undefined;
}

const parseJson = Option.liftThrowable((content: string): unknown => JSON.parse(content));
const parseUrlPath = Option.liftThrowable((content: string): string => new URL(content).pathname);

export function redactText(content: string): string {
  return redactSensitiveText(content);
}

export const walkFiles = Effect.fn('utils.walkFiles')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const files: string[] = [];
  const visit = (currentPath: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const pathStat = yield* fs.stat(currentPath).pipe(Effect.option);
      if (pathStat._tag === 'None' || pathStat.value.type === 'SymbolicLink') {
        return;
      }
      if (pathStat.value.type === 'File') {
        files.push(currentPath);
        return;
      }
      if (pathStat.value.type !== 'Directory') {
        return;
      }
      const entries = yield* fs.readDirectory(currentPath);
      for (const entry of entries) {
        yield* visit(pathService.join(currentPath, entry));
      }
    });
  yield* visit(root);
  return files;
});

export function globToRegExp(glob: string): RegExp {
  let output = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      const next = glob[index + 1];
      if (next === '*') {
        const afterNext = glob[index + 2];
        if (afterNext === '/') {
          output += '(?:.*/)?';
          index += 2;
        } else {
          output += '.*';
          index += 1;
        }
      } else {
        output += '[^/]*';
      }
    } else if (char === '?') {
      output += '[^/]';
    } else {
      output += escapeRegExp(char);
    }
  }
  output += '$';
  return new RegExp(output);
}

export function getGlobBase(pattern: string): string {
  const parts = pattern.split('/');
  const baseParts: string[] = [];
  for (const part of parts) {
    if (hasGlob(part)) {
      break;
    }
    baseParts.push(part);
  }
  return baseParts.length === 0 ? '.' : baseParts.join('/');
}

export function hasGlob(path: string): boolean {
  return path.includes('*') || path.includes('?');
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const requiredExecutable = Effect.fn('utils.requiredExecutable')(function* (command: string) {
  const executable = yield* findExecutable([command]);
  if (!executable) {
    return yield* Effect.fail(new Error(`${command} was not found in PATH.`));
  }
  return executable;
});

export const findExecutable = Effect.fn('utils.findExecutable')(function* (commands: readonly string[]) {
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  for (const command of commands) {
    for (const candidate of executablePathCandidatesForCommand(command, pathService, system)) {
      if (yield* isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
});

export const findWorkingExecutable = Effect.fn('utils.findWorkingExecutable')(function* (
  commands: readonly string[],
  args: readonly string[] = ['--version'],
) {
  for (const executable of yield* findExecutableCandidates(commands)) {
    const result = yield* runCommandEffect(executable, args, {allowFailure: true, timeoutMs: 5000});
    if (result.exitCode === 0) {
      return executable;
    }
  }
  return undefined;
});

export const findExecutableCandidates = Effect.fn('utils.findExecutableCandidates')(function* (
  commands: readonly string[],
) {
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    for (const candidate of executablePathCandidatesForCommand(command, pathService, system)) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      if (yield* isExecutable(candidate)) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
});

function executablePathCandidatesForCommand(
  command: string,
  pathService: Path.Path,
  system: SystemInfoShape,
): readonly string[] {
  return pathService.isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? executableNames(command, system.platform, system.environment().PATHEXT)
    : executablePathCandidates(command, pathService, system);
}

function executablePathCandidates(command: string, pathService: Path.Path, system: SystemInfoShape): readonly string[] {
  const pathDirectories = (system.environment().PATH ?? '').split(system.pathDelimiter);
  const names = executableNames(command, system.platform, system.environment().PATHEXT);
  return pathDirectories.flatMap(directory => names.map(name => pathService.join(directory || '.', name)));
}

export function executableNames(
  command: string,
  currentPlatform: NodeJS.Platform,
  pathExt = '.COM;.EXE;.BAT;.CMD',
): readonly string[] {
  if (currentPlatform !== 'win32') {
    return [command];
  }
  const extensions = pathExt
    .split(';')
    .map(extension => extension.trim())
    .filter(Boolean);
  const lowerCommand = command.toLowerCase();
  if (extensions.some(extension => lowerCommand.endsWith(extension.toLowerCase()))) {
    return [command];
  }
  return [...extensions.map(extension => `${command}${extension}`), command];
}

export const maybeRun = Effect.fn('utils.maybeRun')(function* (
  dryRun: boolean,
  executable: string,
  args: readonly string[],
  options: {readonly allowFailure?: boolean; readonly cwd?: string; readonly env?: NodeJS.ProcessEnv} = {},
) {
  return yield* maybeRunEffect(dryRun, executable, args, options);
});

export const runCommand = Effect.fn('utils.runCommand')(function* (
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
) {
  return yield* runCommandEffect(executable, args, options);
});

/**
 * Upper bound (ms) for an `ov reindex --wait true` call. `ov reindex` has no
 * `--timeout` flag, so without a client-side bound a stuck or poisoned semantic
 * queue makes the wait block until the 10-minute default command timeout — the
 * AGFS memory-reindex hang (a `context_type=memory` queue entry pointed at a
 * memory *file* fails on `ls`, re-enqueues forever, and starves the queue). A
 * healthy memory reindex finishes well under this bound; if it doesn't, the
 * queue is stuck and we bail rather than hang (the write already succeeded).
 * Override with THREADNOTE_REINDEX_TIMEOUT_MS.
 */
export const reindexWaitTimeoutMs = Effect.fn('utils.reindexWaitTimeoutMs')(function* () {
  const environment = (yield* SystemInfo).environment();
  return positiveIntegerFromEnv(environment, 'THREADNOTE_REINDEX_TIMEOUT_MS') ?? 120_000;
});

function positiveIntegerFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const value = environment[name];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export const gitValue = Effect.fn('utils.gitValue')(function* (args: readonly string[], cwd?: string) {
  const result = yield* runCommandEffect('git', args, {
    allowFailure: true,
    cwd: cwd ?? (yield* getInvocationCwd()),
  });
  if (result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout.trim();
});

/**
 * Resolves the canonical repository name for `cwd`, returning undefined when it
 * is not inside a git repository.
 *
 * Prefer the git remote repository name so differently named clones of the same
 * repo resolve to the same project. From repos without remotes, fall back to the
 * primary worktree name: linked worktree paths (`git worktree add`, Conductor
 * workspaces, …) often use the branch/workspace name instead of the project.
 */
export const resolveRepoName = Effect.fn('utils.resolveRepoName')(function* (cwd?: string) {
  const resolvedCwd = cwd ?? (yield* getInvocationCwd());
  const repoRoot = yield* gitValue(['rev-parse', '--show-toplevel'], resolvedCwd);
  if (!repoRoot) {
    return undefined;
  }
  const remoteName = yield* resolveGitRemoteRepoName(repoRoot);
  if (remoteName) {
    return remoteName;
  }
  return yield* resolveRepoFolderName(repoRoot);
});

export const resolveRepoFolderName = Effect.fn('utils.resolveRepoFolderName')(function* (cwd?: string) {
  const pathService = yield* Path.Path;
  const repoRoot = yield* gitValue(['rev-parse', '--show-toplevel'], cwd ?? (yield* getInvocationCwd()));
  if (!repoRoot) {
    return undefined;
  }
  const commonDir = yield* gitValue(['rev-parse', '--git-common-dir'], repoRoot);
  if (commonDir) {
    const absoluteCommonDir = pathService.isAbsolute(commonDir) ? commonDir : pathService.resolve(repoRoot, commonDir);
    const primaryRoot =
      pathService.basename(absoluteCommonDir) === '.git' ? pathService.dirname(absoluteCommonDir) : absoluteCommonDir;
    const name = pathService.basename(primaryRoot).replace(/\.git$/, '');
    if (name && name !== '.') {
      return name;
    }
  }
  return pathService.basename(repoRoot);
});

export const resolveGitRemoteRepoName = Effect.fn('utils.resolveGitRemoteRepoName')(function* (repoRoot: string) {
  const originUrl = yield* gitValue(['remote', 'get-url', 'origin'], repoRoot);
  const originName = originUrl ? gitRemoteRepoName(originUrl) : undefined;
  if (originName) {
    return originName;
  }
  const remotes = yield* gitValue(['remote'], repoRoot);
  const remote = remotes
    ?.split(/\r?\n/)
    .map(name => name.trim())
    .find(name => name.length > 0);
  if (!remote) {
    return undefined;
  }
  const remoteUrl = yield* gitValue(['remote', 'get-url', remote], repoRoot);
  return remoteUrl ? gitRemoteRepoName(remoteUrl) : undefined;
});

function gitRemoteRepoName(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsedUrlPath = parseUrlPath(trimmed);
  let remotePath = Option.getOrUndefined(parsedUrlPath) ?? trimmed.replace(/[?#].*$/, '');
  if (Option.isNone(parsedUrlPath)) {
    const scpLike = trimmed.match(/^[^@\s/]+@[^:\s]+:(.+)$/);
    if (scpLike?.[1]) {
      remotePath = scpLike[1];
    }
  }
  const name = remotePath
    .replace(/[\\/]+$/, '')
    .split(/[\\/:]/)
    .filter(Boolean)
    .pop()
    ?.replace(/\.git$/i, '');
  return name && name !== '.' && name !== '..' ? name : undefined;
}

export const runInteractive = Effect.fn('utils.runInteractive')(function* (
  executable: string,
  args: readonly string[],
  options: {readonly env?: NodeJS.ProcessEnv} = {},
) {
  return (yield* runStreamingCommandEffect(executable, args, options)).exitCode;
});

export const httpGetText = Effect.fn('utils.httpGetText')(function* (url: string, timeoutMs: number) {
  return (yield* getTextEffect(url, {timeoutMs})).body;
});

export const sleep = (ms: number) => Effect.sleep(ms);

/**
 * Compare two semver-ish / PEP 440 versions. Returns positive if `a > b`,
 * negative if `a < b`, zero if equal. Build metadata (`+local...`) carries no
 * precedence and is ignored. Pre-releases (`1.2.3-rc1`, `0.4.4rc1`, `.dev0`)
 * sort before the matching release; post-releases (`0.4.4.post1`) sort after
 * it. A non-integer or extra version segment never NaN-collapses a core number
 * to 0 — important so a locally-built `0.4.4+local` is not misread as `0.4.0`.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = left.numbers[index] - right.numbers[index];
    if (difference !== 0) {
      return difference;
    }
  }
  const rankDelta = suffixRank(left.suffix) - suffixRank(right.suffix);
  if (rankDelta !== 0) {
    return rankDelta;
  }
  if (left.suffix === right.suffix) {
    return 0;
  }
  // Same rank class with distinct suffixes (e.g. beta.2 vs beta.10) — use
  // numeric collation so multi-digit prerelease identifiers keep semver order.
  return (left.suffix ?? '').localeCompare(right.suffix ?? '', 'en', {numeric: true});
}

/** PEP 440 post-releases sort after the release; pre/dev releases before it. */
function suffixRank(suffix: string | undefined): number {
  if (suffix === undefined) {
    return 0;
  }
  return /^post/i.test(suffix) ? 1 : -1;
}

function parseVersion(version: string): {
  readonly numbers: readonly [number, number, number];
  readonly suffix?: string;
} {
  // Drop a leading `v` and build metadata (`+local...`), then split the numeric
  // core off any pre/post/dev suffix. PEP 440 attaches the suffix without a
  // separator (`0.4.4rc1`, `0.4.4.post1`); semver uses a dash (`0.4.4-rc1`).
  // Parsing each core segment as a leading integer keeps a non-numeric tail
  // from collapsing the segment to 0.
  const normalized = version.trim().replace(/^v/, '').split('+', 1)[0];
  const core = normalized.match(/^\d+(?:\.\d+){0,2}/)?.[0] ?? '';
  const rawSuffix = normalized.slice(core.length).replace(/^[-_.]/, '');
  // Only a string with a numeric core can carry a meaningful suffix; a fully
  // non-numeric version (e.g. `abc`) coerces to 0.0.0 with no suffix.
  const suffix = core.length > 0 && rawSuffix.length > 0 ? rawSuffix : undefined;
  const parts = core.split('.');
  return {
    numbers: [
      safeVersionNumber(Number.parseInt(parts[0] ?? '', 10)),
      safeVersionNumber(Number.parseInt(parts[1] ?? '', 10)),
      safeVersionNumber(Number.parseInt(parts[2] ?? '', 10)),
    ],
    suffix,
  };
}

function safeVersionNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Returns a reconnect notice when a newer threadnote is installed on disk than
 * the version a long-lived process started from — undefined when they match,
 * the disk is older, or either version is unknown. Used by the MCP server to
 * tell callers their resident stdio server is running stale code.
 */
export function formatStaleVersionNotice(
  runningVersion: string | undefined,
  diskVersion: string | undefined,
): string | undefined {
  if (runningVersion === undefined || diskVersion === undefined) {
    return undefined;
  }
  if (compareVersions(diskVersion, runningVersion) <= 0) {
    return undefined;
  }
  return (
    `threadnote ${diskVersion} is installed but this MCP server is still running ${runningVersion}. ` +
    'Reconnect the threadnote MCP server (e.g. /mcp) to load the update.'
  );
}

export const readHttpStatus = Effect.fn('utils.readHttpStatus')((url: string, timeoutMs: number) =>
  getStatusEffect(url, {timeoutMs}).pipe(Effect.catch(() => Effect.succeed(undefined))),
);

export const isTcpPortOpen = Effect.fn('utils.isTcpPortOpen')((host: string, port: number, timeoutMs: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const connected = yield* Deferred.make<boolean>();
      const socket = yield* BunSocket.makeNet({host, port});
      yield* socket
        .run(() => undefined, {onOpen: Deferred.succeed(connected, true)})
        .pipe(
          Effect.catch(() => Deferred.succeed(connected, false)),
          Effect.forkScoped,
        );
      return yield* Deferred.await(connected).pipe(
        Effect.timeoutOrElse({duration: timeoutMs, orElse: () => Effect.succeed(false)}),
      );
    }),
  ),
);

export const getInputText = Effect.fn('utils.getInputText')(function* (
  optionText: string | undefined,
  useStdin: boolean,
) {
  if (optionText !== undefined) {
    return optionText;
  }
  if (!useStdin) {
    return '';
  }
  const stdio = yield* Stdio.Stdio;
  return yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.runFold(
      () => '',
      (output, chunk) => `${output}${chunk}`,
    ),
  );
});

export const ensureDirectory = Effect.fn('utils.ensureDirectory')(function* (path: string, dryRun: boolean) {
  if (dryRun) {
    yield* Console.log(`Would create directory: ${path}`);
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(path, {recursive: true});
});

export const exists = Effect.fn('utils.exists')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(path);
});

export const isExecutable = Effect.fn('utils.isExecutable')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const info = yield* fs.stat(path).pipe(Effect.option);
  return (
    info._tag === 'Some' &&
    info.value.type === 'File' &&
    (system.platform === 'win32' || (info.value.mode & 0o111) !== 0)
  );
});

export function suggestedShellRc(shellPath: string | undefined, currentPlatform: NodeJS.Platform): string {
  const shell = shellPath ?? '';
  if (shell.endsWith('/zsh')) {
    return '~/.zshrc';
  }
  if (shell.endsWith('/bash')) {
    return currentPlatform === 'darwin' ? '~/.bash_profile' : '~/.bashrc';
  }
  if (shell.endsWith('/fish')) {
    return '~/.config/fish/config.fish';
  }
  return 'your shell rc';
}

export const isFile = Effect.fn('utils.isFile')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  return info._tag === 'Some' && info.value.type === 'File';
});

export const isDirectory = Effect.fn('utils.isDirectory')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  return info._tag === 'Some' && info.value.type === 'Directory';
});

export const readFileIfExists = Effect.fn('utils.readFileIfExists')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path).pipe(Effect.option, Effect.map(Option.getOrUndefined));
});

export const removePathIfExists = Effect.fn('utils.removePathIfExists')(function* (
  path: string,
  label: string,
  dryRun: boolean,
) {
  if (!(yield* exists(path))) {
    yield* Console.log(`Already absent: ${path}`);
    return;
  }
  yield* removePath(path, label, dryRun);
});

export const removePath = Effect.fn('utils.removePath')(function* (path: string, label: string, dryRun: boolean) {
  if (dryRun) {
    yield* Console.log(`Would remove ${label}: ${path}`);
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(path, {force: true, recursive: true});
  yield* Console.log(`Removed ${label}: ${path}`);
});

export function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

export function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

export function assertResourceUri(uri: string): void {
  parseResourceId(uri);
}

export function collectOption(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

export const expandPath = Effect.fn('utils.expandPath')(function* (path: string) {
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  if (path === '~') {
    return system.homeDirectory;
  }
  if (path.startsWith(`~${pathService.sep}`) || path.startsWith('~/')) {
    return pathService.join(system.homeDirectory, path.slice(2));
  }
  return pathService.isAbsolute(path) ? path : pathService.resolve(yield* getInvocationCwd(), path);
});

export const assertSafeThreadnoteHomeForErase = Effect.fn('utils.assertSafeThreadnoteHomeForErase')(function* (
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  const resolvedPath = pathService.resolve(home);
  const resolvedUserHome = pathService.resolve(system.homeDirectory);
  const comparable = (value: string) => (system.platform === 'win32' ? value.toLowerCase() : value);
  if (
    comparable(resolvedPath) === comparable(pathService.parse(resolvedPath).root) ||
    comparable(resolvedPath) === comparable(resolvedUserHome) ||
    comparable(resolvedPath) === comparable(pathService.dirname(resolvedUserHome))
  ) {
    return yield* Effect.fail(new Error(`Refusing to erase unsafe THREADNOTE_HOME: ${resolvedPath}`));
  }
  if ((yield* fs.readLink(resolvedPath).pipe(Effect.option))._tag === 'Some') {
    return yield* Effect.fail(new Error(`Refusing to erase symbolic-link THREADNOTE_HOME: ${resolvedPath}`));
  }
  const homeInfo = yield* fs.stat(resolvedPath).pipe(Effect.option);
  if (Option.isNone(homeInfo) || homeInfo.value.type !== 'Directory') {
    return yield* Effect.fail(new Error(`Refusing to erase invalid THREADNOTE_HOME directory: ${resolvedPath}`));
  }
  const receiptPath = pathService.join(resolvedPath, 'layout.json');
  if ((yield* fs.readLink(receiptPath).pipe(Effect.option))._tag === 'Some') {
    return yield* Effect.fail(new Error(`Refusing to trust symbolic-link Threadnote layout receipt: ${receiptPath}`));
  }
  const receiptInfo = yield* fs.stat(receiptPath).pipe(Effect.option);
  if (Option.isNone(receiptInfo) || receiptInfo.value.type !== 'File') {
    return yield* Effect.fail(
      new Error(`Refusing to erase unowned THREADNOTE_HOME without a valid layout receipt: ${resolvedPath}`),
    );
  }
  const receipt = yield* fs.readFileString(receiptPath).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => JSON.parse(content) as unknown,
        catch: () => new Error(`Refusing to erase THREADNOTE_HOME with an invalid layout receipt: ${resolvedPath}`),
      }),
    ),
  );
  if (!isThreadnoteStorageLayoutReceipt(receipt)) {
    return yield* Effect.fail(
      new Error(`Refusing to erase THREADNOTE_HOME with an invalid or unsupported layout receipt: ${resolvedPath}`),
    );
  }
  return resolvedPath;
});

export const portablePath = Effect.fn('utils.portablePath')(function* (path: string) {
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  const home = system.homeDirectory;
  const resolvedPath = pathService.resolve(path);
  if (resolvedPath === home) {
    return '~';
  }
  if (resolvedPath.startsWith(`${home}${pathService.sep}`)) {
    return `~/${resolvedPath
      .slice(home.length + 1)
      .split(pathService.sep)
      .join('/')}`;
  }
  return resolvedPath;
});

export const getInvocationCwd = Effect.fn('utils.getInvocationCwd')(function* () {
  const system = yield* SystemInfo;
  return system.environment().THREADNOTE_CALLER_CWD ?? system.currentDirectory();
});

export function recallQueryRequestsWorkspaceContext(query: string): boolean {
  const normalized = query.toLowerCase();
  return /\b(?:this|current)\s+(?:branch|repo|repository|workspace|worktree)\b/.test(normalized);
}

export const enrichRecallQueryWithWorkspaceContext = Effect.fn('utils.enrichRecallQueryWithWorkspaceContext')(
  function* (query: string, options: {readonly cwd?: string; readonly includeProcessCwd?: boolean} = {}) {
    return yield* enrichRecallQueryWithWorkspaceTerms(query, options, true);
  },
);

export const enrichRecallQueryWithWorkspaceProjectContext = Effect.fn(
  'utils.enrichRecallQueryWithWorkspaceProjectContext',
)(function* (query: string, options: {readonly cwd?: string; readonly includeProcessCwd?: boolean} = {}) {
  return yield* enrichRecallQueryWithWorkspaceTerms(query, options, false);
});

export const resolveWorkspaceRepoName = Effect.fn('utils.resolveWorkspaceRepoName')(function* (
  options: {readonly cwd?: string; readonly includeProcessCwd?: boolean} = {},
) {
  const pathService = yield* Path.Path;
  const cwd = options.cwd ?? (options.includeProcessCwd === false ? undefined : yield* getInvocationCwd());
  if (!cwd || !pathService.isAbsolute(cwd)) {
    return undefined;
  }
  return yield* resolveRepoName(cwd);
});

const enrichRecallQueryWithWorkspaceTerms = Effect.fn('utils.enrichRecallQueryWithWorkspaceTerms')(function* (
  query: string,
  options: {readonly cwd?: string; readonly includeProcessCwd?: boolean},
  includeBranch: boolean,
) {
  if (!recallQueryRequestsWorkspaceContext(query)) {
    return query;
  }
  const terms = yield* currentWorkspaceRecallTerms(options, includeBranch);
  const additions = terms.filter(term => !query.toLowerCase().includes(term.toLowerCase()));
  return additions.length > 0 ? `${query} ${additions.join(' ')}` : query;
});

const currentWorkspaceRecallTerms = Effect.fn('utils.currentWorkspaceRecallTerms')(function* (
  options: {
    readonly cwd?: string;
    readonly includeProcessCwd?: boolean;
  },
  includeBranch: boolean,
) {
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  const cwd = options.cwd ?? (options.includeProcessCwd === false ? undefined : yield* getInvocationCwd());
  if (!cwd || !pathService.isAbsolute(cwd)) {
    return [];
  }
  const repoRoot = yield* gitValue(['rev-parse', '--show-toplevel'], cwd);
  if (!repoRoot) {
    return [];
  }
  const branch = yield* gitValue(['branch', '--show-current'], repoRoot);
  const repoName = yield* resolveWorkspaceRepoName({cwd, includeProcessCwd: false});
  const parent = pathService.dirname(repoRoot);
  return uniqueUsefulWorkspaceTerms([
    {source: 'branch', value: includeBranch ? branch : undefined},
    {source: 'path', value: repoName},
    {source: 'path', value: parent === system.homeDirectory ? undefined : pathService.basename(parent)},
  ]);
});

export function uniqueUsefulWorkspaceTerms(
  values: readonly {readonly source: 'branch' | 'path'; readonly value: string | undefined}[],
): readonly string[] {
  const ignored = new Set(['repos', 'repositories', 'workspaces', 'worktrees']);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const {source, value} of values) {
    const term = value?.trim();
    const normalized = term?.toLowerCase();
    const tooShort = source === 'branch' ? false : (term?.length ?? 0) < 4;
    if (!term || !normalized || tooShort || ignored.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    terms.push(term);
  }
  return terms;
}

export function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

export function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function parentResourceUri(uri: string): string {
  const trimmedUri = trimTrailingSlash(uri);
  const slashIndex = trimmedUri.lastIndexOf('/');
  return slashIndex <= 'threadnote://'.length ? trimmedUri : trimmedUri.slice(0, slashIndex);
}

export const sha256 = sha256Hex;

export function exactRecallTerms(query: string): readonly string[] {
  const stopWords = new Set([
    'about',
    'after',
    'agent',
    'anything',
    'been',
    'branch',
    'case',
    'current',
    'does',
    'durable',
    'find',
    'feature',
    'features',
    'from',
    'handoff',
    'have',
    'into',
    'issue',
    'issues',
    'knowledge',
    'latest',
    'memory',
    'memories',
    'project',
    'recall',
    'repo',
    'repository',
    'related',
    'search',
    'stored',
    'than',
    'that',
    'them',
    'then',
    'they',
    'this',
    'the',
    'were',
    'what',
    'when',
    'which',
    'while',
    'with',
    'workspace',
    'worktree',
    'your',
  ]);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of query.matchAll(/[A-Za-z0-9_.-]{3,}/g)) {
    const term = match[0];
    const shortDistinctive = term.length === 3 && ((term.match(/[A-Z]/g) ?? []).length >= 2 || /[0-9]/.test(term));
    if (term.length < 4 && !shortDistinctive) {
      continue;
    }
    const normalized = term.toLowerCase();
    if (stopWords.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    terms.push(term);
  }
  return terms.sort((left, right) => exactRecallTermScore(right) - exactRecallTermScore(left)).slice(0, 4);
}

export function grepOutputHasMatches(output: string): boolean {
  return (
    !output.includes('matches        []') && !output.includes('"matches":[]') && !output.includes('match_count    0')
  );
}

/**
 * Minimum `ov search` relevance score for recall. A conservative floor that
 * drops only the clearly-irrelevant tail while keeping mid-relevance hits;
 * passed to `ov search --threshold`. Observed strong hits sit ~0.70+, so 0.45
 * trims noise without risking useful results on lower-scoring queries.
 * Overridable per-call (recall `--threshold` / the `threshold` MCP arg) and
 * globally via THREADNOTE_RECALL_THRESHOLD, matching the THREADNOTE_* env
 * convention used for command timeout/output caps.
 */
export const recallScoreThreshold = Effect.fn('utils.recallScoreThreshold')(function* () {
  return (yield* SystemInfo).environment().THREADNOTE_RECALL_THRESHOLD?.trim() || '0.45';
});

export type ExactScopeIntent = 'durable' | 'handoffs' | 'incidents' | 'preferences';

// Patterns favour specific, intentful phrasing over common dev vocabulary so an
// incidental "design"/"interface" mention does not narrow the grep to durable
// only. The semantic pass stays unscoped, so a missed intent never hides a hit.
const EXACT_SCOPE_INTENT_PATTERNS: ReadonlyArray<readonly [ExactScopeIntent, RegExp]> = [
  ['preferences', /\b(preferences?|prefer|styles?|tone|voice|writing|persona|communication)\b/i],
  ['handoffs', /\b(handoffs?|status|next step|in progress|wip|current work|where .* left)\b/i],
  ['durable', /\b(durable|feature knowledge|design decisions?|invariants?|api contract|gotchas?)\b/i],
  ['incidents', /\b(incidents?|outage|post-?mortem|on-?call|escalation)\b/i],
];

/**
 * Infer which personal-memory scopes a recall query is actually about, so the
 * exact-term grep targets e.g. `preferences` for a "writing style" query
 * instead of every scope. Empty set means "intent unclear" — the caller should
 * fall back to a broad search. The semantic pass stays unscoped regardless, so
 * a wrong guess here only narrows the exact-match pointers, not retrieval.
 */
export function exactRecallScopeIntents(query: string): ReadonlySet<ExactScopeIntent> {
  const intents = new Set<ExactScopeIntent>();
  for (const [intent, pattern] of EXACT_SCOPE_INTENT_PATTERNS) {
    if (pattern.test(query)) {
      intents.add(intent);
    }
  }
  return intents;
}

/**
 * A `.overview.md` (Level 1) or `.abstract.md` (Level 0) summary sidecar. With
 * Legacy summary auto-generation off (Threadnote's default) these are
 * permanent "[Directory ... not ready]" placeholders, so they are noise in
 * recall and must never surface as results or pointers.
 */
export function isSummarySidecarUri(uri: string): boolean {
  return /\.(?:overview|abstract)\.md(?:#|$)/.test(uri);
}

/**
 * Internal agent-artifact machinery — shareable-pack manifests and the prompt
 * fragments bundled under them (`.../agent-artifacts/packs/...`). These are
 * tooling, not recallable knowledge: a reviewer pack lists many review
 * dimensions ("observability", "rollout", ...) so it lexically matches almost
 * any query and floods recall. Filtered out like summary sidecars. Top-level
 * shared skills (`.../agent-artifacts/skills/.../SKILL.md`) stay discoverable
 * and are placed in the skills category by `categoryForUri`.
 */
export function isAgentArtifactPackUri(uri: string): boolean {
  return /\/agent-artifacts\/packs\//.test(uri);
}

/**
 * A URI that must never surface in recall — summary sidecars or agent-artifact
 * pack machinery. Shared by the semantic (`parseRecallHits`) and exact
 * (`grepUrisFromJson`) passes so their exclusion set cannot drift.
 */
export function isExcludedRecallUri(uri: string): boolean {
  return isSummarySidecarUri(uri) || isAgentArtifactPackUri(uri);
}

/**
 * The project directory segment a memory URI is stored under, or undefined for
 * kinds that carry no project (preferences, smoke), a directory node, or a
 * non-memory URI. Shared team memories (`.../memories/shared/<team>/...`) are
 * de-scoped to their underlying kind first, so both personal and shared layouts
 * resolve the same way. Used by the doctor project-consistency check to compare
 * a memory's storage location against its frontmatter `project`.
 */
export function memoryUriProjectSegment(uri: string): string | undefined {
  const marker = '/memories/';
  const at = uri.indexOf(marker);
  if (at < 0) {
    return undefined;
  }
  let segments = stripAnchor(uri)
    .slice(at + marker.length)
    .split('/')
    .filter(Boolean);
  if (segments[0] === 'shared') {
    segments = segments.slice(2); // drop "shared" and the team name
  }
  // durable/handoffs/incidents store <kind>/<status|projects>/<project>/<file…>;
  // require a file after the project segment so directory nodes are ignored.
  const [kind, , project, ...rest] = segments;
  if ((kind === 'durable' || kind === 'handoffs' || kind === 'incidents') && project && rest.length > 0) {
    return project;
  }
  return undefined;
}

/**
 * Read a single frontmatter field (e.g. `project`) from a memory document — the
 * value after `<field>: ` on its own line within the leading header block (the
 * text before the first blank line). Returns undefined when the field is absent.
 */
export function memoryFrontmatterField(content: string, field: string): string | undefined {
  const blankLine = content.indexOf('\n\n');
  const header = blankLine < 0 ? content : content.slice(0, blankLine);
  // `[ \t]*` (not `\s*`) so the value cannot span into the next header line.
  const match = header.match(new RegExp(`^${escapeRegExp(field)}:[ \\t]*(.+)$`, 'm'));
  return match?.[1]?.trim() || undefined;
}

/**
 * Extract the matched resource URIs from `ov grep --output json` stdout, minus
 * summary sidecars. The CLI prints a `cmd: ...` banner before the JSON, so
 * parse from the first line that starts with `{` (robust to braces in the
 * banner). Returns [] on any shape mismatch — exact matches are best-effort.
 */
export function grepUrisFromJson(output: string): readonly string[] {
  const start = output.search(/^\{/m);
  if (start < 0) {
    return [];
  }
  const parsed = Option.getOrUndefined(parseJson(output.slice(start)));
  const result = isJsonObject(parsed) ? parsed.result : undefined;
  const matches = isJsonObject(result) ? result.matches : undefined;
  if (!Array.isArray(matches)) {
    return [];
  }
  const uris: string[] = [];
  for (const match of matches) {
    if (isJsonObject(match) && typeof match.uri === 'string' && !isExcludedRecallUri(match.uri)) {
      uris.push(match.uri);
    }
  }
  return uris;
}

export interface ExactMatch {
  readonly terms: readonly string[];
  readonly uri: string;
}

/**
 * Result buckets in the order recall presents them: memories first, then seeded
 * resources, then skills. The index doubles as the primary sort key so a
 * lower-scoring memory still ranks above a higher-scoring resource or skill.
 */
export const RECALL_CATEGORY_ORDER = ['memories', 'resources', 'skills'] as const;
export type RecallCategory = (typeof RECALL_CATEGORY_ORDER)[number];

export interface RecallHit {
  readonly category: RecallCategory;
  readonly contextType: string;
  /**
   * Query terms this document matched exactly (lexically) via grep. Present when
   * an exact-match pass corroborates a semantic hit, or when the document was
   * promoted into the ranked list from the exact-match pass alone (in which case
   * `score` is 0 — there was no semantic hit). Empty/undefined for plain
   * semantic hits.
   */
  readonly exactTerms?: readonly string[];
  readonly finalScore?: number;
  readonly rankReasons?: readonly RecallReason[];
  readonly rankSignals?: RecallSignals;
  readonly rankWarnings?: readonly string[];
  readonly score: number;
  readonly snippet: string;
  readonly uri: string;
}

/**
 * Score assigned to a document promoted into the ranked list from the
 * exact-match pass alone (no semantic hit). It is never displayed as a score —
 * `formatRecallHits` renders these as `exact match` — and the category-then-
 * exact-term-count sort keys place them ahead of unmatched semantic hits in
 * their category regardless of this value.
 */
const RECALL_PROMOTED_EXACT_SCORE = 0;

interface ParseRecallHitsOptions {
  readonly includeArchived?: boolean;
}

function recallSnippet(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > 180 ? `${oneLine.slice(0, 180)}…` : oneLine;
}

function isArchivedMemoryUri(uri: string): boolean {
  const documentUri = uri.replace(/#.*$/, '');
  return /^threadnote:\/\/user\/[^/]+\/memories\/(?:durable|handoffs|incidents|preferences|smoke)\/archived(?:\/|$)/.test(
    documentUri,
  );
}

/**
 * Parse `ov search --output json` stdout into recall hits across the memories,
 * resources, and skills result arrays, dropping summary sidecars and trimming
 * each abstract to a short snippet. Tolerant of the leading `cmd:` banner and
 * shape drift; returns [] on parse failure.
 */
export function parseRecallHits(output: string, options: ParseRecallHitsOptions = {}): readonly RecallHit[] {
  const start = output.search(/^\{/m);
  if (start < 0) {
    return [];
  }
  const parsed = Option.getOrUndefined(parseJson(output.slice(start)));
  const result = isJsonObject(parsed) ? parsed.result : undefined;
  if (!isJsonObject(result)) {
    return [];
  }
  const hits: RecallHit[] = [];
  for (const key of RECALL_CATEGORY_ORDER) {
    const items = result[key];
    if (!Array.isArray(items)) {
      continue;
    }
    for (const item of items) {
      if (!isJsonObject(item) || typeof item.uri !== 'string') {
        continue;
      }
      let uri: string;
      try {
        uri = parseResourceId(item.uri).canonicalUri;
      } catch {
        continue;
      }
      if (isExcludedRecallUri(uri)) {
        continue;
      }
      if (options.includeArchived !== true && isArchivedMemoryUri(uri)) {
        continue;
      }
      hits.push({
        category: key,
        contextType: typeof item.context_type === 'string' ? item.context_type : 'result',
        score: typeof item.score === 'number' ? item.score : 0,
        snippet: recallSnippet(item.abstract ?? item.overview),
        uri,
      });
    }
  }
  return hits;
}

/** Drop a chunk anchor (`#chunk_0001`) so a URI addresses its document. */
function stripAnchor(uri: string): string {
  return uri.replace(/#.*$/, '');
}

/**
 * Merge recall hits from several search passes into one ranked list, deduped to
 * one entry per document (chunk anchors stripped), keeping the highest-scoring
 * chunk. Lets the scoped project/seeded passes contribute only documents the
 * global pass missed, and collapses multiple chunks of the same document.
 *
 * Ranking is category-first (memories, then resources, then skills per
 * `RECALL_CATEGORY_ORDER`), then by score within each category, so personal
 * memories always lead and seeded resources/skills only follow. Content-level
 * dedup is applied later by `buildRecallSections`, after exact-match boosting,
 * so a collapsed twin never strips the exact-matched copy.
 */
export function mergeRecallHits(passes: ReadonlyArray<readonly RecallHit[]>): readonly RecallHit[] {
  const byDocument = new Map<string, RecallHit>();
  for (const pass of passes) {
    for (const hit of pass) {
      const documentUri = stripAnchor(hit.uri);
      const existing = byDocument.get(documentUri);
      if (!existing || hit.score > existing.score) {
        byDocument.set(documentUri, {...hit, uri: documentUri});
      }
    }
  }
  return [...byDocument.values()].sort(
    (left, right) => recallCategoryRank(left.category) - recallCategoryRank(right.category) || right.score - left.score,
  );
}

/**
 * Sort index for a category. Unknown categories rank last so a future bucket
 * never silently jumps ahead of memories.
 */
function recallCategoryRank(category: RecallCategory): number {
  const index = RECALL_CATEGORY_ORDER.indexOf(category);
  return index === -1 ? RECALL_CATEGORY_ORDER.length : index;
}

/**
 * Collapse resource/skill hits that share identical snippet content but live at
 * different URIs — e.g. a repo that keeps the same SKILL.md under both
 * `.agents/skills/` and `.claude/skills/`, which would otherwise consume several
 * ranked slots for one logical document. Keeps the first (highest-ranked, since
 * the input is already sorted) occurrence. Memories are never collapsed: their
 * templated `MEMORY kind: ... project: ... topic: ...` header makes truncated
 * snippets prone to colliding across genuinely distinct memories.
 */
function dedupeByContent(hits: readonly RecallHit[]): readonly RecallHit[] {
  const seen = new Set<string>();
  const kept: RecallHit[] = [];
  for (const hit of hits) {
    if (hit.category !== 'memories' && hit.snippet.length > 0) {
      const key = `${hit.category}\n${hit.snippet}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    kept.push(hit);
  }
  return kept;
}

/**
 * Infer a recall category for a document URI, used to place exact-match-only
 * documents (promoted into the ranked list without a semantic hit) into the
 * right group. Keeps search results grouped by personal/shared
 * memories under `.../memories/...`, the global skill catalog under
 * `resources/agent-skills/`, everything else (including repo-embedded skills) as
 * a resource.
 */
export function categoryForUri(uri: string): RecallCategory {
  // Shared agent artifacts live under `.../memories/.../agent-artifacts/` but
  // are tooling, not personal knowledge — keep them out of the leading memory
  // band. (Pack machinery is dropped entirely upstream; only skills reach here.)
  if (uri.includes('/agent-artifacts/')) {
    return 'skills';
  }
  if (uri.includes('/memories/')) {
    return 'memories';
  }
  if (uri.startsWith('threadnote://resources/agent-skills/')) {
    return 'skills';
  }
  return 'resources';
}

function contextTypeForCategory(category: RecallCategory): string {
  if (category === 'memories') {
    return 'memory';
  }
  return category === 'skills' ? 'skill' : 'resource';
}

/**
 * Extra weight given to an exact term that also appears in the document's slug
 * (its memory topic or resource filename). A slug match is a title-level signal
 * — the document is *about* that term — whereas a bare body match can be an
 * incidental mention (a branch name in a CI note, "spec" inside "the author's
 * spec doc"). The bonus lets a document whose topic names the query terms lead
 * its category even when those terms are common corpus-wide.
 */
const RECALL_EXACT_SLUG_BONUS = 4;

/** The document slug: last path segment, chunk anchor and extension stripped,
 * lowercased. For a memory this is its topic (`mobile-observability-alerting-spec`),
 * for a resource its filename. */
function uriSlug(uri: string): string {
  const withoutExtension = stripAnchor(uri).replace(/\.[a-z0-9]+$/i, '');
  return withoutExtension.slice(withoutExtension.lastIndexOf('/') + 1).toLowerCase();
}

/**
 * Document frequency of each exact term across the exact-match set: how many
 * matched documents contain it. Used as a self-contained inverse-frequency
 * (IDF-style) signal — no engine stats needed — so a term matching many
 * documents (common, e.g. "background", "rollout") is discounted while a term
 * matching one or two (distinctive, e.g. "sharding") keeps its weight.
 */
function exactTermDocumentFrequency(matches: readonly ExactMatch[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const match of matches) {
    for (const term of new Set(match.terms.map(term => term.toLowerCase()))) {
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
    }
  }
  return frequency;
}

/**
 * Whether the slug names the term as a whole token rather than an incidental
 * substring — matched on non-alphanumeric boundaries (slugs are kebab/snake
 * case) so `spec` boosts `mobile-observability-alerting-spec` but not
 * `design-respec-notes`, while a hyphenated term like `valencia-v1` still
 * matches `coda-valencia-v1-notes`.
 */
function slugNamesTerm(slug: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`).test(slug);
}

/**
 * Combined exact-match strength for a hit — the intra-category sort key that
 * replaced a raw exact-term *count*. Each matched term contributes its inverse
 * document frequency (rare term → up to 1, common term → toward 0), multiplied
 * by `RECALL_EXACT_SLUG_BONUS` when the term names the document's slug. A doc
 * matched only by common terms in its body scores ~0 and falls back to semantic
 * order; a doc whose topic names distinctive query terms leads its category.
 */
function exactMatchStrength(hit: RecallHit, documentFrequency: ReadonlyMap<string, number>): number {
  if (!hit.exactTerms?.length) {
    return 0;
  }
  const slug = uriSlug(hit.uri);
  let strength = 0;
  for (const term of hit.exactTerms) {
    const normalized = term.toLowerCase();
    // `?? 1` is defensive only: exactTerms is always a subset of the terms the
    // documentFrequency map was built from, so the lookup resolves in practice.
    const rarity = 1 / (documentFrequency.get(normalized) ?? 1);
    strength += rarity * (slugNamesTerm(slug, normalized) ? RECALL_EXACT_SLUG_BONUS : 1);
  }
  return strength;
}

/**
 * Fold exact (lexical) matches into the semantically-ranked hits so the lexical
 * signal drives ranking rather than sitting in a separate afterthought section.
 * Semantic hits that a term also matched are annotated with `exactTerms`;
 * exact-match documents with no semantic hit are promoted in as fresh hits with
 * `score` 0. The result is re-sorted category-first, then by exact-match
 * *strength* (see `exactMatchStrength`), then by semantic score.
 *
 * Ranking by weighted strength rather than raw term count is deliberate: a
 * distinctive exact match (a rare term, or one that names the document's topic)
 * still outranks an unmatched semantic hit in its category — the intended
 * high-precision behaviour — but a document matched only by common words in its
 * body no longer floods the top, because inverse-document-frequency drives those
 * terms toward zero. The intra-category key is `exactMatchStrength + score`, so
 * a strong exact match (strength ≥ 1) leads regardless of semantic score while a
 * weak common-word-only promotion (strength ≪ 1) sits below a genuine semantic
 * hit instead of over-correcting into keyword flooding.
 */
export function applyExactMatchBoost(
  hits: readonly RecallHit[],
  exactMatches: readonly ExactMatch[],
): readonly RecallHit[] {
  if (exactMatches.length === 0) {
    return hits;
  }
  const termsByUri = new Map(exactMatches.map(match => [stripAnchor(match.uri), match.terms]));
  const annotated = hits.map(hit => {
    const terms = termsByUri.get(stripAnchor(hit.uri));
    return terms ? {...hit, exactTerms: terms} : hit;
  });
  const present = new Set(annotated.map(hit => stripAnchor(hit.uri)));
  const promoted: RecallHit[] = [...termsByUri.keys()]
    .filter(uri => !present.has(uri))
    .map(uri => {
      const category = categoryForUri(uri);
      return {
        category,
        contextType: contextTypeForCategory(category),
        exactTerms: termsByUri.get(uri) ?? [],
        score: RECALL_PROMOTED_EXACT_SCORE,
        snippet: '',
        uri,
      };
    });
  const documentFrequency = exactTermDocumentFrequency(exactMatches);
  const merged = [...annotated, ...promoted];
  // Hoist the blended relevance (exact strength + semantic score) into an O(n)
  // pre-pass, keyed by document URI (anchors stripped, matching termsByUri), so
  // the comparator stays a cheap lookup and every hit resolves.
  const combinedRelevanceByUri = new Map<string, number>();
  for (const hit of merged) {
    combinedRelevanceByUri.set(stripAnchor(hit.uri), exactMatchStrength(hit, documentFrequency) + hit.score);
  }
  return merged.sort(
    (left, right) =>
      recallCategoryRank(left.category) - recallCategoryRank(right.category) ||
      (combinedRelevanceByUri.get(stripAnchor(right.uri)) ?? 0) -
        (combinedRelevanceByUri.get(stripAnchor(left.uri)) ?? 0) ||
      right.score - left.score,
  );
}

export function formatRecallHits(hits: readonly RecallHit[], maxHits: number): string | undefined {
  return renderRecallHits(hits.slice(0, maxHits), Math.max(0, hits.length - maxHits));
}

/**
 * Leading note shown when every hit in the window is a keyword-only (score 0)
 * promotion — i.e. no semantic pass matched above the recall threshold. It marks
 * the difference between "here is what the corpus knows about this" and "nothing
 * semantically matched; these merely contain the words", so an agent does not
 * mistake keyword noise for coverage of an absent topic.
 */
export const RECALL_LOW_CONFIDENCE_NOTE =
  '⚠ No semantically-relevant matches — the results below only contain the query words (the corpus may not cover this topic).';

/**
 * Render an already-decided shown window into the numbered recall list. Keeping
 * the slice out of here lets `buildRecallSections` compute the shown set once and
 * feed both the rendering and the exact-tail "already shown" filter from the same
 * list. `overflow` is the count of hits beyond the window, for the trailing note.
 *
 * A promoted exact-only hit (score 0) is labelled `keyword-only:` rather than
 * `exact:` so it is visibly distinct from a semantic hit that a term also
 * corroborated; when the whole window is keyword-only, a low-confidence note
 * leads the list.
 */
function renderRecallHits(
  shown: readonly RecallHit[],
  overflow: number,
  confidence?: RecallConfidence,
): string | undefined {
  if (shown.length === 0) {
    return confidence?.level === 'no_answer'
      ? `⚠ Recall confidence: no answer (${confidence.score.toFixed(2)}) — ${confidence.reason}`
      : undefined;
  }
  const lines = shown.flatMap((hit, index) => {
    const finalScorePart = hit.finalScore === undefined ? undefined : `rank ${hit.finalScore.toFixed(2)}`;
    const scorePart = hit.score > 0 ? `score ${hit.score.toFixed(2)}` : undefined;
    const exactLabel = hit.score > 0 ? 'exact' : 'keyword-only';
    const exactPart = hit.exactTerms?.length ? `${exactLabel}: ${hit.exactTerms.join(', ')}` : undefined;
    const head = `${index + 1}. ${[hit.contextType, finalScorePart, scorePart, exactPart].filter(Boolean).join(' · ')} · ${hit.uri}`;
    const explanation = hit.rankReasons?.length
      ? `   why: ${hit.rankReasons
          .slice(0, 3)
          .map(reason => `${reason.code} ${reason.contribution >= 0 ? '+' : ''}${reason.contribution.toFixed(2)}`)
          .join('; ')}`
      : undefined;
    const warnings = hit.rankWarnings?.length ? `   warning: ${hit.rankWarnings.join('; ')}` : undefined;
    return [head, hit.snippet ? `   ${hit.snippet}` : undefined, explanation, warnings].filter(
      (line): line is string => line !== undefined,
    );
  });
  if (overflow > 0) {
    lines.push(`(+${overflow} more — refine the query or read a URI above)`);
  }
  const noSemanticMatch = shown.every(hit => hit.score === 0);
  const showLowConfidenceNote =
    noSemanticMatch && (confidence === undefined || confidence.level === 'low' || confidence.level === 'no_answer');
  const confidenceLine = confidence
    ? `Recall confidence: ${confidence.level.replace('_', ' ')} (${confidence.score.toFixed(2)}) — ${confidence.reason}`
    : undefined;
  return [
    ...(confidenceLine ? [confidenceLine] : []),
    ...(showLowConfidenceNote ? [RECALL_LOW_CONFIDENCE_NOTE] : []),
    ...lines,
  ].join('\n');
}

export interface RecallSections {
  /** Result-set confidence from the hybrid ranker. */
  readonly confidence?: RecallConfidence;
  /**
   * Final ranked hits (merged, exact-boosted, content-deduped). Exposed for
   * tests and inspection; the CLI and MCP callers emit the rendered sections.
   */
  readonly ranked: readonly RecallHit[];
  /** Rendered ranked list, capped at `limit`. Undefined when there are no hits. */
  readonly semanticSection: string | undefined;
  /** Legacy exact-match pointer list. Hybrid recall incorporates exact evidence into ranking and leaves this empty. */
  readonly exactTail: string | undefined;
}

/**
 * Slots reserved per category in the shown window so a memory-heavy result set
 * does not crowd seeded resources and skills out of view entirely. Memories
 * still lead and still take every slot the reserve pass leaves over.
 */
export const RECALL_CATEGORY_RESERVE = 2;
const RECALL_INDEX_PRESELECTION_MULTIPLIER = 10;
const RECALL_INDEX_PRESELECTION_MINIMUM = 100;

interface HybridRecallOptions {
  readonly allowExactRescue?: boolean;
  readonly allowedUriScopes?: readonly string[];
  readonly candidateUris?: readonly string[];
  readonly corpusStatistics?: RecallCorpusStatistics;
  readonly feedbackByUri?: ReadonlyMap<string, number>;
  readonly includeInactive?: boolean;
  readonly indexedCandidates?: readonly RecallCandidate[];
  readonly minimumScore?: number;
  readonly now?: Date;
  readonly project?: string;
  readonly query: string;
  readonly queryVariants?: readonly string[];
  readonly records?: readonly MemoryRecord[];
  readonly seedUris?: readonly string[];
}

/**
 * Pick which `limit` hits fill the shown window. A reserve pass first takes up
 * to `reserve` hits from each category in `RECALL_CATEGORY_ORDER` priority, so
 * lower-priority categories keep guaranteed visibility; a fill pass then tops
 * the window up from the global rank order (memories first). The selection is
 * returned in the original ranked order — the reserve only changes which hits
 * are shown, never the category-first display order.
 */
function selectShownHits(ranked: readonly RecallHit[], limit: number, reserve: number): readonly RecallHit[] {
  if (ranked.length <= limit) {
    return ranked;
  }
  const selected = new Set<string>();
  for (const category of RECALL_CATEGORY_ORDER) {
    let taken = 0;
    for (const hit of ranked) {
      if (selected.size >= limit || taken >= reserve) {
        break;
      }
      if (hit.category === category && !selected.has(hit.uri)) {
        selected.add(hit.uri);
        taken += 1;
      }
    }
  }
  for (const hit of ranked) {
    if (selected.size >= limit) {
      break;
    }
    selected.add(hit.uri);
  }
  return ranked.filter(hit => selected.has(hit.uri));
}

/**
 * Assemble the two recall output sections shared by the CLI (`runRecall`) and
 * the MCP tool (`runRecallTool`): the ranked semantic list and the exact-match
 * tail. Centralises the ordering — merge → exact-boost → content-dedup — the
 * per-category reserve that decides the shown window, and the rule that the tail
 * only lists exact matches not already surfaced in that window, so the two entry
 * points cannot drift. Callers decide only how to emit.
 */
export function buildRecallSections(
  passes: ReadonlyArray<readonly RecallHit[]>,
  exactMatches: readonly ExactMatch[],
  limit: number,
  ranking?: HybridRecallOptions,
): RecallSections {
  const scopedExactMatches = ranking
    ? exactMatches.filter(match => uriMatchesRecallScopes(match.uri, ranking.allowedUriScopes))
    : exactMatches;
  const legacyRanked = dedupeByContent(
    applyExactMatchBoost(
      mergeRecallHits(passes).filter(hit => uriMatchesRecallScopes(hit.uri, ranking?.allowedUriScopes)),
      scopedExactMatches,
    ),
  );
  const hybrid = ranking ? hybridRankRecallHits(ranking.query, legacyRanked, ranking, limit) : undefined;
  const ranked = hybrid?.ranked ?? legacyRanked;
  const shown = hybrid ? ranked.slice(0, limit) : selectShownHits(ranked, limit, RECALL_CATEGORY_RESERVE);
  const shownUris = new Set(shown.map(hit => stripAnchor(hit.uri)));
  return {
    confidence: hybrid?.confidence,
    exactTail: hybrid
      ? undefined
      : formatExactMatchPointers(scopedExactMatches.filter(match => !shownUris.has(stripAnchor(match.uri)))),
    ranked,
    semanticSection: renderRecallHits(shown, ranked.length - shown.length, hybrid?.confidence),
  };
}

function hybridRankRecallHits(
  query: string,
  hits: readonly RecallHit[],
  context: HybridRecallOptions,
  resultLimit: number,
): {readonly confidence: RecallConfidence; readonly ranked: readonly RecallHit[]} {
  const candidateUris = context.candidateUris ? new Set(context.candidateUris.map(uri => stripAnchor(uri))) : undefined;
  const eligibleHits = candidateUris ? hits.filter(hit => candidateUris.has(stripAnchor(hit.uri))) : hits;
  const byUri = new Map(eligibleHits.map(hit => [stripAnchor(hit.uri), hit]));
  const recordsByUri = new Map(
    (context.records ?? [])
      .filter(record => uriMatchesRecallScopes(record.uri, context.allowedUriScopes))
      .map(record => [stripAnchor(record.uri), record]),
  );
  const scopedIndexedCandidates = boundedRecallIndexCandidates(
    context.indexedCandidates ?? [],
    context.allowedUriScopes,
    resultLimit,
  ).filter(candidate => candidateUris === undefined || candidateUris.has(stripAnchor(candidate.uri)));
  const indexedByUri = new Map(scopedIndexedCandidates.map(candidate => [stripAnchor(candidate.uri), candidate]));
  const hitCandidates = eligibleHits.map(hit => {
    const uri = stripAnchor(hit.uri);
    const record = recordsByUri.get(uri);
    const indexed = indexedByUri.get(uri);
    return {
      ...indexed,
      authority: indexed?.authority ?? (record ? boundedMemoryAuthority(uri, record.metadata) : recallAuthority(hit)),
      exactTerms: hit.exactTerms,
      feedback: context.feedbackByUri?.get(uri),
      fields: {
        identifiers: indexed?.fields?.identifiers,
        keywords: record?.metadata.keywords ?? indexed?.fields?.keywords,
        project:
          record?.metadata.project ??
          indexed?.fields?.project ??
          memoryUriProjectSegment(hit.uri) ??
          resourceProjectFromUri(hit.uri),
        title: indexed?.fields?.title ?? uri.split('/').at(-1) ?? uri,
        topic: record?.metadata.topic ?? indexed?.fields?.topic ?? uriSlug(hit.uri),
      },
      kind: record?.metadata.kind ?? indexed?.kind ?? memoryKindFromUri(hit.uri),
      relations: record
        ? recallRelations(record, context.seedUris ?? [])
        : [...(indexed?.relations ?? []), ...containmentRelations(hit.uri, context.seedUris ?? [])],
      semantic: hit.score,
      status: record?.metadata.status ?? indexed?.status ?? memoryStatusFromUri(hit.uri),
      text: record?.body ?? indexed?.text ?? hit.snippet,
      timestamp: record?.metadata.timestamp ?? indexed?.timestamp,
      trust:
        indexed?.trust ??
        (record
          ? boundedMemoryTrust(uri, record.metadata)
          : hit.category === 'resources'
            ? 'untrusted'
            : isSharedMemoryUri(hit.uri)
              ? 'approved'
              : 'inferred'),
      uri,
      validFrom: record?.metadata.validFrom ?? indexed?.validFrom,
      validTo: record?.metadata.validTo ?? indexed?.validTo,
    } satisfies RecallCandidate;
  });
  const hitUris = new Set(hitCandidates.map(candidate => candidate.uri));
  const candidates = [
    ...hitCandidates,
    ...scopedIndexedCandidates
      .filter(candidate => !hitUris.has(stripAnchor(candidate.uri)))
      .map(candidate => ({
        ...candidate,
        feedback: context.feedbackByUri?.get(stripAnchor(candidate.uri)),
        uri: stripAnchor(candidate.uri),
      })),
  ];
  for (const candidate of candidates) {
    if (!byUri.has(candidate.uri)) {
      const category = categoryForUri(candidate.uri);
      byUri.set(candidate.uri, {
        category,
        contextType: contextTypeForCategory(category),
        score: 0,
        snippet: '',
        uri: candidate.uri,
      });
    }
  }
  const result = rankRecallCandidates(query, candidates, context);
  return {
    confidence: result.confidence,
    ranked:
      result.confidence.level === 'no_answer'
        ? []
        : result.results.map(ranked => {
            const hit = byUri.get(ranked.candidate.uri);
            if (!hit) {
              throw new Error(`Hybrid ranker returned unknown URI: ${ranked.candidate.uri}`);
            }
            return {
              ...hit,
              finalScore: ranked.finalScore,
              rankReasons: ranked.reasons,
              rankSignals: ranked.signals,
              rankWarnings: ranked.warnings,
            };
          }),
  };
}

function uriMatchesRecallScopes(uri: string, scopes: readonly string[] | undefined): boolean {
  if (!scopes || scopes.length === 0) {
    return true;
  }
  const documentUri = stripAnchor(uri);
  return scopes.some(scope => {
    const normalizedScope = stripAnchor(scope).replace(/\/+$/, '');
    return documentUri === normalizedScope || documentUri.startsWith(`${normalizedScope}/`);
  });
}

function boundedRecallIndexCandidates(
  candidates: readonly RecallCandidate[],
  allowedUriScopes: readonly string[] | undefined,
  resultLimit: number,
): readonly RecallCandidate[] {
  const preselectionLimit = Math.max(
    RECALL_INDEX_PRESELECTION_MINIMUM,
    resultLimit * RECALL_INDEX_PRESELECTION_MULTIPLIER,
  );
  const bounded: RecallCandidate[] = [];
  for (const candidate of candidates) {
    if (uriMatchesRecallScopes(candidate.uri, allowedUriScopes)) {
      bounded.push(candidate);
      if (bounded.length >= preselectionLimit) {
        break;
      }
    }
  }
  return bounded;
}

function recallAuthority(hit: RecallHit): 'agent_generated' | 'external' | 'reviewed_shared' {
  if (hit.category === 'resources') {
    return 'external';
  }
  if (isSharedMemoryUri(hit.uri)) {
    return 'reviewed_shared';
  }
  return 'agent_generated';
}

function memoryKindFromUri(uri: string): 'durable' | 'handoff' | 'incident' | 'preference' | 'smoke' | undefined {
  const match = /\/memories\/(?:shared\/[^/]+\/)?(durable|handoffs|incidents|preferences|smoke)\//.exec(uri)?.[1];
  return match === 'handoffs'
    ? 'handoff'
    : match === 'incidents'
      ? 'incident'
      : match === 'preferences'
        ? 'preference'
        : match === 'durable' || match === 'smoke'
          ? match
          : undefined;
}

function memoryStatusFromUri(uri: string): 'active' | 'archived' | 'superseded' | undefined {
  return uri.includes('/archived/')
    ? 'archived'
    : uri.includes('/superseded/')
      ? 'superseded'
      : uri.includes('/memories/')
        ? 'active'
        : undefined;
}

function resourceProjectFromUri(uri: string): string | undefined {
  return /^threadnote:\/\/resources\/repos\/([^/]+)/.exec(uri)?.[1];
}

function recallRelations(record: MemoryRecord, seedUris: readonly string[]): readonly MemoryRelation[] {
  return [
    ...(record.metadata.relations ?? []),
    ...(record.metadata.references ?? []).map(uri => ({type: 'references' as const, uri})),
    ...(record.metadata.evidence ?? [])
      .filter(evidence => evidence.startsWith('threadnote://'))
      .map(uri => ({type: 'evidence_for' as const, uri})),
    ...(record.metadata.supersedes ? [{type: 'supersedes' as const, uri: record.metadata.supersedes}] : []),
    ...containmentRelations(record.uri, seedUris),
  ];
}

function containmentRelations(
  uri: string,
  seedUris: readonly string[],
): readonly {readonly type: 'related_to'; readonly uri: string}[] {
  return seedUris
    .filter(seedUri => uri.startsWith(`${seedUri.replace(/\/$/, '')}/`))
    .map(seedUri => ({type: 'related_to' as const, uri: seedUri}));
}

/**
 * Build the exact-term grep scopes for a recall. Intent (from
 * `exactRecallScopeIntents`) selects which scope types to search; a resolved
 * project narrows the project-specific scopes (durable, handoffs, incidents) to
 * that project, while preferences, shared memories, and explicitly imported
 * external sources stay global. Seeded resources
 * (`threadnote://resources/repos`) are intentionally NOT exact-grepped for
 * intent-classified queries — those are covered by the unscoped base semantic
 * pass plus the project-scoped seeded pass, and grepping every repo per term is
 * broad and low-signal. The broad fallback (unclear intent) does include them.
 */
export function exactMemoryScopeUris(params: {
  readonly agentMemoriesUri: string;
  readonly includeArchived: boolean;
  readonly intents: ReadonlySet<ExactScopeIntent>;
  readonly projectName?: string;
  readonly projectResourceUri?: string;
  readonly userBase: string;
}): readonly string[] {
  const {agentMemoriesUri, includeArchived, intents, projectName, projectResourceUri, userBase} = params;
  const durable = projectName ? `${userBase}/durable/projects/${projectName}` : `${userBase}/durable/projects`;
  const handoffs = projectName ? `${userBase}/handoffs/active/${projectName}` : `${userBase}/handoffs/active`;
  const incidents = projectName ? `${userBase}/incidents/active/${projectName}` : `${userBase}/incidents/active`;
  if (intents.size > 0) {
    const scopes: string[] = [];
    if (intents.has('preferences')) {
      scopes.push(`${userBase}/preferences`);
    }
    if (intents.has('durable')) {
      scopes.push(durable);
    }
    if (intents.has('handoffs')) {
      scopes.push(handoffs);
    }
    if (intents.has('incidents')) {
      scopes.push(incidents);
    }
    // Shared team memories and explicitly imported external sources are
    // cross-cutting, so always include them alongside intent-specific scopes.
    scopes.push(`${userBase}/shared`);
    scopes.push('threadnote://resources/external');
    if (includeArchived) {
      if (intents.has('durable')) {
        scopes.push(`${userBase}/durable/archived`);
      }
      if (intents.has('handoffs')) {
        scopes.push(`${userBase}/handoffs/archived`);
      }
      if (intents.has('incidents')) {
        scopes.push(`${userBase}/incidents/archived`);
      }
    }
    return scopes;
  }
  const scopes = [
    `${userBase}/preferences`,
    durable,
    handoffs,
    incidents,
    `${userBase}/shared`,
    agentMemoriesUri,
    projectResourceUri ?? 'threadnote://resources/repos',
    'threadnote://resources/external',
  ];
  return includeArchived
    ? [...scopes, `${userBase}/durable/archived`, `${userBase}/handoffs/archived`, `${userBase}/incidents/archived`]
    : scopes;
}

/**
 * Run exact-term greps over scopes and collapse them to a deduped, ranked
 * pointer list: one entry per matched URI (chunk anchors stripped), tagged with
 * the terms that hit it, ranked by distinct-term count then first-seen. Keeps
 * recall an index of pointers rather than a dump of matching lines. `runGrep`
 * returns `ov grep --output json` stdout (or undefined on failure).
 */
export const collectExactMatches = Effect.fn('utils.collectExactMatches')(function* <E, R>(
  terms: readonly string[],
  scopes: readonly string[],
  runGrep: (term: string, scope: string) => Effect.Effect<string | undefined, E, R>,
) {
  // Run all term×scope greps concurrently, then fold the results in a fixed
  // order so dedup ranking stays deterministic regardless of completion order.
  const pairs = terms.flatMap(term => scopes.map(scope => ({scope, term})));
  const outputs = yield* Effect.forEach(pairs, pair => runGrep(pair.term, pair.scope), {
    concurrency: 'unbounded',
  });
  const byUri = new Map<string, {order: number; terms: Set<string>}>();
  let order = 0;
  for (const [index, pair] of pairs.entries()) {
    const json = outputs[index];
    if (!json) {
      continue;
    }
    for (const raw of grepUrisFromJson(json)) {
      const uri = raw.replace(/#.*$/, '');
      const existing = byUri.get(uri);
      if (existing) {
        existing.terms.add(pair.term);
      } else {
        byUri.set(uri, {order: order++, terms: new Set([pair.term])});
      }
    }
  }
  return [...byUri.entries()]
    .sort((left, right) => right[1].terms.size - left[1].terms.size || left[1].order - right[1].order)
    .map(([uri, value]) => ({terms: [...value.terms], uri}));
});

export function formatExactMatchPointers(matches: readonly ExactMatch[], maxUris = 8): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  const shown = matches.slice(0, maxUris);
  const lines = shown.map(match => `- ${match.uri} (${match.terms.join(', ')})`);
  if (matches.length > maxUris) {
    lines.push(`(+${matches.length - maxUris} more exact matches — refine the query to narrow)`);
  }
  return ['Exact term matches (read the URI for full content):', ...lines].join('\n');
}

function exactRecallTermScore(term: string): number {
  let score = term.length;
  if (/[A-Z]/.test(term)) {
    score += 8;
  }
  if (/[0-9_.-]/.test(term)) {
    score += 6;
  }
  return score;
}

export function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function firstLine(value: string): string {
  return value.split('\n')[0]?.trim() ?? '';
}

export function formatStatus(status: CommandStatus): string {
  if (status === 'ok') {
    return success('OK  ');
  }
  if (status === 'warn') {
    return warning('WARN');
  }
  return failure('FAIL');
}

export const toolRoot = Effect.fn('utils.toolRoot')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  if (typeof THREADNOTE_STANDALONE !== 'undefined' && THREADNOTE_STANDALONE) {
    const system = yield* SystemInfo;
    return pathService.dirname(system.executablePath);
  }
  const modulePath = yield* pathService.fromFileUrl(new URL(import.meta.url));
  const moduleDirectory = pathService.dirname(modulePath);
  return (yield* fs.exists(pathService.join(moduleDirectory, 'package.json')))
    ? moduleDirectory
    : pathService.resolve(moduleDirectory, '..');
});

export const currentPackageVersion = Effect.fn('utils.currentPackageVersion')(function* () {
  return yield* getThreadnoteVersion();
});

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
