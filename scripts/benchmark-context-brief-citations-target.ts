#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Clock, Effect, FileSystem, Layer} from 'effect';
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
import {sha256FileHex} from '../src/effect/digest.js';
import {SystemInfo} from '../src/effect/system.js';
import {
  CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS,
  parseContextBriefCitationScaleArtifactV2,
  parseContextBriefCitationScaleBudgetV1,
  type ContextBriefCitationScaleProfileId,
} from '../src/evaluation/context-brief-citation-scale-contract.js';
import {
  ContextBriefCitationScaleGraphInstrumentation,
  evaluateContextBriefCitationScale,
  makeContextBriefCitationScaleGraphInstrumentation,
  type ContextBriefCitationScaleRssObserver,
} from '../src/evaluation/context-brief-citation-scale.js';
import {
  contextBriefCitationRssObserverArguments,
  isContextBriefCitationRssObserverMode,
  parseContextBriefCitationRssArtifact,
  parseContextBriefCitationRssReady,
  runContextBriefCitationRssObserverMode,
  waitForContextBriefCitationRssAcknowledgement,
  writeContextBriefCitationRssRequest,
  type ContextBriefCitationRssAcknowledgementV2,
  type ContextBriefCitationRssArtifactV2,
  type ContextBriefCitationRssReadyV2,
  type ContextBriefCitationRssRequestV2,
} from './context-brief-citation-rss-observer.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';

const DEFAULT_BUDGET = 'test/evaluation/baselines/context-brief-citations-v1/scale-budgets.json';
const RSS_OBSERVER_BARRIER_TIMEOUT_MILLISECONDS = 30_000;
const RSS_OBSERVER_EXIT_TIMEOUT_MILLISECONDS = 30_000;
const RSS_OBSERVER_KILL_TIMEOUT_MILLISECONDS = 5_000;
const RSS_OBSERVER_MAXIMUM_STDERR_BYTES = 64 * 1_024;
const RSS_OBSERVER_READY_TIMEOUT_MILLISECONDS = 30_000;

type ContextBriefCitationRssBarrierRequest =
  {readonly observationId: string; readonly operation: 'begin' | 'end'} | {readonly operation: 'stop'};

export interface ContextBriefCitationRssReadyProbe {
  readonly childExitCode: () => number | null;
  readonly readReady: Effect.Effect<ContextBriefCitationRssReadyV2 | undefined, Error>;
  readonly stderr: Promise<string>;
  readonly timeoutMilliseconds?: number;
}

export interface ContextBriefCitationRssTerminationControl {
  readonly exitCode: () => number | null;
  readonly kill: (signal?: number) => void;
  readonly waitForExit: () => Promise<number | undefined>;
}

export interface ContextBriefCitationRssControllerAdapter {
  readonly barrier: (
    request: ContextBriefCitationRssBarrierRequest,
    expected: ContextBriefCitationRssAcknowledgementV2['state'],
  ) => Effect.Effect<void, Error>;
  readonly childExitCode: () => number | null;
  readonly exitWithin: Effect.Effect<number | undefined>;
  readonly readArtifact: Effect.Effect<ContextBriefCitationRssArtifactV2, Error>;
  readonly ready: ContextBriefCitationRssReadyV2;
  readonly stderr: Promise<string>;
  readonly terminate: Effect.Effect<void, Error>;
}

export interface ContextBriefCitationScaleBenchmarkOptions {
  readonly budgetPath: string;
  readonly builtArtifactSha256: string;
  readonly candidateCommit?: string;
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
        options.samples !== 25 ||
        options.warmups !== 5 ||
        JSON.stringify(options.profileIds) !== JSON.stringify(CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS) ||
        !/^[0-9a-f]{40}$/u.test(options.candidateCommit ?? ''))
    ) {
      return yield* Effect.fail(
        new ScriptError(
          '--fail-on-budget requires an exact candidate commit, the reviewed 100k corpus, all three profiles, exactly 25 samples, and exactly 5 warmups.',
        ),
      );
    }
    const evaluatedArtifact = yield* evaluateContextBriefCitationScale({
      budget,
      builtArtifactSha256: options.builtArtifactSha256,
      invocationMode: options.failOnBudget ? 'release-scale' : 'development-smoke',
      memoryCandidates: options.memoryCandidates,
      profileIds: options.profileIds,
      ...(options.candidateCommit === undefined ? {} : {releaseCandidateCommit: options.candidateCommit}),
      samples: options.samples,
      startRssObserver: startContextBriefCitationRssObserver(options.builtArtifactSha256),
      warmups: options.warmups,
    });
    const artifact = parseContextBriefCitationScaleArtifactV2(evaluatedArtifact, budget);
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
  let candidateCommit: string | undefined;
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
    else if (argument === '--candidate-commit') candidateCommit = required(args[++index], argument);
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
    ...(candidateCommit === undefined ? {} : {candidateCommit}),
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

