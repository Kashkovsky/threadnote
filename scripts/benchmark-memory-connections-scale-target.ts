#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {SystemInfo} from '../src/effect/system.js';
import {
  evaluateMemoryConnectionsScaleCapture,
  MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
  parseMemoryConnectionsScaleBudgetV1,
} from '../src/evaluation/memory-connections-scale-contract.js';
import {runMemoryConnectionsScaleWorkload} from '../src/evaluation/memory-connections-scale.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';

const DEFAULT_BUDGET = 'test/evaluation/baselines/memory-connections-scale-v1/budget.json';
const GIT_STATUS_ARGS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  'status',
  '--porcelain=v1',
  '--untracked-files=all',
  '--no-renames',
] as const;

export interface MemoryConnectionsScaleTargetOptions {
  readonly budgetPath: string;
  readonly builtArtifactSha256: string;
  readonly candidateCommit: string;
  readonly developmentSmoke: boolean;
  readonly memoryCandidates: number;
  readonly outputPath?: string;
  readonly samples: number;
  readonly warmups: number;
}

const program = Effect.scoped(
  Effect.gen(function* () {
    const options = parseMemoryConnectionsScaleTargetArguments(yield* scriptArguments());
    const budget = parseMemoryConnectionsScaleBudgetV1(yield* readJsonFile(options.budgetPath));
    const observedCommit = gitText(['rev-parse', 'HEAD']);
    const dirty = gitText(GIT_STATUS_ARGS).length > 0;
    if (!options.developmentSmoke && (observedCommit !== options.candidateCommit || dirty)) {
      return yield* Effect.fail(new ScriptError('Release-scale evidence requires the exact clean candidate checkout.'));
    }
    const capture = yield* runMemoryConnectionsScaleWorkload({
      memoryCandidates: options.memoryCandidates,
      samples: options.samples,
      warmups: options.warmups,
    });
    const system = yield* SystemInfo;
    const artifact = evaluateMemoryConnectionsScaleCapture({
      budget,
      capture,
      createdAt: new Date().toISOString(),
      identity: {
        builtArtifactSha256: options.builtArtifactSha256,
        candidateCommit: options.candidateCommit,
        dirty,
        invocationMode: options.developmentSmoke ? 'development-smoke' : 'release-scale',
        observedCommit,
        runnerClass: system.environment().THREADNOTE_BENCHMARK_RUNNER_CLASS ?? 'local-unpinned',
        runtime: `bun/${system.runtimeVersion}`,
      },
    });
    if (options.outputPath !== undefined) {
      yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    }
    yield* printJson(artifact);
    if (!options.developmentSmoke && !artifact.gate.passed) {
      return yield* Effect.fail(new ScriptError(artifact.gate.failures.join('\n')));
    }
  }),
);

export function parseMemoryConnectionsScaleTargetArguments(
  args: readonly string[],
): MemoryConnectionsScaleTargetOptions {
  let budgetPath = DEFAULT_BUDGET;
  let builtArtifactSha256 = '';
  let candidateCommit = '';
  let developmentSmoke = false;
  let memoryCandidates: number | undefined;
  let outputPath: string | undefined;
  let samples: number | undefined;
  let warmups: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--budget') budgetPath = required(args[++index], argument);
    else if (argument === '--built-artifact-sha256') builtArtifactSha256 = required(args[++index], argument);
    else if (argument === '--candidate-commit') candidateCommit = commit(args[++index], argument);
    else if (argument === '--development-smoke') developmentSmoke = true;
    else if (argument === '--memory-candidates') memoryCandidates = positiveInteger(args[++index], argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--samples') samples = positiveInteger(args[++index], argument);
    else if (argument === '--warmups') warmups = nonNegativeInteger(args[++index], argument);
    else throw new ScriptError(`Unknown memory-connections scale option: ${argument}`);
  }
  if (!candidateCommit) throw new ScriptError('--candidate-commit is required.');
  if (!developmentSmoke && (memoryCandidates !== undefined || samples !== undefined || warmups !== undefined)) {
    throw new ScriptError('--memory-candidates, --samples, and --warmups require --development-smoke.');
  }
  return {
    budgetPath,
    builtArtifactSha256,
    candidateCommit,
    developmentSmoke,
    memoryCandidates:
      memoryCandidates ?? (developmentSmoke ? 1_000 : MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.corpusMemoryCount),
    ...(outputPath === undefined ? {} : {outputPath}),
    samples: samples ?? (developmentSmoke ? 3 : MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.minimumSamples),
    warmups: warmups ?? (developmentSmoke ? 1 : MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.minimumWarmups),
  };
}

function gitText(args: readonly string[]): string {
  const result = Bun.spawnSync({cmd: ['git', ...args], stderr: 'ignore', stdout: 'pipe'});
  return result.exitCode === 0 && result.stdout ? new TextDecoder().decode(result.stdout).trim() : '';
}

function commit(value: string | undefined, option: string): string {
  const parsed = required(value, option);
  if (!/^[0-9a-f]{40}$/u.test(parsed)) throw new ScriptError(`${option} requires 40 lowercase hex characters.`);
  return parsed;
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

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
