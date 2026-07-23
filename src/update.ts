import {constants as fsConstants} from 'node:fs';
import {access, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {stdin as input, stdout as output} from 'node:process';
import {Effect, pipe} from 'effect';
import {heading, info as infoText, keyValue, success, warning, withSpinnerEffect} from './cli_ui.js';
import {consoleOutput, syncWithConsole} from './effect/console.js';
import {applicationError, fromPromise, fromSync} from './effect/errors.js';
import {getJsonEffect, getStatusEffect} from './effect/http.js';
import {pollUntilEffect} from './effect/time.js';
import {hasLegacyLifecycleHandoffCandidates, hasProjectNameMigrationCandidates} from './memory.js';
import {whatsNewLinesForVersionRange} from './release_notes.js';
import type {JsonObject, PostUpdateOptions, RuntimeConfig, UpdateOptions, UpdateRuntime} from './types.js';
import {selectUpdateChannel, type UpdateChannel} from './update_channel.js';
import {
  compareVersions,
  ensureDirectory,
  errorMessage,
  findExecutable,
  currentPackageVersion,
  findOpenVikingCli,
  isExecutable,
  isTcpPortOpen,
  isJsonObject,
  maybeRun,
  readFileIfExists,
  runCommand,
  runInteractive,
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
  readonly isUpdateAvailable: boolean;
  readonly latestVersion: string;
  readonly registry: string;
}

interface UpdateCache {
  readonly channel: UpdateChannel;
  readonly checkedAt: string;
  readonly latestVersion: string;
  readonly registry: string;
}

interface PostUpdateMigration {
  readonly commandArgs: readonly string[];
  readonly description: readonly string[];
  readonly id: string;
  readonly instructions: readonly string[];
  readonly introducedIn: string;
  readonly requiresLegacyHandoffs?: boolean;
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
  if (isUpdateNotificationDisabled()) {
    return Effect.void;
  }
  return fromSync('resolve update registry', updateRegistry).pipe(
    Effect.flatMap(registry =>
      getUpdateInfo(config, {
        allowCacheWrite: options.dryRun !== true,
        betaRequested: false,
        preferFresh: false,
        registry,
      }),
    ),
    Effect.tap(info =>
      info.isUpdateAvailable
        ? syncWithConsole(() => {
            consoleOutput.log('');
            consoleOutput.log(warning(`Update available: threadnote ${info.currentVersion} -> ${info.latestVersion}`));
            consoleOutput.log(`Run: ${infoText('threadnote update')}`);
          })
        : Effect.void,
    ),
    Effect.asVoid,
    Effect.catch(() => Effect.void),
  );
}

export const runUpdate = Effect.fn('runUpdate')(function* (config: RuntimeConfig, options: UpdateOptions) {
  const registry = yield* fromSync('resolve update registry', () =>
    resolveUpdateRegistry(options.registry, options.allowUntrustedRegistry),
  );
  const info = yield* withSpinnerEffect(
    'Checking npm for latest threadnote version',
    getUpdateInfo(config, {
      allowCacheWrite: options.dryRun !== true,
      betaRequested: options.beta === true,
      preferFresh: true,
      registry,
    }),
  );

  yield* syncWithConsole(() => {
    consoleOutput.log(keyValue('Current version', infoText(info.currentVersion)));
    consoleOutput.log(
      keyValue(info.channel === 'beta' ? 'Latest beta version' : 'Latest version', infoText(info.latestVersion)),
    );
    consoleOutput.log(keyValue('Registry', info.registry));
  });

  if (options.check === true) {
    if (info.isUpdateAvailable) {
      const command = options.beta === true ? 'threadnote update --beta' : 'threadnote update';
      yield* syncWithConsole(() => consoleOutput.log(warning(`Update available. Run: ${command}`)));
      yield* printWhatsNewIfAvailable(info);
    } else {
      yield* syncWithConsole(() =>
        consoleOutput.log(
          compareVersions(info.currentVersion, info.latestVersion) > 0
            ? warning(`Current version is newer than npm ${info.channel}.`)
            : success('Threadnote is up to date.'),
        ),
      );
    }
    return;
  }

  if (!info.isUpdateAvailable && options.force !== true) {
    yield* syncWithConsole(() => consoleOutput.log(success('Threadnote is up to date.')));
    return;
  }

  const runtime = yield* fromPromise('resolve update runtime', () => resolveUpdateRuntime(options.runtime ?? 'auto'));
  const updateCommand = updatePackageCommand(runtime, registry, info.channel);
  yield* runStreamingSubcommand(options.dryRun === true, updateCommand.executable, updateCommand.args);

  if (options.repair === false) {
    yield* syncWithConsole(() => consoleOutput.log('Skipping repair because --no-repair was provided.'));
    yield* printWhatsNewIfAvailable(info);
    return;
  }

  const threadnoteCommand = yield* fromPromise('resolve installed threadnote command', () =>
    installedThreadnoteCommand(runtime),
  );
  yield* syncWithConsole(() => {
    consoleOutput.log('');
    consoleOutput.log('Repairing local Threadnote setup after package update.');
  });
  yield* runStreamingSubcommand(options.dryRun === true, threadnoteCommand, ['repair', '--no-post-update']);
  if (options.postUpdate !== false) {
    const postUpdateArgs = [
      'post-update',
      '--from-version',
      info.currentVersion,
      '--to-version',
      info.latestVersion,
      ...(options.yes === true ? ['--yes'] : []),
    ];
    yield* runStreamingSubcommand(options.dryRun === true, threadnoteCommand, postUpdateArgs);
  } else {
    yield* syncWithConsole(() =>
      consoleOutput.log('Skipping post-update migration prompts because --no-post-update was provided.'),
    );
  }
  yield* syncWithConsole(() =>
    consoleOutput.log(
      'Update complete. Restart Cursor, Copilot, Codex, Claude, or open a fresh agent session so MCP tools reload.',
    ),
  );
  yield* printWhatsNewIfAvailable(info);
});

function printWhatsNewIfAvailable(info: UpdateInfo) {
  if (!info.isUpdateAvailable) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    yield* syncWithConsole(() => consoleOutput.log(''));
    const whatsNew = yield* withSpinnerEffect(
      'Fetching GitHub release notes',
      whatsNewLinesForVersionRange(info.currentVersion, info.latestVersion, {
        includePrereleases: info.channel === 'beta',
      }),
    );
    yield* syncWithConsole(() => {
      for (const line of whatsNew) {
        consoleOutput.log(line === "What's new:" ? heading(line) : line);
      }
    });
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
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  yield* ensurePinnedOpenVikingInstalled(config, {dryRun: options.dryRun === true});
  yield* fromPromise('run post-update memory migrations', () =>
    runApplicablePostUpdateMigrations(config, {
      dryRun: options.dryRun === true,
      fromVersion,
      interactive,
      markHandled: true,
      toVersion,
      yes: options.yes === true,
    }),
  );
});

