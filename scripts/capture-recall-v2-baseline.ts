import {createHash} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {
  RECALL_BASELINE_VERSION,
  parseRecallEvaluationBaselineV1,
  type RecallEvaluationBaselineV1,
} from '../src/evaluation/recall-baseline.js';
import {createRecallEvaluationFixtureV2} from '../src/evaluation/recall-fixture.js';
import {evaluateRecallRunV2, runLexicalRecallEvaluationV2} from '../src/evaluation/recall.js';
import {RECALL_RANKER_VERSION} from '../src/recall/rank.js';

const options = parseArguments(process.argv.slice(2));
const fixture = createRecallEvaluationFixtureV2();
const fixtureHash = createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
const result = evaluateRecallRunV2(
  fixture,
  runLexicalRecallEvaluationV2(fixture, {
    createdAt: options.createdAt,
    fixtureHash,
    pipelineName: 'threadnote-3.0.3-lexical-only',
  }),
);
const artifact: RecallEvaluationBaselineV1 = {
  createdAt: options.createdAt,
  fixture: {
    documents: fixture.documents.length,
    hash: fixtureHash,
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
if (options.outputPath) await atomicWrite(options.outputPath, json);
process.stdout.write(json);

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
    else throw new Error(`Unknown recall baseline option: ${argument}`);
  }
  return {createdAt, outputPath};
}

function sourceDate(): string {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  return epoch ? isoDate(new Date(Number(epoch) * 1_000).toISOString()) : '2026-07-27T00:00:00.000Z';
}

function isoDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ISO timestamp: ${value}`);
  return date.toISOString();
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new Error(`${option} requires a value`);
  return value;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}`;
  await mkdir(dirname(target), {recursive: true});
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, target);
}
