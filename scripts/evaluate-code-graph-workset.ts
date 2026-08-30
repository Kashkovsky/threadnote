import {provideScriptLayer, scriptError, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {runCommandEffect} from '../src/effect/command.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {SystemInfo} from '../src/effect/system.js';
import {
  CODE_GRAPH_WORKSET_BASELINE_VERSION,
  codeGraphWorksetEvaluationFixtureHash,
  evaluateCodeGraphWorksetObservations,
  parseCodeGraphWorksetEvaluationBaselineV1,
  type CodeGraphWorksetCoverageObservationV1,
  type CodeGraphWorksetEvaluationMetrics,
  type CodeGraphWorksetEvaluationObservationV1,
} from '../src/evaluation/code-graph-workset.js';
import {getThreadnoteVersion} from '../src/release/runtime_version.js';
import {atomicWrite, printJson, scriptArguments} from './effect/script.js';
import {
  buildCodeGraphWorksetEvaluationFixture,
  codeGraphWorksetCoverage,
  codeGraphWorksetObservationFromQuery,
  codeGraphWorksetRuntimeConfig,
  indexPreparedCodeGraphWorksetFixture,
  measureCodeGraphWorksetQuery,
  publishIndexedCodeGraphWorksetCatalog,
  unsupportedCodeGraphWorksetObservation,
} from './support/code-graph-workset-harness.js';
import {
  CODE_GRAPH_WORKSET_FIXTURE_SIZES,
  prepareCodeGraphWorksetFixture,
  removePreparedCodeGraphWorksetFixture,
  type CodeGraphWorksetFixtureSize,
  type PreparedCodeGraphWorksetFixture,
} from './support/code-graph-workset-fixture.js';

const WORKSET_EVALUATION_SMOKE_SIZES = [1, 8] as const;

export interface CodeGraphWorksetEvaluationArguments {
  readonly createdAt: string;
  readonly outputPath?: string;
  readonly sizes: readonly CodeGraphWorksetFixtureSize[];
  readonly smoke: boolean;
}

interface EvaluationArgumentDefaults {
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: Date;
}

export function parseCodeGraphWorksetEvaluationArguments(
  args: readonly string[],
  defaults: EvaluationArgumentDefaults = {},
): CodeGraphWorksetEvaluationArguments {
  let createdAt = defaultCreatedAt(defaults.environment ?? process.env, defaults.now ?? new Date());
  let outputPath: string | undefined;
  let requestedSizes: readonly CodeGraphWorksetFixtureSize[] | undefined;
  let smoke = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--created-at') createdAt = parseCreatedAt(required(args[++index], argument), argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--sizes') requestedSizes = parseEvaluationSizes(required(args[++index], argument));
    else if (argument === '--smoke') smoke = true;
    else throw new ScriptError(`Unknown code graph workset evaluation option: ${argument}`);
  }
  const sizes = requestedSizes ?? (smoke ? WORKSET_EVALUATION_SMOKE_SIZES : CODE_GRAPH_WORKSET_FIXTURE_SIZES);
  return {createdAt, outputPath, sizes, smoke};
}

