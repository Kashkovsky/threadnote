import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {expect} from 'vitest';
import {
  awaitCodeGraphWorktreeBuilds,
  codeGraphWorktreeBuildActive,
  withCodeGraphMaintenanceIntent,
  withCodeGraphTargetWorktreeLock,
} from '../../src/code_graph/maintenance_gate.js';
import {codeGraphLayout, codeGraphWorktreeLockPath} from '../../src/code_graph/layout.js';
import {compactCodeGraphStorage} from '../../src/code_graph/storage.js';
import {purgeCodeGraphSnapshot} from '../../src/code_graph/snapshot_purge.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {SystemInfo} from '../../src/effect/system.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const checkoutId = 'a'.repeat(64);
const worktreeId = 'b'.repeat(64);
const scopeId = `code-graph-scope:${'c'.repeat(64)}`;
const layer = Layer.merge(CodeGraphStore.layer, CommandExecutor.layer).pipe(
  Layer.provideMerge(SystemInfo.layer),
  Layer.provideMerge(BunServices.layer),
);

effectIt.effect('recognizes exact scoped builders for probes, drains, compaction, purge and target mutation', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scoped-maintenance-'});
    const layout = codeGraphLayout(path, home, checkoutId, worktreeId);
    yield* (yield* CodeGraphStore).initialize(layout.databasePath);
    const lock = codeGraphWorktreeLockPath(path, home, checkoutId, worktreeId, scopeId);
    yield* fs.makeDirectory(path.dirname(lock), {recursive: true});
    for (const name of [`${'d'.repeat(64)}.lock.recovery`, `${'d'.repeat(64)}.scope-bad.lock`, 'unrelated.lock']) {
      yield* fs.writeFileString(path.join(path.dirname(lock), name), 'malformed');
    }
    expect(yield* codeGraphWorktreeBuildActive(home, checkoutId)).toBe(false);
    yield* withCodeGraphTargetWorktreeLock(
      home,
      checkoutId,
      worktreeId,
      Effect.gen(function* () {
        expect(yield* codeGraphWorktreeBuildActive(home, checkoutId)).toBe(true);
        expect((yield* awaitCodeGraphWorktreeBuilds(home, checkoutId, 0).pipe(Effect.exit))._tag).toBe('Failure');
        expect(yield* withCodeGraphTargetWorktreeLock(home, checkoutId, worktreeId, Effect.succeed('full'))).toBe(
          'full',
        );
        expect(
          (yield* withCodeGraphTargetWorktreeLock(home, checkoutId, worktreeId, Effect.void, scopeId).pipe(Effect.exit))
            ._tag,
        ).toBe('Failure');
        expect(yield* compactCodeGraphStorage(home, checkoutId, {dryRun: false, force: true})).toMatchObject({
          action: 'deferred',
          reason: 'active-build',
        });
        const purge = yield* purgeCodeGraphSnapshot(
          home,
          {checkoutId, snapshotId: `cgsn_${'e'.repeat(40)}`},
          {apply: true, approvalDigest: `sha256:${'f'.repeat(64)}`},
        ).pipe(Effect.exit);
        expect(purge._tag).toBe('Failure');
      }),
      scopeId,
    );
    expect(yield* codeGraphWorktreeBuildActive(home, checkoutId)).toBe(false);
    yield* withCodeGraphMaintenanceIntent(home, awaitCodeGraphWorktreeBuilds(home, checkoutId, 0));
  }).pipe(provideTestLayer(layer)),
);
