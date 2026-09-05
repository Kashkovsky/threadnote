import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {runGraphShareJoin, runGraphShareStatus} from '../../src/code_graph/sharing/client.js';
import {readSharedGraphProvenance} from '../../src/code_graph/sharing/provenance.js';
import {runGraphPublisherBootstrap, runGraphShareInit} from '../../src/code_graph/sharing/publisher.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

describe('graph share ensure-commit import', () => {
  effectIt.effect(
    'imports a published ancestor before the ensure-commit writer lock',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-ensure-commit-'});
          const repository = path.join(root, 'repository');
          const cas = path.join(root, 'cas');
          const publisherHome = path.join(root, 'publisher-home');
          const clientHome = path.join(root, 'client-home');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.writeFileString(
            path.join(repository, 'package.json'),
            '{"name":"graph-share-ensure","private":true,"type":"module"}\n',
          );
          yield* fs.writeFileString(path.join(repository, 'src', 'index.ts'), 'export const shared = 1;\n');
          yield* git(repository, ['init', '-q', '--initial-branch=main']);
          yield* git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share-ensure.git']);
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
            'enroll graph sharing',
          ]);
          yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            force: true,
            threadnoteHome: publisherHome,
          });
          const published = yield* runGraphPublisherBootstrap(config(publisherHome), {cas, cwd: repository});
          yield* runGraphShareJoin(config(clientHome), {cas, cwd: repository, readOnly: true});
          const head = (yield* runCommandEffect('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
          const lease = yield* indexer.ensureCommit({
            commit: head,
            cwd: repository,
            ensureVectors: false,
            threadnoteHome: clientHome,
          });
          expect(lease.snapshot.id).toMatch(/^cgsn_/);
          const identity = yield* resolveRepositoryIdentity(repository);
          const provenance = yield* readSharedGraphProvenance(clientHome, identity.checkoutId);
          const status = yield* runGraphShareStatus(config(clientHome), {cwd: repository, json: true});
          expect(status.lastImport).toMatchObject({
            imported: true,
            reason: 'imported',
            checkpointDigest: published.checkpointDigest,
          });
          expect(provenance?.checkpointDigest).toBe(published.checkpointDigest);
          expect(provenance?.snapshotId).toBe(lease.snapshot.id);
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
