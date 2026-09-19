#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, Path} from 'effect';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {
  parseThreadnote5ReleaseEvidenceV1,
  parseThreadnote5ReleaseReadinessFixtureV1,
} from '../src/evaluation/threadnote-5-release-readiness-contract.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';

const DEFAULT_FIXTURE = new URL('../test/evaluation/fixtures/threadnote-5-task-loop-v1/fixture.json', import.meta.url);

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const args = yield* scriptArguments();
  if (args.includes('--help') || args.includes('-h')) return yield* printJson({usage: usage()});
  const options = parseArguments(args);
  const fixturePath = options.fixturePath ?? (yield* path.fromFileUrl(DEFAULT_FIXTURE));
  const [fixtureValue, evidenceValue] = yield* Effect.all([
    readJsonFile(fixturePath),
    readJsonFile(options.evidencePath),
  ]);
  const ledger = yield* Effect.try({
    try: () => {
      const fixture = parseThreadnote5ReleaseReadinessFixtureV1(fixtureValue);
      const evidence = parseThreadnote5ReleaseEvidenceV1(evidenceValue, fixture);
      if (evidence.baseline.state !== 'available') throw new Error('Threadnote 4.7.8 observations are unavailable.');
      return evidence.baseline.evidence;
    },
    catch: cause => ScriptError.make({message: 'Could not capture the Threadnote 4.7.8 comparison ledger.', cause}),
  });
  // Version 1 remains the historical trial-ledger schema. The source-native
  // 4.7.8 evidence wrapper is explicitly versioned separately and its hash is
  // the evidence's own canonical hash (never a hash of the hash field).
  const result = {ledger, ledgerHash: ledger.evidenceHash, version: 2} as const;
  yield* atomicWrite(options.outputPath, `${JSON.stringify(result, undefined, 2)}\n`);
  yield* printJson(result);
});

function parseArguments(args: readonly string[]): {
  readonly evidencePath: string;
  readonly fixturePath?: string;
  readonly outputPath: string;
} {
  let evidencePath: string | undefined;
  let fixturePath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--evidence') evidencePath = required(args[++index], argument);
    else if (argument === '--fixture') fixturePath = required(args[++index], argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else throw ScriptError.make({message: `Unknown Threadnote 4.7.8 comparison-ledger option: ${argument}`});
  }
  if (evidencePath === undefined || outputPath === undefined) {
    throw ScriptError.make({message: 'Baseline capture requires --evidence <json> and --output <json>.'});
  }
  return {evidencePath, ...(fixturePath === undefined ? {} : {fixturePath}), outputPath};
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

function usage(): string {
  return [
    'Usage: bun run capture:threadnote-5-baseline-ledger -- [options]',
    'Required: --evidence <composed-release-evidence-json> --output <baseline-ledger-json>',
    'Optional: --fixture <json>',
    'Emits the source-native baseline-evidence wrapper schema version 2; historical trial-ledger version 1 is unchanged.',
  ].join('\n');
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
