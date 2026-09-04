import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Layer, Path} from 'effect';
import {runCommandEffect, CommandExecutor} from '../src/effect/command.js';
import {sha256FileHex} from '../src/effect/digest.js';
import {SystemInfo} from '../src/effect/system.js';

const ROOT_URL = new URL('..', import.meta.url);
const ARCHIVE_TARGET_PATTERN = /^(darwin|linux|windows)-(arm64|x64)$/;

const archiveRelease = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(ROOT_URL);
  const target = Bun.env.THREADNOTE_RELEASE_TARGET?.trim();
  if (!target || !ARCHIVE_TARGET_PATTERN.test(target)) {
    return yield* ScriptError.make({
      message: 'THREADNOTE_RELEASE_TARGET must be one of darwin|linux|windows combined with arm64|x64.',
    });
  }

  const distributionRoot = path.join(root, 'dist');
  const artifactsRoot = Bun.env.THREADNOTE_ARTIFACTS_ROOT?.trim()
    ? path.resolve(Bun.env.THREADNOTE_ARTIFACTS_ROOT.trim())
    : path.join(root, 'artifacts');
  const artifactName = `threadnote-${target}.tar.gz`;
  const artifactPath = path.join(artifactsRoot, artifactName);
  const checksumPath = `${artifactPath}.sha256`;
  if (!(yield* fs.exists(path.join(distributionRoot, 'release.json')))) {
    return yield* ScriptError.make({message: 'dist/release.json is missing; build the release before archiving it.'});
  }

  yield* fs.makeDirectory(artifactsRoot, {recursive: true});
  yield* fs.remove(artifactPath, {force: true});
  yield* fs.remove(checksumPath, {force: true});
  yield* runCommandEffect('tar', ['-czf', artifactPath, '-C', distributionRoot, '.'], {
    timeoutMs: 10 * 60_000,
  });
  const checksum = yield* sha256FileHex(artifactPath);
  yield* fs.writeFileString(checksumPath, `${checksum}  ${artifactName}\n`, {mode: 0o644});
  yield* Console.log(`Archived ${artifactName}`);
});

const systemLayer = SystemInfo.layer;
const commandLayer = CommandExecutor.layer.pipe(Layer.provide(systemLayer));
const archiveLayer = Layer.merge(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));

BunRuntime.runMain(provideScriptLayer(archiveRelease, archiveLayer));
