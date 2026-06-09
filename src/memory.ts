import {chmod, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {basename, join, sep} from 'node:path';
import {inferProjectFromQuery, uriSegment} from './manifest.js';
import {filterStaleRecallSummaryRows, formatRecallIndexRepairMessages, repairStaleRecallIndex} from './index_repair.js';
import {
  activePersonalMemoryUrisFromText,
  buildCompactPlan,
  type CompactableMemoryKind,
  formatCompactPlan,
  handoffTopicForBranch,
  parseMemoryDocument,
  recallHygieneNudges,
  topicForRecord,
  type MemoryRecord,
} from './memory_hygiene.js';
import {withIdentity} from './runtime.js';
import type {
  ArchiveOptions,
  CompactOptions,
  ForgetOptions,
  HandoffOptions,
  ListOptions,
  MigrateLifecycleOptions,
  MemoryKind,
  MemoryStatus,
  MigrateMemoriesOptions,
  PackOptions,
  ProjectManifest,
  ReadOptions,
  RecallOptions,
  RememberOptions,
  RuntimeConfig,
} from './types.js';
import {
  assertVikingUri,
  enrichRecallQueryWithWorkspaceContext,
  enrichRecallQueryWithWorkspaceProjectContext,
  expandPath,
  exactMemoryScopeUris,
  exactRecallScopeIntents,
  exactRecallTerms,
  collectExactMatches,
  formatExactMatchPointers,
  formatShellCommand,
  getInputText,
  getInvocationCwd,
  gitValue,
  isJsonObject,
  maybeRun,
  openVikingCliForMode,
  parentVikingUri,
  parsePositiveInteger,
  RECALL_SCORE_THRESHOLD,
  resolveRepoName,
  runCommand,
  safeTimestamp,
  sha256,
  sleep,
  trimTrailingSlash,
} from './utils.js';
import {
  applyScrubber,
  ensureSharedDirectoryChain,
  isInSharedNamespace,
  publishShareGitChange,
  resolveTeam,
  sharedMemoryUriParts,
  sharedTeamNameForUri,
  stripPersonalProvenance,
  syncSharedReposBeforeAgentRead,
  vikingUriToWorktreeRelative,
  writeMemoryFile,
} from './share.js';

interface LegacyMemoryCandidate {
  readonly comparableHash: string;
  readonly hash: string;
  readonly sourceAccount: string;
  readonly sourceArchive: string;
  readonly sourceSession: string;
  readonly text: string;
}

interface MemoryMetadata {
  readonly archivedFrom?: string;
  readonly kind: MemoryKind;
  readonly project?: string;
  readonly sourceAgentClient: string;
  readonly status: MemoryStatus;
  readonly supersedes?: string;
  readonly timestamp: string;
  readonly topic?: string;
}

interface StoreMemoryOptions {
  readonly bodyText: string;
  readonly dryRun: boolean;
  readonly metadata: MemoryMetadata;
  readonly replaceUri?: string;
  readonly title: 'MEMORY' | 'HANDOFF';
}

interface LifecycleHandoffCandidate {
  readonly metadata: MemoryMetadata;
  readonly original: string;
  readonly sourceUri: string;
}

export function parseMemoryKind(value: string): MemoryKind {
  if (['durable', 'handoff', 'incident', 'preference', 'smoke'].includes(value)) {
    return value as MemoryKind;
  }
  throw new Error(`Unsupported memory kind "${value}". Expected durable, handoff, incident, preference, or smoke.`);
}

export function parseMemoryStatus(value: string): MemoryStatus {
  if (['active', 'archived', 'superseded'].includes(value)) {
    return value as MemoryStatus;
  }
  throw new Error(`Unsupported memory status "${value}". Expected active, archived, or superseded.`);
}

export function parseCompactKind(value: string): CompactableMemoryKind {
  if (['durable', 'handoff', 'incident'].includes(value)) {
    return value as CompactableMemoryKind;
  }
  throw new Error(`Unsupported compact kind "${value}". Expected durable, handoff, or incident.`);
}

export async function runRemember(config: RuntimeConfig, options: RememberOptions): Promise<void> {
  const text = await getInputText(options.text, options.stdin === true);
  if (!text.trim()) {
    throw new Error('Provide memory text with --text or --stdin.');
  }
  const metadata: MemoryMetadata = {
    kind: options.kind ?? 'durable',
    project: normalizeOptionalMetadata(options.project),
    sourceAgentClient: options.sourceAgentClient ?? 'codex',
    status: options.status ?? 'active',
    timestamp: new Date().toISOString(),
    topic: normalizeOptionalMetadata(options.topic),
  };
  await storeMemory(config, {
    bodyText: text.trim(),
    dryRun: options.dryRun === true,
    metadata,
    replaceUri: options.replace,
    title: 'MEMORY',
  });
}

export async function runMigrateMemories(config: RuntimeConfig, options: MigrateMemoriesOptions): Promise<void> {
  const dryRun = options.dryRun === true;
  const limit = options.limit ? parsePositiveInteger(options.limit, 'migration limit') : undefined;
  const sourceAccounts = await legacySourceAccounts(config, options);
  if (sourceAccounts.length === 0) {
    console.log('No local OpenViking accounts found to scan.');
    return;
  }

  const candidates = await legacyMemoryCandidates(config, sourceAccounts);
  const existingHashes = await existingDurableMemoryHashes(config);
  const ov = await openVikingCliForMode(dryRun);
  const migrationPath = join(config.agentContextHome, 'legacy-memory-migration.txt');

  let duplicateCount = 0;
  let migratedCount = 0;
  let sensitiveCount = 0;
  if (!dryRun && candidates.length > 0) {
    await ensureDurableMemoryDirectory(ov, config);
  }

  try {
    for (const candidate of candidates) {
      if (existingHashes.has(candidate.hash)) {
        duplicateCount += 1;
        continue;
      }
      if (existingHashes.has(candidate.comparableHash)) {
        duplicateCount += 1;
        continue;
      }
      const sensitiveReason = sensitiveMemoryReason(candidate.text);
      if (sensitiveReason) {
        sensitiveCount += 1;
        console.log(
          `SKIP ${legacySourceLabel(candidate)}: possible ${sensitiveReason}; inspect the source archive manually if needed.`,
        );
        continue;
      }
      if (limit !== undefined && migratedCount >= limit) {
        break;
      }

      const memoryUri = migratedDurableMemoryUri(config, candidate.hash);
      if (!dryRun && (await vikingResourceExists(ov, config, memoryUri))) {
        duplicateCount += 1;
        existingHashes.add(candidate.hash);
        continue;
      }

      console.log(`${dryRun ? 'Would migrate' : 'Migrating'} ${legacySourceLabel(candidate)} -> ${memoryUri}`);
      if (!dryRun) {
        await writeFile(migrationPath, candidate.text, {encoding: 'utf8', mode: 0o600});
        await chmod(migrationPath, 0o600);
        await writeDurableMemoryFile(ov, config, memoryUri, migrationPath, 'create');
        existingHashes.add(candidate.hash);
      }
      migratedCount += 1;
    }
  } finally {
    if (!dryRun) {
      await rm(migrationPath, {force: true});
    }
  }

  console.log(
    [
      `Migration summary: ${migratedCount} ${dryRun ? 'would be migrated' : 'migrated'}`,
      `${duplicateCount} duplicate(s) skipped`,
      `${sensitiveCount} sensitive-looking item(s) skipped`,
      `${candidates.length} legacy Threadnote item(s) scanned`,
      `source account(s): ${sourceAccounts.join(', ')}`,
    ].join('; '),
  );
}

export async function runMigrateLifecycle(config: RuntimeConfig, options: MigrateLifecycleOptions): Promise<void> {
  const dryRun = options.dryRun === true || options.apply !== true;
  const limit = options.limit ? parsePositiveInteger(options.limit, 'lifecycle migration limit') : undefined;
  const ov = await openVikingCliForMode(dryRun);
  const candidates = await legacyLifecycleHandoffCandidates(config);
  const migrationPath = join(config.agentContextHome, 'lifecycle-memory-migration.txt');
  let existingCount = 0;
  let migratedCount = 0;
  let skippedCount = 0;

  try {
    for (const candidate of candidates) {
      if (limit !== undefined && migratedCount >= limit) {
        break;
      }
      const destinationUri = lifecycleMigrationUri(config, candidate.metadata, sha256(candidate.original.trim()));
      const migratedMemory = formatMemoryDocument(
        'HANDOFF',
        candidate.metadata,
        ['Migrated legacy handoff from the historical events trail.', '', candidate.original.trim()].join('\n'),
      );

      console.log(`${dryRun ? 'Would migrate' : 'Migrating'} ${candidate.sourceUri} -> ${destinationUri}`);
      if (!dryRun) {
        if (await vikingResourceExists(ov, config, destinationUri)) {
          existingCount += 1;
          console.log(`Archived copy already exists; cleaning up legacy source: ${candidate.sourceUri}`);
        } else {
          await writeFile(migrationPath, migratedMemory, {encoding: 'utf8', mode: 0o600});
          await chmod(migrationPath, 0o600);
          await ensureMemoryDirectory(ov, config, memoryDirectoryUri(config, candidate.metadata));
          await writeDurableMemoryFile(ov, config, destinationUri, migrationPath, 'create');
        }
        const removedOriginal = await removeVikingResourceWithRetry(ov, config, candidate.sourceUri);
        if (!removedOriginal) {
          console.error(
            `Migrated copy stored, but original is still processing. Retry later: threadnote forget ${candidate.sourceUri}`,
          );
          skippedCount += 1;
        }
      }
      migratedCount += 1;
    }
  } finally {
    if (!dryRun) {
      await rm(migrationPath, {force: true});
    }
  }

  console.log(
    [
      `Lifecycle migration summary: ${migratedCount} clear legacy handoff(s) ${dryRun ? 'would be migrated' : 'migrated'}`,
      `${existingCount} existing archived copy/copies reused`,
      `${skippedCount} legacy source(s) still processing`,
      `${candidates.length} clear legacy handoff candidate(s) found`,
      dryRun ? 'Run with --apply to perform this migration.' : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join('; '),
  );
}

export async function runRecall(config: RuntimeConfig, options: RecallOptions): Promise<void> {
  if (options.dryRun !== true) {
    await syncSharedReposAndLog(config);
  }
  const ov = await openVikingCliForMode(options.dryRun === true);
  const query = await enrichRecallQueryWithWorkspaceContext(options.query);
  const projectQuery = await enrichRecallQueryWithWorkspaceProjectContext(options.query);
  let indexRepairMessages: readonly string[];
  try {
    const indexRepair = await repairStaleRecallIndex(config, ov, {
      dryRun: options.dryRun === true,
      query: projectQuery,
    });
    indexRepairMessages = formatRecallIndexRepairMessages(indexRepair, {dryRun: options.dryRun === true});
  } catch (err: unknown) {
    indexRepairMessages = [`Auto-index repair warning: ${err instanceof Error ? err.message : String(err)}`];
  }
  for (const message of indexRepairMessages) {
    console.log(message);
  }
  const inferredUri =
    options.uri ?? (options.inferScope === false ? undefined : await inferRecallUri(config, projectQuery));
  const project = await inferProjectFromQuery(config.manifestPath, options.project ?? projectQuery);
  const args = ['search', query, '--threshold', options.threshold ?? RECALL_SCORE_THRESHOLD, '--level', '2'];
  if (inferredUri) {
    args.push('--uri', inferredUri);
    console.log(`Recall scope: ${inferredUri}`);
  }
  if (options.nodeLimit) {
    args.push('--node-limit', String(parsePositiveInteger(options.nodeLimit, 'node limit')));
  }
  const recallOutputs: string[] = [];
  const baseOutput = await runRecallSearch(config, ov, args, {dryRun: options.dryRun === true});
  if (baseOutput) {
    recallOutputs.push(baseOutput);
  }
  const projectMemoryOutput = await augmentRecallWithProjectMemories(config, ov, {...options, query}, project);
  if (projectMemoryOutput) {
    recallOutputs.push(projectMemoryOutput);
  }
  const seededOutput = await augmentRecallWithSeededResources(config, ov, {...options, query}, inferredUri, project);
  if (seededOutput) {
    recallOutputs.push(seededOutput);
  }
  const exactOutput = await printExactMemoryMatches(config, ov, query, {
    dryRun: options.dryRun === true,
    includeArchived: options.includeArchived === true,
    project,
  });
  if (exactOutput) {
    recallOutputs.push(exactOutput);
  }
  await printRecallHygieneNudges(config, recallOutputs.join('\n'));
}

/**
 * If the query mentions a seeded project, run a second search scoped to that
 * project's resources URI and print results below the base search. The base
 * search is biased toward memory-shaped vocabulary ("handoff", "durable") and
 * with a small node-limit it crowds out seeded README/AGENTS.md/SKILL.md
 * content — running a scoped pass guarantees that seeded guidance surfaces
 * alongside personal memories on every recall.
 *
 * Skips the augmentation when the caller pinned the search to a specific URI
 * (they asked for that scope; honor it) or when the inferred scope already
 * targets the same resources subtree (no need to duplicate).
 */
/**
 * When the caller explicitly scopes recall to a project (the manager Project
 * field or `recall --project`), run an extra semantic pass over that project's
 * durable memories so project context is prioritized — without dropping the
 * global base pass that surfaces cross-project hits. A project merely inferred
 * from the workspace/query does NOT trigger this; only an explicit
 * `options.project` does.
 */
async function augmentRecallWithProjectMemories(
  config: RuntimeConfig,
  ov: string,
  options: RecallOptions,
  project: ProjectManifest | undefined,
): Promise<string | undefined> {
  if (!options.project || !project) {
    return undefined;
  }
  const scope = `viking://user/${uriSegment(config.user)}/memories/durable/projects/${uriSegment(project.name)}`;
  const args = [
    'search',
    options.query,
    '--threshold',
    options.threshold ?? RECALL_SCORE_THRESHOLD,
    '--level',
    '2',
    '--uri',
    scope,
  ];
  if (options.nodeLimit) {
    args.push('--node-limit', String(parsePositiveInteger(options.nodeLimit, 'node limit')));
  }
  console.log(`\nAlso searching ${project.name} project memories: ${scope}`);
  return runRecallSearch(config, ov, args, {dryRun: options.dryRun === true});
}

async function augmentRecallWithSeededResources(
  config: RuntimeConfig,
  ov: string,
  options: RecallOptions,
  inferredUri: string | undefined,
  project: ProjectManifest | undefined,
): Promise<string | undefined> {
  // `--no-infer-scope` (options.inferScope === false) disables the base scope
  // inference; honoring it here too keeps the flag's meaning consistent —
  // augmenting with a project-scoped search would silently re-introduce what
  // the user disabled. A caller-pinned --uri is also explicit intent we honor.
  if (options.uri || options.inferScope === false || !project) {
    return undefined;
  }
  const projectResourceUri = trimTrailingSlash(project.uri);
  if (!projectResourceUri.startsWith('viking://') || projectResourceUri === inferredUri) {
    return undefined;
  }
  const args = [
    'search',
    options.query,
    '--threshold',
    options.threshold ?? RECALL_SCORE_THRESHOLD,
    '--level',
    '2',
    '--uri',
    projectResourceUri,
  ];
  if (options.nodeLimit) {
    args.push('--node-limit', String(parsePositiveInteger(options.nodeLimit, 'node limit')));
  }
  console.log(`\nAlso searching seeded resources: ${projectResourceUri}`);
  return runRecallSearch(config, ov, args, {dryRun: options.dryRun === true});
}

async function runRecallSearch(
  config: RuntimeConfig,
  ov: string,
  args: readonly string[],
  options: {readonly dryRun: boolean},
): Promise<string | undefined> {
  const fullArgs = withIdentity(config, args);
  console.log(`${options.dryRun ? 'Would run' : 'Running'}: ${formatShellCommand(ov, fullArgs)}`);
  if (options.dryRun) {
    return undefined;
  }
  let result = await runCommand(ov, fullArgs, {allowFailure: true});
  if (result.exitCode !== 0) {
    // Older ov builds may not support --threshold/--level; retry without them
    // rather than failing the whole recall.
    result = await runCommand(ov, withIdentity(config, stripAdvancedSearchFlags(args)), {allowFailure: true});
  }
  if (result.exitCode !== 0) {
    console.log(`WARN recall search failed: ${result.stderr.trim() || result.stdout.trim() || 'ov search error'}`);
    return undefined;
  }
  const output = filterStaleRecallSummaryRows([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n'));
  if (output) {
    console.log(output);
  }
  return output || undefined;
}

export function stripAdvancedSearchFlags(args: readonly string[]): readonly string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--threshold' || args[index] === '--level') {
      index += 1;
      continue;
    }
    stripped.push(args[index]);
  }
  return stripped;
}

export async function runRead(config: RuntimeConfig, uri: string, options: ReadOptions): Promise<void> {
  assertVikingUri(uri);
  if (options.dryRun !== true) {
    await syncSharedReposAndLog(config);
  }
  const ov = await openVikingCliForMode(options.dryRun === true);
  const result = await maybeRun(options.dryRun === true, ov, withIdentity(config, ['read', uri]));
  if (
    result &&
    result.stdout.includes('[Directory overview is not ready]') &&
    (uri.endsWith('/.overview.md') || uri.endsWith('/.abstract.md'))
  ) {
    const parentUri = parentVikingUri(uri);
    console.log('\nThis is a generated summary placeholder. To read the underlying content, inspect leaf nodes:');
    console.log(`  threadnote list ${parentUri} --all --recursive`);
  }
}

async function syncSharedReposAndLog(config: RuntimeConfig): Promise<void> {
  try {
    const syncResult = await syncSharedReposBeforeAgentRead(config);
    if (syncResult.syncedTeams.length > 0) {
      console.error(`Auto-synced shared memories: ${syncResult.syncedTeams.join(', ')}`);
    }
    for (const warning of syncResult.warnings) {
      console.error(`Auto-sync warning: ${warning}`);
    }
  } catch (err: unknown) {
    console.error(`Auto-sync warning: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function printRecallHygieneNudges(config: RuntimeConfig, recallOutput: string): Promise<void> {
  const uris = activePersonalMemoryUrisFromText(recallOutput, config.user);
  if (uris.length === 0) {
    return;
  }
  const records = await readMemoryRecordsByUri(config, uris);
  const nudges = recallHygieneNudges(recallOutput, {records, user: config.user});
  if (nudges.length === 0) {
    return;
  }
  console.log('\nMemory hygiene hints:');
  for (const nudge of nudges) {
    console.log(`- ${nudge}`);
  }
}

export async function runCompact(config: RuntimeConfig, options: CompactOptions): Promise<void> {
  const project = normalizeOptionalMetadata(options.project);
  if (!project) {
    throw new Error('Provide --project for scoped memory hygiene.');
  }
  if (options.apply === true && options.dryRun === true) {
    throw new Error('Cannot combine --apply with --dry-run.');
  }
  const apply = options.apply === true;
  const records = await scopedCompactRecords(config, {
    kind: options.kind,
    project,
  });
  const plan = buildCompactPlan(records, {
    kind: options.kind,
    project,
    topic: normalizeOptionalMetadata(options.topic),
  });
  console.log(formatCompactPlan(plan, {apply}));
  if (!apply) {
    return;
  }

  const ov = await openVikingCliForMode(false);
  const updatePath = join(config.agentContextHome, 'compact-memory-update.txt');
  try {
    for (const action of plan.keepUpdates) {
      await writeFile(updatePath, action.content, {encoding: 'utf8', mode: 0o600});
      await chmod(updatePath, 0o600);
      await writeDurableMemoryFile(ov, config, action.uri, updatePath, 'replace');
    }
  } finally {
    await rm(updatePath, {force: true});
  }

  for (const action of plan.archives) {
    await runArchive(config, action.uri, {
      dryRun: false,
      kind: action.kind,
      project: action.project,
      topic: action.topic,
    });
  }
  for (const action of plan.forgets) {
    await runForget(config, action.uri, {dryRun: false});
  }
}

export async function runCompactDiagnostics(config: RuntimeConfig, options: CompactOptions): Promise<void> {
  const project = normalizeOptionalMetadata(options.project);
  if (!project) {
    throw new Error('Provide --project for scoped memory hygiene.');
  }
  const topic = normalizeOptionalMetadata(options.topic);
  const records = await scopedCompactRecords(config, {
    kind: options.kind,
    project,
  });
  const activeRecords = records.filter(record => record.metadata.status === 'active');
  const matchingRecords = activeRecords.filter(record => topic === undefined || topicForRecord(record) === topic);
  const counts = new Map<CompactableMemoryKind, number>();
  for (const record of matchingRecords) {
    const kind = record.metadata.kind;
    if (kind === 'durable' || kind === 'handoff' || kind === 'incident') {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  console.log(
    [
      'Scope summary:',
      `- project: ${project}`,
      `- topic: ${topic ?? '(all)'}`,
      `- kind: ${options.kind ?? '(handoff, durable, incident)'}`,
      `- stable records read: ${records.length}`,
      `- active records in project: ${activeRecords.length}`,
      `- active records matching topic: ${matchingRecords.length}`,
      `- matching by kind: ${formatKindCounts(counts)}`,
      '- skipped by design: archived memories, shared memories, preferences, smoke records, seeded resources, and non-stable timestamped/global paths',
      '',
    ].join('\n'),
  );
}

async function scopedCompactRecords(
  config: RuntimeConfig,
  options: {readonly kind?: CompactableMemoryKind; readonly project: string},
): Promise<readonly MemoryRecord[]> {
  const kinds: readonly CompactableMemoryKind[] = options.kind ? [options.kind] : ['handoff', 'durable', 'incident'];
  const records: MemoryRecord[] = [];
  for (const kind of kinds) {
    const directory = localMemoryDirectoryForCompact(config, kind, options.project);
    const uriDirectory = memoryUriDirectoryForCompact(config, kind, options.project);
    let entries;
    try {
      entries = await readdir(directory, {withFileTypes: true});
    } catch (_err: unknown) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.md')) {
        continue;
      }
      const content = await readTextIfExists(join(directory, entry.name));
      if (!content) {
        continue;
      }
      const record = parseMemoryDocument(`${uriDirectory}/${entry.name}`, content);
      if (record) {
        records.push(record);
      }
    }
  }
  return records;
}

function formatKindCounts(counts: ReadonlyMap<CompactableMemoryKind, number>): string {
  return (['handoff', 'durable', 'incident'] as const).map(kind => `${kind} ${counts.get(kind) ?? 0}`).join(', ');
}

async function readMemoryRecordsByUri(
  config: RuntimeConfig,
  uris: readonly string[],
): Promise<readonly MemoryRecord[]> {
  const records: MemoryRecord[] = [];
  for (const uri of uris) {
    const localPath = localMemoryPathForUri(config, uri);
    if (!localPath) {
      continue;
    }
    const content = await readTextIfExists(localPath);
    if (!content) {
      continue;
    }
    const record = parseMemoryDocument(uri, content);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

function localMemoryDirectoryForCompact(config: RuntimeConfig, kind: CompactableMemoryKind, project: string): string {
  const root = localUserMemoriesRoot(config);
  const projectSegment = uriSegment(project);
  switch (kind) {
    case 'durable':
      return join(root, 'durable', 'projects', projectSegment);
    case 'handoff':
      return join(root, 'handoffs', 'active', projectSegment);
    case 'incident':
      return join(root, 'incidents', 'active', projectSegment);
  }
}

function memoryUriDirectoryForCompact(config: RuntimeConfig, kind: CompactableMemoryKind, project: string): string {
  const base = `viking://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(project);
  switch (kind) {
    case 'durable':
      return `${base}/durable/projects/${projectSegment}`;
    case 'handoff':
      return `${base}/handoffs/active/${projectSegment}`;
    case 'incident':
      return `${base}/incidents/active/${projectSegment}`;
  }
}

function localMemoryPathForUri(config: RuntimeConfig, uri: string): string | undefined {
  const prefix = `viking://user/${uriSegment(config.user)}/memories/`;
  if (!uri.startsWith(prefix) || uri.includes('/shared/')) {
    return undefined;
  }
  const relative = uri.slice(prefix.length);
  if (relative.includes('..') || relative.startsWith('/')) {
    return undefined;
  }
  return join(localUserMemoriesRoot(config), ...relative.split('/'));
}

export async function runList(config: RuntimeConfig, uri: string, options: ListOptions): Promise<void> {
  assertVikingUri(uri);
  const ov = await openVikingCliForMode(options.dryRun === true);
  const args = ['ls', uri];
  if (options.all === true) {
    args.push('--all');
  }
  if (options.recursive === true) {
    args.push('--recursive');
  }
  if (options.simple === true) {
    args.push('--simple');
  }
  if (options.nodeLimit) {
    args.push('--node-limit', String(parsePositiveInteger(options.nodeLimit, 'node limit')));
  }
  await maybeRun(options.dryRun === true, ov, withIdentity(config, args));
}

export async function runHandoff(config: RuntimeConfig, options: HandoffOptions): Promise<void> {
  const {bodyText, metadata} = await buildHandoff(options);
  await storeMemory(config, {
    bodyText,
    dryRun: options.dryRun === true,
    metadata,
    replaceUri: options.replace,
    title: 'HANDOFF',
  });
}

export async function runArchive(config: RuntimeConfig, uri: string, options: ArchiveOptions): Promise<void> {
  assertVikingUri(uri);
  const ov = await openVikingCliForMode(options.dryRun === true);
  const readResult = await maybeRun(options.dryRun === true, ov, withIdentity(config, ['read', uri]));
  const original = readResult?.stdout.trim();
  if (options.dryRun === true) {
    const fallbackMetadata: MemoryMetadata = {
      archivedFrom: uri,
      kind: options.kind ?? 'handoff',
      project: normalizeOptionalMetadata(options.project),
      sourceAgentClient: 'threadnote',
      status: 'archived',
      timestamp: new Date().toISOString(),
      topic: normalizeOptionalMetadata(options.topic),
    };
    await storeMemory(config, {
      bodyText: ['Archived original Threadnote memory.', '', '<original memory content would be read here>'].join('\n'),
      dryRun: true,
      metadata: fallbackMetadata,
      title: 'MEMORY',
    });
    console.log(formatShellCommand(ov, withIdentity(config, ['rm', uri])));
    return;
  }
  if (!original) {
    throw new Error(`Could not read ${uri} before archiving.`);
  }

  const inferredMetadata = inferMemoryMetadata(original);
  const metadata: MemoryMetadata = {
    archivedFrom: uri,
    kind: options.kind ?? inferredMetadata.kind ?? 'handoff',
    project: normalizeOptionalMetadata(options.project) ?? inferredMetadata.project,
    sourceAgentClient: 'threadnote',
    status: 'archived',
    timestamp: new Date().toISOString(),
    topic: normalizeOptionalMetadata(options.topic) ?? inferredMetadata.topic,
  };
  await storeMemory(config, {
    bodyText: ['Archived original Threadnote memory.', '', original].join('\n'),
    dryRun: false,
    metadata,
    title: 'MEMORY',
  });
  const removedOriginal = await removeVikingResourceWithRetry(ov, config, uri);
  if (removedOriginal) {
    console.log(`Archived original memory: ${uri}`);
  } else {
    console.error(`Archive stored, but original memory is still processing. Retry later: threadnote forget ${uri}`);
  }
}

export async function runForget(config: RuntimeConfig, uri: string, options: ForgetOptions): Promise<void> {
  assertVikingUri(uri);
  const ov = await openVikingCliForMode(options.dryRun === true);
  if (options.dryRun === true) {
    await maybeRun(true, ov, withIdentity(config, ['rm', uri]));
    return;
  }
  const removed = await removeVikingResourceWithRetry(ov, config, uri);
  if (!removed) {
    throw new Error(`Resource is still being processed; retry later: threadnote forget ${uri}`);
  }
}

export async function runExportPack(config: RuntimeConfig, options: PackOptions): Promise<void> {
  const ov = await openVikingCliForMode(options.dryRun === true);
  const defaultPath = join(config.agentContextHome, `threadnote-${safeTimestamp()}.ovpack`);
  const outputPath = expandPath(options.path ?? defaultPath);
  await maybeRun(options.dryRun === true, ov, withIdentity(config, ['export', options.uri ?? 'viking://', outputPath]));
}

export async function runImportPack(config: RuntimeConfig, options: PackOptions): Promise<void> {
  if (!options.path) {
    throw new Error('Provide --path for import-pack.');
  }
  const ov = await openVikingCliForMode(options.dryRun === true);
  await maybeRun(
    options.dryRun === true,
    ov,
    withIdentity(config, ['import', expandPath(options.path), options.targetUri ?? 'viking://']),
  );
}

async function inferRecallUri(config: RuntimeConfig, query: string): Promise<string | undefined> {
  // Only scope the base search when the query has an explicit "skills" intent —
  // that narrowing matches user expectation ("find me a skill for X"). For
  // general project-name matches we no longer scope the base search, because
  // doing so used to exclude personal memories whenever the project name
  // appeared in the query. Seeded resources are now surfaced via a parallel
  // scoped pass in `augmentRecallWithSeededResources` so memories and seeded
  // guidance both appear.
  if (!hasAgentSkillCatalogIntent(query)) {
    return undefined;
  }
  const project = await inferProjectFromQuery(config.manifestPath, query);
  return project
    ? `viking://resources/agent-skills/repo-local-${uriSegment(project.name)}`
    : 'viking://resources/agent-skills';
}

export function hasAgentSkillCatalogIntent(query: string): boolean {
  const normalized = query.toLowerCase();
  if (!/\bskills?\b/.test(normalized)) {
    return false;
  }
  if (/\bseed[- ]skills?\b/.test(normalized) || /\bskills?\s+seed(?:ing)?\b/.test(normalized)) {
    return false;
  }
  if (/^\s*skills?\s*$/.test(normalized)) {
    return true;
  }
  return (
    /\b(find|list|show|search|recall|use|choose|select)\b.{0,48}\bskills?\b/.test(normalized) ||
    /\bskills?\b.{0,48}\b(for|to|that|which|about)\b/.test(normalized)
  );
}

async function printExactMemoryMatches(
  config: RuntimeConfig,
  ov: string,
  query: string,
  options: {readonly dryRun: boolean; readonly includeArchived: boolean; readonly project: ProjectManifest | undefined},
): Promise<string | undefined> {
  const terms = exactRecallTerms(query);
  if (terms.length === 0) {
    return undefined;
  }
  const scopes = exactMemoryScopes(config, options.includeArchived, query, options.project);
  const grepArgs = (term: string, scope: string): readonly string[] =>
    withIdentity(config, ['grep', term, '--uri', scope, '--node-limit', '5', '--output', 'json']);
  if (options.dryRun) {
    const planned = terms.flatMap(term => scopes.map(scope => formatShellCommand(ov, grepArgs(term, scope))));
    console.log('\nExact memory/resource matches:');
    console.log(planned.join('\n'));
    return planned.join('\n');
  }
  const matches = await collectExactMatches(terms, scopes, async (term, scope) => {
    const result = await runCommand(ov, grepArgs(term, scope), {allowFailure: true});
    return result.exitCode === 0 ? result.stdout : undefined;
  });
  const text = formatExactMatchPointers(matches);
  if (!text) {
    return undefined;
  }
  console.log(`\n${text}`);
  return text;
}

async function storeMemory(config: RuntimeConfig, options: StoreMemoryOptions): Promise<void> {
  if (options.replaceUri) {
    assertVikingUri(options.replaceUri);
  }
  const ov = await openVikingCliForMode(options.dryRun);
  if (options.replaceUri && isInSharedNamespace(config, options.replaceUri)) {
    await storeSharedMemoryReplacement(config, ov, options, options.replaceUri);
    return;
  }
  const memoryPath = join(config.agentContextHome, 'last-memory.txt');

  // Two-pass formatting: assume the caller's replaceUri is a true supersede,
  // compute the destination URI, then drop the supersedes line if it points
  // at the URI we are about to write to (an in-place update). Without this,
  // `--replace <self>` would bake a self-supersedes line into the body that
  // also leaks to teammates when the memory is later published.
  const candidateMetadata: MemoryMetadata = {...options.metadata, supersedes: options.replaceUri};
  const candidateMemory = formatMemoryDocument(options.title, candidateMetadata, options.bodyText);
  const memoryUri = memoryUriFor(config, candidateMemory, candidateMetadata);
  const isInPlaceUpdate = options.replaceUri !== undefined && options.replaceUri === memoryUri;
  const finalMetadata: MemoryMetadata = isInPlaceUpdate
    ? {...options.metadata, supersedes: undefined}
    : candidateMetadata;
  const memory = isInPlaceUpdate
    ? formatMemoryDocument(options.title, finalMetadata, options.bodyText)
    : candidateMemory;
  const writeMode = await memoryWriteMode(ov, config, memoryUri, finalMetadata);
  if (options.dryRun) {
    console.log(memory);
    console.log('\nWould run:');
    console.log(
      formatShellCommand(
        ov,
        withIdentity(config, [
          'write',
          memoryUri,
          '--from-file',
          memoryPath,
          '--mode',
          writeMode,
          '--wait',
          '--timeout',
          '120',
        ]),
      ),
    );
    if (options.replaceUri && !isInPlaceUpdate) {
      console.log(formatShellCommand(ov, withIdentity(config, ['rm', options.replaceUri])));
    }
    return;
  }
  await writeFile(memoryPath, memory, {encoding: 'utf8', mode: 0o600});
  await chmod(memoryPath, 0o600);
  await ensureMemoryDirectory(ov, config, memoryDirectoryUri(config, finalMetadata));
  await writeDurableMemoryFile(ov, config, memoryUri, memoryPath, writeMode);
  console.log(`Stored memory: ${memoryUri}`);
  if (options.replaceUri && !isInPlaceUpdate) {
    const removedReplacedMemory = await removeVikingResourceWithRetry(ov, config, options.replaceUri);
    if (removedReplacedMemory) {
      console.log(`Forgot replaced memory: ${options.replaceUri}`);
    } else {
      console.error(
        `Replacement stored, but the superseded memory is still processing. Retry later: threadnote forget ${options.replaceUri}`,
      );
    }
  } else if (isInPlaceUpdate) {
    console.log(`Updated existing memory in place: ${memoryUri}`);
  }
}

async function storeSharedMemoryReplacement(
  config: RuntimeConfig,
  ov: string,
  options: StoreMemoryOptions,
  targetUri: string,
): Promise<void> {
  if (options.metadata.kind !== 'durable') {
    throw new Error('Shared memory replacement only supports durable memories.');
  }
  const teamName = sharedTeamNameForUri(config, targetUri);
  if (!teamName) {
    throw new Error(`Memory ${targetUri} is not in the shared namespace.`);
  }
  const team = await resolveTeam(config, teamName);
  const inferred = sharedMemoryUriParts(config, targetUri);
  const metadata: MemoryMetadata = {
    ...options.metadata,
    project: options.metadata.project ?? inferred?.project,
    topic: options.metadata.topic ?? inferred?.topic,
  };
  const rawMemory = formatMemoryDocument(options.title, metadata, options.bodyText);
  const scrub = applyScrubber(stripPersonalProvenance(rawMemory), {redact: false});
  if (scrub.blocker) {
    throw new Error(
      `Refusing to update shared memory ${targetUri}: possible ${scrub.blocker}. Strip the sensitive value first.`,
    );
  }
  const memory = scrub.cleaned;
  const relativePath = vikingUriToWorktreeRelative(config, targetUri, team.name);

  if (options.dryRun) {
    console.log(memory);
    console.log('\nWould run:');
  }
  await ensureSharedDirectoryChain(config, ov, targetUri, options.dryRun);
  await writeMemoryFile(config, ov, targetUri, memory, 'replace', options.dryRun);

  const gitMessages = await publishShareGitChange(team.config.worktree, relativePath, `share: update ${relativePath}`, {
    dryRun: options.dryRun,
  });
  for (const message of gitMessages) {
    console.log(message);
  }

  for (const redaction of scrub.redactions) {
    console.log(`Redacted ${redaction.count}× ${redaction.name} before shared update.`);
  }
  console.log(`Updated shared memory: ${targetUri}`);
}

async function writeDurableMemoryFile(
  ov: string,
  config: RuntimeConfig,
  memoryUri: string,
  memoryPath: string,
  writeMode: 'create' | 'replace',
): Promise<void> {
  const content = await readFile(memoryPath, 'utf8');
  await writeMemoryFile(config, ov, memoryUri, content, writeMode, false);
}

async function removeVikingResourceWithRetry(ov: string, config: RuntimeConfig, uri: string): Promise<boolean> {
  const args = withIdentity(config, ['rm', uri]);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    console.log(`${attempt === 0 ? 'Running' : 'Retrying'}: ${formatShellCommand(ov, args)}`);
    const result = await runCommand(ov, args, {allowFailure: true});
    if (result.exitCode === 0) {
      if (result.stdout.trim()) {
        console.log(result.stdout.trim());
      }
      if (result.stderr.trim()) {
        console.error(result.stderr.trim());
      }
      return true;
    }
    if (isResourceBusy(result.stderr, result.stdout) && attempt === 3) {
      return false;
    }
    if (!isResourceBusy(result.stderr, result.stdout)) {
      throw new Error(`${formatShellCommand(ov, args)} failed: ${result.stderr || result.stdout}`);
    }
    await sleep(1000 * (attempt + 1));
  }
  return false;
}

async function vikingResourceExists(ov: string, config: RuntimeConfig, uri: string): Promise<boolean> {
  const stat = await runCommand(ov, withIdentity(config, ['stat', uri]), {allowFailure: true});
  return stat.exitCode === 0;
}

async function ensureDurableMemoryDirectory(ov: string, config: RuntimeConfig): Promise<void> {
  await ensureMemoryDirectory(ov, config, durableMemoryDirectoryUri(config));
}

async function ensureMemoryDirectory(ov: string, config: RuntimeConfig, directoryUri: string): Promise<void> {
  for (const uri of vikingDirectoryChain(directoryUri)) {
    const statResult = await runCommand(ov, withIdentity(config, ['stat', uri]), {allowFailure: true});
    if (statResult.exitCode === 0) {
      continue;
    }
    await maybeRun(
      false,
      ov,
      withIdentity(config, ['mkdir', uri, '--description', 'Threadnote lifecycle-aware local memories.']),
    );
  }
}

function durableMemoryDirectoryUri(config: RuntimeConfig): string {
  return `viking://user/${uriSegment(config.user)}/memories/events`;
}

function migratedDurableMemoryUri(config: RuntimeConfig, hash: string): string {
  return `${durableMemoryDirectoryUri(config)}/threadnote-migrated-${hash.slice(0, 16)}.md`;
}

export async function hasLegacyLifecycleHandoffCandidates(config: RuntimeConfig): Promise<boolean> {
  return (await legacyLifecycleHandoffCandidates(config, 1)).length > 0;
}

async function legacyLifecycleHandoffCandidates(
  config: RuntimeConfig,
  limit?: number,
): Promise<readonly LifecycleHandoffCandidate[]> {
  const eventsRoot = join(localUserMemoriesRoot(config), 'events');
  let entries;
  try {
    entries = await readdir(eventsRoot, {withFileTypes: true});
  } catch (_err: unknown) {
    return [];
  }

  const candidates: LifecycleHandoffCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.md')) {
      continue;
    }
    const sourcePath = join(eventsRoot, entry.name);
    const original = await readTextIfExists(sourcePath);
    if (!original || !isClearLegacyHandoffMemory(original) || sensitiveMemoryReason(original)) {
      continue;
    }
    const sourceUri = `${durableMemoryDirectoryUri(config)}/${entry.name}`;
    candidates.push({
      metadata: {
        archivedFrom: sourceUri,
        kind: 'handoff',
        project: inferLegacyProject(original),
        sourceAgentClient: 'threadnote',
        status: 'archived',
        timestamp: new Date().toISOString(),
      },
      original,
      sourceUri,
    });
    if (limit !== undefined && candidates.length >= limit) {
      break;
    }
  }
  return candidates;
}