export function maybeRunPostUpdateAfterRepair(config: RuntimeConfig, options: {readonly dryRun: boolean}) {
  return Effect.gen(function* () {
    const toVersion = yield* fromPromise('read current package version', currentPackageVersion);
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    yield* ensurePinnedOpenVikingInstalled(config, {dryRun: options.dryRun});
    const state = yield* fromPromise('read post-update state', () => readPostUpdateState(config));
    const migrations = yield* fromPromise('find applicable post-update migrations', () =>
      applicablePostUpdateMigrations(config, {
        fromVersion: '0.0.0',
        handledMigrationIds: state.handledMigrationIds,
        toVersion,
      }),
    );
    if (migrations.length === 0) {
      return;
    }
    yield* syncWithConsole(() => {
      consoleOutput.log('');
      consoleOutput.log('Repair found package post-update migrations.');
      consoleOutput.log(
        'This also covers updates launched by older Threadnote versions that only knew how to run repair.',
      );
    });
    if (!interactive) {
      yield* syncWithConsole(() => {
        consoleOutput.log(
          'This process is non-interactive, so Threadnote will print the manual migration command instead of prompting.',
        );
        consoleOutput.log(
          `Run the prompt manually with: threadnote post-update --from-version 0.0.0 --to-version ${toVersion}`,
        );
      });
    }
    yield* fromPromise('run post-update migrations after repair', () =>
      runApplicablePostUpdateMigrations(config, {
        dryRun: options.dryRun,
        fromVersion: '0.0.0',
        interactive,
        markHandled: true,
        toVersion,
        yes: false,
      }),
    );
  });
}

