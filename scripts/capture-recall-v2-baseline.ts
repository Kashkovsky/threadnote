import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
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
import {atomicWrite, fixtureHash, printJson, scriptArguments} from './effect/script.js';

const DEFAULT_CREATED_AT = '2026-07-27T00:00:00.000Z';

const captureBaseline = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  const fixture = createRecallEvaluationFixtureV2();
  const hash = yield* fixtureHash(serializeRecallEvaluationFixtureV2Identity(fixture));
  const result = evaluateRecallRunV2(
    fixture,
    runLexicalRecallEvaluationV2(fixture, {
      createdAt: options.createdAt,
      fixtureHash: hash,
      pipelineName: 'threadnote-3.0.3-lexical-only',
    }),
  );
  const artifact: RecallEvaluationBaselineV1 = {
    createdAt: options.createdAt,
    fixture: {
      documents: fixture.documents.length,
      hash,
      queries: fixture.queries.length,
      version: fixture.version,
    },
    knownContractFailures: result.failures.length,
    result: {
      categories: result.categories,
      metrics: result.metrics,
      pipeline: result.pipeline,
    },
    source: {
      openVikingVersion: '0.4.10',
      rankerVersion: RECALL_RANKER_VERSION,
      threadnoteVersion: '3.0.3',
    },
    version: RECALL_BASELINE_VERSION,
  };
  parseRecallEvaluationBaselineV1(artifact);
  const json = `${JSON.stringify(artifact, undefined, 2)}\n`;
  if (options.outputPath) yield* atomicWrite(options.outputPath, json);
  yield* printJson(artifact);
});

interface Options {
  readonly createdAt: string;
  readonly outputPath?: string;
}

function parseArguments(args: readonly string[]): Options {
  let createdAt = sourceDate();
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--created-at') createdAt = isoDate(requiredValue(args[++index], argument));
    else if (argument === '--output') outputPath = requiredValue(args[++index], argument);
    else throw new ScriptError(`Unknown recall baseline option: ${argument}`);
  }
  return {createdAt, outputPath};
}

function sourceDate(): string {
  const epoch = Bun.env.SOURCE_DATE_EPOCH;
  return epoch ? isoDate(new Date(Number(epoch) * 1_000).toISOString()) : DEFAULT_CREATED_AT;
}

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
