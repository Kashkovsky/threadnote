import {chmod, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, join, relative} from 'node:path';
import yaml from 'js-yaml';
import {
  DEFAULT_SEED_PATTERNS,
  MAX_SECRET_MATCHES_TO_PRINT,
  SEED_STATE_FILE,
  SEED_WATCH_INTERVAL_ENV,
  USER_MANIFEST_NAME,
} from './constants.js';
import {buildGraphDocument, type DependencyFacts, extractDependencyFacts, resolveGraphEdges} from './graph.js';
import {readSeedManifest, uriSegment} from './manifest.js';
import {withIdentity} from './runtime.js';
import type {
  InitManifestOptions,
  ProjectManifest,
  RuntimeConfig,
  SeedCandidate,
  SeedManifest,
  SeedOptions,
  SkillCandidate,
} from './types.js';
import {
  ensureDirectory,
  errorMessage,
  exists,
  expandPath,
  getGlobBase,
  getInvocationCwd,
  gitValue,
  globToRegExp,
  hasGlob,
  isDirectory,
  isFile,
  isJsonObject,
  maybeRun,
  openVikingCliForMode,
  portablePath,
  redactText,
  sha256,
  toPosixPath,
  toolRoot,
  trimTrailingSlash,
  walkFiles,
} from './utils.js';

interface SeedStateEntry {
  readonly mtimeMs: number;
  readonly size: number;
}

interface SeedStateFile {
  readonly files: Record<string, SeedStateEntry>;
  readonly version: 1;
}

/**
 * Reads the opt-in auto-refresh cadence (minutes) for seeded resources from
 * THREADNOTE_SEED_WATCH_INTERVAL. Returns undefined (watches off) unless the
 * value is a positive integer. When set, OpenViking re-ingests watched paths on
 * this cadence so seeded repo docs stay indexed without a manual `threadnote
 * seed`.
 */
export function parseSeedWatchIntervalMinutes(rawValue: string | undefined): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  const minutes = Number.parseInt(rawValue.trim(), 10);
  return Number.isInteger(minutes) && minutes > 0 ? minutes : undefined;
}

/**
 * `--watch-interval` args for a seed import, or [] when no watch should attach.
 * A watch only goes on the ORIGINAL file (importedOriginal) that is NOT
 * redaction-prone: OpenViking refreshes a watched path on its own schedule,
 * bypassing Threadnote's per-import secret scan/redaction. So we never watch a
 * redacted temp copy (its contents are frozen anyway) or a redaction-prone
 * path, and watches stay off entirely unless the user opted in via the env.
 */
export function seedWatchArgs(params: {
  readonly watchIntervalMinutes: number | undefined;
  readonly importedOriginal: boolean;
  readonly redactionProne: boolean;
}): readonly string[] {
  if (params.watchIntervalMinutes === undefined || !params.importedOriginal || params.redactionProne) {
    return [];
  }
  return ['--watch-interval', String(params.watchIntervalMinutes)];
}

