#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, Path} from 'effect';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {evaluateContextBriefCitationRuntime} from '../src/evaluation/context-brief-citation-runtime.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';

const DEFAULT_FIXTURE = new URL(
  '../test/evaluation/fixtures/context-brief-citations-runtime-v1/fixture.json',
  import.meta.url,
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const options = parseArguments(yield* scriptArguments());
    const fixturePath = options.fixturePath ?? (yield* path.fromFileUrl(DEFAULT_FIXTURE));
    const fixture = yield* readJsonFile(fixturePath);
    const result = yield* evaluateContextBriefCitationRuntime(fixture);
    if (options.outputPath !== undefined) {
      yield* atomicWrite(options.outputPath, `${JSON.stringify(result, undefined, 2)}\n`);
    }
    yield* printJson(result);
    if (!result.gate.passed) return yield* ScriptError.make({message: result.gate.failures.join('\n')});
  }),
);

function parseArguments(args: readonly string[]): {readonly fixturePath?: string; readonly outputPath?: string} {
  let fixturePath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--fixture') fixturePath = required(args[++index], argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else throw ScriptError.make({message: `Unknown Context Brief citation runtime evaluation option: ${argument}`});
  }
  return {
    ...(fixturePath === undefined ? {} : {fixturePath}),
    ...(outputPath === undefined ? {} : {outputPath}),
  };
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
