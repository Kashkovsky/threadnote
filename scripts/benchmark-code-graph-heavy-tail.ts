import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Database} from 'bun:sqlite';
import {Effect, Exit, FileSystem, Path} from 'effect';
import {sha256HexSync} from '../src/crypto/sha256.js';
import {codeGraphLayout} from '../src/code_graph/layout.js';
import {CodeGraphIndexer} from '../src/code_graph/indexer.js';
import {resolveRepositoryIdentity} from '../src/code_graph/repository.js';
import {CodeGraphStore, type StoredCodeGraph} from '../src/code_graph/store.js';
import type {CodeGraphProgress} from '../src/code_graph/types.js';
import {runCommandEffect} from '../src/effect/command.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {SystemInfo} from '../src/effect/system.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import {
  CODE_GRAPH_HEAVY_TAIL_GENERATED_TYPESCRIPT_PATH,
  CODE_GRAPH_HEAVY_TAIL_JSON_PATH,
  CODE_GRAPH_HEAVY_TAIL_PROFILE,
  CODE_GRAPH_HEAVY_TAIL_SMOKE_PROFILE,
  codeGraphHeavyTailEligibleFiles,
  parseCodeGraphHeavyTailProfile,
  prepareCodeGraphHeavyTailFixture,
  type CodeGraphHeavyTailProfile,
} from './code-graph-heavy-tail-fixture.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const CHILD_OUTPUT_LIMIT_BYTES = 1_048_576;

interface HeavyTailLanguageTelemetry {
  readonly degradedFiles: number;
  readonly files: number;
  readonly parseMilliseconds: number;
  readonly persistenceMilliseconds: number;
  readonly relations: number;
  readonly sourceBytes: number;
  readonly symbols: number;
}

interface HeavyTailSlowFile {
  readonly bytes: number;
  readonly language: string;
  readonly parseMilliseconds: number;
  readonly path: string;
}

interface HeavyTailChildRun {
  readonly cache: {
    readonly factsBytes: number;
    readonly files: number;
    readonly lowSignalJsonFactsBytes: number;
  };
  readonly cpuMilliseconds: number;
  readonly durationMilliseconds: number;
  readonly graph?: {
    readonly digest: string;
    readonly edges: number;
    readonly files: number;
    readonly generatedTypeScriptTailPreserved: boolean;
    readonly lowSignalJsonSymbols: number;
    readonly pathologicalTypeScriptTails: number;
    readonly symbols: number;
    readonly textlessSvgSymbols: number;
  };
  readonly interruptedAfterPersistedFiles?: number;
  readonly languages: Readonly<Record<string, HeavyTailLanguageTelemetry>>;
  readonly peakRssBytes: number;
  readonly readingMilliseconds: number;
  readonly reusedFiles?: number;
  readonly slowFiles: readonly HeavyTailSlowFile[];
  readonly state: 'complete' | 'interrupted';
  readonly version: 1;
  readonly workerCount: number;
}

interface CodeGraphHeavyTailBenchmarkArtifact {
  readonly assertions: {
    readonly interruptionRetainedCache: true;
    readonly lowSignalJsonBounded: true;
    readonly parallelMatchesSingle: true;
    readonly pathologicalTypeScriptSurfacePreserved: true;
    readonly resumeMatchesClean: true;
    readonly resumeReusedCache: true;
    readonly textlessSvgMetadataPreserved: true;
  };
  readonly createdAt: string;
  readonly environment: {
    readonly architecture: string;
    readonly commit: string;
    readonly cpu: string;
    readonly dirty: boolean;
    readonly memoryBytes: number;
    readonly operatingSystem: string;
    readonly runtime: string;
    readonly runnerClass: string;
    readonly runnerIdentity: string;
  };
  readonly profile: CodeGraphHeavyTailProfile;
  readonly runs: {
    readonly interrupted: HeavyTailChildRun;
    readonly parallel: HeavyTailChildRun;
    readonly resumed: HeavyTailChildRun;
    readonly single: HeavyTailChildRun;
  };
  readonly suite: 'code-graph-large-monorepo-heavy-tail-v1';
  readonly version: 1;
}