export async function runSeed(config: RuntimeConfig, options: SeedOptions): Promise<void> {
  const manifest = await readSeedManifest(config.manifestPath);
  const ignorePatterns = await loadIgnorePatterns();
  const ov = await openVikingCliForMode(options.dryRun === true);
  const watchIntervalMinutes = parseSeedWatchIntervalMinutes(process.env[SEED_WATCH_INTERVAL_ENV]);
  const statePath = join(config.agentContextHome, SEED_STATE_FILE);
  const state: {files: Record<string, SeedStateEntry>; version: 1} =
    options.force === true ? {files: {}, version: 1} : await readSeedState(statePath);
  const projects = filterProjects(manifest.projects, options.only);
  let importedCount = 0;
  let skippedCount = 0;
  let unchangedCount = 0;

  for (const project of projects) {
    const projectRoot = expandPath(project.path);
    if (!(await exists(projectRoot))) {
      console.log(`WARN project missing: ${project.name} (${projectRoot})`);
      continue;
    }

    const candidates = await collectSeedCandidates(project, projectRoot, ignorePatterns);
    for (const candidate of candidates) {
      const fileStat = await statSeedFile(candidate.filePath);
      const recorded = state.files[candidate.destinationUri];
      if (fileStat && recorded && recorded.mtimeMs === fileStat.mtimeMs && recorded.size === fileStat.size) {
        unchangedCount += 1;
        continue;
      }
      const importPath = await prepareSeedFile(config, candidate, options.dryRun === true);
      if (!importPath) {
        skippedCount += 1;
        continue;
      }
      const args = withIdentity(config, [
        'add-resource',
        importPath,
        '--to',
        candidate.destinationUri,
        ...seedWatchArgs({
          watchIntervalMinutes,
          importedOriginal: importPath === candidate.filePath,
          redactionProne: shouldRedactPath(candidate.relativePath),
        }),
        '--wait',
      ]);
      await maybeRun(options.dryRun === true, ov, args);
      importedCount += 1;
      if (fileStat && options.dryRun !== true) {
        state.files[candidate.destinationUri] = {mtimeMs: fileStat.mtimeMs, size: fileStat.size};
      }
    }
  }

  if (options.dryRun !== true) {
    await writeSeedState(statePath, state);
  }
  console.log(
    `Seed complete: ${importedCount} candidate(s), ${unchangedCount} unchanged, ${skippedCount} skipped for safety.`,
  );

  if (options.graph === true) {
    await seedDependencyGraphs(config, ov, manifest, projects, options.dryRun === true);
  }
}

/**
 * Seeds a per-project `.graph.md` dependency-facts resource. Facts are extracted
 * from every manifest project (so cross-repo `[[project]]` edges resolve even
 * under --only), then a document is rendered and seeded for each target
 * project. Synthesized content is routed through the same secret scanner as
 * every other seeded file before it can reach OpenViking. Stored as a plain
 * resource, never a memory.
 */
export async function seedDependencyGraphs(
  config: RuntimeConfig,
  ov: string,
  manifest: SeedManifest,
  targetProjects: readonly ProjectManifest[],
  dryRun: boolean,
): Promise<void> {
  const factsByProject = new Map<string, DependencyFacts>();
  for (const project of manifest.projects) {
    const projectRoot = expandPath(project.path);
    if (!(await exists(projectRoot))) {
      continue;
    }
    factsByProject.set(project.name, await extractDependencyFacts(projectRoot));
  }
  const projectByPublishedName = new Map<string, string>();
  for (const [name, facts] of factsByProject) {
    if (facts.publishedName) {
      projectByPublishedName.set(facts.publishedName.toLowerCase(), name);
    }
  }

  let written = 0;
  let skipped = 0;
  for (const project of targetProjects) {
    const facts = factsByProject.get(project.name);
    if (!facts || facts.manifestFiles.length === 0) {
      continue;
    }
    const {externalCount, internalEdges} = resolveGraphEdges(project.name, facts.dependencies, projectByPublishedName);
    const document = buildGraphDocument({externalCount, facts, internalEdges, projectName: project.name});
    const secretMatches = detectSecretMatches(document);
    if (secretMatches.length > 0) {
      skipped += 1;
      console.log(
        `SKIP ${project.name}/.graph.md: possible secret (${secretMatches
          .slice(0, MAX_SECRET_MATCHES_TO_PRINT)
          .join(', ')})`,
      );
      continue;
    }
    const destinationUri = `${trimTrailingSlash(project.uri)}/.graph.md`;
    if (dryRun) {
      console.log(`Would seed dependency facts: ${destinationUri} (${internalEdges.length} in-workspace edge(s))`);
      written += 1;
      continue;
    }
    const graphPath = join(config.agentContextHome, 'graph', graphCacheFileName(project.name));
    await ensureDirectory(dirname(graphPath), false);
    await writeFile(graphPath, document, {encoding: 'utf8', mode: 0o600});
    await chmod(graphPath, 0o600);
    await maybeRun(false, ov, withIdentity(config, ['add-resource', graphPath, '--to', destinationUri, '--wait']));
    written += 1;
  }
  console.log(
    `Dependency graph seed complete: ${written} .graph.md resource(s)${skipped > 0 ? `, ${skipped} skipped for safety` : ''}.`,
  );
}

