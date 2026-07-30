import {Console, Crypto, Effect, FileSystem, Path, Result} from 'effect';
import {
  heading,
  info as infoText,
  keyValue,
  promptForConfirmation,
  success,
  warning,
  withSpinnerEffect,
} from './cli_ui.js';
import {installCommandShim} from './command-shim.js';
import {extractGzipTar} from './effect/archive.js';
import {maybeRunEffect, runCommandEffect, runStreamingCommandEffect} from './effect/command.js';
import {applicationError, fromSync} from './effect/errors.js';
import {syncDirectoryBestEffort, syncWritableFile} from './effect/file_durability.js';
import {withExclusiveFileLock} from './effect/file_lock.js';
import {getJsonEffect, HttpService} from './effect/http.js';
import {sha256FileHex} from './effect/digest.js';
import {SystemInfo, type SystemInfoShape} from './effect/system.js';
import {
  activateStandaloneRelease,
  installationRoot,
  promoteStandaloneReleaseDirectory,
  pruneStandaloneReleases,
  type StandalonePromotionFaultInjection,
  withStandaloneInstallationLock,
} from './installations.js';
import {hasLegacyLifecycleHandoffCandidates, hasProjectNameMigrationCandidates} from './memory.js';
import {isLegacyHomeMigrationPending} from './migration/home.js';
import {whatsNewLinesForVersionRange} from './release_notes.js';
import type {JsonObject, PostUpdateOptions, RuntimeConfig, UpdateOptions} from './types.js';
import {selectUpdateChannel, type UpdateChannel} from './update_channel.js';
import {
  compareVersions,
  ensureDirectory,
  errorMessage,
  currentPackageVersion,
  isJsonObject,
  readFileIfExists,
  toolRoot,
  formatShellCommand,
} from './utils.js';

const THREADNOTE_COMMAND = 'threadnote';
const DEFAULT_RELEASE_SOURCE = 'https://api.github.com/repos/Kashkovsky/threadnote/releases?per_page=100';
const ALLOW_UNTRUSTED_SOURCE_ENV = 'THREADNOTE_ALLOW_UNTRUSTED_RELEASE_SOURCE';
const RELEASE_SOURCE_ENV = 'THREADNOTE_RELEASE_SOURCE';
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const POST_UPDATE_MIGRATIONS_FILE = 'post-update-migrations.json';
const POST_UPDATE_STATE_FILE = 'post-update-state.json';
const POST_UPDATE_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 60_000,
  waitTimeoutMilliseconds: 10 * 60_000,
} as const;

interface UpdateInfo {
  readonly channel: UpdateChannel;
  readonly currentVersion: string;
  readonly isChannelSwitch: boolean;
  readonly isUpdateAvailable: boolean;
  readonly isVersionUpgrade: boolean;
  readonly latestVersion: string | undefined;
  readonly source: string;
}

interface UpdateCache {
  readonly channel: UpdateChannel;
  readonly checkedAt: string;
  readonly latestVersion: string;
  readonly source: string;
}

interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
}

interface AvailableRelease {
  readonly assets: readonly ReleaseAsset[];
  readonly immutable: true;
  readonly prerelease: boolean;
  readonly version: string;
}

interface PostUpdateMigration {
  readonly appliesToPrereleases?: boolean;
  readonly commandArgs: readonly string[];
  readonly description: readonly string[];
  readonly id: string;
  readonly instructions: readonly string[];
  readonly introducedIn: string;
  readonly markHandledWhenSkipped?: boolean;
  readonly requiresLegacyHandoffs?: boolean;
  readonly requiresPendingHomeMigration?: boolean;
  readonly requiresProjectNameConsolidation?: boolean;
  readonly title: string;
}

interface PostUpdateState {
  readonly handledMigrationIds: readonly string[];
}

interface PostUpdateMigrationRunOptions {
  readonly dryRun: boolean;
  readonly fromVersion: string;
  readonly interactive: boolean;
  readonly markHandled: boolean;
  readonly toVersion: string;
  readonly yes: boolean;
}

export function maybeNotifyUpdate(config: RuntimeConfig, options: {readonly dryRun?: boolean} = {}) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    if (isUpdateNotificationDisabled(system.environment())) {
      return;
    }
    const source = yield* fromSync('resolve release source', () =>
      resolveReleaseSource(undefined, false, system.environment()),
    );
    const info = yield* getUpdateInfo(config, {
      allowCacheWrite: options.dryRun !== true,
      preferFresh: false,
      source,
      requestedChannel: undefined,
    });
    if (info.isUpdateAvailable) {
      yield* Console.log('');
      yield* Console.log(warning(`Update available: threadnote ${info.currentVersion} -> ${info.latestVersion}`));
      yield* Console.log(`Run: ${infoText('threadnote update')}`);
    }
  }).pipe(Effect.catch(() => Effect.void));
}

