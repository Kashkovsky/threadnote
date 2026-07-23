import {chmod, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, join, sep} from 'node:path';
import yaml from 'js-yaml';
import {Console, Effect, FileSystem, pipe} from 'effect';
import {maybeRunEffect} from './effect/command.js';
import {consoleOutput, syncWithConsole} from './effect/console.js';
import {fromPromiseError as attempt} from './effect/errors.js';
import {withMemoryUriLocks} from './effect/memory_lock.js';
import {removeOpenVikingResourceEffect} from './effect/openviking.js';
import {syncSharedReposBeforeAgentRead} from './effect/share.js';
import {withSharedRepositoryLock} from './effect/share_lock.js';
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
import {formatMemoryDocument, inferMemoryMetadata, memoryHeaderValue, type MemoryMetadata} from './memory_document.js';
import {prepareRecallSections} from './recall/runtime.js';
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
  resolveGitRemoteRepoName,
  resolveRepoFolderName,
  resolveRepoName,
  resolveWorkspaceRepoName,
  runCommand,
  safeTimestamp,
  sha256,
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
  vikingUriToWorktreeRelative,
  writeMemoryFile,
} from './share.js';

const LAST_MEMORY_STAGING_LOCK_URI = 'threadnote://local/last-memory-staging';

interface LegacyMemoryCandidate {
  readonly comparableHash: string;
  readonly hash: string;
  readonly sourceAccount: string;
  readonly sourceArchive: string;
  readonly sourceSession: string;
  readonly text: string;
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
  readonly sourceContent: string;
  readonly sourceUri: string;
}

interface ProjectNameMigrationProjectEvidence {
  oldProject: string;
  readonly oldSegment: string;
  readonly repoPaths: Set<string>;
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

const attemptSync = <A>(evaluate: () => A) =>
  Effect.try({try: evaluate, catch: cause => (cause instanceof Error ? cause : new Error(String(cause)))});

const requireValue = <A>(value: A | undefined, message: string): Effect.Effect<A, Error> =>
  value === undefined ? Effect.fail(new Error(message)) : Effect.succeed(value);

export const runRemember = Effect.fn('runRemember')(function* (config: RuntimeConfig, options: RememberOptions) {
  const text = yield* attempt(() => getInputText(options.text, options.stdin === true));
  if (!text.trim()) {
    yield* Effect.fail(new Error('Provide memory text with --text or --stdin.'));
  }
  const metadata: MemoryMetadata = {
    kind: options.kind ?? 'durable',
    project: normalizeOptionalMetadata(options.project),
    sourceAgentClient: options.sourceAgentClient ?? 'codex',
    status: options.status ?? 'active',
    timestamp: new Date().toISOString(),
    topic: normalizeOptionalMetadata(options.topic),
  };
  yield* storeMemory(config, {
    bodyText: text.trim(),
    dryRun: options.dryRun === true,
    metadata,
    replaceUri: options.replace,
    title: 'MEMORY',
  });
});

export const runMigrateMemories = Effect.fn('runMigrateMemories')(function* (
  config: RuntimeConfig,
  options: MigrateMemoriesOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const dryRun = options.dryRun === true;
  const limit = options.limit
    ? yield* attemptSync(() => parsePositiveInteger(options.limit!, 'migration limit'))
    : undefined;
  const sourceAccounts = yield* attempt(() => legacySourceAccounts(config, options));
  if (sourceAccounts.length === 0) {
    yield* syncWithConsole(() => consoleOutput.log('No local OpenViking accounts found to scan.'));
    return;
  }

  const candidates = yield* attempt(() => legacyMemoryCandidates(config, sourceAccounts));
  const existingHashes = yield* attempt(() => existingDurableMemoryHashes(config));
  const ov = yield* attempt(() => openVikingCliForMode(dryRun));
  const migrationPath = join(config.agentContextHome, 'legacy-memory-migration.txt');

  let duplicateCount = 0;
  let migratedCount = 0;
  let sensitiveCount = 0;
  if (!dryRun && candidates.length > 0) {
    yield* attempt(() => ensureDurableMemoryDirectory(ov, config));
  }

  const migrate = Effect.gen(function* () {
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
        yield* syncWithConsole(() =>
          consoleOutput.log(
            `SKIP ${legacySourceLabel(candidate)}: possible ${sensitiveReason}; inspect the source archive manually if needed.`,
          ),
        );
        continue;
      }
      if (limit !== undefined && migratedCount >= limit) {
        break;
      }

      const memoryUri = migratedDurableMemoryUri(config, candidate.hash);
      if (!dryRun && (yield* attempt(() => vikingResourceExists(ov, config, memoryUri)))) {
        duplicateCount += 1;
        existingHashes.add(candidate.hash);
        continue;
      }

      yield* syncWithConsole(() =>
        consoleOutput.log(`${dryRun ? 'Would migrate' : 'Migrating'} ${legacySourceLabel(candidate)} -> ${memoryUri}`),
      );
      if (!dryRun) {
        yield* fs.writeFileString(migrationPath, candidate.text, {mode: 0o600});
        yield* fs.chmod(migrationPath, 0o600);
        yield* attempt(() => writeDurableMemoryFile(ov, config, memoryUri, migrationPath, 'create'));
        existingHashes.add(candidate.hash);
      }
      migratedCount += 1;
    }
  }).pipe(Effect.ensuring(dryRun ? Effect.void : Effect.ignore(fs.remove(migrationPath, {force: true}))));

