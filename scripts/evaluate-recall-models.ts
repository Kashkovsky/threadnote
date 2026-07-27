import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {Effect} from 'effect';
import {LocalModelRuntime} from '../src/effect/ai/local-model-runtime.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {baselineResult, parseRecallEvaluationBaselineV1} from '../src/evaluation/recall-baseline.js';
import {
  createRecallEvaluationFixtureV2,
  serializeRecallEvaluationFixtureV2Identity,
} from '../src/evaluation/recall-fixture.js';
import {evaluateRecallNonInferiority} from '../src/evaluation/recall-gate.js';
import {
  evaluateRecallRunV2,
  runScoredRecallEvaluationV2,
  type RecallEvaluationQueryScores,
} from '../src/evaluation/recall.js';
import {BUILTIN_MODEL_MANIFESTS} from '../src/models/builtin.js';
import type {LocalModelManifest} from '../src/models/catalog.js';
import {LocalModelStore} from '../src/models/store.js';
import {rankRecallCandidates} from '../src/recall/rank.js';
import {normalizeVector} from '../src/search/vector-search.js';

const options = parseArguments(process.argv.slice(2));
const fixture = createRecallEvaluationFixtureV2();
const fixtureHash = createHash('sha256').update(serializeRecallEvaluationFixtureV2Identity(fixture)).digest('hex');
const baseline = parseRecallEvaluationBaselineV1(JSON.parse(await readFile(options.baseline, 'utf8')));
if (baseline.fixture.hash !== fixtureHash) {
  throw new Error(
    `Recall baseline fixture hash ${baseline.fixture.hash} does not match generated fixture hash ${fixtureHash}.`,
  );
}
const manifests = [
  options.embedding ? manifest(options.embedding, 'embedding') : undefined,
  options.reranker ? manifest(options.reranker, 'reranker') : undefined,
].filter((value): value is LocalModelManifest => value !== undefined);
if (manifests.length === 0) throw new Error('Pass --embedding <model-id>, --reranker <model-id>, or both.');

const evaluationArtifact = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* LocalModelStore;
      const runtime = yield* LocalModelRuntime;
      const paths = new Map<string, string>();
      for (const candidate of manifests) {
        const status = options.install
          ? yield* store.install(options.home, candidate)
          : yield* store.verify(options.home, candidate);
        paths.set(candidate.id, status.path);
      }

      const documentVectors = options.embedding
        ? yield* runtime.embedMany({
            inputs: fixture.documents.map(
              document => `${manifest(options.embedding!, 'embedding').promptPrefixes?.document ?? ''}${document.text}`,
            ),
            manifest: manifest(options.embedding, 'embedding'),
            modelPath: paths.get(options.embedding)!,
          })
        : undefined;
      const normalizedDocuments = documentVectors?.map(normalizeVector);
      const scoresByQuery = new Map<string, RecallEvaluationQueryScores>();
      for (const query of fixture.queries) {
        let semantic: Map<string, number> | undefined;
        if (options.embedding && normalizedDocuments) {
          const embedding = manifest(options.embedding, 'embedding');
          const [queryVector] = yield* runtime.embedMany({
            inputs: [`${embedding.promptPrefixes?.query ?? ''}${query.query}`],
            manifest: embedding,
            modelPath: paths.get(embedding.id)!,
          });
          const normalizedQuery = normalizeVector(queryVector!);
          semantic = new Map(
            fixture.documents.map((document, index) => [
              document.uri,
              Math.max(0, dot(normalizedQuery, normalizedDocuments[index]!)),
            ]),
          );
        }

        let reranker: Map<string, number> | undefined;
        if (options.reranker) {
          const shortlist = rankRecallCandidates(
            query.query,
            fixture.documents.map(document => ({
              ...document,
              semantic: semantic?.get(document.uri) ?? 0,
            })),
            {
              now: query.now ? new Date(query.now) : undefined,
              project: query.project,
              seedUris: query.seedUris,
            },
          ).results.slice(0, 32);
          const reranking = manifest(options.reranker, 'reranker');
          const rawScores = yield* runtime.rerank({
            documents: shortlist.map(result => result.candidate.text.slice(0, 4_000)),
            manifest: reranking,
            modelPath: paths.get(reranking.id)!,
            query: query.query,
          });
          reranker = new Map(
            shortlist.map((result, index) => [result.candidate.uri, normalizeRerankerScore(rawScores[index] ?? 0)]),
          );
        }
        scoresByQuery.set(query.id, {reranker, semantic});
      }

      const modelIds = manifests.map(candidate => candidate.id).join('+');
      const run = runScoredRecallEvaluationV2(fixture, scoresByQuery, {
        fixtureHash,
        model: modelIds,
        pipelineName: options.reranker ? 'threadnote-4-native-hybrid-reranked' : 'threadnote-4-native-hybrid',
        revision: manifests.map(candidate => candidate.revision).join('+'),
      });
      return {
        fixture: {
          documents: fixture.documents.length,
          hash: fixtureHash,
          queries: fixture.queries.length,
          version: fixture.version,
        },
        models: manifests,
        result: evaluateRecallRunV2(fixture, run),
        run,
        version: 1,
      };
    }),
  ).pipe(Effect.provide(ApplicationLayer)),
);
const gate = evaluateRecallNonInferiority(baselineResult(baseline), evaluationArtifact.result);
const artifact = {...evaluationArtifact, gate};

