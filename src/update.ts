import {constants as fsConstants} from 'node:fs';
import {access, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {stdin as input, stdout as output} from 'node:process';
import {heading, info as infoText, keyValue, success, warning, withSpinner} from './cli_ui.js';
import {hasLegacyLifecycleHandoffCandidates} from './memory.js';
import {whatsNewLinesForVersionRange} from './release_notes.js';
import type {JsonObject, PostUpdateOptions, RuntimeConfig, UpdateOptions, UpdateRuntime} from './types.js';
import {
  compareVersions,
  ensureDirectory,
  errorMessage,
  findExecutable,
  findOpenVikingCli,
  isExecutable,
  isTcpPortOpen,
  isJsonObject,
  maybeRun,
  readFileIfExists,
  runCommand,
  runInteractive,
  sleep,
  toolRoot,
  formatShellCommand,
} from './utils.js';

const NPM_PACKAGE_NAME = 'threadnote';
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const POST_UPDATE_MIGRATIONS_FILE = 'post-update-migrations.json';
const POST_UPDATE_STATE_FILE = 'post-update-state.json';

interface UpdateInfo {
  readonly currentVersion: string;
  readonly isUpdateAvailable: boolean;
  readonly latestVersion: string;
  readonly registry: string;
}

interface UpdateCache {
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

export async function maybeNotifyUpdate(
  config: RuntimeConfig,
  options: {readonly dryRun?: boolean} = {},
): Promise<void> {
  if (isUpdateNotificationDisabled()) {
    return;
  }
  try {
    const info = await getUpdateInfo(config, {
      allowCacheWrite: options.dryRun !== true,
      preferFresh: false,
      registry: updateRegistry(),
    });
    if (!info.isUpdateAvailable) {
      return;
    }
    console.log('');
    console.log(warning(`Update available: threadnote ${info.currentVersion} -> ${info.latestVersion}`));
    console.log(`Run: ${infoText('threadnote update')}`);
  } catch (_err: unknown) {
    return;
  }
}

export async function runUpdate(config: RuntimeConfig, options: UpdateOptions): Promise<void> {
  const registry = normalizeRegistry(options.registry ?? updateRegistry());
  const info = await withSpinner('Checking npm for latest threadnote version', () =>
    getUpdateInfo(config, {
      allowCacheWrite: options.dryRun !== true,
      preferFresh: true,
      registry,
    }),
  );

  console.log(keyValue('Current version', infoText(info.currentVersion)));
  console.log(keyValue('Latest version', infoText(info.latestVersion)));
  console.log(keyValue('Registry', info.registry));

  if (options.check === true) {
    if (info.isUpdateAvailable) {
      console.log(warning('Update available. Run: threadnote update'));
      await printWhatsNewIfAvailable(info);
    } else {
      console.log(
        compareVersions(info.currentVersion, info.latestVersion) > 0
          ? warning('Current version is newer than npm latest.')
          : success('Threadnote is up to date.'),
      );
    }
    return;
  }

  if (!info.isUpdateAvailable && options.force !== true) {
    console.log(success('Threadnote is up to date.'));
    return;
  }

  const runtime = await resolveUpdateRuntime(options.runtime ?? 'auto');
  const updateCommand = updatePackageCommand(runtime, registry);
  await runStreamingSubcommand(options.dryRun === true, updateCommand.executable, updateCommand.args);

  if (options.repair === false) {
    console.log('Skipping repair because --no-repair was provided.');
    await printWhatsNewIfAvailable(info);
    return;
  }

  const threadnoteCommand = await installedThreadnoteCommand(runtime);
  console.log('');
  console.log('Repairing local Threadnote setup after package update.');
  await runStreamingSubcommand(options.dryRun === true, threadnoteCommand, ['repair', '--no-post-update']);
  if (options.postUpdate !== false) {
    const postUpdateArgs = [
      'post-update',
      '--from-version',
      info.currentVersion,
      '--to-version',
      info.latestVersion,
      ...(options.yes === true ? ['--yes'] : []),
    ];
    await runStreamingSubcommand(options.dryRun === true, threadnoteCommand, postUpdateArgs);
  } else {
    console.log('Skipping post-update migration prompts because --no-post-update was provided.');
  }
  console.log(
    'Update complete. Restart Cursor, Copilot, Codex, Claude, or open a fresh agent session so MCP tools reload.',
  );
  await printWhatsNewIfAvailable(info);
}

async function printWhatsNewIfAvailable(info: UpdateInfo): Promise<void> {
  if (!info.isUpdateAvailable) {
    return;
  }
  console.log('');
  const whatsNew = await withSpinner('Fetching GitHub release notes', () =>
    whatsNewLinesForVersionRange(info.currentVersion, info.latestVersion),
  );
  for (const line of whatsNew) {
    console.log(line === "What's new:" ? heading(line) : line);
  }
}

export async function runPostUpdate(config: RuntimeConfig, options: PostUpdateOptions): Promise<void> {
  if (!options.fromVersion || !options.toVersion) {
    throw new Error('Provide --from-version and --to-version for post-update.');
  }
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  await ensurePinnedOpenVikingInstalled(config, {dryRun: options.dryRun === true});
  await runApplicablePostUpdateMigrations(config, {
    dryRun: options.dryRun === true,
    fromVersion: options.fromVersion,
    interactive,
    markHandled: true,
    toVersion: options.toVersion,
    yes: options.yes === true,
  });
}

export async function maybeRunPostUpdateAfterRepair(
  config: RuntimeConfig,
  options: {readonly dryRun: boolean},
): Promise<void> {
  const toVersion = await currentPackageVersion();
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  await ensurePinnedOpenVikingInstalled(config, {dryRun: options.dryRun});
  const state = await readPostUpdateState(config);
  const migrations = await applicablePostUpdateMigrations(config, {
    fromVersion: '0.0.0',
    handledMigrationIds: state.handledMigrationIds,
    toVersion,
  });
  if (migrations.length === 0) {
    return;
  }
  console.log('');
  console.log('Repair found package post-update migrations.');
  console.log('This also covers updates launched by older Threadnote versions that only knew how to run repair.');
  if (!interactive) {
    console.log(
      'This process is non-interactive, so Threadnote will print the manual migration command instead of prompting.',
    );
    console.log(`Run the prompt manually with: threadnote post-update --from-version 0.0.0 --to-version ${toVersion}`);
  }
  await runApplicablePostUpdateMigrations(config, {
    dryRun: options.dryRun,
    fromVersion: '0.0.0',
    interactive,
    markHandled: true,
    toVersion,
    yes: false,
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
async function ensurePinnedOpenVikingInstalled(
  config: RuntimeConfig,
  options: {readonly dryRun: boolean},
): Promise<void> {
  const ov = await findOpenVikingCli();
  if (!ov) {
    return;
  }
  const installedVersion = await readOpenVikingCliVersion(ov);
  if (!installedVersion) {
    console.log(`Could not detect OpenViking CLI version via \`${ov} version\`; skipping pinned-version check.`);
    return;
  }
  const pinned = config.openVikingVersion;
  if (compareVersions(installedVersion, pinned) >= 0) {
    return;
  }
  console.log('');
  console.log(`Upgrading OpenViking ${installedVersion} -> ${pinned} (pinned by Threadnote).`);
  console.log('Picks up upstream CLI, resource-ingestion, and index reliability fixes.');

  // Capture the server state BEFORE we swap binaries so we know what to
  // restart afterward. install --no-start leaves the existing process
  // untouched, but that process is still the pre-upgrade binary, so the
  // user would otherwise need to manually `threadnote stop && threadnote
  // start` to actually be on the new version.
  const wasRunning = await isOpenVikingHealthy(config);
  const usingLaunchd = await isLaunchAgentInstalled();

  const threadnoteCommand =
    currentThreadnoteCommand() ?? (await findExecutable([NPM_PACKAGE_NAME])) ?? NPM_PACKAGE_NAME;
  await runStreamingSubcommand(options.dryRun, threadnoteCommand, ['install', '--force', '--no-start']);

  if (options.dryRun) {
    if (wasRunning || usingLaunchd) {
      console.log('Would restart OpenViking server so the new binary takes effect.');
    }
    return;
  }

  if (!wasRunning && !usingLaunchd) {
    return;
  }

  console.log('Restarting OpenViking server so the new binary takes effect.');
  if (usingLaunchd) {
    const launchAgentPath = launchAgentPlistPath();
    await runCommand('launchctl', ['unload', launchAgentPath], {allowFailure: true});
    await waitForOpenVikingPortClosed(config, 15_000);
    await runCommand('launchctl', ['load', launchAgentPath], {allowFailure: true});
  } else {
    await runStreamingSubcommand(false, threadnoteCommand, ['stop']);
    await waitForOpenVikingPortClosed(config, 15_000);
    await runStreamingSubcommand(false, threadnoteCommand, ['start']);
  }
  const healthyAfter = await waitForOpenVikingHealthy(config, 10_000);
  if (!healthyAfter) {
    console.log(
      `Warning: OpenViking did not return to healthy at ${openVikingHealthEndpoint(config)} within 10s after the restart.`,
    );
    console.log('Check the server log or run: threadnote start');
  }
}

/**
 * Run a subprocess with its stdout/stderr inherited so the user sees output
 * live, instead of buffering through `runCommand`/`maybeRun` (which also
 * imposes the 10-minute command timeout — fatal for long-running steps like a
 * package install, an OpenViking reinstall, or a churning repair). Dry-run
 * defers to `maybeRun` so it only prints the command it would run.
 */
async function runStreamingSubcommand(dryRun: boolean, executable: string, args: readonly string[]): Promise<void> {
  if (dryRun) {
    await maybeRun(true, executable, args);
    return;
  }
  console.log(`Running: ${formatShellCommand(executable, args)}`);
  const exitCode = await runInteractive(executable, args);
  if (exitCode !== 0) {
    throw new Error(`${formatShellCommand(executable, args)} exited with ${exitCode}.`);
  }
}

function openVikingHealthEndpoint(config: RuntimeConfig): string {
  return `http://${config.host}:${config.port}/health`;
}

async function isOpenVikingHealthy(config: RuntimeConfig): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 800);
  try {
    const response = await fetch(openVikingHealthEndpoint(config), {signal: controller.signal});
    return response.ok;
  } catch (_err: unknown) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForOpenVikingHealthy(config: RuntimeConfig, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOpenVikingHealthy(config)) {
      return true;
    }
    await sleep(500);
  }
  return isOpenVikingHealthy(config);
}

async function waitForOpenVikingPortClosed(config: RuntimeConfig, timeoutMs: number): Promise<boolean> {
  console.log(`Waiting for OpenViking port ${config.host}:${config.port} to close before restart.`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isTcpPortOpen(config.host, config.port, 300))) {
      return true;
    }
    await sleep(300);
  }
  if (!(await isTcpPortOpen(config.host, config.port, 300))) {
    return true;
  }
  console.log(
    `Warning: OpenViking port ${config.host}:${config.port} is still in use after ${timeoutMs / 1000}s; start may fail.`,
  );
  return false;
}

function launchAgentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', 'io.threadnote.openviking.plist');
}

async function isLaunchAgentInstalled(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false;
  }
  try {
    await access(launchAgentPlistPath(), fsConstants.F_OK);
    return true;
  } catch (_err: unknown) {
    return false;
  }
}

async function readOpenVikingCliVersion(ov: string): Promise<string | undefined> {
  const result = await runCommand(ov, ['version'], {allowFailure: true});
  if (result.exitCode !== 0) {
    return undefined;
  }
  // `ov version` output:
  //   CLI:     0.3.24
  //   Server:  0.3.24
  // Match the CLI line specifically; ignore the server line in case the
  // server is briefly out of sync with the CLI during an upgrade.
  const match = result.stdout.match(/^\s*CLI:\s*(\S+)/m);
  return match ? match[1] : undefined;
}

async function getUpdateInfo(
  config: RuntimeConfig,
  options: {
    readonly allowCacheWrite: boolean;
    readonly preferFresh: boolean;
    readonly registry: string;
  },
): Promise<UpdateInfo> {
  const currentVersion = await currentPackageVersion();
  const cached = options.preferFresh ? undefined : await readFreshCache(config, options.registry);
  const latestVersion = cached?.latestVersion ?? (await fetchLatestVersion(options.registry));
  if (!cached && options.allowCacheWrite) {
    await writeUpdateCache(config, {checkedAt: new Date().toISOString(), latestVersion, registry: options.registry});
  }
  return {
    currentVersion,
    isUpdateAvailable: compareVersions(currentVersion, latestVersion) < 0,
    latestVersion,
    registry: options.registry,
  };
}