function filterProjects(
  projects: readonly ProjectManifest[],
  only: readonly string[] | undefined,
): readonly ProjectManifest[] {
  if (!only || only.length === 0) {
    return projects;
  }
  const known = new Set(projects.map(project => project.name));
  const missing = only.filter(name => !known.has(name));
  if (missing.length > 0) {
    const all = [...known].join(', ');
    throw new Error(`Unknown project(s) in --only: ${missing.join(', ')}. Manifest projects: ${all}`);
  }
  const want = new Set(only);
  return projects.filter(project => want.has(project.name));
}

async function statSeedFile(path: string): Promise<{readonly mtimeMs: number; readonly size: number} | undefined> {
  try {
    const result = await stat(path);
    return {mtimeMs: result.mtimeMs, size: result.size};
  } catch (_err: unknown) {
    return undefined;
  }
}

async function readSeedState(path: string): Promise<{files: Record<string, SeedStateEntry>; version: 1}> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SeedStateFile>;
    if (parsed.version !== 1 || !isJsonObject(parsed.files)) {
      return {files: {}, version: 1};
    }
    const files: Record<string, SeedStateEntry> = {};
    for (const [uri, entry] of Object.entries(parsed.files)) {
      if (isJsonObject(entry) && typeof entry.mtimeMs === 'number' && typeof entry.size === 'number') {
        files[uri] = {mtimeMs: entry.mtimeMs, size: entry.size};
      }
    }
    return {files, version: 1};
  } catch (_err: unknown) {
    return {files: {}, version: 1};
  }
}

async function writeSeedState(path: string, state: SeedStateFile): Promise<void> {
  await ensureDirectory(dirname(path), false);
  await writeFile(path, `${JSON.stringify(state, undefined, 2)}\n`, {encoding: 'utf8', mode: 0o600});
}

export async function runInitManifest(config: RuntimeConfig, options: InitManifestOptions): Promise<void> {
  const manifestPath = expandPath(
    options.path ?? process.env.THREADNOTE_MANIFEST ?? join(config.agentContextHome, USER_MANIFEST_NAME),
  );
  const repoInputs = options.repo && options.repo.length > 0 ? options.repo : [getInvocationCwd()];
  const existingManifest =
    options.replace === true || !(await exists(manifestPath)) ? undefined : await readSeedManifest(manifestPath);
  const existingProjects = existingManifest?.projects ?? [];
  const projects = [...existingProjects];
  const seen = new Set<string>();

  for (const project of existingProjects) {
    seen.add(await projectIdentity(project.path));
  }

  for (const repoInput of repoInputs) {
    const repoRoot = await resolveRepoRoot(repoInput);
    const identity = await projectIdentity(repoRoot);
    if (seen.has(identity)) {
      console.log(`Already in manifest: ${repoRoot}`);
      continue;
    }
    seen.add(identity);
    projects.push(projectManifestForRepo(repoRoot, projects));
  }

  const outputManifest: Record<string, unknown> = {
    version: 1,
    projects: projects.map(project => ({
      name: project.name,
      path: project.path,
      uri: project.uri,
      seed: [...project.seed],
    })),
  };
  if (existingManifest?.futureMonorepo) {
    const futureMonorepoKey = 'future_monorepo';
    const pathCandidatesKey = 'path_candidates';
    outputManifest[futureMonorepoKey] = {
      [pathCandidatesKey]: [...existingManifest.futureMonorepo.pathCandidates],
      uri: existingManifest.futureMonorepo.uri,
    };
  }
  if (existingManifest?.worksets) {
    outputManifest.worksets = existingManifest.worksets.map(workset => ({
      name: workset.name,
      ...(workset.description !== undefined ? {description: workset.description} : {}),
      projects: [...workset.projects],
    }));
  }
  const output = yaml.dump(outputManifest, {lineWidth: 120, noRefs: true});

  if (options.dryRun === true) {
    console.log(`# Would write ${manifestPath}`);
    console.log(output.trimEnd());
    return;
  }

  await ensureDirectory(dirname(manifestPath), false);
  await writeFile(manifestPath, output, {encoding: 'utf8', mode: 0o600});
  await chmod(manifestPath, 0o600);
  console.log(`Wrote manifest: ${manifestPath}`);
  console.log('Seed with:');
  console.log('  threadnote seed --dry-run');
  console.log('  threadnote seed');
}

