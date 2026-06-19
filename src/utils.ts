import {execFile, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants as fsConstants, existsSync} from 'node:fs';
import {access, lstat, mkdir, readFile, readdir, rm, stat} from 'node:fs/promises';
import {get as httpGet} from 'node:http';
import {createConnection} from 'node:net';
import {homedir} from 'node:os';
import {basename, dirname, isAbsolute, join, resolve, sep} from 'node:path';
import {command as commandText, failure, info, success, warning} from './cli_ui.js';
import type {CommandResult, CommandStatus, JsonObject} from './types.js';

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonConfigObject(content: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch (_err: unknown) {
    return undefined;
  }
}

export function redactText(content: string): string {
  return content
    .replace(
      /([A-Za-z0-9_.-]*(?:token|secret|password|api[_-]?key|authorization)[A-Za-z0-9_.-]*\s*[:=]\s*)("[^"]+"|'[^']+'|Bearer\s+[^'"\s]+|\S+)/gi,
      '$1[REDACTED]',
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, 'gh_[REDACTED]');
}

export async function walkFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(path: string): Promise<void> {
    let pathStat;
    try {
      pathStat = await lstat(path);
    } catch (_err: unknown) {
      return;
    }
    if (pathStat.isSymbolicLink()) {
      return;
    }
    if (pathStat.isFile()) {
      files.push(path);
      return;
    }
    if (!pathStat.isDirectory()) {
      return;
    }
    const entries = await readdir(path);
    for (const entry of entries) {
      await visit(join(path, entry));
    }
  }
  await visit(root);
  return files;
}

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
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}

export async function requiredOpenVikingCli(): Promise<string> {
  const command = await findOpenVikingCli();
  if (!command) {
    throw new Error(
      'Neither ov nor openviking was found in PATH, uv tool bin dir, $UV_TOOL_BIN_DIR, or ~/.local/bin. ' +
        'Run threadnote install first.',
    );
  }
  return command;
}

export async function openVikingCliForMode(dryRun: boolean): Promise<string> {
  if (dryRun) {
    return (await findOpenVikingCli()) ?? 'ov';
  }
  return requiredOpenVikingCli();
}