  yield* migrate;
  yield* syncWithConsole(() =>
    consoleOutput.log(
      [
        `Migration summary: ${migratedCount} ${dryRun ? 'would be migrated' : 'migrated'}`,
        `${duplicateCount} duplicate(s) skipped`,
        `${sensitiveCount} sensitive-looking item(s) skipped`,
        `${candidates.length} legacy Threadnote item(s) scanned`,
        `source account(s): ${sourceAccounts.join(', ')}`,
      ].join('; '),
    ),
  );
});

export const runMigrateLifecycle = Effect.fn('runMigrateLifecycle')(function* (
  config: RuntimeConfig,
  options: MigrateLifecycleOptions,
) {
  const dryRun = options.dryRun === true || options.apply !== true;
  const limit = options.limit ? parsePositiveInteger(options.limit, 'lifecycle migration limit') : undefined;
  const ov = yield* attempt(() => openVikingCliForMode(dryRun));
  const candidates = yield* attempt(() => legacyLifecycleHandoffCandidates(config));
  const migrationPath = join(config.agentContextHome, 'lifecycle-memory-migration.txt');
  let existingCount = 0;
  let migratedCount = 0;
  let skippedCount = 0;

  yield* Effect.gen(function* () {
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

      yield* Console.log(`${dryRun ? 'Would migrate' : 'Migrating'} ${candidate.sourceUri} -> ${destinationUri}`);
      if (!dryRun) {
        if (yield* attempt(() => vikingResourceExists(ov, config, destinationUri))) {
          existingCount += 1;
          yield* Console.log(`Archived copy already exists; cleaning up legacy source: ${candidate.sourceUri}`);
        } else {
          yield* attempt(() => writeFile(migrationPath, migratedMemory, {encoding: 'utf8', mode: 0o600}));
          yield* attempt(() => chmod(migrationPath, 0o600));
          yield* attempt(() => ensureMemoryDirectory(ov, config, memoryDirectoryUri(config, candidate.metadata)));
          yield* attempt(() => writeDurableMemoryFile(ov, config, destinationUri, migrationPath, 'create'));
        }
        const removedOriginal = yield* removeVikingResourceWithRetry(ov, config, candidate.sourceUri, {
          expectedContent: candidate.original,
        });
        if (!removedOriginal) {
          yield* Console.error(
            `Migrated copy stored, but original is still processing. Retry later: threadnote forget ${candidate.sourceUri}`,
          );
          skippedCount += 1;
        }
      }
      migratedCount += 1;
    }
  }).pipe(
    Effect.ensuring(
      dryRun ? Effect.void : attempt(() => rm(migrationPath, {force: true})).pipe(Effect.catch(() => Effect.void)),
    ),
  );

  yield* Console.log(
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
});

export const runMigrateProjectNames = Effect.fn('runMigrateProjectNames')(function* (
  config: RuntimeConfig,
  options: MigrateProjectNamesOptions,
) {
  const dryRun = options.dryRun === true || options.apply !== true;
  const limit = options.limit ? parsePositiveInteger(options.limit, 'project-name migration limit') : undefined;
  const contexts = yield* attempt(() => projectNameMigrationContexts(config));
  if (contexts.length === 0) {
    yield* Console.log('No git remote project-name changes apply across configured projects.');
    return;
  }

  const plans: Array<{
    readonly candidates: readonly ProjectNameMigrationCandidate[];
    readonly context: ProjectNameMigrationContext;
  }> = [];
  let remaining = limit;
  for (const context of contexts) {
    const candidates =
      remaining === 0 ? [] : yield* attempt(() => projectNameMigrationCandidates(config, context, remaining));
    plans.push({candidates, context});
    if (remaining !== undefined) {
      remaining = Math.max(0, remaining - candidates.length);
    }
  }
  const seedManifestMigration = yield* attempt(() => seedManifestProjectNameMigration(config, contexts));
  if (!plans.some(plan => plan.candidates.length > 0) && !seedManifestMigration) {
    yield* Console.log('No project-name migration candidates found across configured projects.');
    return;
  }

  const seedManifestUpdated = yield* attempt(() =>
    migrateSeedManifestProjectNames(config, seedManifestMigration, dryRun),
  );
  let existingCount = 0;
  let migratedCount = 0;
  let skippedCount = 0;
  const candidates = plans.flatMap(plan => [...plan.candidates]);
  if (candidates.length > 0) {
    const ov = yield* attempt(() => openVikingCliForMode(dryRun));
    for (const candidate of candidates) {
      const action = candidate.destinationExistsWithSameContent
        ? dryRun
          ? 'Would consolidate duplicate'
          : 'Consolidating duplicate'
        : dryRun
          ? 'Would migrate'
          : 'Migrating';
      yield* Console.log(`${action} ${candidate.sourceUri} -> ${candidate.destinationUri}`);
      if (!dryRun) {
        if (candidate.destinationExistsWithSameContent) {
          existingCount += 1;
        } else {
          yield* attempt(() => ensureMemoryDirectory(ov, config, parentVikingUri(candidate.destinationUri)));
          yield* attempt(() =>
            writeMemoryFile(config, ov, candidate.destinationUri, candidate.destinationContent, 'create', false),
          );
        }
        const removedOriginal = yield* removeVikingResourceWithRetry(ov, config, candidate.sourceUri, {
          expectedContent: candidate.sourceContent,
        });
        if (!removedOriginal) {
          yield* Console.error(
            `Migrated copy stored, but original is still processing. Retry later: threadnote forget ${candidate.sourceUri}`,
          );
          skippedCount += 1;
        }
      }
      migratedCount += 1;
    }
  }
  const activeContexts = projectNameMigrationActiveContexts(plans, seedManifestMigration);
  const newProjectsToSeed = [...new Set(seedManifestMigration?.newProjects ?? [])];

  yield* Console.log(
    [
      projectNameMigrationSummary(migratedCount, dryRun, activeContexts),
      seedManifestUpdated ? `seed manifest ${dryRun ? 'would be updated' : 'updated'}` : 'seed manifest unchanged',
      `${existingCount} duplicate destination(s) reused`,
      `${skippedCount} source(s) still processing`,
      dryRun ? 'Run with --apply to perform this migration.' : undefined,
      ...newProjectsToSeed.map(
        project => `Run threadnote seed --only ${project} to re-ingest seeded resources under the new project URI.`,
      ),
    ]
      .filter((part): part is string => part !== undefined)
      .join('; '),
  );
});

