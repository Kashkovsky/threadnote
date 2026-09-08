import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {readCodeGraphInventoryReuseEnvironment} from '../../src/code_graph/inventory_reuse.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {CommandExecutor, runCommandEffect} from '../../src/effect/command.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const testLayer = CommandExecutor.layer.pipe(Layer.provideMerge(Layer.mergeAll(BunServices.layer, SystemInfo.layer)));

describe('inventory environment observes Git global excludes', () => {
  it.effect(
    'tracks Git defaults, explicit paths, and explicit disabling without changing the process environment',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const command = yield* CommandExecutor;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-inventory-environment-'});
        const repo = path.join(root, 'repository');
        const privateHome = path.join(root, 'private-home');
        const xdg = path.join(root, 'xdg');
        const configured = path.join(root, 'configured-ignore');
        yield* fs.makeDirectory(repo);
        yield* runCommandEffect('git', ['init', '-q', repo]);
        const identity = yield* resolveRepositoryIdentity(repo);
        for (const xdgValue of [undefined, '', xdg]) {
          const environment = {
            ...system.environment(),
            HOME: privateHome,
            XDG_CONFIG_HOME: xdgValue,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: path.join(root, 'empty-global-config'),
          };
          const defaultIgnore = path.join(xdgValue || path.join(privateHome, '.config'), 'git', 'ignore');
          yield* fs.makeDirectory(path.dirname(defaultIgnore), {recursive: true});
          yield* fs.writeFileString(defaultIgnore, 'first.ts\n');
          const read = readCodeGraphInventoryReuseEnvironment(identity, fs, path).pipe(
            Effect.provideService(SystemInfo, {...system, environment: () => environment}),
            Effect.provideService(CommandExecutor, {
              ...command,
              execute: (executable, args, options) => command.execute(executable, args, {...options, env: environment}),
            }),
          );
          const git = (args: readonly string[]) => command.execute('git', ['-C', repo, ...args], {env: environment});
          yield* git(['config', '--unset', 'core.excludesFile']).pipe(Effect.ignore);
          const before = yield* read;
          yield* fs.writeFileString(defaultIgnore, 'second.ts\n');
          expect((yield* read).fingerprint).not.toBe(before.fingerprint);

          yield* git(['config', 'core.excludesFile', '']);
          const disabled = yield* read;
          yield* fs.writeFileString(defaultIgnore, 'third.ts\n');
          expect((yield* read).fingerprint).toBe(disabled.fingerprint);

          yield* fs.writeFileString(configured, 'configured-first.ts\n');
          yield* git(['config', 'core.excludesFile', configured]);
          const explicit = yield* read;
          yield* fs.writeFileString(defaultIgnore, 'fourth.ts\n');
          expect((yield* read).fingerprint).toBe(explicit.fingerprint);
          yield* fs.writeFileString(configured, 'configured-second.ts\n');
          expect((yield* read).fingerprint).not.toBe(explicit.fingerprint);
        }
      }).pipe(provideTestLayer(testLayer), TestClock.withLive),
  );
});
