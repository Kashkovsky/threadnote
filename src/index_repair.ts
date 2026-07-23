import {Effect, FileSystem, Path, Result} from 'effect';
import {inferProjectFromQuery, readSeedManifest, uriSegment} from './manifest.js';
import {withIdentity} from './runtime.js';
import type {CommandResult} from './types.js';
import {
  ensureDirectory,
  exists,
  isJsonObject,
  readFileIfExists,
  reindexWaitTimeoutMs,
  runCommand,
  sha256,
  toPosixPath,
} from './utils.js';

const AUTO_REPAIR_STATE_FILE = 'index-auto-repair.json';
const AUTO_REPAIR_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SCAN_DEPTH = 5;
const MAX_REPAIR_TARGETS = 4;
export const MAINTENANCE_COLLAPSE_DEPTH = 3;
export const MAINTENANCE_MAX_REPAIR_TARGETS = 512;
export const MAINTENANCE_CONSECUTIVE_FAILURE_LIMIT = 5;

interface RecallIndexRepairConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly agentId: string;
  readonly manifestPath: string;
  readonly user: string;
}

interface AutoRepairState {
  readonly entries: Record<string, AutoRepairStateEntry>;
  readonly version: 1;
}

interface AutoRepairStateEntry {
  readonly repairedAt: string;
  readonly signature: string;
}

export interface StaleIndexTarget {
  readonly signature: string;
  readonly staleCount: number;
  readonly uri: string;
}

export interface RecallIndexRepairResult {
  readonly repairedUris: readonly string[];
  readonly skippedRecentUris: readonly string[];
  readonly warnings: readonly string[];
}

export type RecallIndexRepairProgress =
  | {readonly type: 'scan-start'}
  | {readonly repairTargetCount: number; readonly totalTargets: number; readonly type: 'scan-complete'}
  | {
      readonly index: number;
      readonly target: StaleIndexTarget;
      readonly total: number;
      readonly type: 'repair-start';
    }
  | {
      readonly index: number;
      readonly target: StaleIndexTarget;
      readonly total: number;
      readonly type: 'repair-skip-recent';
    }
  | {
      readonly index: number;
      readonly target: StaleIndexTarget;
      readonly total: number;
      readonly type: 'repair-dry-run';
    };

export const repairStaleRecallIndex = Effect.fn('indexRepair.repair')(function* (
  config: RecallIndexRepairConfig,
  ov: string,
  options: {
    readonly collapseToRoots?: boolean;
    readonly collapseDepth?: number;
    readonly consecutiveFailureLimit?: number;
    readonly dryRun?: boolean;
    readonly ignoreBackoff?: boolean;
    readonly includeAgentSkills?: boolean;
    readonly includeManifestResources?: boolean;
    readonly maxTargets?: number;
    readonly onRepairFailure?: (target: StaleIndexTarget, result: CommandResult) => Effect.Effect<void, unknown> | void;
    readonly onProgress?: (progress: RecallIndexRepairProgress) => void;
    readonly query?: string;
  } = {},
) {
  options.onProgress?.({type: 'scan-start'});
  const targets = yield* findStaleRecallIndexTargets(config, options);
  const repairTargets = targets.slice(0, options.maxTargets ?? MAX_REPAIR_TARGETS);
  const consecutiveFailureLimit = options.consecutiveFailureLimit;
  options.onProgress?.({
    repairTargetCount: repairTargets.length,
    totalTargets: targets.length,
    type: 'scan-complete',
  });
  if (targets.length === 0) {
    return {repairedUris: [], skippedRecentUris: [], warnings: []};
  }

  let state: AutoRepairState = {entries: {}, version: 1};
  if (options.dryRun !== true) {
    state = yield* readAutoRepairState(config);
  }
  const now = Date.now();
  const repairedUris: string[] = [];
  const skippedRecentUris: string[] = [];
  const warnings: string[] = [];
  let consecutiveFailures = 0;

  for (const [targetIndex, target] of repairTargets.entries()) {
    const progressBase = {index: targetIndex + 1, target, total: repairTargets.length};
    const previous = state.entries[target.uri];
    if (
      previous?.signature === target.signature &&
      now - Date.parse(previous.repairedAt) < AUTO_REPAIR_TTL_MS &&
      options.dryRun !== true &&
      options.ignoreBackoff !== true
    ) {
      options.onProgress?.({...progressBase, type: 'repair-skip-recent'});
      skippedRecentUris.push(target.uri);
      continue;
    }

    if (options.dryRun === true) {
      options.onProgress?.({...progressBase, type: 'repair-dry-run'});
      repairedUris.push(target.uri);
      continue;
    }

    options.onProgress?.({...progressBase, type: 'repair-start'});
    const result = yield* runCommand(
      ov,
      withIdentity(config, ['reindex', target.uri, '--mode', 'semantic_and_vectors', '--wait', 'true']),
      // Bound the wait: `ov reindex` has no --timeout, so a stuck/poisoned
      // semantic queue would block each target for the full 10-min command
      // timeout. A timed-out target counts as a failure and trips the
      // consecutive-failure stop instead of hanging the whole repair.
      {allowFailure: true, timeoutMs: yield* reindexWaitTimeoutMs()},
    );
    if (result.exitCode === 0) {
      consecutiveFailures = 0;
      repairedUris.push(target.uri);
      state.entries[target.uri] = {repairedAt: new Date(now).toISOString(), signature: target.signature};
    } else {
      consecutiveFailures += 1;
      warnings.push(indexRepairWarning(target.uri, result));
      if (options.onRepairFailure) {
        const failureHook = yield* Effect.try({
          try: () => options.onRepairFailure?.(target, result),
          catch: cause => cause,
        });
        if (Effect.isEffect(failureHook)) {
          yield* failureHook;
        }
      }
      const remaining = repairTargets.length - (targetIndex + 1);
      if (consecutiveFailureLimit !== undefined && consecutiveFailures >= consecutiveFailureLimit && remaining > 0) {
        warnings.push(
          `Stopped recall index repair after ${consecutiveFailures} consecutive reindex failures; ` +
            `skipped ${remaining} remaining scope(s). Re-run \`threadnote repair\` once OpenViking is idle.`,
        );
        break;
      }
    }
  }

  if (options.dryRun !== true && repairedUris.length > 0) {
    yield* writeAutoRepairState(config, state);
  }

  return {repairedUris, skippedRecentUris, warnings};
});