export async function hasProjectNameMigrationCandidates(config: RuntimeConfig): Promise<boolean> {
  const contexts = await projectNameMigrationContexts(config);
  if (contexts.length === 0) {
    return false;
  }
  for (const context of contexts) {
    if ((await projectNameMigrationCandidates(config, context, 1)).length > 0) {
      return true;
    }
  }
  return (await seedManifestProjectNameMigration(config, contexts)) !== undefined;
}

async function projectNameMigrationContexts(config: RuntimeConfig): Promise<readonly ProjectNameMigrationContext[]> {
  const evidence = await projectNameMigrationMemoryEvidence(config);
  const contexts: ProjectNameMigrationContext[] = [];
  let manifest;
  try {
    manifest = await readSeedManifest(config.manifestPath);
  } catch (_err: unknown) {
    manifest = undefined;
  }
  if (manifest) {
    for (const project of manifest.projects) {
      const projectEvidence = evidence.get(uriSegment(project.name));
      if (projectEvidence) {
        projectEvidence.repoPaths.add(expandPath(project.path));
      }
    }
  }
  for (const projectEvidence of evidence.values()) {
    for (const repoPath of projectEvidence.repoPaths) {
      const context = await projectNameMigrationContextForRepoPath(projectEvidence.oldProject, repoPath);
      if (context) {
        contexts.push(context);
      }
    }
  }
  const currentContext = await currentWorkspaceProjectNameMigrationContext(evidence);
  if (currentContext) {
    contexts.push(currentContext);
  }
  return dedupeProjectNameMigrationContexts(contexts);
}

async function projectNameMigrationMemoryEvidence(
  config: RuntimeConfig,
): Promise<Map<string, ProjectNameMigrationProjectEvidence>> {
  const evidence = new Map<string, ProjectNameMigrationProjectEvidence>();
  for (const location of projectMemoryLocations()) {
    const locationRoot = join(localUserMemoriesRoot(config), ...location.relativePath);
    let projectEntries;
    try {
      projectEntries = await readdir(locationRoot, {withFileTypes: true});
    } catch (_err: unknown) {
      continue;
    }
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory() || projectEntry.name.startsWith('.')) {
        continue;
      }
      const oldSegment = projectEntry.name;
      const projectEvidence = ensureProjectNameMigrationEvidence(evidence, oldSegment);
      const projectDirectory = join(locationRoot, projectEntry.name);
      let memoryEntries;
      try {
        memoryEntries = await readdir(projectDirectory, {withFileTypes: true});
      } catch (_err: unknown) {
        continue;
      }
      for (const memoryEntry of memoryEntries) {
        if (!memoryEntry.isFile() || memoryEntry.name.startsWith('.') || !memoryEntry.name.endsWith('.md')) {
          continue;
        }
        const content = await readTextIfExists(join(projectDirectory, memoryEntry.name));
        if (!content) {
          continue;
        }
        const sourceUri = `viking://user/${uriSegment(config.user)}/memories/${location.uriPath}/${oldSegment}/${memoryEntry.name}`;
        const record = parseMemoryDocument(sourceUri, content);
        if (record?.metadata.project && uriSegment(record.metadata.project) === oldSegment) {
          projectEvidence.oldProject = record.metadata.project;
        }
        const repoPath = repoPathEvidenceFromMemory(content);
        if (repoPath) {
          projectEvidence.repoPaths.add(repoPath);
        }
      }
    }
  }
  return evidence;
}

function ensureProjectNameMigrationEvidence(
  evidence: Map<string, ProjectNameMigrationProjectEvidence>,
  oldSegment: string,
): ProjectNameMigrationProjectEvidence {
  const existing = evidence.get(oldSegment);
  if (existing) {
    return existing;
  }
  const created: ProjectNameMigrationProjectEvidence = {oldProject: oldSegment, oldSegment, repoPaths: new Set()};
  evidence.set(oldSegment, created);
  return created;
}

function repoPathEvidenceFromMemory(content: string): string | undefined {
  const match = /^repo_path:\s*(.+)$/m.exec(content);
  if (!match?.[1]) {
    return undefined;
  }
  const cleaned = match[1]
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[.,;]+$/g, '');
  if (!cleaned.startsWith('/') && !cleaned.startsWith('~/')) {
    return undefined;
  }
  return expandPath(cleaned);
}

async function projectNameMigrationContextForRepoPath(
  oldProject: string,
  repoPath: string,
): Promise<ProjectNameMigrationContext | undefined> {
  const repoRoot = await gitValue(['rev-parse', '--show-toplevel'], repoPath);
  if (!repoRoot) {
    return undefined;
  }
  const newProject = await resolveGitRemoteRepoName(repoRoot);
  if (!newProject) {
    return undefined;
  }
  return projectNameMigrationContextFromParts({
    newProject,
    oldProject,
    repoRoot,
  });
}

