import {Console, Effect, FileSystem, Option, Path, Result} from 'effect';
import yaml from 'js-yaml';
import {
  DEFAULT_SEED_PATTERNS,
  MAX_SECRET_MATCHES_TO_PRINT,
  SEED_STATE_FILE,
  SEED_WATCH_INTERVAL_ENV,
  USER_MANIFEST_NAME,
} from './constants.js';
import {buildGraphDocument, type DependencyFacts, extractDependencyFacts, resolveGraphEdges} from './graph.js';
import {maybeRunEffect} from './effect/command.js';
import {applicationError} from './effect/errors.js';
import {SystemInfo} from './effect/system.js';
import {readSeedManifest, uriSegment} from './manifest.js';
import {withIdentity} from './runtime.js';
import {detectSecretMatches} from './scrubber.js';
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
  openVikingCliForMode,
  portablePath,
  redactText,
  resolveRepoName,
  sha256,
  toPosixPath,
  toolRoot,
  trimTrailingSlash,
  walkFiles,
} from './utils.js';

interface SeedStateEntry {
  readonly mtimeMs: number;
  readonly sha256?: string;
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

const log = Console.log;

export function runSeed(config: RuntimeConfig, options: SeedOptions) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const manifest = yield* readSeedManifest(config.manifestPath);
    const ignorePatterns = yield* loadIgnorePatterns();
    const ov = yield* openVikingCliForMode(options.dryRun === true);
    const watchIntervalMinutes = parseSeedWatchIntervalMinutes(system.environment()[SEED_WATCH_INTERVAL_ENV]);
    const statePath = path.join(config.agentContextHome, SEED_STATE_FILE);
    const state: {files: Record<string, SeedStateEntry>; version: 1} =
      options.force === true ? {files: {}, version: 1} : yield* readSeedState(statePath);
    const projects = yield* Effect.try({
      try: () => filterProjects(manifest.projects, options.only),
      catch: cause => applicationError('filter seed projects', cause),
    });
    let importedCount = 0;
    let skippedCount = 0;
    let unchangedCount = 0;

    for (const project of projects) {
      const projectRoot = yield* expandPath(project.path);
      if (!(yield* fs.exists(projectRoot))) {
        yield* log(`WARN project missing: ${project.name} (${projectRoot})`);
        continue;
      }

      const candidates = yield* collectSeedCandidates(project, projectRoot, ignorePatterns);
      for (const candidate of candidates) {
        const fileStat = yield* statSeedFile(candidate.filePath);
        const recorded = state.files[candidate.destinationUri];
        if (
          fileStat &&
          recorded &&
          recorded.mtimeMs === fileStat.mtimeMs &&
          recorded.size === fileStat.size &&
          recorded.sha256 === fileStat.sha256
        ) {
          unchangedCount += 1;
          continue;
        }
        const importPath = yield* prepareSeedFile(config, candidate, options.dryRun === true);
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
        yield* maybeRunEffect(options.dryRun === true, ov, args);
        importedCount += 1;
        if (fileStat && options.dryRun !== true) {
          state.files[candidate.destinationUri] = fileStat;
        }
      }
    }

    if (options.dryRun !== true) {
      yield* writeSeedState(statePath, state);
    }
    yield* log(
      `Seed complete: ${importedCount} candidate(s), ${unchangedCount} unchanged, ${skippedCount} skipped for safety.`,
    );

    if (options.graph === true) {
      yield* seedDependencyGraphs(config, ov, manifest, projects, options.dryRun === true);
    }
  });
}

/**
 * Seeds a per-project `.graph.md` dependency-facts resource. Facts are extracted
 * from every manifest project (so cross-repo `[[project]]` edges resolve even
 * under --only), then a document is rendered and seeded for each target
 * project. Synthesized content is routed through the same secret scanner as
 * every other seeded file before it can reach OpenViking. Stored as a plain
 * resource, never a memory.
 */
