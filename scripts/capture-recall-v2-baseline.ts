import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {runCommandEffect} from '../src/effect/command.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {
  RECALL_BASELINE_VERSION,
  parseRecallEvaluationBaselineV1,
  type RecallEvaluationBaselineV1,
} from '../src/evaluation/recall-baseline.js';
import {
  createRecallEvaluationFixtureV2,
  serializeRecallEvaluationFixtureV2Identity,
} from '../src/evaluation/recall-fixture.js';
import {evaluateRecallRunV2, runLexicalRecallEvaluationV2} from '../src/evaluation/recall.js';
import {RECALL_RANKER_VERSION} from '../src/recall/rank.js';
import {getThreadnoteVersion} from '../src/release/runtime_version.js';
import {atomicWrite, fixtureHash, printJson, scriptArguments} from './effect/script.js';

const captureBaseline = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  const [threadnoteVersion, commit, committedAt, status] = yield* Effect.all(
    [
      getThreadnoteVersion(),
      git(['rev-parse', 'HEAD']),
      git(['show', '-s', '--format=%cI', 'HEAD']),
      git(['status', '--porcelain', '--untracked-files=all']),
    ],
    {concurrency: 'unbounded'},
  );
  if (status.length > 0) {
    return yield* Effect.fail(
      new ScriptError('Recall baselines must be captured from a clean checkout; commit or stash changes first.'),
    );
  }
  const createdAt = options.createdAt ?? sourceDate(committedAt);
  const outputPath = options.outputPath ?? baselinePath(threadnoteVersion);
  const fixture = createRecallEvaluationFixtureV2();
  const hash = yield* fixtureHash(serializeRecallEvaluationFixtureV2Identity(fixture));
  const result = evaluateRecallRunV2(
    fixture,
    runLexicalRecallEvaluationV2(fixture, {
      createdAt,
      fixtureHash: hash,
      pipelineName: `threadnote-${threadnoteVersion}-lexical-only`,
    }),
  );
  const artifact: RecallEvaluationBaselineV1 = {
    createdAt,
    fixture: {
      documents: fixture.documents.length,
      hash,
      queries: fixture.queries.length,
      version: fixture.version,
    },
    knownContractFailures: result.failures.length,
    reviewedContractFailures: [...result.failures].sort(),
    result: {
      categories: result.categories,
      metrics: result.metrics,
      pipeline: result.pipeline,
    },
    source: {
      commit,
      dirty: false,
      openVikingVersion: 'not-applicable',
      rankerVersion: RECALL_RANKER_VERSION,
      threadnoteVersion,
    },
    version: RECALL_BASELINE_VERSION,
  };
  parseRecallEvaluationBaselineV1(artifact);
  const json = `${JSON.stringify(artifact, undefined, 2)}\n`;
  yield* atomicWrite(outputPath, json);
  yield* printJson(artifact);
});

interface Options {
  readonly createdAt?: string;
  readonly outputPath?: string;
}

function parseArguments(args: readonly string[]): Options {
  let createdAt: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--created-at') createdAt = isoDate(requiredValue(args[++index], argument));
    else if (argument === '--output') outputPath = requiredValue(args[++index], argument);
    else throw new ScriptError(`Unknown recall baseline option: ${argument}`);
  }
  return {createdAt, outputPath};
}

function sourceDate(committedAt: string): string {
  const epoch = Bun.env.SOURCE_DATE_EPOCH;
  return epoch ? isoDate(new Date(Number(epoch) * 1_000).toISOString()) : isoDate(committedAt);
}

function baselinePath(threadnoteVersion: string): string {
  return `test/evaluation/baselines/threadnote-${threadnoteVersion}-${RECALL_RANKER_VERSION}/recall-v2-lexical.json`;
}

const git = Effect.fn('captureRecallBaseline.git')((arguments_: readonly string[]) =>
  runCommandEffect('git', arguments_, {timeoutMs: 30_000}).pipe(Effect.map(result => result.stdout.trim())),
);

function isoDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ScriptError(`Invalid ISO timestamp: ${value}`);
  return date.toISOString();
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new ScriptError(`${option} requires a value`);
  return value;
}

BunRuntime.runMain(provideScriptLayer(captureBaseline, ApplicationLayer));