async function currentWorkspaceProjectNameMigrationContext(
  evidence: Map<string, ProjectNameMigrationProjectEvidence>,
): Promise<ProjectNameMigrationContext | undefined> {
  const repoRoot = await gitValue(['rev-parse', '--show-toplevel']);
  if (!repoRoot) {
    return undefined;
  }
  const newProject = await resolveGitRemoteRepoName(repoRoot);
  const oldProject = await resolveRepoFolderName(repoRoot);
  if (!newProject || !oldProject) {
    return undefined;
  }
  const oldSegment = uriSegment(oldProject);
  if (!evidence.has(oldSegment)) {
    return undefined;
  }
  return projectNameMigrationContextFromParts({newProject, oldProject, repoRoot});
}

function projectNameMigrationContextFromParts(params: {
  readonly newProject: string;
  readonly oldProject: string;
  readonly repoRoot: string;
}): ProjectNameMigrationContext | undefined {
  const newSegment = uriSegment(params.newProject);
  const oldSegment = uriSegment(params.oldProject);
  if (newSegment === oldSegment) {
    return undefined;
  }
  return {
    newProject: params.newProject,
    newSegment,
    oldProject: params.oldProject,
    oldSegment,
    repoRoot: params.repoRoot,
  };
}

function dedupeProjectNameMigrationContexts(
  contexts: readonly ProjectNameMigrationContext[],
): readonly ProjectNameMigrationContext[] {
  const seen = new Set<string>();
  const out: ProjectNameMigrationContext[] = [];
  for (const context of contexts) {
    const key = `${context.oldSegment}\0${context.newSegment}\0${context.repoRoot}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(context);
  }
  return out;
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
        sourceContent: content,
        sourceUri,
      });
      if (limit !== undefined && candidates.length >= limit) {
        return candidates;
      }
    }
  }
  return candidates;
}

function projectNameMigrationActiveContexts(
  plans: readonly {
    readonly candidates: readonly ProjectNameMigrationCandidate[];
    readonly context: ProjectNameMigrationContext;
  }[],
  seedManifestMigration:
    | {
        readonly contexts: readonly ProjectNameMigrationContext[];
        readonly newProjects: readonly string[];
        readonly output: string;
      }
    | undefined,
): readonly ProjectNameMigrationContext[] {
  return dedupeProjectNameMigrationContexts([
    ...plans.filter(plan => plan.candidates.length > 0).map(plan => plan.context),
    ...(seedManifestMigration?.contexts ?? []),
  ]);
}

function projectNameMigrationSummary(
  migratedCount: number,
  dryRun: boolean,
  contexts: readonly ProjectNameMigrationContext[],
): string {
  const memoryWord = migratedCount === 1 ? 'memory' : 'memories';
  const verb = dryRun ? 'would be migrated' : 'migrated';
  if (contexts.length === 1) {
    const [context] = contexts;
    return `Project-name migration summary: ${migratedCount} ${memoryWord} ${verb} from ${context.oldProject} to ${context.newProject}`;
  }
  const renameSummary = contexts.map(context => `${context.oldProject} -> ${context.newProject}`).join(', ');
  return `Project-name migration summary: ${migratedCount} ${memoryWord} ${verb} across ${contexts.length} project rename(s)${renameSummary ? `: ${renameSummary}` : ''}`;
}

async function migrateSeedManifestProjectNames(
  config: RuntimeConfig,
  migration:
    | {
        readonly contexts: readonly ProjectNameMigrationContext[];
        readonly newProjects: readonly string[];
        readonly output: string;
      }
    | undefined,
  dryRun: boolean,
): Promise<boolean> {
  if (!migration) {
    return false;
  }
  if (dryRun) {
    consoleOutput.log(`Would update seed manifest: ${config.manifestPath}`);
    consoleOutput.log(migration.output.trimEnd());
    return true;
  }
  await ensureDirectory(dirname(config.manifestPath), false);
  const currentContent = await readFileIfExists(config.manifestPath);
  if (currentContent !== undefined) {
    const backupPath = `${config.manifestPath}.project-name-${safeTimestamp()}`;
    await writeFile(backupPath, currentContent, {encoding: 'utf8', mode: 0o600});
    await chmod(backupPath, 0o600);
    consoleOutput.log(`Backup: ${backupPath}`);
  }
  await writeFile(config.manifestPath, migration.output, {encoding: 'utf8', mode: 0o600});
  await chmod(config.manifestPath, 0o600);
  consoleOutput.log(`Updated seed manifest: ${config.manifestPath}`);
  return true;
}

async function seedManifestProjectNameMigration(
  config: RuntimeConfig,
  contexts: readonly ProjectNameMigrationContext[],
): Promise<
  | {
      readonly contexts: readonly ProjectNameMigrationContext[];
      readonly newProjects: readonly string[];
      readonly output: string;
    }
  | undefined
> {
  let manifest;
  try {
    manifest = await readSeedManifest(config.manifestPath);
  } catch (_err: unknown) {
    return undefined;
  }
  const renamed = new Map<string, ProjectNameMigrationContext>();
  let changed = false;
  const projects = manifest.projects.map(project => {
    const context = contexts.find(candidate =>
      isSeedManifestProjectNameCandidate(
        project,
        candidate,
        `viking://resources/repos/${candidate.oldSegment}`,
        `viking://resources/repos/${candidate.newSegment}`,
      ),
    );
    if (!context) {
      return project;
    }
    const newNameExists = manifest.projects.some(
      other => other !== project && uriSegment(other.name) === context.newSegment,
    );
    if (newNameExists || [...renamed.values()].some(existing => existing.newSegment === context.newSegment)) {
      return project;
    }
    changed = true;
    renamed.set(context.oldSegment, context);
    return {
      ...project,
      name: context.newProject,
      uri:
        trimTrailingSlash(project.uri) === `viking://resources/repos/${context.oldSegment}`
          ? `viking://resources/repos/${context.newSegment}`
          : project.uri,
    };
  });
  const worksets =
    renamed.size > 0
      ? manifest.worksets?.map(workset => {
          const members = workset.projects.map(projectName => {
            const context = renamed.get(uriSegment(projectName));
            if (!context) {
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
    contexts: [...renamed.values()],
    newProjects: [...new Set([...renamed.values()].map(context => context.newProject))],
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
  newDefaultUri: string,
): boolean {
  const nameSegment = uriSegment(project.name);
  const uriMatchesOld = trimTrailingSlash(project.uri) === oldDefaultUri;
  const pathMatchesRepo = expandPath(project.path) === context.repoRoot;
  if (nameSegment === context.newSegment && !uriMatchesOld) {
    return false;
  }
  if (nameSegment !== context.oldSegment && !uriMatchesOld && !pathMatchesRepo) {
    return false;
  }
  return nameSegment !== context.newSegment || uriMatchesOld || trimTrailingSlash(project.uri) !== newDefaultUri;
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

export const runRecall = Effect.fn('runRecall')(function* (config: RuntimeConfig, options: RecallOptions) {
  if (options.dryRun !== true) {
    yield* syncSharedReposAndLog(config);
  }
  const ov = yield* attempt(() => openVikingCliForMode(options.dryRun === true));
  const workspaceOptions = options.callerCwd
    ? {cwd: options.callerCwd, includeProcessCwd: false}
    : {includeProcessCwd: true};
  const query = yield* attempt(() => enrichRecallQueryWithWorkspaceContext(options.query, workspaceOptions));
  const projectQuery = yield* attempt(() =>
    enrichRecallQueryWithWorkspaceProjectContext(options.query, workspaceOptions),
  );
  const indexRepairMessages = yield* attempt(() =>
    repairStaleRecallIndex(config, ov, {
      dryRun: options.dryRun === true,
      query: projectQuery,
    }),
  ).pipe(
    Effect.map(indexRepair => formatRecallIndexRepairMessages(indexRepair, {dryRun: options.dryRun === true})),
    Effect.catch(error => Effect.succeed([`Auto-index repair warning: ${error.message}`])),
  );
  yield* syncWithConsole(() => {
    for (const message of indexRepairMessages) {
      consoleOutput.log(message);
    }
  });
  const dryRun = options.dryRun === true;
  const inferredUri =
    options.uri ??
    (options.inferScope === false ? undefined : yield* attempt(() => inferRecallUri(config, projectQuery)));
  const project = yield* attempt(() => inferProjectFromQuery(config.manifestPath, options.project ?? projectQuery));
  const projectMemoryName = yield* attempt(() => recallProjectMemoryName(options.project, workspaceOptions));
  const nodeLimit = options.nodeLimit
    ? yield* attemptSync(() => parsePositiveInteger(options.nodeLimit!, 'node limit'))
    : undefined;
  const explicitWorkset = options.workset
    ? yield* attempt(() => requireWorkset(config.manifestPath, options.workset!))
    : undefined;
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
    yield* syncWithConsole(() => consoleOutput.log(`Recall scope: ${inferredUri}`));
  }
  const includeArchived = options.includeArchived === true;
  const passes: Array<readonly RecallHit[]> = [
    yield* attempt(() => recallSearchHits(config, ov, searchArgs(inferredUri), {dryRun, includeArchived})),
  ];
  const scopedRecallUris = new Set([inferredUri].filter((uri): uri is string => uri !== undefined));
  if (options.project && project) {
    const projectMemoryUri = `viking://user/${uriSegment(config.user)}/memories/durable/projects/${uriSegment(project.name)}`;
    if (!scopedRecallUris.has(projectMemoryUri)) {
      scopedRecallUris.add(projectMemoryUri);
      passes.push(
        yield* attempt(() => recallSearchHits(config, ov, searchArgs(projectMemoryUri), {dryRun, includeArchived})),
      );
    }
  }
  for (const scope of projectMemoryScopeUris(config, projectMemoryName, includeArchived)) {
    if (!scopedRecallUris.has(scope)) {
      scopedRecallUris.add(scope);
      passes.push(yield* attempt(() => recallSearchHits(config, ov, searchArgs(scope), {dryRun, includeArchived})));
    }
  }
  const seededUri = project ? trimTrailingSlash(project.uri) : undefined;
  if (seededUri?.startsWith('viking://') && seededUri !== inferredUri && !options.uri && options.inferScope !== false) {
    passes.push(yield* attempt(() => recallSearchHits(config, ov, searchArgs(seededUri), {dryRun, includeArchived})));
  }

  // Workset expansion: a named set of manifest projects recalled as one working
  // set. Push a durable + seeded scope pass per member; the merge dedupes hits,
  // and the scope list is deduped/capped so overlap only costs bounded searches.
  const workset =
    !options.uri && explicitWorkset
      ? explicitWorkset
      : !options.uri && options.inferScope !== false
        ? yield* attempt(() => inferWorksetFromQuery(config.manifestPath, projectQuery))
        : undefined;
  if (workset && workset.projects.length > 0) {
    yield* syncWithConsole(() =>
      consoleOutput.log(`Workset scope: ${workset.name} (${workset.projects.map(member => member.name).join(', ')})`),
    );
    const alreadyScoped = new Set(
      [inferredUri, seededUri, ...scopedRecallUris].filter((uri): uri is string => uri !== undefined),
    );
    const worksetScopes = worksetScopeUris(config, workset)
      .filter(uri => !alreadyScoped.has(uri))
      .slice(0, MAX_WORKSET_PASSES);
    for (const scope of worksetScopes) {
      passes.push(yield* attempt(() => recallSearchHits(config, ov, searchArgs(scope), {dryRun, includeArchived})));
    }
  }

  const exactMatches = yield* attempt(() =>
    collectExactMemoryMatches(config, ov, query, {dryRun, includeArchived, project}),
  );
  const {semanticSection, exactTail} = yield* prepareRecallSections(config, {
    allowExactRescue: options.threshold === undefined,
    allowedUriScopes: options.uri ? [options.uri] : undefined,
    exactMatches,
    feedbackQuery: options.query,
    includeInactive: includeArchived,
    limit: nodeLimit ?? 12,
    minimumScore: Number(options.threshold ?? RECALL_SCORE_THRESHOLD),
    passes,
    project: projectMemoryName ?? project?.name,
    query,
    readRecords: uris => attempt(() => readMemoryRecordsByUri(config, uris)),
    seedUris: [inferredUri, seededUri].filter((uri): uri is string => uri !== undefined),
  });
  if (semanticSection) {
    yield* syncWithConsole(() => consoleOutput.log(`\n${semanticSection}`));
  }
  if (exactTail) {
    yield* syncWithConsole(() => consoleOutput.log(`\n${exactTail}`));
  }
  const referencedSection = yield* attempt(() => referencedContextSection(config, semanticSection ?? ''));
  if (referencedSection) {
    yield* syncWithConsole(() => consoleOutput.log(`\n${referencedSection}`));
  }
  yield* attempt(() => printRecallHygieneNudges(config, semanticSection ?? ''));
});

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
  if (options.dryRun) {
    consoleOutput.log(`Would run: ${formatShellCommand(ov, jsonArgs)}`);
    return [];
  }
  let result = await runCommand(ov, jsonArgs, {allowFailure: true});
  if (result.exitCode !== 0) {
    result = await runCommand(ov, withIdentity(config, [...stripAdvancedSearchFlags(args), '--output', 'json']), {
      allowFailure: true,
    });
  }
  if (result.exitCode !== 0) {
    consoleOutput.log(
      `WARN recall search failed: ${result.stderr.trim() || result.stdout.trim() || 'ov search error'}`,
    );
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

export const runRead = Effect.fn('runRead')(function* (config: RuntimeConfig, uri: string, options: ReadOptions) {
  yield* attemptSync(() => assertVikingUri(uri));
  if (options.dryRun !== true) {
    yield* syncSharedReposAndLog(config);
  }
  const ov = yield* attempt(() => openVikingCliForMode(options.dryRun === true));
  const result = yield* maybeRunEffect(options.dryRun === true, ov, withIdentity(config, ['read', uri]));
  if (
    result &&
    result.stdout.includes('[Directory overview is not ready]') &&
    (uri.endsWith('/.overview.md') || uri.endsWith('/.abstract.md'))
  ) {
    const parentUri = parentVikingUri(uri);
    yield* syncWithConsole(() => {
      consoleOutput.log(
        '\nThis is a generated summary placeholder. To read the underlying content, inspect leaf nodes:',
      );
      consoleOutput.log(`  threadnote list ${parentUri} --all --recursive`);
    });
  }
});

const syncSharedReposAndLog = Effect.fn('memory.syncSharedReposAndLog')(function* (config: RuntimeConfig) {
  const syncResult = yield* syncSharedReposBeforeAgentRead(config).pipe(
    Effect.catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      return syncWithConsole(() => consoleOutput.error(`Auto-sync warning: ${message}`)).pipe(Effect.as(undefined));
    }),
  );
  if (!syncResult) {
    return;
  }
  yield* syncWithConsole(() => {
    if (syncResult.syncedTeams.length > 0) {
      consoleOutput.error(`Auto-synced shared memories: ${syncResult.syncedTeams.join(', ')}`);
    }
    for (const warning of syncResult.warnings) {
      consoleOutput.error(`Auto-sync warning: ${warning}`);
    }
  });
});

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
  consoleOutput.log('\nMemory hygiene hints:');
  for (const nudge of nudges) {
    consoleOutput.log(`- ${nudge}`);
  }
}

export const runCompact = Effect.fn('runCompact')(function* (config: RuntimeConfig, options: CompactOptions) {
  const project = yield* requireValue(
    normalizeOptionalMetadata(options.project),
    'Provide --project for scoped memory hygiene.',
  );
  if (options.apply === true && options.dryRun === true) {
    yield* Effect.fail(new Error('Cannot combine --apply with --dry-run.'));
  }
  const apply = options.apply === true;
  const records = yield* attempt(() =>
    scopedCompactRecords(config, {
      kind: options.kind,
      project,
    }),
  );
  const plan = buildCompactPlan(records, {
    kind: options.kind,
    project,
    topic: normalizeOptionalMetadata(options.topic),
  });
  yield* Console.log(formatCompactPlan(plan, {apply}));
  if (!apply) {
    return;
  }

  const ov = yield* attempt(() => openVikingCliForMode(false));
  const updatePath = join(config.agentContextHome, 'compact-memory-update.txt');
  yield* Effect.gen(function* () {
    for (const action of plan.keepUpdates) {
      yield* attempt(() => writeFile(updatePath, action.content, {encoding: 'utf8', mode: 0o600}));
      yield* attempt(() => chmod(updatePath, 0o600));
      yield* attempt(() => writeDurableMemoryFile(ov, config, action.uri, updatePath, 'replace'));
    }
  }).pipe(Effect.ensuring(attempt(() => rm(updatePath, {force: true})).pipe(Effect.catch(() => Effect.void))));

  for (const action of plan.archives) {
    yield* runArchive(config, action.uri, {
      dryRun: false,
      kind: action.kind,
      project: action.project,
      topic: action.topic,
    });
  }
  for (const action of plan.forgets) {
    yield* runForget(config, action.uri, {dryRun: false});
  }
});

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
  consoleOutput.log(
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
  if (!uri.startsWith(prefix)) {
    return undefined;
  }
  const relative = uri.slice(prefix.length);
  if (relative.includes('..') || relative.startsWith('/')) {
    return undefined;
  }
  return join(localUserMemoriesRoot(config), ...relative.split('/'));
}

export const runList = Effect.fn('runList')(function* (config: RuntimeConfig, uri: string, options: ListOptions) {
  yield* attemptSync(() => assertVikingUri(uri));
  const ov = yield* attempt(() => openVikingCliForMode(options.dryRun === true));
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
    const nodeLimit = yield* attemptSync(() => parsePositiveInteger(options.nodeLimit!, 'node limit'));
    args.push('--node-limit', String(nodeLimit));
  }
  yield* maybeRunEffect(options.dryRun === true, ov, withIdentity(config, args));
});

export const runHandoff = Effect.fn('runHandoff')(function* (config: RuntimeConfig, options: HandoffOptions) {
  const {bodyText, metadata} = yield* attempt(() => buildHandoff(options));
  yield* storeMemory(config, {
    bodyText,
    dryRun: options.dryRun === true,
    metadata,
    replaceUri: options.replace,
    title: 'HANDOFF',
  });
});

export const runArchive = Effect.fn('runArchive')(function* (
  config: RuntimeConfig,
  uri: string,
  options: ArchiveOptions,
) {
  yield* attemptSync(() => assertVikingUri(uri));
  const ov = yield* attempt(() => openVikingCliForMode(options.dryRun === true));
  const readResult = yield* attempt(() => maybeRun(options.dryRun === true, ov, withIdentity(config, ['read', uri])));
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
    yield* storeMemory(config, {
      bodyText: ['Archived original Threadnote memory.', '', '<original memory content would be read here>'].join('\n'),
      dryRun: true,
      metadata: fallbackMetadata,
      title: 'MEMORY',
    });
    yield* Console.log(formatShellCommand(ov, withIdentity(config, ['rm', uri])));
    return;
  }
  const originalMemory = yield* requireValue(original, `Could not read ${uri} before archiving.`);
  const originalLocalPath = localMemoryPathForUri(config, uri);
  const originalLocalContent = originalLocalPath
    ? yield* attempt(() => readFileIfExists(originalLocalPath))
    : undefined;

  const inferredMetadata = inferMemoryMetadata(originalMemory);
  const metadata: MemoryMetadata = {
    archivedFrom: uri,
    kind: options.kind ?? inferredMetadata.kind ?? 'handoff',
    project: normalizeOptionalMetadata(options.project) ?? inferredMetadata.project,
    sourceAgentClient: 'threadnote',
    status: 'archived',
    timestamp: new Date().toISOString(),
    topic: normalizeOptionalMetadata(options.topic) ?? inferredMetadata.topic,
  };
  yield* storeMemory(config, {
    bodyText: ['Archived original Threadnote memory.', '', originalMemory].join('\n'),
    dryRun: false,
    metadata,
    title: 'MEMORY',
  });
  const removedOriginal = yield* removeVikingResourceWithRetry(ov, config, uri, {
    expectedContent: originalLocalContent ?? originalMemory,
  });
  if (removedOriginal) {
    yield* Console.log(`Archived original memory: ${uri}`);
  } else {
    yield* Console.error(
      `Archive stored, but original memory is still processing. Retry later: threadnote forget ${uri}`,
    );
  }
});

