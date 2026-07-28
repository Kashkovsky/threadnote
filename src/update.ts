import {Console, Effect, FileSystem, Path, Result} from 'effect';
import {
  heading,
  info as infoText,
  keyValue,
  promptForConfirmation,
  success,
  warning,
  withSpinnerEffect,
} from './cli_ui.js';
import {installCommandShim, installedThreadnoteRootFromLauncher} from './command-shim.js';
import {maybeRunEffect, runCommandEffect, runStreamingCommandEffect} from './effect/command.js';
import {applicationError, fromSync} from './effect/errors.js';
import {getJsonEffect} from './effect/http.js';
import {SystemInfo, type SystemInfoShape} from './effect/system.js';
import {hasLegacyLifecycleHandoffCandidates, hasProjectNameMigrationCandidates} from './memory.js';
import {isLegacyHomeMigrationPending} from './migration/home.js';
import {assertSupportedNodeRuntime, cleanupStaleNvmThreadnoteInstallations} from './node-runtime.js';
import {whatsNewLinesForVersionRange} from './release_notes.js';
import type {JsonObject, PostUpdateOptions, RuntimeConfig, UpdateOptions, UpdateRuntime} from './types.js';
import {selectUpdateChannel, type UpdateChannel} from './update_channel.js';
import {
  compareVersions,
  ensureDirectory,
  errorMessage,
  findExecutable,
  currentPackageVersion,
  isJsonObject,
  readFileIfExists,
  toolRoot,
  formatShellCommand,
} from './utils.js';

const NPM_PACKAGE_NAME = 'threadnote';
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';
const ALLOW_UNTRUSTED_REGISTRY_ENV = 'THREADNOTE_ALLOW_UNTRUSTED_NPM_REGISTRY';
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const POST_UPDATE_MIGRATIONS_FILE = 'post-update-migrations.json';
const POST_UPDATE_STATE_FILE = 'post-update-state.json';

interface UpdateInfo {
  readonly channel: UpdateChannel;
  readonly currentVersion: string;
  readonly isChannelSwitch: boolean;
  readonly isUpdateAvailable: boolean;
  readonly isVersionUpgrade: boolean;
  readonly latestVersion: string | undefined;
  readonly registry: string;
}

