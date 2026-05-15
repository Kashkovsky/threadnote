import {constants as fsConstants} from 'node:fs';
import {access, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {stdin as input, stdout as output} from 'node:process';
import {hasLegacyLifecycleHandoffCandidates} from './memory.js';
import type {JsonObject, PostUpdateOptions, RuntimeConfig, UpdateOptions, UpdateRuntime} from './types.js';
import {
  ensureDirectory,
  errorMessage,
  findExecutable,
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
    console.log(`Update available: threadnote ${info.currentVersion} -> ${info.latestVersion}`);
    console.log('Run: threadnote update');
  } catch (_err: unknown) {
    return;
  }
}

export async function runUpdate(config: RuntimeConfig, options: UpdateOptions): Promise<void> {
  const registry = normalizeRegistry(options.registry ?? updateRegistry());
  const info = await getUpdateInfo(config, {
    allowCacheWrite: options.dryRun !== true,
    preferFresh: true,
    registry,
  });

  console.log(`Current version: ${info.currentVersion}`);
  console.log(`Latest version:  ${info.latestVersion}`);
  console.log(`Registry:        ${info.registry}`);

  if (options.check === true) {
    if (info.isUpdateAvailable) {
      console.log(`Update available. Run: threadnote update`);
    } else {
      console.log(
        compareVersions(info.currentVersion, info.latestVersion) > 0
          ? 'Current version is newer than npm latest.'
          : 'Threadnote is up to date.',
      );
    }
    return;
  }

  if (!info.isUpdateAvailable && options.force !== true) {
    console.log('Threadnote is up to date.');
    return;
  }

  const runtime = await resolveUpdateRuntime(options.runtime ?? 'auto');
  const updateCommand = updatePackageCommand(runtime, registry);
  await maybeRun(options.dryRun === true, updateCommand.executable, updateCommand.args);

  if (options.repair === false) {
    console.log('Skipping repair because --no-repair was provided.');
    return;
  }

  const threadnoteCommand = await installedThreadnoteCommand(runtime);
  await maybeRun(options.dryRun === true, threadnoteCommand, ['repair', '--no-post-update']);
  if (options.postUpdate !== false) {
    const postUpdateArgs = [
      'post-update',
      '--from-version',
      info.currentVersion,
      '--to-version',
      info.latestVersion,
      ...(options.yes === true ? ['--yes'] : []),
    ];
    if (options.dryRun === true) {
      await maybeRun(true, threadnoteCommand, postUpdateArgs);
    } else {
      console.log(`Running: ${formatShellCommand(threadnoteCommand, postUpdateArgs)}`);
      const postUpdateExitCode = await runInteractive(threadnoteCommand, postUpdateArgs);
      if (postUpdateExitCode !== 0) {
        throw new Error(`${formatShellCommand(threadnoteCommand, postUpdateArgs)} exited with ${postUpdateExitCode}.`);
      }
    }
  } else {
    console.log('Skipping post-update migration prompts because --no-post-update was provided.');
  }
  console.log(
    'Update complete. Restart Cursor, Copilot, Codex, Claude, or open a fresh agent session so MCP tools reload.',
  );
}

export async function runPostUpdate(config: RuntimeConfig, options: PostUpdateOptions): Promise<void> {
  if (!options.fromVersion || !options.toVersion) {
    throw new Error('Provide --from-version and --to-version for post-update.');
  }
  await runApplicablePostUpdateMigrations(config, {
    dryRun: options.dryRun === true,
    fromVersion: options.fromVersion,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
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
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    console.log(
      'This process is non-interactive, so Threadnote will print the manual migration command instead of prompting.',
    );
    console.log(`Run the prompt manually with: threadnote post-update --from-version 0.0.0 --to-version ${toVersion}`);
  }
  await runApplicablePostUpdateMigrations(config, {
    dryRun: options.dryRun,
    fromVersion: '0.0.0',
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    markHandled: true,
    toVersion,
    yes: false,
  });
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

async function currentPackageVersion(): Promise<string> {
  const rawPackage = await readFile(join(toolRoot(), 'package.json'), 'utf8');
  const parsed: unknown = JSON.parse(rawPackage);
  if (!isJsonObject(parsed) || typeof parsed.version !== 'string') {
    throw new Error('Could not read current threadnote package version.');
  }
  return parsed.version;
}

async function fetchLatestVersion(registry: string): Promise<string> {
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
    await maybeRun(options.dryRun, threadnoteCommand, migration.commandArgs);
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

async function confirmPostUpdateMigration(prompt: string): Promise<boolean> {
  const readline = createInterface({input, output});
  try {
    const answer = (await readline.question(prompt)).trim().toLowerCase();
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

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch (_err: unknown) {
    return false;
  }
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

function normalizeRegistry(registry: string): string {
  return registry.endsWith('/') ? registry : `${registry}/`;
}

function updateRegistry(): string {
  return normalizeRegistry(process.env.THREADNOTE_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY);
}

function isUpdateNotificationDisabled(): boolean {
  return (
    process.env.CI !== undefined ||
    process.env.NO_UPDATE_NOTIFIER !== undefined ||
    process.env.THREADNOTE_NO_UPDATE_CHECK !== undefined
  );
}

function compareVersions(currentVersion: string, latestVersion: string): number {
  const current = parseVersion(currentVersion);
  const latest = parseVersion(latestVersion);
  for (let index = 0; index < 3; index += 1) {
    const difference = current.numbers[index] - latest.numbers[index];
    if (difference !== 0) {
      return difference;
    }
  }
  if (current.prerelease === latest.prerelease) {
    return 0;
  }
  if (current.prerelease === undefined) {
    return 1;
  }
  if (latest.prerelease === undefined) {
    return -1;
  }
  return current.prerelease.localeCompare(latest.prerelease);
}

function parseVersion(version: string): {
  readonly numbers: readonly [number, number, number];
  readonly prerelease?: string;
} {
  const normalized = version.trim().replace(/^v/, '');
  const [core, prerelease] = normalized.split('-', 2);
  const parts = core.split('.').map(part => Number(part));
  return {
    numbers: [safeVersionNumber(parts[0]), safeVersionNumber(parts[1]), safeVersionNumber(parts[2])],
    prerelease,
  };
}

function safeVersionNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}