if (options.output) await atomicWrite(options.output, `${JSON.stringify(artifact, undefined, 2)}\n`);
const summary = {
  baseline: {
    fixtureHash: baseline.fixture.hash,
    pipeline: baseline.result.pipeline,
    version: baseline.version,
  },
  fixture: artifact.fixture,
  gate,
  models: artifact.models.map(candidate => ({
    id: candidate.id,
    revision: candidate.revision,
    role: candidate.role,
    sha256: candidate.sha256,
  })),
  result: {
    categories: artifact.result.categories,
    failureCount: artifact.result.failures.length,
    metrics: artifact.result.metrics,
    pipeline: artifact.result.pipeline,
  },
  version: artifact.version,
};
if (options.summaryOutput) await atomicWrite(options.summaryOutput, `${JSON.stringify(summary, undefined, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, undefined, 2)}\n`);
if (options.failOnRegression && !gate.passed) process.exitCode = 1;

function manifest(id: string, role: 'embedding' | 'reranker'): LocalModelManifest {
  const candidate = BUILTIN_MODEL_MANIFESTS.find(value => value.id === id);
  if (!candidate || candidate.role !== role) throw new Error(`Unknown ${role} model: ${id}`);
  return candidate;
}

function dot(left: readonly number[], right: readonly number[]): number {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index]! * right[index]!;
  return score;
}

function normalizeRerankerScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return score >= 0 && score <= 1 ? score : 1 / (1 + Math.exp(-score));
}

interface Options {
  readonly baseline: string;
  readonly embedding?: string;
  readonly failOnRegression: boolean;
  readonly home: string;
  readonly install: boolean;
  readonly output?: string;
  readonly reranker?: string;
  readonly summaryOutput?: string;
}

function parseArguments(args: readonly string[]): Options {
  let baseline = resolve('test/evaluation/baselines/threadnote-3.0.3/recall-v2-lexical.json');
  let embedding: string | undefined;
  let failOnRegression = false;
  let home = resolve('.artifacts/model-bakeoff-home');
  let install = false;
  let output: string | undefined;
  let reranker: string | undefined;
  let summaryOutput: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--baseline') baseline = resolve(required(args[++index], argument));
    else if (argument === '--embedding') embedding = required(args[++index], argument);
    else if (argument === '--fail-on-regression') failOnRegression = true;
    else if (argument === '--home') home = resolve(required(args[++index], argument));
    else if (argument === '--install') install = true;
    else if (argument === '--output') output = required(args[++index], argument);
    else if (argument === '--reranker') reranker = required(args[++index], argument);
    else if (argument === '--summary-output') summaryOutput = required(args[++index], argument);
    else throw new Error(`Unknown model-evaluation option: ${argument}`);
  }
  return {
    baseline,
    embedding,
    failOnRegression,
    home,
    install,
    output,
    reranker,
    summaryOutput,
  };
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new Error(`${option} requires a value.`);
  return value;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}`;
  await mkdir(dirname(target), {recursive: true});
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, target);
}
