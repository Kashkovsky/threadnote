#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Layer, Path} from 'effect';
import {CommandExecutor, runCommandEffect} from '../src/effect/command.js';
import {sha256Hex} from '../src/effect/digest.js';
import {SystemInfo} from '../src/effect/system.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';

const TARGET = new URL('./benchmark-context-brief-citations-target.ts', import.meta.url);

/** Build one self-contained Bun target, then retain its digest in the benchmark artifact. */
const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const args = yield* scriptArguments();
    if (args.includes('--built-artifact-sha256')) {
      return yield* Effect.fail(new ScriptError('--built-artifact-sha256 is reserved for the benchmark wrapper.'));
    }
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-context-brief-citation-benchmark-build-'});
    const target = yield* path.fromFileUrl(TARGET);
    const packageManifest = JSON.parse(
      yield* fs.readFileString(path.join(path.dirname(target), '..', 'package.json')),
    ) as {readonly version?: unknown};
    if (typeof packageManifest.version !== 'string' || packageManifest.version.length === 0) {
      return yield* Effect.fail(new ScriptError('package.json does not declare a benchmark source version.'));
    }
    const outfile = path.join(root, 'context-brief-citation-scale-benchmark.mjs');
    const result = yield* Effect.tryPromise({
      try: () =>
        Bun.build({
          bytecode: false,
          define: {THREADNOTE_VERSION: JSON.stringify(packageManifest.version)},
          entrypoints: [target],
          format: 'esm',
          minify: true,
          naming: path.basename(outfile),
          outdir: root,
          sourcemap: 'none',
          target: 'bun',
          write: true,
        }),
      catch: cause => new ScriptError('Could not build the Context Brief citation scale benchmark target.', {cause}),
    });
    if (!result.success) {
      return yield* Effect.fail(
        new ScriptError(
          result.logs
            .map(log => log.message)
            .filter(Boolean)
            .join('\n') || 'Benchmark build failed.',
        ),
      );
    }
    const digest = yield* sha256Hex(yield* fs.readFile(outfile));
    const child = yield* runCommandEffect(
      system.executablePath,
      [outfile, ...args, '--built-artifact-sha256', digest],
      {maxOutputBytes: 0, timeoutMs: 3 * 60 * 60 * 1_000},
    );
    if (child.stdout.trim()) yield* Console.log(child.stdout.trimEnd());
  }),
);

const systemLayer = SystemInfo.layer;
const commandLayer = CommandExecutor.layer.pipe(Layer.provide(systemLayer));
const wrapperLayer = Layer.mergeAll(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, wrapperLayer));
