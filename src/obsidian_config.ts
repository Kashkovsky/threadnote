import {Crypto, Effect, FileSystem, Path} from 'effect';
import yaml from 'js-yaml';
import {withExclusiveFileLock} from './effect/file_lock.js';
import type {MemoryKind, MemoryStatus, RuntimeConfig} from './types.js';
import {isJsonObject} from './utils.js';

export interface ObsidianSourceConfig {
  readonly enabled: boolean;
  readonly exclude: readonly string[];
  readonly id: string;
  readonly inbox?: string;
  readonly include: readonly string[];
  readonly type: 'obsidian';
  readonly vault: string;
  readonly watch: boolean;
}

export interface ObsidianProjectionConfig {
  readonly enabled: boolean;
  readonly folder: string;
  readonly id: string;
  readonly includeShared: boolean;
  readonly kinds: readonly MemoryKind[];
  readonly statuses: readonly MemoryStatus[];
  readonly type: 'obsidian';
  readonly vault: string;
}

export interface ObsidianConfiguration {
  readonly projections: readonly ObsidianProjectionConfig[];
  readonly sources: readonly ObsidianSourceConfig[];
  readonly version: 1;
}

export const DEFAULT_OBSIDIAN_EXCLUDES = ['.obsidian/**', '.trash/**'] as const;
export const DEFAULT_PROJECTION_KINDS = ['durable', 'handoff'] as const;
export const DEFAULT_PROJECTION_STATUSES = ['active'] as const;

const CONFIGURATION_VERSION = 1;
const CONFIGURATION_FILENAME = 'sources.yaml';
const CONFIGURATION_LOCK_RETRY_MILLISECONDS = 25;
const CONFIGURATION_LOCK_STALE_MILLISECONDS = 5 * 60 * 1_000;
const CONFIGURATION_LOCK_WAIT_MILLISECONDS = 5_000;
const CONFIGURATION_LOCK_OPTIONS = {
  retryIntervalMilliseconds: CONFIGURATION_LOCK_RETRY_MILLISECONDS,
  staleAfterMilliseconds: CONFIGURATION_LOCK_STALE_MILLISECONDS,
  waitTimeoutMilliseconds: CONFIGURATION_LOCK_WAIT_MILLISECONDS,
} as const;
const CONFIGURATION_FILE_MODE = 0o600;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function emptyObsidianConfiguration(): ObsidianConfiguration {
  return {projections: [], sources: [], version: CONFIGURATION_VERSION};
}

export const obsidianConfigurationPath = Effect.fn('obsidian.configurationPath')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const pathService = yield* Path.Path;
  return pathService.join(config.agentContextHome, 'threadnote', CONFIGURATION_FILENAME);
});

export const readObsidianConfiguration = Effect.fn('obsidian.readConfiguration')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* obsidianConfigurationPath(config);
  if (!(yield* fs.exists(path))) {
    return emptyObsidianConfiguration();
  }
  const raw = yield* fs.readFileString(path);
  return yield* Effect.try({
    try: () => parseObsidianConfiguration(raw, path),
    catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
  });
});

export const writeObsidianConfiguration = Effect.fn('obsidian.writeConfiguration')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  value: ObsidianConfiguration,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = yield* obsidianConfigurationPath(config);
  const serialized = renderObsidianConfiguration(value);
  yield* withExclusiveFileLock(
    fs,
    `${path}.lock`,
    CONFIGURATION_LOCK_OPTIONS,
    Effect.gen(function* () {
      yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
      const crypto = yield* Crypto.Crypto;
      const temporaryPath = `${path}.${yield* crypto.randomUUIDv4}.tmp`;
      yield* fs.writeFileString(temporaryPath, serialized, {mode: CONFIGURATION_FILE_MODE});
      yield* fs
        .rename(temporaryPath, path)
        .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.catch(() => Effect.void))));
      yield* fs.chmod(path, CONFIGURATION_FILE_MODE);
    }),
  );
  return path;
});

