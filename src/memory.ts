import {chmod, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {basename, join, sep} from 'node:path';
import {readSeedManifest, uriSegment} from './manifest.js';
import {withIdentity} from './runtime.js';
import type {
  ArchiveOptions,
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
  expandPath,
  exactRecallTerms,
  formatShellCommand,
  getInputText,
  getInvocationCwd,
  gitValue,
  grepOutputHasMatches,
  isJsonObject,
  maybeRun,
  openVikingCliForMode,
  parentVikingUri,
  parsePositiveInteger,
  runCommand,
  safeTimestamp,
  sha256,
  sleep,
  trimTrailingSlash,
} from './utils.js';

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
  readonly dryRun: boolean;
  readonly metadata: MemoryMetadata;
  readonly replaceUri?: string;
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
    supersedes: options.replace,
    timestamp: new Date().toISOString(),
    topic: normalizeOptionalMetadata(options.topic),
  };
  const memory = formatMemoryDocument('MEMORY', metadata, text.trim());
  await storeMemory(config, memory, {dryRun: options.dryRun === true, metadata, replaceUri: options.replace});
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
  const ov = await openVikingCliForMode(options.dryRun === true);
  const inferredUri =
    options.uri ?? (options.inferScope === false ? undefined : await inferRecallUri(config, options.query));
  const args = ['search', options.query];
  if (inferredUri) {
    args.push('--uri', inferredUri);
    console.log(`Recall scope: ${inferredUri}`);
  }
  if (options.nodeLimit) {
    args.push('--node-limit', String(parsePositiveInteger(options.nodeLimit, 'node limit')));
  }
  await maybeRun(options.dryRun === true, ov, withIdentity(config, args));
  await printExactMemoryMatches(config, ov, options.query, {
    dryRun: options.dryRun === true,
    includeArchived: options.includeArchived === true,
  });
}

export async function runRead(config: RuntimeConfig, uri: string, options: ReadOptions): Promise<void> {
  assertVikingUri(uri);
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
  const {handoff, metadata} = await buildHandoff(options);
  await storeMemory(config, handoff, {dryRun: options.dryRun === true, metadata, replaceUri: options.replace});
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
    const archiveMemory = formatMemoryDocument(
      'MEMORY',
      fallbackMetadata,
      ['Archived original Threadnote memory.', '', '<original memory content would be read here>'].join('\n'),
    );
    await storeMemory(config, archiveMemory, {dryRun: true, metadata: fallbackMetadata});
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
  const archiveMemory = formatMemoryDocument(
    'MEMORY',
    metadata,
    ['Archived original Threadnote memory.', '', original].join('\n'),
  );
  await storeMemory(config, archiveMemory, {dryRun: false, metadata});
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
  const normalizedQuery = query.toLowerCase();
  if (/\bskills?\b/.test(normalizedQuery)) {
    const project = await inferProjectFromQuery(config, normalizedQuery);
    return project
      ? `viking://resources/agent-skills/repo-local-${uriSegment(project.name)}`
      : 'viking://resources/agent-skills';
  }

  const project = await inferProjectFromQuery(config, normalizedQuery);
  return project ? trimTrailingSlash(project.uri) : undefined;
}

async function inferProjectFromQuery(
  config: RuntimeConfig,
  normalizedQuery: string,
): Promise<ProjectManifest | undefined> {
  try {
    const manifest = await readSeedManifest(config.manifestPath);
    return manifest.projects.find(project => normalizedQuery.includes(project.name.toLowerCase()));
  } catch (_err: unknown) {
    return undefined;
  }
}

async function printExactMemoryMatches(
  config: RuntimeConfig,
  ov: string,
  query: string,
  options: {readonly dryRun: boolean; readonly includeArchived: boolean},
): Promise<void> {
  const terms = exactRecallTerms(query);
  if (terms.length === 0) {
    return;
  }
  const scopes = exactMemoryScopes(config, options.includeArchived);
  const outputs: string[] = [];
  for (const term of terms) {
    for (const scope of scopes) {
      const args = withIdentity(config, ['grep', term, '--uri', scope, '--node-limit', '5']);
      if (options.dryRun) {
        outputs.push(formatShellCommand(ov, args));
        continue;
      }
      const result = await runCommand(ov, args, {allowFailure: true});
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
      if (result.exitCode === 0 && grepOutputHasMatches(output)) {
        outputs.push(output);
      }
    }
  }
  if (outputs.length === 0) {
    return;
  }
  console.log('\nExact durable memory matches:');
  console.log(outputs.join('\n\n'));
}

