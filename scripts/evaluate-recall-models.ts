import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, FileSystem, Path} from 'effect';
import {LocalModelRuntime} from '../src/effect/ai/local-model-runtime.js';
import {sha256FileHex} from '../src/effect/digest.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {
  baselineResult,
  CURRENT_RECALL_BASELINE_PATH,
  parseRecallEvaluationBaselineV1,
} from '../src/evaluation/recall-baseline.js';
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
import {parseLocalModelManifest, type LocalModelManifest} from '../src/models/catalog.js';
import {LocalModelStore} from '../src/models/store.js';
import {deriveRecallEligibilityPolicy} from '../src/recall/eligibility.js';
import {rankRecallCandidates} from '../src/recall/rank.js';
import {normalizeRecallRerankerScore} from '../src/recall/reranker-score.js';
import {normalizeVector} from '../src/search/vector-search.js';
import {atomicWrite, fixtureHash, markFailure, printJson, readJsonFile, scriptArguments} from './effect/script.js';

const evaluateModels = Effect.gen(function* () {
  const path = yield* Path.Path;
  const options = parseArguments(yield* scriptArguments(), path.resolve);
  const fixture = createRecallEvaluationFixtureV2();
  const hash = yield* fixtureHash(serializeRecallEvaluationFixtureV2Identity(fixture));
  const baseline = parseRecallEvaluationBaselineV1(yield* readJsonFile(options.baseline));
  if (baseline.fixture.hash !== hash) {
    return yield* Effect.fail(
      new ScriptError(
        `Recall baseline fixture hash ${baseline.fixture.hash} does not match generated fixture hash ${hash}.`,
      ),
    );
  }
  const embeddingManifest = options.embedding ? builtinManifest(options.embedding, 'embedding') : undefined;
  const localRerankerManifest = options.rerankerManifest
    ? parseLocalModelManifest(yield* readJsonFile(options.rerankerManifest))
    : undefined;
  if (localRerankerManifest && localRerankerManifest.role !== 'reranker') {
    return yield* Effect.fail(new ScriptError(`Local model ${localRerankerManifest.id} is not a reranker.`));
  }
  const rerankerManifest =
    localRerankerManifest ?? (options.reranker ? builtinManifest(options.reranker, 'reranker') : undefined);
  const manifests = [embeddingManifest, rerankerManifest].filter(
    (value): value is LocalModelManifest => value !== undefined,
  );
  if (manifests.length === 0) {
    return yield* Effect.fail(
      new ScriptError(
        'Pass --embedding <model-id>, --reranker <model-id>, or a local --reranker-manifest/--reranker-path pair.',
      ),
    );
  }

  const evaluationArtifact = yield* Effect.scoped(
    Effect.gen(function* () {
      const store = yield* LocalModelStore;
      const runtime = yield* LocalModelRuntime;
      const paths = new Map<string, string>();
      for (const candidate of manifests) {
        if (candidate === localRerankerManifest) {
          yield* verifyLocalModelArtifact(candidate, options.rerankerPath!);
          paths.set(candidate.id, options.rerankerPath!);
          continue;
        }
        const status = options.install
          ? yield* store.install(options.home, candidate)
          : yield* store.verify(options.home, candidate);
        paths.set(candidate.id, status.path);
      }

      const documentVectors = options.embedding
        ? yield* runtime.embedMany({
            inputs: fixture.documents.map(
              document => `${embeddingManifest!.promptPrefixes?.document ?? ''}${document.text}`,
            ),
            manifest: embeddingManifest!,
            modelPath: paths.get(options.embedding)!,
          })
        : undefined;
      const normalizedDocuments = documentVectors?.map(normalizeVector);
      const scoresByQuery = new Map<string, RecallEvaluationQueryScores>();
      for (const query of fixture.queries) {
        let semantic: Map<string, number> | undefined;
        if (embeddingManifest && normalizedDocuments) {
          const embedding = embeddingManifest;
          const [queryVector] = yield* runtime.embedMany({
            inputs: [`${embedding.promptPrefixes?.query ?? ''}${query.query}`],
            manifest: embedding,
            modelPath: paths.get(embedding.id)!,
          });
          const normalizedQuery = normalizeVector(queryVector);
          semantic = new Map(
            fixture.documents.map((document, index) => [
              document.uri,
              Math.max(0, dot(normalizedQuery, normalizedDocuments[index])),
            ]),
          );
        }

        let reranker: Map<string, number> | undefined;
        if (rerankerManifest) {
          const shortlist = rankRecallCandidates(
            query.query,
            fixture.documents.map(document => ({
              ...document,
              semantic: semantic?.get(document.uri) ?? 0,
            })),
            {
              eligibility: deriveRecallEligibilityPolicy({
                explicitProject: query.project,
                originalQuery: query.query,
              }),
              now: query.now ? new Date(query.now) : undefined,
              project: query.project,
              seedUris: query.seedUris,
            },
          ).results.slice(0, 32);
          const reranking = rerankerManifest;
          const rawScores = yield* runtime.rerank({
            documents: shortlist.map(result => result.candidate.text.slice(0, 4_000)),
            manifest: reranking,
            modelPath: paths.get(reranking.id)!,
            query: query.query,
          });
          reranker = new Map(
            shortlist.map((result, index) => [
              result.candidate.uri,
              normalizeRecallRerankerScore(rawScores[index] ?? 0),
            ]),
          );
        }
        scoresByQuery.set(query.id, {reranker, semantic});
      }

      const modelIds = manifests.map(candidate => candidate.id).join('+');
      const run = runScoredRecallEvaluationV2(fixture, scoresByQuery, {
        fixtureHash: hash,
        model: modelIds,
        pipelineName: rerankerManifest ? 'threadnote-4-native-hybrid-reranked' : 'threadnote-4-native-hybrid',
        revision: manifests.map(candidate => candidate.revision).join('+'),
      });
      return {
        fixture: {
          documents: fixture.documents.length,
          hash,
          queries: fixture.queries.length,
          version: fixture.version,
        },
        models: manifests,
        result: evaluateRecallRunV2(fixture, run),
        run,
        version: 1,
      };
    }),
  );
  const gate = evaluateRecallNonInferiority(baselineResult(baseline), evaluationArtifact.result);
  const artifact = {...evaluationArtifact, gate};

  if (options.output) yield* atomicWrite(options.output, `${JSON.stringify(artifact, undefined, 2)}\n`);
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
  if (options.summaryOutput) {
    yield* atomicWrite(options.summaryOutput, `${JSON.stringify(summary, undefined, 2)}\n`);
  }
  yield* printJson(summary);
  if (options.failOnRegression && !gate.passed) yield* markFailure();
});