export const runUpdate = Effect.fn('runUpdate')(function* (config: RuntimeConfig, options: UpdateOptions) {
  const system = yield* SystemInfo;
  const requestedChannel = yield* fromSync('select update channel', () => requestedUpdateChannel(options));
  const source = yield* fromSync('resolve release source', () =>
    resolveReleaseSource(options.source, options.allowUntrustedSource, system.environment()),
  );
  const info = yield* withSpinnerEffect(
    'Checking GitHub for the latest standalone Threadnote release',
    getUpdateInfo(config, {
      allowCacheWrite: options.dryRun !== true,
      preferFresh: true,
      source,
      requestedChannel,
    }),
  );

  yield* Console.log(keyValue('Current version', infoText(info.currentVersion)));
  yield* Console.log(
    keyValue(
      info.channel === 'beta' ? 'Latest beta version' : 'Latest version',
      info.latestVersion ? infoText(info.latestVersion) : warning('not published'),
    ),
  );
  yield* Console.log(keyValue('Release source', info.source));
  if (requiresFreshStandaloneInstall(info.currentVersion)) {
    return yield* Effect.fail(
      new Error(
        'Threadnote 3 cannot update across the standalone-runtime boundary. Install Threadnote 4 fresh from the GitHub release installer.',
      ),
    );
  }

  if (info.latestVersion === undefined) {
    yield* Console.log('No beta release is currently published.');
    return;
  }
  const latestVersion = info.latestVersion;

  if (options.check === true) {
    if (info.isUpdateAvailable) {
      const command =
        requestedChannel === 'beta'
          ? 'threadnote update --beta'
          : requestedChannel === 'latest'
            ? 'threadnote update --stable'
            : 'threadnote update';
      yield* Console.log(warning(`${info.isChannelSwitch ? 'Channel switch' : 'Update'} available. Run: ${command}`));
      yield* printWhatsNewIfAvailable(info);
    } else {
      yield* Console.log(
        compareVersions(info.currentVersion, latestVersion) > 0
          ? warning(`Current version is newer than the published ${info.channel} release.`)
          : success('Threadnote is up to date.'),
      );
    }
    return;
  }

  if (!info.isUpdateAvailable && options.force !== true) {
    yield* Console.log(success('Threadnote is up to date.'));
    return;
  }

  const shouldRepair = options.repair !== false;
  const dryRun = options.dryRun === true;
  const releaseRoot = yield* withStandaloneInstallationLock(
    Effect.gen(function* () {
      const installed = yield* installStandaloneRelease({
        dryRun,
        force: options.force === true,
        source,
        version: latestVersion,
      });
      yield* installCommandShim(dryRun, installed);
      yield* activateStandaloneRelease(installed, dryRun);
      return installed;
    }),
    dryRun,
  );
  const path = yield* Path.Path;
  const threadnoteCommand = path.join(releaseRoot, system.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
  const postUpdateArgs = [
    'post-update',
    '--from-version',
    info.currentVersion,
    '--to-version',
    latestVersion,
    ...(options.yes === true ? ['--yes'] : []),
  ];
  if (options.postUpdate !== false) {
    yield* runStreamingSubcommand(dryRun, threadnoteCommand, postUpdateArgs);
  } else {
    yield* Console.log('Skipping post-update migration prompts because --no-post-update was provided.');
  }
  if (shouldRepair) {
    yield* Console.log('');
    yield* Console.log('Repairing local Threadnote setup after standalone update.');
    yield* runStreamingSubcommand(dryRun, threadnoteCommand, ['repair', '--no-post-update']);
  } else {
    yield* Console.log('Skipping repair because --no-repair was provided.');
  }
  yield* Console.log(
    'Update complete. Restart Cursor, Copilot, Codex, Claude, or open a fresh agent session so MCP tools reload.',
  );
  yield* withStandaloneInstallationLock(pruneStandaloneReleases(releaseRoot, dryRun), dryRun);
  yield* printWhatsNewIfAvailable(info);
});

const installStandaloneRelease = Effect.fn('update.installStandaloneRelease')(function* (options: {
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly source: string;
  readonly version: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const releaseRoot = path.join(installationRoot(path, system), 'versions', options.version);
  const artifactName = releaseArtifactName(system);
  const releases = yield* fetchAvailableReleases(options.source);
  const release = releases.find(candidate => compareVersions(candidate.version, options.version) === 0);
  if (!release) {
    return yield* Effect.fail(new Error(`GitHub release ${options.version} is no longer available.`));
  }
  const archiveAsset = release.assets.find(asset => asset.name === artifactName);
  const checksumAsset = release.assets.find(asset => asset.name === `${artifactName}.sha256`);
  if (!archiveAsset || !checksumAsset) {
    return yield* Effect.fail(
      new Error(
        `Release ${options.version} does not publish ${artifactName} and ${artifactName}.sha256 for this platform.`,
      ),
    );
  }
  if (options.dryRun) {
    yield* Console.log(`Would download verified release artifact: ${archiveAsset.url}`);
    yield* Console.log(`Would install standalone Threadnote to: ${releaseRoot}`);
    return releaseRoot;
  }

  yield* fs.makeDirectory(path.dirname(releaseRoot), {recursive: true, mode: 0o700});
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const temporaryRoot = yield* fs.makeTempDirectoryScoped({
        directory: path.dirname(releaseRoot),
        prefix: '.threadnote-update-',
      });
      const archivePath = path.join(temporaryRoot, artifactName);
      const extractedRoot = path.join(temporaryRoot, 'release');
      const http = yield* HttpService;
      yield* Console.log(`Downloading ${artifactName}`);
      yield* http.downloadToFile(archiveAsset.url, archivePath, {
        headers: releaseRequestHeaders(),
        timeoutMs: 10 * 60_000,
      });
      const checksumResponse = yield* http.getText(checksumAsset.url, {
        headers: releaseRequestHeaders(),
        timeoutMs: 30_000,
      });
      const expectedChecksum = yield* fromSync('parse release checksum', () =>
        parseReleaseChecksum(checksumResponse.body, artifactName),
      );
      const actualChecksum = yield* sha256FileHex(archivePath);
      if (actualChecksum !== expectedChecksum) {
        return yield* Effect.fail(
          new Error(`Checksum mismatch for ${artifactName}: expected ${expectedChecksum}, got ${actualChecksum}.`),
        );
      }
      yield* extractGzipTar(archivePath, extractedRoot);
      yield* validateExtractedRelease(fs, path, extractedRoot, options.version, system.platform);
      yield* verifyOfficialPlatformSignature(fs, path, extractedRoot, options.source, system);
      yield* promoteReleaseDirectory(fs, path, extractedRoot, releaseRoot, options.force, system.processId);
      yield* Console.log(`Installed standalone Threadnote ${options.version}: ${releaseRoot}`);
      return releaseRoot;
    }),
  );
});

