import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, FileSystem} from 'effect';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {evaluateRecallFixture, parseRecallEvaluationFixture} from '../src/recall/evaluate.js';
import {RECALL_RANKER_VERSION} from '../src/recall/rank.js';
import {atomicWrite, fixtureHash, printJson, scriptArguments} from './effect/script.js';

const FIXTURE_PATH = 'test/evaluation/fixtures/recall-v1/fixture.json';
const DEFAULT_CREATED_AT = '2026-07-27T00:00:00.000Z';

const captureBaseline = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const options = parseArguments(yield* scriptArguments());
  const raw = yield* fs.readFileString(FIXTURE_PATH);
  const fixture = yield* Effect.try({
    try: () => parseRecallEvaluationFixture(JSON.parse(raw)),
    catch: cause => new ScriptError(`Could not parse ${FIXTURE_PATH}.`, {cause}),
  });
  const result = evaluateRecallFixture(fixture);
  const artifact = {
    createdAt: options.createdAt,
    fixture: {
      hash: yield* fixtureHash(raw),
      path: FIXTURE_PATH,
      version: fixture.version,
    },
    result,
    source: {
      openVikingVersion: '0.4.10',
      rankerVersion: RECALL_RANKER_VERSION,
      threadnoteVersion: '3.0.3',
    },
    version: 1,
  };
  const json = `${JSON.stringify(artifact, undefined, 2)}\n`;
  if (options.outputPath) {
    yield* atomicWrite(options.outputPath, json);
  }
  yield* printJson(artifact);
});

function parseArguments(args: readonly string[]): {readonly createdAt: string; readonly outputPath?: string} {
  const sourceDateEpoch = Bun.env.SOURCE_DATE_EPOCH;
  let createdAt = sourceDateEpoch ? new Date(Number(sourceDateEpoch) * 1_000).toISOString() : DEFAULT_CREATED_AT;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--created-at') {
      const value = args[++index];
      if (!value?.trim() || Number.isNaN(new Date(value).getTime())) {
        throw new ScriptError('--created-at requires an ISO timestamp');
      }
      createdAt = new Date(value).toISOString();
    } else if (argument === '--output') {
      const value = args[++index];
      if (!value?.trim()) throw new ScriptError('--output requires a path');
      outputPath = value;
    } else {
      throw new ScriptError(`Unknown recall baseline option: ${argument}`);
    }
  }
  return {createdAt, outputPath};
}

BunRuntime.runMain(provideScriptLayer(captureBaseline, ApplicationLayer));
