import {describe, expect, it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {
  runGraphPublisherBootstrap,
  runGraphPublisherListen,
  runGraphShareInit,
} from '../../src/code_graph/sharing/publisher.js';
import {readGraphPublisherRegistryStatus} from '../../src/code_graph/sharing/publisher/registry.js';
import {readJsonFile, writePrivateJsonFile} from '../../src/code_graph/sharing/atomic.js';
import {graphSharingLayout, graphSharingPublisherEvidencePath} from '../../src/code_graph/sharing/layout.js';
import {parseSha256Digest} from '../../src/code_graph/sharing/digest.js';

describe('publisher listener source-use evidence', () => {
  effectIt.effect(
    'retains a source-use record for an automatic publication across listener restart',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const indexer = yield* CodeGraphIndexer;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-listener-evidence-'});
          const repository = path.join(root, 'repository');
          const home = path.join(root, 'home');
          const cas = path.join(root, 'cas');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.writeFileString(path.join(repository, 'package.json'), '{"private":true,"type":"module"}\n');
          yield* fs.writeFileString(path.join(repository, 'src', 'index.ts'), 'export const baseline = 1;\n');
          yield* git(repository, ['init', '-q', '--initial-branch=main']);
          yield* git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/listener-evidence.git']);
          yield* git(repository, ['add', '.']);
          yield* commit(repository, 'baseline');
          yield* runGraphShareInit(config(home), {cas, cwd: repository, organization: 'acme', writeConfig: true});
          yield* git(repository, ['add', '.threadnote/graph-share.json']);
          yield* commit(repository, 'enroll');
          yield* indexer.index({cwd: repository, ensureVectors: false, force: true, threadnoteHome: home});
          yield* runGraphPublisherBootstrap(config(home), {cas, cwd: repository});
          const ready = yield* Deferred.make<void>();
          const listener = yield* Effect.forkScoped(
            runGraphPublisherListen(config(home), {
              cas,
              cwd: repository,
              listen: '127.0.0.1:0',
              onReady: () => Deferred.succeed(ready, undefined),
            }),
          );
          yield* Deferred.await(ready);
          yield* fs.writeFileString(path.join(repository, 'src', 'next.ts'), 'export const next = 2;\n');
          yield* git(repository, ['add', 'src/next.ts']);
          yield* commit(repository, 'next');
          const sourceCommit = (yield* resolveRepositoryIdentity(repository)).headCommit;
          let status: Effect.Success<ReturnType<typeof readGraphPublisherRegistryStatus>> | undefined;
          for (let attempt = 0; attempt < 240; attempt++) {
            status = yield* readGraphPublisherRegistryStatus(config(home), {cas, cwd: repository});
            if (status.localCandidate?.sourceCommit === sourceCommit && status.contributionEvidence !== undefined)
              break;
            yield* Effect.sleep(200);
          }
          expect(status?.localCandidate?.sourceCommit).toBe(sourceCommit);
          expect(status?.contributionEvidence).toMatchObject({
            generation: 2,
            sourceCommit,
            contributionEvidence: {
              selectedResults: 0,
              sourceUse: {consumedActions: 0, consumedResultManifestDigests: [], sourceVerifiedFiles: 3},
            },
          });
          yield* Fiber.interrupt(listener);
          const restarted = yield* Deferred.make<void>();
          const nextListener = yield* Effect.forkScoped(
            runGraphPublisherListen(config(home), {
              cas,
              cwd: repository,
              listen: '127.0.0.1:0',
              onReady: () => Deferred.succeed(restarted, undefined),
            }),
          );
          yield* Deferred.await(restarted);
          const afterRestart = yield* readGraphPublisherRegistryStatus(config(home), {cas, cwd: repository});
          expect(afterRestart.contributionEvidence).toEqual(status?.contributionEvidence);
          yield* Fiber.interrupt(nextListener);
          const recordPath = graphSharingPublisherEvidencePath(
            path,
            graphSharingLayout(path, home).root,
            (yield* resolveRepositoryIdentity(repository)).repositoryId,
            parseSha256Digest(status!.localCandidate!.manifestDigest),
          );
          const record = (yield* readJsonFile(recordPath)) as Record<string, unknown>;
          yield* writePrivateJsonFile(recordPath, {...record, generation: 'not-a-generation'});
          const malformed = yield* readGraphPublisherRegistryStatus(config(home), {cas, cwd: repository});
          expect(malformed.localCandidate?.sourceCommit).toBe(sourceCommit);
          expect(malformed.contributionEvidenceStatus).toBe('unavailable');
          expect(malformed.contributionEvidence).toBeUndefined();
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    90_000,
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

function commit(repo: string, message: string) {
  return git(repo, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    message,
  ]);
}