export const verifyOfficialPlatformSignature = Effect.fn('update.verifyOfficialPlatformSignature')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  releaseRoot: string,
  source: string,
  system: SystemInfoShape,
) {
  if (source !== DEFAULT_RELEASE_SOURCE || system.platform === 'linux') return;
  const executable = path.join(releaseRoot, system.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
  if (system.platform === 'darwin') {
    for (const file of yield* findFilesRecursively(fs, path, path.join(releaseRoot, 'runtime'))) {
      const type = yield* runCommandEffect('file', ['--brief', file]);
      if (!type.stdout.includes('Mach-O')) continue;
      yield* runCommandEffect('codesign', ['--verify', '--strict', '--verbose=2', file]).pipe(
        Effect.mapError(cause => new Error(`Release signature validation failed for ${file}.`, {cause})),
      );
    }
    yield* runCommandEffect('codesign', ['--verify', '--strict', '--verbose=2', executable]).pipe(
      Effect.mapError(cause => new Error(`Release signature validation failed for ${executable}.`, {cause})),
    );
    return;
  }
  const script = [
    "$files=@((Get-Item -LiteralPath $env:THREADNOTE_SIGNED_EXECUTABLE)) + @(Get-ChildItem -LiteralPath $env:THREADNOTE_SIGNED_RUNTIME -Recurse -File | Where-Object { $_.Extension -in '.dll','.node' })",
    'foreach($file in $files){',
    '  $signature=Get-AuthenticodeSignature -LiteralPath $file.FullName',
    '  if($signature.Status -ne \'Valid\'){ throw "Invalid Authenticode signature for $($file.FullName): $($signature.Status)" }',
    '}',
  ].join('; ');
  yield* runCommandEffect('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: {
      ...system.environment(),
      THREADNOTE_SIGNED_EXECUTABLE: executable,
      THREADNOTE_SIGNED_RUNTIME: path.join(releaseRoot, 'runtime'),
    },
  }).pipe(Effect.mapError(cause => new Error('Release Authenticode validation failed.', {cause})));
});

const findFilesRecursively = Effect.fn('update.findFilesRecursively')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
) {
  if (!(yield* fs.exists(root))) return [] as readonly string[];
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const name of yield* fs.readDirectory(directory)) {
      const entry = path.join(directory, name);
      const info = yield* fs.stat(entry);
      if (info.type === 'Directory') pending.push(entry);
      else if (info.type === 'File') files.push(entry);
    }
  }
  return files.sort();
});

export function releaseArtifactName(system: Pick<SystemInfoShape, 'architecture' | 'platform'>): string {
  const platform = system.platform === 'win32' ? 'windows' : system.platform === 'darwin' ? 'darwin' : system.platform;
  const architecture = system.architecture === 'aarch64' ? 'arm64' : system.architecture;
  if (!['darwin', 'linux', 'windows'].includes(platform) || !['arm64', 'x64'].includes(architecture)) {
    throw new Error(`No standalone Threadnote artifact is available for ${platform}-${architecture}.`);
  }
  return `threadnote-${platform}-${architecture}.tar.gz`;
}

function releaseRequestHeaders(): Readonly<Record<string, string>> {
  return {
    accept: 'application/octet-stream',
    'user-agent': 'threadnote-cli',
  };
}

export function parseReleaseChecksum(content: string, artifactName: string): string {
  const line = content
    .split(/\r?\n/)
    .map(value => value.trim())
    .find(value => value.length > 0);
  const match = line ? /^([a-f0-9]{64})(?:\s+\*?(.+))?$/i.exec(line) : undefined;
  if (!match || (match[2] !== undefined && match[2] !== artifactName)) {
    throw new Error(`Invalid checksum document for ${artifactName}.`);
  }
  return match[1]!.toLowerCase();
}