export function seedDependencyGraphs(
  config: RuntimeConfig,
  ov: string,
  manifest: SeedManifest,
  targetProjects: readonly ProjectManifest[],
  dryRun: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const factsByProject = new Map<string, DependencyFacts>();
    for (const project of manifest.projects) {
      const projectRoot = yield* expandPath(project.path);
      if (!(yield* fs.exists(projectRoot))) {
        continue;
      }
      factsByProject.set(project.name, yield* extractDependencyFacts(projectRoot));
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
      const {externalCount, internalEdges} = resolveGraphEdges(
        project.name,
        facts.dependencies,
        projectByPublishedName,
      );
      const document = buildGraphDocument({externalCount, facts, internalEdges, projectName: project.name});
      const secretMatches = detectSecretMatches(document);
      if (secretMatches.length > 0) {
        skipped += 1;
        yield* log(
          `SKIP ${project.name}/.graph.md: possible secret (${secretMatches
            .slice(0, MAX_SECRET_MATCHES_TO_PRINT)
            .join(', ')})`,
        );
        continue;
      }
      const destinationUri = `${trimTrailingSlash(project.uri)}/.graph.md`;
      if (dryRun) {
        yield* log(`Would seed dependency facts: ${destinationUri} (${internalEdges.length} in-workspace edge(s))`);
        written += 1;
        continue;
      }
      const graphPath = path.join(config.agentContextHome, 'graph', yield* graphCacheFileName(project.name));
      yield* fs.makeDirectory(path.dirname(graphPath), {recursive: true});
      yield* fs.writeFileString(graphPath, document, {mode: 0o600});
      yield* fs.chmod(graphPath, 0o600);
      yield* maybeRunEffect(
        false,
        ov,
        withIdentity(config, ['add-resource', graphPath, '--to', destinationUri, '--wait']),
      );
      written += 1;
    }
    yield* log(
      `Dependency graph seed complete: ${written} .graph.md resource(s)${skipped > 0 ? `, ${skipped} skipped for safety` : ''}.`,
    );
  });
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

function statSeedFile(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path).pipe(Effect.option);
    return info._tag === 'Some'
      ? {
          mtimeMs: Option.getOrElse(info.value.mtime, () => new Date(0)).getTime(),
          sha256: yield* sha256(yield* fs.readFile(path)),
          size: Number(info.value.size),
        }
      : undefined;
  });
}

function readSeedState(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path).pipe(
      Effect.catchIf(
        error => error.reason._tag === 'NotFound',
        () => Effect.succeed(undefined),
      ),
    );
    if (raw === undefined) {
      return {files: {}, version: 1} as const;
    }
    const parsedResult = Result.try(() => JSON.parse(raw) as Partial<SeedStateFile>);
    if (Result.isFailure(parsedResult)) {
      return {files: {}, version: 1} as const;
    }
    const parsed = parsedResult.success;
    if (parsed.version !== 1 || !isJsonObject(parsed.files)) {
      return {files: {}, version: 1} as const;
    }
    const files: Record<string, SeedStateEntry> = {};
    for (const [uri, entry] of Object.entries(parsed.files)) {
      if (isJsonObject(entry) && typeof entry.mtimeMs === 'number' && typeof entry.size === 'number') {
        files[uri] = {
          mtimeMs: entry.mtimeMs,
          sha256: typeof entry.sha256 === 'string' ? entry.sha256 : undefined,
          size: entry.size,
        };
      }
    }
    return {files, version: 1 as const};
  });
}

function writeSeedState(path: string, state: SeedStateFile) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
    yield* fs.writeFileString(path, `${JSON.stringify(state, undefined, 2)}\n`, {mode: 0o600});
  });
}

