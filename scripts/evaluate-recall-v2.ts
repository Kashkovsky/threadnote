import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {
  baselineResult,
  CURRENT_RECALL_BASELINE_PATH,
  exceedsReviewedContractFailureLimit,
  parseRecallEvaluationBaselineV1,
} from '../src/evaluation/recall-baseline.js';
import {
  createRecallEvaluationFixtureV2,
  expandRecallEvaluationFixtureV2,
  recallEvaluationCategoryCounts,
  serializeRecallEvaluationFixtureV2Identity,
} from '../src/evaluation/recall-fixture.js';
import {evaluateRecallNonInferiority} from '../src/evaluation/recall-gate.js';
import {evaluateRecallRunV2, runLexicalRecallEvaluationV2} from '../src/evaluation/recall.js';
import {getThreadnoteVersion} from '../src/version.js';
import {atomicWrite, fixtureHash, markFailure, printJson, readJsonFile, scriptArguments} from './effect/script.js';

const evaluateRecall = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  const threadnoteVersion = yield* getThreadnoteVersion();
  const baseFixture = createRecallEvaluationFixtureV2();
  const fixture = expandRecallEvaluationFixtureV2(baseFixture, options.documentCount, options.seed);
  const hash = yield* fixtureHash(serializeRecallEvaluationFixtureV2Identity(fixture));
  const run = runLexicalRecallEvaluationV2(fixture, {
    fixtureHash: hash,
    pipelineName: `threadnote-${threadnoteVersion}-${options.globalEligibility ? 'lexical-global' : 'lexical-only'}`,
    projectEligibility: options.globalEligibility ? 'global' : 'explicit',
  });
  const result = evaluateRecallRunV2(fixture, run);
  const baseline = options.baselinePath
    ? parseRecallEvaluationBaselineV1(yield* readJsonFile(options.baselinePath))
    : undefined;
  if (baseline && baseline.fixture.hash !== hash) {
    return yield* Effect.fail(
      new ScriptError(
        `Recall baseline fixture hash ${baseline.fixture.hash} does not match generated fixture hash ${hash}`,
      ),
    );
  }
  const gate = baseline ? evaluateRecallNonInferiority(baselineResult(baseline), result) : undefined;
  const artifact = {
    fixture: {
      categories: recallEvaluationCategoryCounts(fixture),
      documents: fixture.documents.length,
      hash,
      metadata: fixture.metadata,
      queries: fixture.queries.length,
      version: fixture.version,
    },
    result,
    run,
    ...(gate ? {gate} : {}),
    version: 1,
  };
  const summary = {
    fixture: artifact.fixture,
    result: {
      categories: result.categories,
      failureCount: result.failures.length,
      failures: result.failures.slice(0, options.maximumPrintedFailures),
      metrics: result.metrics,
      pipeline: result.pipeline,
      version: result.version,
    },
    ...(gate ? {gate} : {}),
    version: artifact.version,
  };

  if (options.outputPath) {
    yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  }
  yield* printJson(options.full ? artifact : summary);
  if (
    (options.failOnContract && exceedsReviewedContractFailureLimit(result.failures, baseline)) ||
    (options.failOnRegression && gate && !gate.passed)
  ) {
    yield* markFailure();
  }
});

interface EvaluationOptions {
  readonly baselinePath?: string;
  readonly documentCount: number;
  readonly failOnContract: boolean;
  readonly failOnRegression: boolean;
  readonly full: boolean;
  readonly globalEligibility: boolean;
  readonly maximumPrintedFailures: number;
  readonly outputPath?: string;
  readonly seed: number;
}

function parseArguments(args: readonly string[]): EvaluationOptions {
  let baselinePath: string | undefined = CURRENT_RECALL_BASELINE_PATH;
  let documentCount = 200;
  let failOnContract = false;
  let failOnRegression = false;
  let full = false;
  let globalEligibility = false;
  let maximumPrintedFailures = 20;
  let outputPath: string | undefined;
  let seed = 0x4_00_00;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--documents') documentCount = positiveInteger(args[++index], '--documents');
    else if (argument === '--baseline') baselinePath = requiredValue(args[++index], '--baseline');
    else if (argument === '--no-baseline') baselinePath = undefined;
    else if (argument === '--fail-on-contract') failOnContract = true;
    else if (argument === '--fail-on-regression') failOnRegression = true;
    else if (argument === '--full') full = true;
    else if (argument === '--global-eligibility') globalEligibility = true;
    else if (argument === '--max-failures') maximumPrintedFailures = positiveInteger(args[++index], '--max-failures');
    else if (argument === '--output') outputPath = requiredValue(args[++index], '--output');
    else if (argument === '--seed') seed = positiveInteger(args[++index], '--seed');
    else throw new ScriptError(`Unknown recall-v2 evaluation option: ${argument}`);
  }
  if (failOnRegression && !baselinePath) {
    throw new ScriptError('--fail-on-regression cannot be combined with --no-baseline');
  }
  if (globalEligibility && baselinePath) {
    throw new ScriptError('--global-eligibility requires --no-baseline so retrieval contracts are not conflated');
  }
  return {
    baselinePath,
    documentCount,
    failOnContract,
    failOnRegression,
    full,
    globalEligibility,
    maximumPrintedFailures,
    outputPath,
    seed,
  };
}

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = Number.parseInt(requiredValue(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ScriptError(`${option} requires a positive integer`);
  }
  return parsed;
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new ScriptError(`${option} requires a value`);
  return value;
}

BunRuntime.runMain(provideScriptLayer(evaluateRecall, ApplicationLayer));