const validateExtractedRelease = Effect.fn('update.validateExtractedRelease')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  releaseRoot: string,
  version: string,
  platform: NodeJS.Platform,
) {
  const metadataContent = yield* fs.readFileString(path.join(releaseRoot, 'release.json'));
  const metadata = yield* Effect.try({
    try: () => JSON.parse(metadataContent) as unknown,
    catch: cause => new Error('Release metadata is invalid.', {cause}),
  });
  const executable = platform === 'win32' ? 'threadnote.exe' : 'threadnote';
  if (
    !isJsonObject(metadata) ||
    metadata.version !== version ||
    metadata.executable !== executable ||
    !isJsonObject(metadata.codeGraphAssets) ||
    metadata.codeGraphAssets.manifest !== 'assets/code-graph/manifest.json' ||
    metadata.codeGraphAssets.version !== 1 ||
    !(yield* fs.exists(path.join(releaseRoot, executable))) ||
    !(yield* fs.exists(path.join(releaseRoot, 'runtime', 'node-llama-cpp.js')))
  ) {
    return yield* Effect.fail(new Error(`Release artifact validation failed for Threadnote ${version}.`));
  }
  yield* validateCodeGraphAssets(fs, path, releaseRoot);
  if (platform !== 'win32') {
    yield* fs.chmod(path.join(releaseRoot, executable), 0o755);
  }
});

const validateCodeGraphAssets = Effect.fn('update.validateCodeGraphAssets')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  releaseRoot: string,
) {
  const manifestPath = path.join(releaseRoot, 'assets', 'code-graph', 'manifest.json');
  const content = yield* fs.readFileString(manifestPath);
  const manifest = yield* Effect.try({
    try: () => JSON.parse(content) as unknown,
    catch: cause => new Error('Code graph asset manifest is invalid.', {cause}),
  });
  if (!isJsonObject(manifest) || manifest.version !== 1 || !isJsonObject(manifest.runtime)) {
    return yield* Effect.fail(new Error('Code graph asset manifest is invalid.'));
  }
  const grammars = isJsonObject(manifest.grammars) ? manifest.grammars : {};
  const expected = [
    {
      id: 'web-tree-sitter',
      metadata: manifest.runtime,
      path: 'runtime/web-tree-sitter.wasm',
      runtime: true,
    },
    {id: 'java', metadata: grammars.java, path: 'grammars/java.wasm', runtime: false},
    {id: 'kotlin', metadata: grammars.kotlin, path: 'grammars/kotlin.wasm', runtime: false},
    {id: 'swift', metadata: grammars.swift, path: 'grammars/swift.wasm', runtime: false},
  ] as const;
  for (const asset of expected) {
    if (
      !isJsonObject(asset.metadata) ||
      asset.metadata.path !== asset.path ||
      typeof asset.metadata.version !== 'string' ||
      typeof asset.metadata.source !== 'string' ||
      !asset.metadata.source.startsWith('https://github.com/') ||
      typeof asset.metadata.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(asset.metadata.sha256) ||
      (asset.runtime
        ? asset.metadata.id !== asset.id
        : !Number.isInteger(asset.metadata.abi) || Number(asset.metadata.abi) <= 0)
    ) {
      return yield* Effect.fail(new Error(`Code graph asset metadata is invalid for ${asset.path}.`));
    }
    const assetPath = path.join(releaseRoot, 'assets', 'code-graph', ...asset.path.split('/'));
    if (!(yield* fs.exists(assetPath)) || (yield* sha256FileHex(assetPath)) !== asset.metadata.sha256) {
      return yield* Effect.fail(new Error(`Code graph asset checksum validation failed for ${asset.path}.`));
    }
  }
  for (const license of [
    'tree-sitter-java.LICENSE',
    'tree-sitter-kotlin.LICENSE',
    'tree-sitter-swift.LICENSE',
    'web-tree-sitter.LICENSE',
  ]) {
    const licensePath = path.join(releaseRoot, 'assets', 'code-graph', 'licenses', license);
    if (!(yield* fs.exists(licensePath)) || (yield* fs.stat(licensePath)).size <= 0) {
      return yield* Effect.fail(new Error(`Code graph asset license is missing for ${license}.`));
    }
  }
});

export const promoteReleaseDirectory = Effect.fn('update.promoteReleaseDirectory')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  stagedRoot: string,
  releaseRoot: string,
  force: boolean,
  processId: number,
  faultInjection: StandalonePromotionFaultInjection = {},
) {
  void force;
  yield* promoteStandaloneReleaseDirectory(fs, path, stagedRoot, releaseRoot, processId, faultInjection);
});

function printWhatsNewIfAvailable(info: UpdateInfo) {
  if (!info.isVersionUpgrade || info.latestVersion === undefined) {
    return Effect.void;
  }
  const latestVersion = info.latestVersion;
  return Effect.gen(function* () {
    yield* Console.log('');
    const whatsNew = yield* withSpinnerEffect(
      'Fetching GitHub release notes',
      whatsNewLinesForVersionRange(info.currentVersion, latestVersion, {
        includePrereleases: info.channel === 'beta',
      }),
    );
    for (const line of whatsNew) {
      yield* Console.log(line === "What's new:" ? heading(line) : line);
    }
  });
}