export const runForget = Effect.fn('runForget')(function* (config: RuntimeConfig, uri: string, options: ForgetOptions) {
  yield* attemptSync(() => assertVikingUri(uri));
  const ov = yield* attempt(() => openVikingCliForMode(options.dryRun === true));
  if (options.dryRun === true) {
    yield* attempt(() => maybeRun(true, ov, withIdentity(config, ['rm', uri])));
    return;
  }
  const removed = yield* removeVikingResourceWithRetry(ov, config, uri);
  if (!removed) {
    yield* Effect.fail(new Error(`Resource is still being processed; retry later: threadnote forget ${uri}`));
  }
});

export const runExportPack = Effect.fn('runExportPack')(function* (config: RuntimeConfig, options: PackOptions) {
  const ov = yield* attempt(() => openVikingCliForMode(options.dryRun === true));
  const defaultPath = join(config.agentContextHome, `threadnote-${safeTimestamp()}.ovpack`);
  const outputPath = expandPath(options.path ?? defaultPath);
  const sourceUri = options.uri ?? `viking://user/${uriSegment(config.user)}/memories`;
  yield* maybeRunEffect(options.dryRun === true, ov, withIdentity(config, ['export', sourceUri, outputPath]));
});

export const runImportPack = Effect.fn('runImportPack')(function* (config: RuntimeConfig, options: PackOptions) {
  if (!options.path) {
    yield* Effect.fail(new Error('Provide --path for import-pack.'));
  }
  const ov = yield* attempt(() => openVikingCliForMode(options.dryRun === true));
  const targetUri = options.targetUri ?? `viking://user/${uriSegment(config.user)}`;
  yield* maybeRunEffect(
    options.dryRun === true,
    ov,
    withIdentity(config, ['import', expandPath(options.path!), targetUri]),
  );
});

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
    consoleOutput.log('\nExact memory/resource matches:');
    consoleOutput.log(planned.join('\n'));
    return [];
  }
  return collectExactMatches(terms, scopes, async (term, scope) => {
    const result = await runCommand(ov, grepArgs(term, scope), {allowFailure: true});
    return result.exitCode === 0 ? result.stdout : undefined;
  });
}

