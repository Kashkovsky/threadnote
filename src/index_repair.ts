import {readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {inferProjectFromQuery, readSeedManifest, uriSegment} from './manifest.js';
import {withIdentity} from './runtime.js';
import type {CommandResult} from './types.js';
import {ensureDirectory, exists, isJsonObject, readFileIfExists, runCommand, sha256, toPosixPath} from './utils.js';

const AUTO_REPAIR_STATE_FILE = 'index-auto-repair.json';
const AUTO_REPAIR_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SCAN_DEPTH = 5;
const MAX_REPAIR_TARGETS = 4;
export const MAINTENANCE_MAX_REPAIR_TARGETS = 16;

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

export async function repairStaleRecallIndex(
  config: RecallIndexRepairConfig,
  ov: string,
  options: {
    readonly collapseToRoots?: boolean;
    readonly dryRun?: boolean;
    readonly ignoreBackoff?: boolean;
    readonly includeAgentSkills?: boolean;
    readonly includeManifestResources?: boolean;
    readonly maxTargets?: number;
    readonly onProgress?: (progress: RecallIndexRepairProgress) => void;
    readonly query?: string;
  } = {},
): Promise<RecallIndexRepairResult> {
  options.onProgress?.({type: 'scan-start'});
  const targets = await findStaleRecallIndexTargets(config, options);
  const repairTargets = targets.slice(0, options.maxTargets ?? MAX_REPAIR_TARGETS);
  options.onProgress?.({
    repairTargetCount: repairTargets.length,
    totalTargets: targets.length,
    type: 'scan-complete',
  });
  if (targets.length === 0) {
    return {repairedUris: [], skippedRecentUris: [], warnings: []};
  }

  const state = options.dryRun === true ? {entries: {}, version: 1 as const} : await readAutoRepairState(config);
  const now = Date.now();
  const repairedUris: string[] = [];
  const skippedRecentUris: string[] = [];
  const warnings: string[] = [];

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
    const result = await runCommand(
      ov,
      withIdentity(config, ['reindex', target.uri, '--mode', 'semantic_and_vectors', '--wait', 'true']),
      {allowFailure: true},
    );
    if (result.exitCode === 0) {
      repairedUris.push(target.uri);
      state.entries[target.uri] = {repairedAt: new Date(now).toISOString(), signature: target.signature};
    } else {
      warnings.push(indexRepairWarning(target.uri, result));
    }
  }

  if (options.dryRun !== true && repairedUris.length > 0) {
    await writeAutoRepairState(config, state);
  }

  return {repairedUris, skippedRecentUris, warnings};
}

export async function findStaleRecallIndexTargets(
  config: RecallIndexRepairConfig,
  options: {
    readonly collapseToRoots?: boolean;
    readonly includeAgentSkills?: boolean;
    readonly includeManifestResources?: boolean;
    readonly query?: string;
  } = {},
): Promise<readonly StaleIndexTarget[]> {
  const roots = await scanRoots(config, options);
  const byUri = new Map<string, {parts: string[]; staleCount: number; uri: string}>();
  for (const root of roots) {
    if (!(await exists(root.path))) {
      continue;
    }
    const sidecars = await staleSidecars(root.path, root.uri);
    if (options.collapseToRoots === true) {
      if (sidecars.length === 0) {
        continue;
      }
      const parts = sidecars.map(sidecar => `${sidecar.relativePath}\n${sidecar.content}`);
      byUri.set(root.uri, {
        parts,
        staleCount: sidecars.length,
        uri: root.uri,
      });
      continue;
    }
    for (const sidecar of sidecars) {
      const current = byUri.get(sidecar.uri) ?? {parts: [], staleCount: 0, uri: sidecar.uri};
      current.parts.push(`${sidecar.relativePath}\n${sidecar.content}`);
      current.staleCount += 1;
      byUri.set(sidecar.uri, current);
    }
  }
  return [...byUri.values()].map(target => ({
    signature: sha256([target.uri, ...target.parts.sort()].join('\n---\n')),
    staleCount: target.staleCount,
    uri: target.uri,
  }));
}

