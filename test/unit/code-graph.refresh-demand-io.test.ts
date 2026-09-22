import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '../helpers/fast-check-property.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '../helpers/test-error.js';
import {observeCodeGraphAdmissionEnvironment} from '../../src/code_graph/admission_freshness.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {codeGraphBuildRequestKey} from '../../src/code_graph/indexer/build.js';
import {worktreeBuildRequestState} from '../../src/code_graph/inventory.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../../src/code_graph/languages/registry.js';
import {
  adoptCodeGraphBackgroundDemand,
  beginCodeGraphBackgroundPublication,
  CodeGraphRefreshDemandSuperseded,
  recoverCodeGraphBackgroundDemand,
  registerCodeGraphBackgroundDemand,
  resumeCodeGraphBackgroundDemand,
} from '../../src/code_graph/refresh/demand.js';
import {
  codeGraphRefreshDemandLockPath,
  codeGraphRefreshDemandPath,
  codeGraphWorktreeSpawnLockPath,
} from '../../src/code_graph/layout.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';

const checkoutId = 'a'.repeat(64);
const worktreeId = 'b'.repeat(64);
const firstKey = '1'.repeat(64);
const secondKey = '2'.repeat(64);
const scopeA = `code-graph-scope:${'c'.repeat(64)}`;
const scopeB = `code-graph-scope:${'d'.repeat(64)}`;
const TestLayer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));

