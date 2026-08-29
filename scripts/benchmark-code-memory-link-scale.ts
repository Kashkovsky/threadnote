#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Layer, Path} from 'effect';
import {CommandExecutor, runCommandEffect} from '../src/effect/command.js';
import {sha256Hex} from '../src/effect/digest.js';
import {SystemInfo} from '../src/effect/system.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';

const TARGET = new URL('./benchmark-code-memory-link-scale-target.ts', import.meta.url);

export interface CodeMemoryLinkScaleBuiltTarget {
  readonly executablePath: string;
  readonly sha256: string;
  readonly sourceVersion: string;
}

/** Build the exact benchmark program whose bytes are bound into release-scale evidence. */
export const buildCodeMemoryLinkScaleTarget = Effect.fn('codeMemoryLinkScale.buildTarget')(function* (
  outputDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* path.fromFileUrl(TARGET);
  const packageManifest = JSON.parse(
    yield* fs.readFileString(path.join(path.dirname(target), '..', 'package.json')),
  ) as {readonly version?: unknown};
  if (typeof packageManifest.version !== 'string' || packageManifest.version.length === 0) {
    return yield* Effect.fail(new ScriptError('package.json does not declare a scale benchmark source version.'));
  }
  const executablePath = path.join(outputDirectory, 'code-memory-link-inverse-scale.mjs');
  const result = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        bytecode: false,
        define: {THREADNOTE_VERSION: JSON.stringify(packageManifest.version)},
        entrypoints: [target],
        format: 'esm',
        minify: true,
        naming: path.basename(executablePath),
        outdir: outputDirectory,
        sourcemap: 'none',
        target: 'bun',
      }),
    catch: cause => new ScriptError('Could not build the inverse-selector scale benchmark target.', {cause}),
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
  return {
    executablePath,
    sha256: yield* sha256Hex(yield* fs.readFile(executablePath)),
    sourceVersion: packageManifest.version,
  } satisfies CodeMemoryLinkScaleBuiltTarget;
});

export const rebuildCodeMemoryLinkScaleTargetDigest = Effect.fn('codeMemoryLinkScale.rebuildTargetDigest')(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-memory-link-scale-verify-'});
    return (yield* buildCodeMemoryLinkScaleTarget(root)).sha256;
  },
);

/** Build one immutable target and bind its digest into retained scale evidence. */
const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const system = yield* SystemInfo;
    const args = yield* scriptArguments();
    if (args.includes('--built-artifact-sha256')) {
      return yield* Effect.fail(new ScriptError('--built-artifact-sha256 is reserved for the benchmark wrapper.'));
    }
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-memory-link-scale-build-'});
    const built = yield* buildCodeMemoryLinkScaleTarget(root);
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