export function runInitManifest(config: RuntimeConfig, options: InitManifestOptions) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const manifestPath = yield* expandPath(
      options.path ??
        system.environment().THREADNOTE_MANIFEST ??
        path.join(config.agentContextHome, USER_MANIFEST_NAME),
    );
    const repoInputs = options.repo && options.repo.length > 0 ? options.repo : [yield* getInvocationCwd()];
    const existingManifest =
      options.replace === true || !(yield* fs.exists(manifestPath)) ? undefined : yield* readSeedManifest(manifestPath);
    const existingProjects = existingManifest?.projects ?? [];
    const projects = [...existingProjects];
    const seen = new Set<string>();

    for (const project of existingProjects) {
      seen.add(yield* projectIdentity(project.path));
    }

    for (const repoInput of repoInputs) {
      const repoRoot = yield* resolveRepoRoot(repoInput);
      const identity = yield* projectIdentity(repoRoot);
      if (seen.has(identity)) {
        yield* log(`Already in manifest: ${repoRoot}`);
        continue;
      }
      seen.add(identity);
      projects.push(yield* projectManifestForRepo(repoRoot, projects));
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
      yield* log(`# Would write ${manifestPath}`);
      yield* log(output.trimEnd());
      return;
    }

    yield* fs.makeDirectory(path.dirname(manifestPath), {recursive: true});
    yield* fs.writeFileString(manifestPath, output, {mode: 0o600});
    yield* fs.chmod(manifestPath, 0o600);
    yield* log(`Wrote manifest: ${manifestPath}`);
    yield* log('Seed with:');
    yield* log('  threadnote seed --dry-run');
    yield* log('  threadnote seed');
  });
}

export function runWorksetList(config: RuntimeConfig) {
  return Effect.gen(function* () {
    const manifest = yield* readSeedManifest(config.manifestPath);
    const worksets = manifest.worksets ?? [];
    if (worksets.length === 0) {
      yield* log(
        'No worksets defined. Add a top-level `worksets:` list to the seed manifest to group related projects.',
      );
      return;
    }
    yield* log(`Worksets (${worksets.length}):`);
    for (const workset of worksets) {
      const summary = workset.description ? ` — ${workset.description}` : '';
      yield* log(`- ${workset.name} (${workset.projects.length} project(s))${summary}`);
    }
  });
}

export function runWorksetShow(config: RuntimeConfig, name: string) {
  return Effect.gen(function* () {
    const manifest = yield* readSeedManifest(config.manifestPath);
    const workset = manifest.worksets?.find(entry => entry.name.toLowerCase() === name.toLowerCase());
    if (!workset) {
      return yield* Effect.fail(
        applicationError('show workset', new Error(`No workset named "${name}" in ${config.manifestPath}.`)),
      );
    }
    yield* log(`Workset: ${workset.name}`);
    if (workset.description) {
      yield* log(workset.description);
    }
    yield* log('Projects:');
    for (const memberName of workset.projects) {
      const project = manifest.projects.find(entry => entry.name.toLowerCase() === memberName.toLowerCase());
      yield* log(project ? `- ${project.name} (${project.uri})` : `- ${memberName} [not found in manifest projects]`);
    }
  });
}

export function runSeedSkills(config: RuntimeConfig, options: SeedOptions) {
  return Effect.gen(function* () {
    const ov = yield* openVikingCliForMode(options.dryRun === true);
    const catalogItems = yield* collectSkillCandidates(config);
    const nativeMode = options.native === true;
    yield* log(
      nativeMode
        ? 'Skill seed mode: native OpenViking skills. This requires a working VLM config.'
        : 'Skill seed mode: resource catalog. Use --native only after configuring a working VLM provider.',
    );
    let skippedCount = 0;
    for (const skill of catalogItems) {
      yield* log(`${skill.kind === 'command' ? 'Command' : 'Skill'} ${skill.source}: ${skill.filePath}`);
      if (nativeMode && skill.kind === 'command') {
        skippedCount += 1;
        yield* log(`SKIP command in native skill mode: ${skill.filePath}`);
        continue;
      }
      const args = nativeMode
        ? ['add-skill', skill.filePath, '--wait']
        : ['add-resource', skill.filePath, '--to', skillResourceUri(skill), '--wait'];
      yield* maybeRunEffect(options.dryRun === true, ov, withIdentity(config, args));
    }
    yield* log(
      `Skill seed complete: ${catalogItems.length - skippedCount} unique catalog item(s)${
        skippedCount > 0 ? `, ${skippedCount} skipped` : ''
      }.`,
    );
  });
}