/**
 * Detects the installed OpenViking CLI version and, if it's older than the
 * pinned `config.openVikingVersion`, transparently upgrades by spawning
 * `threadnote install --force --no-start` and then restarting the OV server
 * so the new binary takes effect. No prompt — `threadnote update` is the
 * user's signal that they want the whole stack brought up to date, and a
 * stale OV binary breaks `doctor`/share-sync until restarted.
 *
 * No-ops if OV is not installed at all (the install command path covers
 * fresh installs), if the installed version is unparseable, or if the
 * installed version is already at-or-above the pin.
 *
 * Lives in update.ts (not lifecycle.ts) to avoid a lifecycle <-> update
 * import cycle; restarts via threadnote subcommands, or `launchctl` direct
 * when a LaunchAgent is in play (so the user's launchd setup is preserved
 * instead of getting silently shifted to a detached process).
 */
function ensurePinnedOpenVikingInstalled(config: RuntimeConfig, options: {readonly dryRun: boolean}) {
  return Effect.gen(function* () {
    const ov = yield* fromPromise('find OpenViking CLI', findOpenVikingCli);
    if (!ov) {
      return;
    }
    const installedVersion = yield* fromPromise('read OpenViking CLI version', () => readOpenVikingCliVersion(ov));
    if (!installedVersion) {
      yield* syncWithConsole(() =>
        consoleOutput.log(
          `Could not detect OpenViking CLI version via \`${ov} version\`; skipping pinned-version check.`,
        ),
      );
      return;
    }
    const pinned = config.openVikingVersion;
    if (compareVersions(installedVersion, pinned) >= 0) {
      return;
    }
    yield* syncWithConsole(() => {
      consoleOutput.log('');
      consoleOutput.log(`Upgrading OpenViking ${installedVersion} -> ${pinned} (pinned by Threadnote).`);
      consoleOutput.log('Picks up upstream CLI, resource-ingestion, and index reliability fixes.');
    });

    // Capture the server state BEFORE we swap binaries so we know what to
    // restart afterward. install --no-start leaves the existing process
    // untouched, but that process is still the pre-upgrade binary, so the
    // user would otherwise need to manually `threadnote stop && threadnote
    // start` to actually be on the new version.
    const wasRunning = yield* isOpenVikingHealthy(config);
    const usingLaunchd = yield* isLaunchAgentInstalled();

    const threadnoteCommand =
      currentThreadnoteCommand() ??
      (yield* fromPromise('find threadnote executable', () => findExecutable([NPM_PACKAGE_NAME]))) ??
      NPM_PACKAGE_NAME;
    yield* runStreamingSubcommand(options.dryRun, threadnoteCommand, ['install', '--force', '--no-start']);

    if (options.dryRun) {
      if (wasRunning || usingLaunchd) {
        yield* syncWithConsole(() =>
          consoleOutput.log('Would restart OpenViking server so the new binary takes effect.'),
        );
      }
      return;
    }

    if (!wasRunning && !usingLaunchd) {
      return;
    }

    yield* syncWithConsole(() => consoleOutput.log('Restarting OpenViking server so the new binary takes effect.'));
    if (usingLaunchd) {
      const launchAgentPath = launchAgentPlistPath();
      yield* fromPromise('unload OpenViking launch agent', () =>
        runCommand('launchctl', ['unload', launchAgentPath], {allowFailure: true}),
      );
      yield* waitForOpenVikingPortClosed(config, 15_000);
      yield* fromPromise('load OpenViking launch agent', () =>
        runCommand('launchctl', ['load', launchAgentPath], {allowFailure: true}),
      );
    } else {
      yield* runStreamingSubcommand(false, threadnoteCommand, ['stop']);
      yield* waitForOpenVikingPortClosed(config, 15_000);
      yield* runStreamingSubcommand(false, threadnoteCommand, ['start']);
    }
    const healthyAfter = yield* waitForOpenVikingHealthy(config, 10_000);
    if (!healthyAfter) {
      yield* syncWithConsole(() => {
        consoleOutput.log(
          `Warning: OpenViking did not return to healthy at ${openVikingHealthEndpoint(config)} within 10s after the restart.`,
        );
        consoleOutput.log('Check the server log or run: threadnote start');
      });
    }
  });
}