export const runPostUpdate = Effect.fn('runPostUpdate')(function* (config: RuntimeConfig, options: PostUpdateOptions) {
  if (!options.fromVersion || !options.toVersion) {
    return yield* Effect.fail(
      applicationError(
        'validate post-update options',
        new Error('Provide --from-version and --to-version for post-update.'),
      ),
    );
  }
  const fromVersion = options.fromVersion;
  const toVersion = options.toVersion;
  const system = yield* SystemInfo;
  const interactive = system.stdinIsTTY && system.stdoutIsTTY;
  yield* runApplicablePostUpdateMigrations(config, {
    dryRun: options.dryRun === true,
    fromVersion,
    interactive,
    markHandled: true,
    toVersion,
    yes: options.yes === true,
  });
});

export function maybeRunPostUpdateAfterRepair(config: RuntimeConfig, options: {readonly dryRun: boolean}) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const toVersion = yield* currentPackageVersion();
    const interactive = system.stdinIsTTY && system.stdoutIsTTY;
    const state = yield* readPostUpdateState(config);
    const migrations = yield* applicablePostUpdateMigrations(config, {
      fromVersion: '0.0.0',
      handledMigrationIds: state.handledMigrationIds,
      toVersion,
    });
    if (migrations.length === 0) {
      return;
    }
    yield* Console.log('');
    yield* Console.log('Repair found package post-update actions.');
    yield* Console.log(
      'This also covers updates launched by older Threadnote versions that only knew how to run repair.',
    );
    if (!interactive) {
      yield* Console.log(
        'This process is non-interactive, so Threadnote will print the manual migration command instead of prompting.',
      );
      yield* Console.log(
        `Run the prompt manually with: threadnote post-update --from-version 0.0.0 --to-version ${toVersion}`,
      );
    }
    yield* runApplicablePostUpdateMigrations(config, {
      dryRun: options.dryRun,
      fromVersion: '0.0.0',
      interactive,
      markHandled: true,
      toVersion,
      yes: false,
    });
  });
}

/**
 * Run a subprocess with its stdout/stderr inherited so the user sees output
 * live, instead of buffering through the regular command runner. Dry-run
 * defers to `maybeRun` so it only prints the command it would run.
 */
function runStreamingSubcommand(dryRun: boolean, executable: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  if (dryRun) {
    return maybeRunEffect(true, executable, args).pipe(Effect.asVoid);
  }
  return Effect.gen(function* () {
    yield* Console.log(`Running: ${formatShellCommand(executable, args)}`);
    const result = yield* runStreamingCommandEffect(executable, args, {
      ...(env ? {env} : {}),
      inheritOutput: true,
    });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        applicationError(
          'run interactive subcommand',
          new Error(`${formatShellCommand(executable, args)} exited with ${result.exitCode}.`),
        ),
      );
    }
  });
}

function getUpdateInfo(
  config: RuntimeConfig,
  options: {
    readonly allowCacheWrite: boolean;
    readonly preferFresh: boolean;
    readonly source: string;
    readonly requestedChannel: UpdateChannel | undefined;
  },
) {
  return Effect.gen(function* () {
    const currentVersion = yield* currentPackageVersion();
    const inferredChannel = selectUpdateChannel(currentVersion);
    const channel = selectUpdateChannel(currentVersion, options.requestedChannel);
    const cached = options.preferFresh ? undefined : yield* readFreshCache(config, options.source, channel);
    const latestVersion = cached?.latestVersion ?? (yield* fetchLatestVersion(options.source, channel));
    if (!cached && latestVersion !== undefined && options.allowCacheWrite) {
      yield* writeUpdateCache(config, {
        channel,
        checkedAt: new Date().toISOString(),
        latestVersion,
        source: options.source,
      });
    }
    const isChannelSwitch = options.requestedChannel !== undefined && channel !== inferredChannel;
    const isVersionUpgrade = latestVersion !== undefined && compareVersions(currentVersion, latestVersion) < 0;
    return {
      channel,
      currentVersion,
      isChannelSwitch,
      isUpdateAvailable: latestVersion !== undefined && (isChannelSwitch || isVersionUpgrade),
      isVersionUpgrade,
      latestVersion,
      source: options.source,
    };
  });
}

export function requestedUpdateChannel(options: Pick<UpdateOptions, 'beta' | 'stable'>): UpdateChannel | undefined {
  if (options.beta === true && options.stable === true) {
    throw new Error('Choose either --beta or --stable, not both.');
  }
  if (options.beta === true) {
    return 'beta';
  }
  if (options.stable === true) {
    return 'latest';
  }
  return undefined;
}

export function requiresFreshStandaloneInstall(version: string): boolean {
  const major = Number.parseInt(stableVersionCore(version).split('.', 1)[0] ?? '', 10);
  return Number.isSafeInteger(major) && major < 4;
}

