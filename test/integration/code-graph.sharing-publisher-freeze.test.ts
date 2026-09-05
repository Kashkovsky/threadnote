import {describe, expect, it as effectIt} from '@effect/vitest';
import {Deferred, Effect, FileSystem, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {runGraphShareJoin} from '../../src/code_graph/sharing/client.js';
import {graphShareControlGetStatus} from '../../src/code_graph/sharing/control_client.js';
import {advanceGraphPublisherFrontier} from '../../src/code_graph/sharing/publisher_cycle.js';
import {
  runGraphPublisherBootstrap,
  runGraphPublisherListen,
  runGraphPublisherServe,
  runGraphShareInit,
} from '../../src/code_graph/sharing/publisher.js';

describe('graph share publisher freeze cycle', () => {
  effectIt.effect(
    'freezes two contributor receipts, hydrates, exports, and walks status phases',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-freeze-'});
          const repository = path.join(root, 'repository');
          const cas = path.join(root, 'cas');
          const publisherHome = path.join(root, 'publisher-home');
          const contributorA = path.join(root, 'contributor-a');
          const contributorB = path.join(root, 'contributor-b');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.writeFileString(
            path.join(repository, 'package.json'),
            '{"name":"graph-share-freeze","private":true,"type":"module"}\n',
          );
          yield* fs.writeFileString(path.join(repository, 'src', 'index.ts'), 'export const shared = 1;\n');
          yield* git(repository, ['init', '-q', '--initial-branch=main']);
          yield* git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share-freeze.git']);
          yield* git(repository, ['add', '.']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'base',
          ]);
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: publisherHome});
          const ready = yield* Deferred.make<{readonly coordinatorUrl: string}>();
          yield* runGraphShareInit(config(publisherHome), {
            cas,
            cwd: repository,
            organization: 'acme',
            writeConfig: true,
          });
          yield* git(repository, ['add', '.threadnote/graph-share.json']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'enroll',
          ]);
          yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            force: true,
            threadnoteHome: publisherHome,
          });
          yield* runGraphPublisherBootstrap(config(publisherHome), {cas, cwd: repository});
          yield* Effect.forkScoped(
            runGraphPublisherListen(config(publisherHome), {
              cas,
              cwd: repository,
              listen: '127.0.0.1:0',
              onReady: output => Deferred.succeed(ready, {coordinatorUrl: output.coordinatorUrl}).pipe(Effect.asVoid),
            }),
          );
          const {coordinatorUrl} = yield* Deferred.await(ready);
          yield* runGraphShareJoin(config(contributorA), {cas, coordinator: coordinatorUrl, cwd: repository});
          yield* runGraphShareJoin(config(contributorB), {cas, coordinator: coordinatorUrl, cwd: repository});
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: contributorA});
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: contributorB});
          const afterJoin = yield* graphShareControlGetStatus(coordinatorUrl);
          expect(afterJoin.receipts.length).toBeGreaterThan(0);
          yield* fs.writeFileString(path.join(repository, 'src', 'next.ts'), 'export const next = 2;\n');
          yield* git(repository, ['add', 'src/next.ts']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'advance',
          ]);
          yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            force: true,
            threadnoteHome: publisherHome,
          });
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: contributorA});
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: contributorB});
          const phases = yield* Ref.make<string[]>([]);
          const advanced = yield* advanceGraphPublisherFrontier(config(publisherHome), {
            cas,
            cwd: repository,
            forceFreeze: true,
            onMachine: machine => Ref.update(phases, current => [...current, machine.phase]),
          });
          expect(advanced.published).toBe(true);
          expect(advanced.generation).toBe(2);
          expect(advanced.checkpointDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
          const walked = yield* Ref.get(phases);
          expect(walked).toContain('frozen');
          expect(walked).toContain('assembling');
          expect(walked).toContain('verifying');
          expect(walked.at(-1) === 'published' || walked.at(-1) === 'collecting').toBe(true);
          const status = yield* graphShareControlGetStatus(coordinatorUrl);
          expect(status.generation).toBeGreaterThanOrEqual(1);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    180_000,
  );

  effectIt.effect(
    'keeps the last signed frontier when HEAD is unrelated',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-unrelated-'});
          const repository = path.join(root, 'repository');
          const cas = path.join(root, 'cas');
          const publisherHome = path.join(root, 'publisher-home');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.writeFileString(
            path.join(repository, 'package.json'),
            '{"name":"graph-share-unrelated","private":true,"type":"module"}\n',
          );
          yield* fs.writeFileString(path.join(repository, 'src', 'index.ts'), 'export const shared = 1;\n');
          yield* git(repository, ['init', '-q', '--initial-branch=main']);
          yield* git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share-unrelated.git']);
          yield* git(repository, ['add', '.']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'base',
          ]);
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: publisherHome});
          yield* runGraphShareInit(config(publisherHome), {
            cas,
            cwd: repository,
            organization: 'acme',
            writeConfig: true,
          });
          yield* git(repository, ['add', '.threadnote/graph-share.json']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'enroll',
          ]);
          yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            force: true,
            threadnoteHome: publisherHome,
          });
          const bootstrapped = yield* runGraphPublisherBootstrap(config(publisherHome), {cas, cwd: repository});
          yield* git(repository, ['checkout', '--orphan', 'other']);
          yield* fs.writeFileString(path.join(repository, 'src', 'index.ts'), 'export const other = 1;\n');
          yield* git(repository, ['add', '.']);
          yield* git(repository, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'unrelated',
          ]);
          const served = yield* runGraphPublisherServe(config(publisherHome), {cas, cwd: repository});
          expect(served.generation).toBe(bootstrapped.generation);
          expect(served.manifestDigest).toBe(bootstrapped.manifestDigest);
          expect(served.type).toBe('code-graph-publisher-serve');
          if (served.type === 'code-graph-publisher-serve') expect(served.published).toBe(false);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    180_000,
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