/**
 * Run a subprocess with its stdout/stderr inherited so the user sees output
 * live, instead of buffering through `runCommand`/`maybeRun` (which also
 * imposes the 10-minute command timeout — fatal for long-running steps like a
 * package install, an OpenViking reinstall, or a churning repair). Dry-run
 * defers to `maybeRun` so it only prints the command it would run.
 */
function runStreamingSubcommand(dryRun: boolean, executable: string, args: readonly string[]) {
  if (dryRun) {
    return fromPromise('print subcommand', () => maybeRun(true, executable, args)).pipe(Effect.asVoid);
  }
  return Effect.gen(function* () {
    yield* syncWithConsole(() => consoleOutput.log(`Running: ${formatShellCommand(executable, args)}`));
    const exitCode = yield* fromPromise('run interactive subcommand', () => runInteractive(executable, args));
    if (exitCode !== 0) {
      return yield* Effect.fail(
        applicationError(
          'run interactive subcommand',
          new Error(`${formatShellCommand(executable, args)} exited with ${exitCode}.`),
        ),
      );
    }
  });
}

function openVikingHealthEndpoint(config: RuntimeConfig): string {
  return `http://${config.host}:${config.port}/health`;
}

const isOpenVikingHealthy = Effect.fn('isOpenVikingHealthy')((config: RuntimeConfig) =>
  getStatusEffect(openVikingHealthEndpoint(config), {timeoutMs: 800}).pipe(
    Effect.map(status => status >= 200 && status < 300),
    Effect.catch(() => Effect.succeed(false)),
  ),
);

function waitForOpenVikingHealthy(config: RuntimeConfig, timeoutMs: number) {
  return pipe(
    pollUntilEffect(
      getStatusEffect(openVikingHealthEndpoint(config), {timeoutMs: 800}).pipe(
        Effect.map(status => (status >= 200 && status < 300 ? true : undefined)),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
      {intervalMs: 500, timeoutMs},
    ),
    Effect.map(result => result === true),
  );
}

function waitForOpenVikingPortClosed(config: RuntimeConfig, timeoutMs: number) {
  return Effect.gen(function* () {
    yield* syncWithConsole(() =>
      consoleOutput.log(`Waiting for OpenViking port ${config.host}:${config.port} to close before restart.`),
    );
    const closed = yield* pipe(
      pollUntilEffect(
        fromPromise('check OpenViking TCP port', () => isTcpPortOpen(config.host, config.port, 300)).pipe(
          Effect.map(open => (open ? undefined : true)),
        ),
        {intervalMs: 300, timeoutMs},
      ),
      Effect.map(result => result === true),
    );
    if (closed) {
      return true;
    }
    yield* syncWithConsole(() =>
      consoleOutput.log(
        `Warning: OpenViking port ${config.host}:${config.port} is still in use after ${timeoutMs / 1000}s; start may fail.`,
      ),
    );
    return false;
  });
}

function launchAgentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', 'io.threadnote.openviking.plist');
}

function isLaunchAgentInstalled() {
  if (process.platform !== 'darwin') {
    return Effect.succeed(false);
  }
  return fromPromise('check OpenViking launch agent', () => access(launchAgentPlistPath(), fsConstants.F_OK)).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
}

export async function readOpenVikingCliVersion(ov: string): Promise<string | undefined> {
  const result = await runCommand(ov, ['--version'], {allowFailure: true});
  if (result.exitCode !== 0) {
    return undefined;
  }
  // `ov --version` is local-only and remains available while the server is
  // stopped. OpenViking 0.4.10 prints `openviking 0.4.10`.
  const match = `${result.stdout}\n${result.stderr}`.match(
    /^\s*openviking(?:\s+CLI)?\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/im,
  );
  return match ? match[1] : undefined;
}

