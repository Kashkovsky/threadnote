import {Console, Effect, FileSystem, Option, Path} from 'effect';
import {USER_INSTRUCTIONS_END_MARKER, USER_INSTRUCTIONS_START_MARKER} from './constants.js';
import {sha256FileHex} from './effect/digest.js';
import {SystemInfo} from './effect/system.js';
import type {DoctorCheck} from './types.js';
import {errorMessage, expandPath, findExecutable, readFileIfExists, toolRoot} from './utils.js';

const CURSOR_PLUGIN_NAME = 'threadnote';
const CURSOR_PLUGIN_MANIFEST = '.cursor-plugin/plugin.json';
const CURSOR_PLUGIN_MARKER = '.threadnote-managed.json';
const CURSOR_PLUGIN_RULE = 'rules/threadnote.mdc';
const CURSOR_PLUGIN_MARKER_SCHEMA_VERSION = 1;

interface CursorPluginManifest {
  readonly name: string;
  readonly version: string;
}

interface CursorAvailabilityOptions {
  readonly cursorInstalled?: boolean;
}

export const cursorPluginDoctorChecks = Effect.fn('cursorPlugin.doctorChecks')(function* (
  options: CursorAvailabilityOptions = {},
) {
  const cursorInstalled = options.cursorInstalled ?? (yield* isCursorInstalled());
  if (!cursorInstalled) return [];
  return [yield* cursorPluginDoctorCheck()];
});

export const installCursorPlugin = Effect.fn('cursorPlugin.install')(function* (
  dryRun: boolean,
  releaseRoot?: string,
  options: CursorAvailabilityOptions = {},
) {
  const cursorInstalled = options.cursorInstalled ?? (yield* isCursorInstalled());
  if (!cursorInstalled) return;

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const sourceRoot = path.join(releaseRoot ?? (yield* toolRoot()), 'cursor-plugin');
  const targetRoot = yield* localCursorPluginRoot();
  const targetExists = yield* fs.exists(targetRoot);
  if (targetExists && (yield* isSymbolicLink(targetRoot))) {
    yield* Console.warn(`WARN ${targetRoot} is a symlink; not replacing it with the managed Cursor plugin.`);
    return;
  }
  if (targetExists && !(yield* hasManagedCursorPluginMarker(targetRoot))) {
    yield* Console.warn(`WARN ${targetRoot} is not managed by Threadnote; not modifying it.`);
    return;
  }
  if (dryRun) {
    yield* Console.log(
      targetExists
        ? `Would refresh managed Cursor plugin: ${targetRoot}`
        : `Would install Cursor plugin: ${targetRoot}`,
    );
    return;
  }

  yield* validateCursorPluginSource(sourceRoot);
  if (targetExists && (yield* directoryTreesMatch(sourceRoot, targetRoot))) {
    yield* Console.log(`Cursor plugin already current: ${targetRoot}`);
    return;
  }

  const parent = path.dirname(targetRoot);
  yield* fs.makeDirectory(parent, {recursive: true, mode: 0o700});
  const operationId = `${system.processId}-${crypto.randomUUID()}`;
  const temporaryRoot = path.join(parent, `.${CURSOR_PLUGIN_NAME}.${operationId}.installing`);
  const backupRoot = path.join(parent, `.${CURSOR_PLUGIN_NAME}.${operationId}.backup`);
  const cleanupTemporary = fs
    .remove(temporaryRoot, {force: true, recursive: true})
    .pipe(Effect.catch(() => Effect.void));
  yield* Effect.gen(function* () {
    yield* fs.copy(sourceRoot, temporaryRoot, {overwrite: false});
    let movedExisting = false;
    if (targetExists) {
      yield* fs.rename(targetRoot, backupRoot);
      movedExisting = true;
    }
    yield* fs.rename(temporaryRoot, targetRoot).pipe(
      Effect.catch(cause =>
        Effect.gen(function* () {
          if (movedExisting && !(yield* fs.exists(targetRoot)) && (yield* fs.exists(backupRoot))) {
            yield* fs.rename(backupRoot, targetRoot);
          }
          return yield* Effect.fail(cause);
        }),
      ),
    );
    if (movedExisting) {
      yield* fs
        .remove(backupRoot, {recursive: true})
        .pipe(
          Effect.catch(cause =>
            Console.warn(
              `WARN could not remove the previous Cursor plugin backup at ${backupRoot}: ${errorMessage(cause)}`,
            ),
          ),
        );
    }
  }).pipe(Effect.ensuring(cleanupTemporary));
  yield* Console.log(
    targetExists ? `Refreshed managed Cursor plugin: ${targetRoot}` : `Installed Cursor plugin: ${targetRoot}`,
  );
  yield* Console.log('Reload Cursor or open a new Cursor window so the Threadnote plugin refreshes.');
});