export const findStaleRecallIndexTargets = Effect.fn('indexRepair.findTargets')(function* (
  config: RecallIndexRepairConfig,
  options: {
    readonly collapseToRoots?: boolean;
    readonly collapseDepth?: number;
    readonly includeAgentSkills?: boolean;
    readonly includeManifestResources?: boolean;
    readonly query?: string;
  } = {},
) {
  if (yield* summaryAutoGenerationDisabled(config)) {
    return [];
  }
  const roots = yield* scanRoots(config, options);
  const byUri = new Map<string, {parts: string[]; staleCount: number; uri: string}>();
  for (const root of roots) {
    if (!(yield* exists(root.path))) {
      continue;
    }
    const sidecars = yield* staleSidecars(root.path, root.uri);
    if (options.collapseToRoots === true) {
      for (const sidecar of sidecars) {
        const uri = collapseStaleSidecarUri(root.uri, sidecar.relativePath, options.collapseDepth);
        const current = byUri.get(uri) ?? {parts: [], staleCount: 0, uri};
        current.parts.push(`${sidecar.relativePath}\n${sidecar.content}`);
        current.staleCount += 1;
        byUri.set(uri, current);
      }
      continue;
    }
    for (const sidecar of sidecars) {
      const current = byUri.get(sidecar.uri) ?? {parts: [], staleCount: 0, uri: sidecar.uri};
      current.parts.push(`${sidecar.relativePath}\n${sidecar.content}`);
      current.staleCount += 1;
      byUri.set(sidecar.uri, current);
    }
  }
  return yield* Effect.forEach([...byUri.values()], target =>
    sha256([target.uri, ...target.parts.sort()].join('\n---\n')).pipe(
      Effect.map(signature => ({signature, staleCount: target.staleCount, uri: target.uri})),
    ),
  );
});

function collapseStaleSidecarUri(rootUri: string, relativePath: string, depth = 0): string {
  const normalizedRootUri = trimLocalRootUri(rootUri);
  if (depth <= 0) {
    return normalizedRootUri;
  }
  const parentParts = relativePath.split('/').slice(0, -1);
  const collapsedParts = parentParts.slice(0, depth);
  return collapsedParts.length === 0 ? normalizedRootUri : `${normalizedRootUri}/${collapsedParts.join('/')}`;
}