async function storeMemory(config: RuntimeConfig, memory: string, options: StoreMemoryOptions): Promise<void> {
  if (options.replaceUri) {
    assertVikingUri(options.replaceUri);
  }
  const ov = await openVikingCliForMode(options.dryRun);
  const memoryPath = join(config.agentContextHome, 'last-memory.txt');
  const memoryUri = memoryUriFor(config, memory, options.metadata);
  const writeMode = await memoryWriteMode(ov, config, memoryUri, options.metadata);
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
    if (options.replaceUri && options.replaceUri !== memoryUri) {
      console.log(formatShellCommand(ov, withIdentity(config, ['rm', options.replaceUri])));
    }
    return;
  }
  await writeFile(memoryPath, memory, {encoding: 'utf8', mode: 0o600});
  await chmod(memoryPath, 0o600);
  await ensureMemoryDirectory(ov, config, memoryDirectoryUri(config, options.metadata));
  await writeDurableMemoryFile(ov, config, memoryUri, memoryPath, writeMode);
  console.log(`Stored memory: ${memoryUri}`);
  if (options.replaceUri && options.replaceUri !== memoryUri) {
    const removedReplacedMemory = await removeVikingResourceWithRetry(ov, config, options.replaceUri);
    if (removedReplacedMemory) {
      console.log(`Forgot replaced memory: ${options.replaceUri}`);
    } else {
      console.error(
        `Replacement stored, but the superseded memory is still processing. Retry later: threadnote forget ${options.replaceUri}`,
      );
    }
  } else if (options.replaceUri === memoryUri) {
    console.log(`Updated existing memory in place: ${memoryUri}`);
  }
}

async function writeDurableMemoryFile(
  ov: string,
  config: RuntimeConfig,
  memoryUri: string,
  memoryPath: string,
  writeMode: 'create' | 'replace',
): Promise<void> {
  const args = withIdentity(config, [
    'write',
    memoryUri,
    '--from-file',
    memoryPath,
    '--mode',
    writeMode,
    '--wait',
    '--timeout',
    '120',
  ]);
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
      return;
    }
    if (await vikingResourceExists(ov, config, memoryUri)) {
      console.log('OpenViking accepted the memory but returned before the wait completed; waiting for indexing.');
      await waitForOpenVikingQueue(ov, config);
      return;
    }
    if (!isResourceBusy(result.stderr, result.stdout) || attempt === 3) {
      throw new Error(`${formatShellCommand(ov, args)} failed: ${result.stderr || result.stdout}`);
    }
    await sleep(1000 * (attempt + 1));
  }
}

async function waitForOpenVikingQueue(ov: string, config: RuntimeConfig): Promise<void> {
  const result = await runCommand(ov, withIdentity(config, ['wait', '--timeout', '120']), {allowFailure: true});
  if (result.stdout.trim()) {
    console.log(result.stdout.trim());
  }
  if (result.stderr.trim()) {
    console.error(result.stderr.trim());
  }
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

function exactMemoryScopes(config: RuntimeConfig, includeArchived: boolean): readonly string[] {
  const userBase = `viking://user/${uriSegment(config.user)}/memories`;
  const scopes = [
    `${userBase}/preferences`,
    `${userBase}/durable/projects`,
    `${userBase}/handoffs/active`,
    `${userBase}/incidents/active`,
    `${userBase}/events`,
    `${userBase}/shared`,
    `viking://agent/${uriSegment(config.agentId)}/memories`,
  ];
  return includeArchived
    ? [...scopes, `${userBase}/durable/archived`, `${userBase}/handoffs/archived`, `${userBase}/incidents/archived`]
    : scopes;
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
): Promise<{readonly handoff: string; readonly metadata: MemoryMetadata}> {
  const repoRoot = (await gitValue(['rev-parse', '--show-toplevel'])) ?? getInvocationCwd();
  const branch = (await gitValue(['branch', '--show-current'], repoRoot)) ?? 'unknown';
  const status = (await gitValue(['status', '--short'], repoRoot)) ?? '';
  const diffStat = (await gitValue(['diff', '--stat', 'HEAD'], repoRoot)) ?? '';
  const touchedFiles = await gitTouchedFiles(repoRoot);
  const repoName = basename(repoRoot);
  const metadata: MemoryMetadata = {
    kind: 'handoff',
    project: normalizeOptionalMetadata(options.project) ?? repoName,
    sourceAgentClient: options.sourceAgentClient ?? 'codex',
    status: 'active',
    supersedes: options.replace,
    timestamp: new Date().toISOString(),
    topic: normalizeOptionalMetadata(options.topic),
  };
  const body = [
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
  return {handoff: formatMemoryDocument('HANDOFF', metadata, body), metadata};
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
