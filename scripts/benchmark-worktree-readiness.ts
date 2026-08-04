import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {cpus, platform, release, tmpdir, totalmem} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';

const DEFAULT_CANDIDATE_REF = 'v4.0.1';
const DEFAULT_SAMPLES = 5;
const DEFAULT_WARMUPS = 1;
const FIXTURE_QUERY = 'compareVersions';
const FIXTURE_QUERY_PATH = 'src/version_compare.ts';
const INDEX_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1_024 * 1_024;
const PARSER_WORKERS = 4;

type ScenarioName = 'graphEquivalentCommit' | 'oneFileChange';
type RuntimeName = 'baseline' | 'candidate';

interface BenchmarkOptions {
  readonly baselineRef?: string;
  readonly candidateRef: string;
  readonly outputPath?: string;
  readonly samples: number;
  readonly warmups: number;
}

interface RuntimeCheckout {
  readonly commit: string;
  readonly home: string;
  readonly name: RuntimeName;
  readonly root: string;
}

interface FixtureCheckout {
  readonly primary: string;
  readonly runtime: RuntimeCheckout;
  readonly worktreeRoot: string;
}

interface GraphShape {
  readonly edges: number;
  readonly files: number;
  readonly symbols: number;
}

interface Observation {
  readonly durationMilliseconds: number;
  readonly graph: GraphShape;
  readonly materializationMode: string;
  readonly queryDigest: string;
  readonly reusedFiles: number;
  readonly stagedFiles: number;
  readonly totalFiles: number;
}

interface Summary {
  readonly maximumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly minimumMilliseconds: number;
  readonly samples: number;
}

interface ScenarioEvidence {
  readonly baseline: Summary & {
    readonly materializationModes: readonly string[];
    readonly observations: readonly Observation[];
    readonly stagedFiles: readonly number[];
  };
  readonly candidate: Summary & {
    readonly materializationModes: readonly string[];
    readonly observations: readonly Observation[];
    readonly stagedFiles: readonly number[];
  };
  readonly graphParityPassed: true;
  readonly medianSpeedup: number;
  readonly percentFaster: number;
  readonly queryParityPassed: true;
}

const options = parseArguments(process.argv.slice(2));
const repositoryRoot = gitTopLevel(process.cwd());
const candidateCommit = git(repositoryRoot, ['rev-parse', '--verify', `${options.candidateRef}^{commit}`]);
const baselineRef = options.baselineRef ?? `${candidateCommit}^`;
const baselineCommit = git(repositoryRoot, ['rev-parse', '--verify', `${baselineRef}^{commit}`]);
if (candidateCommit === baselineCommit) throw new Error('Candidate and baseline commits must differ.');
git(repositoryRoot, ['merge-base', '--is-ancestor', baselineCommit, candidateCommit]);

