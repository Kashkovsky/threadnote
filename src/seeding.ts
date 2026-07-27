import {Cause, Console, Effect, FileSystem, Option, Path, Result} from 'effect';
import yaml from 'js-yaml';
import {DEFAULT_SEED_PATTERNS, SEED_STATE_FILE, USER_MANIFEST_NAME} from './constants.js';
import {buildGraphDocument, type DependencyFacts, extractDependencyFacts, resolveGraphEdges} from './graph.js';
import {applicationError} from './effect/errors.js';
import {ResourceStore, type ResourceStoreMutation, type ResourceStoreShape} from './effect/resource-store.js';
import {SystemInfo} from './effect/system.js';
import {readSeedManifest, uriSegment} from './manifest.js';
import {applyScrubber} from './scrubber.js';
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
  readonly project?: string;
  readonly sha256?: string;
  readonly size: number;
}

interface SeedStateFile {
  readonly files: Record<string, SeedStateEntry>;
  readonly version: 1;
}

const log = Console.log;
const MAX_SEED_CANDIDATES_PER_PROJECT = 20_000;
const MAX_SEED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SEED_WALK_ENTRIES_PER_PROJECT = 250_000;
const SEED_MUTATION_BATCH_SIZE = 16;

interface SeedCounters {
  failedProjects: number;
  imported: number;
  removed: number;
  skipped: number;
  unchanged: number;
}

interface SeedWalkBudget {
  candidates: number;
  entries: number;
}

interface PendingSeedMutation {
  readonly mutation: ResourceStoreMutation;
  readonly stateEntry?: SeedStateEntry;
  readonly stateUri: string;
}

