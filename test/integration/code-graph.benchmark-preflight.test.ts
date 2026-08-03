import {Effect, FileSystem, Path} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  revalidateExternalBenchmarkPreflightState,
  validateBenchmarkRuntimeProvenance,
} from '../../scripts/benchmark-code-graph.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';

const CONTROL = JSON.stringify({
  expectedLanguage: 'typescript',
  expectedPath: 'src/index.ts',
  query: 'indexSymbol',
});

describe('external code graph benchmark execution safety', () => {
  it('rejects source and external checkout drift before emitting preflight evidence', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-benchmark-preflight-drift-'});
          const sourceRepository = path.join(root, 'threadnote-source');
          const externalRepository = path.join(root, 'external-source');
          yield* fs.makeDirectory(sourceRepository, {recursive: true});
          yield* fs.writeFileString(path.join(sourceRepository, 'bun.lock'), 'fixture lock\n');
          yield* fs.writeFileString(path.join(sourceRepository, 'package.json'), '{}\n');
          yield* fs.writeFileString(path.join(sourceRepository, 'source.ts'), 'export const source = 1;\n');
          const sourceCommit = yield* initializeGitRepository(sourceRepository);
          yield* fs.makeDirectory(externalRepository, {recursive: true});
          yield* fs.writeFileString(path.join(externalRepository, 'external.ts'), 'export const external = 1;\n');
          const externalCommit = yield* initializeGitRepository(externalRepository);
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              CI: 'true',
              GITHUB_ACTIONS: 'true',
              GITHUB_REPOSITORY: 'Kashkovsky/threadnote',
              GITHUB_RUN_ID: '123',
              GITHUB_SHA: sourceCommit,
              GITHUB_WORKSPACE: sourceRepository,
            }),
          });
          const initial = yield* validateBenchmarkRuntimeProvenance(sourceRepository).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );

          yield* fs.writeFileString(path.join(sourceRepository, 'source.ts'), 'export const source = 2;\n');
          const sourceFailure = yield* revalidateExternalBenchmarkPreflightState(
            sourceRepository,
            externalRepository,
            externalCommit,
            initial,
          ).pipe(Effect.provideService(SystemInfo, testSystem), Effect.flip);
          yield* fs.writeFileString(path.join(sourceRepository, 'source.ts'), 'export const source = 1;\n');

          yield* fs.writeFileString(path.join(externalRepository, 'external.ts'), 'export const external = 2;\n');
          const externalFailure = yield* revalidateExternalBenchmarkPreflightState(
            sourceRepository,
            externalRepository,
            externalCommit,
            initial,
          ).pipe(Effect.provideService(SystemInfo, testSystem), Effect.flip);
          return {externalFailure: String(externalFailure), initial, sourceFailure: String(sourceFailure)};
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.initial.mode).toBe('github-actions-clean-source');
    expect(result.sourceFailure).toContain('clean Threadnote checkout');
    expect(result.externalFailure).toContain('External repository changed during the benchmark');
  });

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'preflights every run, sees config-hidden dirt, and releases prospective homes',
    async () => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-benchmark-preflight-test-'});
            const repository = path.join(root, 'repository');
            const output = path.join(root, 'evidence.json');
            const home = path.join(root, 'primary-home');
            const referenceHome = path.join(root, 'reference-home');
            const script = path.resolve('scripts/benchmark-code-graph.ts');
            yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
            yield* fs.writeFileString(path.join(repository, 'src', 'index.ts'), 'export const indexSymbol = 1;\n');
            yield* runCommandEffect('git', ['init', '--quiet', repository]);
            yield* runCommandEffect('git', [
              '-C',
              repository,
              'remote',
              'add',
              'origin',
              'https://github.com/Example/benchmark-fixture.git',
            ]);
            yield* runCommandEffect('git', ['-C', repository, 'add', 'src/index.ts']);
            yield* runCommandEffect(
              'git',
              [
                '-C',
                repository,
                '-c',
                'user.name=Threadnote Benchmark',
                '-c',
                'user.email=benchmark@threadnote.invalid',
                'commit',
                '--quiet',
                '-m',
                'fixture',
              ],
              {timeoutMs: 10_000},
            );

            const sourceDirty =
              (yield* runCommandEffect('git', [
                '-C',
                path.resolve('.'),
                '-c',
                'core.fsmonitor=false',
                '-c',
                'core.untrackedCache=false',
                '-c',
                'status.showUntrackedFiles=all',
                'status',
                '--porcelain=v1',
                '--untracked-files=all',
              ])).stdout.trim().length > 0;
            const common = [
              '--repository',
              repository,
              '--incremental-path',
              'src/index.ts',
              '--control',
              CONTROL,
              '--output',
              output,
              '--home',
              home,
              '--reference-home',
              referenceHome,
              '--retain-homes',
            ] as const;
            const first = yield* Effect.promise(() =>
              runBenchmark(script, [...common, '--minimum-free-gib', '1', '--preflight']),
            );
            const firstHomesReleased = !(yield* fs.exists(home)) && !(yield* fs.exists(referenceHome));
            const second = yield* Effect.promise(() =>
              runBenchmark(script, [...common, '--minimum-free-gib', '1', '--preflight']),
            );
            const secondHomesReleased = !(yield* fs.exists(home)) && !(yield* fs.exists(referenceHome));

            yield* runCommandEffect('git', ['-C', repository, 'config', 'status.showUntrackedFiles', 'no']);
            yield* fs.writeFileString(path.join(repository, 'hidden-untracked.txt'), 'must still be detected\n');
            const dirty = yield* Effect.promise(() =>
              runBenchmark(script, [...common, '--minimum-free-gib', '1', '--preflight']),
            );
            yield* fs.remove(path.join(repository, 'hidden-untracked.txt'));

            const lowDisk = yield* Effect.promise(() =>
              runBenchmark(script, [...common, '--minimum-free-gib', '8000000']),
            );
            const lowDiskHomesReleased = !(yield* fs.exists(home)) && !(yield* fs.exists(referenceHome));
            const actual = yield* Effect.promise(() =>
              runBenchmark(script, [...common, '--minimum-free-gib', '1', '--samples', '1', '--warmups', '0']),
            );
            const artifactExists = yield* fs.exists(output);

            return {
              actual,
              artifact: artifactExists ? JSON.parse(yield* fs.readFileString(output)) : undefined,
              artifactExists,
              dirty,
              first,
              firstHomesReleased,
              lowDisk,
              lowDiskHomesReleased,
              preflightArtifactExists: yield* fs.exists(`${output}.preflight.json`),
              second,
              secondHomesReleased,
              sourceDirty,
            };
          }),
        ).pipe(Effect.provide(ApplicationLayer)),
      );

      expect(result.firstHomesReleased).toBe(true);
      expect(result.secondHomesReleased).toBe(true);
      expect(result.lowDiskHomesReleased).toBe(true);
      if (result.sourceDirty) {
        for (const attempt of [result.first, result.second, result.dirty, result.lowDisk, result.actual]) {
          expect(attempt.exitCode).not.toBe(0);
          expect(`${attempt.stderr}\n${attempt.stdout}`).toContain('clean Threadnote checkout');
        }
        expect(result.preflightArtifactExists).toBe(false);
        expect(result.actual.exitCode).not.toBe(0);
        expect(`${result.actual.stderr}\n${result.actual.stdout}`).not.toContain(
          'one-file reindex incremental-overlay materialization mode',
        );
        expect(result.artifactExists).toBe(false);
      } else {
        expect(result.first.exitCode).toBe(0);
        expect(result.second.exitCode).toBe(0);
        expect(result.preflightArtifactExists).toBe(true);
        expect(result.dirty.exitCode).not.toBe(0);
        expect(`${result.dirty.stderr}\n${result.dirty.stdout}`).toContain('requires a clean checkout');
        expect(result.lowDisk.exitCode).not.toBe(0);
        expect(`${result.lowDisk.stderr}\n${result.lowDisk.stdout}`).toContain(
          'External benchmark preflight requires at least 8000000 GiB',
        );
        expect(
          result.actual.exitCode,
          `benchmark stderr:\n${result.actual.stderr}\nbenchmark stdout:\n${result.actual.stdout}`,
        ).toBe(0);
        expect(result.artifactExists).toBe(true);
        expect(result.artifact?.metadata).toMatchObject({
          externalRepositoryName: 'Example/benchmark-fixture',
          externalRepositoryUrl: 'https://github.com/Example/benchmark-fixture',
          managerRequestCancellationPassed: true,
          managerRequestLifecycleControl:
            'real Manager queries through the GraphWorkspace request gate: superseding aborts an in-flight request; a completed late response is rejected',
          managerSnapshotBindingPassed: true,
          managerStaleResponseRejectionPassed: true,
          oneFileReindexMaterializationMode: 'incremental-overlay',
          sameOverlayReferenceMaterializationMode: 'full',
          simultaneousWorktrees: 2,
          worktreeIsolationIndexedFiles: 2,
          worktreeIsolationPassed: true,
          worktreeIsolationTopology: 'bounded-synthetic-linked-worktrees-in-measured-primary-home',
        });
        for (const name of [
          'external-query-cold-typescript-duration',
          'manager-catalog-cold',
          'manager-catalog-warm',
          'manager-overview-cold',
          'manager-overview-warm',
          'manager-detail-cold',
          'manager-layout-preparation-proxy',
          'manager-response-payload',
          'manager-bounded-query',
          'manager-bounded-query-payload',
          'concurrent-worktree-isolation-duration',
        ]) {
          expect(result.artifact?.measurements.some((measurement: {name: string}) => measurement.name === name)).toBe(
            true,
          );
        }
        expect(result.artifact?.metadata.structuralGraphDigestIncremental).toBe(
          result.artifact?.metadata.structuralGraphDigestSameOverlayReference,
        );
      }
    },
    30_000,
  );
});

const initializeGitRepository = Effect.fn('benchmarkPreflightTest.initializeGitRepository')(function* (
  repository: string,
) {
  yield* runCommandEffect('git', ['init', '--quiet', repository]);
  yield* runCommandEffect('git', ['-C', repository, 'add', '.']);
  yield* runCommandEffect(
    'git',
    [
      '-C',
      repository,
      '-c',
      'user.name=Threadnote Benchmark',
      '-c',
      'user.email=benchmark@threadnote.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    {timeoutMs: 10_000},
  );
  return (yield* runCommandEffect('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
});

async function runBenchmark(script: string, args: readonly string[]) {
  const sourceCommit = Bun.spawnSync({cmd: ['git', 'rev-parse', 'HEAD'], stderr: 'pipe', stdout: 'pipe'})
    .stdout.toString()
    .trim();
  const child = Bun.spawn({
    cmd: [process.execPath, script, ...args],
    env: {
      ...process.env,
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'Kashkovsky/threadnote',
      GITHUB_RUN_ID: '1',
      GITHUB_SHA: sourceCommit,
      GITHUB_WORKSPACE: process.cwd(),
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return {exitCode, stderr, stdout};
}
