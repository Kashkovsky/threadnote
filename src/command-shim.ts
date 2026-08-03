import {Console, Effect, FileSystem, Option, Path} from 'effect';
import {SHIM_MARKER} from './constants.js';
import {runCommandEffect} from './effect/command.js';
import {SystemInfo} from './effect/system.js';
import type {DoctorCheck} from './types.js';
import {expandPath, readFileIfExists, removePath, shellQuote, toolRoot} from './utils.js';

const THREADNOTE_COMMAND = 'threadnote';
const THREADNOTE_MCP_COMMAND = 'threadnote-mcp-server';
type LauncherMode = 'cli' | 'mcp';

export function shouldManageCommandShim(_currentPlatform: NodeJS.Platform): boolean {
  return true;
}

export const commandLauncherPath = Effect.fn('commandShim.launcherPath')((mode: LauncherMode = 'cli') =>
  managedCommandShimPath(mode),
);

export const commandShimCheck = Effect.fn('commandShim.check')(function* () {
  const shimPath = yield* managedCommandShimPath('cli');
  const content = yield* readFileIfExists(shimPath);
  if (content === undefined) {
    return {
      detail: `${shimPath} missing; repair will create it`,
      name: 'threadnote launcher',
      status: 'warn',
    } satisfies DoctorCheck;
  }
  if (!isManagedCommandShim(content)) {
    return {
      detail: `${shimPath} exists but is not managed by Threadnote; repair will not overwrite it`,
      name: 'threadnote launcher',
      status: 'warn',
    } satisfies DoctorCheck;
  }
  if (content !== (yield* renderCommandShim())) {
    return {
      detail: `${shimPath} points at a different standalone release; repair will rewrite it`,
      name: 'threadnote launcher',
      status: 'warn',
    } satisfies DoctorCheck;
  }
  return {detail: shimPath, name: 'threadnote launcher', status: 'ok'} satisfies DoctorCheck;
});

export const installCommandShim = Effect.fn('commandShim.install')(function* (dryRun: boolean, releaseRoot?: string) {
  for (const mode of ['cli', 'mcp'] as const) {
    yield* installLauncher(mode, dryRun, releaseRoot);
  }
  yield* ensureDefaultWindowsBinDirectoryOnUserPath(dryRun);
});

const ensureDefaultWindowsBinDirectoryOnUserPath = Effect.fn('commandShim.ensureWindowsPath')(function* (
  dryRun: boolean,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  if (system.platform !== 'win32' || system.environment().THREADNOTE_BIN_DIR?.trim()) return;
  const binDirectory = path.dirname(yield* managedCommandShimPath('cli'));
  if (dryRun) {
    yield* Console.log(`Would ensure command directory is on the Windows user PATH: ${binDirectory}`);
    return;
  }
  const script = [
    '$entry=$env:THREADNOTE_PATH_ENTRY',
    "$current=[Environment]::GetEnvironmentVariable('Path','User')",
    "$entries=@($current -split ';' | Where-Object { $_ })",
    "if (-not ($entries | Where-Object { $_.TrimEnd('\\') -ieq $entry.TrimEnd('\\') })) {",
    "  [Environment]::SetEnvironmentVariable('Path', ((@($entry) + $entries) -join ';'), 'User')",
    '}',
  ].join('; ');
  yield* runCommandEffect('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: {...system.environment(), THREADNOTE_PATH_ENTRY: binDirectory},
  });
  yield* Console.log(`Ensured command directory is on the Windows user PATH: ${binDirectory}`);
});

const installLauncher = Effect.fn('commandShim.installLauncher')(function* (
  mode: LauncherMode,
  dryRun: boolean,
  releaseRoot?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const shimPath = yield* managedCommandShimPath(mode);
  const existingContent = yield* readFileIfExists(shimPath);
  if (existingContent === undefined && (yield* pathEntryExists(fs, shimPath))) {
    yield* Console.warn(`WARN not overwriting unreadable command launcher: ${shimPath}`);
    return;
  }
  if (existingContent !== undefined && !isManagedCommandShim(existingContent)) {
    yield* Console.warn(`WARN not overwriting unmanaged command launcher: ${shimPath}`);
    return;
  }
  const content = yield* renderCommandShim(releaseRoot, mode);
  if (existingContent === content) {
    yield* Console.log(`Command launcher already current: ${shimPath}`);
    return;
  }
  if (dryRun) {
    yield* Console.log(`Would write command launcher: ${shimPath}`);
    return;
  }
  yield* fs.makeDirectory(path.dirname(shimPath), {recursive: true, mode: 0o700});
  const temporary = path.join(path.dirname(shimPath), `.${path.basename(shimPath)}.${system.processId}.tmp`);
  yield* Effect.gen(function* () {
    yield* fs.remove(temporary, {force: true});
    yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o755});
    yield* fs.chmod(temporary, 0o755);
    yield* fs.rename(temporary, shimPath);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.catch(() => Effect.void))));
  yield* Console.log(`Wrote command launcher: ${shimPath}`);
});

