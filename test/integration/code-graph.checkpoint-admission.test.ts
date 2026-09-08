import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {
  importCodeGraphCheckpointSnapshot,
  CodeGraphCheckpointCommandError,
  runCodeGraphCheckpointExport,
} from '../../src/code_graph/checkpoint/commands.js';
import {
  decodeCodeGraphCheckpointPackV1,
  encodeCodeGraphCheckpointPackV1,
} from '../../src/code_graph/checkpoint/pack.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {CommandExecutor, runCommandEffect} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('checkpoint receiver admission', () => {
  it.effect(
    'rejects both stricter and looser receiver inventories without replacing ready state',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const command = yield* CommandExecutor;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-checkpoint-admission-'});
        const repo = path.join(root, 'repository');
        yield* fs.makeDirectory(path.join(repo, 'src'), {recursive: true});
        yield* fs.writeFileString(path.join(repo, 'package.json'), '{"name":"checkpoint-admission","type":"module"}\n');
        yield* fs.writeFileString(path.join(repo, 'src/included.ts'), 'export const included = 1;\n');
        yield* fs.writeFileString(path.join(repo, 'src/excluded.ts'), 'export const excluded = 2;\n');
        yield* fs.makeDirectory(path.join(repo, 'assets'));
        yield* fs.writeFile(path.join(repo, 'assets/icon.png'), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
        yield* git(repo, ['init', '-q', '--initial-branch=main']);
        yield* git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/checkpoint-admission.git']);
        yield* git(repo, ['add', '.']);
        yield* git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
        const exclude = path.join(repo, '.git/info/exclude');
        for (const donorExcludes of [false, true]) {
          const donorHome = path.join(root, `donor-${donorExcludes}`);
          const receiverHome = path.join(root, `receiver-${donorExcludes}`);
          const artifact = path.join(root, `checkpoint-${donorExcludes}.cgcp`);
          yield* fs.writeFileString(exclude, donorExcludes ? 'src/excluded.ts\n' : '');
          const donor = yield* indexer.index({cwd: repo, threadnoteHome: donorHome, ensureVectors: false});
          yield* runCodeGraphCheckpointExport(config(donorHome), {cwd: repo, output: artifact, quiet: true});
          const bytes = yield* fs.readFile(artifact);
          const decoded = decodeCodeGraphCheckpointPackV1(bytes);
          const withoutReuse = path.join(root, `without-reuse-${donorExcludes}.cgcp`);
          yield* fs.writeFile(
            withoutReuse,
            encodeCodeGraphCheckpointPackV1(
              {
                abi: decoded.header.abi.input,
                coverage: decoded.header.coverage,
                repository: decoded.header.repository,
                source: decoded.header.source,
              },
              decoded.records,
            ).bytes,
          );

          yield* fs.writeFileString(exclude, donorExcludes ? '' : 'src/excluded.ts\n');
          const receiver = yield* indexer.index({cwd: repo, threadnoteHome: receiverHome, ensureVectors: false});
          const identity = yield* resolveRepositoryIdentity(repo);
          const database = codeGraphLayout(path, receiverHome, identity.checkoutId, identity.worktreeId).databasePath;
          for (const input of [artifact, withoutReuse]) {
            const result = yield* importCodeGraphCheckpointSnapshot(config(receiverHome), {cwd: repo, input}).pipe(
              Effect.result,
            );
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') {
              expect(result.failure).toMatchObject({
                _tag: 'CodeGraphCheckpointCommandError',
              });
              expect(Schema.is(CodeGraphCheckpointCommandError)(result.failure)).toBe(true);
              if (Schema.is(CodeGraphCheckpointCommandError)(result.failure)) {
                expect(result.failure.message).toContain('receiver admission');
              }
            }
            expect((yield* store.readySnapshot(database, identity.worktreeId))?.id).toBe(receiver.snapshot.id);
          }

          yield* fs.writeFileString(
            exclude,
            donorExcludes ? '# receiver comment\nsrc/excluded.ts\n' : '# receiver comment\n',
          );
          const accepted = yield* importCodeGraphCheckpointSnapshot(config(receiverHome), {cwd: repo, input: artifact});
          expect(accepted.result.publication).toBe('activated');
          expect(accepted.snapshot.graphContentId).toBe(donor.snapshot.graphContentId);
          const acceptedWithoutReuse = yield* importCodeGraphCheckpointSnapshot(config(receiverHome), {
            cwd: repo,
            input: withoutReuse,
          });
          expect(acceptedWithoutReuse.result.publication).toBe('activated');
          expect(acceptedWithoutReuse.snapshot.graphContentId).toBe(donor.snapshot.graphContentId);
          let changedPolicy = false;
          const raced = yield* importCodeGraphCheckpointSnapshot(config(receiverHome), {
            cwd: repo,
            input: artifact,
          }).pipe(
            Effect.provideService(CommandExecutor, {
              ...command,
              execute: (executable, args, options) =>
                command.execute(executable, args, options).pipe(
                  Effect.tap(() =>
                    Effect.gen(function* () {
                      if (executable === 'git' && args.includes('ls-tree') && args.includes('-r') && !changedPolicy) {
                        expect(options?.env?.GIT_NO_LAZY_FETCH).toBe('1');
                        expect(options?.env?.GIT_OPTIONAL_LOCKS).toBe('0');
                        changedPolicy = true;
                        yield* fs.writeFileString(exclude, donorExcludes ? '' : 'src/excluded.ts\n');
                      }
                    }),
                  ),
                ),
            }),
            Effect.result,
          );
          expect(changedPolicy).toBe(true);
          expect(raced._tag).toBe('Failure');
          if (raced._tag === 'Failure') {
            expect(Schema.is(CodeGraphCheckpointCommandError)(raced.failure)).toBe(true);
            if (Schema.is(CodeGraphCheckpointCommandError)(raced.failure)) {
              expect(raced.failure.message).toContain('receiver admission');
            }
          }
          expect((yield* store.readySnapshot(database, identity.worktreeId))?.id).toBe(
            acceptedWithoutReuse.snapshot.id,
          );
          expect(yield* fs.readFile(artifact)).toEqual(bytes);
          expect((yield* git(repo, ['status', '--porcelain'])).stdout).toBe('');
        }
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );
});

function config(home: string) {
  return {
    account: 'local' as const,
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user: 'local',
  };
}

function git(repo: string, args: readonly string[]) {
  return runCommandEffect('git', ['-C', repo, ...args]);
}
