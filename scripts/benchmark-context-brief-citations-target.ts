#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer} from 'effect';
import {CodeGraphEmbeddingIndex} from '../src/code_graph/embedding.js';
import {CodeGraphIndexer} from '../src/code_graph/indexer.js';
import {
  CodeGraphLanguagePackRegistry,
  createCodeGraphLanguagePackRegistry,
} from '../src/code_graph/languages/registry.js';
import {CodeGraphMaintenanceCoordinator} from '../src/code_graph/maintenance_coordinator.js';
import {CodeGraphQueryService} from '../src/code_graph/query.js';
import {CodeGraphStore} from '../src/code_graph/store.js';
import {CommandExecutor} from '../src/effect/command.js';
import {SystemInfo} from '../src/effect/system.js';
import {
  CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS,
  parseContextBriefCitationScaleBudgetV1,
  type ContextBriefCitationScaleProfileId,
} from '../src/evaluation/context-brief-citation-scale-contract.js';
import {
  ContextBriefCitationScaleGraphInstrumentation,
  evaluateContextBriefCitationScale,
  makeContextBriefCitationScaleGraphInstrumentation,
} from '../src/evaluation/context-brief-citation-scale.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';

const DEFAULT_BUDGET = 'test/evaluation/baselines/context-brief-citations-v1/scale-budgets.json';

export interface ContextBriefCitationScaleBenchmarkOptions {
  readonly budgetPath: string;
  readonly builtArtifactSha256: string;
  readonly failOnBudget: boolean;
  readonly memoryCandidates: number;
  readonly outputPath?: string;
  readonly profileIds: readonly ContextBriefCitationScaleProfileId[];
  readonly samples: number;
  readonly warmups: number;
}

const program = Effect.scoped(
  Effect.gen(function* () {
    const options = parseContextBriefCitationScaleBenchmarkArguments(yield* scriptArguments());
    const budget = parseContextBriefCitationScaleBudgetV1(yield* readJsonFile(options.budgetPath));
    if (
      options.failOnBudget &&
      (options.memoryCandidates !== budget.corpusMemoryCandidates ||
        options.samples < 25 ||
        options.warmups < 5 ||
        JSON.stringify(options.profileIds) !== JSON.stringify(CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS))
    ) {
      return yield* Effect.fail(
        new ScriptError(
          '--fail-on-budget requires the reviewed 100k corpus, all three profiles, at least 25 samples, and 5 warmups.',
        ),
      );
    }
    const artifact = yield* evaluateContextBriefCitationScale({
      budget,
      builtArtifactSha256: options.builtArtifactSha256,
      memoryCandidates: options.memoryCandidates,
      profileIds: options.profileIds,
      samples: options.samples,
      warmups: options.warmups,
    });
    if (options.outputPath !== undefined) {
      yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    }
    yield* printJson(artifact);
    if (options.failOnBudget && !artifact.gate.passed) {
      return yield* Effect.fail(new ScriptError(artifact.gate.failures.join('\n')));
    }
  }),
);

export function parseContextBriefCitationScaleBenchmarkArguments(
  args: readonly string[],
): ContextBriefCitationScaleBenchmarkOptions {
  let budgetPath = DEFAULT_BUDGET;
  let builtArtifactSha256 = '';
  let failOnBudget = false;
  let memoryCandidates = 100_000;
  let outputPath: string | undefined;
  let profileIds: readonly ContextBriefCitationScaleProfileId[] = CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS;
  let samples = 25;
  let warmups = 5;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--budget') budgetPath = required(args[++index], argument);
    else if (argument === '--built-artifact-sha256') builtArtifactSha256 = required(args[++index], argument);
    else if (argument === '--fail-on-budget') failOnBudget = true;
    else if (argument === '--memory-candidates') memoryCandidates = positiveInteger(args[++index], argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--profiles') profileIds = profiles(required(args[++index], argument));
    else if (argument === '--samples') samples = positiveInteger(args[++index], argument);
    else if (argument === '--warmups') warmups = nonNegativeInteger(args[++index], argument);
    else throw new ScriptError(`Unknown Context Brief citation scale benchmark option: ${argument}`);
  }
  return {
    budgetPath,
    builtArtifactSha256,
    failOnBudget,
    memoryCandidates,
    ...(outputPath === undefined ? {} : {outputPath}),
    profileIds,
    samples,
    warmups,
  };
}

