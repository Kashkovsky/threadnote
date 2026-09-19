#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, Path} from 'effect';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {composeThreadnote5ReleaseReadinessEvidenceV1} from '../src/evaluation/threadnote-5-release-readiness-compose.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';

const DEFAULT_FIXTURE = new URL('../test/evaluation/fixtures/threadnote-5-task-loop-v1/fixture.json', import.meta.url);

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const args = yield* scriptArguments();
  if (args.includes('--help') || args.includes('-h')) return yield* printJson({usage: usage()});
  const options = parseArguments(args);
  const fixturePath = options.fixturePath ?? (yield* path.fromFileUrl(DEFAULT_FIXTURE));
  const [baselineEvidence, candidateEvidence, expectedCandidate, fixture] = yield* Effect.all([
    readJsonFile(options.baselineEvidencePath),
    readJsonFile(options.candidateEvidencePath),
    readJsonFile(options.expectedCandidatePath),
    readJsonFile(fixturePath),
  ]);
  const evidence = yield* Effect.try({
    try: () =>
      composeThreadnote5ReleaseReadinessEvidenceV1({
        baselineEvidence,
        candidateEvidence,
        expectedBaseline: {
          commit: options.baselineCommit,
          executableSha256: options.baselineExecutableSha256,
          id: 'threadnote-4.7.x',
          version: options.baselineVersion,
        },
        expectedBaselineEvidenceSha256: options.baselineEvidenceSha256,
        expectedCandidate,
        expectedCandidateEvidenceSha256: options.candidateEvidenceSha256,
        fixture,
      }),
    catch: cause =>
      ScriptError.make({message: 'Threadnote 5 release-readiness evidence composition failed closed.', cause}),
  });
  yield* atomicWrite(path.resolve(options.outputPath), `${JSON.stringify(evidence, undefined, 2)}\n`);
  yield* printJson({
    captureManifestHash: evidence.capture.manifestHash,
    evidenceHash: evidence.evidenceHash,
    version: evidence.version,
  });
});

function parseArguments(args: readonly string[]): {
  readonly baselineEvidencePath: string;
  readonly baselineEvidenceSha256: string;
  readonly baselineCommit: string;
  readonly baselineExecutableSha256: string;
  readonly baselineVersion: string;
  readonly candidateEvidencePath: string;
  readonly candidateEvidenceSha256: string;
  readonly expectedCandidatePath: string;
  readonly fixturePath?: string;
  readonly outputPath: string;
} {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!OPTIONS.has(option)) throw ScriptError.make({message: `Unknown release-readiness compose option: ${option}`});
    options[option] = required(args[++index], option);
  }
  for (const option of REQUIRED_OPTIONS)
    if (options[option] === undefined) throw ScriptError.make({message: `Release composition requires ${option}.`});
  return {
    baselineEvidencePath: options['--baseline-evidence'],
    baselineEvidenceSha256: options['--baseline-evidence-sha256'],
    baselineCommit: options['--baseline-commit'],
    baselineExecutableSha256: options['--baseline-executable-sha256'],
    baselineVersion: options['--baseline-version'],
    candidateEvidencePath: options['--candidate-evidence'],
    candidateEvidenceSha256: options['--candidate-evidence-sha256'],
    expectedCandidatePath: options['--expected-candidate'],
    ...(options['--fixture'] === undefined ? {} : {fixturePath: options['--fixture']}),
    outputPath: options['--output'],
  };
}

const REQUIRED_OPTIONS = [
  '--baseline-evidence',
  '--baseline-evidence-sha256',
  '--baseline-version',
  '--baseline-commit',
  '--baseline-executable-sha256',
  '--candidate-evidence',
  '--candidate-evidence-sha256',
  '--expected-candidate',
  '--output',
] as const;
const OPTIONS = new Set([...REQUIRED_OPTIONS, '--fixture']);

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

function usage(): string {
  return [
    'Usage: bun run compose:threadnote-5-release-readiness -- [options]',
    'Required: --candidate-evidence <json> --candidate-evidence-sha256 <64-hex> --expected-candidate <json>',
    '  --baseline-evidence <json> --baseline-evidence-sha256 <64-hex>',
    '  --baseline-version 4.7.8 --baseline-commit <40-hex> --baseline-executable-sha256 <64-hex>',
    '  --output <json>',
    'Optional: --fixture <json>',
  ].join('\n');
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