export function formatRecallIndexRepairMessages(
  result: RecallIndexRepairResult,
  options: {readonly dryRun?: boolean; readonly maxUris?: number} = {},
): readonly string[] {
  const messages: string[] = [];
  const maxUris = options.maxUris ?? result.repairedUris.length;
  for (const uri of result.repairedUris.slice(0, maxUris)) {
    messages.push(
      `${options.dryRun === true ? 'Would auto-reindex stale recall scope' : 'Auto-reindexed stale recall scope'}: ${uri}`,
    );
  }
  const hiddenUriCount = result.repairedUris.length - maxUris;
  if (hiddenUriCount > 0) {
    messages.push(
      options.dryRun === true
        ? `Would auto-reindex ${hiddenUriCount} more stale recall scope(s).`
        : `Auto-reindexed ${hiddenUriCount} more stale recall scope(s).`,
    );
  }
  for (const warning of result.warnings) {
    messages.push(`Auto-index repair warning: ${warning}`);
  }
  return messages;
}

export function filterStaleRecallSummaryRows(output: string): string {
  return output
    .split(/\r?\n/)
    .filter(line => !isStaleRecallSummaryRow(line))
    .join('\n')
    .trim();
}

function isStaleRecallSummaryRow(line: string): boolean {
  return /viking:\/\/\S+\/\.(?:abstract|overview)\.md\b/.test(line) && isStaleSummary(line);
}

const scanRoots = Effect.fn('indexRepair.scanRoots')(function* (
  config: RecallIndexRepairConfig,
  options: {
    readonly collapseToRoots?: boolean;
    readonly includeAgentSkills?: boolean;
    readonly includeManifestResources?: boolean;
    readonly query?: string;
  },
) {
  const path = yield* Path.Path;
  const accountRoot = path.join(config.agentContextHome, 'data', 'viking', config.account);
  const roots: Array<{path: string; uri: string}> = [
    {
      path: path.join(accountRoot, 'user', uriSegment(config.user), 'memories'),
      uri: `viking://user/${uriSegment(config.user)}/memories`,
    },
  ];

  const query = options.query;
  if (query) {
    const project = yield* inferProjectFromQuery(config.manifestPath, query);
    const projectPath = project?.uri.startsWith('viking://resources/')
      ? path.join(accountRoot, 'resources', ...project.uri.slice('viking://resources/'.length).split('/'))
      : undefined;
    if (project && projectPath) {
      roots.push({path: projectPath, uri: project.uri});
    }
  }

  if (options.includeManifestResources === true) {
    roots.push(...(yield* manifestResourceRoots(config, accountRoot)));
  }

  const scanAgentSkills =
    options.includeAgentSkills === true || (query ? /\bskills?\b/.test(query.toLowerCase()) : false);
  if (scanAgentSkills) {
    roots.push({path: path.join(accountRoot, 'resources', 'agent-skills'), uri: 'viking://resources/agent-skills'});
  }

  return dedupeRoots(roots);
});

const manifestResourceRoots = Effect.fn('indexRepair.manifestRoots')(function* (
  config: RecallIndexRepairConfig,
  accountRoot: string,
) {
  const path = yield* Path.Path;
  const manifest = yield* readSeedManifest(config.manifestPath).pipe(Effect.option);
  if (manifest._tag === 'None') {
    return [];
  }
  return manifest.value.projects
    .filter(project => project.uri.startsWith('viking://resources/'))
    .map(project => ({
      path: path.join(accountRoot, 'resources', ...project.uri.slice('viking://resources/'.length).split('/')),
      uri: project.uri,
    }));
});

function dedupeRoots(
  roots: readonly {readonly path: string; readonly uri: string}[],
): readonly {readonly path: string; readonly uri: string}[] {
  const seen = new Set<string>();
  const deduped: Array<{path: string; uri: string}> = [];
  for (const root of roots) {
    if (seen.has(root.uri)) {
      continue;
    }
    seen.add(root.uri);
    deduped.push(root);
  }
  return deduped;
}

interface StaleSidecar {
  readonly content: string;
  readonly relativePath: string;
  readonly uri: string;
}