export function runSeed(config: RuntimeConfig, options: SeedOptions) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifest = yield* readSeedManifest(config.manifestPath);
    const ignorePatterns = yield* loadIgnorePatterns();
    const store = yield* ResourceStore;
    const statePath = path.join(config.agentContextHome, SEED_STATE_FILE);
    const state: {files: Record<string, SeedStateEntry>; version: 1} =
      options.force === true ? {files: {}, version: 1} : yield* readSeedState(statePath);
    yield* Effect.try({
      try: () => assertUniqueProjectUriRoots(manifest.projects),
      catch: cause => applicationError('validate seed project URI roots', cause),
    });
    const projects = yield* Effect.try({
      try: () => filterProjects(manifest.projects, options.only),
      catch: cause => applicationError('filter seed projects', cause),
    });
    const counters: SeedCounters = {
      failedProjects: 0,
      imported: 0,
      removed: 0,
      skipped: 0,
      unchanged: 0,
    };
    const failedProjectNames: string[] = [];

    for (const project of projects) {
      const projectRoot = yield* expandPath(project.path);
      if (!(yield* fs.exists(projectRoot))) {
        yield* log(`WARN project missing: ${project.name} (${projectRoot})`);
        continue;
      }

      const result = yield* Effect.result(
        Effect.sandbox(
          seedProject({
            config,
            counters,
            ignorePatterns,
            manifest,
            options,
            project,
            projectRoot,
            state,
            store,
          }),
        ),
      );
      if (Result.isFailure(result)) {
        if (Cause.hasInterruptsOnly(result.failure)) {
          return yield* Effect.failCause(result.failure);
        }
        counters.failedProjects += 1;
        failedProjectNames.push(project.name);
        const error = Cause.squash(result.failure);
        yield* log(`ERROR project ${project.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (options.dryRun !== true) {
      yield* writeSeedState(statePath, state);
    }
    yield* log(
      `Seed complete: ${counters.imported} candidate(s), ${counters.unchanged} unchanged, ${counters.removed} stale removed, ${counters.skipped} skipped for safety, ${counters.failedProjects} project(s) failed.`,
    );
    if (counters.skipped > 0) {
      yield* log(
        `Seed safety summary: ${counters.skipped} file(s) were not seeded. Review the SKIP lines above for details.`,
      );
    }

    if (options.graph === true) {
      yield* seedDependencyGraphs(config, 'threadnote-native', manifest, projects, options.dryRun === true);
    }
    if (failedProjectNames.length > 0) {
      return yield* Effect.fail(
        applicationError(
          'seed projects',
          new Error(
            `${failedProjectNames.length} project(s) failed after the remaining projects were processed: ${failedProjectNames.join(', ')}`,
          ),
        ),
      );
    }
  });
}

const seedProject = Effect.fn('seeding.seedProject')(function* ({
  config,
  counters,
  ignorePatterns,
  manifest,
  options,
  project,
  projectRoot,
  state,
  store,
}: {
  readonly config: RuntimeConfig;
  readonly counters: SeedCounters;
  readonly ignorePatterns: readonly string[];
  readonly manifest: SeedManifest;
  readonly options: SeedOptions;
  readonly project: ProjectManifest;
  readonly projectRoot: string;
  readonly state: {files: Record<string, SeedStateEntry>; version: 1};
  readonly store: ResourceStoreShape;
}) {
  const currentUris = new Set<string>();
  const pending: PendingSeedMutation[] = [];
  const location = resourceStoreLocation(config);
  const flush = Effect.fn('seeding.flushMutations')(function* () {
    if (pending.length === 0 || options.dryRun === true) {
      return;
    }
    const batch = pending.splice(0);
    yield* store.mutate(
      location,
      batch.map(entry => entry.mutation),
    );
    for (const entry of batch) {
      if (entry.stateEntry === undefined) {
        delete state.files[entry.stateUri];
      } else {
        state.files[entry.stateUri] = entry.stateEntry;
      }
    }
  });
  const queue = Effect.fn('seeding.queueMutation')(function* (entry: PendingSeedMutation) {
    pending.push(entry);
    if (pending.length >= SEED_MUTATION_BATCH_SIZE) {
      yield* flush();
    }
  });

  yield* visitSeedCandidates(project, projectRoot, ignorePatterns, candidate =>
    Effect.gen(function* () {
      currentUris.add(candidate.destinationUri);
      const fileStat = yield* statSeedFile(candidate.filePath);
      const recorded = state.files[candidate.destinationUri];
      if (fileStat?.type === 'too-large') {
        yield* log(
          `SKIP ${candidate.projectName}/${candidate.relativePath}: file is ${fileStat.size} bytes; maximum seed file size is ${MAX_SEED_FILE_BYTES} bytes`,
        );
        if (recorded) {
          if (options.dryRun === true) {
            yield* log(`Would remove unsafe seeded resource: ${candidate.destinationUri}`);
          } else {
            yield* queue({
              mutation: {ignoreMissing: true, type: 'remove', uri: candidate.destinationUri},
              stateUri: candidate.destinationUri,
            });
          }
          counters.removed += 1;
        }
        counters.skipped += 1;
        return;
      }
      if (
        fileStat?.type === 'file' &&
        recorded &&
        recorded.mtimeMs === fileStat.mtimeMs &&
        recorded.size === fileStat.size &&
        recorded.sha256 === fileStat.sha256
      ) {
        counters.unchanged += 1;
        if (options.dryRun !== true && recorded.project !== project.name) {
          state.files[candidate.destinationUri] = {...recorded, project: project.name};
        }
        return;
      }
      const content = yield* prepareSeedContent(candidate);
      if (content === undefined) {
        if (recorded) {
          if (options.dryRun === true) {
            yield* log(`Would remove unsafe seeded resource: ${candidate.destinationUri}`);
          } else {
            yield* queue({
              mutation: {ignoreMissing: true, type: 'remove', uri: candidate.destinationUri},
              stateUri: candidate.destinationUri,
            });
          }
          counters.removed += 1;
        }
        counters.skipped += 1;
        return;
      }
      if (options.dryRun === true) {
        yield* log(`Would seed resource: ${candidate.filePath} -> ${candidate.destinationUri}`);
      } else {
        yield* queue({
          mutation: {
            content,
            options: {mode: 'upsert'},
            type: 'write',
            uri: candidate.destinationUri,
          },
          stateEntry:
            fileStat?.type === 'file'
              ? {
                  mtimeMs: fileStat.mtimeMs,
                  project: project.name,
                  sha256: fileStat.sha256,
                  size: fileStat.size,
                }
              : undefined,
          stateUri: candidate.destinationUri,
        });
      }
      counters.imported += 1;
    }),
  );
  yield* flush();

  for (const uri of Object.keys(state.files).filter(
    uri => seedStateEntryOwnedByProject(uri, state.files[uri]!, project, manifest.projects) && !currentUris.has(uri),
  )) {
    if (options.dryRun === true) {
      yield* log(`Would remove stale seeded resource: ${uri}`);
    } else {
      yield* queue({mutation: {ignoreMissing: true, type: 'remove', uri}, stateUri: uri});
    }
    counters.removed += 1;
  }
  yield* flush();
});

/**
 * Seeds a per-project `.graph.md` dependency-facts resource. Facts are extracted
 * from every manifest project (so cross-repo `[[project]]` edges resolve even
 * under --only), then a document is rendered and seeded for each target
 * project. Synthesized content is routed through the same secret scanner as
 * every other seeded file before it can reach the canonical store. Stored as a plain
 * resource, never a memory.
 */
export function seedDependencyGraphs(
  config: RuntimeConfig,
  _legacyOv: string,
  manifest: SeedManifest,
  targetProjects: readonly ProjectManifest[],
  dryRun: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
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
    const mutations: ResourceStoreMutation[] = [];
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
      const scrubbed = applyScrubber(document, {redact: true});
      if (scrubbed.blocker !== undefined) {
        skipped += 1;
        yield* log(`SKIP ${project.name}/.graph.md: possible secret (${scrubbed.blocker})`);
        continue;
      }
      const destinationUri = `${trimTrailingSlash(project.uri)}/.graph.md`;
      if (dryRun) {
        yield* log(`Would seed dependency facts: ${destinationUri} (${internalEdges.length} in-workspace edge(s))`);
        written += 1;
        continue;
      }
      mutations.push({content: scrubbed.cleaned, options: {mode: 'upsert'}, type: 'write', uri: destinationUri});
      written += 1;
    }
    if (!dryRun) {
      const store = yield* ResourceStore;
      yield* store.mutate(resourceStoreLocation(config), mutations);
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
    if (info._tag === 'None' || info.value.type !== 'File') {
      return undefined;
    }
    const size = Number(info.value.size);
    if (size > MAX_SEED_FILE_BYTES) {
      return {size, type: 'too-large' as const};
    }
    return {
      mtimeMs: Option.getOrElse(info.value.mtime, () => new Date(0)).getTime(),
      sha256: yield* sha256(yield* fs.readFile(path)),
      size,
      type: 'file' as const,
    };
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
          project: typeof entry.project === 'string' ? entry.project : undefined,
          sha256: typeof entry.sha256 === 'string' ? entry.sha256 : undefined,
          size: entry.size,
        };
      }
    }
    return {files, version: 1 as const};
  });
}

function assertUniqueProjectUriRoots(projects: readonly ProjectManifest[]): void {
  const ownerByRoot = new Map<string, string>();
  for (const project of projects) {
    const root = trimTrailingSlash(project.uri);
    const existing = ownerByRoot.get(root);
    if (existing !== undefined) {
      throw new Error(`Projects ${existing} and ${project.name} use the same seed URI root: ${root}.`);
    }
    ownerByRoot.set(root, project.name);
  }
}

function seedStateEntryOwnedByProject(
  uri: string,
  entry: SeedStateEntry,
  project: ProjectManifest,
  projects: readonly ProjectManifest[],
): boolean {
  if (entry.project !== undefined && projects.some(candidate => candidate.name === entry.project)) {
    return entry.project === project.name;
  }
  const matchingOwners = projects
    .filter(candidate => {
      const root = trimTrailingSlash(candidate.uri);
      return uri === root || uri.startsWith(`${root}/`);
    })
    .sort(
      (left, right) =>
        trimTrailingSlash(right.uri).length - trimTrailingSlash(left.uri).length || left.name.localeCompare(right.name),
    );
  return matchingOwners[0]?.name === project.name;
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
    const store = yield* ResourceStore;
    const catalogItems = yield* collectSkillCandidates(config);
    const mutations: ResourceStoreMutation[] = [];
    yield* log(
      options.native === true
        ? 'Skill seed mode: native Threadnote resource catalog (--native is retained as a compatibility alias).'
        : 'Skill seed mode: native Threadnote resource catalog.',
    );
    for (const skill of catalogItems) {
      yield* log(`${skill.kind === 'command' ? 'Command' : 'Skill'} ${skill.source}: ${skill.filePath}`);
      const destinationUri = skillResourceUri(skill);
      if (options.dryRun === true) {
        yield* log(`Would seed skill resource: ${skill.filePath} -> ${destinationUri}`);
      } else {
        mutations.push({
          content: skill.content,
          options: {mode: 'upsert'},
          type: 'write',
          uri: destinationUri,
        });
      }
    }
    if (options.dryRun !== true) {
      yield* store.mutate(resourceStoreLocation(config), mutations);
    }
    yield* log(`Skill seed complete: ${catalogItems.length} unique catalog item(s).`);
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
  let uri = `threadnote://resources/repos/${name}`;
  if (usedNames.has(name) || usedUris.has(uri)) {
    name = `${baseName}-${(yield* sha256(repoRoot)).slice(0, 8)}`;
    uri = `threadnote://resources/repos/${name}`;
  }
  return {
    name,
    path: yield* portablePath(repoRoot),
    seed: DEFAULT_SEED_PATTERNS,
    uri,
  };
});

const visitSeedCandidates = Effect.fn('seeding.visitSeedCandidates')(function* (
  project: ProjectManifest,
  projectRoot: string,
  ignorePatterns: readonly string[],
  visit: (candidate: SeedCandidate) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>,
) {
  const path = yield* Path.Path;
  const seen = new Set<string>();
  const budget: SeedWalkBudget = {candidates: 0, entries: 0};
  for (const pattern of project.seed) {
    yield* visitProjectPattern(projectRoot, pattern, ignorePatterns, budget, filePath =>
      Effect.gen(function* () {
        const relativePath = toPosixPath(path.relative(projectRoot, filePath));
        if (seen.has(relativePath)) {
          return;
        }
        seen.add(relativePath);
        budget.candidates += 1;
        if (budget.candidates > MAX_SEED_CANDIDATES_PER_PROJECT) {
          return yield* Effect.fail(
            new Error(
              `candidate limit exceeded (${MAX_SEED_CANDIDATES_PER_PROJECT}); narrow the project's seed patterns`,
            ),
          );
        }
        yield* visit({
          destinationUri: `${trimTrailingSlash(project.uri)}/${relativePath}`,
          filePath,
          projectName: project.name,
          relativePath,
        });
      }),
    );
  }
});

const visitProjectPattern = Effect.fn('seeding.visitProjectPattern')(function* (
  projectRoot: string,
  pattern: string,
  ignorePatterns: readonly string[],
  budget: SeedWalkBudget,
  visitFile: (filePath: string) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const normalizedPattern = toPosixPath(pattern);
  if (!hasGlob(normalizedPattern)) {
    const filePath = path.join(projectRoot, normalizedPattern);
    const relativePath = toPosixPath(path.relative(projectRoot, filePath));
    if ((yield* isFile(filePath)) && !matchesIgnore(relativePath, ignorePatterns)) {
      yield* visitFile(filePath);
    }
    return;
  }

  const globBase = getGlobBase(normalizedPattern);
  const basePath = path.join(projectRoot, globBase);
  if (!(yield* exists(basePath))) {
    return;
  }

  const regex = globToRegExp(normalizedPattern);
  const patternDepth = normalizedPattern.split('/').filter(segment => segment !== '' && segment !== '.').length;
  const recursiveGlob = normalizedPattern.includes('**');
  const explicitlyIncludedHiddenDirectories = new Set(
    normalizedPattern
      .split('/')
      .filter(segment => segment.startsWith('.') && segment !== '.' && segment !== '..' && !hasGlob(segment)),
  );
  const visitPath: (currentPath: string) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> = Effect.fn(
    'seeding.visitProjectPath',
  )(function* (currentPath: string) {
    const relativePath = toPosixPath(path.relative(projectRoot, currentPath));
    if (relativePath !== '' && matchesIgnore(relativePath, ignorePatterns)) {
      return;
    }
    const pathStat = yield* fs.stat(currentPath).pipe(Effect.option);
    if (pathStat._tag === 'None' || pathStat.value.type === 'SymbolicLink') {
      return;
    }
    if (pathStat.value.type === 'File') {
      if (regex.test(relativePath)) {
        yield* visitFile(currentPath);
      }
      return;
    }
    if (pathStat.value.type !== 'Directory') {
      return;
    }
    const directoryName = relativePath.split('/').at(-1) ?? '';
    if (
      directoryName.startsWith('.') &&
      relativePath !== '' &&
      !explicitlyIncludedHiddenDirectories.has(directoryName)
    ) {
      return;
    }
    const directoryDepth =
      relativePath === '' ? 0 : relativePath.split('/').filter(segment => segment !== '' && segment !== '.').length;
    if (!recursiveGlob && directoryDepth >= patternDepth) {
      return;
    }
    for (const entry of yield* fs.readDirectory(currentPath)) {
      const entryPath = path.join(currentPath, entry);
      const entryRelativePath = toPosixPath(path.relative(projectRoot, entryPath));
      if (matchesIgnore(entryRelativePath, ignorePatterns)) {
        continue;
      }
      budget.entries += 1;
      if (budget.entries > MAX_SEED_WALK_ENTRIES_PER_PROJECT) {
        return yield* Effect.fail(
          new Error(
            `filesystem traversal limit exceeded (${MAX_SEED_WALK_ENTRIES_PER_PROJECT} entries); narrow the project's seed patterns or extend .threadnoteignore`,
          ),
        );
      }
      yield* visitPath(entryPath);
    }
  });
  yield* visitPath(basePath);
});

const prepareSeedContent = Effect.fn('seeding.prepareSeedContent')(function* (candidate: SeedCandidate) {
  const fs = yield* FileSystem.FileSystem;
  const content = yield* fs.readFileString(candidate.filePath);
  const preRedactedContent = shouldRedactPath(candidate.relativePath)
    ? redactContent(candidate.relativePath, content)
    : content;
  const scrubbed = applyScrubber(preRedactedContent, {redact: true});
  if (scrubbed.blocker !== undefined) {
    yield* Console.log(
      `SKIP ${candidate.projectName}/${candidate.relativePath}: possible secret (${scrubbed.blocker})`,
    );
    return undefined;
  }

  return scrubbed.cleaned;
});

function resourceStoreLocation(config: RuntimeConfig) {
  return {
    account: config.account,
    home: config.agentContextHome,
    user: config.user,
  } as const;
}

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
      const scrubbed = applyScrubber(content, {redact: true});
      if (scrubbed.blocker !== undefined) {
        yield* Console.log(`SKIP skill with possible secret (${scrubbed.blocker}): ${filePath}`);
        continue;
      }
      const hash = yield* sha256(scrubbed.cleaned);
      if (seenHashes.has(hash)) {
        continue;
      }
      seenHashes.add(hash);
      skills.push({content: scrubbed.cleaned, filePath, hash, kind: source.kind, source: source.source});
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
  return `threadnote://resources/agent-skills/${uriSegment(skill.source)}/${skillResourceName(skill)}-${skill.hash.slice(0, 12)}.md`;
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