export async function findOpenVikingCli(): Promise<string | undefined> {
  const override = process.env.THREADNOTE_OV?.trim();
  if (override) {
    return override;
  }
  const onPath = await findExecutable(['ov', 'openviking']);
  if (onPath) {
    return onPath;
  }
  for (const candidateDir of await openVikingToolCandidateDirs()) {
    for (const command of ['ov', 'openviking']) {
      const candidate = join(candidateDir, command);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

async function openVikingToolCandidateDirs(): Promise<readonly string[]> {
  const dirs: string[] = [];
  const uv = await findExecutable(['uv']);
  if (uv) {
    const result = await runCommand(uv, ['tool', 'dir', '--bin'], {allowFailure: true});
    if (result.exitCode === 0) {
      const dir = result.stdout.trim();
      if (dir) {
        dirs.push(dir);
      }
    }
  }
  if (process.env.UV_TOOL_BIN_DIR) {
    dirs.push(process.env.UV_TOOL_BIN_DIR);
  }
  dirs.push(join(homedir(), '.local', 'bin'));
  return Array.from(new Set(dirs));
}

export async function requiredExecutable(command: string): Promise<string> {
  const executable = await findExecutable([command]);
  if (!executable) {
    throw new Error(`${command} was not found in PATH.`);
  }
  return executable;
}

export async function findExecutable(commands: readonly string[]): Promise<string | undefined> {
  for (const command of commands) {
    const result = await runCommand('which', [command], {allowFailure: true});
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }
  return undefined;
}

export async function maybeRun(
  dryRun: boolean,
  executable: string,
  args: readonly string[],
  options: {readonly allowFailure?: boolean; readonly cwd?: string} = {},
): Promise<CommandResult | undefined> {
  const cwdSuffix = options.cwd ? ` (cwd: ${options.cwd})` : '';
  const label = dryRun ? warning('Would run') : info('Running');
  console.log(`${label}: ${commandText(formatShellCommand(executable, args))}${cwdSuffix}`);
  if (dryRun) {
    return undefined;
  }
  const result = await runCommand(executable, args, {allowFailure: options.allowFailure === true, cwd: options.cwd});
  if (result.stdout.trim()) {
    console.log(result.stdout.trim());
  }
  if (result.stderr.trim()) {
    console.error(result.stderr.trim());
  }
  return result;
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: {
    readonly allowFailure?: boolean;
    readonly cwd?: string;
    readonly maxOutputBytes?: number;
    readonly timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const maxOutputBytes = options.maxOutputBytes ?? defaultCommandMaxOutputBytes();
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;
    let failureMessage: string | undefined;
    let sentTerminationSignal = false;
    const timeoutMs = options.timeoutMs ?? defaultCommandTimeoutMs();
    const finish = (result: CommandResult): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (killEscalationTimer) {
        clearTimeout(killEscalationTimer);
      }
      if (result.exitCode !== 0 && options.allowFailure !== true) {
        rejectPromise(new Error(`${formatShellCommand(executable, args)} failed: ${result.stderr || result.stdout}`));
        return;
      }
      resolvePromise(result);
    };
    const child = execFile(
      executable,
      [...args],
      {
        cwd: options.cwd,
        encoding: 'utf8',
        maxBuffer: maxOutputBytes,
      },
      (err, stdout, stderr) => {
        finish(
          commandResultFromExecFileCallback({
            args,
            err,
            executable,
            failureMessage,
            maxOutputBytes,
            stderr,
            stdout,
          }),
        );
      },
    );
    const failAndKill = (message: string): void => {
      if (failureMessage) {
        return;
      }
      failureMessage = message;
      if (!sentTerminationSignal) {
        sentTerminationSignal = true;
        child.kill('SIGTERM');
      }
      killEscalationTimer = setTimeout(() => {
        if (!finished) {
          child.kill('SIGKILL');
        }
      }, 1000).unref?.();
    };
    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        failAndKill(`${formatShellCommand(executable, args)} timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      killTimer.unref?.();
    }
  });
}

function commandResultFromExecFileCallback(params: {
  readonly args: readonly string[];
  readonly err: Error | null;
  readonly executable: string;
  readonly failureMessage?: string;
  readonly maxOutputBytes: number;
  readonly stderr: string;
  readonly stdout: string;
}): CommandResult {
  if (params.failureMessage) {
    return {exitCode: 124, stderr: params.failureMessage, stdout: params.stdout};
  }
  if (!params.err) {
    return {exitCode: 0, stderr: params.stderr, stdout: params.stdout};
  }
  const error = params.err as Error & {readonly code?: number | string};
  const exitCode =
    typeof error.code === 'number' ? error.code : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 124 : 127;
  const stderr =
    error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      ? `${formatShellCommand(params.executable, params.args)} exceeded output limit of ${params.maxOutputBytes} bytes`
      : params.stderr || errorMessage(error);
  return {exitCode, stderr, stdout: params.stdout};
}

function defaultCommandTimeoutMs(): number {
  return positiveIntegerFromEnv('THREADNOTE_COMMAND_TIMEOUT_MS') ?? 10 * 60 * 1000;
}

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
export function reindexWaitTimeoutMs(): number {
  return positiveIntegerFromEnv('THREADNOTE_REINDEX_TIMEOUT_MS') ?? 120_000;
}

function defaultCommandMaxOutputBytes(): number {
  return positiveIntegerFromEnv('THREADNOTE_COMMAND_MAX_OUTPUT_BYTES') ?? 5 * 1024 * 1024;
}

function positiveIntegerFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function gitValue(args: readonly string[], cwd = getInvocationCwd()): Promise<string | undefined> {
  const result = await runCommand('git', args, {allowFailure: true, cwd});
  if (result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout.trim();
}

/**
 * Resolves the canonical repository name for `cwd`, returning undefined when it
 * is not inside a git repository.
 *
 * From a linked worktree (`git worktree add`, Conductor workspaces, …) the
 * top-level path basename is the worktree/branch name, not the project — so a
 * handoff would file under e.g. `algiers` instead of `threadnote`. The shared
 * `--git-common-dir` always points at the primary worktree's `.git`, so the
 * project name is derived from there to stay consistent with what the primary
 * checkout produces.
 */
export async function resolveRepoName(cwd = getInvocationCwd()): Promise<string | undefined> {
  const repoRoot = await gitValue(['rev-parse', '--show-toplevel'], cwd);
  if (!repoRoot) {
    return undefined;
  }
  const commonDir = await gitValue(['rev-parse', '--git-common-dir'], repoRoot);
  if (commonDir) {
    const absoluteCommonDir = isAbsolute(commonDir) ? commonDir : resolve(repoRoot, commonDir);
    const primaryRoot = basename(absoluteCommonDir) === '.git' ? dirname(absoluteCommonDir) : absoluteCommonDir;
    const name = basename(primaryRoot).replace(/\.git$/, '');
    if (name && name !== '.') {
      return name;
    }
  }
  return basename(repoRoot);
}

export async function runInteractive(executable: string, args: readonly string[]): Promise<number> {
  return new Promise(resolvePromise => {
    const child = spawn(executable, args, {stdio: 'inherit'});
    // `error` fires instead of `close` when the binary cannot be spawned
    // (e.g. ENOENT). Resolve non-zero so callers surface a failure rather than
    // hanging forever waiting for a `close` that never comes.
    child.on('error', () => {
      resolvePromise(1);
    });
    child.on('close', code => {
      resolvePromise(code ?? 1);
    });
  });
}

export async function httpGetText(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpGet(url, response => {
      const chunks: string[] = [];
      response.on('data', chunk => {
        chunks.push(String(chunk));
      });
      response.on('end', () => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          rejectPromise(new Error(`HTTP ${statusCode}`));
          return;
        }
        resolvePromise(chunks.join(''));
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    request.on('error', rejectPromise);
  });
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => {
    setTimeout(resolvePromise, ms);
  });
}

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
  // Same rank class with distinct suffixes (e.g. rc1 vs rc2) — order lexically.
  return (left.suffix ?? '').localeCompare(right.suffix ?? '');
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

export async function readHttpStatus(url: string, timeoutMs: number): Promise<number | undefined> {
  return new Promise(resolvePromise => {
    const request = httpGet(url, response => {
      response.resume();
      resolvePromise(response.statusCode);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolvePromise(undefined);
    });
    request.on('error', () => {
      resolvePromise(undefined);
    });
  });
}

export async function isTcpPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolvePromise => {
    const socket = createConnection({host, port});
    let resolved = false;
    const finish = (value: boolean): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('timeout', () => {
      finish(false);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
}

export async function getInputText(optionText: string | undefined, useStdin: boolean): Promise<string> {
  if (optionText !== undefined) {
    return optionText;
  }
  if (!useStdin) {
    return '';
  }
  return new Promise(resolvePromise => {
    const chunks: string[] = [];
    process.stdin.on('data', chunk => {
      chunks.push(String(chunk));
    });
    process.stdin.on('end', () => {
      resolvePromise(chunks.join(''));
    });
  });
}

export async function ensureDirectory(path: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`Would create directory: ${path}`);
    return;
  }
  await mkdir(path, {recursive: true});
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (_err: unknown) {
    return false;
  }
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch (_err: unknown) {
    return false;
  }
}

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

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (_err: unknown) {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (_err: unknown) {
    return false;
  }
}

export async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (_err: unknown) {
    return undefined;
  }
}

export async function removePathIfExists(path: string, label: string, dryRun: boolean): Promise<void> {
  if (!(await exists(path))) {
    console.log(`Already absent: ${path}`);
    return;
  }
  await removePath(path, label, dryRun);
}

export async function removePath(path: string, label: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`Would remove ${label}: ${path}`);
    return;
  }
  await rm(path, {force: true, recursive: true});
  console.log(`Removed ${label}: ${path}`);
}

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

export function assertVikingUri(uri: string): void {
  if (!uri.startsWith('viking://')) {
    throw new Error(`Refusing non-viking URI: ${uri}`);
  }
}

export function collectOption(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

export function expandPath(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith(`~${sep}`) || path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return isAbsolute(path) ? path : resolve(getInvocationCwd(), path);
}

export function assertSafeThreadnoteHomeForErase(path: string): void {
  const resolvedPath = resolve(path);
  if (resolvedPath === '/' || resolvedPath === homedir() || resolvedPath === dirname(homedir())) {
    throw new Error(`Refusing to erase unsafe THREADNOTE_HOME: ${resolvedPath}`);
  }
}

export function portablePath(path: string): string {
  const home = homedir();
  const resolvedPath = resolve(path);
  if (resolvedPath === home) {
    return '~';
  }
  if (resolvedPath.startsWith(`${home}${sep}`)) {
    return `~/${resolvedPath
      .slice(home.length + 1)
      .split(sep)
      .join('/')}`;
  }
  return resolvedPath;
}

export function getInvocationCwd(): string {
  return process.env.THREADNOTE_CALLER_CWD ?? process.cwd();
}

export function recallQueryRequestsWorkspaceContext(query: string): boolean {
  const normalized = query.toLowerCase();
  return /\b(?:this|current)\s+(?:branch|repo|repository|workspace|worktree)\b/.test(normalized);
}

export async function enrichRecallQueryWithWorkspaceContext(
  query: string,
  options: {readonly cwd?: string; readonly includeProcessCwd?: boolean} = {},
): Promise<string> {
  return enrichRecallQueryWithWorkspaceTerms(query, options, true);
}

export async function enrichRecallQueryWithWorkspaceProjectContext(
  query: string,
  options: {readonly cwd?: string; readonly includeProcessCwd?: boolean} = {},
): Promise<string> {
  return enrichRecallQueryWithWorkspaceTerms(query, options, false);
}

async function enrichRecallQueryWithWorkspaceTerms(
  query: string,
  options: {readonly cwd?: string; readonly includeProcessCwd?: boolean},
  includeBranch: boolean,
): Promise<string> {
  if (!recallQueryRequestsWorkspaceContext(query)) {
    return query;
  }
  const terms = await currentWorkspaceRecallTerms(options, includeBranch);
  const additions = terms.filter(term => !query.toLowerCase().includes(term.toLowerCase()));
  return additions.length > 0 ? `${query} ${additions.join(' ')}` : query;
}

async function currentWorkspaceRecallTerms(
  options: {
    readonly cwd?: string;
    readonly includeProcessCwd?: boolean;
  },
  includeBranch: boolean,
): Promise<readonly string[]> {
  const cwd = options.cwd ?? (options.includeProcessCwd === false ? undefined : getInvocationCwd());
  if (!cwd || !isAbsolute(cwd)) {
    return [];
  }
  const repoRoot = await gitValue(['rev-parse', '--show-toplevel'], cwd);
  if (!repoRoot) {
    return [];
  }
  const branch = await gitValue(['branch', '--show-current'], repoRoot);
  const parent = dirname(repoRoot);
  return uniqueUsefulWorkspaceTerms([
    {source: 'branch', value: includeBranch ? branch : undefined},
    {source: 'path', value: basename(repoRoot)},
    {source: 'path', value: parent === homedir() ? undefined : basename(parent)},
  ]);
}

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
  return path.split(sep).join('/');
}

export function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function parentVikingUri(uri: string): string {
  const trimmedUri = trimTrailingSlash(uri);
  const slashIndex = trimmedUri.lastIndexOf('/');
  return slashIndex <= 'viking://'.length ? trimmedUri : trimmedUri.slice(0, slashIndex);
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function exactRecallTerms(query: string): readonly string[] {
  const stopWords = new Set([
    'about',
    'after',
    'agent',
    'anything',
    'branch',
    'case',
    'current',
    'durable',
    'find',
    'feature',
    'features',
    'handoff',
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
    'this',
    'the',
    'with',
    'workspace',
    'worktree',
  ]);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of query.matchAll(/[A-Za-z0-9_.-]{4,}/g)) {
    const term = match[0];
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
export const RECALL_SCORE_THRESHOLD = process.env.THREADNOTE_RECALL_THRESHOLD?.trim() || '0.45';

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
 * OpenViking summary auto-generation off (Threadnote's default) these are
 * permanent "[Directory ... not ready]" placeholders, so they are noise in
 * recall and must never surface as results or pointers.
 */
export function isSummarySidecarUri(uri: string): boolean {
  return /\.(?:overview|abstract)\.md(?:#|$)/.test(uri);
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
  try {
    const parsed: unknown = JSON.parse(output.slice(start));
    const result = isJsonObject(parsed) ? parsed.result : undefined;
    const matches = isJsonObject(result) ? result.matches : undefined;
    if (!Array.isArray(matches)) {
      return [];
    }
    const uris: string[] = [];
    for (const match of matches) {
      if (isJsonObject(match) && typeof match.uri === 'string' && !isSummarySidecarUri(match.uri)) {
        uris.push(match.uri);
      }
    }
    return uris;
  } catch (_err: unknown) {
    return [];
  }
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
  return /^viking:\/\/user\/[^/]+\/memories\/(?:durable|handoffs|incidents|preferences|smoke)\/archived(?:\/|$)/.test(
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
  try {
    const parsed: unknown = JSON.parse(output.slice(start));
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
        if (!isJsonObject(item) || typeof item.uri !== 'string' || isSummarySidecarUri(item.uri)) {
          continue;
        }
        if (options.includeArchived !== true && isArchivedMemoryUri(item.uri)) {
          continue;
        }
        hits.push({
          category: key,
          contextType: typeof item.context_type === 'string' ? item.context_type : 'result',
          score: typeof item.score === 'number' ? item.score : 0,
          snippet: recallSnippet(item.abstract ?? item.overview),
          uri: item.uri,
        });
      }
    }
    return hits;
  } catch (_err: unknown) {
    return [];
  }
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
 * right group. Mirrors how OpenViking buckets search results: personal/shared
 * memories under `.../memories/...`, the global skill catalog under
 * `resources/agent-skills/`, everything else (including repo-embedded skills) as
 * a resource.
 */
export function categoryForUri(uri: string): RecallCategory {
  if (uri.includes('/memories/')) {
    return 'memories';
  }
  if (uri.startsWith('viking://resources/agent-skills/')) {
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
 * Fold exact (lexical) matches into the semantically-ranked hits so the lexical
 * signal drives ranking rather than sitting in a separate afterthought section.
 * Semantic hits that a term also matched are annotated with `exactTerms`;
 * exact-match documents with no semantic hit are promoted in as fresh hits with
 * `score` 0. The result is re-sorted category-first, then by number of exact
 * terms matched, then by semantic score — so within each category, exact matches
 * lead (most terms first) and only then come unmatched semantic hits. This fixes
 * canonical docs being buried under higher-scored-but-irrelevant noise in the
 * compressed semantic score band.
 *
 * Intentional trade-off: an exact (lexical) match is treated as a stronger
 * relevance signal than semantic proximity, so a promoted exact-only document
 * (score 0) outranks an unmatched semantic hit in the same category and can
 * occupy a slot in the shown window. `exactRecallTerms` only keeps distinctive
 * tokens, so a literal match is high precision; surfacing it over a fuzzy
 * neighbour is the desired behaviour.
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
  return [...annotated, ...promoted].sort(
    (left, right) =>
      recallCategoryRank(left.category) - recallCategoryRank(right.category) ||
      (right.exactTerms?.length ?? 0) - (left.exactTerms?.length ?? 0) ||
      right.score - left.score,
  );
}

export function formatRecallHits(hits: readonly RecallHit[], maxHits: number): string | undefined {
  return renderRecallHits(hits.slice(0, maxHits), Math.max(0, hits.length - maxHits));
}

/**
 * Render an already-decided shown window into the numbered recall list. Keeping
 * the slice out of here lets `buildRecallSections` compute the shown set once and
 * feed both the rendering and the exact-tail "already shown" filter from the same
 * list. `overflow` is the count of hits beyond the window, for the trailing note.
 */
function renderRecallHits(shown: readonly RecallHit[], overflow: number): string | undefined {
  if (shown.length === 0) {
    return undefined;
  }
  const lines = shown.flatMap((hit, index) => {
    const scorePart = hit.score > 0 ? `score ${hit.score.toFixed(2)}` : undefined;
    const exactPart = hit.exactTerms?.length ? `exact: ${hit.exactTerms.join(', ')}` : undefined;
    const head = `${index + 1}. ${[hit.contextType, scorePart, exactPart].filter(Boolean).join(' · ')} · ${hit.uri}`;
    return hit.snippet ? [head, `   ${hit.snippet}`] : [head];
  });
  if (overflow > 0) {
    lines.push(`(+${overflow} more — refine the query or read a URI above)`);
  }
  return lines.join('\n');
}

export interface RecallSections {
  /**
   * Final ranked hits (merged, exact-boosted, content-deduped). Exposed for
   * tests and inspection; the CLI and MCP callers emit the rendered sections.
   */
  readonly ranked: readonly RecallHit[];
  /** Rendered ranked list, capped at `limit`. Undefined when there are no hits. */
  readonly semanticSection: string | undefined;
  /** Exact-match pointer list for matches not already shown in the ranked window. */
  readonly exactTail: string | undefined;
}

/**
 * Slots reserved per category in the shown window so a memory-heavy result set
 * does not crowd seeded resources and skills out of view entirely. Memories
 * still lead and still take every slot the reserve pass leaves over.
 */
export const RECALL_CATEGORY_RESERVE = 2;

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
): RecallSections {
  const ranked = dedupeByContent(applyExactMatchBoost(mergeRecallHits(passes), exactMatches));
  const shown = selectShownHits(ranked, limit, RECALL_CATEGORY_RESERVE);
  const shownUris = new Set(shown.map(hit => stripAnchor(hit.uri)));
  return {
    exactTail: formatExactMatchPointers(exactMatches.filter(match => !shownUris.has(stripAnchor(match.uri)))),
    ranked,
    semanticSection: renderRecallHits(shown, ranked.length - shown.length),
  };
}

/**
 * Build the exact-term grep scopes for a recall. Intent (from
 * `exactRecallScopeIntents`) selects which scope types to search; a resolved
 * project narrows the project-specific scopes (durable, handoffs, incidents) to
 * that project, while preferences and shared stay global. Seeded resources
 * (`viking://resources/repos`) are intentionally NOT exact-grepped for
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
    // Shared team memories are cross-cutting (durable knowledge published by
    // teammates), so always include them alongside the intent-specific scopes.
    scopes.push(`${userBase}/shared`);
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
    projectResourceUri ?? 'viking://resources/repos',
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
export async function collectExactMatches(
  terms: readonly string[],
  scopes: readonly string[],
  runGrep: (term: string, scope: string) => Promise<string | undefined>,
): Promise<readonly ExactMatch[]> {
  // Run all term×scope greps concurrently, then fold the results in a fixed
  // order so dedup ranking stays deterministic regardless of completion order.
  const pairs = terms.flatMap(term => scopes.map(scope => ({scope, term})));
  const outputs = await Promise.all(pairs.map(pair => runGrep(pair.term, pair.scope)));
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
}

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

export function formatShellCommand(executable: string, args: readonly string[]): string {
  return redactText([executable, ...args].map(shellQuote).join(' '));
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function toolRoot(): string {
  if (existsSync(join(__dirname, 'package.json'))) {
    return __dirname;
  }
  return resolve(__dirname, '..');
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
