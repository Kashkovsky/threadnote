import {chmod, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, join, sep} from 'node:path';
import yaml from 'js-yaml';
import {
  inferProjectFromQuery,
  inferWorksetFromQuery,
  readSeedManifest,
  requireWorkset,
  uriSegment,
} from './manifest.js';
import {formatRecallIndexRepairMessages, repairStaleRecallIndex} from './index_repair.js';
import {
  activePersonalMemoryUrisFromText,
  buildCompactPlan,
  type CompactableMemoryKind,
  formatCompactPlan,
  handoffTopicForBranch,
  parseMemoryDocument,
  recallHygieneNudges,
  referencedContextExcerpt,
  referencedUrisFromRecords,
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
  MigrateProjectNamesOptions,
  PackOptions,
  ProjectManifest,
  ReadOptions,
  RecallOptions,
  RememberOptions,
  ResolvedWorkset,
  RuntimeConfig,
} from './types.js';
import {
  assertVikingUri,
  buildRecallSections,
  enrichRecallQueryWithWorkspaceContext,
  enrichRecallQueryWithWorkspaceProjectContext,
  ensureDirectory,
  expandPath,
  type ExactMatch,
  exactMemoryScopeUris,
  exactRecallScopeIntents,
  exactRecallTerms,
  collectExactMatches,
  formatShellCommand,
  getInputText,
  getInvocationCwd,
  gitValue,
  isJsonObject,
  maybeRun,
  openVikingCliForMode,
  parentVikingUri,
  parsePositiveInteger,
  parseRecallHits,
  readFileIfExists,
  type RecallHit,
  RECALL_SCORE_THRESHOLD,
  resolveRepoFolderName,
  resolveRepoName,
  resolveWorkspaceRepoName,
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
  readonly references?: readonly string[];
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

interface ProjectNameMigrationContext {
  readonly newProject: string;
  readonly newSegment: string;
  readonly oldProject: string;
  readonly oldSegment: string;
  readonly repoRoot: string;
}

interface ProjectNameMigrationCandidate {
  readonly destinationContent: string;
  readonly destinationExistsWithSameContent: boolean;
  readonly destinationUri: string;
  readonly sourceUri: string;
}

interface ProjectMemoryLocation {
  readonly relativePath: readonly string[];
  readonly uriPath: string;
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

export async function runMigrateProjectNames(
  config: RuntimeConfig,
  options: MigrateProjectNamesOptions,
): Promise<void> {
  const dryRun = options.dryRun === true || options.apply !== true;
  const limit = options.limit ? parsePositiveInteger(options.limit, 'project-name migration limit') : undefined;
  const context = await projectNameMigrationContext();
  if (!context) {
    console.log('No git remote project-name change applies in the current workspace.');
    return;
  }

  const candidates = await projectNameMigrationCandidates(config, context, limit);
  const seedManifestCandidate = await hasSeedManifestProjectNameMigrationCandidate(config, context);
  if (candidates.length === 0 && !seedManifestCandidate) {
    console.log(`No project-name migration candidates found for ${context.oldProject} -> ${context.newProject}.`);
    return;
  }

  const seedManifestUpdated = await migrateSeedManifestProjectName(config, context, dryRun);
  let existingCount = 0;
  let migratedCount = 0;
  let skippedCount = 0;
  if (candidates.length > 0) {
    const ov = await openVikingCliForMode(dryRun);
    for (const candidate of candidates) {
      const action = candidate.destinationExistsWithSameContent
        ? dryRun
          ? 'Would consolidate duplicate'
          : 'Consolidating duplicate'
        : dryRun
          ? 'Would migrate'
          : 'Migrating';
      console.log(`${action} ${candidate.sourceUri} -> ${candidate.destinationUri}`);
      if (!dryRun) {
        if (candidate.destinationExistsWithSameContent) {
          existingCount += 1;
        } else {
          await ensureMemoryDirectory(ov, config, parentVikingUri(candidate.destinationUri));
          await writeMemoryFile(config, ov, candidate.destinationUri, candidate.destinationContent, 'create', false);
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
  }

  console.log(
    [
      `Project-name migration summary: ${migratedCount} memor${migratedCount === 1 ? 'y' : 'ies'} ${dryRun ? 'would be migrated' : 'migrated'} from ${context.oldProject} to ${context.newProject}`,
      seedManifestUpdated ? `seed manifest ${dryRun ? 'would be updated' : 'updated'}` : 'seed manifest unchanged',
      `${existingCount} duplicate destination(s) reused`,
      `${skippedCount} source(s) still processing`,
      dryRun ? 'Run with --apply to perform this migration.' : undefined,
      seedManifestUpdated
        ? `Run threadnote seed --only ${context.newProject} to re-ingest seeded resources under the new project URI.`
        : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join('; '),
  );
}

export async function hasProjectNameMigrationCandidates(config: RuntimeConfig): Promise<boolean> {
  const context = await projectNameMigrationContext();
  return context
    ? (await projectNameMigrationCandidates(config, context, 1)).length > 0 ||
        (await hasSeedManifestProjectNameMigrationCandidate(config, context))
    : false;
}

async function projectNameMigrationContext(): Promise<ProjectNameMigrationContext | undefined> {
  const repoRoot = await gitValue(['rev-parse', '--show-toplevel']);
  if (!repoRoot) {
    return undefined;
  }
  const newProject = await resolveRepoName(repoRoot);
  const oldProject = await resolveRepoFolderName(repoRoot);
  if (!newProject || !oldProject) {
    return undefined;
  }
  const newSegment = uriSegment(newProject);
  const oldSegment = uriSegment(oldProject);
  if (newSegment === oldSegment) {
    return undefined;
  }
  return {newProject, newSegment, oldProject, oldSegment, repoRoot};
}

async function projectNameMigrationCandidates(
  config: RuntimeConfig,
  context: ProjectNameMigrationContext,
  limit?: number,
): Promise<readonly ProjectNameMigrationCandidate[]> {
  const candidates: ProjectNameMigrationCandidate[] = [];
  for (const location of projectMemoryLocations()) {
    const sourceDirectory = join(localUserMemoriesRoot(config), ...location.relativePath, context.oldSegment);
    const sourceDirectoryUri = `viking://user/${uriSegment(config.user)}/memories/${location.uriPath}/${context.oldSegment}`;
    let entries;
    try {
      entries = await readdir(sourceDirectory, {withFileTypes: true});
    } catch (_err: unknown) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.md')) {
        continue;
      }
      const sourceUri = `${sourceDirectoryUri}/${entry.name}`;
      const content = await readTextIfExists(join(sourceDirectory, entry.name));
      if (!content) {
        continue;
      }
      const record = parseMemoryDocument(sourceUri, content);
      if (!record || !canMigrateProjectName(record, context)) {
        continue;
      }
      const metadata = {...record.metadata, project: context.newProject};
      const destinationDirectoryUri = memoryDirectoryUri(config, metadata);
      const destinationDirectory = localMemoryPathForUri(config, destinationDirectoryUri);
      if (!destinationDirectory) {
        continue;
      }
      const destinationContent = formatMemoryDocument(record.headerTitle, metadata, record.body);
      const destination = await projectNameMigrationDestination(
        destinationDirectory,
        entry.name,
        destinationContent,
        context.oldSegment,
      );
      candidates.push({
        destinationContent,
        destinationExistsWithSameContent: destination.existsWithSameContent,
        destinationUri: `${destinationDirectoryUri}/${destination.filename}`,
        sourceUri,
      });
      if (limit !== undefined && candidates.length >= limit) {
        return candidates;
      }
    }
  }
  return candidates;
}

async function hasSeedManifestProjectNameMigrationCandidate(
  config: RuntimeConfig,
  context: ProjectNameMigrationContext,
): Promise<boolean> {
  return (await seedManifestProjectNameMigration(config, context)) !== undefined;
}

async function migrateSeedManifestProjectName(
  config: RuntimeConfig,
  context: ProjectNameMigrationContext,
  dryRun: boolean,
): Promise<boolean> {
  const migration = await seedManifestProjectNameMigration(config, context);
  if (!migration) {
    return false;
  }
  if (dryRun) {
    console.log(`Would update seed manifest: ${config.manifestPath}`);
    console.log(migration.output.trimEnd());
    return true;
  }
  await ensureDirectory(dirname(config.manifestPath), false);
  const currentContent = await readFileIfExists(config.manifestPath);
  if (currentContent !== undefined) {
    const backupPath = `${config.manifestPath}.project-name-${safeTimestamp()}`;
    await writeFile(backupPath, currentContent, {encoding: 'utf8', mode: 0o600});
    await chmod(backupPath, 0o600);
    console.log(`Backup: ${backupPath}`);
  }
  await writeFile(config.manifestPath, migration.output, {encoding: 'utf8', mode: 0o600});
  await chmod(config.manifestPath, 0o600);
  console.log(`Updated seed manifest: ${config.manifestPath}`);
  return true;
}

async function seedManifestProjectNameMigration(
  config: RuntimeConfig,
  context: ProjectNameMigrationContext,
): Promise<{readonly output: string} | undefined> {
  let manifest;
  try {
    manifest = await readSeedManifest(config.manifestPath);
  } catch (_err: unknown) {
    return undefined;
  }
  const oldDefaultUri = `viking://resources/repos/${context.oldSegment}`;
  const newDefaultUri = `viking://resources/repos/${context.newSegment}`;
  const newNameExists = manifest.projects.some(project => uriSegment(project.name) === context.newSegment);
  let changed = false;
  let renamedProject = false;
  const projects = manifest.projects.map(project => {
    if (!isSeedManifestProjectNameCandidate(project, context, oldDefaultUri) || newNameExists) {
      return project;
    }
    changed = true;
    renamedProject = true;
    return {
      ...project,
      name: context.newProject,
      uri: trimTrailingSlash(project.uri) === oldDefaultUri ? newDefaultUri : project.uri,
    };
  });
  const worksets = renamedProject
    ? manifest.worksets?.map(workset => {
        const members = workset.projects.map(projectName => {
          if (uriSegment(projectName) !== context.oldSegment) {
            return projectName;
          }
          changed = true;
          return context.newProject;
        });
        return {...workset, projects: members};
      })
    : manifest.worksets;
  if (!changed) {
    return undefined;
  }
  return {
    output: `${yaml.dump(
      {
        version: manifest.version,
        projects: projects.map(project => ({
          name: project.name,
          path: project.path,
          uri: project.uri,
          seed: [...project.seed],
        })),
        ...(worksets
          ? {
              worksets: worksets.map(workset => ({
                name: workset.name,
                ...(workset.description ? {description: workset.description} : {}),
                projects: [...workset.projects],
              })),
            }
          : {}),
        ...(manifest.futureMonorepo
          ? {
              future_monorepo: {
                path_candidates: [...manifest.futureMonorepo.pathCandidates],
                uri: manifest.futureMonorepo.uri,
              },
            }
          : {}),
      },
      {lineWidth: 120, noRefs: true},
    )}`,
  };
}

function isSeedManifestProjectNameCandidate(
  project: ProjectManifest,
  context: ProjectNameMigrationContext,
  oldDefaultUri: string,
): boolean {
  if (uriSegment(project.name) !== context.oldSegment) {
    return false;
  }
  return trimTrailingSlash(project.uri) === oldDefaultUri || expandPath(project.path) === context.repoRoot;
}

function canMigrateProjectName(record: MemoryRecord, context: ProjectNameMigrationContext): boolean {
  const projectSegment = record.metadata.project ? uriSegment(record.metadata.project) : context.oldSegment;
  return projectSegment === context.oldSegment || projectSegment === context.newSegment;
}

async function projectNameMigrationDestination(
  destinationDirectory: string,
  filename: string,
  content: string,
  oldProjectSegment: string,
): Promise<{readonly existsWithSameContent: boolean; readonly filename: string}> {
  const direct = await projectNameMigrationDestinationState(destinationDirectory, filename, content);
  if (!direct.exists || direct.sameContent) {
    return {existsWithSameContent: direct.sameContent, filename};
  }
  const stem = filename.replace(/\.md$/i, '');
  const fromOldProject = `${stem}-from-${oldProjectSegment}.md`;
  const renamed = await projectNameMigrationDestinationState(destinationDirectory, fromOldProject, content);
  if (!renamed.exists || renamed.sameContent) {
    return {existsWithSameContent: renamed.sameContent, filename: fromOldProject};
  }
  return {
    existsWithSameContent: false,
    filename: `${stem}-from-${oldProjectSegment}-${sha256(content).slice(0, 12)}.md`,
  };
}

async function projectNameMigrationDestinationState(
  destinationDirectory: string,
  filename: string,
  content: string,
): Promise<{readonly exists: boolean; readonly sameContent: boolean}> {
  const existing = await readTextIfExists(join(destinationDirectory, filename));
  return {exists: existing !== undefined, sameContent: existing?.trim() === content.trim()};
}

function projectMemoryLocations(): readonly ProjectMemoryLocation[] {
  return [
    {relativePath: ['durable', 'projects'], uriPath: 'durable/projects'},
    {relativePath: ['durable', 'archived'], uriPath: 'durable/archived'},
    {relativePath: ['durable', 'superseded'], uriPath: 'durable/superseded'},
    {relativePath: ['handoffs', 'active'], uriPath: 'handoffs/active'},
    {relativePath: ['handoffs', 'archived'], uriPath: 'handoffs/archived'},
    {relativePath: ['handoffs', 'superseded'], uriPath: 'handoffs/superseded'},
    {relativePath: ['incidents', 'active'], uriPath: 'incidents/active'},
    {relativePath: ['incidents', 'archived'], uriPath: 'incidents/archived'},
    {relativePath: ['incidents', 'superseded'], uriPath: 'incidents/superseded'},
  ];
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
  const dryRun = options.dryRun === true;
  const inferredUri =
    options.uri ?? (options.inferScope === false ? undefined : await inferRecallUri(config, projectQuery));
  const project = await inferProjectFromQuery(config.manifestPath, options.project ?? projectQuery);
  const projectMemoryName = await recallProjectMemoryName(options.project, {
    includeProcessCwd: true,
  });
  const nodeLimit = options.nodeLimit ? parsePositiveInteger(options.nodeLimit, 'node limit') : undefined;
  const explicitWorkset = options.workset ? await requireWorkset(config.manifestPath, options.workset) : undefined;
  const searchArgs = (scopeUri: string | undefined): readonly string[] => [
    'search',
    query,
    '--threshold',
    options.threshold ?? RECALL_SCORE_THRESHOLD,
    '--level',
    '2',
    ...(scopeUri ? ['--uri', scopeUri] : []),
    ...(nodeLimit ? ['--node-limit', String(nodeLimit)] : []),
  ];

  // Run the global base pass plus any scoped passes, then merge into one
  // deduped ranked list so resources/memories the base already surfaced are not
  // repeated by the scoped passes (and multiple chunks of one document collapse
  // to a single entry).
  if (inferredUri) {
    console.log(`Recall scope: ${inferredUri}`);
  }
  const includeArchived = options.includeArchived === true;
  const passes: Array<readonly RecallHit[]> = [
    await recallSearchHits(config, ov, searchArgs(inferredUri), {dryRun, includeArchived}),
  ];
  const scopedRecallUris = new Set([inferredUri].filter((uri): uri is string => uri !== undefined));
  if (options.project && project) {
    const projectMemoryUri = `viking://user/${uriSegment(config.user)}/memories/durable/projects/${uriSegment(project.name)}`;
    if (!scopedRecallUris.has(projectMemoryUri)) {
      scopedRecallUris.add(projectMemoryUri);
      passes.push(await recallSearchHits(config, ov, searchArgs(projectMemoryUri), {dryRun, includeArchived}));
    }
  }
  for (const scope of projectMemoryScopeUris(config, projectMemoryName, includeArchived)) {
    if (!scopedRecallUris.has(scope)) {
      scopedRecallUris.add(scope);
      passes.push(await recallSearchHits(config, ov, searchArgs(scope), {dryRun, includeArchived}));
    }
  }
  const seededUri = project ? trimTrailingSlash(project.uri) : undefined;
  if (seededUri?.startsWith('viking://') && seededUri !== inferredUri && !options.uri && options.inferScope !== false) {
    passes.push(await recallSearchHits(config, ov, searchArgs(seededUri), {dryRun, includeArchived}));
  }

  // Workset expansion: a named set of manifest projects recalled as one working
  // set. Push a durable + seeded scope pass per member; the merge dedupes hits,
  // and the scope list is deduped/capped so overlap only costs bounded searches.
  const workset =
    !options.uri && explicitWorkset
      ? explicitWorkset
      : !options.uri && options.inferScope !== false
        ? await inferWorksetFromQuery(config.manifestPath, projectQuery)
        : undefined;
  if (workset && workset.projects.length > 0) {
    console.log(`Workset scope: ${workset.name} (${workset.projects.map(member => member.name).join(', ')})`);
    const alreadyScoped = new Set(
      [inferredUri, seededUri, ...scopedRecallUris].filter((uri): uri is string => uri !== undefined),
    );
    const worksetScopes = worksetScopeUris(config, workset)
      .filter(uri => !alreadyScoped.has(uri))
      .slice(0, MAX_WORKSET_PASSES);
    for (const scope of worksetScopes) {
      passes.push(await recallSearchHits(config, ov, searchArgs(scope), {dryRun, includeArchived}));
    }
  }

  const recallOutputs: string[] = [];
  const exactMatches = await collectExactMemoryMatches(config, ov, query, {dryRun, includeArchived, project});
  const {semanticSection, exactTail} = buildRecallSections(passes, exactMatches, nodeLimit ?? 12);
  if (semanticSection) {
    console.log(`\n${semanticSection}`);
    recallOutputs.push(semanticSection);
  }
  if (exactTail) {
    console.log(`\n${exactTail}`);
    recallOutputs.push(exactTail);
  }
  const referencedSection = await referencedContextSection(config, recallOutputs.join('\n'));
  if (referencedSection) {
    console.log(`\n${referencedSection}`);
    recallOutputs.push(referencedSection);
  }
  await printRecallHygieneNudges(config, recallOutputs.join('\n'));
}

const MAX_REFERENCED_CONTEXT = 5;
const REFERENCED_EXCERPT_LINES = 12;

/**
 * Resolves the one-way `references:` pointers carried by the personal memories
 * recall just surfaced, reading each referenced memory read-only from the local
 * store and appending a short excerpt. Bounded to one hop and a small cap;
 * missing references degrade to a labeled line and never fail recall.
 */
async function referencedContextSection(config: RuntimeConfig, recallOutput: string): Promise<string | undefined> {
  const surfacedUris = activePersonalMemoryUrisFromText(recallOutput, config.user);
  if (surfacedUris.length === 0) {
    return undefined;
  }
  const surfaced = await readMemoryRecordsByUri(config, surfacedUris);
  const referenced = referencedUrisFromRecords(surfaced, recallOutput);
  if (referenced.length === 0) {
    return undefined;
  }
  const capped = referenced.slice(0, MAX_REFERENCED_CONTEXT);
  const records = await readMemoryRecordsByUri(config, capped);
  const byUri = new Map(records.map(record => [record.uri, record]));
  const lines = ['Referenced read-only context (one-way pointers from surfaced memories):'];
  for (const uri of capped) {
    const record = byUri.get(uri);
    if (record) {
      lines.push(`- ${uri}`, referencedContextExcerpt(record.body, REFERENCED_EXCERPT_LINES));
    } else {
      lines.push(`- ${uri} [reference unavailable locally]`);
    }
  }
  if (referenced.length > capped.length) {
    lines.push(
      `- … ${referenced.length - capped.length} more referenced ${referenced.length - capped.length === 1 ? 'memory' : 'memories'} omitted`,
    );
  }
  return lines.join('\n');
}

/**
 * Run one recall search pass with `--output json` and return parsed hits.
 * Falls back to a plain search (without --threshold/--level) on a non-zero
 * exit so an older ov does not fail the whole recall. The merge in `runRecall`
 * dedupes hits across passes, so scoped passes only contribute what the base
 * pass missed.
 */
async function recallSearchHits(
  config: RuntimeConfig,
  ov: string,
  args: readonly string[],
  options: {readonly dryRun: boolean; readonly includeArchived: boolean},
): Promise<readonly RecallHit[]> {
  const jsonArgs = withIdentity(config, [...args, '--output', 'json']);
  console.log(`${options.dryRun ? 'Would run' : 'Running'}: ${formatShellCommand(ov, jsonArgs)}`);
  if (options.dryRun) {
    return [];
  }
  let result = await runCommand(ov, jsonArgs, {allowFailure: true});
  if (result.exitCode !== 0) {
    result = await runCommand(ov, withIdentity(config, [...stripAdvancedSearchFlags(args), '--output', 'json']), {
      allowFailure: true,
    });
  }
  if (result.exitCode !== 0) {
    console.log(`WARN recall search failed: ${result.stderr.trim() || result.stdout.trim() || 'ov search error'}`);
    return [];
  }
  return parseRecallHits(result.stdout, {includeArchived: options.includeArchived});
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

async function collectExactMemoryMatches(
  config: RuntimeConfig,
  ov: string,
  query: string,
  options: {readonly dryRun: boolean; readonly includeArchived: boolean; readonly project: ProjectManifest | undefined},
): Promise<readonly ExactMatch[]> {
  const terms = exactRecallTerms(query);
  if (terms.length === 0) {
    return [];
  }
  const scopes = exactMemoryScopes(config, options.includeArchived, query, options.project);
  const grepArgs = (term: string, scope: string): readonly string[] =>
    withIdentity(config, ['grep', term, '--uri', scope, '--node-limit', '5', '--output', 'json']);
  if (options.dryRun) {
    const planned = terms.flatMap(term => scopes.map(scope => formatShellCommand(ov, grepArgs(term, scope))));
    console.log('\nExact memory/resource matches:');
    console.log(planned.join('\n'));
    return [];
  }
  return collectExactMatches(terms, scopes, async (term, scope) => {
    const result = await runCommand(ov, grepArgs(term, scope), {allowFailure: true});
    return result.exitCode === 0 ? result.stdout : undefined;
  });
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

/**
 * Warn when an in-place shared replacement was asked to change the memory's
 * project — that is fixed by the storage path, so the request is ignored to keep
 * frontmatter and path consistent (the divergence the doctor check flags). The
 * caller's value is normalized via `uriSegment` to match how the path segment
 * was produced. Topic is left to the existing caller-wins behavior: it is not a
 * consistency-checked field and the path-derived topic can be a raw multi-segment
 * value (`a/b`) that must not be slugged into or persisted from here.
 */
function warnOnSharedProjectDrift(metadata: MemoryMetadata, inferred: {readonly project?: string} | undefined): void {
  if (inferred?.project && metadata.project && uriSegment(metadata.project) !== inferred.project) {
    console.log(
      `WARN keeping shared memory project "${inferred.project}" from its storage path; ignoring requested "${metadata.project}". ` +
        `To change a shared memory's project, forget it and store a new one under the new project.`,
    );
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
  // The file is updated in place at targetUri, so its frontmatter project must
  // match the path it lives under; otherwise recall's project scoping and the
  // doctor consistency check disagree with the file's real location. Prefer the
  // path's project over a differing caller value and warn — changing a shared
  // memory's project means relocating it (forget + store anew), not editing the
  // frontmatter of the file at the old path. Topic keeps caller-wins semantics.
  warnOnSharedProjectDrift(options.metadata, inferred);
  const metadata: MemoryMetadata = {
    ...options.metadata,
    project: inferred?.project ?? options.metadata.project,
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

const MAX_WORKSET_PASSES = 12;

/**
 * Durable + seeded recall scopes for every member of a workset, in member
 * order. Callers dedupe against the already-scoped passes and cap the result;
 * the recall merge dedupes any overlapping hits.
 */
function worksetScopeUris(config: RuntimeConfig, workset: ResolvedWorkset): readonly string[] {
  const scopes: string[] = [];
  for (const member of workset.projects) {
    scopes.push(`viking://user/${uriSegment(config.user)}/memories/durable/projects/${uriSegment(member.name)}`);
    const seeded = trimTrailingSlash(member.uri);
    if (seeded.startsWith('viking://')) {
      scopes.push(seeded);
    }
  }
  return [...new Set(scopes)];
}

async function recallProjectMemoryName(
  explicitProject: string | undefined,
  options: {readonly cwd?: string; readonly includeProcessCwd?: boolean},
): Promise<string | undefined> {
  return normalizeOptionalMetadata(explicitProject) ?? (await resolveWorkspaceRepoName(options));
}

function projectMemoryScopeUris(
  config: RuntimeConfig,
  projectName: string | undefined,
  includeArchived: boolean,
): readonly string[] {
  if (!projectName) {
    return [];
  }
  const base = `viking://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(projectName);
  const scopes = [
    `${base}/durable/projects/${projectSegment}`,
    `${base}/handoffs/active/${projectSegment}`,
    `${base}/incidents/active/${projectSegment}`,
  ];
  return includeArchived
    ? [
        ...scopes,
        `${base}/durable/archived/${projectSegment}`,
        `${base}/handoffs/archived/${projectSegment}`,
        `${base}/incidents/archived/${projectSegment}`,
      ]
    : scopes;
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
    ...(metadata.references ?? []).map(uri => `references: ${uri}`),
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

/**
 * Validates and dedupes caller-supplied reference URIs so a handoff can record
 * one-way, read-only pointers to other memories/sessions. Invalid URIs throw
 * (loud failure) rather than silently dropping; returns undefined when empty so
 * the `references:` header lines are omitted entirely.
 */
function normalizeReferenceUris(references: readonly string[] | undefined): readonly string[] | undefined {
  if (!references || references.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  for (const raw of references) {
    const uri = raw.trim();
    if (!uri || seen.has(uri)) {
      continue;
    }
    assertVikingUri(uri);
    seen.add(uri);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

async function buildHandoff(
  options: HandoffOptions,
): Promise<{readonly bodyText: string; readonly metadata: MemoryMetadata}> {
  const repoRoot = (await gitValue(['rev-parse', '--show-toplevel'])) ?? getInvocationCwd();
  const branch = (await gitValue(['branch', '--show-current'], repoRoot)) ?? 'unknown';
  const commit = (await gitValue(['rev-parse', 'HEAD'], repoRoot)) ?? 'unknown';
  const status = (await gitValue(['status', '--short'], repoRoot)) ?? '';
  const diffStat = (await gitValue(['diff', '--stat', 'HEAD'], repoRoot)) ?? '';
  const touchedFiles = await gitTouchedFiles(repoRoot);
  const repoName = (await resolveRepoName(repoRoot)) ?? basename(repoRoot);
  const topicBranch = branch && branch !== 'unknown' ? branch : 'current';
  const metadata: MemoryMetadata = {
    kind: 'handoff',
    project: normalizeOptionalMetadata(options.project) ?? repoName,
    references: normalizeReferenceUris(options.references),
    sourceAgentClient: options.sourceAgentClient ?? 'codex',
    status: 'active',
    timestamp: new Date().toISOString(),
    topic: handoffTopicForBranch(topicBranch, {timestamped: options.timestamped, topic: options.topic}),
  };
  // Caller-supplied review-state snapshot (pr/issue/ci). Threadnote has no
  // GitHub client, so these are captured strings paired with the exact commit,
  // never a live status board.
  const reviewState = [
    options.pr ? `pr: ${options.pr}` : undefined,
    options.issue ? `issue: ${options.issue}` : undefined,
    options.ci ? `ci: ${options.ci}` : undefined,
  ].filter((line): line is string => line !== undefined);
  const bodyText = [
    `repo: ${repoName}`,
    `repo_path: ${repoRoot}`,
    `branch: ${branch || 'unknown'}`,
    `commit: ${commit}`,
    `task: ${options.task ?? 'unspecified'}`,
    ...reviewState,
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
    ...(options.sessionId ? ['', `session_id: ${options.sessionId}`] : []),
    ...(options.trace ? ['', 'trace (auto-captured, heuristic):', options.trace] : []),
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