export {currentPackageVersion};

export const fetchLatestVersion = Effect.fn('fetchLatestVersion')(function* (
  source: string = DEFAULT_RELEASE_SOURCE,
  channel: UpdateChannel = 'latest',
) {
  const releases = yield* fetchAvailableReleases(source);
  const candidates = releases.filter(release => release.prerelease === (channel === 'beta'));
  return candidates.sort((left, right) => compareVersions(right.version, left.version))[0]?.version;
});

const fetchAvailableReleases = Effect.fn('update.fetchAvailableReleases')(function* (source: string) {
  const response = yield* getJsonEffect(source, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'threadnote-cli',
    },
    timeoutMs: 5000,
  }).pipe(
    Effect.mapError(cause =>
      applicationError(
        'check GitHub for updates',
        new Error(`Could not check GitHub for updates: ${errorMessage(cause)}`, {cause}),
      ),
    ),
  );
  if (!Array.isArray(response.body)) {
    return yield* Effect.fail(
      applicationError('check GitHub for updates', new Error('GitHub releases response was not an array.')),
    );
  }
  return response.body.flatMap(parseAvailableRelease);
});

function parseAvailableRelease(value: unknown): readonly AvailableRelease[] {
  if (!isJsonObject(value) || value.draft === true || value.immutable !== true || typeof value.tag_name !== 'string') {
    return [];
  }
  const version = value.tag_name.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !Array.isArray(value.assets)) {
    return [];
  }
  const assets = value.assets.flatMap(asset => {
    if (!isJsonObject(asset) || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') {
      return [];
    }
    return [{name: asset.name, url: asset.browser_download_url}];
  });
  return [{assets, immutable: true, prerelease: value.prerelease === true, version}];
}

const readFreshCache = Effect.fn('update.readFreshCache')(function* (
  config: RuntimeConfig,
  source: string,
  channel: UpdateChannel,
) {
  const rawCache = yield* readFileIfExists(yield* updateCachePath(config));
  if (!rawCache) {
    return undefined;
  }
  const parsedResult = Result.try((): unknown => JSON.parse(rawCache));
  if (Result.isFailure(parsedResult)) {
    return undefined;
  }
  const parsed = parsedResult.success;
  if (
    !isJsonObject(parsed) ||
    parsed.channel !== channel ||
    typeof parsed.checkedAt !== 'string' ||
    typeof parsed.latestVersion !== 'string' ||
    parsed.source !== source
  ) {
    return undefined;
  }
  const checkedAt = Date.parse(parsed.checkedAt);
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > UPDATE_CHECK_TTL_MS) {
    return undefined;
  }
  return {channel, checkedAt: parsed.checkedAt, latestVersion: parsed.latestVersion, source};
});

const writeUpdateCache = Effect.fn('update.writeCache')(function* (config: RuntimeConfig, cache: UpdateCache) {
  const fs = yield* FileSystem.FileSystem;
  yield* ensureDirectory(config.agentContextHome, false);
  yield* fs.writeFileString(yield* updateCachePath(config), `${JSON.stringify(cache, null, 2)}\n`, {mode: 0o600});
});

const updateCachePath = Effect.fn('update.cachePath')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, 'update-check.json');
});

const runApplicablePostUpdateMigrations = Effect.fn('update.runApplicableMigrations')(function* (
  config: RuntimeConfig,
  options: PostUpdateMigrationRunOptions,
) {
  const run = runApplicablePostUpdateMigrationsUnlocked(config, options);
  if (options.dryRun) return yield* run;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withExclusiveFileLock(
    fs,
    path.join(config.agentContextHome, 'locks', 'post-update-migrations.lock'),
    POST_UPDATE_LOCK_OPTIONS,
    run,
  );
});

const runApplicablePostUpdateMigrationsUnlocked = Effect.fn('update.runApplicableMigrationsUnlocked')(function* (
  config: RuntimeConfig,
  options: PostUpdateMigrationRunOptions,
) {
  const system = yield* SystemInfo;
  if (!options.dryRun) yield* removeInterruptedPostUpdateStateWrites(config);
  const state = yield* readPostUpdateState(config);
  const migrations = yield* applicablePostUpdateMigrations(config, {
    fromVersion: options.fromVersion,
    handledMigrationIds: state.handledMigrationIds,
    toVersion: options.toVersion,
  });
  if (migrations.length === 0) {
    yield* Console.log('No post-update actions apply.');
    return;
  }

  yield* Console.log('');
  yield* Console.log('Post-update actions are available.');
  const threadnoteCommand = currentThreadnoteCommand(system) ?? THREADNOTE_COMMAND;
  const handledMigrationIds = new Set(state.handledMigrationIds);
  const checkpoint = (migrationId: string) => {
    if (options.dryRun || !options.markHandled || handledMigrationIds.has(migrationId)) return Effect.void;
    handledMigrationIds.add(migrationId);
    return writePostUpdateState(config, {handledMigrationIds: [...handledMigrationIds].sort()});
  };
  for (const migration of migrations) {
    if (!(yield* migrationRequirementsSatisfied(config, migration))) {
      if (!options.dryRun) yield* checkpoint(migration.id);
      continue;
    }
    yield* printPostUpdateMigration(migration);
    const accepted =
      options.dryRun ||
      options.yes ||
      (options.interactive && (yield* promptForConfirmation('Apply this migration now? [y/N] ')));
    if (!accepted) {
      yield* Console.log('Skipped. Run manually later:');
      yield* Console.log(`  ${formatMigrationCommand(threadnoteCommand, migration.commandArgs)}`);
      if (options.interactive && migration.markHandledWhenSkipped === true) {
        yield* checkpoint(migration.id);
      }
      continue;
    }
    yield* runStreamingSubcommand(options.dryRun, threadnoteCommand, migration.commandArgs);
    if (!options.dryRun) {
      yield* checkpoint(migration.id);
      for (const instruction of migration.instructions) {
        yield* Console.log(instruction);
      }
    } else {
      yield* Console.log('After this migration succeeds, Threadnote will print:');
      for (const instruction of migration.instructions) {
        yield* Console.log(`  ${instruction}`);
      }
    }
  }
});