describe('code graph refresh demand sidecar', () => {
  fcEffectProp(
    effectIt,
    'keeps distinct scope paths deterministic and every recovery component within NAME_MAX',
    [fc.uniqueArray(fc.integer({min: 0, max: 1000}), {minLength: 2, maxLength: 8})] as const,
    ([values]) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const paths = values.flatMap(value => {
          const scope = `code-graph-scope:${value.toString(16).padStart(64, '0')}`;
          const data = codeGraphRefreshDemandPath(path, '/private/home', checkoutId, worktreeId, scope);
          const lock = codeGraphRefreshDemandLockPath(path, '/private/home', checkoutId, worktreeId, scope);
          const spawn = codeGraphWorktreeSpawnLockPath(path, '/private/home', checkoutId, worktreeId, scope);
          expect(data).toBe(codeGraphRefreshDemandPath(path, '/private/home', checkoutId, worktreeId, scope));
          for (const component of [data, `${lock}.recovery-${'f'.repeat(64)}`, `${spawn}.recovery-${'f'.repeat(64)}`])
            expect(new TextEncoder().encode(path.basename(component)).length).toBeLessThanOrEqual(255);
          return [data, lock, spawn];
        });
        expect(new Set(paths).size).toBe(paths.length);
      }).pipe(provideTestLayer(TestLayer)),
    {fastCheck: {numRuns: 25}},
  );

  effectIt.effect(
    'isolates coalescing sidecars by exact configured view while preserving the legacy full filename',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-scopes-'});
          const full = {checkoutId, threadnoteHome: home, worktreeId};
          const first = {...full, scopeId: scopeA};
          const second = {...full, scopeId: scopeB};

          expect((yield* registerCodeGraphBackgroundDemand(first, firstKey)).type).toBe('claimed');
          expect((yield* registerCodeGraphBackgroundDemand(second, secondKey)).type).toBe('claimed');

          const fullPath = codeGraphRefreshDemandPath(path, home, checkoutId, worktreeId);
          const firstPath = codeGraphRefreshDemandPath(path, home, checkoutId, worktreeId, scopeA);
          const secondPath = codeGraphRefreshDemandPath(path, home, checkoutId, worktreeId, scopeB);
          expect(fullPath).toContain(`-${worktreeId}.json`);
          expect(firstPath).not.toBe(secondPath);
          expect(firstPath).not.toBe(fullPath);
          expect(firstPath.split('/').at(-1)?.length).toBeLessThan(200);
          expect(secondPath.split('/').at(-1)?.length).toBeLessThan(200);
          const lock = codeGraphRefreshDemandLockPath(path, home, checkoutId, worktreeId, scopeA);
          const spawn = codeGraphWorktreeSpawnLockPath(path, home, checkoutId, worktreeId, scopeA);
          expect(path.dirname(lock)).toBe(path.dirname(firstPath));
          expect(firstPath).toMatch(/\.json$/u);
          expect(lock).toMatch(/\.lock$/u);
          expect(new Set([firstPath, lock, spawn]).size).toBe(3);
          for (const file of [firstPath, `${lock}.recovery-${'f'.repeat(64)}`, `${spawn}.recovery-${'f'.repeat(64)}`]) {
            expect(new TextEncoder().encode(path.basename(file)).length).toBeLessThanOrEqual(255);
          }
          expect(yield* fs.exists(firstPath)).toBe(true);
          expect(yield* fs.exists(secondPath)).toBe(true);
          expect(yield* fs.exists(fullPath)).toBe(false);
        }),
      ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('recovers a stranded scoped demand lock and its recovery guard', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-recovery-'});
      const identity = {checkoutId, scopeId: scopeA, threadnoteHome: home, worktreeId};
      const lock = codeGraphRefreshDemandLockPath(path, home, checkoutId, worktreeId, scopeA);
      yield* fs.makeDirectory(path.dirname(lock), {recursive: true, mode: 0o700});
      const owner = JSON.stringify({
        processId: 2_000_000_000,
        processStartIdentity: 'dead',
        token: 'stranded',
        version: 1,
      });
      yield* fs.writeFileString(lock, owner, {mode: 0o600});
      yield* fs.writeFileString(`${lock}.recovery`, owner, {mode: 0o600});
      expect((yield* registerCodeGraphBackgroundDemand(identity, firstKey)).type).toBe('claimed');
      expect(yield* fs.exists(lock)).toBe(false);
      expect(yield* fs.exists(`${lock}.recovery`)).toBe(false);
      expect(yield* fs.readDirectory(path.dirname(lock))).toHaveLength(1);
    }).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('keeps a live pre-status claimant and recovers it after the exact process dies', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-live-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        const claimed = yield* registerCodeGraphBackgroundDemand(identity, firstKey);
        expect(claimed.type).toBe('claimed');

        const retained = yield* recoverCodeGraphBackgroundDemand(identity, {liveness: 'inactive'});
        expect(retained.active?.targetToken).toBe(claimed.target.targetToken);

        const sidecar = codeGraphRefreshDemandPath(path, home, checkoutId, worktreeId);
        const persisted = JSON.parse(yield* fs.readFileString(sidecar)) as Record<string, unknown> & {
          active: Record<string, unknown>;
        };
        persisted.active = {
          ...persisted.active,
          claimOwner: {processId: 2_000_000_000, processStartIdentity: 'dead-process'},
        };
        yield* fs.writeFileString(sidecar, `${JSON.stringify(persisted)}\n`, {flag: 'w', mode: 0o600});

        const recovered = yield* recoverCodeGraphBackgroundDemand(identity, {liveness: 'inactive'});
        expect(recovered.active).toBeUndefined();
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('never admits a target that was absent when resume acquired the sidecar lock', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-resume-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        const claimed = yield* registerCodeGraphBackgroundDemand(identity, firstKey);
        expect(claimed.type).toBe('claimed');

        const absent = yield* resumeCodeGraphBackgroundDemand(identity, secondKey, {liveness: 'inactive'});
        expect(absent).toBeUndefined();
        const retained = yield* recoverCodeGraphBackgroundDemand(identity, {liveness: 'inactive'});
        expect(retained.active?.targetKey).toBe(firstKey);
        expect(retained.desired).toBeUndefined();
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('does not displace a live publisher when status evidence is stale', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-publishing-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        const claimed = yield* registerCodeGraphBackgroundDemand(identity, firstKey);
        expect(claimed.type).toBe('claimed');
        expect(yield* beginCodeGraphBackgroundPublication(identity, claimed.target.targetToken, firstKey)).toBe(
          'publish',
        );

        const resumed = yield* resumeCodeGraphBackgroundDemand(identity, firstKey, {liveness: 'inactive'});
        expect(resumed).toMatchObject({
          type: 'attached',
          target: {phase: 'publishing', targetToken: claimed.target.targetToken},
        });
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('bounds live-process authority to the pre-status startup grace', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-owner-grace-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        yield* registerCodeGraphBackgroundDemand(identity, firstKey);
        yield* TestClock.adjust(30_001);

        const recovered = yield* recoverCodeGraphBackgroundDemand(identity, {liveness: 'inactive'});
        expect(recovered.active).toBeUndefined();
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('preserves an adopted child during the bounded pre-status window', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-adopted-grace-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        const claim = yield* registerCodeGraphBackgroundDemand(identity, firstKey);
        expect(yield* adoptCodeGraphBackgroundDemand(identity, claim.target.targetToken, firstKey)).toBe(true);

        const retained = yield* recoverCodeGraphBackgroundDemand(identity, {liveness: 'inactive'});
        expect(retained.active).toMatchObject({
          phase: 'preparing',
          targetToken: claim.target.targetToken,
        });
        yield* TestClock.adjust(30_001);
        const expired = yield* recoverCodeGraphBackgroundDemand(identity, {liveness: 'inactive'});
        expect(expired.active).toBeUndefined();
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('refuses a linked sidecar without reading or writing its outside target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-link-'});
        const outside = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-outside-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        const sidecar = codeGraphRefreshDemandPath(path, home, checkoutId, worktreeId);
        const outsideTarget = path.join(outside, 'target.json');
        yield* fs.writeFileString(outsideTarget, 'outside-marker\n', {mode: 0o600});
        yield* fs.symlink(outsideTarget, sidecar);

        const failure = yield* Effect.flip(registerCodeGraphBackgroundDemand(identity, firstKey));
        expect(Schema.is(CodeGraphRefreshDemandSuperseded)(failure)).toBe(true);
        expect(yield* fs.readFileString(outsideTarget)).toBe('outside-marker\n');
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('refuses a linked lock file before reading or writing its outside target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-lock-link-'});
        const outside = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-lock-outside-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        const lockPath = codeGraphRefreshDemandLockPath(path, home, checkoutId, worktreeId);
        const outsideTarget = path.join(outside, 'lock');
        yield* fs.writeFileString(outsideTarget, 'outside-lock-marker\n', {mode: 0o600});
        yield* fs.symlink(outsideTarget, lockPath);

        const failure = yield* Effect.flip(registerCodeGraphBackgroundDemand(identity, firstKey));
        expect(Schema.is(CodeGraphRefreshDemandSuperseded)(failure)).toBe(true);
        expect(yield* fs.readFileString(outsideTarget)).toBe('outside-lock-marker\n');
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('reconstructs an oversized sidecar through the bounded stable-file reader', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-bounded-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        yield* registerCodeGraphBackgroundDemand(identity, firstKey);
        const sidecar = codeGraphRefreshDemandPath(path, home, checkoutId, worktreeId);
        yield* fs.writeFileString(sidecar, 'x'.repeat(8 * 1024 + 1), {flag: 'w', mode: 0o600});

        const reconstructed = yield* registerCodeGraphBackgroundDemand(identity, secondKey);
        expect(reconstructed.type).toBe('claimed');
        expect(reconstructed.state.active?.targetKey).toBe(secondKey);
        expect(Number((yield* fs.stat(sidecar)).size)).toBeLessThan(8 * 1024);
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('stops a real indexer at the publication checkpoint after a newer target is queued', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-indexer-'});
          const repository = path.join(home, 'repository');
          yield* fs.makeDirectory(repository);
          yield* fs.writeFileString(path.join(repository, 'source.ts'), 'export const value = 1;\n');
          yield* Effect.sync(() => {
            runGit(repository, ['init', '--quiet']);
            runGit(repository, ['config', 'user.email', 'test@example.invalid']);
            runGit(repository, ['config', 'user.name', 'Threadnote Test']);
            runGit(repository, ['add', 'source.ts']);
            runGit(repository, ['commit', '--quiet', '-m', 'fixture']);
          });

          const identity = yield* resolveRepositoryIdentity(repository);
          const overlay = yield* worktreeBuildRequestState(identity, home);
          const environment = yield* observeCodeGraphAdmissionEnvironment(identity);
          const targetKey = codeGraphBuildRequestKey(
            identity,
            overlay,
            BUILTIN_LANGUAGE_PACK_REGISTRY,
            undefined,
            false,
            environment,
          );
          const demandIdentity = {
            checkoutId: identity.checkoutId,
            threadnoteHome: home,
            worktreeId: identity.worktreeId,
          };
          const claim = yield* registerCodeGraphBackgroundDemand(demandIdentity, targetKey);
          expect(claim.type).toBe('claimed');
          yield* registerCodeGraphBackgroundDemand(demandIdentity, secondKey);

          const indexer = yield* CodeGraphIndexer;
          const failure = yield* Effect.flip(
            indexer.index({
              admissionClass: 'background',
              cwd: repository,
              ensureVectors: false,
              refreshDemandToken: claim.target.targetToken,
              threadnoteHome: home,
            }),
          );
          expect(Schema.is(CodeGraphRefreshDemandSuperseded)(failure)).toBe(true);

          const sidecar = codeGraphRefreshDemandPath(path, home, identity.checkoutId, identity.worktreeId);
          const state = JSON.parse(yield* fs.readFileString(sidecar)) as {
            readonly active?: unknown;
            readonly desired?: {readonly targetKey: string};
          };
          expect(state.active).toBeUndefined();
          expect(state.desired?.targetKey).toBe(secondKey);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );
});

function runGit(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync({cmd: ['git', '-C', cwd, ...args], stderr: 'pipe', stdout: 'pipe'});
  if (result.exitCode !== 0) throw TestError.make({message: result.stderr.toString()});
}
