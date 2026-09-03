#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Layer, Path} from 'effect';
import {CommandExecutor, runCommandEffect} from '../src/effect/command.js';
import {sha256Hex} from '../src/effect/digest.js';
import {SystemInfo} from '../src/effect/system.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';

const TARGET = new URL('./benchmark-memory-connections-scale-target.ts', import.meta.url);

export const buildMemoryConnectionsScaleTarget = Effect.fn('memoryConnectionsScale.buildTarget')(function* (
  outputDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* path.fromFileUrl(TARGET);
  const executablePath = path.join(outputDirectory, 'memory-connections-scale.mjs');
  const result = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        bytecode: false,
        entrypoints: [target],
        format: 'esm',
        minify: true,
        naming: path.basename(executablePath),
        outdir: outputDirectory,
        sourcemap: 'none',
        target: 'bun',
      }),
    catch: cause => ScriptError.make({message: 'Could not build the memory-connections scale target.', cause}),
  });
  if (!result.success) return yield* ScriptError.make({message: 'Memory-connections scale target build failed.'});
  return {executablePath, sha256: yield* sha256Hex(yield* fs.readFile(executablePath))};
});

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const system = yield* SystemInfo;
    const args = yield* scriptArguments();
    if (args.includes('--built-artifact-sha256')) {
      return yield* ScriptError.make({message: '--built-artifact-sha256 is reserved for the benchmark wrapper.'});
    }
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-connections-scale-build-'});
    const built = yield* buildMemoryConnectionsScaleTarget(root);
    const child = yield* runCommandEffect(
      system.executablePath,
      [built.executablePath, ...args, '--built-artifact-sha256', built.sha256],
      {maxOutputBytes: 0, timeoutMs: 3 * 60 * 60 * 1_000},
    );
    if (child.stdout.trim()) yield* Console.log(child.stdout.trimEnd());
  }),
);

const systemLayer = SystemInfo.layer;
const commandLayer = CommandExecutor.layer.pipe(Layer.provide(systemLayer));
const wrapperLayer = Layer.mergeAll(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, wrapperLayer));
