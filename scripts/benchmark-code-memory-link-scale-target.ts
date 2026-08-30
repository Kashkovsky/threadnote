#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {SystemInfo} from '../src/effect/system.js';
import {
  CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET,
  evaluateCodeMemoryLinkScaleCapture,
  parseCodeMemoryLinkScaleArtifactV1,
  parseCodeMemoryLinkScaleBudgetV1,
} from '../src/evaluation/code-memory-link-scale-contract.js';
import {runCodeMemoryLinkScaleWorkload} from '../src/evaluation/code-memory-link-scale.js';
import {getThreadnoteVersion} from '../src/release/runtime_version.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';

const DEFAULT_BUDGET = 'test/evaluation/baselines/code-memory-link-scale-v1/budget.json';
const CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'status.showUntrackedFiles=all',
  '-c',
  'diff.ignoreSubmodules=none',
  'status',
  '--porcelain=v1',
  '--untracked-files=all',
  '--ignore-submodules=none',
  '--no-renames',
] as const;

export interface CodeMemoryLinkScaleTargetOptions {
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
    const options = parseCodeMemoryLinkScaleTargetArguments(yield* scriptArguments());
    const budget = parseCodeMemoryLinkScaleBudgetV1(yield* readJsonFile(options.budgetPath));
    const observedCommit = gitText(['rev-parse', 'HEAD']);
    const dirty = gitText(CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS).length > 0;
    if (observedCommit.length !== 40) {
      return yield* Effect.fail(new ScriptError('Could not resolve the exact benchmark source commit.'));
    }
    if (!options.developmentSmoke && observedCommit !== options.candidateCommit) {
      return yield* Effect.fail(
        new ScriptError(`Observed commit ${observedCommit}; required exact candidate ${options.candidateCommit}.`),
      );
    }
    if (!options.developmentSmoke && dirty) {
      return yield* Effect.fail(
        new ScriptError('Release-scale evidence requires an exact clean checkout (dirty=false).'),
      );
    }
    if (!options.developmentSmoke && !/^[0-9a-f]{64}$/u.test(options.builtArtifactSha256)) {
      return yield* Effect.fail(new ScriptError('Release-scale evidence requires the built target SHA-256 digest.'));
    }
    const capture = yield* runCodeMemoryLinkScaleWorkload({
      memoryCandidates: options.memoryCandidates,
      samples: options.samples,
      warmups: options.warmups,
    });
    const system = yield* SystemInfo;
    const [hardware, sourceVersion] = yield* Effect.all([system.hardwareInfo, getThreadnoteVersion()]);
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      capture,
      createdAt: new Date().toISOString(),
      identity: {
        architecture: system.architecture,
        builtArtifactSha256: options.builtArtifactSha256,
        candidateCommit: options.candidateCommit,
        cpu: hardware.cpuModel,
        dirty,
        invocationMode: options.developmentSmoke ? 'development-smoke' : 'release-scale',
        memoryBytes: hardware.memoryBytes,
        observedCommit,
        operatingSystem: hardware.operatingSystem,
        runnerClass: system.environment().THREADNOTE_BENCHMARK_RUNNER_CLASS ?? 'local-unpinned',
        runtime: `bun/${system.runtimeVersion}`,
        sourceVersion: `threadnote-${sourceVersion}`,
      },
    });
    const verified = parseCodeMemoryLinkScaleArtifactV1(artifact, budget);
    if (options.outputPath !== undefined) {
      yield* atomicWrite(options.outputPath, `${JSON.stringify(verified, undefined, 2)}\n`);
    }
    yield* printJson(verified);
    if (!options.developmentSmoke && !verified.gate.passed) {
      return yield* Effect.fail(new ScriptError(verified.gate.failures.join('\n')));
    }
  }),
);

export function parseCodeMemoryLinkScaleTargetArguments(args: readonly string[]): CodeMemoryLinkScaleTargetOptions {
  let budgetPath = DEFAULT_BUDGET;
  let builtArtifactSha256 = '';
  let candidateCommit = '';
  let developmentSmoke = false;
  let memoryCandidates: number | undefined;
  let outputPath: string | undefined;
  let samples: number | undefined;
  let warmups: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--budget') budgetPath = required(args[++index], argument);
    else if (argument === '--built-artifact-sha256') builtArtifactSha256 = required(args[++index], argument);
    else if (argument === '--candidate-commit') candidateCommit = commit(args[++index], argument);
    else if (argument === '--development-smoke') developmentSmoke = true;
    else if (argument === '--memory-candidates') memoryCandidates = positiveInteger(args[++index], argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--samples') samples = positiveInteger(args[++index], argument);
    else if (argument === '--warmups') warmups = nonNegativeInteger(args[++index], argument);
    else throw new ScriptError(`Unknown inverse-selector scale benchmark option: ${argument}`);
  }
  if (!candidateCommit) throw new ScriptError('--candidate-commit is required.');
  if (!developmentSmoke && (memoryCandidates !== undefined || samples !== undefined || warmups !== undefined)) {
    throw new ScriptError(
      '--memory-candidates, --samples, and --warmups require --development-smoke; release scale is fixed.',
    );
  }
  return {
    budgetPath,
    builtArtifactSha256,
    candidateCommit,
    developmentSmoke,
    memoryCandidates:
      memoryCandidates ?? (developmentSmoke ? 1_000 : CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET.corpusMemoryCount),
    ...(outputPath === undefined ? {} : {outputPath}),
    samples: samples ?? (developmentSmoke ? 3 : CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET.minimumSamples),
    warmups: warmups ?? (developmentSmoke ? 1 : CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET.minimumWarmups),
  };
}

function gitText(args: readonly string[]): string {
  const result = Bun.spawnSync({cmd: ['git', ...args], stderr: 'ignore', stdout: 'pipe'});
  return result.exitCode === 0 && result.stdout ? new TextDecoder().decode(result.stdout).trim() : '';
}

function commit(value: string | undefined, option: string): string {
  const parsed = required(value, option);
  if (!/^[0-9a-f]{40}$/u.test(parsed)) throw new ScriptError(`${option} requires exactly 40 lowercase hex characters.`);
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