export const evaluateCodeGraphWorkset = Effect.scoped(
  Effect.gen(function* () {
    const options = parseCodeGraphWorksetEvaluationArguments(yield* scriptArguments());
    const maximumSize = Math.max(...options.sizes) as CodeGraphWorksetFixtureSize;
    const prepared = yield* acquirePreparedFixture(maximumSize, 'mixed');
    yield* indexPreparedCodeGraphWorksetFixture(prepared);
    const selectedWorksets = options.sizes.map(size => {
      const workset = prepared.plan.worksets.find(candidate => candidate.size === size);
      if (!workset) throw new ScriptError(`Fixture did not emit a size-${size} workset.`);
      return workset.name;
    });
    yield* publishIndexedCodeGraphWorksetCatalog(prepared, selectedWorksets);

    const fixture = buildCodeGraphWorksetEvaluationFixture(prepared.plan, options.sizes);
    const config = codeGraphWorksetRuntimeConfig(prepared);
    const observations: CodeGraphWorksetEvaluationObservationV1[] = [];
    for (const worksetSize of options.sizes) {
      const workset = prepared.plan.worksets.find(candidate => candidate.size === worksetSize);
      if (!workset) return yield* Effect.fail(new ScriptError(`Fixture did not emit a size-${worksetSize} workset.`));
      const queries = fixture.queries.filter(query => query.sizes.includes(worksetSize));
      const worktree = yield* measureWorktreeIsolation(prepared, config, workset.name, worksetSize);
      let coverage: readonly CodeGraphWorksetCoverageObservationV1[] | undefined;
      let worktreeReceiptAvailable = true;
      for (const query of queries) {
        if (query.operation !== 'query') {
          if (!coverage) {
            const probe = fixture.queries.find(
              candidate => candidate.operation === 'query' && candidate.sizes.includes(worksetSize),
            );
            if (!probe?.query) {
              return yield* Effect.fail(
                new ScriptError(`Fixture size ${worksetSize} has no executable coverage probe.`),
              );
            }
            const measured = yield* measureCodeGraphWorksetQuery(config, workset.name, probe.query);
            coverage = codeGraphWorksetCoverage(fixture, worksetSize, measured.result);
          }
          observations.push(
            unsupportedCodeGraphWorksetObservation(fixture, worksetSize, 'evaluation-1', query.id, coverage),
          );
          continue;
        }
        const measured = yield* measureCodeGraphWorksetQuery(config, workset.name, query.query!);
        coverage = codeGraphWorksetCoverage(fixture, worksetSize, measured.result);
        observations.push(
          codeGraphWorksetObservationFromQuery(
            fixture,
            worksetSize,
            'evaluation-1',
            query.id,
            measured,
            worktreeReceiptAvailable ? worktree : undefined,
          ),
        );
        worktreeReceiptAvailable = false;
      }
    }

    const metrics = evaluateCodeGraphWorksetObservations(fixture, observations);
    const system = yield* SystemInfo;
    const hardware = yield* system.hardwareInfo;
    const [commit, dirty, version] = yield* Effect.all(
      [
        sourceGit(['rev-parse', 'HEAD']),
        sourceGit(['status', '--porcelain', '--untracked-files=all']),
        getThreadnoteVersion().pipe(Effect.catch(() => Effect.succeed('unknown'))),
      ],
      {concurrency: 3},
    );
    const baseline = parseCodeGraphWorksetEvaluationBaselineV1({
      createdAt: options.createdAt,
      fixture: {
        hash: codeGraphWorksetEvaluationFixtureHash(fixture),
        id: fixture.id,
        members: fixture.members.length,
        queries: fixture.queries.length,
        sizes: fixture.sizes,
        version: fixture.version,
      },
      metrics,
      source: {
        commit,
        dirty: dirty.length > 0,
        environment: `${hardware.operatingSystem}; ${system.architecture}`,
        name: 'threadnote-native-code-graph-workset',
        version,
      },
      version: CODE_GRAPH_WORKSET_BASELINE_VERSION,
    });
    if (options.outputPath) yield* atomicWrite(options.outputPath, `${JSON.stringify(baseline, undefined, 2)}\n`);
    yield* printJson(baseline);
    const safetyFailures = codeGraphWorksetEvaluationSafetyFailures(metrics);
    if (safetyFailures.length > 0) return yield* Effect.fail(new ScriptError(safetyFailures.join('\n')));
  }),
);

export function codeGraphWorksetEvaluationSafetyFailures(metrics: {
  readonly aggregate: Pick<
    CodeGraphWorksetEvaluationMetrics['aggregate'],
    'authoritativeFalseEdgeRate' | 'noAnswerPrecision' | 'noAnswerRecall' | 'worktreeLeakageRate'
  >;
}): readonly string[] {
  return [
    metrics.aggregate.authoritativeFalseEdgeRate !== 0 ? 'authoritative false-edge rate must be zero' : '',
    metrics.aggregate.worktreeLeakageRate !== 0 ? 'worktree leakage rate must be zero' : '',
    metrics.aggregate.noAnswerPrecision !== 1 ? 'no-answer precision must be one' : '',
    metrics.aggregate.noAnswerRecall !== 1 ? 'no-answer recall must be one' : '',
  ].filter(Boolean);
}