export function parseObsidianConfiguration(raw: string, path = CONFIGURATION_FILENAME): ObsidianConfiguration {
  const loaded = yaml.load(raw);
  if (!isJsonObject(loaded)) {
    throw new Error(`Obsidian source configuration must be an object: ${path}`);
  }
  if (loaded.version !== CONFIGURATION_VERSION) {
    throw new Error(`Unsupported Obsidian source configuration version in ${path}. Expected 1.`);
  }
  if (!Array.isArray(loaded.sources) || !Array.isArray(loaded.projections)) {
    throw new Error(`Obsidian source configuration requires sources and projections arrays: ${path}`);
  }
  const sources = loaded.sources.map((value, index) => parseSource(value, `${path} sources[${index}]`));
  const projections = loaded.projections.map((value, index) => parseProjection(value, `${path} projections[${index}]`));
  assertUniqueIds(sources, projections, path);
  return {projections, sources, version: CONFIGURATION_VERSION};
}

export function renderObsidianConfiguration(value: ObsidianConfiguration): string {
  const normalized = {
    version: CONFIGURATION_VERSION,
    sources: value.sources.map(source => ({
      id: source.id,
      type: source.type,
      vault: source.vault,
      include: [...source.include],
      exclude: [...source.exclude],
      enabled: source.enabled,
      watch: source.watch,
      ...(source.inbox ? {inbox: source.inbox} : {}),
    })),
    projections: value.projections.map(projection => ({
      id: projection.id,
      type: projection.type,
      vault: projection.vault,
      folder: projection.folder,
      kinds: [...projection.kinds],
      statuses: [...projection.statuses],
      include_shared: projection.includeShared,
      enabled: projection.enabled,
    })),
  };
  return yaml.dump(normalized, {lineWidth: 100, noRefs: true, sortKeys: false});
}

export function upsertObsidianSource(
  configuration: ObsidianConfiguration,
  source: ObsidianSourceConfig,
): ObsidianConfiguration {
  return {
    ...configuration,
    sources: [...configuration.sources.filter(item => item.id !== source.id), source].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

export function upsertObsidianProjection(
  configuration: ObsidianConfiguration,
  projection: ObsidianProjectionConfig,
): ObsidianConfiguration {
  return {
    ...configuration,
    projections: [...configuration.projections.filter(item => item.id !== projection.id), projection].sort(
      (left, right) => left.id.localeCompare(right.id),
    ),
  };
}

export function removeObsidianSource(configuration: ObsidianConfiguration, id: string): ObsidianConfiguration {
  return {...configuration, sources: configuration.sources.filter(source => source.id !== id)};
}

export function removeObsidianProjection(configuration: ObsidianConfiguration, id: string): ObsidianConfiguration {
  return {...configuration, projections: configuration.projections.filter(projection => projection.id !== id)};
}

export function requireObsidianSource(configuration: ObsidianConfiguration, id: string): ObsidianSourceConfig {
  const source = configuration.sources.find(item => item.id === id);
  if (!source) {
    throw new Error(`No Obsidian source named "${id}".`);
  }
  return source;
}

export function requireObsidianProjection(configuration: ObsidianConfiguration, id: string): ObsidianProjectionConfig {
  const projection = configuration.projections.find(item => item.id === id);
  if (!projection) {
    throw new Error(`No Obsidian projection named "${id}".`);
  }
  return projection;
}

export function validateObsidianIdentifier(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new Error(`${label} must contain only lowercase letters, digits, dots, underscores, and hyphens.`);
  }
  return normalized;
}

function parseSource(value: unknown, label: string): ObsidianSourceConfig {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const id = requiredIdentifier(value.id, `${label}.id`);
  if (value.type !== 'obsidian') {
    throw new Error(`${label}.type must be "obsidian".`);
  }
  const include = sourcePatterns(value.include, `${label}.include`);
  if (include.length === 0) {
    throw new Error(`${label}.include must contain at least one allowlist pattern.`);
  }
  return {
    enabled: optionalBoolean(value.enabled, true, `${label}.enabled`),
    exclude: value.exclude === undefined ? [] : sourcePatterns(value.exclude, `${label}.exclude`),
    id,
    inbox: value.inbox === undefined ? undefined : requiredRelativeFolder(value.inbox, `${label}.inbox`),
    include,
    type: 'obsidian',
    vault: requiredAbsoluteVaultPath(value.vault, `${label}.vault`),
    watch: optionalBoolean(value.watch, false, `${label}.watch`),
  };
}

function parseProjection(value: unknown, label: string): ObsidianProjectionConfig {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const id = requiredIdentifier(value.id, `${label}.id`);
  if (value.type !== 'obsidian') {
    throw new Error(`${label}.type must be "obsidian".`);
  }
  return {
    enabled: optionalBoolean(value.enabled, true, `${label}.enabled`),
    folder: requiredRelativeFolder(value.folder, `${label}.folder`),
    id,
    includeShared: optionalBoolean(value.include_shared, true, `${label}.include_shared`),
    kinds: memoryKinds(value.kinds, `${label}.kinds`),
    statuses: memoryStatuses(value.statuses, `${label}.statuses`),
    type: 'obsidian',
    vault: requiredAbsoluteVaultPath(value.vault, `${label}.vault`),
  };
}

function assertUniqueIds(
  sources: readonly ObsidianSourceConfig[],
  projections: readonly ObsidianProjectionConfig[],
  path: string,
): void {
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.id)) {
      throw new Error(`Duplicate source id "${source.id}" in ${path}.`);
    }
    sourceIds.add(source.id);
  }
  const projectionIds = new Set<string>();
  for (const projection of projections) {
    if (projectionIds.has(projection.id)) {
      throw new Error(`Duplicate projection id "${projection.id}" in ${path}.`);
    }
    projectionIds.add(projection.id);
  }
}