const applicablePostUpdateMigrations = Effect.fn('update.applicableMigrations')(function* (
  config: RuntimeConfig,
  options: {
    readonly fromVersion: string;
    readonly handledMigrationIds: readonly string[];
    readonly toVersion: string;
  },
) {
  const migrations = yield* readPostUpdateMigrations();
  const handled = new Set(options.handledMigrationIds);
  const applicable: PostUpdateMigration[] = [];
  for (const migration of migrations) {
    if (handled.has(migration.id)) {
      continue;
    }
    if (compareVersions(options.fromVersion, migration.introducedIn) >= 0) {
      continue;
    }
    if (!postUpdateMigrationReached(migration, options.fromVersion, options.toVersion)) {
      continue;
    }
    if (!(yield* migrationRequirementsSatisfied(config, migration))) {
      continue;
    }
    applicable.push(migration);
  }
  return applicable;
});

const migrationRequirementsSatisfied = Effect.fn('update.migrationRequirementsSatisfied')(function* (
  config: RuntimeConfig,
  migration: PostUpdateMigration,
) {
  if (migration.requiresLegacyHandoffs === true && !(yield* hasLegacyLifecycleHandoffCandidates(config))) {
    return false;
  }
  if (
    migration.requiresPendingHomeMigration === true &&
    !(yield* isLegacyHomeMigrationPending({targetHome: config.agentContextHome}))
  ) {
    return false;
  }
  if (migration.requiresProjectNameConsolidation === true && !(yield* hasProjectNameMigrationCandidates(config))) {
    return false;
  }
  return true;
});

const readPostUpdateMigrations = Effect.fn('update.readPostUpdateMigrations')(function* () {
  const path = yield* Path.Path;
  const raw = yield* readFileIfExists(path.join(yield* toolRoot(), 'config', POST_UPDATE_MIGRATIONS_FILE));
  if (!raw) {
    return [];
  }
  const parsed = yield* Effect.try({
    try: (): unknown => JSON.parse(raw),
    catch: cause => new Error(`Could not parse ${POST_UPDATE_MIGRATIONS_FILE}.`, {cause}),
  });
  if (!isJsonObject(parsed) || !Array.isArray(parsed.migrations)) {
    throw new Error(`${POST_UPDATE_MIGRATIONS_FILE} must contain a migrations array.`);
  }
  return parsed.migrations.map(parsePostUpdateMigration);
});

function parsePostUpdateMigration(value: unknown): PostUpdateMigration {
  if (
    !isJsonObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.introducedIn !== 'string' ||
    typeof value.title !== 'string' ||
    !Array.isArray(value.description) ||
    !Array.isArray(value.commandArgs) ||
    !Array.isArray(value.instructions)
  ) {
    throw new Error(`Invalid entry in ${POST_UPDATE_MIGRATIONS_FILE}.`);
  }
  return {
    appliesToPrereleases: value.appliesToPrereleases === true,
    commandArgs: stringArray(value, 'commandArgs'),
    description: stringArray(value, 'description'),
    id: value.id,
    instructions: stringArray(value, 'instructions'),
    introducedIn: value.introducedIn,
    markHandledWhenSkipped: value.markHandledWhenSkipped === true,
    requiresLegacyHandoffs: value.requiresLegacyHandoffs === true,
    requiresPendingHomeMigration: value.requiresPendingHomeMigration === true,
    requiresProjectNameConsolidation: value.requiresProjectNameConsolidation === true,
    title: value.title,
  };
}

function postUpdateMigrationReached(migration: PostUpdateMigration, fromVersion: string, toVersion: string): boolean {
  if (compareVersions(migration.introducedIn, toVersion) <= 0) {
    return true;
  }
  return (
    migration.appliesToPrereleases === true &&
    compareVersions(fromVersion, toVersion) < 0 &&
    stableVersionCore(migration.introducedIn) === stableVersionCore(toVersion) &&
    toVersion.includes('-')
  );
}

function stableVersionCore(version: string): string {
  return version.trim().replace(/^v/, '').split(/[+-]/, 1)[0] ?? '';
}