function acquirePreparedFixture(size: CodeGraphWorksetFixtureSize, stateProfile: 'all-clean' | 'mixed') {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => prepareCodeGraphWorksetFixture({size, stateProfile}),
      catch: cause => scriptError(cause),
    }),
    fixture =>
      Effect.tryPromise({
        try: () => removePreparedCodeGraphWorksetFixture(fixture),
        catch: cause => scriptError(cause),
      }).pipe(Effect.catch(() => Effect.void)),
  );
}

const measureWorktreeIsolation = Effect.fn('evaluateCodeGraphWorkset.worktreeIsolation')(function* (
  prepared: PreparedCodeGraphWorksetFixture,
  config: ReturnType<typeof codeGraphWorksetRuntimeConfig>,
  worksetName: string,
  worksetSize: number,
) {
  const admitted = prepared.repositories.slice(0, worksetSize).filter(repository => repository.state === 'worktree');
  if (admitted.length === 0) return {leakageCount: 0, observationCount: 0};
  const measured = yield* measureCodeGraphWorksetQuery(config, worksetName, 'siblingOnlySymbol');
  const leakedRepositories = new Set(
    measured.result.cards.filter(card => card.symbol.name === 'siblingOnlySymbol').map(card => card.repositoryKey),
  );
  return {
    leakageCount: admitted.filter(repository => leakedRepositories.has(repository.projectName)).length,
    observationCount: admitted.length,
  };
});

function parseEvaluationSizes(value: string): readonly CodeGraphWorksetFixtureSize[] {
  const allowed = new Set<number>(CODE_GRAPH_WORKSET_FIXTURE_SIZES);
  const sizes = parseSizeList(value, '--sizes');
  for (const size of sizes) {
    if (!allowed.has(size)) {
      throw new ScriptError(
        `--sizes only accepts evaluation sizes: ${CODE_GRAPH_WORKSET_FIXTURE_SIZES.join(', ')}. Received ${size}.`,
      );
    }
  }
  return [...sizes].sort((left, right) => left - right) as readonly CodeGraphWorksetFixtureSize[];
}

function parseSizeList(value: string, option: string): readonly number[] {
  const parts = value.split(',');
  if (parts.length === 0 || parts.some(part => !part.trim()))
    throw new ScriptError(`${option} requires comma-separated sizes.`);
  const sizes = parts.map(part => Number(part.trim()));
  if (sizes.some(size => !Number.isSafeInteger(size) || size < 1)) {
    throw new ScriptError(`${option} requires positive integer sizes.`);
  }
  if (new Set(sizes).size !== sizes.length) throw new ScriptError(`${option} sizes must be unique.`);
  return sizes;
}

function defaultCreatedAt(environment: NodeJS.ProcessEnv, now: Date): string {
  const epoch = environment.SOURCE_DATE_EPOCH;
  if (epoch === undefined) return parseCreatedAt(now.toISOString(), 'current time');
  if (!/^\d+$/.test(epoch))
    throw new ScriptError('SOURCE_DATE_EPOCH must be a non-negative integer number of seconds.');
  const date = new Date(Number(epoch) * 1_000);
  if (!Number.isFinite(date.getTime())) throw new ScriptError('SOURCE_DATE_EPOCH is outside the supported date range.');
  return date.toISOString();
}

function parseCreatedAt(value: string, option: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ScriptError(`${option} requires a valid date.`);
  return date.toISOString();
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new ScriptError(`${option} requires a value.`);
  return value;
}

const sourceGit = Effect.fn('evaluateCodeGraphWorkset.sourceGit')((args: readonly string[]) =>
  runCommandEffect('git', ['-C', process.cwd(), ...args], {
    maxOutputBytes: 1_048_576,
    timeoutMs: 30_000,
  }).pipe(Effect.map(result => result.stdout.trim())),
);

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(evaluateCodeGraphWorkset, ApplicationLayer));