export const removeCommandShim = Effect.fn('commandShim.remove')(function* (dryRun: boolean) {
  for (const mode of ['cli', 'mcp'] as const) {
    const shimPath = yield* managedCommandShimPath(mode);
    const content = yield* readFileIfExists(shimPath);
    if (content === undefined) {
      yield* Console.log(`Command launcher already absent: ${shimPath}`);
      continue;
    }
    if (!isManagedCommandShim(content)) {
      yield* Console.warn(`WARN not removing unmanaged command launcher: ${shimPath}`);
      continue;
    }
    yield* removePath(shimPath, 'command launcher', dryRun);
  }
});

export const renderCommandShim = Effect.fn('commandShim.render')(function* (
  releaseRoot?: string,
  mode: LauncherMode = 'cli',
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = releaseRoot ?? (yield* toolRoot());
  const executable = path.join(root, system.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
  const modeArguments = mode === 'mcp' ? ['mcp-server'] : [];
  if (system.platform === 'win32') {
    const command = [cmdQuote(executable), ...modeArguments, '%*'].join(' ');
    return [
      '@echo off',
      `rem ${SHIM_MARKER}`,
      'setlocal',
      'set "THREADNOTE_CALLER_CWD=%CD%"',
      command,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n');
  }
  return [
    '#!/usr/bin/env sh',
    `# ${SHIM_MARKER}`,
    'set -eu',
    `THREADNOTE_ENTRY=${shellQuote(executable)}`,
    'if [ ! -x "$THREADNOTE_ENTRY" ]; then',
    '  echo "Threadnote standalone executable is missing: $THREADNOTE_ENTRY" >&2',
    '  echo "Reinstall Threadnote from a stable or beta GitHub release." >&2',
    '  exit 127',
    'fi',
    'THREADNOTE_CALLER_CWD="$PWD"',
    'export THREADNOTE_CALLER_CWD',
    `exec "$THREADNOTE_ENTRY"${modeArguments
      .map(shellQuote)
      .map(value => ` ${value}`)
      .join('')} "$@"`,
    '',
  ].join('\n');
});

function isManagedCommandShim(content: string): boolean {
  const marker = SHIM_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    new RegExp(`^#![^\\r\\n]*\\r?\\n# ${marker}(?:\\r?\\n|$)`).test(content) ||
    new RegExp(`^@echo off\\r?\\nrem ${marker}(?:\\r?\\n|$)`, 'i').test(content)
  );
}

const managedCommandShimPath = Effect.fn('commandShim.path')(function* (mode: LauncherMode) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const environment = system.environment();
  const configured = environment.THREADNOTE_BIN_DIR?.trim();
  const localAppData = environment.LOCALAPPDATA;
  const binDirectory = configured
    ? yield* expandPath(configured)
    : system.platform === 'win32' && localAppData
      ? path.join(localAppData, 'Threadnote', 'bin')
      : yield* expandPath('~/.local/bin');
  const command = mode === 'mcp' ? THREADNOTE_MCP_COMMAND : THREADNOTE_COMMAND;
  return path.join(binDirectory, system.platform === 'win32' ? `${command}.cmd` : command);
});

function cmdQuote(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`;
}

function pathEntryExists(fs: FileSystem.FileSystem, target: string): Effect.Effect<boolean, never> {
  return Effect.all([fs.stat(target).pipe(Effect.option), fs.readLink(target).pipe(Effect.option)]).pipe(
    Effect.map(([info, link]) => Option.isSome(info) || Option.isSome(link)),
    Effect.catch(() => Effect.succeed(false)),
  );
}
