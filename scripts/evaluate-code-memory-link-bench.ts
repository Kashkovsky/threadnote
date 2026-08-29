#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, Path} from 'effect';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {evaluateCodeMemoryLinkBenchRuntime} from '../src/evaluation/code-memory-link-bench.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';

const DEFAULT_FIXTURE = new URL('../test/evaluation/fixtures/code-memory-link-bench-v1/fixture.json', import.meta.url);

const program = Effect.scoped(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const options = parseArguments(yield* scriptArguments());
    const fixturePath = options.fixturePath ?? (yield* path.fromFileUrl(DEFAULT_FIXTURE));
    const result = yield* evaluateCodeMemoryLinkBenchRuntime(yield* readJsonFile(fixturePath));
    if (options.outputPath !== undefined) {
      yield* atomicWrite(options.outputPath, `${JSON.stringify(result, undefined, 2)}\n`);
    }
    yield* printJson(result);
    if (!result.gate.passed) return yield* Effect.fail(new ScriptError(result.gate.failures.join('\n')));
  }),
);

function parseArguments(args: readonly string[]): {readonly fixturePath?: string; readonly outputPath?: string} {
  let fixturePath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--fixture') fixturePath = required(args[++index], argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else throw new ScriptError(`Unknown CodeMemoryLinkBench option: ${argument}`);
  }
  return {
    ...(fixturePath === undefined ? {} : {fixturePath}),
    ...(outputPath === undefined ? {} : {outputPath}),
  };
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new ScriptError(`${option} requires a value`);
  return value;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
