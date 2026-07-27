import yaml from 'js-yaml';
import {Clock, Console, Crypto, Effect, FileSystem, Path, Result} from 'effect';
import {
  expandWeakRecallQueryEffect,
  limitRecallRewritesForConfidence,
  mergeRecallRewritesForConfidence,
  recallHybridMinimumScore,
  recallRewriteLimitForConfidence,
  selectExpandedRecallCandidatesEffect,
  shouldExpandRecall,
} from './effect/ai/recall.js';
import {resolveEffectAiConfiguration} from './effect/ai/consolidator.js';
import {
  enrichMemoryMetadataWithConfiguredLocalAi,
  enrichMemoryWithInstalledLocalAi,
  isUnusableMemoryEnrichmentOutput,
} from './effect/ai/enrichment.js';
import {withMemoryUriLocks} from './effect/memory_lock.js';
import {scanFilesWithinBoundary} from './effect/safe_scan.js';
import {syncSharedReposBeforeAgentRead} from './effect/share.js';
import {withSharedRepositoryLock} from './effect/share_lock.js';
import {SystemInfo} from './effect/system.js';
import {ResourceStore, type ResourceStoreMutation} from './effect/resource-store.js';
import {runModelInstall, runModelSelect} from './models/commands.js';
import {resolveSelectedLocalModel} from './models/inference.js';
import {syncObsidianSourcesBeforeRecall} from './obsidian_source.js';
import {canonicalResourceUri, parseResourceId, resourceIdWithoutAnchor} from './storage/resource-id.js';
import {
  inferProjectFromQuery,
  inferWorksetFromQuery,
  readSeedManifest,
  requireWorkset,
  uriSegment,
} from './manifest.js';
import {
  activePersonalMemoryUrisFromText,
  buildCompactPlan,
  type CompactableMemoryKind,
  formatCompactPlan,
  formatReferencedContextPointers,
  handoffTopicForBranch,
  parseMemoryDocument,
  recallHygieneNudges,
  referencedUrisFromRecords,
  topicForRecord,
  type MemoryRecord,
} from './memory_hygiene.js';
import {
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  formatMemoryDocumentWithKeywords,
  inferMemoryMetadata,
  memoryHeaderValue,
  type MemoryMetadata,
} from './memory_document.js';
import {
  buildRecallIndexSelectionCandidates,
  buildRecallSelectionCandidates,
  createRecallRerankerCache,
  loadRecallExpansionVocabulary,
  loadRecallSemanticScores,
  prepareRecallSections,
  recallSelectionQueries,
  recallSelectionAnchorIds,
  selectedRecallCandidateUris,
} from './recall/runtime.js';
import type {
  ArchiveOptions,
  CompactOptions,
  EnrichMemoriesOptions,
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
  assertResourceUri,
  enrichRecallQueryWithWorkspaceContext,
  enrichRecallQueryWithWorkspaceProjectContext,
  ensureDirectory,
  errorMessage,
  exactMemoryScopeUris,
  exactRecallScopeIntents,
  exactRecallTerms,
  expandPath,
  getInputText,
  getInvocationCwd,
  gitValue,
  isJsonObject,
  parentResourceUri,
  parsePositiveInteger,
  readFileIfExists,
  type RecallHit,
  recallScoreThreshold,
  resolveGitRemoteRepoName,
  resolveRepoFolderName,
  resolveRepoName,
  resolveWorkspaceRepoName,
  safeTimestamp,
  sha256,
  trimTrailingSlash,
} from './utils.js';
import {
  applyScrubber,
  assertSharedWorktreeFileReady,
  ensureSharedDirectoryChain,
  isInSharedNamespace,
  publishShareGitChange,
  readTeamsFile,
  resolveTeam,
  sharedMemoryUriParts,
  sharedTeamNameForUri,
  stripPersonalProvenance,
  resourceUriToWorktreeRelative,
  writeMemoryFile,
  writeSharedWorktreeFile,
} from './share.js';

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

interface MemoryEnrichmentCandidate {
  readonly path: string;
  readonly priority: number;
  readonly uri: string;
}

interface MemoryEnrichmentPlan {
  readonly alreadyEnriched: number;
  readonly candidates: readonly MemoryEnrichmentCandidate[];
  readonly invalid: number;
  readonly personalScanned: number;
  readonly sharedScanned: number;
  readonly skippedKinds: number;
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

const NATIVE_RESOURCE_BACKEND = 'threadnote-native';

export const runRemember = Effect.fn('runRemember')(function* (config: RuntimeConfig, options: RememberOptions) {
  const text = yield* getInputText(options.text, options.stdin === true);
  if (!text.trim()) {
    yield* Effect.fail(new Error('Provide memory text with --text or --stdin.'));
  }
  const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString();
  const [replaced] = options.replace ? yield* readMemoryRecordsByUri(config, [options.replace]) : [];
  const crypto = yield* Crypto.Crypto;
  // Projection computes source_hash from canonical content. Keeping the
  // high-entropy digest out of Threadnote's indexed memory preserves semantic
  // retrieval quality while the stable identity and lifecycle fields remain
  // part of the authoritative record.
  const baseMetadata: MemoryMetadata = {
    createdAt: replaced?.metadata.createdAt ?? replaced?.metadata.timestamp ?? timestamp,
    kind: options.kind ?? 'durable',
    memoryId: replaced?.metadata.memoryId ?? `tn_${(yield* crypto.randomUUIDv4).replaceAll('-', '')}`,
    project: normalizeOptionalMetadata(options.project),
    schemaVersion: 3,
    sourceAgentClient: options.sourceAgentClient ?? 'codex',
    status: options.status ?? 'active',
    timestamp,
    topic: normalizeOptionalMetadata(options.topic),
    updatedAt: timestamp,
    visibility: options.replace && isInSharedNamespace(config, options.replace) ? 'shared' : 'personal',
  };
  const metadata =
    options.dryRun === true || (options.replace !== undefined && isInSharedNamespace(config, options.replace))
      ? baseMetadata
      : yield* enrichMemoryMetadataWithConfiguredLocalAi(config, baseMetadata, text.trim()).pipe(
          Effect.catch(error =>
            Console.log(
              `Local AI memory enrichment skipped: ${error instanceof Error ? error.message : String(error)}`,
            ).pipe(Effect.as(baseMetadata)),
          ),
        );
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
  const path = yield* Path.Path;
  const dryRun = options.dryRun === true;
  const limit = options.limit
    ? yield* attemptSync(() => parsePositiveInteger(options.limit!, 'migration limit'))
    : undefined;
  const sourceAccounts = yield* legacySourceAccounts(config, options);
  if (sourceAccounts.length === 0) {
    yield* Console.log('No local canonical accounts found to scan.');
    return;
  }

  const candidates = yield* legacyMemoryCandidates(config, sourceAccounts);
  const existingHashes = yield* existingDurableMemoryHashes(config);
  const ov = NATIVE_RESOURCE_BACKEND;
  const migrationPath = path.join(config.agentContextHome, 'legacy-memory-migration.txt');

  let duplicateCount = 0;
  let migratedCount = 0;
  let sensitiveCount = 0;
  if (!dryRun && candidates.length > 0) {
    yield* ensureDurableMemoryDirectory(ov, config);
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
        yield* Console.log(
          `SKIP ${legacySourceLabel(candidate)}: possible ${sensitiveReason}; inspect the source archive manually if needed.`,
        );
        continue;
      }
      if (limit !== undefined && migratedCount >= limit) {
        break;
      }

      const memoryUri = migratedDurableMemoryUri(config, candidate.hash);
      if (!dryRun && (yield* resourceExists(ov, config, memoryUri))) {
        duplicateCount += 1;
        existingHashes.add(candidate.hash);
        continue;
      }

      yield* Console.log(`${dryRun ? 'Would migrate' : 'Migrating'} ${legacySourceLabel(candidate)} -> ${memoryUri}`);
      if (!dryRun) {
        yield* fs.writeFileString(migrationPath, candidate.text, {mode: 0o600});
        yield* fs.chmod(migrationPath, 0o600);
        yield* writeDurableMemoryFile(ov, config, memoryUri, migrationPath, 'create');
        existingHashes.add(candidate.hash);
      }
      migratedCount += 1;
    }
  }).pipe(Effect.ensuring(dryRun ? Effect.void : Effect.ignore(fs.remove(migrationPath, {force: true}))));

  yield* migrate;
  yield* Console.log(
    [
      `Migration summary: ${migratedCount} ${dryRun ? 'would be migrated' : 'migrated'}`,
      `${duplicateCount} duplicate(s) skipped`,
      `${sensitiveCount} sensitive-looking item(s) skipped`,
      `${candidates.length} legacy Threadnote item(s) scanned`,
      `source account(s): ${sourceAccounts.join(', ')}`,
    ].join('; '),
  );
});