function getUpdateInfo(
  config: RuntimeConfig,
  options: {
    readonly allowCacheWrite: boolean;
    readonly betaRequested: boolean;
    readonly preferFresh: boolean;
    readonly registry: string;
  },
) {
  return Effect.gen(function* () {
    const currentVersion = yield* fromPromise('read current package version', currentPackageVersion);
    const channel = selectUpdateChannel(currentVersion, options.betaRequested);
    const cached = options.preferFresh
      ? undefined
      : yield* fromPromise('read update cache', () => readFreshCache(config, options.registry, channel));
    const latestVersion = cached?.latestVersion ?? (yield* fetchLatestVersion(options.registry, channel));
    if (!cached && options.allowCacheWrite) {
      yield* fromPromise('write update cache', () =>
        writeUpdateCache(config, {
          channel,
          checkedAt: new Date().toISOString(),
          latestVersion,
          registry: options.registry,
        }),
      );
    }
    return {
      channel,
      currentVersion,
      isUpdateAvailable: compareVersions(currentVersion, latestVersion) < 0,
      latestVersion,
      registry: options.registry,
    };
  });
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
    Effect.mapError(cause =>
      applicationError(
        'check npm for updates',
        new Error(`Could not check npm for updates: ${errorMessage(cause)}`, {cause}),
      ),
    ),
  );
  if (!isJsonObject(response.body) || typeof response.body.version !== 'string') {
    return yield* Effect.fail(
      applicationError('check npm for updates', new Error('npm registry response did not include a version.')),
    );
  }
  return response.body.version;
});

async function readFreshCache(
  config: RuntimeConfig,
  registry: string,
  channel: UpdateChannel,
): Promise<UpdateCache | undefined> {
  const rawCache = await readFileIfExists(updateCachePath(config));
  if (!rawCache) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(rawCache);
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
  } catch (_err: unknown) {
    return undefined;
  }
}

