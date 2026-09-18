#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, Path} from 'effect';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {evaluateThreadnote5ReleaseReadiness} from '../src/evaluation/threadnote-5-release-readiness.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';

const DEFAULT_FIXTURE = new URL('../test/evaluation/fixtures/threadnote-5-task-loop-v1/fixture.json', import.meta.url);

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const options = parseArguments(yield* scriptArguments());
  const fixturePath = options.fixturePath ?? (yield* path.fromFileUrl(DEFAULT_FIXTURE));
  const [fixture, evidence, retainedSubsystemReceiptRecords, baselineTrialLedger, localAuthorityManifest] =
    yield* Effect.all(
      [
        readJsonFile(fixturePath),
        readJsonFile(options.evidencePath),
        options.retainedSubsystemReceiptRecordsPath === undefined
          ? Effect.void
          : readJsonFile(options.retainedSubsystemReceiptRecordsPath),
        options.baselineTrialLedgerPath === undefined ? Effect.void : readJsonFile(options.baselineTrialLedgerPath),
        options.localAuthorityManifestPath === undefined
          ? Effect.void
          : readJsonFile(options.localAuthorityManifestPath),
      ],
      {
        concurrency: 2,
      },
    );
  const result = yield* Effect.try({
    try: () =>
      evaluateThreadnote5ReleaseReadiness({
        evidence,
        expectedBaselineSource: options.baselineSource,
        expectedBaselineTrialLedgerSha256: options.baselineTrialLedgerSha256,
        expectedCandidateCommit: options.candidateCommit,
        expectedCandidateExecutableSha256: options.candidateExecutableSha256,
        expectedCaptureManifestSha256: options.captureManifestSha256,
        expectedLocalAuthorityManifestSha256: options.localAuthorityManifestSha256,
        fixture,
        baselineTrialLedger,
        localAuthorityManifest,
        retainedSubsystemReceiptRecords,
      }),
    catch: cause => ScriptError.make({message: 'Threadnote 5 release-readiness evidence is invalid.', cause}),
  });
  if (options.outputPath !== undefined) {
    yield* atomicWrite(options.outputPath, `${JSON.stringify(result, undefined, 2)}\n`);
  }
  yield* printJson(result);
  if (result.gate.status !== 'passed') {
    return yield* ScriptError.make({
      message: [...result.gate.qualityFailures, ...result.gate.insufficiencies].join('\n'),
    });
  }
});

function parseArguments(args: readonly string[]): {
  readonly candidateCommit: string;
  readonly candidateExecutableSha256: string;
  readonly captureManifestSha256: string;
  readonly evidencePath: string;
  readonly fixturePath?: string;
  readonly outputPath?: string;
  readonly retainedSubsystemReceiptRecordsPath?: string;
  readonly localAuthorityManifestPath?: string;
  readonly localAuthorityManifestSha256?: string;
  readonly baselineTrialLedgerPath?: string;
  readonly baselineTrialLedgerSha256?: string;
  readonly baselineSource?: {
    readonly commit: string;
    readonly executableSha256: string;
    readonly id: 'threadnote-4.7.x';
    readonly version: string;
  };
} {
  let baselineCommit: string | undefined;
  let baselineExecutableSha256: string | undefined;
  let baselineVersion: string | undefined;
  let candidateCommit: string | undefined;
  let candidateExecutableSha256: string | undefined;
  let captureManifestSha256: string | undefined;
  let evidencePath: string | undefined;
  let fixturePath: string | undefined;
  let outputPath: string | undefined;
  let retainedSubsystemReceiptRecordsPath: string | undefined;
  let baselineTrialLedgerPath: string | undefined;
  let baselineTrialLedgerSha256: string | undefined;
  let localAuthorityManifestPath: string | undefined;
  let localAuthorityManifestSha256: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--baseline-commit') baselineCommit = required(args[++index], argument);
    else if (argument === '--baseline-executable-sha256') {
      baselineExecutableSha256 = required(args[++index], argument);
    } else if (argument === '--baseline-version') baselineVersion = required(args[++index], argument);
    else if (argument === '--candidate-commit') candidateCommit = required(args[++index], argument);
    else if (argument === '--candidate-executable-sha256') {
      candidateExecutableSha256 = required(args[++index], argument);
    } else if (argument === '--capture-manifest-sha256') {
      captureManifestSha256 = required(args[++index], argument);
    } else if (argument === '--evidence') evidencePath = required(args[++index], argument);
    else if (argument === '--fixture') fixturePath = required(args[++index], argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--retained-subsystem-receipts') {
      retainedSubsystemReceiptRecordsPath = required(args[++index], argument);
    } else if (argument === '--baseline-trial-ledger') baselineTrialLedgerPath = required(args[++index], argument);
    else if (argument === '--baseline-trial-ledger-sha256') {
      baselineTrialLedgerSha256 = required(args[++index], argument);
    } else if (argument === '--authority-manifest') {
      localAuthorityManifestPath = required(args[++index], argument);
    } else if (argument === '--authority-manifest-sha256') {
      localAuthorityManifestSha256 = required(args[++index], argument);
    } else throw ScriptError.make({message: `Unknown Threadnote 5 release-readiness option: ${argument}`});
  }
  if (
    candidateCommit === undefined ||
    candidateExecutableSha256 === undefined ||
    captureManifestSha256 === undefined ||
    evidencePath === undefined
  ) {
    throw ScriptError.make({
      message:
        'Release-readiness evaluation requires --candidate-commit <40-hex>, --candidate-executable-sha256 <64-hex>, --capture-manifest-sha256 <64-hex>, and --evidence <json>.',
    });
  }
  const baselineValues = [baselineCommit, baselineExecutableSha256, baselineVersion].filter(
    value => value !== undefined,
  ).length;
  if (baselineValues !== 0 && baselineValues !== 3) {
    throw ScriptError.make({
      message:
        'Trusted baseline comparison requires --baseline-version, --baseline-commit, and --baseline-executable-sha256 together.',
    });
  }
  if ((baselineTrialLedgerPath === undefined) !== (baselineTrialLedgerSha256 === undefined)) {
    throw ScriptError.make({
      message:
        'Baseline trial-ledger verification requires --baseline-trial-ledger and --baseline-trial-ledger-sha256 together.',
    });
  }
  if ((localAuthorityManifestPath === undefined) !== (localAuthorityManifestSha256 === undefined)) {
    throw ScriptError.make({
      message: 'Local authority verification requires --authority-manifest and --authority-manifest-sha256 together.',
    });
  }
  return {
    candidateCommit,
    candidateExecutableSha256,
    captureManifestSha256,
    evidencePath,
    ...(baselineValues === 3
      ? {
          baselineSource: {
            commit: baselineCommit!,
            executableSha256: baselineExecutableSha256!,
            id: 'threadnote-4.7.x' as const,
            version: baselineVersion!,
          },
        }
      : {}),
    ...(fixturePath === undefined ? {} : {fixturePath}),
    ...(outputPath === undefined ? {} : {outputPath}),
    ...(retainedSubsystemReceiptRecordsPath === undefined ? {} : {retainedSubsystemReceiptRecordsPath}),
    ...(baselineTrialLedgerPath === undefined ? {} : {baselineTrialLedgerPath}),
    ...(baselineTrialLedgerSha256 === undefined ? {} : {baselineTrialLedgerSha256}),
    ...(localAuthorityManifestPath === undefined ? {} : {localAuthorityManifestPath}),
    ...(localAuthorityManifestSha256 === undefined ? {} : {localAuthorityManifestSha256}),
  };
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
