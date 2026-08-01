import {Effect, FileSystem, Path} from 'effect';
import {describe, expect, it} from 'vitest';
import {runCommandEffect} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

const CONTROL = JSON.stringify({
  expectedLanguage: 'typescript',
  expectedPath: 'src/index.ts',
  query: 'indexSymbol',
});

describe('external code graph benchmark execution safety', () => {
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

      expect(result.first.exitCode).toBe(0);
      expect(result.second.exitCode).toBe(0);
      expect(result.firstHomesReleased).toBe(true);
      expect(result.secondHomesReleased).toBe(true);
      expect(result.preflightArtifactExists).toBe(true);
      expect(result.dirty.exitCode).not.toBe(0);
      expect(`${result.dirty.stderr}\n${result.dirty.stdout}`).toContain('requires a clean checkout');
      expect(result.lowDisk.exitCode).not.toBe(0);
      expect(`${result.lowDisk.stderr}\n${result.lowDisk.stdout}`).toContain(
        'External benchmark preflight requires at least 8000000 GiB',
      );
      expect(result.lowDiskHomesReleased).toBe(true);
      if (result.sourceDirty) {
        expect(result.actual.exitCode).not.toBe(0);
        expect(`${result.actual.stderr}\n${result.actual.stdout}`).toContain('clean exact Threadnote source commit');
        expect(`${result.actual.stderr}\n${result.actual.stdout}`).not.toContain(
          'one-file reindex incremental-overlay materialization mode',
        );
        expect(result.artifactExists).toBe(false);
      } else {
        expect(result.actual.exitCode).toBe(0);
        expect(result.artifactExists).toBe(true);
        expect(result.artifact?.metadata).toMatchObject({
          oneFileReindexMaterializationMode: 'incremental-overlay',
          sameOverlayReferenceMaterializationMode: 'full',
        });
        expect(result.artifact?.metadata.structuralGraphDigestIncremental).toBe(
          result.artifact?.metadata.structuralGraphDigestSameOverlayReference,
        );
      }
    },
    30_000,
  );
});

async function runBenchmark(script: string, args: readonly string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, script, ...args],
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
