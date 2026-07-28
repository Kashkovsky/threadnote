import {Console, Effect, FileSystem, Path, Result} from 'effect';
import {runCommandEffect} from './effect/command.js';
import {SystemInfo, type SystemInfoShape} from './effect/system.js';

export const SUPPORTED_NODE_RANGE = '^22.22.2 || ^24.15.0 || >=26.0.0';
export const RECOMMENDED_NODE_VERSION = '24.18.0';

interface ParsedNodeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function isSupportedNodeVersion(version: string): boolean {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  if (parsed.major === 22) return atLeast(parsed, {major: 22, minor: 22, patch: 2});
  if (parsed.major === 24) return atLeast(parsed, {major: 24, minor: 15, patch: 0});
  return parsed.major >= 26;
}

export function unsupportedNodeVersionMessage(
  version: string,
  system: Pick<SystemInfoShape, 'environment' | 'executablePath' | 'platform'>,
): string {
  const environment = system.environment();
  const lines = [
    `Threadnote requires Node ${SUPPORTED_NODE_RANGE}; current runtime is ${normalizeNodeVersion(version)}.`,
    'Upgrade Node before installing or updating Threadnote, then open a new terminal and rerun the Threadnote bootstrap installer on the same stable or beta channel.',
  ];
  if (
    environment.NVM_DIR !== undefined ||
    environment.NVM_HOME !== undefined ||
    /(?:^|[\\/])nvm(?:[\\/]|$)/i.test(system.executablePath)
  ) {
    lines.push(
      system.platform === 'win32'
        ? `nvm-windows: nvm install ${RECOMMENDED_NODE_VERSION} && nvm use ${RECOMMENDED_NODE_VERSION}`
        : 'nvm: nvm install 24 && nvm use 24',
    );
  } else if (system.platform === 'darwin' && /(?:homebrew|Cellar)/i.test(system.executablePath)) {
    lines.push('Homebrew: brew update && brew upgrade node (or install/upgrade node@24).');
  } else if (system.platform === 'win32') {
    lines.push('Windows: winget upgrade --id OpenJS.NodeJS.LTS -e (or install the current Node.js LTS MSI).');
  } else {
    lines.push('Install the current Node.js 24 LTS release with your existing package or version manager.');
  }
  if (environment.NVM_DIR !== undefined || environment.NVM_HOME !== undefined) {
    lines.push('nvm global packages are Node-version scoped, so the old Threadnote command may no longer be on PATH.');
  }
  lines.push('For a beta reinstall, set THREADNOTE_PACKAGE=threadnote@beta when running the bootstrap installer.');
  lines.push('Threadnote does not change the system Node installation automatically.');
  return lines.join('\n');
}

export const assertSupportedNodeRuntime = Effect.fn('nodeRuntime.assertSupported')(function* () {
  const system = yield* SystemInfo;
  if (!isSupportedNodeVersion(system.nodeVersion)) {
    return yield* Effect.fail(new Error(unsupportedNodeVersionMessage(system.nodeVersion, system)));
  }
});

export const cleanupStaleNvmThreadnoteInstallations = Effect.fn('nodeRuntime.cleanupStaleNvmInstalls')(
  function* (options: {readonly dryRun: boolean}) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const roots = nvmVersionRoots(path, system);
    for (const root of roots) {
      const names = yield* fs.readDirectory(root.path).pipe(Effect.catch(() => Effect.succeed([])));
      for (const name of names) {
        const version = normalizeNodeVersion(name);
        if (version === normalizeNodeVersion(system.nodeVersion)) continue;
        const versionRoot = path.join(root.path, name);
        const packageRoot = root.windows
          ? path.join(versionRoot, 'node_modules', 'threadnote')
          : path.join(versionRoot, 'lib', 'node_modules', 'threadnote');
        const packageVersion = yield* verifiedThreadnotePackageVersion(fs, path, versionRoot, packageRoot);
        if (!packageVersion) continue;
        if (options.dryRun) {
          yield* Console.log(`Would remove stale Threadnote ${packageVersion} from nvm Node ${version}.`);
          continue;
        }
        const node = path.join(versionRoot, root.windows ? 'node.exe' : 'bin/node');
        const npmCli = root.windows
          ? path.join(versionRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')
          : path.join(versionRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
        if (!(yield* fs.exists(node)) || !(yield* fs.exists(npmCli))) {
          yield* Console.warn(
            `WARN could not remove stale Threadnote ${packageVersion} from nvm Node ${version}: npm runtime is missing.`,
          );
          continue;
        }
        const result = yield* runCommandEffect(
          node,
          [npmCli, 'uninstall', '--global', '--prefix', versionRoot, 'threadnote', '--ignore-scripts'],
          {
            allowFailure: true,
          },
        ).pipe(Effect.result);
        if (
          Result.isSuccess(result) &&
          result.success.exitCode === 0 &&
          !(yield* fs.exists(path.join(packageRoot, 'package.json')))
        ) {
          yield* Console.log(`Removed stale Threadnote ${packageVersion} from nvm Node ${version}.`);
        } else {
          const detail = Result.isSuccess(result)
            ? result.success.stderr.trim() || `npm exited with ${result.success.exitCode}`
            : String(result.failure);
          yield* Console.warn(
            `WARN could not remove stale Threadnote ${packageVersion} from nvm Node ${version}: ${detail}`,
          );
        }
      }
    }
  },
);

function parseNodeVersion(value: string): ParsedNodeVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return undefined;
  return {major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3])};
}

function atLeast(left: ParsedNodeVersion, right: ParsedNodeVersion): boolean {
  return (
    left.major > right.major ||
    (left.major === right.major &&
      (left.minor > right.minor || (left.minor === right.minor && left.patch >= right.patch)))
  );
}

function normalizeNodeVersion(value: string): string {
  return value.trim().replace(/^v/i, '');
}

function nvmVersionRoots(
  path: Path.Path,
  system: Pick<SystemInfoShape, 'environment' | 'platform'>,
): readonly {readonly path: string; readonly windows: boolean}[] {
  const environment = system.environment();
  const roots: Array<{readonly path: string; readonly windows: boolean}> = [];
  if (environment.NVM_DIR) {
    roots.push({path: path.join(environment.NVM_DIR, 'versions', 'node'), windows: false});
  }
  if (system.platform === 'win32' && environment.NVM_HOME) {
    roots.push({path: environment.NVM_HOME, windows: true});
  }
  return roots.filter((root, index) => roots.findIndex(candidate => candidate.path === root.path) === index);
}

function verifiedThreadnotePackageVersion(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  versionRoot: string,
  packageRoot: string,
): Effect.Effect<string | undefined> {
  return Effect.gen(function* () {
    const [resolvedVersionRoot, resolvedPackageRoot] = yield* Effect.all([
      fs.realPath(versionRoot),
      fs.realPath(packageRoot),
    ]);
    const relativePackageRoot = path.relative(resolvedVersionRoot, resolvedPackageRoot);
    if (
      relativePackageRoot === '' ||
      relativePackageRoot === '..' ||
      relativePackageRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePackageRoot)
    ) {
      return undefined;
    }
    const content = yield* fs.readFileString(path.join(resolvedPackageRoot, 'package.json'));
    const decoded = Result.try(() => JSON.parse(content) as {readonly name?: unknown; readonly version?: unknown});
    if (Result.isFailure(decoded)) return undefined;
    return decoded.success.name === 'threadnote' && typeof decoded.success.version === 'string'
      ? decoded.success.version
      : undefined;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
}