interface UpdateCache {
  readonly channel: UpdateChannel;
  readonly checkedAt: string;
  readonly latestVersion: string;
  readonly registry: string;
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

export function parseUpdateRuntime(value: string): UpdateRuntime {
  if (value === 'auto' || value === 'npm' || value === 'bun' || value === 'deno') {
    return value;
  }
  throw new Error(`Invalid update runtime: ${value}. Expected auto, npm, bun, or deno.`);
}

export function maybeNotifyUpdate(config: RuntimeConfig, options: {readonly dryRun?: boolean} = {}) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    if (isUpdateNotificationDisabled(system.environment())) {
      return;
    }
    const registry = yield* fromSync('resolve update registry', () =>
      resolveUpdateRegistry(undefined, false, system.environment()),
    );
    const info = yield* getUpdateInfo(config, {
      allowCacheWrite: options.dryRun !== true,
      preferFresh: false,
      registry,
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
  yield* assertSupportedNodeRuntime();
  const system = yield* SystemInfo;
  const requestedChannel = yield* fromSync('select update channel', () => requestedUpdateChannel(options));
  const registry = yield* fromSync('resolve update registry', () =>
    resolveUpdateRegistry(options.registry, options.allowUntrustedRegistry, system.environment()),
  );
  const info = yield* withSpinnerEffect(
    'Checking npm for latest threadnote version',
    getUpdateInfo(config, {
      allowCacheWrite: options.dryRun !== true,
      preferFresh: true,
      registry,
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
  yield* Console.log(keyValue('Registry', info.registry));

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
          ? warning(`Current version is newer than npm ${info.channel}.`)
          : success('Threadnote is up to date.'),
      );
    }
    return;
  }

  if (!info.isUpdateAvailable && options.force !== true) {
    yield* Console.log(success('Threadnote is up to date.'));
    return;
  }

  const runtime = yield* resolveUpdateRuntime(options.runtime ?? 'auto');
  const runtimeExecutable = (yield* findExecutable([runtime])) ?? runtime;
  const updateCommand = updatePackageCommand(runtime, registry, info.channel, runtimeExecutable, system.environment());
  yield* runStreamingSubcommand(
    options.dryRun === true,
    updateCommand.executable,
    updateCommand.args,
    updateCommand.env,
  );

  const shouldRepair = options.repair !== false;
  const threadnoteCommand = yield* installedThreadnoteCommand(runtime, runtimeExecutable);
  const installedPackageRoot = yield* installedThreadnoteRootFromLauncher(threadnoteCommand);
  if (installedPackageRoot !== undefined) {
    yield* installCommandShim(options.dryRun === true, installedPackageRoot);
  }
  const postUpdateArgs = [
    'post-update',
    '--from-version',
    info.currentVersion,
    '--to-version',
    latestVersion,
    ...(options.yes === true ? ['--yes'] : []),
  ];
  const crossesSelfContainedHomeBoundary = crossesMajorVersion(info.currentVersion, latestVersion, 4);
  if (crossesSelfContainedHomeBoundary) {
    if (options.postUpdate !== false) {
      yield* Console.log('');
      yield* Console.log('Migrating the Threadnote home before repair initializes the 4.x layout.');
      yield* runStreamingSubcommand(options.dryRun === true, threadnoteCommand, postUpdateArgs);
    } else {
      yield* Console.log('Skipping post-update migration prompts because --no-post-update was provided.');
    }
    if (shouldRepair && options.postUpdate !== false && options.yes === true) {
      yield* Console.log('');
      yield* Console.log('Repairing local Threadnote setup after home migration.');
      yield* runStreamingSubcommand(options.dryRun === true, threadnoteCommand, ['repair', '--no-post-update']);
    } else if (shouldRepair) {
      yield* Console.log('Repair was deferred so it cannot create ~/.threadnote before migration is accepted.');
      yield* Console.log(`Run: ${threadnoteCommand} migrate --apply`);
      yield* Console.log(`Then: ${threadnoteCommand} repair`);
    } else {
      yield* Console.log('Skipping repair because --no-repair was provided.');
    }
  } else {
    if (shouldRepair) {
      yield* Console.log('');
      yield* Console.log('Repairing local Threadnote setup after package update.');
      yield* runStreamingSubcommand(options.dryRun === true, threadnoteCommand, ['repair', '--no-post-update']);
    } else {
      yield* Console.log('Skipping repair because --no-repair was provided.');
    }
    if (options.postUpdate !== false) {
      yield* runStreamingSubcommand(options.dryRun === true, threadnoteCommand, postUpdateArgs);
    } else {
      yield* Console.log('Skipping post-update migration prompts because --no-post-update was provided.');
    }
  }
  yield* cleanupStaleNvmThreadnoteInstallations({dryRun: options.dryRun === true});
  yield* Console.log(
    'Update complete. Restart Cursor, Copilot, Codex, Claude, or open a fresh agent session so MCP tools reload.',
  );
  yield* printWhatsNewIfAvailable(info);
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
    readonly registry: string;
    readonly requestedChannel: UpdateChannel | undefined;
  },
) {
  return Effect.gen(function* () {
    const currentVersion = yield* currentPackageVersion();
    const inferredChannel = selectUpdateChannel(currentVersion);
    const channel = selectUpdateChannel(currentVersion, options.requestedChannel);
    const cached = options.preferFresh ? undefined : yield* readFreshCache(config, options.registry, channel);
    const latestVersion = cached?.latestVersion ?? (yield* fetchLatestVersion(options.registry, channel));
    if (!cached && latestVersion !== undefined && options.allowCacheWrite) {
      yield* writeUpdateCache(config, {
        channel,
        checkedAt: new Date().toISOString(),
        latestVersion,
        registry: options.registry,
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
      registry: options.registry,
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

export {currentPackageVersion};

export const fetchLatestVersion = Effect.fn('fetchLatestVersion')(function* (
  registry: string,
  channel: UpdateChannel = 'latest',
) {
  const url = yield* fromSync(
    'build npm registry URL',
    () => new URL(`${NPM_PACKAGE_NAME}/${channel}`, normalizeRegistry(registry)),
  );
  const response = yield* getJsonEffect(url, {headers: {accept: 'application/json'}, timeoutMs: 2500}).pipe(
    Effect.catchTag('HttpStatusError', cause =>
      channel === 'beta' && cause.status === 404 ? Effect.succeed(undefined) : Effect.fail(cause),
    ),
    Effect.mapError(cause =>
      applicationError(
        'check npm for updates',
        new Error(`Could not check npm for updates: ${errorMessage(cause)}`, {cause}),
      ),
    ),
  );
  if (response === undefined) {
    return undefined;
  }
  if (!isJsonObject(response.body) || typeof response.body.version !== 'string') {
    return yield* Effect.fail(
      applicationError('check npm for updates', new Error('npm registry response did not include a version.')),
    );
  }
  return response.body.version;
});

const readFreshCache = Effect.fn('update.readFreshCache')(function* (
  config: RuntimeConfig,
  registry: string,
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
    parsed.registry !== registry
  ) {
    return undefined;
  }
  const checkedAt = Date.parse(parsed.checkedAt);
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > UPDATE_CHECK_TTL_MS) {
    return undefined;
  }
  return {channel, checkedAt: parsed.checkedAt, latestVersion: parsed.latestVersion, registry};
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
  options: {
    readonly dryRun: boolean;
    readonly fromVersion: string;
    readonly interactive: boolean;
    readonly markHandled: boolean;
    readonly toVersion: string;
    readonly yes: boolean;
  },
) {
  const system = yield* SystemInfo;
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
  const threadnoteCommand =
    currentThreadnoteCommand(system) ?? (yield* findExecutable([NPM_PACKAGE_NAME])) ?? NPM_PACKAGE_NAME;
  const handledMigrationIds = new Set(state.handledMigrationIds);
  for (const migration of migrations) {
    if (!(yield* migrationRequirementsSatisfied(config, migration))) {
      if (!options.dryRun) {
        handledMigrationIds.add(migration.id);
      }
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
        handledMigrationIds.add(migration.id);
      }
      continue;
    }
    yield* runStreamingSubcommand(options.dryRun, threadnoteCommand, migration.commandArgs);
    if (!options.dryRun) {
      handledMigrationIds.add(migration.id);
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

  const nextHandledMigrationIds = [...handledMigrationIds].sort();
  const previousHandledMigrationIds = [...state.handledMigrationIds].sort();
  if (!options.dryRun && options.markHandled && !arraysEqual(nextHandledMigrationIds, previousHandledMigrationIds)) {
    yield* writePostUpdateState(config, {handledMigrationIds: nextHandledMigrationIds});
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

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

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

function crossesMajorVersion(fromVersion: string, toVersion: string, major: number): boolean {
  const versionMajor = (version: string): number | undefined => {
    const parsed = /^(\d+)(?:\.|$)/.exec(stableVersionCore(version));
    return parsed ? Number(parsed[1]) : undefined;
  };
  const fromMajor = versionMajor(fromVersion);
  const toMajor = versionMajor(toVersion);
  return fromMajor !== undefined && toMajor !== undefined && fromMajor < major && toMajor >= major;
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
  const entrypoint = system.processArguments[1]?.trim();
  return entrypoint ? entrypoint : undefined;
}

const readPostUpdateState = Effect.fn('update.readPostUpdateState')(function* (config: RuntimeConfig) {
  const raw = yield* readFileIfExists(yield* postUpdateStatePath(config));
  if (!raw) {
    return {handledMigrationIds: []};
  }
  const parsedResult = Result.try((): unknown => JSON.parse(raw));
  if (Result.isFailure(parsedResult)) {
    return {handledMigrationIds: []};
  }
  const parsed = parsedResult.success;
  if (!isJsonObject(parsed) || !Array.isArray(parsed.handledMigrationIds)) {
    return {handledMigrationIds: []};
  }
  return {handledMigrationIds: parsed.handledMigrationIds.filter((id): id is string => typeof id === 'string')};
});

const writePostUpdateState = Effect.fn('update.writePostUpdateState')(function* (
  config: RuntimeConfig,
  state: PostUpdateState,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* ensureDirectory(config.agentContextHome, false);
  yield* fs.writeFileString(yield* postUpdateStatePath(config), `${JSON.stringify(state, null, 2)}\n`, {mode: 0o600});
});

const postUpdateStatePath = Effect.fn('update.postUpdateStatePath')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, POST_UPDATE_STATE_FILE);
});

const resolveUpdateRuntime = Effect.fn('update.resolveRuntime')(function* (runtime: UpdateRuntime) {
  if (runtime !== 'auto') {
    yield* requireRuntime(runtime);
    return runtime;
  }
  for (const candidate of ['npm', 'bun', 'deno'] as const) {
    if (yield* findExecutable([candidate])) {
      return candidate;
    }
  }
  return yield* Effect.fail(new Error('Install Node/npm, Bun, or Deno to update threadnote.'));
});

const requireRuntime = Effect.fn('update.requireRuntime')(function* (runtime: Exclude<UpdateRuntime, 'auto'>) {
  if (!(yield* findExecutable([runtime]))) {
    return yield* Effect.fail(new Error(`${runtime} was requested but was not found on PATH.`));
  }
});

const installedThreadnoteCommand = Effect.fn('installedThreadnoteCommand')(function* (
  runtime: Exclude<UpdateRuntime, 'auto'>,
  runtimeExecutable: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const runtimeBin = yield* runtimeThreadnoteBin(runtime, runtimeExecutable);
  if (runtimeBin && (yield* isExecutableFileEffect(fs, runtimeBin, system.platform))) {
    return runtimeBin;
  }
  return (yield* findExecutable([NPM_PACKAGE_NAME])) ?? NPM_PACKAGE_NAME;
});

const runtimeThreadnoteBin = Effect.fn('runtimeThreadnoteBin')(function* (
  runtime: Exclude<UpdateRuntime, 'auto'>,
  runtimeExecutable: string,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  if (runtime === 'npm') {
    const result = yield* runCommandEffect(runtimeExecutable, ['prefix', '--global'], {allowFailure: true});
    const prefix = result.stdout.trim();
    return prefix ? runtimeThreadnoteBinPath(runtime, prefix, system.platform) : undefined;
  }
  if (runtime === 'bun') {
    const result = yield* runCommandEffect(runtimeExecutable, ['pm', 'bin', '-g'], {allowFailure: true});
    const binDir = result.stdout.trim();
    return binDir ? runtimeThreadnoteBinPath(runtime, binDir, system.platform) : undefined;
  }
  const environment = system.environment();
  const denoRoot =
    environment.DENO_INSTALL_ROOT ?? environment.DENO_INSTALL ?? path.join(system.homeDirectory, '.deno');
  return runtimeThreadnoteBinPath(runtime, path.join(denoRoot, 'bin'), system.platform);
});

const isExecutableFileEffect = Effect.fn('isExecutableFile')(function* (
  fs: FileSystem.FileSystem,
  filePath: string,
  currentPlatform: NodeJS.Platform,
) {
  const info = yield* fs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)));
  return info?.type === 'File' && (currentPlatform === 'win32' || (info.mode & 0o111) !== 0);
});

export function runtimeThreadnoteBinPath(
  runtime: Exclude<UpdateRuntime, 'auto'>,
  root: string,
  currentPlatform: NodeJS.Platform,
): string {
  const separator = currentPlatform === 'win32' ? '\\' : '/';
  const append = (...segments: readonly string[]): string => {
    const base = root.replace(/[\\/]+$/, '') || separator;
    return `${base}${base.endsWith(separator) ? '' : separator}${segments.join(separator)}`;
  };
  if (currentPlatform === 'win32') {
    return append(`${NPM_PACKAGE_NAME}.cmd`);
  }
  return runtime === 'npm' ? append('bin', NPM_PACKAGE_NAME) : append(NPM_PACKAGE_NAME);
}

function updatePackageCommand(
  runtime: Exclude<UpdateRuntime, 'auto'>,
  registry: string,
  channel: UpdateChannel,
  runtimeExecutable: string = runtime,
  environment: NodeJS.ProcessEnv,
): {
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly executable: string;
} {
  const packageSpec = `${NPM_PACKAGE_NAME}@${channel}`;
  if (runtime === 'npm') {
    return {
      executable: runtimeExecutable,
      args: ['install', '--global', packageSpec, `--registry=${registry}`, '--node-llama-cpp-postinstall=skip'],
    };
  }
  if (runtime === 'bun') {
    return {
      executable: runtimeExecutable,
      args: ['install', '--global', packageSpec, `--registry=${registry}`, '--node-llama-cpp-postinstall=skip'],
    };
  }
  return {
    executable: runtimeExecutable,
    args: [
      'install',
      '--global',
      '--force',
      '--name',
      NPM_PACKAGE_NAME,
      '--allow-read',
      '--allow-write',
      '--allow-run',
      '--allow-env',
      '--allow-net',
      `npm:${packageSpec}`,
    ],
    env: {
      ...environment,
      NODE_LLAMA_CPP_POSTINSTALL: 'skip',
      NPM_CONFIG_REGISTRY: registry,
    },
  };
}

export function normalizeRegistry(registry: string): string {
  const normalized = registry.endsWith('/') ? registry : `${registry}/`;
  const url = new URL(normalized);
  if (url.protocol !== 'https:') {
    throw new Error(`npm registry must use https: ${normalized}`);
  }
  return url.toString();
}

export function updateRegistry(environment: NodeJS.ProcessEnv): string {
  return resolveUpdateRegistry(undefined, false, environment);
}

export function resolveUpdateRegistry(
  registry: string | undefined,
  allowUntrustedRegistry: boolean | undefined,
  environment: NodeJS.ProcessEnv,
): string {
  const normalized = normalizeRegistry(registry ?? environment.THREADNOTE_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY);
  if (normalized !== DEFAULT_NPM_REGISTRY && !allowsUntrustedRegistry(allowUntrustedRegistry, environment)) {
    throw new Error(
      `Refusing custom npm registry ${normalized}: threadnote update does not verify package signatures from alternate registries. Use the default registry, pass --allow-untrusted-registry, or set ${ALLOW_UNTRUSTED_REGISTRY_ENV}=1 only for an approved mirror.`,
    );
  }
  return normalized;
}

function allowsUntrustedRegistry(option: boolean | undefined, environment: NodeJS.ProcessEnv): boolean {
  if (option === true) {
    return true;
  }
  const envValue = environment[ALLOW_UNTRUSTED_REGISTRY_ENV]?.trim().toLowerCase();
  return envValue === '1' || envValue === 'true' || envValue === 'yes';
}

function isUpdateNotificationDisabled(environment: NodeJS.ProcessEnv): boolean {
  return (
    environment.CI !== undefined ||
    environment.NO_UPDATE_NOTIFIER !== undefined ||
    environment.THREADNOTE_NO_UPDATE_CHECK !== undefined
  );
}
