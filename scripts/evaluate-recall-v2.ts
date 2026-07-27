import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {baselineResult, parseRecallEvaluationBaselineV1} from '../src/evaluation/recall-baseline.js';
import {
  createRecallEvaluationFixtureV2,
  expandRecallEvaluationFixtureV2,
  recallEvaluationCategoryCounts,
} from '../src/evaluation/recall-fixture.js';
import {evaluateRecallNonInferiority} from '../src/evaluation/recall-gate.js';
import {evaluateRecallRunV2, runLexicalRecallEvaluationV2} from '../src/evaluation/recall.js';

const options = parseArguments(process.argv.slice(2));
const baseFixture = createRecallEvaluationFixtureV2();
const fixture = expandRecallEvaluationFixtureV2(baseFixture, options.documentCount, options.seed);
const fixtureJson = JSON.stringify(fixture);
const fixtureHash = createHash('sha256').update(fixtureJson).digest('hex');
const run = runLexicalRecallEvaluationV2(fixture, {
  fixtureHash,
  pipelineName: 'threadnote-3.x-lexical-only',
});
const result = evaluateRecallRunV2(fixture, run);
const baseline = options.baselinePath
  ? parseRecallEvaluationBaselineV1(JSON.parse(await readFile(options.baselinePath, 'utf8')))
  : undefined;
if (baseline && baseline.fixture.hash !== fixtureHash) {
  throw new Error(
    `Recall baseline fixture hash ${baseline.fixture.hash} does not match generated fixture hash ${fixtureHash}`,
  );
}
const gate = baseline ? evaluateRecallNonInferiority(baselineResult(baseline), result) : undefined;
const artifact = {
  fixture: {
    categories: recallEvaluationCategoryCounts(fixture),
    documents: fixture.documents.length,
    hash: fixtureHash,
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
  await atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(options.full ? artifact : summary, undefined, 2)}\n`);

if (options.failOnContract && result.failures.length > 0) {
  process.exitCode = 1;
}
if (options.failOnRegression && gate && !gate.passed) {
  process.exitCode = 1;
}

interface EvaluationOptions {
  readonly baselinePath?: string;
  readonly documentCount: number;
  readonly failOnContract: boolean;
  readonly failOnRegression: boolean;
  readonly full: boolean;
  readonly maximumPrintedFailures: number;
  readonly outputPath?: string;
  readonly seed: number;
}

function parseArguments(args: readonly string[]): EvaluationOptions {
  let baselinePath: string | undefined;
  let documentCount = 200;
  let failOnContract = false;
  let failOnRegression = false;
  let full = false;
  let maximumPrintedFailures = 20;
  let outputPath: string | undefined;
  let seed = 0x4_00_00;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--documents') {
      documentCount = positiveInteger(args[++index], '--documents');
    } else if (argument === '--baseline') {
      baselinePath = requiredValue(args[++index], '--baseline');
    } else if (argument === '--fail-on-contract') {
      failOnContract = true;
    } else if (argument === '--fail-on-regression') {
      failOnRegression = true;
    } else if (argument === '--full') {
      full = true;
    } else if (argument === '--max-failures') {
      maximumPrintedFailures = positiveInteger(args[++index], '--max-failures');
    } else if (argument === '--output') {
      outputPath = requiredValue(args[++index], '--output');
    } else if (argument === '--seed') {
      seed = positiveInteger(args[++index], '--seed');
    } else {
      throw new Error(`Unknown recall-v2 evaluation option: ${argument}`);
    }
  }
  if (failOnRegression && !baselinePath) {
    throw new Error('--fail-on-regression requires --baseline <path>');
  }
  return {
    baselinePath,
    documentCount,
    failOnContract,
    failOnRegression,
    full,
    maximumPrintedFailures,
    outputPath,
    seed,
  };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}`;
  await mkdir(dirname(target), {recursive: true});
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, target);
}

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = Number.parseInt(requiredValue(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} requires a positive integer`);
  }
  return parsed;
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new Error(`${option} requires a value`);
  return value;
}