export const removeCursorPlugin = Effect.fn('cursorPlugin.remove')(function* (dryRun: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const targetRoot = yield* localCursorPluginRoot();
  if (!(yield* fs.exists(targetRoot))) return;
  if (yield* isSymbolicLink(targetRoot)) {
    yield* Console.warn(`WARN ${targetRoot} is a symlink; not removing it.`);
    return;
  }
  if (!(yield* hasManagedCursorPluginMarker(targetRoot))) {
    yield* Console.warn(`WARN ${targetRoot} is not managed by Threadnote; not removing it.`);
    return;
  }
  if (dryRun) {
    yield* Console.log(`Would remove managed Cursor plugin: ${targetRoot}`);
    return;
  }
  yield* fs.remove(targetRoot, {recursive: true});
  yield* Console.log(`Removed managed Cursor plugin: ${targetRoot}. It can be restored with threadnote install.`);
});

export const isCursorInstalled = Effect.fn('cursorPlugin.isCursorInstalled')(function* () {
  if (yield* findExecutable(['cursor', 'cursor-agent'])) return true;

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const environment = system.environment();
  const homeRelativeToTemporary = path.relative(system.tempDirectory, system.homeDirectory);
  const homeIsTemporary =
    homeRelativeToTemporary === '' ||
    (homeRelativeToTemporary !== '..' &&
      !homeRelativeToTemporary.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(homeRelativeToTemporary));
  const includeSystemMarkers = !homeIsTemporary;
  const markers: string[] = [];
  if (system.platform === 'darwin') {
    markers.push(
      path.join(system.homeDirectory, 'Applications', 'Cursor.app'),
      path.join(system.homeDirectory, 'Library', 'Application Support', 'Cursor'),
    );
    if (includeSystemMarkers) markers.push('/Applications/Cursor.app');
  } else if (system.platform === 'win32') {
    markers.push(
      path.join(system.homeDirectory, 'AppData', 'Local', 'Programs', 'cursor', 'Cursor.exe'),
      path.join(system.homeDirectory, 'AppData', 'Roaming', 'Cursor'),
    );
    if (includeSystemMarkers) {
      for (const root of [environment.LOCALAPPDATA, environment.ProgramFiles, environment['ProgramFiles(x86)']]) {
        if (!root) continue;
        markers.push(path.join(root, 'Programs', 'cursor', 'Cursor.exe'), path.join(root, 'Cursor', 'Cursor.exe'));
      }
      if (environment.APPDATA) markers.push(path.join(environment.APPDATA, 'Cursor'));
    }
  } else if (system.platform === 'linux') {
    const configHome =
      includeSystemMarkers && environment.XDG_CONFIG_HOME
        ? environment.XDG_CONFIG_HOME
        : path.join(system.homeDirectory, '.config');
    markers.push(
      path.join(configHome, 'Cursor'),
      path.join(system.homeDirectory, '.local', 'share', 'applications', 'cursor.desktop'),
    );
    if (includeSystemMarkers) {
      markers.push('/usr/share/applications/cursor.desktop', '/opt/Cursor/cursor', '/opt/cursor/cursor');
    }
  }
  for (const marker of markers) {
    if (yield* fs.exists(marker)) return true;
  }
  return false;
});

const cursorPluginDoctorCheck = Effect.fn('cursorPlugin.doctorCheck')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const localRoot = yield* localCursorPluginRoot();
  if (yield* fs.exists(localRoot)) {
    const check = yield* inspectCursorPluginRoot(localRoot);
    if (check.status === 'ok' && !(yield* hasManagedCursorPluginMarker(localRoot))) {
      return {
        detail: `${localRoot}; valid but not managed by Threadnote; repair will not overwrite it`,
        name: 'Cursor plugin',
        status: 'warn',
      } satisfies DoctorCheck;
    }
    return check;
  }

  const cacheRoot = yield* expandPath('~/.cursor/plugins/cache');
  if (yield* fs.exists(cacheRoot)) {
    const candidates: Array<{readonly manifest: CursorPluginManifest; readonly root: string}> = [];
    const entries = (yield* fs.readDirectory(cacheRoot, {recursive: true})).sort();
    for (const entry of entries) {
      if (!normalizePath(entry).endsWith(CURSOR_PLUGIN_MANIFEST)) continue;
      const manifestPath = path.join(cacheRoot, entry);
      const manifest = yield* readCursorPluginManifest(manifestPath).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (manifest?.name !== CURSOR_PLUGIN_NAME) continue;
      candidates.push({manifest, root: path.dirname(path.dirname(manifestPath))});
    }
    candidates.sort((left, right) => compareSemver(right.manifest.version, left.manifest.version));
    const current = candidates[0];
    if (current) return yield* inspectCursorPluginRoot(current.root);
  }

  return {
    detail: 'not installed; run `threadnote repair` to install the managed local plugin',
    name: 'Cursor plugin',
    status: 'warn',
  } satisfies DoctorCheck;
});

