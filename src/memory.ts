import {chmod, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {basename, join, sep} from 'node:path';
import {readSeedManifest, uriSegment} from './manifest.js';
import {withIdentity} from './runtime.js';
import type {
  ForgetOptions,
  HandoffOptions,
  ListOptions,
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

export async function runRemember(config: RuntimeConfig, options: RememberOptions): Promise<void> {
  const text = await getInputText(options.text, options.stdin === true);
  if (!text.trim()) {
    throw new Error('Provide memory text with --text or --stdin.');
  }
  const memory = [
    'MEMORY',
    `source_agent_client: ${options.sourceAgentClient ?? 'codex'}`,
    `timestamp: ${new Date().toISOString()}`,
    '',
    text.trim(),
  ].join('\n');
  await storeMemory(config, memory, options.dryRun === true);
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
        await writeDurableMemoryFile(ov, config, memoryUri, migrationPath);
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
  await printExactMemoryMatches(config, ov, options.query, options.dryRun === true);
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
  const handoff = await buildHandoff(options);
  await storeMemory(config, handoff, options.dryRun === true);
}

export async function runForget(config: RuntimeConfig, uri: string, options: ForgetOptions): Promise<void> {
  assertVikingUri(uri);
  const ov = await openVikingCliForMode(options.dryRun === true);
  await maybeRun(options.dryRun === true, ov, withIdentity(config, ['rm', uri]));
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
  dryRun: boolean,
): Promise<void> {
  const terms = exactRecallTerms(query);
  if (terms.length === 0) {
    return;
  }
  const scopes = [
    `viking://user/${uriSegment(config.user)}/memories`,
    `viking://agent/${uriSegment(config.agentId)}/memories`,
  ];
  const outputs: string[] = [];
  for (const term of terms) {
    for (const scope of scopes) {
      const args = withIdentity(config, ['grep', term, '--uri', scope, '--node-limit', '5']);
      if (dryRun) {
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

async function storeMemory(config: RuntimeConfig, memory: string, dryRun: boolean): Promise<void> {
  const ov = await openVikingCliForMode(dryRun);
  const memoryPath = join(config.agentContextHome, 'last-memory.txt');
  const memoryUri = durableMemoryUri(config, memory);
  if (dryRun) {
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
          'create',
          '--wait',
          '--timeout',
          '120',
        ]),
      ),
    );
    return;
  }
  await writeFile(memoryPath, memory, {encoding: 'utf8', mode: 0o600});
  await chmod(memoryPath, 0o600);
  await ensureDurableMemoryDirectory(ov, config);
  await writeDurableMemoryFile(ov, config, memoryUri, memoryPath);
  console.log(`Stored durable memory: ${memoryUri}`);
}

async function writeDurableMemoryFile(
  ov: string,
  config: RuntimeConfig,
  memoryUri: string,
  memoryPath: string,
): Promise<void> {
  const args = withIdentity(config, [
    'write',
    memoryUri,
    '--from-file',
    memoryPath,
    '--mode',
    'create',
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

async function vikingResourceExists(ov: string, config: RuntimeConfig, uri: string): Promise<boolean> {
  const stat = await runCommand(ov, withIdentity(config, ['stat', uri]), {allowFailure: true});
  return stat.exitCode === 0;
}

async function ensureDurableMemoryDirectory(ov: string, config: RuntimeConfig): Promise<void> {
  const directoryUri = durableMemoryDirectoryUri(config);
  const stat = await runCommand(ov, withIdentity(config, ['stat', directoryUri]), {allowFailure: true});
  if (stat.exitCode === 0) {
    return;
  }
  await maybeRun(
    false,
    ov,
    withIdentity(config, [
      'mkdir',
      directoryUri,
      '--description',
      'Threadnote durable handoffs, memories, and cross-agent notes.',
    ]),
  );
}

function durableMemoryUri(config: RuntimeConfig, memory: string): string {
  return `${durableMemoryDirectoryUri(config)}/threadnote-${safeTimestamp()}-${sha256(memory).slice(0, 12)}.md`;
}

function durableMemoryDirectoryUri(config: RuntimeConfig): string {
  return `viking://user/${uriSegment(config.user)}/memories/events`;
}

function migratedDurableMemoryUri(config: RuntimeConfig, hash: string): string {
  return `${durableMemoryDirectoryUri(config)}/threadnote-migrated-${hash.slice(0, 16)}.md`;
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

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function isResourceBusy(stderr: string, stdout: string): boolean {
  return `${stderr}\n${stdout}`.includes('resource is busy');
}

async function buildHandoff(options: HandoffOptions): Promise<string> {
  const repoRoot = (await gitValue(['rev-parse', '--show-toplevel'])) ?? getInvocationCwd();
  const branch = (await gitValue(['branch', '--show-current'], repoRoot)) ?? 'unknown';
  const status = (await gitValue(['status', '--short'], repoRoot)) ?? '';
  const diffStat = (await gitValue(['diff', '--stat', 'HEAD'], repoRoot)) ?? '';
  const touchedFiles = await gitTouchedFiles(repoRoot);
  return [
    'HANDOFF',
    `repo: ${basename(repoRoot)}`,
    `repo_path: ${repoRoot}`,
    `branch: ${branch || 'unknown'}`,
    `source_agent_client: ${options.sourceAgentClient ?? 'codex'}`,
    `timestamp: ${new Date().toISOString()}`,
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
