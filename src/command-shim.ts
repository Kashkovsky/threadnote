import {Console, Effect, FileSystem, Option, Path, Result} from 'effect';
import {SHIM_MARKER} from './constants.js';
import {SystemInfo} from './effect/system.js';
import type {DoctorCheck} from './types.js';
import {expandPath, findExecutable, readFileIfExists, removePath, shellQuote, toolRoot} from './utils.js';

const THREADNOTE_COMMAND = 'threadnote';

export function shouldManageCommandShim(currentPlatform: NodeJS.Platform): boolean {
  return currentPlatform !== 'win32';
}

export const commandShimCheck = Effect.fn('commandShim.check')(function* () {
  const system = yield* SystemInfo;
  if (!shouldManageCommandShim(system.platform)) {
    const launcher = yield* findExecutable([THREADNOTE_COMMAND]);
    return launcher
      ? ({detail: launcher, name: 'threadnote launcher', status: 'ok'} satisfies DoctorCheck)
      : ({
          detail: 'npm threadnote.cmd launcher is not on PATH; repair preserves package-manager launchers',
          name: 'threadnote launcher',
          status: 'warn',
        } satisfies DoctorCheck);
  }
  const shimPath = yield* managedCommandShimPath();
  const content = yield* readFileIfExists(shimPath);
  if (content === undefined) {
    return {
      detail: `${shimPath} missing; repair will create it`,
      name: 'threadnote shim',
      status: 'warn',
    } satisfies DoctorCheck;
  }
  if (!isManagedCommandShim(content)) {
    return {
      detail: `${shimPath} exists but is not managed by Threadnote; repair will not overwrite it`,
      name: 'threadnote shim',
      status: 'warn',
    } satisfies DoctorCheck;
  }
  if (content !== (yield* renderCommandShim())) {
    return {
      detail: `${shimPath} points at a different installation; repair will rewrite it`,
      name: 'threadnote shim',
      status: 'warn',
    } satisfies DoctorCheck;
  }
  return {detail: shimPath, name: 'threadnote shim', status: 'ok'} satisfies DoctorCheck;
});

export const installCommandShim = Effect.fn('commandShim.install')(function* (dryRun: boolean, packageRoot?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  if (!shouldManageCommandShim(system.platform)) {
    yield* Console.log('Preserving the package-manager threadnote.cmd launcher on Windows.');
    return;
  }
  const shimPath = yield* managedCommandShimPath();
  const existingContent = yield* readFileIfExists(shimPath);
  if (existingContent === undefined && (yield* pathEntryExists(fs, shimPath))) {
    yield* Console.warn(`WARN not overwriting unreadable command shim: ${shimPath}`);
    return;
  }
  if (existingContent !== undefined && !isManagedCommandShim(existingContent)) {
    yield* Console.warn(`WARN not overwriting unmanaged command shim: ${shimPath}`);
    return;
  }
  const content = yield* renderCommandShim(packageRoot);
  if (existingContent === content) {
    yield* Console.log(`Command shim already current: ${shimPath}`);
    return;
  }
  if (dryRun) {
    yield* Console.log(`Would write command shim: ${shimPath}`);
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
  yield* Console.log(`Wrote command shim: ${shimPath}`);
});

export const removeCommandShim = Effect.fn('commandShim.remove')(function* (dryRun: boolean) {
  const system = yield* SystemInfo;
  if (!shouldManageCommandShim(system.platform)) {
    yield* Console.log('Preserving the package-manager threadnote.cmd launcher on Windows.');
    return;
  }
  const shimPath = yield* managedCommandShimPath();
  const content = yield* readFileIfExists(shimPath);
  if (content === undefined) {
    yield* Console.log(`Command shim already absent: ${shimPath}`);
    return;
  }
  if (!isManagedCommandShim(content)) {
    yield* Console.warn(`WARN not removing unmanaged command shim: ${shimPath}`);
    return;
  }
  yield* removePath(shimPath, 'command shim', dryRun);
});

export const installedThreadnoteRootFromLauncher = Effect.fn('commandShim.installedRootFromLauncher')(function* (
  launcher: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(launcher)) return undefined;
  const resolved = yield* fs.realPath(launcher).pipe(Effect.option);
  if (Option.isNone(resolved)) return undefined;
  const binDirectory = path.dirname(resolved.value);
  if (path.basename(binDirectory) !== 'bin' || !/^threadnote(?:\.cjs)?$/i.test(path.basename(resolved.value))) {
    return undefined;
  }
  const packageRoot = path.dirname(binDirectory);
  const packageJson = yield* fs.readFileString(path.join(packageRoot, 'package.json')).pipe(Effect.option);
  if (Option.isNone(packageJson)) return undefined;
  const decoded = Result.try(() => JSON.parse(packageJson.value) as {readonly name?: unknown});
  return Result.isSuccess(decoded) && decoded.success.name === THREADNOTE_COMMAND ? packageRoot : undefined;
});

export const renderCommandShim = Effect.fn('commandShim.render')(function* (packageRoot?: string) {
  const root = packageRoot ?? (yield* toolRoot());
  return [
    '#!/usr/bin/env bash',
    `# ${SHIM_MARKER}`,
    'set -euo pipefail',
    `THREADNOTE_ROOT=${shellQuote(root)}`,
    'THREADNOTE_ENTRY="$THREADNOTE_ROOT/dist/threadnote.js"',
    'if [ ! -f "$THREADNOTE_ENTRY" ]; then',
    '  THREADNOTE_ENTRY="$THREADNOTE_ROOT/bin/threadnote.cjs"',
    'fi',
    'if [ ! -f "$THREADNOTE_ENTRY" ]; then',
    '  echo "Threadnote launcher target is missing: $THREADNOTE_ROOT" >&2',
    '  echo "Reinstall Threadnote with the active Node runtime, preserving your stable or beta channel." >&2',
    '  exit 127',
    'fi',
    'THREADNOTE_CALLER_CWD="$PWD"',
    'export THREADNOTE_CALLER_CWD',
    'if command -v node >/dev/null 2>&1; then',
    '  exec node "$THREADNOTE_ENTRY" "$@"',
    'fi',
    'if command -v bun >/dev/null 2>&1; then',
    '  exec bun "$THREADNOTE_ENTRY" "$@"',
    'fi',
    'if command -v deno >/dev/null 2>&1; then',
    '  exec deno run --allow-read --allow-write --allow-run --allow-env --allow-net "$THREADNOTE_ENTRY" "$@"',
    'fi',
    'echo "threadnote requires Node.js, Bun, or Deno." >&2',
    'exit 127',
    '',
  ].join('\n');
});

function isManagedCommandShim(content: string): boolean {
  return new RegExp(`^#![^\\r\\n]*\\r?\\n# ${SHIM_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\r?\\n|$)`).test(
    content,
  );
}

const managedCommandShimPath = Effect.fn('commandShim.path')(function* () {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const binDirectory = yield* expandPath(system.environment().THREADNOTE_BIN_DIR ?? '~/.local/bin');
  return path.join(binDirectory, THREADNOTE_COMMAND);
});

function pathEntryExists(fs: FileSystem.FileSystem, target: string): Effect.Effect<boolean, never> {
  return Effect.all([fs.stat(target).pipe(Effect.option), fs.readLink(target).pipe(Effect.option)]).pipe(
    Effect.map(([info, link]) => Option.isSome(info) || Option.isSome(link)),
    Effect.catch(() => Effect.succeed(false)),
  );
}