const temporaryRoot = mkdtempSync(join(tmpdir(), 'threadnote-worktree-readiness-'));
const runtimeRoots: string[] = [];
try {
  progress(`Preparing exact runtime checkouts in ${temporaryRoot}`);
  const baseline = prepareRuntime('baseline', baselineCommit);
  const candidate = prepareRuntime('candidate', candidateCommit);
  const fixtures = {
    baseline: prepareFixture(baseline),
    candidate: prepareFixture(candidate),
  } as const;

  progress('Building the shared warm anchor for each runtime');
  const anchorObservations = {
    baseline: runIndex(baseline, fixtures.baseline.primary),
    candidate: runIndex(candidate, fixtures.candidate.primary),
  } as const;
  assertParity(anchorObservations.baseline, anchorObservations.candidate, 'warm anchor');

  const scenarios = {
    graphEquivalentCommit: runScenario('graphEquivalentCommit', fixtures),
    oneFileChange: runScenario('oneFileChange', fixtures),
  } satisfies Record<ScenarioName, ScenarioEvidence>;

  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: {
      name: 'warm-linked-worktree-lexical-readiness',
      description:
        'Elapsed wall time from invoking graph index in a newly linked worktree until a current lexical snapshot is ready.',
      excludes: ['cold anchor construction', 'dependency installation', 'optional vector enrichment'],
      order: 'Alternating same-machine runs; candidate first for even samples and baseline first for odd samples.',
      samples: options.samples,
      warmups: options.warmups,
    },
    source: {
      repository: 'Kashkovsky/threadnote',
      repositoryUrl: 'https://github.com/Kashkovsky/threadnote',
      fixtureCommit: candidateCommit,
      candidate: {commit: candidateCommit, ref: options.candidateRef},
      baseline: {commit: baselineCommit, ref: baselineRef},
      harness: {
        path: 'scripts/benchmark-worktree-readiness.ts',
        sha256: sha256(readFileSync(new URL(import.meta.url))),
      },
    },
    environment: {
      architecture: process.arch,
      bun: Bun.version,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: cpus().length,
      memoryBytes: totalmem(),
      operatingSystem: `${platform()} ${release()}`,
      parserWorkers: PARSER_WORKERS,
      runner: 'same-machine-local-source',
    },
    anchor: {
      graphParityPassed: true,
      baseline: anchorObservations.baseline.graph,
      candidate: anchorObservations.candidate.graph,
    },
    scenarios,
  } as const;

  validateArtifact(artifact);
  const json = `${JSON.stringify(artifact, undefined, 2)}\n`;
  if (options.outputPath) atomicWrite(resolve(options.outputPath), json);
  process.stdout.write(json);
} finally {
  for (const runtimeRoot of runtimeRoots.reverse()) {
    rmSync(runtimeRoot, {force: true, recursive: true});
  }
  rmSync(temporaryRoot, {force: true, recursive: true});
}