export const validateContextBriefCitationRssBundleDigest = Effect.fn(
  'contextBriefCitationScale.validateRssBundleDigest',
)(function* (observed: string, expected: string) {
  if (observed === expected) return;
  return yield* Effect.fail(
    new ScriptError(`Context Brief benchmark target digest ${observed}; expected ${expected}.`),
  );
});

export const validateContextBriefCitationRssAcknowledgement = Effect.fn(
  'contextBriefCitationScale.validateRssAcknowledgement',
)(function* (
  request: ContextBriefCitationRssRequestV2,
  expected: ContextBriefCitationRssAcknowledgementV2['state'],
  acknowledgement: ContextBriefCitationRssAcknowledgementV2,
) {
  if (
    acknowledgement.sequence === request.sequence &&
    acknowledgement.version === request.version &&
    acknowledgement.state === expected &&
    (!('observationId' in request) ||
      ('observationId' in acknowledgement && acknowledgement.observationId === request.observationId))
  ) {
    return;
  }
  return yield* Effect.fail(new ScriptError('Context Brief RSS observer returned a mismatched barrier.'));
});

export const validateContextBriefCitationRssReadyArtifact = Effect.fn(
  'contextBriefCitationScale.validateRssReadyArtifact',
)(function* (ready: ContextBriefCitationRssReadyV2, artifact: ContextBriefCitationRssArtifactV2) {
  if (
    artifact.intervalMilliseconds === ready.intervalMilliseconds &&
    artifact.observerExcluded === ready.observerExcluded &&
    artifact.rootIdentityValidation === ready.rootIdentityValidation &&
    artifact.rootStartIdentity === ready.rootStartIdentity &&
    artifact.samplingSchedule === ready.samplingSchedule &&
    artifact.scope === ready.scope &&
    artifact.source === ready.source &&
    artifact.version === ready.version
  ) {
    return;
  }
  return yield* Effect.fail(new ScriptError('Context Brief RSS observer artifact changed its ready contract.'));
});

export function makeContextBriefCitationRssObserverController(
  adapter: ContextBriefCitationRssControllerAdapter,
): ContextBriefCitationScaleRssObserver {
  let activeObservationId: string | undefined;
  let finished = false;
  const observe: ContextBriefCitationScaleRssObserver['observe'] = (observationId, effect) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        if (finished || activeObservationId !== undefined) {
          return yield* Effect.fail(new ScriptError('Context Brief RSS observer received overlapping work.'));
        }
        yield* adapter.barrier({observationId, operation: 'begin'}, 'begun');
        activeObservationId = observationId;
      }),
      () => effect,
      () =>
        Effect.gen(function* () {
          if (activeObservationId !== observationId) {
            return yield* Effect.fail(new ScriptError('Context Brief RSS observer lost its active observation.'));
          }
          yield* adapter.barrier({observationId, operation: 'end'}, 'ended');
          activeObservationId = undefined;
        }),
    );
  const finish = Effect.gen(function* () {
    if (finished || activeObservationId !== undefined) {
      return yield* Effect.fail(new ScriptError('Context Brief RSS observer cannot finish in its current state.'));
    }
    yield* adapter.barrier({operation: 'stop'}, 'stopped');
    const exitCode = yield* adapter.exitWithin;
    if (exitCode === undefined) {
      yield* adapter.terminate;
      return yield* Effect.fail(new ScriptError('Context Brief RSS observer did not exit after its stop barrier.'));
    }
    if (exitCode !== 0) {
      return yield* Effect.fail(
        new ScriptError(
          `Context Brief RSS observer exited with ${exitCode}: ${yield* boundedObserverStderr(adapter.stderr)}`,
        ),
      );
    }
    const artifact = yield* adapter.readArtifact;
    yield* validateContextBriefCitationRssReadyArtifact(adapter.ready, artifact);
    finished = true;
    return artifact;
  });
  const close = Effect.gen(function* () {
    if (adapter.childExitCode() !== null) return;
    yield* adapter.terminate;
  });
  return {close, finish, observe};
}