function requiredIdentifier(value: unknown, label: string): string {
  return validateObsidianIdentifier(requiredString(value, label), label);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredAbsoluteVaultPath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (!path.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(path) && !/^\\\\/.test(path)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path;
}

function requiredRelativeFolder(value: unknown, label: string): string {
  const folder = requiredString(value, label)
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/g, '');
  if (folder.length === 0 || folder.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} must be a safe vault-relative folder.`);
  }
  return folder;
}

function requiredStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim().length > 0)) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return [...new Set(value.map(item => (item as string).trim()))];
}

function sourcePatterns(value: unknown, label: string): readonly string[] {
  return requiredStringArray(value, label).map(pattern => {
    const normalized = pattern.replaceAll('\\', '/');
    if (
      normalized.startsWith('/') ||
      /^[a-zA-Z]:\//.test(normalized) ||
      normalized.split('/').some(segment => segment === '..')
    ) {
      throw new Error(`${label} must contain only vault-relative patterns without parent traversal.`);
    }
    return normalized;
  });
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function memoryKinds(value: unknown, label: string): readonly MemoryKind[] {
  const values = value === undefined ? DEFAULT_PROJECTION_KINDS : requiredStringArray(value, label);
  if (
    !values.every(
      item =>
        item === 'durable' || item === 'handoff' || item === 'incident' || item === 'preference' || item === 'smoke',
    )
  ) {
    throw new Error(`${label} contains an unsupported memory kind.`);
  }
  return values as readonly MemoryKind[];
}

function memoryStatuses(value: unknown, label: string): readonly MemoryStatus[] {
  const values = value === undefined ? DEFAULT_PROJECTION_STATUSES : requiredStringArray(value, label);
  if (!values.every(item => item === 'active' || item === 'archived' || item === 'superseded')) {
    throw new Error(`${label} contains an unsupported memory status.`);
  }
  return values as readonly MemoryStatus[];
}