export async function runWorksetList(config: RuntimeConfig): Promise<void> {
  const manifest = await readSeedManifest(config.manifestPath);
  const worksets = manifest.worksets ?? [];
  if (worksets.length === 0) {
    console.log(
      'No worksets defined. Add a top-level `worksets:` list to the seed manifest to group related projects.',
    );
    return;
  }
  console.log(`Worksets (${worksets.length}):`);
  for (const workset of worksets) {
    const summary = workset.description ? ` — ${workset.description}` : '';
    console.log(`- ${workset.name} (${workset.projects.length} project(s))${summary}`);
  }
}

export async function runWorksetShow(config: RuntimeConfig, name: string): Promise<void> {
  const manifest = await readSeedManifest(config.manifestPath);
  const workset = manifest.worksets?.find(entry => entry.name.toLowerCase() === name.toLowerCase());
  if (!workset) {
    throw new Error(`No workset named "${name}" in ${config.manifestPath}.`);
  }
  console.log(`Workset: ${workset.name}`);
  if (workset.description) {
    console.log(workset.description);
  }
  console.log('Projects:');
  for (const memberName of workset.projects) {
    const project = manifest.projects.find(entry => entry.name.toLowerCase() === memberName.toLowerCase());
    console.log(project ? `- ${project.name} (${project.uri})` : `- ${memberName} [not found in manifest projects]`);
  }
}

export async function runSeedSkills(config: RuntimeConfig, options: SeedOptions): Promise<void> {
  const ov = await openVikingCliForMode(options.dryRun === true);
  const catalogItems = await collectSkillCandidates(config);
  const nativeMode = options.native === true;
  console.log(
    nativeMode
      ? 'Skill seed mode: native OpenViking skills. This requires a working VLM config.'
      : 'Skill seed mode: resource catalog. Use --native only after configuring a working VLM provider.',
  );
  let skippedCount = 0;
  for (const skill of catalogItems) {
    console.log(`${skill.kind === 'command' ? 'Command' : 'Skill'} ${skill.source}: ${skill.filePath}`);
    if (nativeMode && skill.kind === 'command') {
      skippedCount += 1;
      console.log(`SKIP command in native skill mode: ${skill.filePath}`);
      continue;
    }
    const args = nativeMode
      ? ['add-skill', skill.filePath, '--wait']
      : ['add-resource', skill.filePath, '--to', skillResourceUri(skill), '--wait'];
    await maybeRun(options.dryRun === true, ov, withIdentity(config, args));
  }
  console.log(
    `Skill seed complete: ${catalogItems.length - skippedCount} unique catalog item(s)${
      skippedCount > 0 ? `, ${skippedCount} skipped` : ''
    }.`,
  );
}

export async function resolveRepoRoot(repoInput: string): Promise<string> {
  const inputPath = expandPath(repoInput);
  if (!(await isDirectory(inputPath))) {
    throw new Error(`Repo path is not a directory: ${inputPath}`);
  }
  return (await gitValue(['rev-parse', '--show-toplevel'], inputPath)) ?? inputPath;
}

async function projectIdentity(path: string): Promise<string> {
  const expanded = expandPath(path);
  try {
    return await realpath(expanded);
  } catch (_err: unknown) {
    return expanded;
  }
}

export function projectManifestForRepo(
  repoRoot: string,
  existingProjects: readonly ProjectManifest[],
): ProjectManifest {
  const baseName = uriSegment(basename(repoRoot));
  const usedNames = new Set(existingProjects.map(project => project.name));
  const usedUris = new Set(existingProjects.map(project => project.uri));
  let name = baseName;
  let uri = `viking://resources/repos/${name}`;
  if (usedNames.has(name) || usedUris.has(uri)) {
    name = `${baseName}-${sha256(repoRoot).slice(0, 8)}`;
    uri = `viking://resources/repos/${name}`;
  }
  return {
    name,
    path: portablePath(repoRoot),
    seed: DEFAULT_SEED_PATTERNS,
    uri,
  };
}