const startContextBriefCitationRssObserver = Effect.fn('contextBriefCitationScale.startRssObserver')(function* (
  expectedBuiltArtifactSha256: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  if (system.platform !== 'darwin' && system.platform !== 'linux') {
    return yield* Effect.fail(new ScriptError(`Context Brief RSS observation does not support ${system.platform}.`));
  }
  const bundlePath = system.processArguments[1];
  if (bundlePath === undefined || bundlePath.length === 0) {
    return yield* Effect.fail(new ScriptError('Context Brief RSS observer could not resolve the benchmark target.'));
  }
  const observedBuiltArtifactSha256 = yield* sha256FileHex(bundlePath);
  yield* validateContextBriefCitationRssBundleDigest(observedBuiltArtifactSha256, expectedBuiltArtifactSha256);
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-context-brief-rss-observer-'});
  const paths = {
    acknowledgementPath: `${root}/acknowledgement.json`,
    outputPath: `${root}/artifact.json`,
    readyPath: `${root}/ready.json`,
    requestPath: `${root}/request.json`,
  };
  const intervalMilliseconds = system.platform === 'darwin' ? 25 : 10;
  const child = yield* Effect.try({
    try: () =>
      Bun.spawn({
        cmd: [
          system.executablePath,
          bundlePath,
          ...contextBriefCitationRssObserverArguments({
            ...paths,
            barrierTimeoutMilliseconds: RSS_OBSERVER_BARRIER_TIMEOUT_MILLISECONDS,
            intervalMilliseconds,
            rootProcessId: system.processId,
          }),
        ],
        maxBuffer: RSS_OBSERVER_MAXIMUM_STDERR_BYTES,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'ignore',
      }),
    catch: cause => new ScriptError('Could not start the Context Brief RSS observer.', {cause}),
  });
  const stderr = contextBriefCitationRssObserverStderr(child);
  const ready = yield* waitForContextBriefCitationRssReady({
    childExitCode: () => child.exitCode,
    readReady: Effect.gen(function* () {
      if (!(yield* fs.exists(paths.readyPath))) return undefined;
      const value = yield* readJsonFile(paths.readyPath).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      return yield* Effect.try({
        try: () => parseContextBriefCitationRssReady(value),
        catch: cause => new ScriptError('Context Brief RSS observer ready evidence is invalid.', {cause}),
      });
    }),
    stderr,
  }).pipe(Effect.tapError(() => terminateContextBriefCitationRssObserver(child)));
  if (ready.intervalMilliseconds !== intervalMilliseconds) {
    yield* terminateContextBriefCitationRssObserver(child);
    return yield* Effect.fail(new ScriptError('Context Brief RSS observer acknowledged the wrong sample interval.'));
  }
  let sequence = 0;
  const barrier = (
    request: ContextBriefCitationRssBarrierRequest,
    expected: ContextBriefCitationRssAcknowledgementV2['state'],
  ) =>
    Effect.gen(function* () {
      sequence += 1;
      const sequenced = {...request, sequence, version: 2 as const} as ContextBriefCitationRssRequestV2;
      yield* writeContextBriefCitationRssRequest(paths.requestPath, sequenced).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const acknowledgement = yield* waitForContextBriefCitationRssAcknowledgement(
        paths.acknowledgementPath,
        sequence,
        RSS_OBSERVER_BARRIER_TIMEOUT_MILLISECONDS,
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      yield* validateContextBriefCitationRssAcknowledgement(sequenced, expected, acknowledgement);
    });
  return makeContextBriefCitationRssObserverController({
    barrier,
    childExitCode: () => child.exitCode,
    exitWithin: Effect.promise(() =>
      contextBriefCitationRssObserverExitWithin(child, RSS_OBSERVER_EXIT_TIMEOUT_MILLISECONDS),
    ),
    readArtifact: readJsonFile(paths.outputPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.flatMap(value =>
        Effect.try({
          try: () => parseContextBriefCitationRssArtifact(value),
          catch: cause => new ScriptError('Context Brief RSS observer artifact is invalid.', {cause}),
        }),
      ),
    ),
    ready,
    stderr,
    terminate: terminateContextBriefCitationRssObserver(child),
  });
});

export const waitForContextBriefCitationRssReady = Effect.fn('contextBriefCitationScale.waitForRssReady')(function* (
  probe: ContextBriefCitationRssReadyProbe,
) {
  const timeoutMilliseconds = probe.timeoutMilliseconds ?? RSS_OBSERVER_READY_TIMEOUT_MILLISECONDS;
  const startedAt = yield* Clock.currentTimeMillis;
  while (true) {
    const ready = yield* probe.readReady;
    if (ready !== undefined && probe.childExitCode() === null) return ready;
    if (probe.childExitCode() !== null) {
      return yield* Effect.fail(
        new ScriptError(
          `Context Brief RSS observer exited before ready: ${yield* boundedObserverStderr(probe.stderr)}`,
        ),
      );
    }
    if ((yield* Clock.currentTimeMillis) - startedAt >= timeoutMilliseconds) {
      return yield* Effect.fail(
        new ScriptError('Timed out waiting for the Context Brief RSS observer to become ready.'),
      );
    }
    yield* Effect.sleep(10);
  }
});

export const terminateContextBriefCitationRssProcess = Effect.fn('contextBriefCitationScale.terminateRssProcess')(
  function* (control: ContextBriefCitationRssTerminationControl) {
    if (control.exitCode() !== null) return;
    yield* Effect.try({
      try: () => control.kill(),
      catch: cause => new ScriptError('Could not terminate the Context Brief RSS observer.', {cause}),
    });
    const terminated = yield* Effect.promise(control.waitForExit);
    if (terminated !== undefined || control.exitCode() !== null) return;
    yield* Effect.try({
      try: () => control.kill(9),
      catch: cause => new ScriptError('Could not kill the Context Brief RSS observer.', {cause}),
    });
    const killed = yield* Effect.promise(control.waitForExit);
    if (killed === undefined && control.exitCode() === null) {
      return yield* Effect.fail(new ScriptError('Context Brief RSS observer could not be confirmed stopped.'));
    }
  },
);

const terminateContextBriefCitationRssObserver = Effect.fn('contextBriefCitationScale.terminateRssObserver')(function* (
  child: ReturnType<typeof Bun.spawn>,
) {
  return yield* terminateContextBriefCitationRssProcess({
    exitCode: () => child.exitCode,
    kill: signal => child.kill(signal),
    waitForExit: () => contextBriefCitationRssObserverExitWithin(child, RSS_OBSERVER_KILL_TIMEOUT_MILLISECONDS),
  });
});

function contextBriefCitationRssObserverExitWithin(
  child: ReturnType<typeof Bun.spawn>,
  timeoutMilliseconds: number,
): Promise<number | undefined> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve(undefined), timeoutMilliseconds);
    timeout.unref?.();
    void child.exited.then(
      exitCode => {
        clearTimeout(timeout);
        resolve(exitCode);
      },
      () => {
        clearTimeout(timeout);
        resolve(undefined);
      },
    );
  });
}

function contextBriefCitationRssObserverStderr(child: ReturnType<typeof Bun.spawn>): Promise<string> {
  const stream = child.stderr;
  if (!(stream instanceof ReadableStream)) return Promise.resolve('');
  return new Response(stream).text().catch(() => '');
}

const boundedObserverStderr = Effect.fn('contextBriefCitationScale.boundedRssObserverStderr')(function* (
  stderr: Promise<string>,
) {
  const text = yield* Effect.promise(() => stderr);
  return text.trim().slice(0, 4_096) || 'no diagnostic';
});

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

if (import.meta.main) {
  const args = process.argv.slice(2);
  BunRuntime.runMain(
    isContextBriefCitationRssObserverMode(args)
      ? provideScriptLayer(runContextBriefCitationRssObserverMode(args), platformLayer)
      : provideScriptLayer(program, targetLayer),
  );
}