function builtinManifest(id: string, role: 'embedding' | 'reranker'): LocalModelManifest {
  const candidate = BUILTIN_MODEL_MANIFESTS.find(value => value.id === id);
  if (!candidate || candidate.role !== role) throw new ScriptError(`Unknown ${role} model: ${id}`);
  return candidate;
}

function dot(left: readonly number[], right: readonly number[]): number {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

interface Options {
  readonly baseline: string;
  readonly embedding?: string;
  readonly failOnRegression: boolean;
  readonly home: string;
  readonly install: boolean;
  readonly output?: string;
  readonly reranker?: string;
  readonly rerankerManifest?: string;
  readonly rerankerPath?: string;
  readonly summaryOutput?: string;
}

function parseArguments(args: readonly string[], resolve: (value: string) => string): Options {
  let baseline = resolve(CURRENT_RECALL_BASELINE_PATH);
  let embedding: string | undefined;
  let failOnRegression = false;
  let home = resolve('.artifacts/model-bakeoff-home');
  let install = false;
  let output: string | undefined;
  let reranker: string | undefined;
  let rerankerManifest: string | undefined;
  let rerankerPath: string | undefined;
  let summaryOutput: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--baseline') baseline = resolve(required(args[++index], argument));
    else if (argument === '--embedding') embedding = required(args[++index], argument);
    else if (argument === '--fail-on-regression') failOnRegression = true;
    else if (argument === '--home') home = resolve(required(args[++index], argument));
    else if (argument === '--install') install = true;
    else if (argument === '--output') output = required(args[++index], argument);
    else if (argument === '--reranker') reranker = required(args[++index], argument);
    else if (argument === '--reranker-manifest') rerankerManifest = resolve(required(args[++index], argument));
    else if (argument === '--reranker-path') rerankerPath = resolve(required(args[++index], argument));
    else if (argument === '--summary-output') summaryOutput = required(args[++index], argument);
    else throw new ScriptError(`Unknown model-evaluation option: ${argument}`);
  }
  if ((rerankerManifest === undefined) !== (rerankerPath === undefined)) {
    throw new ScriptError('--reranker-manifest and --reranker-path must be passed together.');
  }
  if (reranker && rerankerManifest) {
    throw new ScriptError('--reranker cannot be combined with --reranker-manifest.');
  }
  return {
    baseline,
    embedding,
    failOnRegression,
    home,
    install,
    output,
    reranker,
    rerankerManifest,
    rerankerPath,
    summaryOutput,
  };
}

const verifyLocalModelArtifact = Effect.fn('evaluateRecallModels.verifyLocalModelArtifact')(function* (
  manifest: LocalModelManifest,
  modelPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(modelPath);
  if (info.type !== 'File') throw new ScriptError(`Local reranker artifact is not a regular file: ${modelPath}`);
  if (Number(info.size) !== manifest.size) {
    throw new ScriptError(`Local reranker size ${info.size} does not match manifest size ${manifest.size}.`);
  }
  const digest = yield* sha256FileHex(modelPath);
  if (digest !== manifest.sha256) {
    throw new ScriptError(`Local reranker SHA-256 ${digest} does not match manifest SHA-256 ${manifest.sha256}.`);
  }
});

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new ScriptError(`${option} requires a value.`);
  return value;
}

BunRuntime.runMain(provideScriptLayer(evaluateModels, ApplicationLayer));