const inspectCursorPluginRoot = Effect.fn('cursorPlugin.inspectRoot')(function* (pluginRoot: string) {
  const path = yield* Path.Path;
  const manifestPath = path.join(pluginRoot, CURSOR_PLUGIN_MANIFEST);
  const manifest = yield* readCursorPluginManifest(manifestPath).pipe(
    Effect.mapError(cause => new Error(`${manifestPath}: ${errorMessage(cause)}`)),
  );
  if (manifest.name !== CURSOR_PLUGIN_NAME) {
    return {
      detail: `${manifestPath} declares plugin ${JSON.stringify(manifest.name)} instead of ${CURSOR_PLUGIN_NAME}`,
      name: 'Cursor plugin',
      status: 'fail',
    } satisfies DoctorCheck;
  }

  const rulePath = path.join(pluginRoot, CURSOR_PLUGIN_RULE);
  const rule = yield* readFileIfExists(rulePath);
  if (rule === undefined) {
    return {
      detail: `${rulePath} missing; run \`threadnote repair\``,
      name: 'Cursor plugin',
      status: 'fail',
    } satisfies DoctorCheck;
  }
  const ruleProblem = cursorRuleProblem(rule);
  if (ruleProblem) {
    return {
      detail: `${rulePath} ${ruleProblem}; run \`threadnote repair\``,
      name: 'Cursor plugin',
      status: 'fail',
    } satisfies DoctorCheck;
  }

  const bundledRoot = path.join(yield* toolRoot(), 'cursor-plugin');
  const bundledManifest = yield* readCursorPluginManifest(path.join(bundledRoot, CURSOR_PLUGIN_MANIFEST));
  const bundledRule = yield* readFileIfExists(path.join(bundledRoot, CURSOR_PLUGIN_RULE));
  if (bundledRule === undefined) {
    return yield* Effect.fail(new Error('The standalone release is missing its bundled Cursor plugin rule.'));
  }
  const comparison = compareSemver(manifest.version, bundledManifest.version);
  if (comparison < 0) {
    return {
      detail: `${pluginRoot}; v${manifest.version} is older than bundled v${bundledManifest.version}; run \`threadnote repair\``,
      name: 'Cursor plugin',
      status: 'warn',
    } satisfies DoctorCheck;
  }
  if (comparison === 0 && normalizeNewlines(rule) !== normalizeNewlines(bundledRule)) {
    return {
      detail: `${rulePath} differs from bundled v${bundledManifest.version}; run \`threadnote repair\``,
      name: 'Cursor plugin',
      status: 'fail',
    } satisfies DoctorCheck;
  }
  return {
    detail: `${pluginRoot}; v${manifest.version}; always-applied rule verified`,
    name: 'Cursor plugin',
    status: 'ok',
  } satisfies DoctorCheck;
});

const validateCursorPluginSource = Effect.fn('cursorPlugin.validateSource')(function* (pluginRoot: string) {
  const path = yield* Path.Path;
  const manifest = yield* readCursorPluginManifest(path.join(pluginRoot, CURSOR_PLUGIN_MANIFEST));
  if (manifest.name !== CURSOR_PLUGIN_NAME) {
    return yield* Effect.fail(new Error(`Bundled Cursor plugin must be named ${CURSOR_PLUGIN_NAME}.`));
  }
  if (!(yield* hasManagedCursorPluginMarker(pluginRoot))) {
    return yield* Effect.fail(new Error('Bundled Cursor plugin is missing its Threadnote ownership marker.'));
  }
  const rule = yield* readFileIfExists(path.join(pluginRoot, CURSOR_PLUGIN_RULE));
  const problem = rule === undefined ? 'is missing' : cursorRuleProblem(rule);
  if (problem) return yield* Effect.fail(new Error(`Bundled Cursor plugin rule ${problem}.`));
  return manifest;
});