function prepareRuntime(name: RuntimeName, commit: string): RuntimeCheckout {
  const root = join(temporaryRoot, `runtime-${name}`);
  runtimeRoots.push(root);
  cloneAtCommit(repositoryRoot, root, commit);
  progress(`Installing frozen dependencies for ${name} ${commit.slice(0, 12)}`);
  command('bun', ['install', '--frozen-lockfile', '--ignore-scripts'], root, 5 * 60 * 1_000);
  if (git(root, ['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new Error(`${name} runtime checkout changed during dependency installation.`);
  }
  return {
    commit,
    home: join(temporaryRoot, `home-${name}`),
    name,
    root,
  };
}

function prepareFixture(runtime: RuntimeCheckout): FixtureCheckout {
  const primary = join(temporaryRoot, `fixture-${runtime.name}`);
  cloneAtCommit(repositoryRoot, primary, candidateCommit);
  git(primary, ['switch', '--create', 'worktree-readiness-benchmark']);
  git(primary, ['config', 'user.name', 'Threadnote Benchmark']);
  git(primary, ['config', 'user.email', 'benchmark@threadnote.local']);
  return {
    primary,
    runtime,
    worktreeRoot: join(temporaryRoot, `worktrees-${runtime.name}`),
  };
}

function runScenario(
  scenario: ScenarioName,
  fixtures: Readonly<Record<RuntimeName, FixtureCheckout>>,
): ScenarioEvidence {
  const observations: Record<RuntimeName, Observation[]> = {baseline: [], candidate: []};
  const totalRuns = options.warmups + options.samples;
  for (let run = 0; run < totalRuns; run += 1) {
    const measured = run >= options.warmups;
    const sample = run - options.warmups;
    const logicalRun = `${scenario}-${run + 1}`;
    for (const fixture of Object.values(fixtures)) prepareScenarioCommit(fixture, scenario, run);
    const worktrees = {
      baseline: addLinkedWorktree(fixtures.baseline, logicalRun),
      candidate: addLinkedWorktree(fixtures.candidate, logicalRun),
    } as const;
    const order: readonly RuntimeName[] = run % 2 === 0 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    const current: Partial<Record<RuntimeName, Observation>> = {};
    try {
      for (const name of order) {
        progress(
          `${scenario} ${measured ? `sample ${sample + 1}/${options.samples}` : `warmup ${run + 1}/${options.warmups}`} · ${name}`,
        );
        current[name] = runIndex(fixtures[name].runtime, worktrees[name]);
      }
    } finally {
      removeLinkedWorktree(fixtures.baseline, worktrees.baseline);
      removeLinkedWorktree(fixtures.candidate, worktrees.candidate);
    }
    const baseline = requireObservation(current.baseline, `${logicalRun} baseline`);
    const candidate = requireObservation(current.candidate, `${logicalRun} candidate`);
    assertParity(baseline, candidate, logicalRun);
    assertExpectedMode(scenario, baseline, candidate);
    if (measured) {
      observations.baseline.push(baseline);
      observations.candidate.push(candidate);
    }
  }
  const baseline = summarize(observations.baseline.map(value => value.durationMilliseconds));
  const candidate = summarize(observations.candidate.map(value => value.durationMilliseconds));
  const medianSpeedup = baseline.medianMilliseconds / candidate.medianMilliseconds;
  return {
    baseline: {
      ...baseline,
      materializationModes: unique(observations.baseline.map(value => value.materializationMode)),
      observations: observations.baseline,
      stagedFiles: observations.baseline.map(value => value.stagedFiles),
    },
    candidate: {
      ...candidate,
      materializationModes: unique(observations.candidate.map(value => value.materializationMode)),
      observations: observations.candidate,
      stagedFiles: observations.candidate.map(value => value.stagedFiles),
    },
    graphParityPassed: true,
    medianSpeedup,
    percentFaster: (1 - candidate.medianMilliseconds / baseline.medianMilliseconds) * 100,
    queryParityPassed: true,
  };
}

function prepareScenarioCommit(fixture: FixtureCheckout, scenario: ScenarioName, run: number): void {
  if (scenario === 'oneFileChange') {
    appendFileSync(
      join(fixture.primary, FIXTURE_QUERY_PATH),
      `\n// Threadnote worktree-readiness benchmark sample ${run + 1}.\n`,
    );
    git(fixture.primary, ['add', FIXTURE_QUERY_PATH]);
  }
  const date = new Date(Date.UTC(2026, 7, 4, scenario === 'graphEquivalentCommit' ? 1 : 2, run, 0)).toISOString();
  const environment = {
    ...process.env,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  command(
    'git',
    ['commit', '--allow-empty', '--quiet', '--message', `${scenario} benchmark sample ${run + 1}`],
    fixture.primary,
    30_000,
    environment,
  );
}

function addLinkedWorktree(fixture: FixtureCheckout, logicalRun: string): string {
  const worktree = join(fixture.worktreeRoot, logicalRun);
  git(fixture.primary, ['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD']);
  return worktree;
}

function removeLinkedWorktree(fixture: FixtureCheckout, worktree: string): void {
  if (!worktree.startsWith(`${fixture.worktreeRoot}/`)) {
    throw new Error(`Refusing to remove an unexpected worktree path: ${worktree}`);
  }
  git(fixture.primary, ['worktree', 'remove', '--force', worktree]);
}

function runIndex(runtime: RuntimeCheckout, cwd: string): Observation {
  const started = process.hrtime.bigint();
  const output = runThreadnote(runtime, ['--log-level', 'none', 'graph', 'index', '--cwd', cwd, '--json']);
  const durationMilliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;
  const summary = finalJsonRecord(output, 'code-graph-index');
  const snapshot = record(summary.snapshot, 'snapshot');
  const materialization = record(summary.materialization, 'materialization');
  const query = finalJsonRecord(
    runThreadnote(runtime, [
      '--log-level',
      'none',
      'graph',
      'query',
      '--cwd',
      cwd,
      '--query',
      FIXTURE_QUERY,
      '--node-limit',
      '5',
      '--edge-limit',
      '10',
      '--json',
    ]),
  );
  const nodes = array(query.nodes, 'query.nodes').map(value => record(value, 'query node'));
  if (!nodes.some(node => node.name === FIXTURE_QUERY && node.path === FIXTURE_QUERY_PATH)) {
    throw new Error(`${runtime.name} query control did not return ${FIXTURE_QUERY_PATH}#${FIXTURE_QUERY}.`);
  }
  return {
    durationMilliseconds,
    graph: {
      edges: integerField(snapshot, 'edgeCount'),
      files: integerField(snapshot, 'fileCount'),
      symbols: integerField(snapshot, 'symbolCount'),
    },
    materializationMode: stringField(materialization, 'mode'),
    queryDigest: queryEvidenceDigest(query),
    reusedFiles: integerField(summary, 'reusedFiles'),
    stagedFiles: integerField(materialization, 'stagedFiles'),
    totalFiles: integerField(materialization, 'totalFiles'),
  };
}

function runThreadnote(runtime: RuntimeCheckout, arguments_: readonly string[]): string {
  const result = spawnSync(process.execPath, [join(runtime.root, 'src/standalone.ts'), ...arguments_], {
    cwd: runtime.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      THREADNOTE_CODE_GRAPH_PARSER_WORKERS: String(PARSER_WORKERS),
      THREADNOTE_HOME: runtime.home,
    },
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: INDEX_TIMEOUT_MILLISECONDS,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${runtime.name} Threadnote command failed: ${(result.error?.message ?? result.stderr.trim()) || `exit ${result.status}`}`,
    );
  }
  return result.stdout;
}

function assertExpectedMode(scenario: ScenarioName, baseline: Observation, candidate: Observation): void {
  if (baseline.materializationMode !== 'full') {
    throw new Error(`${scenario} baseline unexpectedly used ${baseline.materializationMode}.`);
  }
  const expectedCandidate = scenario === 'graphEquivalentCommit' ? 'reused-snapshot' : 'incremental-clean';
  if (candidate.materializationMode !== expectedCandidate) {
    throw new Error(`${scenario} candidate unexpectedly used ${candidate.materializationMode}.`);
  }
  if (scenario === 'graphEquivalentCommit' && candidate.stagedFiles !== 0) {
    throw new Error('Graph-equivalent candidate commit staged files instead of aliasing the ready graph.');
  }
  if (scenario === 'oneFileChange' && candidate.stagedFiles !== 1) {
    throw new Error(`One-file candidate commit staged ${candidate.stagedFiles} files instead of one.`);
  }
}

function assertParity(baseline: Observation, candidate: Observation, label: string): void {
  if (JSON.stringify(baseline.graph) !== JSON.stringify(candidate.graph)) {
    throw new Error(`${label} graph counts differ between the baseline and candidate.`);
  }
  if (baseline.queryDigest !== candidate.queryDigest) {
    throw new Error(`${label} query control differs between the baseline and candidate.`);
  }
}

function queryEvidenceDigest(query: Record<string, unknown>): string {
  const nodes = array(query.nodes, 'query.nodes')
    .map(value => record(value, 'query node'))
    .map(node => ({
      exported: node.exported,
      kind: node.kind,
      language: node.language,
      name: node.name,
      path: node.path,
      qualifiedName: node.qualifiedName,
      signature: node.signature,
    }))
    .sort(compareJson);
  const edges = array(query.edges, 'query.edges')
    .map(value => record(value, 'query edge'))
    .map(edge => ({
      evidencePath: edge.evidencePath,
      provenance: edge.provenance,
      relation: edge.relation,
      sourceName: edge.sourceName,
      targetName: edge.targetName,
    }))
    .sort(compareJson);
  return sha256(JSON.stringify({edges, nodes}));
}

function compareJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right), 'en');
}

function summarize(values: readonly number[]): Summary {
  if (values.length !== options.samples || values.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`Expected ${options.samples} positive benchmark observations.`);
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMilliseconds = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return {
    maximumMilliseconds: sorted.at(-1)!,
    medianMilliseconds,
    minimumMilliseconds: sorted[0]!,
    samples: sorted.length,
  };
}

function validateArtifact(artifact: {
  readonly scenarios: Readonly<Record<ScenarioName, ScenarioEvidence>>;
  readonly source: {readonly baseline: {readonly commit: string}; readonly candidate: {readonly commit: string}};
}): void {
  if (artifact.source.baseline.commit !== baselineCommit || artifact.source.candidate.commit !== candidateCommit) {
    throw new Error('Benchmark artifact source provenance drifted during the run.');
  }
  for (const [name, scenario] of Object.entries(artifact.scenarios)) {
    if (!scenario.graphParityPassed || !scenario.queryParityPassed) throw new Error(`${name} parity did not pass.`);
    if (!Number.isFinite(scenario.medianSpeedup) || scenario.medianSpeedup <= 1) {
      throw new Error(`${name} did not improve median readiness time.`);
    }
    if (!Number.isFinite(scenario.percentFaster) || scenario.percentFaster <= 0 || scenario.percentFaster >= 100) {
      throw new Error(`${name} has an invalid percentage improvement.`);
    }
  }
}

function finalJsonRecord(output: string, expectedType?: string): Record<string, unknown> {
  const records = output
    .split(/\r?\n/)
    .filter(line => line.trim().startsWith('{'))
    .map(line => JSON.parse(line) as unknown)
    .filter(value => value !== null && typeof value === 'object' && !Array.isArray(value)) as Record<string, unknown>[];
  const selected = expectedType ? records.findLast(record => record.type === expectedType) : records.at(-1);
  if (!selected) throw new Error(`Threadnote command did not emit ${expectedType ?? 'a final JSON record'}.`);
  return selected;
}

function cloneAtCommit(source: string, target: string, commit: string): void {
  command('git', ['clone', '--quiet', '--no-local', '--no-checkout', source, target], temporaryRoot, 2 * 60 * 1_000);
  git(target, ['checkout', '--quiet', '--detach', commit]);
  if (git(target, ['rev-parse', 'HEAD']) !== commit) throw new Error(`Could not prepare exact checkout ${commit}.`);
}

function git(cwd: string, arguments_: readonly string[]): string {
  return command('git', arguments_, cwd, 2 * 60 * 1_000).trim();
}

function gitTopLevel(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

function command(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  timeout: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return execFileSync(executable, arguments_, {
    cwd,
    encoding: 'utf8',
    env,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout,
  });
}

function atomicWrite(path: string, content: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  writeFileSync(temporary, content, {encoding: 'utf8', flag: 'wx', mode: 0o600});
  renameSync(temporary, path);
}

function parseArguments(arguments_: readonly string[]): BenchmarkOptions {
  let baselineRef: string | undefined;
  let candidateRef = DEFAULT_CANDIDATE_REF;
  let outputPath: string | undefined;
  let samples = DEFAULT_SAMPLES;
  let warmups = DEFAULT_WARMUPS;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === '--baseline-ref') baselineRef = required(arguments_[++index], argument);
    else if (argument === '--candidate-ref') candidateRef = required(arguments_[++index], argument);
    else if (argument === '--output') outputPath = required(arguments_[++index], argument);
    else if (argument === '--samples') samples = positiveInteger(arguments_[++index], argument);
    else if (argument === '--warmups') warmups = nonNegativeInteger(arguments_[++index], argument);
    else throw new Error(`Unknown worktree-readiness benchmark option: ${argument}`);
  }
  return {baselineRef, candidateRef, outputPath, samples, warmups};
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new Error(`${option} requires a value.`);
  return value;
}

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = nonNegativeInteger(value, option);
  if (parsed === 0) throw new Error(`${option} must be at least 1.`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, option: string): number {
  const parsed = Number.parseInt(required(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${option} must be a non-negative integer.`);
  return parsed;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function integerField(record_: Record<string, unknown>, key: string): number {
  const value = record_[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${key} must be a non-negative integer.`);
  return Number(value);
}

function stringField(record_: Record<string, unknown>, key: string): string {
  const value = record_[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string.`);
  return value;
}

function requireObservation(value: Observation | undefined, label: string): Observation {
  if (!value) throw new Error(`Missing ${label} observation.`);
  return value;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function progress(message: string): void {
  process.stderr.write(`[worktree-readiness] ${message}\n`);
}