interface BenchmarkArguments {
  readonly child: boolean;
  readonly home?: string;
  readonly interruptAfterPersistedFiles?: number;
  readonly outputPath?: string;
  readonly profilePath?: string;
  readonly repository?: string;
  readonly smoke: boolean;
  readonly workers?: number;
}

const benchmark = Effect.scoped(
  Effect.gen(function* () {
    const args = parseArguments(yield* scriptArguments());
    if (args.child) return yield* runChild(args);
    return yield* runParent(args);
  }),
);

const runParent = Effect.fn('benchmarkCodeGraphHeavyTail.parent')(function* (args: BenchmarkArguments) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const profile = args.smoke ? CODE_GRAPH_HEAVY_TAIL_SMOKE_PROFILE : CODE_GRAPH_HEAVY_TAIL_PROFILE;
  const fixture = yield* prepareCodeGraphHeavyTailFixture(profile);
  const profilePath = path.join(fixture.root, 'profile.json');
  yield* fs.writeFileString(profilePath, `${JSON.stringify(profile)}\n`);

  const childScript = yield* path.fromFileUrl(new URL('./benchmark-code-graph-heavy-tail.ts', import.meta.url));
  const single = yield* spawnChild({
    childScript,
    home: path.join(fixture.root, 'home-single'),
    name: 'single',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: 1,
  });
  const parallel = yield* spawnChild({
    childScript,
    home: path.join(fixture.root, 'home-parallel'),
    name: 'parallel',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: profile.parallelWorkers,
  });
  const resumeHome = path.join(fixture.root, 'home-resume');
  const interrupted = yield* spawnChild({
    childScript,
    home: resumeHome,
    interruptAfterPersistedFiles: profile.interruptAfterPersistedFiles,
    name: 'interrupted',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: profile.parallelWorkers,
  });
  const resumed = yield* spawnChild({
    childScript,
    home: resumeHome,
    name: 'resumed',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: profile.parallelWorkers,
  });

  validateCompletedRun('single-worker', single, profile);
  validateCompletedRun('parallel-worker', parallel, profile);
  validateCompletedRun('resumed', resumed, profile);
  if (interrupted.state !== 'interrupted' || interrupted.cache.files < 1) {
    return yield* Effect.fail(new Error('The interruption run did not retain any durable parser cache rows.'));
  }
  if ((resumed.reusedFiles ?? 0) < 1) {
    return yield* Effect.fail(new Error('The resumed run did not reuse facts persisted before interruption.'));
  }
  if (single.graph!.digest !== parallel.graph!.digest) {
    return yield* Effect.fail(new Error('Single-worker and parallel code graphs differ.'));
  }
  if (single.graph!.digest !== resumed.graph!.digest) {
    return yield* Effect.fail(new Error('Interrupted/resumed and clean code graphs differ.'));
  }

  const hardware = yield* system.hardwareInfo();
  const [commit, dirty] = yield* Effect.all(
    [git(process.cwd(), ['rev-parse', 'HEAD']), git(process.cwd(), ['status', '--porcelain'])],
    {concurrency: 2},
  );
  const artifact: CodeGraphHeavyTailBenchmarkArtifact = {
    assertions: {
      interruptionRetainedCache: true,
      lowSignalJsonBounded: true,
      parallelMatchesSingle: true,
      pathologicalTypeScriptSurfacePreserved: true,
      resumeMatchesClean: true,
      resumeReusedCache: true,
      textlessSvgMetadataPreserved: true,
    },
    createdAt: new Date().toISOString(),
    environment: {
      architecture: system.architecture,
      commit,
      cpu: hardware.cpuModel,
      dirty: dirty.length > 0,
      memoryBytes: hardware.memoryBytes,
      operatingSystem: hardware.operatingSystem,
      runtime: `bun/${system.runtimeVersion}`,
      runnerClass: process.env.THREADNOTE_BENCHMARK_RUNNER_CLASS?.trim() || 'local-unclassified',
      runnerIdentity: process.env.THREADNOTE_BENCHMARK_RUNNER_ID?.trim() || 'local',
    },
    profile,
    runs: {interrupted, parallel, resumed, single},
    suite: 'code-graph-large-monorepo-heavy-tail-v1',
    version: 1,
  };
  parseCodeGraphHeavyTailBenchmarkArtifact(artifact);
  if (args.outputPath) yield* atomicWrite(args.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  yield* printJson(artifact);
});

