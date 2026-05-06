import {chmod, writeFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {readSeedManifest, uriSegment} from './manifest.js';
import {withIdentity} from './runtime.js';
import type {
  ForgetOptions,
  HandoffOptions,
  ListOptions,
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
