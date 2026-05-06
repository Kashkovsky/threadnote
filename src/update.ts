import {constants as fsConstants} from 'node:fs';
import {access, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {RuntimeConfig, UpdateOptions, UpdateRuntime} from './types.js';
import {
  ensureDirectory,
  errorMessage,
  findExecutable,
  isJsonObject,
  maybeRun,
  readFileIfExists,
  runCommand,
  toolRoot,
} from './utils.js';

const NPM_PACKAGE_NAME = 'threadnote';
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

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
  await maybeRun(options.dryRun === true, threadnoteCommand, ['repair']);
  console.log('Update complete. Restart Cursor, Codex, Claude, or open a fresh agent session so MCP tools reload.');
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
