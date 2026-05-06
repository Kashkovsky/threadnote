import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {access, lstat, mkdir, readFile, readdir, rm, stat} from 'node:fs/promises';
import {get as httpGet} from 'node:http';
import {createConnection} from 'node:net';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join, resolve, sep} from 'node:path';
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
  const command = await findExecutable(['ov', 'openviking']);
  if (!command) {
    throw new Error('Neither ov nor openviking was found in PATH. Run threadnote install first.');
  }
  return command;
}

export async function openVikingCliForMode(dryRun: boolean): Promise<string> {
  if (dryRun) {
    return (await findExecutable(['ov', 'openviking'])) ?? 'ov';
  }
  return requiredOpenVikingCli();
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
  console.log(`${dryRun ? 'Would run' : 'Running'}: ${formatShellCommand(executable, args)}${cwdSuffix}`);
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
  options: {readonly allowFailure?: boolean; readonly cwd?: string} = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {cwd: options.cwd});
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout.on('data', chunk => {
      stdoutChunks.push(String(chunk));
    });
    child.stderr.on('data', chunk => {
      stderrChunks.push(String(chunk));
    });
    child.on('error', err => {
      if (options.allowFailure === true) {
        resolvePromise({exitCode: 127, stderr: errorMessage(err), stdout: ''});
      } else {
        rejectPromise(err);
      }
    });
    child.on('close', code => {
      const result = {
        exitCode: code ?? 1,
        stderr: stderrChunks.join(''),
        stdout: stdoutChunks.join(''),
      };
      if (result.exitCode !== 0 && options.allowFailure !== true) {
        rejectPromise(new Error(`${formatShellCommand(executable, args)} failed: ${result.stderr || result.stdout}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

export async function gitValue(args: readonly string[], cwd = getInvocationCwd()): Promise<string | undefined> {
  const result = await runCommand('git', args, {allowFailure: true, cwd});
  if (result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout.trim();
}

export async function runInteractive(executable: string, args: readonly string[]): Promise<number> {
  return new Promise(resolvePromise => {
    const child = spawn(executable, args, {stdio: 'inherit'});
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

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function firstLine(value: string): string {
  return value.split('\n')[0]?.trim() ?? '';
}

export function formatStatus(status: CommandStatus): string {
  if (status === 'ok') {
    return 'OK  ';
  }
  if (status === 'warn') {
    return 'WARN';
  }
  return 'FAIL';
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
