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
  formatShellCommand,
  getInputText,
  getInvocationCwd,
  gitValue,
  maybeRun,
  openVikingCliForMode,
  parentVikingUri,
  parsePositiveInteger,
  safeTimestamp,
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

async function storeMemory(config: RuntimeConfig, memory: string, dryRun: boolean): Promise<void> {
  const ov = await openVikingCliForMode(dryRun);
  const memoryPath = join(config.agentContextHome, 'last-memory.txt');
  if (dryRun) {
    console.log(memory);
    console.log('\nWould run:');
    console.log(formatShellCommand(ov, withIdentity(config, ['add-memory', memory])));
    return;
  }
  await writeFile(memoryPath, memory, {encoding: 'utf8', mode: 0o600});
  await chmod(memoryPath, 0o600);
  await maybeRun(false, ov, withIdentity(config, ['add-memory', memory]));
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