export async function currentPackageVersion(): Promise<string> {
  const rawPackage = await readFile(join(toolRoot(), 'package.json'), 'utf8');
  const parsed: unknown = JSON.parse(rawPackage);
  if (!isJsonObject(parsed) || typeof parsed.version !== 'string') {
    throw new Error('Could not read current threadnote package version.');
  }
  return parsed.version;
}

export async function fetchLatestVersion(registry: string): Promise<string> {
  const url = new URL(`${NPM_PACKAGE_NAME}/latest`, normalizeRegistry(registry));
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 2500);
  try {
    const response = await fetch(url, {headers: {accept: 'application/json'}, signal: controller.signal});
    if (!response.ok) {
      throw new Error(`npm registry returned HTTP ${response.status}`);
    }
    const parsed: unknown = await response.json();
    if (!isJsonObject(parsed) || typeof parsed.version !== 'string') {
      throw new Error('npm registry response did not include a version.');
    }
    return parsed.version;
  } catch (err: unknown) {
    throw new Error(`Could not check npm for updates: ${errorMessage(err)}`, {cause: err});
  } finally {
    clearTimeout(timeout);
  }
}

async function readFreshCache(config: RuntimeConfig, registry: string): Promise<UpdateCache | undefined> {
  const rawCache = await readFileIfExists(updateCachePath(config));
  if (!rawCache) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(rawCache);
    if (
      !isJsonObject(parsed) ||
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
    return {checkedAt: parsed.checkedAt, latestVersion: parsed.latestVersion, registry};
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
    console.log('No post-update memory migrations apply.');
    return;
  }

  console.log('');
  console.log('Post-update memory migrations are available.');
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
      console.log('Skipped. Run manually later:');
      console.log(`  ${formatMigrationCommand(threadnoteCommand, migration.commandArgs)}`);
      continue;
    }
    await runStreamingSubcommand(options.dryRun, threadnoteCommand, migration.commandArgs);
    if (!options.dryRun) {
      handledMigrationIds.add(migration.id);
      for (const instruction of migration.instructions) {
        console.log(instruction);
      }
    } else {
      console.log('After this migration succeeds, Threadnote will print:');
      for (const instruction of migration.instructions) {
        console.log(`  ${instruction}`);
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
  console.log('');
  console.log(`${migration.title} (${migration.introducedIn})`);
  for (const line of migration.description) {
    console.log(`- ${line}`);
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
): {
  readonly args: readonly string[];
  readonly executable: string;
} {
  if (runtime === 'npm') {
    return {executable: 'npm', args: ['install', '--global', `${NPM_PACKAGE_NAME}@latest`, `--registry=${registry}`]};
  }
  if (runtime === 'bun') {
    return {executable: 'bun', args: ['install', '--global', `${NPM_PACKAGE_NAME}@latest`, `--registry=${registry}`]};
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
      `npm:${NPM_PACKAGE_NAME}@latest`,
    ],
  };
}

export function normalizeRegistry(registry: string): string {
  return registry.endsWith('/') ? registry : `${registry}/`;
}

export function updateRegistry(): string {
  return normalizeRegistry(process.env.THREADNOTE_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY);
}

function isUpdateNotificationDisabled(): boolean {
  return (
    process.env.CI !== undefined ||
    process.env.NO_UPDATE_NOTIFIER !== undefined ||
    process.env.THREADNOTE_NO_UPDATE_CHECK !== undefined
  );
}