export const runEnrichMemories = Effect.fn('runEnrichMemories')(function* (
  config: RuntimeConfig,
  options: EnrichMemoriesOptions,
) {
  const dryRun = options.dryRun === true || options.apply !== true;
  const limit = options.limit ? parsePositiveInteger(options.limit, 'memory enrichment limit') : undefined;
  yield* Console.log('Scanning personal and shared memories for enrichment eligibility...');
  const plan = yield* withSharedRepositoryLock(config, memoryEnrichmentPlan(config, options.force === true));
  const candidates = limit === undefined ? plan.candidates : plan.candidates.slice(0, limit);
  yield* Console.log(
    [
      `Memory enrichment: ${candidates.length} ${dryRun ? 'would be processed' : 'to process'}`,
      `${plan.alreadyEnriched} already enriched`,
      `${plan.skippedKinds} smoke record(s) skipped`,
      `${plan.invalid} non-memory file(s) skipped`,
      `${plan.personalScanned} personal markdown file(s) scanned`,
      `${plan.sharedScanned} shared team memory file(s) scanned`,
    ].join('; '),
  );
  if (candidates.length === 0) {
    return;
  }
  if (dryRun) {
    for (const [index, candidate] of candidates.entries()) {
      const prefix = `[${index + 1}/${candidates.length}]`;
      yield* Console.log(`${prefix} Would enrich ${candidate.uri}`);
    }
    yield* Console.log('Run with --apply to generate and store local-model search keywords.');
    return;
  }

  const selectedGeneration = yield* resolveSelectedLocalModel(config.agentContextHome, 'generation');
  if (!selectedGeneration) {
    if (options.installLocalAi !== true) {
      return yield* Effect.fail(
        new Error(
          'No local generation model is selected. Use `threadnote models install` and `threadnote models select generation`, or rerun with `--install-local-ai`.',
        ),
      );
    }
    yield* Console.log(
      'Installing the pinned compatibility generation model before enrichment; the one-time download is 4.59 GB.',
    );
    yield* runModelInstall(config, 'gemma-4-e4b-it-q4', {});
    yield* runModelSelect(config, 'generation', 'gemma-4-e4b-it-q4', {});
  }
  yield* Console.log(
    'Generating retrieval keywords locally. This can take a long time for a large corpus; progress will stream below.',
  );

  const ov = NATIVE_RESOURCE_BACKEND;
  const fs = yield* FileSystem.FileSystem;
  let enriched = 0;
  let failed = 0;
  let noKeywords = 0;
  const enrichedSharedTeams = new Map<string, number>();
  for (const [index, candidate] of candidates.entries()) {
    const prefix = `[${index + 1}/${candidates.length}]`;
    yield* Console.log(`${prefix} Enriching ${candidate.uri}`);
    const loaded = yield* Effect.result(fs.readFileString(candidate.path));
    if (Result.isFailure(loaded)) {
      failed += 1;
      yield* Console.error(
        `${prefix} Failed to read ${candidate.uri}: ${
          loaded.failure instanceof Error ? loaded.failure.message : String(loaded.failure)
        }`,
      );
      continue;
    }
    const record = parseMemoryDocument(candidate.uri, loaded.success);
    if (!record) {
      failed += 1;
      yield* Console.error(`${prefix} Failed ${candidate.uri}: file is no longer a valid memory document.`);
      continue;
    }
    if (record.metadata.kind === 'smoke') {
      noKeywords += 1;
      yield* Console.log(`${prefix} Became ineligible since the scan; left unchanged.`);
      continue;
    }
    if (!options.force && record.metadata.keywords !== undefined) {
      noKeywords += 1;
      yield* Console.log(`${prefix} Already enriched since the scan; left unchanged.`);
      continue;
    }
    const generated = yield* Effect.result(
      enrichMemoryWithInstalledLocalAi(config, {
        body: record.body,
        kind: record.metadata.kind,
        project: record.metadata.project,
        topic: record.metadata.topic,
      }),
    );
    if (Result.isFailure(generated)) {
      if (isUnusableMemoryEnrichmentOutput(generated.failure)) {
        noKeywords += 1;
        yield* Console.log(`${prefix} No useful keywords generated; left unchanged.`);
      } else {
        failed += 1;
        yield* Console.error(
          `${prefix} Failed ${candidate.uri}: ${
            generated.failure instanceof Error ? generated.failure.message : String(generated.failure)
          }`,
        );
      }
      continue;
    }
    const keywords = generated.success;
    if (!keywords || keywords.length === 0) {
      noKeywords += 1;
      yield* Console.log(`${prefix} No useful keywords generated; left unchanged.`);
      continue;
    }
    const sharedTeam = sharedTeamNameForUri(config, candidate.uri);
    const store = withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [candidate.uri],
      Effect.gen(function* () {
        const currentContent = yield* fs.readFileString(candidate.path);
        if (canonicalMemoryDocumentContent(currentContent) !== canonicalMemoryDocumentContent(record.content)) {
          return yield* Effect.fail(
            new Error(`Memory changed during enrichment; left untouched so the migration can be retried.`),
          );
        }
        const content = formatMemoryDocumentWithKeywords(currentContent, keywords);
        if (sharedTeam) {
          const scrub = applyScrubber(content, {redact: false});
          if (scrub.blocker) {
            return yield* Effect.fail(
              new Error(`Refusing to enrich shared memory ${candidate.uri}: possible ${scrub.blocker}.`),
            );
          }
          const team = yield* resolveTeam(config, sharedTeam);
          yield* assertSharedWorktreeFileReady(
            team.config.worktree,
            resourceUriToWorktreeRelative(config, candidate.uri, team.name),
            currentContent,
          );
        }
        yield* writeMemoryFile(config, ov, candidate.uri, content, 'replace', false, {quiet: true});
        if (sharedTeam) {
          const team = yield* resolveTeam(config, sharedTeam);
          yield* writeSharedWorktreeFile(
            team.config.worktree,
            resourceUriToWorktreeRelative(config, candidate.uri, team.name),
            content,
          );
        }
      }),
    );
    const written = yield* Effect.result(sharedTeam ? withSharedRepositoryLock(config, store) : store);
    if (Result.isFailure(written)) {
      failed += 1;
      yield* Console.error(
        `${prefix} Failed to store ${candidate.uri}: ${
          written.failure instanceof Error ? written.failure.message : String(written.failure)
        }`,
      );
      continue;
    }
    enriched += 1;
    if (sharedTeam) {
      enrichedSharedTeams.set(sharedTeam, (enrichedSharedTeams.get(sharedTeam) ?? 0) + 1);
    }
    yield* Console.log(`${prefix} Stored ${keywords.length} keyword(s): ${keywords.join(', ')}`);
  }
  yield* Console.log(
    `Memory enrichment summary: ${enriched} enriched; ${noKeywords} unchanged; ${failed} failed; ${candidates.length} attempted.`,
  );
  for (const [team, count] of [...enrichedSharedTeams].sort(([left], [right]) => left.localeCompare(right))) {
    yield* Console.log(
      `Run \`threadnote share sync --team ${team}\` to publish ${count} enriched shared ${
        count === 1 ? 'memory' : 'memories'
      }.`,
    );
  }
  if (failed > 0) {
    return yield* Effect.fail(
      new Error(`${failed} memory enrichment operation(s) failed. Rerun the command to resume remaining memories.`),
    );
  }
});

const memoryEnrichmentPlan = Effect.fn('memory.memoryEnrichmentPlan')(function* (
  config: RuntimeConfig,
  force: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* localUserMemoriesRoot(config);
  const personalFiles = yield* scanFilesWithinBoundary(fs, root, root, {
    includeDirectory: directory => {
      const relative = path.relative(root, directory).split(path.sep);
      return relative[0] !== 'shared' && !relative.some(segment => segment.startsWith('.'));
    },
    includeFile: (_filePath, name) => name.endsWith('.md') && !name.startsWith('.'),
  });
  const personal = personalFiles.map(file => {
    const relative = path.relative(root, file.path).split(path.sep).join('/');
    return {
      path: file.path,
      uri: `threadnote://user/${uriSegment(config.user)}/memories/${relative}`,
    };
  });
  const teams = yield* readTeamsFile(config);
  const sharedByTeam = yield* Effect.forEach(
    Object.entries(teams.teams).sort(([left], [right]) => left.localeCompare(right)),
    ([team, settings]) =>
      Effect.gen(function* () {
        const files = yield* scanFilesWithinBoundary(fs, path.join(settings.worktree, 'durable'), settings.worktree, {
          includeDirectory: directory =>
            !path
              .relative(settings.worktree, directory)
              .split(path.sep)
              .some(segment => segment.startsWith('.')),
          includeFile: (_filePath, name) => name.endsWith('.md') && !name.startsWith('.'),
        });
        return files.map(file => {
          const relative = path.relative(settings.worktree, file.path).split(path.sep).join('/');
          return {
            path: file.path,
            uri: `threadnote://user/${uriSegment(config.user)}/memories/shared/${team}/${relative}`,
          };
        });
      }),
  );
  const shared = sharedByTeam.flat();
  const files = [...personal, ...shared];
  const candidates: MemoryEnrichmentCandidate[] = [];
  let alreadyEnriched = 0;
  let invalid = 0;
  let skippedKinds = 0;
  for (const file of files) {
    const content = yield* fs.readFileString(file.path);
    const record = parseMemoryDocument(file.uri, content);
    if (!record) {
      invalid += 1;
      continue;
    }
    if (record.metadata.kind === 'smoke') {
      skippedKinds += 1;
      continue;
    }
    if (!force && record.metadata.keywords !== undefined) {
      alreadyEnriched += 1;
      continue;
    }
    candidates.push({path: file.path, priority: memoryEnrichmentPriority(record), uri: file.uri});
  }
  candidates.sort((left, right) => left.priority - right.priority || left.uri.localeCompare(right.uri));
  return {
    alreadyEnriched,
    candidates,
    invalid,
    personalScanned: personal.length,
    sharedScanned: shared.length,
    skippedKinds,
  } satisfies MemoryEnrichmentPlan;
});

function memoryEnrichmentPriority(record: MemoryRecord): number {
  const statusPriority = record.metadata.status === 'active' ? 0 : record.metadata.status === 'archived' ? 10 : 20;
  const kindPriority = {
    durable: 0,
    handoff: 1,
    incident: 2,
    preference: 3,
    smoke: 4,
  }[record.metadata.kind];
  return statusPriority + kindPriority;
}

