import {chmod, readFile, realpath, writeFile} from 'node:fs/promises';
import {basename, dirname, join, relative} from 'node:path';
import yaml from 'js-yaml';
import {DEFAULT_SEED_PATTERNS, MAX_SECRET_MATCHES_TO_PRINT, USER_MANIFEST_NAME} from './constants.js';
import {readSeedManifest, uriSegment} from './manifest.js';
import {withIdentity} from './runtime.js';
import type {
  InitManifestOptions,
  ProjectManifest,
  RuntimeConfig,
  SeedCandidate,
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

export async function runSeed(config: RuntimeConfig, options: SeedOptions): Promise<void> {
  const manifest = await readSeedManifest(config.manifestPath);
  const ignorePatterns = await loadIgnorePatterns();
  const ov = await openVikingCliForMode(options.dryRun === true);
  let importedCount = 0;
  let skippedCount = 0;

  for (const project of manifest.projects) {
    const projectRoot = expandPath(project.path);
    if (!(await exists(projectRoot))) {
      console.log(`WARN project missing: ${project.name} (${projectRoot})`);
      continue;
    }

    const candidates = await collectSeedCandidates(project, projectRoot, ignorePatterns);
    for (const candidate of candidates) {
      const importPath = await prepareSeedFile(config, candidate, options.dryRun === true);
      if (!importPath) {
        skippedCount += 1;
        continue;
      }
      const args = withIdentity(config, ['add-resource', importPath, '--to', candidate.destinationUri, '--wait']);
      await maybeRun(options.dryRun === true, ov, args);
      importedCount += 1;
    }
  }

  console.log(`Seed complete: ${importedCount} candidate(s), ${skippedCount} skipped for safety.`);
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

export async function runSeedSkills(config: RuntimeConfig, options: SeedOptions): Promise<void> {
  const ov = await openVikingCliForMode(options.dryRun === true);
  const skills = await collectSkillCandidates(config);
  const nativeMode = options.native === true;
  console.log(
    nativeMode
      ? 'Skill seed mode: native OpenViking skills. This requires a working VLM config.'
      : 'Skill seed mode: resource catalog. Use --native only after configuring a working VLM provider.',
  );
  for (const skill of skills) {
    console.log(`Skill ${skill.source}: ${skill.filePath}`);
    const args = nativeMode
      ? ['add-skill', skill.filePath, '--wait']
      : ['add-resource', skill.filePath, '--to', skillResourceUri(skill), '--wait'];
    await maybeRun(options.dryRun === true, ov, withIdentity(config, args));
  }
  console.log(`Skill seed complete: ${skills.length} unique skill(s).`);
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

async function collectSkillCandidates(config: RuntimeConfig): Promise<readonly SkillCandidate[]> {
  const sources: Array<{readonly pattern: string; readonly source: string}> = [
    {pattern: '~/.codex/skills/**/SKILL.md', source: 'codex-global'},
    {pattern: '~/.codex/plugins/cache/**/skills/**/SKILL.md', source: 'codex-plugin-cache'},
    {pattern: '~/.claude/skills/**/SKILL.md', source: 'claude-global'},
  ];

  try {
    const manifest = await readSeedManifest(config.manifestPath);
    for (const project of manifest.projects) {
      sources.push({
        pattern: `${project.path}/.claude/skills/**/SKILL.md`,
        source: `repo-local:${project.name}`,
      });
    }
  } catch (err: unknown) {
    console.log(`WARN cannot read manifest for repo-local skill discovery: ${errorMessage(err)}`);
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
      skills.push({filePath, hash, source: source.source});
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
  return `viking://resources/agent-skills/${uriSegment(skill.source)}/${uriSegment(basename(dirname(skill.filePath)))}-${skill.hash.slice(0, 12)}.md`;
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