const staleSidecars = Effect.fn('indexRepair.staleSidecars')(function* (rootPath: string, rootUri: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const results: StaleSidecar[] = [];

  const visit = (path: string, depth: number): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(path).pipe(Effect.catch(() => Effect.succeed([])));
      for (const entry of entries) {
        const childPath = pathService.join(path, entry);
        const info = yield* fs.stat(childPath).pipe(Effect.option);
        if (info._tag === 'None') {
          continue;
        }
        if (info.value.type === 'File' && isSummarySidecar(entry)) {
          const content = yield* fs.readFileString(childPath).pipe(Effect.option);
          if (content._tag === 'None') {
            continue;
          }
          if (!isStaleSummary(content.value)) {
            continue;
          }
          const parentPath = pathService.dirname(childPath);
          const parentRelative = toPosixPath(pathService.relative(rootPath, parentPath));
          const relativePath = toPosixPath(pathService.relative(rootPath, childPath));
          results.push({
            content: content.value.trim(),
            relativePath,
            uri: parentRelative ? `${trimLocalRootUri(rootUri)}/${parentRelative}` : trimLocalRootUri(rootUri),
          });
        } else if (info.value.type === 'Directory' && depth < MAX_SCAN_DEPTH) {
          yield* visit(childPath, depth + 1);
        }
      }
    });

  yield* visit(rootPath, 0);
  return results;
});

function isSummarySidecar(name: string): boolean {
  return name === '.abstract.md' || name === '.overview.md';
}

/**
 * `[Directory ... not ready]` sidecars only become "ready" when OpenViking
 * generates Level 0/1 directory summaries. Threadnote's shipped `ov.conf`
 * template sets `auto_generate_l0` and `auto_generate_l1` to false, and
 * `ov reindex` (vectors_only / semantic_and_vectors) never regenerates those
 * summaries. So when both are disabled the placeholders are permanent by
 * design — treating them as stale would reindex every scope on every recall
 * forever without ever clearing a single placeholder. Recall itself relies on
 * the semantic + vector index, not these summaries, so skipping the scan is
 * safe. Unknown/unparseable config is treated as enabled to preserve behavior.
 */
export const summaryAutoGenerationDisabled = Effect.fn('indexRepair.summaryAutoGenerationDisabled')(function* (
  config: RecallIndexRepairConfig,
) {
  const path = yield* Path.Path;
  const raw = yield* readFileIfExists(path.join(config.agentContextHome, 'ov.conf'));
  if (!raw) {
    return false;
  }
  const parsedResult = Result.try((): unknown => JSON.parse(raw));
  if (Result.isFailure(parsedResult)) {
    return false;
  }
  const parsed = parsedResult.success;
  return isJsonObject(parsed) && parsed.auto_generate_l0 === false && parsed.auto_generate_l1 === false;
});

function isStaleSummary(content: string): boolean {
  return content.includes('[Directory overview is not ready]') || content.includes('[Directory abstract is not ready]');
}

function trimLocalRootUri(uri: string): string {
  return uri.endsWith('/') ? uri.slice(0, -1) : uri;
}

const readAutoRepairState = Effect.fn('indexRepair.readState')(function* (config: RecallIndexRepairConfig) {
  const raw = yield* readFileIfExists(yield* autoRepairStatePath(config));
  if (!raw) {
    return {entries: {}, version: 1 as const};
  }
  const parsedResult = Result.try((): unknown => JSON.parse(raw));
  if (Result.isFailure(parsedResult)) {
    return {entries: {}, version: 1 as const};
  }
  const parsed = parsedResult.success;
  if (!isJsonObject(parsed) || parsed.version !== 1 || !isJsonObject(parsed.entries)) {
    return {entries: {}, version: 1 as const};
  }
  const entries: Record<string, AutoRepairStateEntry> = {};
  for (const [uri, entry] of Object.entries(parsed.entries)) {
    if (isJsonObject(entry) && typeof entry.signature === 'string' && typeof entry.repairedAt === 'string') {
      entries[uri] = {repairedAt: entry.repairedAt, signature: entry.signature};
    }
  }
  return {entries, version: 1 as const};
});

const writeAutoRepairState = Effect.fn('indexRepair.writeState')(function* (
  config: RecallIndexRepairConfig,
  state: AutoRepairState,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = yield* autoRepairStatePath(config);
  yield* ensureDirectory(pathService.dirname(path), false);
  yield* fs.writeFileString(path, `${JSON.stringify(state, undefined, 2)}\n`, {mode: 0o600});
});

const autoRepairStatePath = Effect.fn('indexRepair.statePath')(function* (config: RecallIndexRepairConfig) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, AUTO_REPAIR_STATE_FILE);
});

function indexRepairWarning(uri: string, result: CommandResult): string {
  return `${uri}: ${result.stderr.trim() || result.stdout.trim() || 'reindex failed'}`;
}