export const resolveRepoRoot = Effect.fn('seeding.resolveRepoRoot')(function* (repoInput: string) {
  const inputPath = yield* expandPath(repoInput);
  if (!(yield* isDirectory(inputPath))) {
    return yield* Effect.fail(new Error(`Repo path is not a directory: ${inputPath}`));
  }
  return (yield* gitValue(['rev-parse', '--show-toplevel'], inputPath)) ?? inputPath;
});

const projectIdentity = Effect.fn('seeding.projectIdentity')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const expanded = yield* expandPath(path);
  return yield* fs.realPath(expanded).pipe(Effect.catch(() => Effect.succeed(expanded)));
});

export const projectManifestForRepo = Effect.fn('seeding.projectManifestForRepo')(function* (
  repoRoot: string,
  existingProjects: readonly ProjectManifest[],
) {
  const path = yield* Path.Path;
  const baseName = uriSegment((yield* resolveRepoName(repoRoot)) ?? path.basename(repoRoot));
  const usedNames = new Set(existingProjects.map(project => project.name));
  const usedUris = new Set(existingProjects.map(project => project.uri));
  let name = baseName;
  let uri = `viking://resources/repos/${name}`;
  if (usedNames.has(name) || usedUris.has(uri)) {
    name = `${baseName}-${(yield* sha256(repoRoot)).slice(0, 8)}`;
    uri = `viking://resources/repos/${name}`;
  }
  return {
    name,
    path: yield* portablePath(repoRoot),
    seed: DEFAULT_SEED_PATTERNS,
    uri,
  };
});