function lifecycleMigrationUri(config: RuntimeConfig, metadata: MemoryMetadata, hash: string): string {
  return `${memoryDirectoryUri(config, metadata)}/legacy-${hash.slice(0, 16)}.md`;
}

function exactMemoryScopes(
  config: RuntimeConfig,
  includeArchived: boolean,
  query: string,
  project: ProjectManifest | undefined,
): readonly string[] {
  return exactMemoryScopeUris({
    agentMemoriesUri: `viking://agent/${uriSegment(config.agentId)}/memories`,
    includeArchived,
    intents: exactRecallScopeIntents(query),
    projectName: project ? uriSegment(project.name) : undefined,
    projectResourceUri: project ? trimTrailingSlash(project.uri) : undefined,
    userBase: `viking://user/${uriSegment(config.user)}/memories`,
  });
}

function memoryUriFor(config: RuntimeConfig, memory: string, metadata: MemoryMetadata): string {
  const filename = shouldUseStableMemoryUri(metadata)
    ? `${uriSegment(metadata.topic ?? 'current')}.md`
    : `threadnote-${safeTimestamp()}-${sha256(memory).slice(0, 12)}.md`;
  return `${memoryDirectoryUri(config, metadata)}/${filename}`;
}

function memoryDirectoryUri(config: RuntimeConfig, metadata: MemoryMetadata): string {
  const baseUri = `viking://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(metadata.project ?? 'general');
  switch (metadata.kind) {
    case 'preference':
      return metadata.status === 'active'
        ? `${baseUri}/preferences`
        : `${baseUri}/preferences/${uriSegment(metadata.status)}`;
    case 'handoff':
      return `${baseUri}/handoffs/${uriSegment(metadata.status)}/${projectSegment}`;
    case 'incident':
      return `${baseUri}/incidents/${uriSegment(metadata.status)}/${projectSegment}`;
    case 'smoke':
      return `${baseUri}/smoke/${uriSegment(metadata.status)}`;
    case 'durable':
      return metadata.status === 'active'
        ? `${baseUri}/durable/projects/${projectSegment}`
        : `${baseUri}/durable/${uriSegment(metadata.status)}/${projectSegment}`;
  }
}

function shouldUseStableMemoryUri(metadata: MemoryMetadata): boolean {
  return metadata.status === 'active' && metadata.topic !== undefined && metadata.kind !== 'smoke';
}

async function memoryWriteMode(
  ov: string,
  config: RuntimeConfig,
  memoryUri: string,
  metadata: MemoryMetadata,
): Promise<'create' | 'replace'> {
  if (!shouldUseStableMemoryUri(metadata)) {
    return 'create';
  }
  return (await vikingResourceExists(ov, config, memoryUri)) ? 'replace' : 'create';
}

function vikingDirectoryChain(directoryUri: string): readonly string[] {
  const prefix = 'viking://';
  if (!directoryUri.startsWith(prefix)) {
    return [directoryUri];
  }
  const parts = directoryUri.slice(prefix.length).split('/').filter(Boolean);
  const startIndex = parts[0] === 'user' && parts.length > 2 ? 3 : 1;
  const chain: string[] = [];
  for (let index = startIndex; index <= parts.length; index += 1) {
    chain.push(`${prefix}${parts.slice(0, index).join('/')}`);
  }
  return chain;
}

function formatMemoryDocument(title: 'MEMORY' | 'HANDOFF', metadata: MemoryMetadata, body: string): string {
  const header = [
    title,
    `kind: ${metadata.kind}`,
    `status: ${metadata.status}`,
    metadata.project ? `project: ${metadata.project}` : undefined,
    metadata.topic ? `topic: ${metadata.topic}` : undefined,
    `source_agent_client: ${metadata.sourceAgentClient}`,
    `timestamp: ${metadata.timestamp}`,
    metadata.supersedes ? `supersedes: ${metadata.supersedes}` : undefined,
    metadata.archivedFrom ? `archived_from: ${metadata.archivedFrom}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return [...header, '', body.trim()].join('\n');
}