export function formatRecallIndexRepairMessages(
  result: RecallIndexRepairResult,
  options: {readonly dryRun?: boolean} = {},
): readonly string[] {
  const messages: string[] = [];
  for (const uri of result.repairedUris) {
    messages.push(
      `${options.dryRun === true ? 'Would auto-reindex stale recall scope' : 'Auto-reindexed stale recall scope'}: ${uri}`,
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

async function scanRoots(
  config: RecallIndexRepairConfig,
  options: {
    readonly collapseToRoots?: boolean;
    readonly includeAgentSkills?: boolean;
    readonly includeManifestResources?: boolean;
    readonly query?: string;
  },
): Promise<readonly {readonly path: string; readonly uri: string}[]> {
  const accountRoot = join(config.agentContextHome, 'data', 'viking', config.account);
  const roots: Array<{path: string; uri: string}> = [
    {
      path: join(accountRoot, 'user', uriSegment(config.user), 'memories'),
      uri: `viking://user/${uriSegment(config.user)}/memories`,
    },
  ];

  const query = options.query;
  if (query) {
    const project = await inferProjectFromQuery(config.manifestPath, query);
    const projectPath = project?.uri.startsWith('viking://resources/')
      ? join(accountRoot, 'resources', ...project.uri.slice('viking://resources/'.length).split('/'))
      : undefined;
    if (project && projectPath) {
      roots.push({path: projectPath, uri: project.uri});
    }
  }

  if (options.includeManifestResources === true) {
    roots.push(...(await manifestResourceRoots(config, accountRoot)));
  }

  const scanAgentSkills =
    options.includeAgentSkills === true || (query ? /\bskills?\b/.test(query.toLowerCase()) : false);
  if (scanAgentSkills) {
    roots.push({path: join(accountRoot, 'resources', 'agent-skills'), uri: 'viking://resources/agent-skills'});
  }

  return dedupeRoots(roots);
}

async function manifestResourceRoots(
  config: RecallIndexRepairConfig,
  accountRoot: string,
): Promise<readonly {readonly path: string; readonly uri: string}[]> {
  try {
    const manifest = await readSeedManifest(config.manifestPath);
    return manifest.projects
      .filter(project => project.uri.startsWith('viking://resources/'))
      .map(project => ({
        path: join(accountRoot, 'resources', ...project.uri.slice('viking://resources/'.length).split('/')),
        uri: project.uri,
      }));
  } catch (_err: unknown) {
    return [];
  }
}

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

async function staleSidecars(rootPath: string, rootUri: string): Promise<readonly StaleSidecar[]> {
  const results: StaleSidecar[] = [];

  async function visit(path: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(path, {withFileTypes: true});
    } catch (_err: unknown) {
      return;
    }

    for (const entry of entries) {
      const childPath = join(path, entry.name);
      if (entry.isFile() && isSummarySidecar(entry.name)) {
        let content;
        try {
          content = await readFile(childPath, 'utf8');
        } catch (_err: unknown) {
          continue;
        }
        if (!isStaleSummary(content)) {
          continue;
        }
        const parentPath = dirname(childPath);
        const parentRelative = toPosixPath(relative(rootPath, parentPath));
        const relativePath = toPosixPath(relative(rootPath, childPath));
        results.push({
          content: content.trim(),
          relativePath,
          uri: parentRelative ? `${trimLocalRootUri(rootUri)}/${parentRelative}` : trimLocalRootUri(rootUri),
        });
      } else if (entry.isDirectory() && depth < MAX_SCAN_DEPTH) {
        await visit(childPath, depth + 1);
      }
    }
  }

  await visit(rootPath, 0);
  return results;
}

function isSummarySidecar(name: string): boolean {
  return name === '.abstract.md' || name === '.overview.md';
}

function isStaleSummary(content: string): boolean {
  return content.includes('[Directory overview is not ready]') || content.includes('[Directory abstract is not ready]');
}

function trimLocalRootUri(uri: string): string {
  return uri.endsWith('/') ? uri.slice(0, -1) : uri;
}

async function readAutoRepairState(config: RecallIndexRepairConfig): Promise<AutoRepairState> {
  const raw = await readFileIfExists(autoRepairStatePath(config));
  if (!raw) {
    return {entries: {}, version: 1};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed) || parsed.version !== 1 || !isJsonObject(parsed.entries)) {
      return {entries: {}, version: 1};
    }
    const entries: Record<string, AutoRepairStateEntry> = {};
    for (const [uri, entry] of Object.entries(parsed.entries)) {
      if (isJsonObject(entry) && typeof entry.signature === 'string' && typeof entry.repairedAt === 'string') {
        entries[uri] = {repairedAt: entry.repairedAt, signature: entry.signature};
      }
    }
    return {entries, version: 1};
  } catch (_err: unknown) {
    return {entries: {}, version: 1};
  }
}

async function writeAutoRepairState(config: RecallIndexRepairConfig, state: AutoRepairState): Promise<void> {
  const path = autoRepairStatePath(config);
  await ensureDirectory(dirname(path), false);
  await writeFile(path, `${JSON.stringify(state, undefined, 2)}\n`, {encoding: 'utf8', mode: 0o600});
}

function autoRepairStatePath(config: RecallIndexRepairConfig): string {
  return join(config.agentContextHome, AUTO_REPAIR_STATE_FILE);
}

function indexRepairWarning(uri: string, result: CommandResult): string {
  return `${uri}: ${result.stderr.trim() || result.stdout.trim() || 'reindex failed'}`;
}