async function collectSeedCandidates(
  project: ProjectManifest,
  projectRoot: string,
  ignorePatterns: readonly string[],
): Promise<readonly SeedCandidate[]> {
  const candidates: SeedCandidate[] = [];
  const seen = new Set<string>();
  for (const pattern of project.seed) {
    const files = await resolveProjectPattern(projectRoot, pattern);
    for (const filePath of files) {
      const relativePath = toPosixPath(relative(projectRoot, filePath));
      if (seen.has(relativePath) || matchesIgnore(relativePath, ignorePatterns)) {
        continue;
      }
      seen.add(relativePath);
      candidates.push({
        destinationUri: `${trimTrailingSlash(project.uri)}/${relativePath}`,
        filePath,
        projectName: project.name,
        relativePath,
      });
    }
  }
  return candidates;
}

async function resolveProjectPattern(projectRoot: string, pattern: string): Promise<readonly string[]> {
  const normalizedPattern = toPosixPath(pattern);
  if (!hasGlob(normalizedPattern)) {
    const filePath = join(projectRoot, normalizedPattern);
    return (await isFile(filePath)) ? [filePath] : [];
  }

  const globBase = getGlobBase(normalizedPattern);
  const basePath = join(projectRoot, globBase);
  if (!(await exists(basePath))) {
    return [];
  }

  const regex = globToRegExp(normalizedPattern);
  const files = await walkFiles(basePath);
  return files.filter(filePath => regex.test(toPosixPath(relative(projectRoot, filePath))));
}

async function prepareSeedFile(
  config: RuntimeConfig,
  candidate: SeedCandidate,
  dryRun: boolean,
): Promise<string | undefined> {
  const content = await readFile(candidate.filePath, 'utf8');
  const redactedContent = shouldRedactPath(candidate.relativePath)
    ? redactContent(candidate.relativePath, content)
    : content;
  const secretMatches = detectSecretMatches(redactedContent);
  if (secretMatches.length > 0) {
    console.log(
      `SKIP ${candidate.projectName}/${candidate.relativePath}: possible secret (${secretMatches
        .slice(0, MAX_SECRET_MATCHES_TO_PRINT)
        .join(', ')})`,
    );
    return undefined;
  }

  if (redactedContent === content) {
    return candidate.filePath;
  }

  const redactedPath = join(config.agentContextHome, 'redacted', candidate.projectName, candidate.relativePath);
  if (dryRun) {
    console.log(`Would write redacted copy: ${redactedPath}`);
    return redactedPath;
  }
  await ensureDirectory(dirname(redactedPath), false);
  await writeFile(redactedPath, redactedContent, {encoding: 'utf8', mode: 0o600});
  await chmod(redactedPath, 0o600);
  return redactedPath;
}

function graphCacheFileName(projectName: string): string {
  return `${uriSegment(projectName)}-${sha256(projectName).slice(0, 8)}.graph.md`;
}

async function collectSkillCandidates(config: RuntimeConfig): Promise<readonly SkillCandidate[]> {
  const sources: Array<{
    readonly kind: SkillCandidate['kind'];
    readonly pattern: string;
    readonly source: string;
  }> = [
    {kind: 'skill', pattern: '~/.codex/skills/**/SKILL.md', source: 'codex-global'},
    {kind: 'skill', pattern: '~/.codex/plugins/cache/**/skills/**/SKILL.md', source: 'codex-plugin-cache'},
    {kind: 'skill', pattern: '~/.claude/skills/**/SKILL.md', source: 'claude-global'},
    {kind: 'command', pattern: '~/.claude/commands/**/*.md', source: 'claude-commands-global'},
  ];

  try {
    const manifest = await readSeedManifest(config.manifestPath);
    for (const project of manifest.projects) {
      sources.push({
        kind: 'skill',
        pattern: `${project.path}/.claude/skills/**/SKILL.md`,
        source: `repo-local:${project.name}`,
      });
      sources.push({
        kind: 'command',
        pattern: `${project.path}/.claude/commands/**/*.md`,
        source: `repo-local:${project.name}:claude-commands`,
      });
    }
  } catch (err: unknown) {
    console.log(`WARN cannot read manifest for repo-local skill/command discovery: ${errorMessage(err)}`);
  }

  const seenHashes = new Set<string>();
  const skills: SkillCandidate[] = [];
  for (const source of sources) {
    const files = await resolveAbsolutePattern(expandPath(source.pattern));
    for (const filePath of files) {
      const content = await readFile(filePath, 'utf8');
      const matches = detectSecretMatches(content);
      if (matches.length > 0) {
        console.log(`SKIP skill with possible secret: ${filePath}`);
        continue;
      }
      const hash = sha256(content);
      if (seenHashes.has(hash)) {
        continue;
      }
      seenHashes.add(hash);
      skills.push({filePath, hash, kind: source.kind, source: source.source});
    }
  }
  return skills;
}