export const runMigrateLifecycle = Effect.fn('runMigrateLifecycle')(function* (
  config: RuntimeConfig,
  options: MigrateLifecycleOptions,
) {
  const dryRun = options.dryRun === true || options.apply !== true;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const limit = options.limit ? parsePositiveInteger(options.limit, 'lifecycle migration limit') : undefined;
  const ov = NATIVE_RESOURCE_BACKEND;
  const candidates = yield* legacyLifecycleHandoffCandidates(config);
  const migrationPath = path.join(config.agentContextHome, 'lifecycle-memory-migration.txt');
  let existingCount = 0;
  let migratedCount = 0;
  let skippedCount = 0;

  yield* Effect.gen(function* () {
    for (const candidate of candidates) {
      if (limit !== undefined && migratedCount >= limit) {
        break;
      }
      const destinationUri = lifecycleMigrationUri(
        config,
        candidate.metadata,
        yield* sha256(candidate.original.trim()),
      );
      const migratedMemory = formatMemoryDocument(
        'HANDOFF',
        candidate.metadata,
        ['Migrated legacy handoff from the historical events trail.', '', candidate.original.trim()].join('\n'),
      );

      yield* Console.log(`${dryRun ? 'Would migrate' : 'Migrating'} ${candidate.sourceUri} -> ${destinationUri}`);
      if (!dryRun) {
        if (yield* resourceExists(ov, config, destinationUri)) {
          existingCount += 1;
          yield* Console.log(`Archived copy already exists; cleaning up legacy source: ${candidate.sourceUri}`);
        } else {
          yield* fs.writeFileString(migrationPath, migratedMemory, {mode: 0o600});
          yield* fs.chmod(migrationPath, 0o600);
          yield* ensureMemoryDirectory(ov, config, memoryDirectoryUri(config, candidate.metadata));
          yield* writeDurableMemoryFile(ov, config, destinationUri, migrationPath, 'create');
        }
        const removedOriginal = yield* removeResourceWithRetry(ov, config, candidate.sourceUri, {
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
  }).pipe(Effect.ensuring(dryRun ? Effect.void : fs.remove(migrationPath, {force: true}).pipe(Effect.ignore)));

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
  const contexts = yield* projectNameMigrationContexts(config);
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
    const candidates = remaining === 0 ? [] : yield* projectNameMigrationCandidates(config, context, remaining);
    plans.push({candidates, context});
    if (remaining !== undefined) {
      remaining = Math.max(0, remaining - candidates.length);
    }
  }
  const seedManifestMigration = yield* seedManifestProjectNameMigration(config, contexts);
  if (!plans.some(plan => plan.candidates.length > 0) && !seedManifestMigration) {
    yield* Console.log('No project-name migration candidates found across configured projects.');
    return;
  }

  const seedManifestUpdated = yield* migrateSeedManifestProjectNames(config, seedManifestMigration, dryRun);
  let existingCount = 0;
  let migratedCount = 0;
  let skippedCount = 0;
  const candidates = plans.flatMap(plan => [...plan.candidates]);
  if (candidates.length > 0) {
    const ov = NATIVE_RESOURCE_BACKEND;
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
          yield* ensureMemoryDirectory(ov, config, parentResourceUri(candidate.destinationUri));
          yield* writeMemoryFile(config, ov, candidate.destinationUri, candidate.destinationContent, 'create', false);
        }
        const removedOriginal = yield* removeResourceWithRetry(ov, config, candidate.sourceUri, {
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

export const hasProjectNameMigrationCandidates = Effect.fn('memory.hasProjectNameMigrationCandidates')(function* (
  config: RuntimeConfig,
) {
  const contexts = yield* projectNameMigrationContexts(config);
  if (contexts.length === 0) {
    return false;
  }
  for (const context of contexts) {
    if ((yield* projectNameMigrationCandidates(config, context, 1)).length > 0) {
      return true;
    }
  }
  return (yield* seedManifestProjectNameMigration(config, contexts)) !== undefined;
});

const projectNameMigrationContexts = Effect.fn('memory.projectNameMigrationContexts')(function* (
  config: RuntimeConfig,
) {
  const evidence = yield* projectNameMigrationMemoryEvidence(config);
  const contexts: ProjectNameMigrationContext[] = [];
  const manifest = yield* readSeedManifest(config.manifestPath).pipe(Effect.option);
  if (manifest._tag === 'Some') {
    for (const project of manifest.value.projects) {
      const projectEvidence = evidence.get(uriSegment(project.name));
      if (projectEvidence) {
        projectEvidence.repoPaths.add(yield* expandPath(project.path));
      }
    }
  }
  for (const projectEvidence of evidence.values()) {
    for (const repoPath of projectEvidence.repoPaths) {
      const context = yield* projectNameMigrationContextForRepoPath(projectEvidence.oldProject, repoPath);
      if (context) {
        contexts.push(context);
      }
    }
  }
  const currentContext = yield* currentWorkspaceProjectNameMigrationContext(evidence);
  if (currentContext) {
    contexts.push(currentContext);
  }
  return dedupeProjectNameMigrationContexts(contexts);
});

const projectNameMigrationMemoryEvidence = Effect.fn('memory.projectNameMigrationMemoryEvidence')(function* (
  config: RuntimeConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const evidence = new Map<string, ProjectNameMigrationProjectEvidence>();
  for (const location of projectMemoryLocations()) {
    const locationRoot = path.join(yield* localUserMemoriesRoot(config), ...location.relativePath);
    const projectEntries = yield* fs.readDirectory(locationRoot).pipe(Effect.option);
    if (projectEntries._tag === 'None') {
      continue;
    }
    for (const projectEntry of projectEntries.value) {
      if (projectEntry.startsWith('.')) {
        continue;
      }
      const projectDirectory = path.join(locationRoot, projectEntry);
      const projectInfo = yield* fs.stat(projectDirectory).pipe(Effect.option);
      if (projectInfo._tag === 'None' || projectInfo.value.type !== 'Directory') {
        continue;
      }
      const oldSegment = projectEntry;
      const projectEvidence = ensureProjectNameMigrationEvidence(evidence, oldSegment);
      const memoryEntries = yield* fs.readDirectory(projectDirectory).pipe(Effect.option);
      if (memoryEntries._tag === 'None') {
        continue;
      }
      for (const memoryEntry of memoryEntries.value) {
        if (memoryEntry.startsWith('.') || !memoryEntry.endsWith('.md')) {
          continue;
        }
        const memoryPath = path.join(projectDirectory, memoryEntry);
        const memoryInfo = yield* fs.stat(memoryPath).pipe(Effect.option);
        if (memoryInfo._tag === 'None' || memoryInfo.value.type !== 'File') {
          continue;
        }
        const content = yield* readTextIfExists(memoryPath);
        if (!content) {
          continue;
        }
        const sourceUri = `threadnote://user/${uriSegment(config.user)}/memories/${location.uriPath}/${oldSegment}/${memoryEntry}`;
        const record = parseMemoryDocument(sourceUri, content);
        if (record?.metadata.project && uriSegment(record.metadata.project) === oldSegment) {
          projectEvidence.oldProject = record.metadata.project;
        }
        const repoPath = yield* repoPathEvidenceFromMemory(content);
        if (repoPath) {
          projectEvidence.repoPaths.add(repoPath);
        }
      }
    }
  }
  return evidence;
});

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

const repoPathEvidenceFromMemory = Effect.fn('memory.repoPathEvidenceFromMemory')(function* (content: string) {
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
  return yield* expandPath(cleaned);
});

const projectNameMigrationContextForRepoPath = Effect.fn('memory.projectNameMigrationContextForRepoPath')(function* (
  oldProject: string,
  repoPath: string,
) {
  const repoRoot = yield* gitValue(['rev-parse', '--show-toplevel'], repoPath);
  if (!repoRoot) {
    return undefined;
  }
  const newProject = yield* resolveGitRemoteRepoName(repoRoot);
  if (!newProject) {
    return undefined;
  }
  return projectNameMigrationContextFromParts({
    newProject,
    oldProject,
    repoRoot,
  });
});

const currentWorkspaceProjectNameMigrationContext = Effect.fn('memory.currentWorkspaceProjectNameMigrationContext')(
  function* (evidence: Map<string, ProjectNameMigrationProjectEvidence>) {
    const repoRoot = yield* gitValue(['rev-parse', '--show-toplevel']);
    if (!repoRoot) {
      return undefined;
    }
    const newProject = yield* resolveGitRemoteRepoName(repoRoot);
    const oldProject = yield* resolveRepoFolderName(repoRoot);
    if (!newProject || !oldProject) {
      return undefined;
    }
    const oldSegment = uriSegment(oldProject);
    if (!evidence.has(oldSegment)) {
      return undefined;
    }
    return projectNameMigrationContextFromParts({newProject, oldProject, repoRoot});
  },
);

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

const projectNameMigrationCandidates = Effect.fn('memory.projectNameMigrationCandidates')(function* (
  config: RuntimeConfig,
  context: ProjectNameMigrationContext,
  limit?: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates: ProjectNameMigrationCandidate[] = [];
  for (const location of projectMemoryLocations()) {
    const sourceDirectory = path.join(
      yield* localUserMemoriesRoot(config),
      ...location.relativePath,
      context.oldSegment,
    );
    const sourceDirectoryUri = `threadnote://user/${uriSegment(config.user)}/memories/${location.uriPath}/${context.oldSegment}`;
    const entries = yield* fs.readDirectory(sourceDirectory).pipe(Effect.option);
    if (entries._tag === 'None') {
      continue;
    }
    for (const entry of entries.value) {
      if (entry.startsWith('.') || !entry.endsWith('.md')) {
        continue;
      }
      const sourcePath = path.join(sourceDirectory, entry);
      const sourceInfo = yield* fs.stat(sourcePath).pipe(Effect.option);
      if (sourceInfo._tag === 'None' || sourceInfo.value.type !== 'File') {
        continue;
      }
      const sourceUri = `${sourceDirectoryUri}/${entry}`;
      const content = yield* readTextIfExists(sourcePath);
      if (!content) {
        continue;
      }
      const record = parseMemoryDocument(sourceUri, content);
      if (!record || !canMigrateProjectName(record, context)) {
        continue;
      }
      const metadata = {...record.metadata, project: context.newProject};
      const destinationDirectoryUri = memoryDirectoryUri(config, metadata);
      const destinationDirectory = yield* localMemoryPathForUri(config, destinationDirectoryUri);
      if (!destinationDirectory) {
        continue;
      }
      const destinationContent = formatMemoryDocument(record.headerTitle, metadata, record.body);
      const destination = yield* projectNameMigrationDestination(
        destinationDirectory,
        entry,
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
});

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

const migrateSeedManifestProjectNames = Effect.fn('memory.migrateSeedManifestProjectNames')(function* (
  config: RuntimeConfig,
  migration:
    | {
        readonly contexts: readonly ProjectNameMigrationContext[];
        readonly newProjects: readonly string[];
        readonly output: string;
      }
    | undefined,
  dryRun: boolean,
) {
  if (!migration) {
    return false;
  }
  if (dryRun) {
    yield* Console.log(`Would update seed manifest: ${config.manifestPath}`);
    yield* Console.log(migration.output.trimEnd());
    return true;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* ensureDirectory(path.dirname(config.manifestPath), false);
  const currentContent = yield* readFileIfExists(config.manifestPath);
  if (currentContent !== undefined) {
    const backupPath = `${config.manifestPath}.project-name-${safeTimestamp()}`;
    yield* fs.writeFileString(backupPath, currentContent, {mode: 0o600});
    yield* fs.chmod(backupPath, 0o600);
    yield* Console.log(`Backup: ${backupPath}`);
  }
  yield* fs.writeFileString(config.manifestPath, migration.output, {mode: 0o600});
  yield* fs.chmod(config.manifestPath, 0o600);
  yield* Console.log(`Updated seed manifest: ${config.manifestPath}`);
  return true;
});

const seedManifestProjectNameMigration = Effect.fn('memory.seedManifestProjectNameMigration')(function* (
  config: RuntimeConfig,
  contexts: readonly ProjectNameMigrationContext[],
) {
  const manifest = yield* readSeedManifest(config.manifestPath).pipe(Effect.option);
  if (manifest._tag === 'None') {
    return undefined;
  }
  const renamed = new Map<string, ProjectNameMigrationContext>();
  let changed = false;
  const projects = manifest.value.projects.map(project => {
    const context = contexts.find(candidate =>
      isSeedManifestProjectNameCandidate(
        project,
        candidate,
        `threadnote://resources/repos/${candidate.oldSegment}`,
        `threadnote://resources/repos/${candidate.newSegment}`,
      ),
    );
    if (!context) {
      return project;
    }
    const newNameExists = manifest.value.projects.some(
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
        trimTrailingSlash(project.uri) === `threadnote://resources/repos/${context.oldSegment}`
          ? `threadnote://resources/repos/${context.newSegment}`
          : project.uri,
    };
  });
  const worksets =
    renamed.size > 0
      ? manifest.value.worksets?.map(workset => {
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
      : manifest.value.worksets;
  if (!changed) {
    return undefined;
  }
  return {
    contexts: [...renamed.values()],
    newProjects: [...new Set([...renamed.values()].map(context => context.newProject))],
    output: `${yaml.dump(
      {
        version: manifest.value.version,
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
        ...(manifest.value.futureMonorepo
          ? {
              future_monorepo: {
                path_candidates: [...manifest.value.futureMonorepo.pathCandidates],
                uri: manifest.value.futureMonorepo.uri,
              },
            }
          : {}),
      },
      {lineWidth: 120, noRefs: true},
    )}`,
  };
});

function isSeedManifestProjectNameCandidate(
  project: ProjectManifest,
  context: ProjectNameMigrationContext,
  oldDefaultUri: string,
  newDefaultUri: string,
): boolean {
  const nameSegment = uriSegment(project.name);
  const uriMatchesOld = trimTrailingSlash(project.uri) === oldDefaultUri;
  const pathMatchesRepo = project.path === context.repoRoot || project.path === `~/${context.repoRoot}`;
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

const projectNameMigrationDestination = Effect.fn('memory.projectNameMigrationDestination')(function* (
  destinationDirectory: string,
  filename: string,
  content: string,
  oldProjectSegment: string,
) {
  const direct = yield* projectNameMigrationDestinationState(destinationDirectory, filename, content);
  if (!direct.exists || direct.sameContent) {
    return {existsWithSameContent: direct.sameContent, filename};
  }
  const stem = filename.replace(/\.md$/i, '');
  const fromOldProject = `${stem}-from-${oldProjectSegment}.md`;
  const renamed = yield* projectNameMigrationDestinationState(destinationDirectory, fromOldProject, content);
  if (!renamed.exists || renamed.sameContent) {
    return {existsWithSameContent: renamed.sameContent, filename: fromOldProject};
  }
  return {
    existsWithSameContent: false,
    filename: `${stem}-from-${oldProjectSegment}-${(yield* sha256(content)).slice(0, 12)}.md`,
  };
});

const projectNameMigrationDestinationState = Effect.fn('memory.projectNameMigrationDestinationState')(function* (
  destinationDirectory: string,
  filename: string,
  content: string,
) {
  const path = yield* Path.Path;
  const existing = yield* readTextIfExists(path.join(destinationDirectory, filename));
  return {exists: existing !== undefined, sameContent: existing?.trim() === content.trim()};
});

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
    yield* syncObsidianSourcesAndLog(config);
  }
  const workspaceOptions = options.callerCwd
    ? {cwd: options.callerCwd, includeProcessCwd: false}
    : {includeProcessCwd: true};
  const query = yield* enrichRecallQueryWithWorkspaceContext(options.query, workspaceOptions);
  const projectQuery = yield* enrichRecallQueryWithWorkspaceProjectContext(options.query, workspaceOptions);
  const dryRun = options.dryRun === true;
  const explicitUri = options.uri ? parseResourceId(options.uri).canonicalUri : undefined;
  const inferredUri =
    explicitUri ?? (options.inferScope === false ? undefined : yield* inferRecallUri(config, projectQuery));
  const queryProject = yield* inferProjectFromQuery(config.manifestPath, options.project ?? options.query);
  const project = queryProject ?? (yield* inferProjectFromQuery(config.manifestPath, projectQuery));
  const projectMemoryName = yield* recallProjectMemoryName(options.project, workspaceOptions);
  const recallProjectName = project?.name ?? projectMemoryName;
  const nodeLimit = options.nodeLimit
    ? yield* attemptSync(() => parsePositiveInteger(options.nodeLimit!, 'node limit'))
    : undefined;
  const explicitWorkset = options.workset ? yield* requireWorkset(config.manifestPath, options.workset!) : undefined;
  const recallThreshold = options.threshold ?? (yield* recallScoreThreshold());
  // Scope selection feeds the native postings/vector indexes directly. The
  // passes array remains as a compatibility input to the existing explainable
  // ranker; no background process or HTTP service is queried.
  if (inferredUri) {
    yield* Console.log(`Recall scope: ${inferredUri}`);
  }
  const includeArchived = options.includeArchived === true;
  const passes: Array<readonly RecallHit[]> = [];
  if (dryRun) {
    yield* Console.log(
      `Would search native recall index for ${JSON.stringify(query)}${inferredUri ? ` under ${inferredUri}` : ''}.`,
    );
  }
  const scopedRecallUris = new Set([inferredUri].filter((uri): uri is string => uri !== undefined));
  if (options.project && project) {
    const projectMemoryUri = `threadnote://user/${uriSegment(config.user)}/memories/durable/projects/${uriSegment(project.name)}`;
    if (!scopedRecallUris.has(projectMemoryUri)) {
      scopedRecallUris.add(projectMemoryUri);
    }
  }
  for (const scope of projectMemoryScopeUris(config, recallProjectName, includeArchived)) {
    if (!scopedRecallUris.has(scope)) {
      scopedRecallUris.add(scope);
    }
  }
  const seededUri = project ? trimTrailingSlash(project.uri) : undefined;
  if (
    seededUri?.startsWith('threadnote://') &&
    seededUri !== inferredUri &&
    !options.uri &&
    options.inferScope !== false
  ) {
    scopedRecallUris.add(seededUri);
  }

  // Workset expansion: a named set of manifest projects recalled as one working
  // set. Push a durable + seeded scope pass per member; the merge dedupes hits,
  // and the scope list is deduped/capped so overlap only costs bounded searches.
  const workset =
    !options.uri && explicitWorkset
      ? explicitWorkset
      : !options.uri && options.inferScope !== false
        ? yield* inferWorksetFromQuery(config.manifestPath, projectQuery)
        : undefined;
  if (workset && workset.projects.length > 0) {
    yield* Console.log(`Workset scope: ${workset.name} (${workset.projects.map(member => member.name).join(', ')})`);
    const alreadyScoped = new Set(
      [inferredUri, seededUri, ...scopedRecallUris].filter((uri): uri is string => uri !== undefined),
    );
    const worksetScopes = worksetScopeUris(config, workset)
      .filter(uri => !alreadyScoped.has(uri))
      .slice(0, MAX_WORKSET_PASSES);
    for (const scope of worksetScopes) {
      scopedRecallUris.add(scope);
    }
  }
  if (dryRun) {
    for (const scope of scopedRecallUris) {
      yield* Console.log(`Would search native recall index --uri ${scope}`);
    }
  }

  const exactMatches = dryRun
    ? []
    : yield* collectNativeExactMemoryMatches(config, query, {
        includeArchived,
        project,
      });
  const environment = (yield* SystemInfo).environment();
  const effectAi = dryRun ? undefined : yield* resolveEffectAiConfiguration(config, environment);
  let hybridMinimumScore = recallHybridMinimumScore(Number(recallThreshold), options.threshold !== undefined);
  const expansionQueries: string[] = [];
  const recallLimit = nodeLimit ?? 12;
  const semanticScores = dryRun ? null : ((yield* loadRecallSemanticScores(config, query, recallLimit)) ?? null);
  const rerankerCache = createRecallRerankerCache();
  const prepareSections = (candidateUris?: readonly string[]) =>
    prepareRecallSections(config, {
      allowExactRescue: options.threshold === undefined,
      allowedUriScopes: explicitUri ? [explicitUri] : undefined,
      candidateUris,
      exactMatches,
      feedbackQuery: options.query,
      includeInactive: includeArchived,
      limit: recallLimit,
      minimumScore: hybridMinimumScore,
      passes,
      preferredUriScopes: explicitUri ? undefined : [...scopedRecallUris],
      project: recallProjectName,
      query,
      queryVariants: expansionQueries,
      readRecords: uris => readMemoryRecordsByUri(config, uris),
      rerankerCache,
      seedUris: [inferredUri, seededUri].filter((uri): uri is string => uri !== undefined),
      semanticScores,
    });
  let recallSections = yield* prepareSections();
  const shouldAttemptAiExpansion = !dryRun && shouldExpandRecall(recallSections.confidence);
  const indexSelectionCandidates = shouldAttemptAiExpansion
    ? buildRecallIndexSelectionCandidates(recallSections.expansionCandidates, recallProjectName, 24)
    : [];
  const indexSelectionIds =
    indexSelectionCandidates.length > 0
      ? yield* selectExpandedRecallCandidatesEffect(
          {candidates: indexSelectionCandidates, query: options.query},
          config,
          effectAi,
        )
      : undefined;
  const groundedExpansionQueries =
    indexSelectionIds && indexSelectionIds.length > 0
      ? limitRecallRewritesForConfidence(
          recallSections.confidence,
          recallSelectionQueries(
            indexSelectionCandidates,
            recallSections.expansionCandidates,
            indexSelectionIds,
            options.query,
            2,
          ),
        )
      : [];
  const needsFallbackExpansion =
    shouldExpandRecall(recallSections.confidence) &&
    groundedExpansionQueries.length < recallRewriteLimitForConfidence(recallSections.confidence);
  const expansionVocabulary =
    needsFallbackExpansion && shouldExpandRecall(recallSections.confidence)
      ? yield* loadRecallExpansionVocabulary(config, {
          allowedUriScopes: explicitUri ? [explicitUri] : [...scopedRecallUris],
          includeInactive: includeArchived,
          project: recallProjectName,
          rankedCandidates: recallSections.expansionCandidates,
        }).pipe(Effect.catch(() => Effect.succeed([])))
      : [];
  const fallbackExpansionQueries =
    dryRun || !needsFallbackExpansion
      ? []
      : yield* expandWeakRecallQueryEffect(
          {
            confidence: recallSections.confidence,
            project: recallProjectName,
            query: options.query,
            vocabulary: expansionVocabulary,
          },
          config,
          effectAi,
        );
  const proposedExpansionQueries = mergeRecallRewritesForConfidence(
    recallSections.confidence,
    groundedExpansionQueries,
    fallbackExpansionQueries,
  );
  for (const expansionQuery of proposedExpansionQueries) {
    expansionQueries.push(expansionQuery);
    hybridMinimumScore = recallHybridMinimumScore(Number(recallThreshold), options.threshold !== undefined);
    recallSections = yield* prepareSections();
  }
  if (expansionQueries.length > 0) {
    yield* Console.log(`Recall query expansion: evaluated ${expansionQueries.length} model rewrite(s).`);
    const selectionCandidates = buildRecallSelectionCandidates(
      recallSections.ranked,
      recallSections.expansionCandidates,
      Math.max(nodeLimit ?? 12, 12) * 2,
    );
    const selectedIds = yield* selectExpandedRecallCandidatesEffect(
      {candidates: selectionCandidates, query: options.query},
      config,
      effectAi,
    );
    if (selectedIds !== undefined) {
      const selectedUris = selectedRecallCandidateUris(
        selectionCandidates,
        selectedIds,
        recallSelectionAnchorIds(selectionCandidates, recallSections.ranked),
      );
      recallSections = yield* prepareSections(selectedUris);
      yield* Console.log(
        `Recall local AI post-filter: kept ${selectedUris.length} of ${selectionCandidates.length} candidate(s).`,
      );
    }
  }
  const {semanticSection, exactTail} = recallSections;
  if (semanticSection) {
    yield* Console.log(`\n${semanticSection}`);
  }
  if (exactTail) {
    yield* Console.log(`\n${exactTail}`);
  }
  const referencedSection = yield* referencedContextSection(config, semanticSection ?? '');
  if (referencedSection) {
    yield* Console.log(`\n${referencedSection}`);
  }
  yield* printRecallHygieneNudges(config, semanticSection ?? '');
});

const MAX_REFERENCED_CONTEXT = 5;

/**
 * Resolves the one-way `references:` pointers carried by the personal memories
 * recall just surfaced and appends bounded URI-only pointers. The caller can
 * explicitly read a relevant pointer without recall inlining unrelated text.
 */
const referencedContextSection = Effect.fn('memory.referencedContextSection')(function* (
  config: RuntimeConfig,
  recallOutput: string,
) {
  const surfacedUris = activePersonalMemoryUrisFromText(recallOutput, config.user);
  if (surfacedUris.length === 0) {
    return undefined;
  }
  const surfaced = yield* readMemoryRecordsByUri(config, surfacedUris);
  const referenced = referencedUrisFromRecords(surfaced, recallOutput);
  if (referenced.length === 0) {
    return undefined;
  }
  return formatReferencedContextPointers(referenced, MAX_REFERENCED_CONTEXT);
});

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
  yield* attemptSync(() => assertResourceUri(uri));
  if (options.dryRun !== true) {
    yield* syncSharedReposAndLog(config);
  }
  if (options.dryRun === true) {
    yield* Console.log(`Would read native resource: ${uri}`);
    return;
  }
  const store = yield* ResourceStore;
  yield* Console.log(yield* store.read(resourceStoreLocation(config), uri));
});

const syncSharedReposAndLog = Effect.fn('memory.syncSharedReposAndLog')(function* (config: RuntimeConfig) {
  const syncResult = yield* syncSharedReposBeforeAgentRead(config).pipe(
    Effect.catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      return Console.error(`Auto-sync warning: ${message}`).pipe(Effect.as(undefined));
    }),
  );
  if (!syncResult) {
    return;
  }
  if (syncResult.syncedTeams.length > 0) {
    yield* Console.error(`Auto-synced shared memories: ${syncResult.syncedTeams.join(', ')}`);
  }
  for (const warning of syncResult.warnings) {
    yield* Console.error(`Auto-sync warning: ${warning}`);
  }
});

const syncObsidianSourcesAndLog = Effect.fn('memory.syncObsidianSourcesAndLog')(function* (config: RuntimeConfig) {
  const syncResult = yield* syncObsidianSourcesBeforeRecall(config).pipe(
    Effect.catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      return Console.error(`Auto-sync warning: Obsidian source refresh failed: ${message}`).pipe(Effect.as(undefined));
    }),
  );
  if (!syncResult) {
    return;
  }
  if (syncResult.syncedSources.length > 0) {
    yield* Console.error(`Auto-synced Obsidian sources: ${syncResult.syncedSources.join(', ')}`);
  }
  for (const warning of syncResult.warnings) {
    yield* Console.error(`Auto-sync warning: ${warning}`);
  }
});

const printRecallHygieneNudges = Effect.fn('memory.printRecallHygieneNudges')(function* (
  config: RuntimeConfig,
  recallOutput: string,
) {
  const uris = activePersonalMemoryUrisFromText(recallOutput, config.user);
  if (uris.length === 0) {
    return;
  }
  const records = yield* readMemoryRecordsByUri(config, uris);
  const nudges = recallHygieneNudges(recallOutput, {records, user: config.user});
  if (nudges.length === 0) {
    return;
  }
  yield* Console.log('\nMemory hygiene hints:');
  for (const nudge of nudges) {
    yield* Console.log(`- ${nudge}`);
  }
});

export const runCompact = Effect.fn('runCompact')(function* (config: RuntimeConfig, options: CompactOptions) {
  const project = yield* requireValue(
    normalizeOptionalMetadata(options.project),
    'Provide --project for scoped memory hygiene.',
  );
  if (options.apply === true && options.dryRun === true) {
    yield* Effect.fail(new Error('Cannot combine --apply with --dry-run.'));
  }
  const apply = options.apply === true;
  const records = yield* scopedCompactRecords(config, {
    kind: options.kind,
    project,
  });
  const plan = buildCompactPlan(records, {
    kind: options.kind,
    project,
    topic: normalizeOptionalMetadata(options.topic),
  });
  yield* Console.log(formatCompactPlan(plan, {apply}));
  if (!apply) {
    return;
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ov = NATIVE_RESOURCE_BACKEND;
  const updatePath = path.join(config.agentContextHome, 'compact-memory-update.txt');
  yield* Effect.gen(function* () {
    for (const action of plan.keepUpdates) {
      yield* fs.writeFileString(updatePath, action.content, {mode: 0o600});
      yield* fs.chmod(updatePath, 0o600);
      yield* writeDurableMemoryFile(ov, config, action.uri, updatePath, 'replace');
    }
  }).pipe(Effect.ensuring(fs.remove(updatePath, {force: true}).pipe(Effect.ignore)));

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

export const runCompactDiagnostics = Effect.fn('memory.runCompactDiagnostics')(function* (
  config: RuntimeConfig,
  options: CompactOptions,
) {
  const project = normalizeOptionalMetadata(options.project);
  if (!project) {
    return yield* Effect.fail(new Error('Provide --project for scoped memory hygiene.'));
  }
  const topic = normalizeOptionalMetadata(options.topic);
  const records = yield* scopedCompactRecords(config, {
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
  yield* Console.log(
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
});

const scopedCompactRecords = Effect.fn('memory.scopedCompactRecords')(function* (
  config: RuntimeConfig,
  options: {readonly kind?: CompactableMemoryKind; readonly project: string},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const kinds: readonly CompactableMemoryKind[] = options.kind ? [options.kind] : ['handoff', 'durable', 'incident'];
  const records: MemoryRecord[] = [];
  for (const kind of kinds) {
    const directory = yield* localMemoryDirectoryForCompact(config, kind, options.project);
    const uriDirectory = memoryUriDirectoryForCompact(config, kind, options.project);
    const entries = yield* fs.readDirectory(directory).pipe(Effect.option);
    if (entries._tag === 'None') {
      continue;
    }
    for (const entry of entries.value) {
      if (entry.startsWith('.') || !entry.endsWith('.md')) {
        continue;
      }
      const entryPath = path.join(directory, entry);
      const info = yield* fs.stat(entryPath).pipe(Effect.option);
      if (info._tag === 'None' || info.value.type !== 'File') {
        continue;
      }
      const content = yield* readTextIfExists(entryPath);
      if (!content) {
        continue;
      }
      const record = parseMemoryDocument(`${uriDirectory}/${entry}`, content);
      if (record) {
        records.push(record);
      }
    }
  }
  return records;
});

function formatKindCounts(counts: ReadonlyMap<CompactableMemoryKind, number>): string {
  return (['handoff', 'durable', 'incident'] as const).map(kind => `${kind} ${counts.get(kind) ?? 0}`).join(', ');
}

const readMemoryRecordsByUri = Effect.fn('memory.readMemoryRecordsByUri')(function* (
  config: RuntimeConfig,
  uris: readonly string[],
) {
  const records: MemoryRecord[] = [];
  for (const uri of uris) {
    const localPath = yield* localMemoryPathForUri(config, uri);
    if (!localPath) {
      continue;
    }
    const content = yield* readTextIfExists(localPath);
    if (!content) {
      continue;
    }
    const record = parseMemoryDocument(uri, content);
    if (record) {
      records.push(record);
    }
  }
  return records;
});

const localMemoryDirectoryForCompact = Effect.fn('memory.localMemoryDirectoryForCompact')(function* (
  config: RuntimeConfig,
  kind: CompactableMemoryKind,
  project: string,
) {
  const path = yield* Path.Path;
  const root = yield* localUserMemoriesRoot(config);
  const projectSegment = uriSegment(project);
  switch (kind) {
    case 'durable':
      return path.join(root, 'durable', 'projects', projectSegment);
    case 'handoff':
      return path.join(root, 'handoffs', 'active', projectSegment);
    case 'incident':
      return path.join(root, 'incidents', 'active', projectSegment);
  }
});

function memoryUriDirectoryForCompact(config: RuntimeConfig, kind: CompactableMemoryKind, project: string): string {
  const base = `threadnote://user/${uriSegment(config.user)}/memories`;
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

const localMemoryPathForUri = Effect.fn('memory.localMemoryPathForUri')(function* (config: RuntimeConfig, uri: string) {
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/`;
  if (!uri.startsWith(prefix)) {
    return undefined;
  }
  const relative = uri.slice(prefix.length);
  if (relative.includes('..') || relative.startsWith('/')) {
    return undefined;
  }
  const path = yield* Path.Path;
  return path.join(yield* localUserMemoriesRoot(config), ...relative.split('/'));
});

export const runList = Effect.fn('runList')(function* (config: RuntimeConfig, uri: string, options: ListOptions) {
  yield* attemptSync(() => assertResourceUri(uri));
  const nodeLimit = options.nodeLimit
    ? yield* attemptSync(() => parsePositiveInteger(options.nodeLimit!, 'node limit'))
    : undefined;
  if (options.dryRun === true) {
    yield* Console.log(`Would list native resource: ${uri}${options.recursive ? ' recursively' : ''}`);
    return;
  }
  const store = yield* ResourceStore;
  const allEntries = yield* store.list(resourceStoreLocation(config), uri, {
    recursive: options.recursive === true,
  });
  const entries = nodeLimit === undefined ? allEntries : allEntries.slice(0, nodeLimit);
  if (options.simple === true) {
    yield* Console.log(entries.map(entry => entry.uri).join('\n'));
    return;
  }
  yield* Console.log(JSON.stringify(entries, null, 2));
});

export const runHandoff = Effect.fn('runHandoff')(function* (config: RuntimeConfig, options: HandoffOptions) {
  const {bodyText, metadata: baseMetadata} = yield* buildHandoff(options);
  const metadata =
    options.dryRun === true || (options.replace !== undefined && isInSharedNamespace(config, options.replace))
      ? baseMetadata
      : yield* enrichMemoryMetadataWithConfiguredLocalAi(config, baseMetadata, bodyText).pipe(
          Effect.catch(error =>
            Console.log(
              `Local AI memory enrichment skipped: ${error instanceof Error ? error.message : String(error)}`,
            ).pipe(Effect.as(baseMetadata)),
          ),
        );
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
  yield* attemptSync(() => assertResourceUri(uri));
  const ov = NATIVE_RESOURCE_BACKEND;
  const store = yield* ResourceStore;
  const original = options.dryRun === true ? undefined : (yield* store.read(resourceStoreLocation(config), uri)).trim();
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
    yield* Console.log(`Would remove archived native resource: ${uri}`);
    return;
  }
  const originalMemory = yield* requireValue(original, `Could not read ${uri} before archiving.`);
  const originalLocalPath = yield* localMemoryPathForUri(config, uri);
  const originalLocalContent = originalLocalPath ? yield* readFileIfExists(originalLocalPath) : undefined;

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
  const removedOriginal = yield* removeResourceWithRetry(ov, config, uri, {
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
  yield* attemptSync(() => assertResourceUri(uri));
  if (options.dryRun === true) {
    yield* Console.log(`Would remove native resource: ${uri}`);
    return;
  }
  const removed = yield* removeResourceWithRetry(NATIVE_RESOURCE_BACKEND, config, uri);
  if (!removed) {
    yield* Effect.fail(new Error(`Resource does not exist: ${uri}`));
  }
});

export const runExportPack = Effect.fn('runExportPack')(function* (config: RuntimeConfig, options: PackOptions) {
  const path = yield* Path.Path;
  const defaultPath = path.join(config.agentContextHome, `threadnote-${safeTimestamp()}.threadnote-pack.json`);
  const outputPath = yield* expandPath(options.path ?? defaultPath);
  const sourceUri = canonicalPackRoot(options.uri ?? `threadnote://user/${uriSegment(config.user)}/memories`);
  if (options.dryRun === true) {
    yield* Console.log(`Would export native resources under ${sourceUri} to ${outputPath}.`);
    return;
  }
  const store = yield* ResourceStore;
  const entries = yield* store.list(resourceStoreLocation(config), sourceUri, {recursive: true});
  const resources = yield* Effect.forEach(
    entries.filter(entry => entry.type === 'file'),
    entry =>
      store.read(resourceStoreLocation(config), entry.uri).pipe(
        Effect.map(content => ({
          content,
          relativeUri: entry.uri.slice(sourceUri.replace(/\/+$/, '').length).replace(/^\/+/, ''),
        })),
      ),
    {concurrency: 8},
  );
  const fs = yield* FileSystem.FileSystem;
  const temporary = `${outputPath}.${(yield* SystemInfo).processId}.tmp`;
  yield* fs.makeDirectory(path.dirname(outputPath), {recursive: true, mode: 0o700});
  yield* fs.writeFileString(temporary, `${JSON.stringify({resources, sourceUri, version: 1}, undefined, 2)}\n`, {
    mode: 0o600,
  });
  yield* fs.rename(temporary, outputPath);
  yield* Console.log(`Exported ${resources.length} resource(s) to ${outputPath}.`);
});

export const runImportPack = Effect.fn('runImportPack')(function* (config: RuntimeConfig, options: PackOptions) {
  if (!options.path) {
    yield* Effect.fail(new Error('Provide --path for import-pack.'));
  }
  const inputPath = yield* expandPath(options.path!);
  const fs = yield* FileSystem.FileSystem;
  const rawPack = yield* fs.readFileString(inputPath);
  const pack = yield* Effect.try({
    try: () => parseThreadnotePack(rawPack),
    catch: cause => new Error(`Invalid Threadnote pack ${inputPath}: ${errorMessage(cause)}`, {cause}),
  });
  const targetUri = options.targetUri
    ? canonicalPackRoot(options.targetUri)
    : packTargetForCurrentUser(pack.sourceUri, config.user);
  const planned = pack.resources.map(resource => ({
    content: resource.content,
    uri: canonicalPackRoot(`${targetUri.replace(/\/+$/, '')}/${resource.relativeUri}`),
  }));
  const destinations = new Set<string>();
  for (const resource of planned) {
    const collisionKey = resource.uri.normalize('NFC').toLocaleLowerCase();
    if (destinations.has(collisionKey)) {
      yield* Effect.fail(new Error(`Threadnote pack contains colliding destination URIs: ${resource.uri}.`));
    }
    destinations.add(collisionKey);
  }
  const store = yield* ResourceStore;
  const mutations: ResourceStoreMutation[] = [];
  for (const resource of planned) {
    if (options.dryRun === true) {
      yield* Console.log(`Would import native resource: ${resource.uri}`);
      continue;
    }
    mutations.push({
      content: resource.content,
      options: {mode: 'upsert'},
      type: 'write',
      uri: resource.uri,
    });
  }
  if (options.dryRun !== true) {
    yield* store.mutate(resourceStoreLocation(config), mutations);
  }
  yield* Console.log(
    `${options.dryRun === true ? 'Would import' : 'Imported'} ${pack.resources.length} resource(s) from ${inputPath}.`,
  );
});

function parseThreadnotePack(raw: string): {
  readonly resources: readonly {readonly content: string; readonly relativeUri: string}[];
  readonly sourceUri: string;
  readonly version: 1;
} {
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== 'object' || value === null) throw new Error('Pack root must be an object.');
  const pack = value as {
    readonly resources?: unknown;
    readonly sourceUri?: unknown;
    readonly version?: unknown;
  };
  if (pack.version !== 1 || typeof pack.sourceUri !== 'string' || !Array.isArray(pack.resources)) {
    throw new Error('Unsupported Threadnote pack version or shape.');
  }
  const resources = pack.resources.map(resource => {
    if (
      typeof resource !== 'object' ||
      resource === null ||
      typeof (resource as {content?: unknown}).content !== 'string' ||
      typeof (resource as {relativeUri?: unknown}).relativeUri !== 'string'
    ) {
      throw new Error('Pack resource entry is invalid.');
    }
    const entry = resource as {readonly content: string; readonly relativeUri: string};
    if (
      !entry.relativeUri ||
      entry.relativeUri.startsWith('/') ||
      entry.relativeUri.split('/').some(segment => !segment || segment === '.' || segment === '..')
    ) {
      throw new Error(`Unsafe pack relative URI: ${entry.relativeUri}.`);
    }
    return entry;
  });
  return {resources, sourceUri: pack.sourceUri, version: 1};
}

function canonicalPackRoot(input: string): string {
  const id = parseResourceId(input);
  if (id.anchor) throw new Error(`Pack resource roots cannot contain anchors: ${input}.`);
  return resourceIdWithoutAnchor(id).canonicalUri;
}

function packTargetForCurrentUser(sourceUri: string, user: string): string {
  const source = resourceIdWithoutAnchor(parseResourceId(sourceUri));
  if (source.namespace === 'resources') {
    return source.canonicalUri;
  }
  if (source.namespace === 'user' && source.segments.length > 0) {
    return canonicalResourceUri('user', [uriSegment(user), ...source.segments.slice(1)]);
  }
  throw new Error(`Unsupported Threadnote pack source URI: ${sourceUri}.`);
}

const inferRecallUri = Effect.fn('memory.inferRecallUri')(function* (config: RuntimeConfig, query: string) {
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
  const project = yield* inferProjectFromQuery(config.manifestPath, query);
  return project
    ? `threadnote://resources/agent-skills/repo-local-${uriSegment(project.name)}`
    : 'threadnote://resources/agent-skills';
});

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

const collectNativeExactMemoryMatches = Effect.fn('memory.collectNativeExactMemoryMatches')(function* (
  config: RuntimeConfig,
  query: string,
  options: {readonly includeArchived: boolean; readonly project: ProjectManifest | undefined},
) {
  const terms = exactRecallTerms(query);
  if (terms.length === 0) return [];
  const store = yield* ResourceStore;
  const termsByUri = new Map<string, Set<string>>();
  for (const scope of exactMemoryScopes(config, options.includeArchived, query, options.project)) {
    const matches = yield* store
      .grepMany(resourceStoreLocation(config), scope, terms, 25)
      .pipe(Effect.catch(() => Effect.succeed([])));
    for (const match of matches) {
      const matchedTerms = termsByUri.get(match.uri) ?? new Set<string>();
      matchedTerms.add(match.term);
      termsByUri.set(match.uri, matchedTerms);
    }
  }
  return [...termsByUri]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([uri, matchedTerms]) => ({terms: [...matchedTerms], uri}));
});

const storeMemory = Effect.fn('storeMemory')(function* (config: RuntimeConfig, options: StoreMemoryOptions) {
  if (options.replaceUri) {
    yield* attemptSync(() => assertResourceUri(options.replaceUri as string));
  }
  const ov = NATIVE_RESOURCE_BACKEND;
  if (options.replaceUri && isInSharedNamespace(config, options.replaceUri)) {
    if (options.dryRun) {
      yield* storeSharedMemoryReplacement(config, ov, options, options.replaceUri as string);
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    yield* withSharedRepositoryLock(
      config,
      withMemoryUriLocks(
        fs,
        config.agentContextHome,
        [options.replaceUri],
        storeSharedMemoryReplacement(config, ov, options, options.replaceUri as string),
      ),
    );
    return;
  }
  // Two-pass formatting: assume the caller's replaceUri is a true supersede,
  // compute the destination URI, then drop the supersedes line if it points
  // at the URI we are about to write to (an in-place update). Without this,
  // `--replace <self>` would bake a self-supersedes line into the body that
  // also leaks to teammates when the memory is later published.
  const candidateMetadata: MemoryMetadata = {...options.metadata, supersedes: options.replaceUri};
  const candidateMemory = formatMemoryDocument(options.title, candidateMetadata, options.bodyText);
  const memoryUri = yield* memoryUriFor(config, candidateMemory, candidateMetadata);
  const isInPlaceUpdate = options.replaceUri !== undefined && options.replaceUri === memoryUri;
  const finalMetadata: MemoryMetadata = isInPlaceUpdate
    ? {...options.metadata, supersedes: undefined}
    : candidateMetadata;
  const memory = isInPlaceUpdate
    ? formatMemoryDocument(options.title, finalMetadata, options.bodyText)
    : candidateMemory;
  if (options.dryRun) {
    const writeMode = yield* memoryWriteMode(ov, config, memoryUri, finalMetadata);
    yield* Console.log(memory);
    yield* Console.log(`\nWould ${writeMode} native resource: ${memoryUri}`);
    if (options.replaceUri && !isInPlaceUpdate) {
      yield* Console.log(`Would remove superseded native resource: ${options.replaceUri}`);
    }
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [options.replaceUri, memoryUri],
    Effect.gen(function* () {
      const writeMode = yield* memoryWriteMode(ov, config, memoryUri, finalMetadata);
      yield* ensureMemoryDirectory(ov, config, memoryDirectoryUri(config, finalMetadata));
      yield* writeMemoryFile(config, ov, memoryUri, memory, writeMode, false);
      yield* Console.log(`Stored memory: ${memoryUri}`);
      if (options.replaceUri && !isInPlaceUpdate) {
        const removedReplacedMemory = yield* removeResourceWithRetry(ov, config, options.replaceUri, {
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
const warnOnSharedProjectDrift = Effect.fn('memory.warnOnSharedProjectDrift')(function* (
  metadata: MemoryMetadata,
  inferred: {readonly project?: string} | undefined,
) {
  if (inferred?.project && metadata.project && uriSegment(metadata.project) !== inferred.project) {
    yield* Console.log(
      `WARN keeping shared memory project "${inferred.project}" from its storage path; ignoring requested "${metadata.project}". ` +
        `To change a shared memory's project, forget it and store a new one under the new project.`,
    );
  }
});

const storeSharedMemoryReplacement = Effect.fn('memory.storeSharedMemoryReplacement')(function* (
  config: RuntimeConfig,
  ov: string,
  options: StoreMemoryOptions,
  targetUri: string,
) {
  if (options.metadata.kind !== 'durable') {
    return yield* Effect.fail(new Error('Shared memory replacement only supports durable memories.'));
  }
  const teamName = sharedTeamNameForUri(config, targetUri);
  if (!teamName) {
    return yield* Effect.fail(new Error(`Memory ${targetUri} is not in the shared namespace.`));
  }
  const team = yield* resolveTeam(config, teamName);
  const inferred = sharedMemoryUriParts(config, targetUri);
  // The file is updated in place at targetUri, so its frontmatter project must
  // match the path it lives under; otherwise recall's project scoping and the
  // doctor consistency check disagree with the file's real location. Prefer the
  // path's project over a differing caller value and warn — changing a shared
  // memory's project means relocating it (forget + store anew), not editing the
  // frontmatter of the file at the old path. Topic keeps caller-wins semantics.
  yield* warnOnSharedProjectDrift(options.metadata, inferred);
  const metadata: MemoryMetadata = {
    ...options.metadata,
    project: inferred?.project ?? options.metadata.project,
    topic: options.metadata.topic ?? inferred?.topic,
  };
  const rawMemory = formatMemoryDocument(options.title, metadata, options.bodyText);
  const scrub = applyScrubber(stripPersonalProvenance(rawMemory), {redact: false});
  if (scrub.blocker) {
    return yield* Effect.fail(
      new Error(
        `Refusing to update shared memory ${targetUri}: possible ${scrub.blocker}. Strip the sensitive value first.`,
      ),
    );
  }
  const memory = scrub.cleaned;
  const relativePath = resourceUriToWorktreeRelative(config, targetUri, team.name);

  if (options.dryRun) {
    yield* Console.log(memory);
    yield* Console.log('\nWould run:');
  }
  const [existingTarget] = options.dryRun ? [] : yield* readMemoryRecordsByUri(config, [targetUri]);
  if (!options.dryRun && !existingTarget) {
    return yield* Effect.fail(new Error(`Shared memory ${targetUri} no longer exists.`));
  }
  const previousContent = existingTarget?.content;
  yield* assertSharedWorktreeFileReady(team.config.worktree, relativePath, previousContent, options.dryRun);
  yield* ensureSharedDirectoryChain(config, ov, targetUri, options.dryRun);
  yield* writeMemoryFile(config, ov, targetUri, memory, 'replace', options.dryRun);
  yield* writeSharedWorktreeFile(team.config.worktree, relativePath, memory, options.dryRun);

  const gitMessages = yield* publishShareGitChange(
    team.config.worktree,
    relativePath,
    `share: update ${relativePath}`,
    {
      dryRun: options.dryRun,
    },
  );
  for (const message of gitMessages) {
    yield* Console.log(message);
  }

  for (const redaction of scrub.redactions) {
    yield* Console.log(`Redacted ${redaction.count}× ${redaction.name} before shared update.`);
  }
  yield* Console.log(`Updated shared memory: ${targetUri}`);
});

const writeDurableMemoryFile = Effect.fn('memory.writeDurableMemoryFile')(function* (
  ov: string,
  config: RuntimeConfig,
  memoryUri: string,
  memoryPath: string,
  writeMode: 'create' | 'replace',
) {
  const fs = yield* FileSystem.FileSystem;
  const content = yield* fs.readFileString(memoryPath);
  yield* writeMemoryFile(config, ov, memoryUri, content, writeMode, false);
});

function removeResourceWithRetry(
  _ov: string,
  config: RuntimeConfig,
  uri: string,
  options: {readonly alreadyLocked?: boolean; readonly expectedContent?: string} = {},
) {
  const remove = Effect.gen(function* () {
    const store = yield* ResourceStore;
    yield* store.remove(resourceStoreLocation(config), uri);
    return true;
  }).pipe(Effect.catchTag('ResourceNotFound', () => Effect.succeed(false)));
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
          const localPath = yield* localMemoryPathForUri(config, uri);
          const currentContent = localPath ? yield* readFileIfExists(localPath) : undefined;
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

const resourceExists = Effect.fn('memory.resourceExists')(function* (_ov: string, config: RuntimeConfig, uri: string) {
  const store = yield* ResourceStore;
  return yield* store.stat(resourceStoreLocation(config), uri).pipe(
    Effect.as(true),
    Effect.catchTag('ResourceNotFound', () => Effect.succeed(false)),
  );
});

const ensureDurableMemoryDirectory = Effect.fn('memory.ensureDurableMemoryDirectory')(
  (ov: string, config: RuntimeConfig) => ensureMemoryDirectory(ov, config, durableMemoryDirectoryUri(config)),
);

const ensureMemoryDirectory = Effect.fn('memory.ensureMemoryDirectory')(function* (
  _ov: string,
  config: RuntimeConfig,
  directoryUri: string,
) {
  const store = yield* ResourceStore;
  yield* store.makeDirectory(resourceStoreLocation(config), directoryUri);
});

function durableMemoryDirectoryUri(config: RuntimeConfig): string {
  return `threadnote://user/${uriSegment(config.user)}/memories/events`;
}

function migratedDurableMemoryUri(config: RuntimeConfig, hash: string): string {
  return `${durableMemoryDirectoryUri(config)}/threadnote-migrated-${hash.slice(0, 16)}.md`;
}

export const hasLegacyLifecycleHandoffCandidates = Effect.fn('memory.hasLegacyLifecycleHandoffCandidates')(function* (
  config: RuntimeConfig,
) {
  return (yield* legacyLifecycleHandoffCandidates(config, 1)).length > 0;
});

const legacyLifecycleHandoffCandidates = Effect.fn('memory.legacyLifecycleHandoffCandidates')(function* (
  config: RuntimeConfig,
  limit?: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const eventsRoot = path.join(yield* localUserMemoriesRoot(config), 'events');
  const entries = yield* fs.readDirectory(eventsRoot).pipe(Effect.option);
  if (entries._tag === 'None') {
    return [];
  }

  const candidates: LifecycleHandoffCandidate[] = [];
  for (const entry of entries.value) {
    if (entry.startsWith('.') || !entry.endsWith('.md')) {
      continue;
    }
    const sourcePath = path.join(eventsRoot, entry);
    const info = yield* fs.stat(sourcePath).pipe(Effect.option);
    if (info._tag === 'None' || info.value.type !== 'File') {
      continue;
    }
    const original = yield* readTextIfExists(sourcePath);
    if (!original || !isClearLegacyHandoffMemory(original) || sensitiveMemoryReason(original)) {
      continue;
    }
    const sourceUri = `${durableMemoryDirectoryUri(config)}/${entry}`;
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
});

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
    scopes.push(`threadnote://user/${uriSegment(config.user)}/memories/durable/projects/${uriSegment(member.name)}`);
    const seeded = trimTrailingSlash(member.uri);
    if (seeded.startsWith('threadnote://')) {
      scopes.push(seeded);
    }
  }
  return [...new Set(scopes)];
}

const recallProjectMemoryName = Effect.fn('memory.recallProjectMemoryName')(function* (
  explicitProject: string | undefined,
  options: {readonly cwd?: string; readonly includeProcessCwd?: boolean},
) {
  return normalizeOptionalMetadata(explicitProject) ?? (yield* resolveWorkspaceRepoName(options));
});

function projectMemoryScopeUris(
  config: RuntimeConfig,
  projectName: string | undefined,
  includeArchived: boolean,
): readonly string[] {
  if (!projectName) {
    return [];
  }
  const base = `threadnote://user/${uriSegment(config.user)}/memories`;
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
    agentMemoriesUri: `threadnote://agent/${uriSegment(config.agentId)}/memories`,
    includeArchived,
    intents: exactRecallScopeIntents(query),
    projectName: project ? uriSegment(project.name) : undefined,
    projectResourceUri: project ? trimTrailingSlash(project.uri) : undefined,
    userBase: `threadnote://user/${uriSegment(config.user)}/memories`,
  });
}

const memoryUriFor = Effect.fn('memory.memoryUriFor')(function* (
  config: RuntimeConfig,
  memory: string,
  metadata: MemoryMetadata,
) {
  const filename = shouldUseStableMemoryUri(metadata)
    ? `${uriSegment(metadata.topic ?? 'current')}.md`
    : `threadnote-${safeTimestamp()}-${(yield* sha256(memory)).slice(0, 12)}.md`;
  return `${memoryDirectoryUri(config, metadata)}/${filename}`;
});

function memoryDirectoryUri(config: RuntimeConfig, metadata: MemoryMetadata): string {
  const baseUri = `threadnote://user/${uriSegment(config.user)}/memories`;
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

const memoryWriteMode = Effect.fn('memory.memoryWriteMode')(function* (
  _ov: string,
  config: RuntimeConfig,
  memoryUri: string,
  metadata: MemoryMetadata,
) {
  if (!shouldUseStableMemoryUri(metadata)) {
    return 'create';
  }
  return (yield* resourceExists(NATIVE_RESOURCE_BACKEND, config, memoryUri)) ? 'replace' : 'create';
});

function resourceStoreLocation(config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>) {
  return {
    account: config.account,
    home: config.agentContextHome,
    user: config.user,
  };
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
  return trimmed.includes('/') ? (trimmed.split('/').at(-1) ?? trimmed) : trimmed;
}

function normalizeOptionalMetadata(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const legacySourceAccounts = Effect.fn('memory.legacySourceAccounts')(function* (
  config: RuntimeConfig,
  options: MigrateMemoriesOptions,
) {
  const explicitAccounts = options.sourceAccount?.filter(account => account.trim().length > 0) ?? [];
  if (explicitAccounts.length > 0) {
    return uniqueStrings(explicitAccounts);
  }
  if (options.allAccounts === true) {
    const accounts = yield* childDirectoryNames(yield* localDataRoot(config));
    return accounts.filter(account => !account.startsWith('_'));
  }
  return [config.account];
});

const legacyMemoryCandidates = Effect.fn('memory.legacyMemoryCandidates')(function* (
  config: RuntimeConfig,
  sourceAccounts: readonly string[],
) {
  const path = yield* Path.Path;
  const dataRoot = yield* localDataRoot(config);
  const candidates: LegacyMemoryCandidate[] = [];
  for (const sourceAccount of sourceAccounts) {
    const sessionRoot = path.join(dataRoot, sourceAccount, 'session');
    for (const sourceSession of yield* childDirectoryNames(sessionRoot)) {
      const historyRoot = path.join(sessionRoot, sourceSession, 'history');
      for (const sourceArchive of yield* childDirectoryNames(historyRoot)) {
        if (!sourceArchive.startsWith('archive_')) {
          continue;
        }
        const sourcePath = path.join(historyRoot, sourceArchive, 'messages.jsonl');
        for (const text of yield* legacyMemoryTexts(sourcePath)) {
          candidates.push({
            comparableHash: yield* sha256(comparableMemoryText(text)),
            hash: yield* sha256(text),
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
});

const legacyMemoryTexts = Effect.fn('memory.legacyMemoryTexts')(function* (sourcePath: string) {
  const raw = yield* readTextIfExists(sourcePath);
  if (!raw) {
    return [];
  }
  const memories: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }
    const parsed = Result.try((): unknown => JSON.parse(trimmedLine));
    if (Result.isFailure(parsed)) {
      continue;
    }
    const text = legacyMessageText(parsed.success)?.trim();
    if (text && isLegacyThreadnoteMemory(text)) {
      memories.push(text);
    }
  }
  return memories;
});

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

const existingDurableMemoryHashes = Effect.fn('memory.existingDurableMemoryHashes')(function* (config: RuntimeConfig) {
  const hashes = new Set<string>();
  yield* collectDurableMemoryHashes(yield* localDataRoot(config), hashes);
  return hashes;
});

const collectDurableMemoryHashes: (
  root: string,
  hashes: Set<string>,
) => Effect.Effect<void, unknown, Crypto.Crypto | FileSystem.FileSystem | Path.Path> = Effect.fn(
  'memory.collectDurableMemoryHashes',
)(function* (root: string, hashes: Set<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(root).pipe(Effect.option);
  if (entries._tag === 'None') {
    return;
  }
  for (const entry of entries.value) {
    const entryPath = path.join(root, entry);
    const info = yield* fs.stat(entryPath).pipe(Effect.option);
    if (info._tag === 'None') {
      continue;
    }
    if (info.value.type === 'Directory') {
      yield* collectDurableMemoryHashes(entryPath, hashes);
      continue;
    }
    if (
      info.value.type !== 'File' ||
      entry.startsWith('.') ||
      !entry.endsWith('.md') ||
      !isDurableMemoryPath(entryPath)
    ) {
      continue;
    }
    const content = yield* readTextIfExists(entryPath);
    if (content) {
      const trimmedContent = content.trim();
      hashes.add(yield* sha256(trimmedContent));
      hashes.add(yield* sha256(comparableMemoryText(trimmedContent)));
    }
  }
});

function isDurableMemoryPath(path: string): boolean {
  return path.replaceAll('\\', '/').split('/').includes('memories');
}

const childDirectoryNames = Effect.fn('memory.childDirectoryNames')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const entries = yield* fs.readDirectory(path).pipe(Effect.option);
  if (entries._tag === 'None') {
    return [];
  }
  const directories: string[] = [];
  for (const entry of entries.value) {
    const info = yield* fs.stat(pathService.join(path, entry)).pipe(Effect.option);
    if (info._tag === 'Some' && info.value.type === 'Directory') {
      directories.push(entry);
    }
  }
  return directories.sort();
});

const readTextIfExists = Effect.fn('memory.readTextIfExists')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (info._tag === 'None' || info.value.type !== 'File') {
    return undefined;
  }
  return yield* fs.readFileString(path).pipe(Effect.catch(() => Effect.succeed(undefined)));
});

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

const localDataRoot = Effect.fn('memory.localDataRoot')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, 'data');
});

const localUserMemoriesRoot = Effect.fn('memory.localUserMemoriesRoot')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  return path.join(yield* localDataRoot(config), config.account, 'user', uriSegment(config.user), 'memories');
});

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
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
    if (!uri) {
      continue;
    }
    const canonicalUri = parseResourceId(uri).canonicalUri;
    seen.add(canonicalUri);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

const buildHandoff = Effect.fn('memory.buildHandoff')(function* (options: HandoffOptions) {
  const path = yield* Path.Path;
  const repoRoot = (yield* gitValue(['rev-parse', '--show-toplevel'])) ?? (yield* getInvocationCwd());
  const branch = (yield* gitValue(['branch', '--show-current'], repoRoot)) ?? 'unknown';
  const commit = (yield* gitValue(['rev-parse', 'HEAD'], repoRoot)) ?? 'unknown';
  const status = (yield* gitValue(['status', '--short'], repoRoot)) ?? '';
  const diffStat = (yield* gitValue(['diff', '--stat', 'HEAD'], repoRoot)) ?? '';
  const touchedFiles = yield* gitTouchedFiles(repoRoot);
  const repoName = (yield* resolveRepoName(repoRoot)) ?? path.basename(repoRoot);
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
});

const gitTouchedFiles = Effect.fn('memory.gitTouchedFiles')(function* (cwd: string) {
  const changedFiles = yield* gitValue(['diff', '--name-only', 'HEAD'], cwd);
  const untrackedFiles = yield* gitValue(['ls-files', '--others', '--exclude-standard'], cwd);
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
});

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
