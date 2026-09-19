#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {captureThreadnote5BaselineEvidenceV1} from './threadnote-5-baseline-runtime-capture.js';
import {prepareThreadnote5BaselineOutputPathsV1} from './threadnote-5-baseline-output-publication.js';
import {
  THREADNOTE_5_BASELINE_COMMIT,
  THREADNOTE_5_BASELINE_VERSION,
} from '../src/evaluation/threadnote-5-release-readiness-contract.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {printJson, readJsonFile, scriptArguments} from './effect/script.js';

export {
  prepareThreadnote5BaselineOutputPathsV1,
  type PreparedThreadnote5BaselineOutputPathsV1,
} from './threadnote-5-baseline-output-publication.js';

const program = Effect.gen(function* () {
  const args = yield* scriptArguments();
  if (args.includes('--help') || args.includes('-h')) return yield* printJson({usage: usage()});
  const options = parseArguments(args);
  const outputPaths = yield* Effect.tryPromise({
    try: () =>
      prepareThreadnote5BaselineOutputPathsV1({
        evidenceOutputPath: options.outputPath,
        privateReplayOutputPath: options.privateReplayOutputPath,
      }),
    catch: cause => ScriptError.make({message: 'Baseline evidence output staging failed closed.', cause}),
  });
  return yield* Effect.gen(function* () {
    const plan = yield* readJsonFile(options.planPath);
    const capture = yield* Effect.tryPromise({
      try: () =>
        captureThreadnote5BaselineEvidenceV1({
          executablePath: options.executablePath,
          expectedExecutableSha256: options.executableSha256,
          expectedJudgeExecutableSha256: options.judgeExecutableSha256,
          expectedObserverExecutableSha256: options.observerExecutableSha256,
          expectedPlanSha256: options.planSha256,
          judgeExecutablePath: options.judgeExecutablePath,
          observerExecutablePath: options.observerExecutablePath,
          plan,
        }),
      catch: cause => ScriptError.make({message: 'Threadnote 4.7.8 baseline capture failed closed.', cause}),
    });
    yield* Effect.tryPromise({
      try: () =>
        outputPaths.publish({
          evidence: `${JSON.stringify(capture.evidence, undefined, 2)}\n`,
          privateReplay: `${JSON.stringify(capture.privateReplay, undefined, 2)}\n`,
        }),
      catch: cause => ScriptError.make({message: 'Baseline evidence publication failed closed.', cause}),
    });
    yield* printJson({
      evidenceHash: capture.evidence.evidenceHash,
      observationCount: capture.evidence.observations.length,
      privateReplayOutput: outputPaths.privateReplayOutputPath,
      version: capture.evidence.version,
    });
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise({
        try: () => outputPaths.cleanupReservations(),
        catch: cause => ScriptError.make({message: 'Could not clean baseline output reservations.', cause}),
      }).pipe(Effect.orDie),
    ),
  );
});

function parseArguments(args: readonly string[]): {
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly judgeExecutablePath: string;
  readonly judgeExecutableSha256: string;
  readonly observerExecutablePath: string;
  readonly observerExecutableSha256: string;
  readonly outputPath: string;
  readonly planPath: string;
  readonly planSha256: string;
  readonly privateReplayOutputPath: string;
} {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!OPTIONS.has(option)) throw ScriptError.make({message: `Unknown baseline capture option: ${option}`});
    options[option] = required(args[++index], option);
  }
  for (const option of OPTIONS) {
    if (options[option] === undefined) throw ScriptError.make({message: `Baseline capture requires ${option}.`});
  }
  if (
    options['--baseline-version'] !== THREADNOTE_5_BASELINE_VERSION ||
    options['--baseline-commit'] !== THREADNOTE_5_BASELINE_COMMIT
  ) {
    throw ScriptError.make({
      message: `Baseline capture is fixed to Threadnote ${THREADNOTE_5_BASELINE_VERSION} at ${THREADNOTE_5_BASELINE_COMMIT}.`,
    });
  }
  return {
    executablePath: options['--baseline-executable'],
    executableSha256: options['--baseline-executable-sha256'],
    judgeExecutablePath: options['--judge-executable'],
    judgeExecutableSha256: options['--judge-executable-sha256'],
    observerExecutablePath: options['--observer-executable'],
    observerExecutableSha256: options['--observer-executable-sha256'],
    outputPath: options['--output'],
    planPath: options['--plan'],
    planSha256: options['--plan-sha256'],
    privateReplayOutputPath: options['--private-replay-output'],
  };
}

const OPTIONS = new Set([
  '--baseline-version',
  '--baseline-commit',
  '--baseline-executable',
  '--baseline-executable-sha256',
  '--judge-executable',
  '--judge-executable-sha256',
  '--observer-executable',
  '--observer-executable-sha256',
  '--plan',
  '--plan-sha256',
  '--private-replay-output',
  '--output',
]);

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

function usage(): string {
  return [
    'Usage: bun run capture:threadnote-5-baseline-evidence -- [options]',
    'Required: --baseline-version 4.7.8 --baseline-commit 80ca4acdb7347a4d00b0381f3757a5ac984d9fbf',
    '  --baseline-executable <native-standalone> --baseline-executable-sha256 <64-hex>',
    '  --observer-executable <reviewed-native-harness> --observer-executable-sha256 <64-hex>',
    '  --judge-executable <reviewed-native-judge> --judge-executable-sha256 <64-hex>',
    '  --plan <reviewed-json> --plan-sha256 <64-hex>',
    '  --private-replay-output <private-json> --output <content-free-json>',
    'Output filenames must be distinct lowercase ASCII names; publication requires POSIX mkdirat/renameat/unlinkat.',
    'The runner pins separate observer and judge boundaries and fails closed.',
  ].join('\n');
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