async function resolveAbsolutePattern(pattern: string): Promise<readonly string[]> {
  const normalizedPattern = toPosixPath(pattern);
  if (!hasGlob(normalizedPattern)) {
    return (await isFile(normalizedPattern)) ? [normalizedPattern] : [];
  }
  const globBase = getGlobBase(normalizedPattern);
  const basePath = globBase.startsWith('/') ? globBase : `/${globBase}`;
  if (!(await exists(basePath))) {
    return [];
  }
  const regex = globToRegExp(normalizedPattern);
  const files = await walkFiles(basePath);
  return files.filter(filePath => regex.test(toPosixPath(filePath)));
}

function skillResourceUri(skill: SkillCandidate): string {
  return `viking://resources/agent-skills/${uriSegment(skill.source)}/${skillResourceName(skill)}-${skill.hash.slice(0, 12)}.md`;
}

function skillResourceName(skill: SkillCandidate): string {
  const fileName = basename(skill.filePath);
  if (fileName.toLowerCase() === 'skill.md') {
    return uriSegment(basename(dirname(skill.filePath)));
  }
  const extensionIndex = fileName.lastIndexOf('.');
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  return uriSegment(stem);
}

async function loadIgnorePatterns(): Promise<readonly string[]> {
  const raw = await readFile(join(toolRoot(), '.threadnoteignore'), 'utf8');
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

function matchesIgnore(relativePath: string, patterns: readonly string[]): boolean {
  const path = toPosixPath(relativePath);
  for (const pattern of patterns) {
    const normalizedPattern = toPosixPath(pattern);
    if (normalizedPattern.endsWith('/')) {
      const directory = normalizedPattern.slice(0, -1);
      if (path === directory || path.includes(`/${directory}/`) || path.startsWith(`${directory}/`)) {
        return true;
      }
      continue;
    }
    if (globToRegExp(normalizedPattern).test(path) || globToRegExp(`**/${normalizedPattern}`).test(path)) {
      return true;
    }
  }
  return false;
}

function shouldRedactPath(relativePath: string): boolean {
  const path = toPosixPath(relativePath);
  return (
    path.endsWith('.mcp.json') ||
    path.endsWith('config.toml') ||
    path.includes('/settings') ||
    path.includes('/settings.local')
  );
}

function redactContent(relativePath: string, content: string): string {
  if (relativePath.endsWith('.json')) {
    try {
      const parsed: unknown = JSON.parse(content);
      return `${JSON.stringify(redactJsonValue(parsed), null, 2)}\n`;
    } catch (_err: unknown) {
      return redactText(content);
    }
  }
  return redactText(content);
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => redactJsonValue(item));
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? '[REDACTED]' : redactJsonValue(nestedValue);
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|credential|authorization|api[_-]?key|client[_-]?secret|bearer/i.test(key);
}

export function detectSecretMatches(content: string): readonly string[] {
  const detectors: Array<{readonly label: string; readonly regex: RegExp}> = [
    {label: 'private-key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/},
    {label: 'openai-key', regex: /sk-[A-Za-z0-9_-]{24,}/},
    {label: 'github-token', regex: /gh[pousr]_[A-Za-z0-9_]{24,}/},
    {label: 'slack-token', regex: /xox[abprs]-[A-Za-z0-9-]{24,}/},
    {label: 'bearer-token', regex: /Bearer\s+[A-Za-z0-9._~+/=-]{24,}/i},
    {label: 'aws-access-key', regex: /AKIA[0-9A-Z]{16}/},
  ];
  const matches: string[] = [];
  for (const detector of detectors) {
    if (detector.regex.test(content)) {
      matches.push(detector.label);
    }
  }
  return matches;
}