async function writeUpdateCache(config: RuntimeConfig, cache: UpdateCache): Promise<void> {
  await ensureDirectory(config.agentContextHome, false);
  await writeFile(updateCachePath(config), `${JSON.stringify(cache, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
}

function updateCachePath(config: RuntimeConfig): string {
  return join(config.agentContextHome, 'update-check.json');
}

async function runApplicablePostUpdateMigrations(
  config: RuntimeConfig,
  options: {
    readonly dryRun: boolean;
    readonly fromVersion: string;
    readonly interactive: boolean;
    readonly markHandled: boolean;
    readonly toVersion: string;
    readonly yes: boolean;
  },
): Promise<void> {
  const state = await readPostUpdateState(config);
  const migrations = await applicablePostUpdateMigrations(config, {
    fromVersion: options.fromVersion,
    handledMigrationIds: state.handledMigrationIds,
    toVersion: options.toVersion,
  });
  if (migrations.length === 0) {
    consoleOutput.log('No post-update memory migrations apply.');
    return;
  }

  consoleOutput.log('');
  consoleOutput.log('Post-update memory migrations are available.');
  const threadnoteCommand =
    currentThreadnoteCommand() ?? (await findExecutable([NPM_PACKAGE_NAME])) ?? NPM_PACKAGE_NAME;
  const handledMigrationIds = new Set(state.handledMigrationIds);
  for (const migration of migrations) {
    printPostUpdateMigration(migration);
    const accepted =
      options.dryRun ||
      options.yes ||
      (options.interactive && (await confirmPostUpdateMigration('Apply this migration now? [y/N] ')));
    if (!accepted) {
      consoleOutput.log('Skipped. Run manually later:');
      consoleOutput.log(`  ${formatMigrationCommand(threadnoteCommand, migration.commandArgs)}`);
      continue;
    }
    await runStreamingSubcommand(options.dryRun, threadnoteCommand, migration.commandArgs);
    if (!options.dryRun) {
      handledMigrationIds.add(migration.id);
      for (const instruction of migration.instructions) {
        consoleOutput.log(instruction);
      }
    } else {
      consoleOutput.log('After this migration succeeds, Threadnote will print:');
      for (const instruction of migration.instructions) {
        consoleOutput.log(`  ${instruction}`);
      }
    }
  }

  if (!options.dryRun && options.markHandled) {
    await writePostUpdateState(config, {handledMigrationIds: [...handledMigrationIds].sort()});
  }
}

async function applicablePostUpdateMigrations(
  config: RuntimeConfig,
  options: {
    readonly fromVersion: string;
    readonly handledMigrationIds: readonly string[];
    readonly toVersion: string;
  },
): Promise<readonly PostUpdateMigration[]> {
  const migrations = await readPostUpdateMigrations();
  const handled = new Set(options.handledMigrationIds);
  const applicable: PostUpdateMigration[] = [];
  for (const migration of migrations) {
    if (handled.has(migration.id)) {
      continue;
    }
    if (compareVersions(options.fromVersion, migration.introducedIn) >= 0) {
      continue;
    }
    if (compareVersions(migration.introducedIn, options.toVersion) > 0) {
      continue;
    }
    if (migration.requiresLegacyHandoffs === true && !(await hasLegacyLifecycleHandoffCandidates(config))) {
      continue;
    }
    if (migration.requiresProjectNameConsolidation === true && !(await hasProjectNameMigrationCandidates(config))) {
      continue;
    }
    applicable.push(migration);
  }
  return applicable;
}

async function readPostUpdateMigrations(): Promise<readonly PostUpdateMigration[]> {
  const raw = await readFileIfExists(join(toolRoot(), 'config', POST_UPDATE_MIGRATIONS_FILE));
  if (!raw) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isJsonObject(parsed) || !Array.isArray(parsed.migrations)) {
    throw new Error(`${POST_UPDATE_MIGRATIONS_FILE} must contain a migrations array.`);
  }
  return parsed.migrations.map(parsePostUpdateMigration);
}

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
    commandArgs: stringArray(value, 'commandArgs'),
    description: stringArray(value, 'description'),
    id: value.id,
    instructions: stringArray(value, 'instructions'),
    introducedIn: value.introducedIn,
    requiresLegacyHandoffs: value.requiresLegacyHandoffs === true,
    requiresProjectNameConsolidation: value.requiresProjectNameConsolidation === true,
    title: value.title,
  };
}

function stringArray(value: JsonObject, key: string): readonly string[] {
  const raw = value[key];
  if (!Array.isArray(raw) || !raw.every(item => typeof item === 'string')) {
    throw new Error(`Invalid ${key} in ${POST_UPDATE_MIGRATIONS_FILE}.`);
  }
  return raw;
}

function printPostUpdateMigration(migration: PostUpdateMigration): void {
  consoleOutput.log('');
  consoleOutput.log(`${migration.title} (${migration.introducedIn})`);
  for (const line of migration.description) {
    consoleOutput.log(`- ${line}`);
  }
}

async function confirmPostUpdateMigration(prompt: string, defaultYes = false): Promise<boolean> {
  const readline = createInterface({input, output});
  try {
    const answer = (await readline.question(prompt)).trim().toLowerCase();
    if (answer === '') {
      return defaultYes;
    }
    return answer === 'y' || answer === 'yes';
  } finally {
    readline.close();
  }
}

function formatMigrationCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(part => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

function currentThreadnoteCommand(): string | undefined {
  const entrypoint = process.argv[1]?.trim();
  return entrypoint ? entrypoint : undefined;
}

async function readPostUpdateState(config: RuntimeConfig): Promise<PostUpdateState> {
  const raw = await readFileIfExists(postUpdateStatePath(config));
  if (!raw) {
    return {handledMigrationIds: []};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed) || !Array.isArray(parsed.handledMigrationIds)) {
      return {handledMigrationIds: []};
    }
    return {handledMigrationIds: parsed.handledMigrationIds.filter((id): id is string => typeof id === 'string')};
  } catch (_err: unknown) {
    return {handledMigrationIds: []};
  }
}

async function writePostUpdateState(config: RuntimeConfig, state: PostUpdateState): Promise<void> {
  await ensureDirectory(config.agentContextHome, false);
  await writeFile(postUpdateStatePath(config), `${JSON.stringify(state, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
}

function postUpdateStatePath(config: RuntimeConfig): string {
  return join(config.agentContextHome, POST_UPDATE_STATE_FILE);
}

async function resolveUpdateRuntime(runtime: UpdateRuntime): Promise<Exclude<UpdateRuntime, 'auto'>> {
  if (runtime !== 'auto') {
    await requireRuntime(runtime);
    return runtime;
  }
  for (const candidate of ['npm', 'bun', 'deno'] as const) {
    if (await findExecutable([candidate])) {
      return candidate;
    }
  }
  throw new Error('Install Node/npm, Bun, or Deno to update threadnote.');
}

async function requireRuntime(runtime: Exclude<UpdateRuntime, 'auto'>): Promise<void> {
  if (!(await findExecutable([runtime]))) {
    throw new Error(`${runtime} was requested but was not found on PATH.`);
  }
}

async function installedThreadnoteCommand(runtime: Exclude<UpdateRuntime, 'auto'>): Promise<string> {
  const runtimeBin = await runtimeThreadnoteBin(runtime);
  if (runtimeBin && (await isExecutable(runtimeBin))) {
    return runtimeBin;
  }
  return (await findExecutable([NPM_PACKAGE_NAME])) ?? NPM_PACKAGE_NAME;
}

async function runtimeThreadnoteBin(runtime: Exclude<UpdateRuntime, 'auto'>): Promise<string | undefined> {
  if (runtime === 'npm') {
    const result = await runCommand('npm', ['prefix', '--global'], {allowFailure: true});
    const prefix = result.stdout.trim();
    return prefix ? join(prefix, 'bin', NPM_PACKAGE_NAME) : undefined;
  }
  if (runtime === 'bun') {
    const result = await runCommand('bun', ['pm', 'bin', '-g'], {allowFailure: true});
    const binDir = result.stdout.trim();
    return binDir ? join(binDir, NPM_PACKAGE_NAME) : undefined;
  }
  return join(process.env.DENO_INSTALL ?? join(homedir(), '.deno'), 'bin', NPM_PACKAGE_NAME);
}

function updatePackageCommand(
  runtime: Exclude<UpdateRuntime, 'auto'>,
  registry: string,
  channel: UpdateChannel,
): {
  readonly args: readonly string[];
  readonly executable: string;
} {
  const packageSpec = `${NPM_PACKAGE_NAME}@${channel}`;
  if (runtime === 'npm') {
    return {executable: 'npm', args: ['install', '--global', packageSpec, `--registry=${registry}`]};
  }
  if (runtime === 'bun') {
    return {executable: 'bun', args: ['install', '--global', packageSpec, `--registry=${registry}`]};
  }
  return {
    executable: 'env',
    args: [
      `NPM_CONFIG_REGISTRY=${registry}`,
      'deno',
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

export function updateRegistry(): string {
  return resolveUpdateRegistry(undefined, false);
}

export function resolveUpdateRegistry(
  registry: string | undefined,
  allowUntrustedRegistry: boolean | undefined,
): string {
  const normalized = normalizeRegistry(registry ?? process.env.THREADNOTE_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY);
  if (normalized !== DEFAULT_NPM_REGISTRY && !allowsUntrustedRegistry(allowUntrustedRegistry)) {
    throw new Error(
      `Refusing custom npm registry ${normalized}: threadnote update does not verify package signatures from alternate registries. Use the default registry, pass --allow-untrusted-registry, or set ${ALLOW_UNTRUSTED_REGISTRY_ENV}=1 only for an approved mirror.`,
    );
  }
  return normalized;
}

function allowsUntrustedRegistry(option: boolean | undefined): boolean {
  if (option === true) {
    return true;
  }
  const envValue = process.env[ALLOW_UNTRUSTED_REGISTRY_ENV]?.trim().toLowerCase();
  return envValue === '1' || envValue === 'true' || envValue === 'yes';
}

function isUpdateNotificationDisabled(): boolean {
  return (
    process.env.CI !== undefined ||
    process.env.NO_UPDATE_NOTIFIER !== undefined ||
    process.env.THREADNOTE_NO_UPDATE_CHECK !== undefined
  );
}