const storeMemory = Effect.fn('storeMemory')(function* (config: RuntimeConfig, options: StoreMemoryOptions) {
  if (options.replaceUri) {
    yield* attemptSync(() => assertVikingUri(options.replaceUri as string));
  }
  const ov = yield* attempt(() => openVikingCliForMode(options.dryRun));
  if (options.replaceUri && isInSharedNamespace(config, options.replaceUri)) {
    if (options.dryRun) {
      yield* attempt(() => storeSharedMemoryReplacement(config, ov, options, options.replaceUri as string));
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    yield* withSharedRepositoryLock(
      config,
      withMemoryUriLocks(
        fs,
        config.agentContextHome,
        [options.replaceUri],
        attempt(() => storeSharedMemoryReplacement(config, ov, options, options.replaceUri as string)),
      ),
    );
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
  if (options.dryRun) {
    const writeMode = yield* attempt(() => memoryWriteMode(ov, config, memoryUri, finalMetadata));
    yield* Console.log(memory);
    yield* Console.log('\nWould run:');
    yield* Console.log(
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
      yield* Console.log(formatShellCommand(ov, withIdentity(config, ['rm', options.replaceUri])));
    }
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [LAST_MEMORY_STAGING_LOCK_URI, options.replaceUri, memoryUri],
    Effect.gen(function* () {
      const writeMode = yield* attempt(() => memoryWriteMode(ov, config, memoryUri, finalMetadata));
      yield* attempt(() => writeFile(memoryPath, memory, {encoding: 'utf8', mode: 0o600}));
      yield* attempt(() => chmod(memoryPath, 0o600));
      yield* attempt(() => ensureMemoryDirectory(ov, config, memoryDirectoryUri(config, finalMetadata)));
      yield* attempt(() => writeDurableMemoryFile(ov, config, memoryUri, memoryPath, writeMode));
      yield* Console.log(`Stored memory: ${memoryUri}`);
      if (options.replaceUri && !isInPlaceUpdate) {
        const removedReplacedMemory = yield* removeVikingResourceWithRetry(ov, config, options.replaceUri, {
          alreadyLocked: true,
        });
        if (removedReplacedMemory) {
          yield* Console.log(`Forgot replaced memory: ${options.replaceUri}`);
        } else {
          yield* Console.error(
            `Replacement stored, but the superseded memory is still processing. Retry later: threadnote forget ${options.replaceUri}`,
          );
        }
      } else if (isInPlaceUpdate) {
        yield* Console.log(`Updated existing memory in place: ${memoryUri}`);
      }
    }),
  );
});

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
    consoleOutput.log(
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
    consoleOutput.log(memory);
    consoleOutput.log('\nWould run:');
  }
  await ensureSharedDirectoryChain(config, ov, targetUri, options.dryRun);
  await writeMemoryFile(config, ov, targetUri, memory, 'replace', options.dryRun);

  const gitMessages = await publishShareGitChange(team.config.worktree, relativePath, `share: update ${relativePath}`, {
    dryRun: options.dryRun,
  });
  for (const message of gitMessages) {
    consoleOutput.log(message);
  }

  for (const redaction of scrub.redactions) {
    consoleOutput.log(`Redacted ${redaction.count}× ${redaction.name} before shared update.`);
  }
  consoleOutput.log(`Updated shared memory: ${targetUri}`);
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

function removeVikingResourceWithRetry(
  ov: string,
  config: RuntimeConfig,
  uri: string,
  options: {readonly alreadyLocked?: boolean; readonly expectedContent?: string} = {},
) {
  const args = withIdentity(config, ['rm', uri]);
  const remove = Console.consoleWith(output =>
    pipe(
      removeOpenVikingResourceEffect(ov, args, {
        isBusy: isResourceBusy,
        onAttempt: attempt => output.log(`${attempt === 0 ? 'Running' : 'Retrying'}: ${formatShellCommand(ov, args)}`),
      }),
      Effect.map(result => {
        if (!result) return false;
        if (result.stdout.trim()) output.log(result.stdout.trim());
        if (result.stderr.trim()) output.error(result.stderr.trim());
        return true;
      }),
    ),
  );
  if (options.alreadyLocked) {
    return remove;
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [uri],
      Effect.gen(function* () {
        if (options.expectedContent !== undefined) {
          const localPath = localMemoryPathForUri(config, uri);
          const currentContent = localPath ? yield* attempt(() => readFileIfExists(localPath)) : undefined;
          if (currentContent === undefined || currentContent.trim() !== options.expectedContent.trim()) {
            return yield* Effect.fail(
              new Error(`Memory changed before removal; review the current content and retry: ${uri}`),
            );
          }
        }
        return yield* remove;
      }),
    );
  });
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
    memoryHeaderValue(memory, 'project') ??
    memoryHeaderValue(memory, 'repo') ??
    memoryHeaderValue(memory, 'repo_path') ??
    /\brepo(?:_path)?\s+([~/A-Za-z0-9_.:/-]+)/.exec(memory)?.[1];
  if (!explicit) {
    return 'general';
  }
  const trimmed = explicit.trim().replace(/[`.,;]+$/g, '');
  return trimmed.includes('/') ? basename(trimmed) : trimmed;
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
