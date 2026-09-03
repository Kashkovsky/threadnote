import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Clock, Effect, FileSystem, Layer, Path} from 'effect';
import {isolatedLocalModelRuntimeLayer} from '../src/effect/ai/isolated-local-model-runtime.js';
import {LocalModelRuntime} from '../src/effect/ai/local-model-runtime.js';
import {sha256FileHex} from '../src/effect/digest.js';
import {SystemInfo} from '../src/effect/system.js';
import {parseLocalModelManifest, type LocalModelManifest} from '../src/models/catalog.js';
import {atomicWrite, markFailure, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import {
  DEFAULT_RERANKER_PARITY_MAXIMUM_ABSOLUTE_ERROR,
  DEFAULT_RERANKER_PARITY_MINIMUM_ORDERING_GAP,
  evaluateRecallRerankerParity,
  parseRecallRerankerParityFixtureV1,
} from './training/recall-reranker-parity.js';

const validateParity = Effect.gen(function* () {
  const path = yield* Path.Path;
  const options = parseArguments(yield* scriptArguments(), path.resolve);
  const fixture = parseRecallRerankerParityFixtureV1(yield* readJsonFile(options.fixture));
  const manifest = parseLocalModelManifest(yield* readJsonFile(options.manifest));
  verifyRuntimeBinding(fixture.runtimeTarget, manifest);
  yield* verifyModelArtifact(manifest, options.model);

  const runtime = yield* LocalModelRuntime;
  const nativeScores = new Map<string, readonly number[]>();
  for (const group of fixture.groups) {
    const scores = yield* runtime.rerank({
      documents: group.candidates.map(candidate => candidate.document),
      manifest,
      modelPath: options.model,
      query: group.query,
    });
    nativeScores.set(group.groupId, scores);
  }
  const result = evaluateRecallRerankerParity(fixture, nativeScores, {
    maximumAbsoluteError: options.maximumAbsoluteError,
    minimumOrderingGap: options.minimumOrderingGap,
  });
  const fixtureSha256 = yield* sha256FileHex(options.fixture);
  const manifestSha256 = yield* sha256FileHex(options.manifest);
  const now = yield* Clock.currentTimeMillis;
  const artifact = {
    version: 1,
    gate: 'threadnote-recall-reranker-python-native-parity',
    generatedAt: new Date(now).toISOString(),
    passed: result.passed,
    fixture: {
      configurationSha256: fixture.configurationSha256,
      datasetGroupsSha256: fixture.dataset.groupsSha256,
      modelTreeSha256: fixture.run.modelTreeSha256,
      runJsonSha256: fixture.run.runJsonSha256,
      sha256: fixtureSha256,
      split: fixture.split,
    },
    model: {
      id: manifest.id,
      manifestSha256,
      nodeLlamaCpp: manifest.runtime.nodeLlamaCpp,
      sha256: manifest.sha256,
      size: manifest.size,
    },
    thresholds: {
      maximumAbsoluteError: options.maximumAbsoluteError,
      minimumOrderingGap: options.minimumOrderingGap,
    },
    result,
  };
  yield* atomicWrite(options.output, `${JSON.stringify(artifact, undefined, 2)}\n`);
  yield* printJson({
    absoluteError: result.absoluteError,
    fixtureSha256,
    modelSha256: manifest.sha256,
    ordering: {
      comparisons: result.ordering.comparisons,
      failures: result.ordering.failures.length,
    },
    output: options.output,
    pairs: result.pairs,
    passed: result.passed,
    version: artifact.version,
  });
  if (!result.passed) yield* markFailure();
});

interface Options {
  readonly fixture: string;
  readonly manifest: string;
  readonly maximumAbsoluteError: number;
  readonly minimumOrderingGap: number;
  readonly model: string;
  readonly output: string;
}

function parseArguments(args: readonly string[], resolve: (value: string) => string): Options {
  let fixture: string | undefined;
  let manifest: string | undefined;
  let maximumAbsoluteError = DEFAULT_RERANKER_PARITY_MAXIMUM_ABSOLUTE_ERROR;
  let minimumOrderingGap = DEFAULT_RERANKER_PARITY_MINIMUM_ORDERING_GAP;
  let model: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--fixture') fixture = resolve(required(args[++index], argument));
    else if (argument === '--manifest') manifest = resolve(required(args[++index], argument));
    else if (argument === '--max-absolute-error') {
      maximumAbsoluteError = numberValue(args[++index], argument);
    } else if (argument === '--minimum-ordering-gap') {
      minimumOrderingGap = numberValue(args[++index], argument);
    } else if (argument === '--model') model = resolve(required(args[++index], argument));
    else if (argument === '--output') output = resolve(required(args[++index], argument));
    else throw new ScriptError(`Unknown reranker-parity option: ${argument}`);
  }
  return {
    fixture: required(fixture, '--fixture'),
    manifest: required(manifest, '--manifest'),
    maximumAbsoluteError,
    minimumOrderingGap,
    model: required(model, '--model'),
    output: required(output, '--output'),
  };
}

function verifyRuntimeBinding(
  expected: {
    readonly architecture: string;
    readonly contextLimit: number;
    readonly nodeLlamaCpp: string;
  },
  manifest: LocalModelManifest,
): void {
  if (manifest.role !== 'reranker') throw new ScriptError(`Local model ${manifest.id} is not a reranker.`);
  if (
    manifest.architecture !== expected.architecture ||
    manifest.contextLimit !== expected.contextLimit ||
    manifest.runtime.nodeLlamaCpp !== expected.nodeLlamaCpp
  ) {
    throw new ScriptError('Local reranker manifest does not match the Python parity fixture runtime target.');
  }
}

const verifyModelArtifact = Effect.fn('validateRecallRerankerParity.verifyModelArtifact')(function* (
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

function numberValue(value: string | undefined, option: string): number {
  const parsed = Number(required(value, option));
  if (!Number.isFinite(parsed) || parsed < 0) throw new ScriptError(`${option} requires a finite non-negative number.`);
  return parsed;
}

const systemLayer = SystemInfo.layer;
const runtimeLayer = isolatedLocalModelRuntimeLayer().pipe(Layer.provideMerge(systemLayer));
const ParityLayer = Layer.mergeAll(runtimeLayer, systemLayer).pipe(Layer.provideMerge(BunServices.layer));

BunRuntime.runMain(provideScriptLayer(validateParity, ParityLayer));