const runChild = Effect.fn('benchmarkCodeGraphHeavyTail.child')(function* (args: BenchmarkArguments) {
  const outputPath = required(args.outputPath, '--output');
  const repository = required(args.repository, '--repository');
  const home = required(args.home, '--home');
  const profilePath = required(args.profilePath, '--profile-file');
  const workerCount = args.workers ?? 1;
  parseCodeGraphHeavyTailProfile(yield* readJsonFile(profilePath));
  const path = yield* Path.Path;
  const indexer = yield* CodeGraphIndexer;
  const store = yield* CodeGraphStore;
  const identity = yield* resolveRepositoryIdentity(repository);
  const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
  const progress = new HeavyTailProgressTelemetry();
  const startedAt = process.hrtime.bigint();
  const startedCpu = process.cpuUsage();
  let interruptedAfterPersistedFiles: number | undefined;
  const exit = yield* Effect.exit(
    indexer.index({
      cwd: repository,
      onProgress: event =>
        Effect.sync(() => {
          progress.observe(event);
          if (
            args.interruptAfterPersistedFiles !== undefined &&
            event.phase === 'scanning' &&
            event.activity?.stage === 'persisting' &&
            event.activity.persistMilliseconds !== undefined
          ) {
            const persisted = event.completed + event.activity.batchCompleted;
            if (persisted >= args.interruptAfterPersistedFiles) {
              interruptedAfterPersistedFiles = persisted;
              return true;
            }
          }
          return false;
        }).pipe(
          Effect.flatMap(shouldInterrupt =>
            shouldInterrupt ? Effect.fail(new Error('Expected heavy-tail benchmark interruption.')) : Effect.void,
          ),
        ),
      threadnoteHome: home,
    }),
  );
  const durationMilliseconds = Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND;
  const cpu = process.cpuUsage(startedCpu);
  const cache = databaseCacheTelemetry(layout.databasePath);

  if (Exit.isFailure(exit)) {
    if (interruptedAfterPersistedFiles === undefined) return yield* Effect.failCause(exit.cause);
    const artifact: HeavyTailChildRun = {
      cache,
      cpuMilliseconds: (cpu.user + cpu.system) / 1_000,
      durationMilliseconds,
      interruptedAfterPersistedFiles,
      languages: progress.languages(),
      peakRssBytes: processPeakRssBytes(),
      readingMilliseconds: progress.readingMilliseconds,
      slowFiles: progress.slowFiles(),
      state: 'interrupted',
      version: 1,
      workerCount,
    };
    parseHeavyTailChildRun(artifact);
    yield* atomicWrite(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    return;
  }
  if (args.interruptAfterPersistedFiles !== undefined) {
    return yield* Effect.fail(new Error('The heavy-tail benchmark completed before its requested interruption.'));
  }
  const summary = exit.value;
  const graph = yield* store.loadGraph(layout.databasePath, summary.snapshot.id);
  const graphShape = heavyTailGraphShape(graph);
  const artifact: HeavyTailChildRun = {
    cache,
    cpuMilliseconds: (cpu.user + cpu.system) / 1_000,
    durationMilliseconds,
    graph: {
      ...graphShape,
      files: summary.snapshot.fileCount,
    },
    languages: progress.languages(),
    peakRssBytes: processPeakRssBytes(),
    readingMilliseconds: progress.readingMilliseconds,
    reusedFiles: summary.reusedFiles,
    slowFiles: progress.slowFiles(),
    state: 'complete',
    version: 1,
    workerCount,
  };
  parseHeavyTailChildRun(artifact);
  yield* atomicWrite(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
});

class HeavyTailProgressTelemetry {
  readonly #languages = new Map<string, MutableLanguageTelemetry>();
  readonly #slowFiles: HeavyTailSlowFile[] = [];
  readingMilliseconds = 0;

  observe(progress: CodeGraphProgress): void {
    if (progress.phase !== 'scanning') return;
    this.readingMilliseconds = Math.max(this.readingMilliseconds, progress.timings?.readingMilliseconds ?? 0);
    const activity = progress.activity;
    if (!activity) return;
    const language = this.#languages.get(activity.language) ?? {
      degradedFiles: 0,
      files: 0,
      parseMilliseconds: 0,
      persistenceMilliseconds: 0,
      relations: 0,
      sourceBytes: 0,
      symbols: 0,
    };
    this.#languages.set(activity.language, language);
    if (activity.stage === 'extracting' && activity.parseMilliseconds !== undefined) {
      language.files += 1;
      language.sourceBytes += activity.bytes;
      language.parseMilliseconds += activity.parseMilliseconds;
      language.symbols += activity.symbols ?? 0;
      language.relations += activity.relations ?? 0;
      if (activity.degraded) language.degradedFiles += 1;
      this.#slowFiles.push({
        bytes: activity.bytes,
        language: activity.language,
        parseMilliseconds: activity.parseMilliseconds,
        path: activity.path,
      });
    }
    if (activity.stage === 'persisting' && activity.persistMilliseconds !== undefined) {
      language.persistenceMilliseconds += activity.persistMilliseconds;
    }
  }

  languages(): Readonly<Record<string, HeavyTailLanguageTelemetry>> {
    return Object.fromEntries([...this.#languages.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  slowFiles(): readonly HeavyTailSlowFile[] {
    return [...this.#slowFiles]
      .sort((left, right) => right.parseMilliseconds - left.parseMilliseconds || left.path.localeCompare(right.path))
      .slice(0, 10);
  }
}

interface MutableLanguageTelemetry {
  degradedFiles: number;
  files: number;
  parseMilliseconds: number;
  persistenceMilliseconds: number;
  relations: number;
  sourceBytes: number;
  symbols: number;
}

function heavyTailGraphShape(graph: StoredCodeGraph) {
  const canonical = {
    edges: [...graph.edges].sort((left, right) => left.id.localeCompare(right.id)),
    symbols: [...graph.symbols].sort((left, right) => left.id.localeCompare(right.id)),
  };
  return {
    digest: sha256HexSync(JSON.stringify(canonical)),
    edges: graph.edges.length,
    generatedTypeScriptTailPreserved: graph.symbols.some(
      symbol =>
        symbol.path === CODE_GRAPH_HEAVY_TAIL_GENERATED_TYPESCRIPT_PATH && symbol.name === 'GeneratedSurfaceTail',
    ),
    lowSignalJsonSymbols: graph.symbols.filter(symbol => symbol.path === CODE_GRAPH_HEAVY_TAIL_JSON_PATH).length,
    pathologicalTypeScriptTails: graph.symbols.filter(
      symbol => symbol.path.startsWith('src/pathological-') && symbol.name.startsWith('PreservedTail'),
    ).length,
    symbols: graph.symbols.length,
    textlessSvgSymbols: graph.symbols.filter(symbol => /^assets\/icons\/icon-\d+\.svg$/.test(symbol.path)).length,
  } satisfies Omit<NonNullable<HeavyTailChildRun['graph']>, 'files'>;
}

function validateCompletedRun(name: string, run: HeavyTailChildRun, profile: CodeGraphHeavyTailProfile): void {
  if (run.state !== 'complete' || !run.graph) throw new Error(`${name} heavy-tail run did not complete.`);
  if (run.graph.lowSignalJsonSymbols !== 1 || run.cache.lowSignalJsonFactsBytes > 16 * 1_024) {
    throw new Error(`${name} heavy-tail run expanded low-signal JSON beyond the metadata-only contract.`);
  }
  if (run.graph.pathologicalTypeScriptTails !== profile.pathologicalTypeScriptFiles) {
    throw new Error(`${name} heavy-tail run lost declarations after pathological TypeScript calls.`);
  }
  if (!run.graph.generatedTypeScriptTailPreserved) {
    throw new Error(`${name} heavy-tail run lost declarations from generated TypeScript surface extraction.`);
  }
  if (run.graph.textlessSvgSymbols !== profile.textlessSvgFiles) {
    throw new Error(`${name} heavy-tail run did not preserve one metadata symbol per textless SVG.`);
  }
  if (run.graph.files !== codeGraphHeavyTailEligibleFiles(profile)) {
    throw new Error(`${name} heavy-tail run indexed ${run.graph.files} files; expected fixture shape mismatch.`);
  }
  if (Object.values(run.languages).some(language => language.degradedFiles > 0)) {
    throw new Error(`${name} heavy-tail run degraded one or more parser files.`);
  }
}

function databaseCacheTelemetry(databasePath: string): HeavyTailChildRun['cache'] {
  const database = new Database(databasePath, {readonly: true});
  try {
    const total = database
      .query('SELECT COUNT(*) AS files, COALESCE(SUM(length(facts_json)), 0) AS factsBytes FROM file_blobs')
      .get() as {readonly factsBytes: number; readonly files: number};
    const json = database
      .query('SELECT COALESCE(MAX(length(facts_json)), 0) AS factsBytes FROM file_blobs WHERE path_hint = ?')
      .get(CODE_GRAPH_HEAVY_TAIL_JSON_PATH) as {readonly factsBytes: number};
    return {
      factsBytes: Number(total.factsBytes),
      files: Number(total.files),
      lowSignalJsonFactsBytes: Number(json.factsBytes),
    };
  } finally {
    database.close();
  }
}

const spawnChild = Effect.fn('benchmarkCodeGraphHeavyTail.spawnChild')(function* (options: {
  readonly childScript: string;
  readonly home: string;
  readonly interruptAfterPersistedFiles?: number;
  readonly name: string;
  readonly profilePath: string;
  readonly repository: string;
  readonly root: string;
  readonly workers: number;
}) {
  const path = yield* Path.Path;
  const outputPath = path.join(options.root, `${options.name}.json`);
  const command = [
    process.execPath,
    options.childScript,
    '--child',
    '--repository',
    options.repository,
    '--home',
    options.home,
    '--profile-file',
    options.profilePath,
    '--workers',
    String(options.workers),
    '--output',
    outputPath,
  ];
  if (options.interruptAfterPersistedFiles !== undefined) {
    command.push('--interrupt-after-files', String(options.interruptAfterPersistedFiles));
  }
  const child = Bun.spawn({
    cmd: command,
    env: {...process.env, THREADNOTE_CODE_GRAPH_PARSER_WORKERS: String(options.workers)},
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
    Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
  );
  if (exitCode !== 0) {
    return yield* Effect.fail(
      new Error(
        `${options.name} heavy-tail child exited with ${exitCode}.\n` +
          boundedOutput('stdout', stdout) +
          boundedOutput('stderr', stderr),
      ),
    );
  }
  return parseHeavyTailChildRun(yield* readJsonFile(outputPath));
});

export function parseHeavyTailChildRun(value: unknown): HeavyTailChildRun {
  if (typeof value !== 'object' || value === null) throw new Error('Heavy-tail child artifact must be an object.');
  const artifact = value as Partial<HeavyTailChildRun>;
  if (
    artifact.version !== 1 ||
    !['complete', 'interrupted'].includes(artifact.state ?? '') ||
    !positiveInteger(artifact.workerCount) ||
    !nonNegativeNumber(artifact.durationMilliseconds) ||
    !nonNegativeNumber(artifact.cpuMilliseconds) ||
    !nonNegativeInteger(artifact.peakRssBytes) ||
    !nonNegativeNumber(artifact.readingMilliseconds) ||
    typeof artifact.cache !== 'object' ||
    artifact.cache === null ||
    !nonNegativeInteger(artifact.cache.files) ||
    !nonNegativeInteger(artifact.cache.factsBytes) ||
    !nonNegativeInteger(artifact.cache.lowSignalJsonFactsBytes) ||
    typeof artifact.languages !== 'object' ||
    artifact.languages === null ||
    !Array.isArray(artifact.slowFiles)
  ) {
    throw new Error('Heavy-tail child artifact is invalid.');
  }
  if (artifact.state === 'complete' && artifact.graph === undefined) {
    throw new Error('Completed heavy-tail child artifact must include a graph shape.');
  }
  if (artifact.state === 'interrupted' && !positiveInteger(artifact.interruptedAfterPersistedFiles)) {
    throw new Error('Interrupted heavy-tail child artifact must include its durable interruption point.');
  }
  return artifact as HeavyTailChildRun;
}

export function parseCodeGraphHeavyTailBenchmarkArtifact(value: unknown): CodeGraphHeavyTailBenchmarkArtifact {
  if (typeof value !== 'object' || value === null) throw new Error('Heavy-tail benchmark artifact must be an object.');
  const artifact = value as Partial<CodeGraphHeavyTailBenchmarkArtifact>;
  if (
    artifact.version !== 1 ||
    artifact.suite !== 'code-graph-large-monorepo-heavy-tail-v1' ||
    typeof artifact.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(artifact.createdAt)) ||
    typeof artifact.runs !== 'object' ||
    artifact.runs === null
  ) {
    throw new Error('Heavy-tail benchmark artifact is invalid.');
  }
  parseCodeGraphHeavyTailProfile(artifact.profile);
  parseHeavyTailChildRun(artifact.runs.single);
  parseHeavyTailChildRun(artifact.runs.parallel);
  parseHeavyTailChildRun(artifact.runs.interrupted);
  parseHeavyTailChildRun(artifact.runs.resumed);
  return artifact as CodeGraphHeavyTailBenchmarkArtifact;
}

function parseArguments(args: readonly string[]): BenchmarkArguments {
  let child = false;
  let home: string | undefined;
  let interruptAfterPersistedFiles: number | undefined;
  let outputPath: string | undefined;
  let profilePath: string | undefined;
  let repository: string | undefined;
  let smoke = false;
  let workers: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--child') child = true;
    else if (argument === '--home') home = required(args[++index], argument);
    else if (argument === '--interrupt-after-files') {
      interruptAfterPersistedFiles = integer(args[++index], argument, 1);
    } else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--profile-file') profilePath = required(args[++index], argument);
    else if (argument === '--repository') repository = required(args[++index], argument);
    else if (argument === '--smoke') smoke = true;
    else if (argument === '--workers') workers = integer(args[++index], argument, 1, 8);
    else throw new Error(`Unknown heavy-tail benchmark option: ${argument}`);
  }
  if (
    !child &&
    [home, profilePath, repository, workers, interruptAfterPersistedFiles].some(value => value !== undefined)
  ) {
    throw new Error('Child-only heavy-tail benchmark options require --child.');
  }
  if (child && smoke) throw new Error('--smoke is a parent benchmark option.');
  return {child, home, interruptAfterPersistedFiles, outputPath, profilePath, repository, smoke, workers};
}

function integer(
  value: string | undefined,
  option: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number.parseInt(required(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${option} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new Error(`${option} requires a value.`);
  return value;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function boundedOutput(label: string, output: string): string {
  if (!output) return '';
  const bytes = new TextEncoder().encode(output);
  const bounded =
    bytes.byteLength <= CHILD_OUTPUT_LIMIT_BYTES
      ? output
      : new TextDecoder().decode(bytes.slice(bytes.byteLength - CHILD_OUTPUT_LIMIT_BYTES));
  return `${label}:\n${bounded}\n`;
}

function processPeakRssBytes(): number {
  const maxRss = process.resourceUsage().maxRSS;
  return 'bun' in process.versions ? maxRss : maxRss * 1_024;
}

const git = Effect.fn('benchmarkCodeGraphHeavyTail.git')((cwd: string, args: readonly string[]) =>
  runCommandEffect('git', ['-C', cwd, ...args], {maxOutputBytes: 1_048_576, timeoutMs: 30_000}).pipe(
    Effect.map(result => result.stdout.trim()),
  ),
);

if (import.meta.main) BunRuntime.runMain(benchmark.pipe(Effect.provide(ApplicationLayer)));