function profiles(value: string): readonly ContextBriefCitationScaleProfileId[] {
  const selected = value.split(',').filter(Boolean);
  if (
    selected.length === 0 ||
    new Set(selected).size !== selected.length ||
    selected.some(
      profile => !CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS.includes(profile as ContextBriefCitationScaleProfileId),
    )
  ) {
    throw new ScriptError('--profiles must be a unique comma-separated subset of local-100k,workset-50,workset-128.');
  }
  return selected as ContextBriefCitationScaleProfileId[];
}

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = nonNegativeInteger(value, option);
  if (parsed < 1) throw new ScriptError(`${option} requires a positive integer.`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, option: string): number {
  const raw = required(value, option);
  if (!/^\d+$/u.test(raw)) throw new ScriptError(`${option} requires a non-negative integer.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new ScriptError(`${option} exceeds the safe integer range.`);
  return parsed;
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new ScriptError(`${option} requires a value.`);
  return value;
}

const systemLayer = SystemInfo.layer;
const commandLayer = CommandExecutor.layer.pipe(Layer.provide(systemLayer));
const platformLayer = Layer.mergeAll(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));
const graphInstrumentation = makeContextBriefCitationScaleGraphInstrumentation();
const graphInstrumentationLayer = Layer.succeed(ContextBriefCitationScaleGraphInstrumentation, graphInstrumentation);
const realStoreLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(platformLayer));
const instrumentedStoreLayer = Layer.effect(
  CodeGraphStore,
  Effect.gen(function* () {
    const store = yield* CodeGraphStore;
    return CodeGraphStore.of(graphInstrumentation.instrumentStore(store));
  }),
).pipe(Layer.provide(realStoreLayer));
const queryDependencies = Layer.mergeAll(
  platformLayer,
  graphInstrumentationLayer,
  instrumentedStoreLayer,
  Layer.succeed(CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry([])),
  Layer.succeed(
    CodeGraphIndexer,
    CodeGraphIndexer.of({
      ensureCommit: () =>
        graphInstrumentation.recordColdGraphBuild.pipe(
          Effect.andThen(Effect.die(new Error('Scale benchmark must not start commit indexing.'))),
        ),
      index: () =>
        graphInstrumentation.recordColdGraphBuild.pipe(
          Effect.andThen(Effect.die(new Error('Scale benchmark must not start graph indexing.'))),
        ),
    }),
  ),
  Layer.succeed(
    CodeGraphMaintenanceCoordinator,
    CodeGraphMaintenanceCoordinator.of({
      kickOrdinary: () => Effect.die(new Error('Scale benchmark must not run ordinary graph maintenance.')),
      kickReconciliation: () => Effect.die(new Error('Scale benchmark must not run graph reconciliation maintenance.')),
      kickResidual: () => Effect.die(new Error('Scale benchmark must not run residual graph maintenance.')),
      request: () => graphInstrumentation.recordMaintenanceRequest,
      tick: () => Effect.die(new Error('Scale benchmark must not tick graph maintenance.')),
    }),
  ),
  Layer.succeed(
    CodeGraphEmbeddingIndex,
    CodeGraphEmbeddingIndex.of({
      check: () => Effect.die(new Error('Scale benchmark must not check graph embeddings.')),
      ensure: () => Effect.die(new Error('Scale benchmark must not build graph embeddings.')),
      search: () => Effect.succeed(new Map()),
    }),
  ),
);
const targetLayer = CodeGraphQueryService.layer.pipe(Layer.provideMerge(queryDependencies));

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, targetLayer));
