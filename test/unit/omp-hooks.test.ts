import {provideTestLayer} from '../helpers/effect-layer.js';
import {withoutOmpPathSelectors} from '../helpers/omp-environment.js';
import {BunFileSystem, BunPath} from '@effect/platform-bun';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import {describe, expect} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {SystemInfo} from '../../src/effect/system.js';
import {hasCurrentOmpHooks, hasManagedOmpHooks, runOmpHooksInstall} from '../../src/omp_hooks.js';

const TestLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, SystemInfo.layer);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-omp-hooks-'});
  const hookPath = path.join(root, '.omp', 'agent', 'hooks', 'pre', 'threadnote.ts');
  const system = yield* SystemInfo;
  return {
    fs,
    hookPath,
    system: SystemInfo.of({...system, homeDirectory: root, currentDirectory: () => root, environment: () => ({})}),
  };
});

describe('omp session hooks', () => {
  effectIt.effect('previews without writing, installs once, and removes only its own file', () =>
    Effect.gen(function* () {
      const {fs, hookPath, system} = yield* fixture;
      const run = (options: Parameters<typeof runOmpHooksInstall>[0]) =>
        captureConsole(runOmpHooksInstall(options).pipe(Effect.provideService(SystemInfo, system)));

      const preview = yield* run({apply: true, dryRun: true});
      expect(preview.output).toContain('Would write');
      expect(preview.output).toContain('threadnote session-start-hook');
      expect(yield* fs.exists(hookPath)).toBe(false);

      yield* run({apply: true});
      const installed = yield* fs.readFileString(hookPath);
      expect(installed).toContain("pi.on('session_start'");
      expect(installed).toContain("pi.on('session_before_compact'");
      expect(installed).toContain("['session-start-hook']");
      expect(installed).toContain("['pre-compact-hook', '--source-agent-client', 'omp']");
      expect(yield* hasManagedOmpHooks().pipe(Effect.provideService(SystemInfo, system))).toBe(true);
      expect(yield* hasCurrentOmpHooks().pipe(Effect.provideService(SystemInfo, system))).toBe(true);

      yield* fs.writeFileString(hookPath, `${installed}// drift\n`);
      expect(yield* hasManagedOmpHooks().pipe(Effect.provideService(SystemInfo, system))).toBe(true);
      expect(yield* hasCurrentOmpHooks().pipe(Effect.provideService(SystemInfo, system))).toBe(false);

      const repaired = yield* run({apply: true});
      expect(repaired.output).toContain('Updated');
      expect(yield* fs.readFileString(hookPath)).toBe(installed);
      const second = yield* run({apply: true});
      expect(second.output).toContain('already current');

      yield* run({apply: true, remove: true});
      expect(yield* fs.exists(hookPath)).toBe(false);
      expect(yield* hasManagedOmpHooks().pipe(Effect.provideService(SystemInfo, system))).toBe(false);
    }).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('refuses to overwrite a user-owned file and leaves it in place on removal', () =>
    Effect.gen(function* () {
      const {fs, hookPath, system} = yield* fixture;
      const userOwned = 'export default function userOwned() {}\n';
      yield* fs.makeDirectory((yield* Path.Path).dirname(hookPath), {recursive: true});
      yield* fs.writeFileString(hookPath, userOwned);

      const install = yield* runOmpHooksInstall({apply: true}).pipe(
        Effect.provideService(SystemInfo, system),
        Effect.result,
      );
      expect(Result.isFailure(install)).toBe(true);

      const remove = yield* captureConsole(
        runOmpHooksInstall({apply: true, remove: true}).pipe(Effect.provideService(SystemInfo, system)),
      );
      expect(remove.output).toContain('not managed by Threadnote');
      expect(yield* fs.readFileString(hookPath)).toBe(userOwned);
      expect(yield* hasManagedOmpHooks().pipe(Effect.provideService(SystemInfo, system))).toBe(false);
    }).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('uses the active OMP agent root for hook installation', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseSystem = yield* SystemInfo;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-omp-hooks-agent-dir-'});
      const agentRoot = path.join(root, 'active-agent');
      const system = SystemInfo.of({
        ...baseSystem,
        environment: () => ({
          ...withoutOmpPathSelectors(baseSystem.environment()),
          PI_CODING_AGENT_DIR: agentRoot,
        }),
        homeDirectory: path.join(root, 'user'),
      });

      yield* runOmpHooksInstall({apply: true}).pipe(Effect.provideService(SystemInfo, system));

      expect(yield* fs.exists(path.join(agentRoot, 'hooks', 'pre', 'threadnote.ts'))).toBe(true);
    }).pipe(provideTestLayer(TestLayer)),
  );
});
