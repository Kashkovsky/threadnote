#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Console, Effect, FileSystem} from 'effect';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {
  assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1,
  assertCodeMemoryLinkAgentAbRuntimeIdentity,
  evaluateCodeMemoryLinkAgentAb,
  parseCodeMemoryLinkAgentAbTrialsJsonl,
} from '../src/evaluation/code-memory-link-agent-ab.js';
import {
  parseCodeMemoryLinkAgentAttemptsJsonl,
  resolveCodeMemoryLinkAgentLedgerLayout,
  withCodeMemoryLinkAgentLedgerLock,
} from '../src/evaluation/code-memory-link-agent-attempts.js';
import {parseCodeMemoryLinkAgentEvidenceJsonl} from '../src/evaluation/code-memory-link-agent-evidence.js';
import {verifyManagedDevelopmentRuntimeForSource} from './development-runtime.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {readJsonFile, scriptArguments} from './effect/script.js';

const program = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  const fs = yield* FileSystem.FileSystem;
  const assignment = yield* readJsonFile(options.assignmentPath);
  const manifest = yield* readJsonFile(options.manifestPath);
  const layout = yield* resolveCodeMemoryLinkAgentLedgerLayout(
    options.trialsPath,
    options.attemptsPath,
    options.evidencePath,
  );
  const {attempts, evidence, trials} = yield* withCodeMemoryLinkAgentLedgerLock(
    layout,
    60_000,
    Effect.gen(function* () {
      if (yield* fs.exists(layout.pendingPath)) {
        return yield* Effect.fail(
          new ScriptError('A pending trial commit requires recovery through the trial runner before evaluation.'),
        );
      }
      const [attemptSource, evidenceSource, trialSource] = yield* Effect.all(
        [
          fs.readFileString(layout.attemptsPath),
          fs.readFileString(layout.evidencePath),
          fs.readFileString(layout.trialsPath),
        ],
        {concurrency: 3},
      );
      return {
        attempts: parseCodeMemoryLinkAgentAttemptsJsonl(attemptSource),
        evidence: parseCodeMemoryLinkAgentEvidenceJsonl(evidenceSource),
        trials: parseCodeMemoryLinkAgentAbTrialsJsonl(trialSource),
      };
    }),
  );
  assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1({assignment, manifest, trials});
  const result = evaluateCodeMemoryLinkAgentAb({assignment, attempts, evidence, manifest, trials});
  const runtime = yield* verifyManagedDevelopmentRuntimeForSource(options.candidateCommit);
  yield* Effect.try({
    try: () => assertCodeMemoryLinkAgentAbRuntimeIdentity(result.candidate, runtime),
    catch: cause => new ScriptError('Agent A/B candidate does not match the verified installed runtime.', {cause}),
  });
  yield* Console.log(JSON.stringify(result, undefined, 2));
  if (result.gate.status !== 'passed') return yield* Effect.fail(new ScriptError(result.gate.failures.join('\n')));
});

function parseArguments(args: readonly string[]): {
  readonly assignmentPath: string;
  readonly attemptsPath: string;
  readonly candidateCommit: string;
  readonly evidencePath: string;
  readonly manifestPath: string;
  readonly trialsPath: string;
} {
  let assignmentPath: string | undefined;
  let attemptsPath: string | undefined;
  let candidateCommit: string | undefined;
  let evidencePath: string | undefined;
  let manifestPath: string | undefined;
  let trialsPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--assignment') assignmentPath = required(args[++index], argument);
    else if (argument === '--attempts') attemptsPath = required(args[++index], argument);
    else if (argument === '--candidate-commit') candidateCommit = required(args[++index], argument);
    else if (argument === '--evidence') evidencePath = required(args[++index], argument);
    else if (argument === '--manifest') manifestPath = required(args[++index], argument);
    else if (argument === '--trials') trialsPath = required(args[++index], argument);
    else throw new ScriptError(`Unknown Code Memory Link agent A/B option: ${argument}`);
  }
  if (
    assignmentPath === undefined ||
    attemptsPath === undefined ||
    candidateCommit === undefined ||
    evidencePath === undefined ||
    manifestPath === undefined ||
    trialsPath === undefined
  ) {
    throw new ScriptError(
      'Agent A/B evaluation requires --assignment <json>, --attempts <jsonl>, --candidate-commit <sha>, --evidence <jsonl>, --manifest <json>, and --trials <jsonl>.',
    );
  }
  return {assignmentPath, attemptsPath, candidateCommit, evidencePath, manifestPath, trialsPath};
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new ScriptError(`${option} requires a value`);
  return value;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