function inferMemoryMetadata(memory: string): Partial<MemoryMetadata> {
  const header = memory.slice(0, Math.max(0, memory.indexOf('\n\n')) || memory.length);
  const firstLine = header.split('\n')[0]?.trim();
  const kind =
    parseOptionalMemoryKind(parseHeaderValue(header, 'kind')) ?? (firstLine === 'HANDOFF' ? 'handoff' : undefined);
  const status = parseOptionalMemoryStatus(parseHeaderValue(header, 'status'));
  const project =
    normalizeOptionalMetadata(parseHeaderValue(header, 'project')) ??
    normalizeOptionalMetadata(parseHeaderValue(header, 'repo'));
  const topic =
    normalizeOptionalMetadata(parseHeaderValue(header, 'topic')) ??
    normalizeOptionalMetadata(parseHeaderValue(header, 'task'));
  return {
    kind,
    project,
    sourceAgentClient: parseHeaderValue(header, 'source_agent_client') ?? undefined,
    status,
    topic,
  };
}

function parseHeaderValue(header: string, key: string): string | undefined {
  const prefix = `${key}:`;
  return header
    .split('\n')
    .find(line => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function isClearLegacyHandoffMemory(memory: string): boolean {
  if (/^kind:\s*/m.test(memory) || /^status:\s*/m.test(memory)) {
    return false;
  }
  const trimmed = memory.trim();
  if (trimmed.startsWith('HANDOFF\n')) {
    return true;
  }
  if (!trimmed.startsWith('MEMORY\n')) {
    return false;
  }
  return /^(?:#+\s*)?(?:final\s+)?handoff(?:\s+update)?\b/i.test(memoryBody(trimmed));
}

function memoryBody(memory: string): string {
  const separatorIndex = memory.indexOf('\n\n');
  return separatorIndex === -1 ? '' : memory.slice(separatorIndex + 2).trim();
}

function inferLegacyProject(memory: string): string {
  const explicit =
    parseHeaderValue(memory, 'project') ??
    parseHeaderValue(memory, 'repo') ??
    parseHeaderValue(memory, 'repo_path') ??
    /\brepo(?:_path)?\s+([~/A-Za-z0-9_.:/-]+)/.exec(memory)?.[1];
  if (!explicit) {
    return 'general';
  }
  const trimmed = explicit.trim().replace(/[`.,;]+$/g, '');
  return trimmed.includes('/') ? basename(trimmed) : trimmed;
}

function parseOptionalMemoryKind(value: string | undefined): MemoryKind | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return parseMemoryKind(value);
  } catch (_err: unknown) {
    return undefined;
  }
}

function parseOptionalMemoryStatus(value: string | undefined): MemoryStatus | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return parseMemoryStatus(value);
  } catch (_err: unknown) {
    return undefined;
  }
}

function normalizeOptionalMetadata(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function legacySourceAccounts(
  config: RuntimeConfig,
  options: MigrateMemoriesOptions,
): Promise<readonly string[]> {
  const explicitAccounts = options.sourceAccount?.filter(account => account.trim().length > 0) ?? [];
  if (explicitAccounts.length > 0) {
    return uniqueStrings(explicitAccounts);
  }
  if (options.allAccounts === true) {
    const accounts = await childDirectoryNames(localVikingDataRoot(config));
    return accounts.filter(account => !account.startsWith('_'));
  }
  return [config.account];
}

async function legacyMemoryCandidates(
  config: RuntimeConfig,
  sourceAccounts: readonly string[],
): Promise<readonly LegacyMemoryCandidate[]> {
  const candidates: LegacyMemoryCandidate[] = [];
  for (const sourceAccount of sourceAccounts) {
    const sessionRoot = join(localVikingDataRoot(config), sourceAccount, 'session');
    for (const sourceSession of await childDirectoryNames(sessionRoot)) {
      const historyRoot = join(sessionRoot, sourceSession, 'history');
      for (const sourceArchive of await childDirectoryNames(historyRoot)) {
        if (!sourceArchive.startsWith('archive_')) {
          continue;
        }
        const sourcePath = join(historyRoot, sourceArchive, 'messages.jsonl');
        for (const text of await legacyMemoryTexts(sourcePath)) {
          candidates.push({
            comparableHash: sha256(comparableMemoryText(text)),
            hash: sha256(text),
            sourceAccount,
            sourceArchive,
            sourceSession,
            text,
          });
        }
      }
    }
  }
  return candidates.sort((left, right) => legacySourceLabel(left).localeCompare(legacySourceLabel(right)));
}

async function legacyMemoryTexts(sourcePath: string): Promise<readonly string[]> {
  const raw = await readTextIfExists(sourcePath);
  if (!raw) {
    return [];
  }
  const memories: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmedLine);
      const text = legacyMessageText(parsed)?.trim();
      if (text && isLegacyThreadnoteMemory(text)) {
        memories.push(text);
      }
    } catch (_err: unknown) {
      continue;
    }
  }
  return memories;
}

function legacyMessageText(value: unknown): string | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  if (typeof value.content === 'string') {
    return value.content;
  }
  if (!Array.isArray(value.parts)) {
    return undefined;
  }
  const parts = value.parts
    .map(part => (isJsonObject(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : undefined))
    .filter((text): text is string => text !== undefined);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function isLegacyThreadnoteMemory(text: string): boolean {
  return text.startsWith('MEMORY\n') || text.startsWith('HANDOFF\n');
}

async function existingDurableMemoryHashes(config: RuntimeConfig): Promise<Set<string>> {
  const hashes = new Set<string>();
  await collectDurableMemoryHashes(localVikingDataRoot(config), hashes);
  return hashes;
}

async function collectDurableMemoryHashes(root: string, hashes: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, {withFileTypes: true});
  } catch (_err: unknown) {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectDurableMemoryHashes(path, hashes);
      continue;
    }
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.md') || !isDurableMemoryPath(path)) {
      continue;
    }
    const content = await readTextIfExists(path);
    if (content) {
      const trimmedContent = content.trim();
      hashes.add(sha256(trimmedContent));
      hashes.add(sha256(comparableMemoryText(trimmedContent)));
    }
  }
}

function isDurableMemoryPath(path: string): boolean {
  return path.split(sep).includes('memories');
}

async function childDirectoryNames(path: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(path, {withFileTypes: true});
  } catch (_err: unknown) {
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    const pathStat = await stat(path);
    if (!pathStat.isFile()) {
      return undefined;
    }
    return await readFile(path, 'utf8');
  } catch (_err: unknown) {
    return undefined;
  }
}

function sensitiveMemoryReason(text: string): string | undefined {
  const patterns: readonly {readonly name: string; readonly regex: RegExp}[] = [
    {name: 'private key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/},
    {name: 'API key', regex: /\bsk-[A-Za-z0-9_-]{16,}/},
    {name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9_]{16,}/},
    {name: 'bearer token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i},
    {name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/},
  ];
  return patterns.find(pattern => pattern.regex.test(text))?.name;
}

function comparableMemoryText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('MEMORY\n')) {
    return trimmed;
  }
  const separatorIndex = trimmed.indexOf('\n\n');
  return separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 2).trim();
}

function legacySourceLabel(candidate: LegacyMemoryCandidate): string {
  return `${candidate.sourceAccount}/${candidate.sourceSession}/${candidate.sourceArchive}`;
}

function localVikingDataRoot(config: RuntimeConfig): string {
  return join(config.agentContextHome, 'data', 'viking');
}

function localUserMemoriesRoot(config: RuntimeConfig): string {
  return join(localVikingDataRoot(config), config.account, 'user', uriSegment(config.user), 'memories');
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function isResourceBusy(stderr: string, stdout: string): boolean {
  const output = `${stderr}\n${stdout}`.toLowerCase();
  return output.includes('resource is busy') || output.includes('resource is being processed');
}

async function buildHandoff(
  options: HandoffOptions,
): Promise<{readonly bodyText: string; readonly metadata: MemoryMetadata}> {
  const repoRoot = (await gitValue(['rev-parse', '--show-toplevel'])) ?? getInvocationCwd();
  const branch = (await gitValue(['branch', '--show-current'], repoRoot)) ?? 'unknown';
  const status = (await gitValue(['status', '--short'], repoRoot)) ?? '';
  const diffStat = (await gitValue(['diff', '--stat', 'HEAD'], repoRoot)) ?? '';
  const touchedFiles = await gitTouchedFiles(repoRoot);
  const repoName = (await resolveRepoName(repoRoot)) ?? basename(repoRoot);
  const topicBranch = branch && branch !== 'unknown' ? branch : 'current';
  const metadata: MemoryMetadata = {
    kind: 'handoff',
    project: normalizeOptionalMetadata(options.project) ?? repoName,
    sourceAgentClient: options.sourceAgentClient ?? 'codex',
    status: 'active',
    timestamp: new Date().toISOString(),
    topic: handoffTopicForBranch(topicBranch, {timestamped: options.timestamped, topic: options.topic}),
  };
  const bodyText = [
    `repo: ${repoName}`,
    `repo_path: ${repoRoot}`,
    `branch: ${branch || 'unknown'}`,
    `task: ${options.task ?? 'unspecified'}`,
    '',
    'files_touched:',
    formatBlock(touchedFiles, '- none'),
    '',
    'git_status:',
    formatBlock(status, '- clean'),
    '',
    'diff_stat:',
    formatBlock(diffStat, '- none'),
    '',
    'tests:',
    options.tests ?? '- not recorded',
    '',
    'blockers:',
    options.blockers ?? '- none recorded',
    '',
    'next_step:',
    options.nextStep ?? '- inspect the current repo state and continue from this handoff',
  ].join('\n');
  return {bodyText, metadata};
}

async function gitTouchedFiles(cwd: string): Promise<string> {
  const changedFiles = await gitValue(['diff', '--name-only', 'HEAD'], cwd);
  const untrackedFiles = await gitValue(['ls-files', '--others', '--exclude-standard'], cwd);
  const files = new Set<string>();
  for (const value of [changedFiles, untrackedFiles]) {
    for (const line of (value ?? '').split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        files.add(trimmed);
      }
    }
  }
  return [...files].sort().join('\n');
}

function formatBlock(value: string, emptyValue: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return emptyValue;
  }
  return trimmed
    .split('\n')
    .map(line => `- ${line}`)
    .join('\n');
}
