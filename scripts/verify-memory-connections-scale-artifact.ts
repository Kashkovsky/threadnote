#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {
  memoryConnectionsScaleCandidateBinding,
  parseMemoryConnectionsScaleArtifactV1,
  parseMemoryConnectionsScaleBudgetV1,
} from '../src/evaluation/memory-connections-scale-contract.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {printJson, readJsonFile, scriptArguments} from './effect/script.js';

const DEFAULT_BUDGET = 'test/evaluation/baselines/memory-connections-scale-v1/budget.json';
export const MAX_MEMORY_CONNECTIONS_SCALE_ARTIFACT_BYTES = 32 * 1024 * 1024;

export interface VerifyMemoryConnectionsScaleArtifactOptions {
  readonly artifactPath: string;
  readonly budgetPath: string;
  readonly candidateCommit: string;
}

const program = Effect.gen(function* () {
  const options = parseVerifyMemoryConnectionsScaleArtifactArguments(yield* scriptArguments());
  const budget = parseMemoryConnectionsScaleBudgetV1(yield* readJsonFile(options.budgetPath));
  const candidate = yield* readCandidateBinding(options.candidateCommit);
  const input = yield* readMemoryConnectionsScaleArtifact(options.artifactPath);
  const artifact = yield* Effect.try({
    try: () => parseMemoryConnectionsScaleArtifactV1(input, budget, candidate),
    catch: cause => ScriptError.make({message: 'Memory Connections scale artifact replay failed.', cause}),
  });
  if (!artifact.gate.passed || artifact.evidenceClass !== 'release-scale') {
    return yield* ScriptError.make({message: artifact.gate.failures.join('\n')});
  }
  yield* printJson({
    artifact: options.artifactPath,
    candidateCommit: artifact.identity.candidateCommit,
    evidenceClass: artifact.evidenceClass,
    gate: artifact.gate,
    suite: artifact.suite,
    version: artifact.version,
  });
});

export const readMemoryConnectionsScaleArtifact = Effect.fn('memoryConnectionsScaleVerifier.readArtifact')(function* (
  file: string,
) {
  const bytes = yield* Effect.tryPromise({
    try: () =>
      Bun.file(file)
        .slice(0, MAX_MEMORY_CONNECTIONS_SCALE_ARTIFACT_BYTES + 1)
        .arrayBuffer(),
    catch: cause => ScriptError.make({message: `Could not read Memory Connections scale artifact ${file}.`, cause}),
  });
  if (bytes.byteLength > MAX_MEMORY_CONNECTIONS_SCALE_ARTIFACT_BYTES) {
    return yield* ScriptError.make({
      message: `Memory Connections scale artifact exceeds ${MAX_MEMORY_CONNECTIONS_SCALE_ARTIFACT_BYTES} bytes.`,
    });
  }
  return yield* Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: cause => ScriptError.make({message: `Could not parse JSON file ${file}.`, cause}),
  });
});

export function parseVerifyMemoryConnectionsScaleArtifactArguments(
  args: readonly string[],
): VerifyMemoryConnectionsScaleArtifactOptions {
  let artifactPath = '';
  let budgetPath = DEFAULT_BUDGET;
  let candidateCommit = '';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--artifact') artifactPath = required(args[++index], argument);
    else if (argument === '--budget') budgetPath = required(args[++index], argument);
    else if (argument === '--candidate-commit') candidateCommit = commit(args[++index], argument);
    else throw ScriptError.make({message: `Unknown Memory Connections artifact verification option: ${argument}`});
  }
  if (!artifactPath) throw ScriptError.make({message: '--artifact is required.'});
  if (!candidateCommit) throw ScriptError.make({message: '--candidate-commit is required.'});
  return {artifactPath, budgetPath, candidateCommit};
}

const readCandidateBinding = Effect.fn('memoryConnectionsScaleVerifier.readCandidate')(function* (
  candidateCommit: string,
) {
  const manifest = gitText(['show', `${candidateCommit}:package.json`]);
  if (manifest === undefined) {
    return yield* ScriptError.make({message: 'Could not read package.json from the exact release candidate.'});
  }
  return yield* Effect.try({
    try: () => memoryConnectionsScaleCandidateBinding(candidateCommit, JSON.parse(manifest) as unknown),
    catch: cause => ScriptError.make({message: 'Could not validate the candidate package and Bun versions.', cause}),
  });
});

function gitText(args: readonly string[]): string | undefined {
  const result = Bun.spawnSync({cmd: ['git', ...args], stderr: 'ignore', stdout: 'pipe'});
  return result.exitCode === 0 && result.stdout ? new TextDecoder().decode(result.stdout).trim() : undefined;
}

function commit(value: string | undefined, option: string): string {
  const parsed = required(value, option);
  if (!/^[0-9a-f]{40}$/u.test(parsed)) {
    throw ScriptError.make({message: `${option} requires 40 lowercase hex characters.`});
  }
  return parsed;
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