const collectSeedCandidates = Effect.fn('seeding.collectSeedCandidates')(function* (
  project: ProjectManifest,
  projectRoot: string,
  ignorePatterns: readonly string[],
) {
  const path = yield* Path.Path;
  const candidates: SeedCandidate[] = [];
  const seen = new Set<string>();
  for (const pattern of project.seed) {
    const files = yield* resolveProjectPattern(projectRoot, pattern);
    for (const filePath of files) {
      const relativePath = toPosixPath(path.relative(projectRoot, filePath));
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
});

const resolveProjectPattern = Effect.fn('seeding.resolveProjectPattern')(function* (
  projectRoot: string,
  pattern: string,
) {
  const path = yield* Path.Path;
  const normalizedPattern = toPosixPath(pattern);
  if (!hasGlob(normalizedPattern)) {
    const filePath = path.join(projectRoot, normalizedPattern);
    return (yield* isFile(filePath)) ? [filePath] : [];
  }

  const globBase = getGlobBase(normalizedPattern);
  const basePath = path.join(projectRoot, globBase);
  if (!(yield* exists(basePath))) {
    return [];
  }

  const regex = globToRegExp(normalizedPattern);
  const files = yield* walkFiles(basePath);
  return files.filter(filePath => regex.test(toPosixPath(path.relative(projectRoot, filePath))));
});

const prepareSeedFile = Effect.fn('seeding.prepareSeedFile')(function* (
  config: RuntimeConfig,
  candidate: SeedCandidate,
  dryRun: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const content = yield* fs.readFileString(candidate.filePath);
  const redactedContent = shouldRedactPath(candidate.relativePath)
    ? redactContent(candidate.relativePath, content)
    : content;
  const secretMatches = detectSecretMatches(redactedContent);
  if (secretMatches.length > 0) {
    yield* Console.log(
      `SKIP ${candidate.projectName}/${candidate.relativePath}: possible secret (${secretMatches
        .slice(0, MAX_SECRET_MATCHES_TO_PRINT)
        .join(', ')})`,
    );
    return undefined;
  }

  if (redactedContent === content) {
    return candidate.filePath;
  }

  const redactedPath = path.join(config.agentContextHome, 'redacted', candidate.projectName, candidate.relativePath);
  if (dryRun) {
    yield* Console.log(`Would write redacted copy: ${redactedPath}`);
    return redactedPath;
  }
  yield* ensureDirectory(path.dirname(redactedPath), false);
  yield* fs.writeFileString(redactedPath, redactedContent, {mode: 0o600});
  yield* fs.chmod(redactedPath, 0o600);
  return redactedPath;
});

const graphCacheFileName = Effect.fn('seeding.graphCacheFileName')(function* (projectName: string) {
  return `${uriSegment(projectName)}-${(yield* sha256(projectName)).slice(0, 8)}.graph.md`;
});

const collectSkillCandidates = Effect.fn('seeding.collectSkillCandidates')(function* (config: RuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
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

  const manifest = yield* readSeedManifest(config.manifestPath).pipe(Effect.option);
  if (manifest._tag === 'Some') {
    for (const project of manifest.value.projects) {
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
  } else {
    yield* Console.log('WARN cannot read manifest for repo-local skill/command discovery.');
  }

  const seenHashes = new Set<string>();
  const skills: SkillCandidate[] = [];
  for (const source of sources) {
    const files = yield* resolveAbsolutePattern(yield* expandPath(source.pattern));
    for (const filePath of files) {
      const content = yield* fs.readFileString(filePath);
      const matches = detectSecretMatches(content);
      if (matches.length > 0) {
        yield* Console.log(`SKIP skill with possible secret: ${filePath}`);
        continue;
      }
      const hash = yield* sha256(content);
      if (seenHashes.has(hash)) {
        continue;
      }
      seenHashes.add(hash);
      skills.push({filePath, hash, kind: source.kind, source: source.source});
    }
  }
  return skills;
});

const resolveAbsolutePattern = Effect.fn('seeding.resolveAbsolutePattern')(function* (pattern: string) {
  const normalizedPattern = toPosixPath(pattern);
  if (!hasGlob(normalizedPattern)) {
    return (yield* isFile(normalizedPattern)) ? [normalizedPattern] : [];
  }
  const globBase = getGlobBase(normalizedPattern);
  const basePath = globBase.startsWith('/') ? globBase : `/${globBase}`;
  if (!(yield* exists(basePath))) {
    return [];
  }
  const regex = globToRegExp(normalizedPattern);
  const files = yield* walkFiles(basePath);
  return files.filter(filePath => regex.test(toPosixPath(filePath)));
});

function skillResourceUri(skill: SkillCandidate): string {
  return `viking://resources/agent-skills/${uriSegment(skill.source)}/${skillResourceName(skill)}-${skill.hash.slice(0, 12)}.md`;
}

function skillResourceName(skill: SkillCandidate): string {
  const parts = toPosixPath(skill.filePath).split('/');
  const fileName = parts.at(-1) ?? skill.filePath;
  if (fileName.toLowerCase() === 'skill.md') {
    return uriSegment(parts.at(-2) ?? 'skill');
  }
  const extensionIndex = fileName.lastIndexOf('.');
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  return uriSegment(stem);
}

const loadIgnorePatterns = Effect.fn('seeding.loadIgnorePatterns')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fs.readFileString(path.join(yield* toolRoot(), '.threadnoteignore'));
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
});

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
    const parsed = Result.try((): unknown => JSON.parse(content));
    return Result.isSuccess(parsed)
      ? `${JSON.stringify(redactJsonValue(parsed.success), null, 2)}\n`
      : redactText(content);
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