const readCursorPluginManifest = Effect.fn('cursorPlugin.readManifest')(function* (manifestPath: string) {
  const raw = yield* readFileIfExists(manifestPath);
  if (raw === undefined) return yield* Effect.fail(new Error('manifest is missing'));
  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: cause => new Error('manifest is not valid JSON', {cause}),
  });
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).name !== 'string' ||
    typeof (parsed as Record<string, unknown>).version !== 'string' ||
    !isSemver((parsed as Record<string, unknown>).version as string)
  ) {
    return yield* Effect.fail(new Error('manifest must declare string name and semantic version fields'));
  }
  return parsed as CursorPluginManifest;
});

const hasManagedCursorPluginMarker = Effect.fn('cursorPlugin.hasManagedMarker')(function* (pluginRoot: string) {
  const path = yield* Path.Path;
  const raw = yield* readFileIfExists(path.join(pluginRoot, CURSOR_PLUGIN_MARKER));
  return isManagedCursorPluginMarker(raw);
});

const localCursorPluginRoot = Effect.fn('cursorPlugin.localRoot')(() =>
  expandPath(`~/.cursor/plugins/local/${CURSOR_PLUGIN_NAME}`),
);

const isSymbolicLink = Effect.fn('cursorPlugin.isSymbolicLink')(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  return Option.isSome(yield* fs.readLink(target).pipe(Effect.option));
});

const directoryTreesMatch = Effect.fn('cursorPlugin.directoryTreesMatch')(function* (
  sourceRoot: string,
  targetRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [sourceEntries, targetEntries] = yield* Effect.all([
    fs.readDirectory(sourceRoot, {recursive: true}),
    fs.readDirectory(targetRoot, {recursive: true}),
  ]);
  const sourceByNormalizedPath = new Map(sourceEntries.map(entry => [normalizePath(entry), entry]));
  const targetByNormalizedPath = new Map(targetEntries.map(entry => [normalizePath(entry), entry]));
  const sourcePaths = [...sourceByNormalizedPath.keys()].sort();
  const targetPaths = [...targetByNormalizedPath.keys()].sort();
  if (JSON.stringify(sourcePaths) !== JSON.stringify(targetPaths)) return false;
  for (const relative of sourcePaths) {
    const sourceEntry = path.join(sourceRoot, sourceByNormalizedPath.get(relative)!);
    const targetEntry = path.join(targetRoot, targetByNormalizedPath.get(relative)!);
    const [sourceInfo, targetInfo] = yield* Effect.all([fs.stat(sourceEntry), fs.stat(targetEntry)]);
    if (sourceInfo.type !== targetInfo.type) return false;
    if (sourceInfo.type === 'File' && (yield* sha256FileHex(sourceEntry)) !== (yield* sha256FileHex(targetEntry))) {
      return false;
    }
  }
  return true;
});

function isManagedCursorPluginMarker(content: string | undefined): boolean {
  if (content === undefined) return false;
  try {
    const parsed = JSON.parse(content) as unknown;
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).managedBy === 'threadnote' &&
      (parsed as Record<string, unknown>).schemaVersion === CURSOR_PLUGIN_MARKER_SCHEMA_VERSION
    );
  } catch {
    return false;
  }
}

function cursorRuleProblem(content: string): string | undefined {
  const normalized = normalizeNewlines(content);
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)?.[1];
  if (!frontmatter) return 'has no valid MDC frontmatter';
  if (!/^description:\s*\S.+$/m.test(frontmatter)) return 'has no non-empty description';
  if (!/^alwaysApply:\s*true\s*$/m.test(frontmatter)) return 'is not marked alwaysApply: true';
  const start = normalized.indexOf(USER_INSTRUCTIONS_START_MARKER);
  const end = normalized.indexOf(USER_INSTRUCTIONS_END_MARKER);
  if (start === -1 || end < start) return 'does not contain the complete Threadnote instruction block';
  return undefined;
}

function compareSemver(left: string, right: string): number {
  const [leftCore, leftPrerelease] = left.split('-', 2);
  const [rightCore, rightPrerelease] = right.split('-', 2);
  const leftParts = leftCore!.split('.').map(Number);
  const rightParts = rightCore!.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  if (leftPrerelease === rightPrerelease) return 0;
  if (leftPrerelease === undefined) return 1;
  if (rightPrerelease === undefined) return -1;
  return leftPrerelease.localeCompare(rightPrerelease);
}

function isSemver(value: string): boolean {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function normalizeNewlines(value: string): string {
  return value.replaceAll('\r\n', '\n');
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/');
}