function stringArray(value: JsonObject, key: string): readonly string[] {
  const raw = value[key];
  if (!Array.isArray(raw) || !raw.every(item => typeof item === 'string')) {
    throw new Error(`Invalid ${key} in ${POST_UPDATE_MIGRATIONS_FILE}.`);
  }
  return raw;
}

const printPostUpdateMigration = Effect.fn('update.printPostUpdateMigration')(function* (
  migration: PostUpdateMigration,
) {
  yield* Console.log('');
  yield* Console.log(`${migration.title} (${migration.introducedIn})`);
  for (const line of migration.description) {
    yield* Console.log(`- ${line}`);
  }
});

function formatMigrationCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(part => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

function currentThreadnoteCommand(system: SystemInfoShape): string | undefined {
  const executable = system.executablePath.trim();
  return executable || undefined;
}

const readPostUpdateState = Effect.fn('update.readPostUpdateState')(function* (config: RuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
  const statePath = yield* postUpdateStatePath(config);
  if (!(yield* fs.exists(statePath))) {
    return {handledMigrationIds: []};
  }
  const raw = yield* fs.readFileString(statePath);
  const parsedResult = Result.try((): unknown => JSON.parse(raw));
  if (Result.isFailure(parsedResult)) {
    return yield* Effect.fail(new Error(`Post-update state is invalid and was preserved: ${statePath}`));
  }
  const parsed = parsedResult.success;
  if (!isJsonObject(parsed) || !Array.isArray(parsed.handledMigrationIds)) {
    return yield* Effect.fail(new Error(`Post-update state is invalid and was preserved: ${statePath}`));
  }
  if (!parsed.handledMigrationIds.every((id): id is string => typeof id === 'string')) {
    return yield* Effect.fail(new Error(`Post-update state is invalid and was preserved: ${statePath}`));
  }
  return {handledMigrationIds: [...new Set(parsed.handledMigrationIds)].sort()};
});

const removeInterruptedPostUpdateStateWrites = Effect.fn('update.removeInterruptedStateWrites')(function* (
  config: RuntimeConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(config.agentContextHome))) return;
  for (const name of yield* fs.readDirectory(config.agentContextHome)) {
    if (/^\.post-update-state\.json\.[0-9a-f-]+\.tmp$/i.test(name)) {
      yield* fs.remove(path.join(config.agentContextHome, name), {force: true});
    }
  }
});

const writePostUpdateState = Effect.fn('update.writePostUpdateState')(function* (
  config: RuntimeConfig,
  state: PostUpdateState,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const target = yield* postUpdateStatePath(config);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${yield* crypto.randomUUIDv4}.tmp`);
  yield* ensureDirectory(config.agentContextHome, false);
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, `${JSON.stringify(state, null, 2)}\n`, {flag: 'wx', mode: 0o600});
    yield* syncWritableFile(fs, temporary);
    yield* fs.rename(temporary, target);
    yield* syncDirectoryBestEffort(fs, path.dirname(target));
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.catch(() => Effect.void))));
});

const postUpdateStatePath = Effect.fn('update.postUpdateStatePath')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, POST_UPDATE_STATE_FILE);
});

export function releaseSource(environment: NodeJS.ProcessEnv): string {
  return resolveReleaseSource(undefined, false, environment);
}

export function resolveReleaseSource(
  source: string | undefined,
  allowUntrustedSource: boolean | undefined,
  environment: NodeJS.ProcessEnv,
): string {
  const untrustedSourceAllowed = allowsUntrustedSource(allowUntrustedSource, environment);
  const normalized = normalizeReleaseSource(
    source ?? environment[RELEASE_SOURCE_ENV] ?? DEFAULT_RELEASE_SOURCE,
    untrustedSourceAllowed,
  );
  if (normalized !== DEFAULT_RELEASE_SOURCE && !untrustedSourceAllowed) {
    throw new Error(
      `Refusing custom release source ${normalized}. Use the official GitHub releases API, pass --allow-untrusted-source, or set ${ALLOW_UNTRUSTED_SOURCE_ENV}=1 only for an approved mirror.`,
    );
  }
  return normalized;
}

function normalizeReleaseSource(source: string, untrustedSourceAllowed: boolean): string {
  const url = new URL(source);
  const localDevelopmentSource =
    untrustedSourceAllowed &&
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !localDevelopmentSource) {
    throw new Error(`Release source must use https: ${source}`);
  }
  return url.toString();
}

function allowsUntrustedSource(option: boolean | undefined, environment: NodeJS.ProcessEnv): boolean {
  if (option === true) {
    return true;
  }
  const envValue = environment[ALLOW_UNTRUSTED_SOURCE_ENV]?.trim().toLowerCase();
  return envValue === '1' || envValue === 'true' || envValue === 'yes';
}

function isUpdateNotificationDisabled(environment: NodeJS.ProcessEnv): boolean {
  return (
    environment.CI !== undefined ||
    environment.NO_UPDATE_NOTIFIER !== undefined ||
    environment.THREADNOTE_NO_UPDATE_CHECK !== undefined
  );
}
