import {createHash} from 'node:crypto';
import {readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {evaluateRecallFixture, parseRecallEvaluationFixture} from '../src/recall/evaluate.js';
import {RECALL_RANKER_VERSION} from '../src/recall/rank.js';

const FIXTURE_PATH = 'test/evaluation/fixtures/recall-v1/fixture.json';
const options = parseArguments(process.argv.slice(2));
const raw = await readFile(FIXTURE_PATH, 'utf8');
const fixture = parseRecallEvaluationFixture(JSON.parse(raw));
const result = evaluateRecallFixture(fixture);
const artifact = {
  createdAt: options.createdAt,
  fixture: {
    hash: createHash('sha256').update(raw).digest('hex'),
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
  const target = resolve(options.outputPath);
  const temporary = `${target}.tmp-${process.pid}`;
  await mkdir(dirname(target), {recursive: true});
  await writeFile(temporary, json, 'utf8');
  await rename(temporary, target);
}
process.stdout.write(json);

function parseArguments(args: readonly string[]): {readonly createdAt: string; readonly outputPath?: string} {
  let createdAt = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1_000).toISOString()
    : '2026-07-27T00:00:00.000Z';
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--created-at') {
      const value = args[++index];
      if (!value?.trim() || Number.isNaN(new Date(value).getTime())) {
        throw new Error('--created-at requires an ISO timestamp');
      }
      createdAt = new Date(value).toISOString();
    } else if (argument === '--output') {
      const value = args[++index];
      if (!value?.trim()) throw new Error('--output requires a path');
      outputPath = value;
    } else {
      throw new Error(`Unknown recall baseline option: ${argument}`);
    }
  }
  return {createdAt, outputPath};
}
