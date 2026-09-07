import {describe, expect, it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {CodeGraphStoreError} from '../../src/code_graph/types.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {runCodeGraphCheckpointExport} from '../../src/code_graph/checkpoint/commands.js';
import {runGraphShareJoin} from '../../src/code_graph/sharing/client.js';
import {graphShareControlGetStatus} from '../../src/code_graph/sharing/control_client.js';
import {parseSha256Digest} from '../../src/code_graph/sharing/digest.js';
import {verifyGraphShareParseReceipt} from '../../src/code_graph/sharing/parse_cache.js';
import {advanceGraphPublisherFrontier} from '../../src/code_graph/sharing/publisher_cycle.js';
import {
  runGraphPublisherBootstrap,
  runGraphPublisherListen,
  runGraphShareInit,
} from '../../src/code_graph/sharing/publisher.js';

describe('publisher contribution evidence with an independent clean control', () => {
  for (const failHydration of [false, true]) {
    effectIt.effect(
      failHydration
        ? 'reports partial hydration failure while publishing a correct graph'
        : 'distinguishes received facts from canonical publisher recomputation',
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const indexer = yield* CodeGraphIndexer;
            const store = yield* CodeGraphStore;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-publication-evidence-'});
            const repo = path.join(root, 'publisher-repo');
            const contributor = path.join(root, 'contributor-repo');
            const home = path.join(root, 'publisher-home');
            const workerHome = path.join(root, 'worker-home');
            const controlHome = path.join(root, 'control-home');
            const cas = path.join(root, 'cas');
            const controlCas = path.join(root, 'control-cas');
            const origin = 'https://github.com/acme/publication-evidence.git';
            yield* fs.makeDirectory(path.join(repo, 'src'), {recursive: true});
            yield* fs.writeFileString(path.join(repo, 'package.json'), '{"private":true,"type":"module"}\n');
            yield* fs.writeFileString(path.join(repo, 'src/a.ts'), 'export const alpha = 1;\n');
            yield* fs.writeFileString(
              path.join(repo, 'src/b.ts'),
              "import {alpha} from './a.js'; export const beta = alpha + 1;\n",
            );
            yield* git(repo, ['init', '-q', '--initial-branch=main']);
            yield* git(repo, ['remote', 'add', 'origin', origin]);
            yield* commit(repo, 'baseline');
            yield* runGraphShareInit(config(home), {cas, cwd: repo, organization: 'acme', writeConfig: true});
            yield* commit(repo, 'enroll');
            yield* indexer.index({cwd: repo, ensureVectors: false, threadnoteHome: home});
            const baseline = yield* runGraphPublisherBootstrap(config(home), {cas, cwd: repo});
            // Copy the same baseline before any contributor receipt or target-commit facts exist.
            yield* fs.copy(home, controlHome);
            yield* fs.copy(cas, controlCas);
            yield* git(root, ['clone', '-q', repo, contributor]);
            yield* git(contributor, ['remote', 'set-url', 'origin', origin]);
            const ready = yield* Deferred.make<string>();
            const listener = yield* Effect.forkScoped(
              runGraphPublisherListen(config(home), {
                cas,
                cwd: repo,
                listen: '127.0.0.1:0',
                onReady: output => Deferred.succeed(ready, output.coordinatorUrl).pipe(Effect.asVoid),
              }),
            );
            const url = yield* Deferred.await(ready);
            yield* runGraphShareJoin(config(workerHome), {
              cas: path.join(root, 'worker-cas'),
              coordinator: url,
              cwd: contributor,
            });
            // Every eligible source file changes, so old local parse facts cannot explain target reuse.
            yield* fs.writeFileString(
              path.join(contributor, 'package.json'),
              '{"private":true,"type":"module","name":"target"}\n',
            );
            yield* fs.writeFileString(
              path.join(contributor, 'src/a.ts'),
              'export function alpha(value: number) { return value * 7; }\n',
            );
            yield* fs.writeFileString(
              path.join(contributor, 'src/b.ts'),
              "import {alpha} from './a.js'; export function beta(value: number) { return alpha(value) + 3; }\n",
            );
            yield* commit(contributor, 'target');
            const target = yield* resolveRepositoryIdentity(contributor);
            yield* indexer.index({cwd: contributor, ensureVectors: false, threadnoteHome: workerHome});
            const status = yield* graphShareControlGetStatus(url);
            const receipts = status.receipts.filter(receipt => receipt.batchId === target.headCommit);
            expect(receipts).toHaveLength(3);
            const identity = yield* resolveRepositoryIdentity(repo);
            expect(identity.headCommit).toBe(baseline.sourceCommit);
            const databasePath = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId).databasePath;
            for (const announcement of receipts) {
              const verified = yield* verifyGraphShareParseReceipt({
                announcement: {
                  ...announcement,
                  attestationDigest: parseSha256Digest(announcement.attestationDigest),
                  resultManifestDigest: parseSha256Digest(announcement.resultManifestDigest),
                  semanticDigest: parseSha256Digest(announcement.semanticDigest),
                },
                casRoot: cas,
                repositoryId: identity.repositoryId,
              });
              const cached = yield* store.cachedCommittedFileKeys(databasePath, verified.parsed.extractorSet, [
                {path: verified.parsed.normalizedPath, contentHash: verified.parsed.contentHash},
              ]);
              expect(cached.size).toBe(0);
            }
            // Stop the watch before advancing the publisher clone; publication is now exactly controlled.
            yield* Fiber.interrupt(listener);
            yield* git(repo, ['fetch', '-q', contributor, 'main']);
            yield* git(repo, ['merge', '--ff-only', 'FETCH_HEAD']);
            const control = yield* advanceGraphPublisherFrontier(config(controlHome), {
              cas: controlCas,
              cwd: repo,
              forceFreeze: true,
            });
            expect(control.published).toBe(true);
            expect(control.contributionEvidence).toMatchObject({
              selectedResults: 0,
              verifiedResults: 0,
              hydration: {status: 'completed', hydratedResults: 0},
              index: {reusedFiles: 0, totalFiles: 3},
            });
            const publication = advanceGraphPublisherFrontier(config(home), {cas, cwd: repo, forceFreeze: true});
            let hydrationCalls = 0;
            const advanced = yield* failHydration
              ? publication.pipe(
                  Effect.provideService(CodeGraphStore, {
                    ...store,
                    cacheFacts: (...args) =>
                      Effect.gen(function* () {
                        hydrationCalls += 1;
                        if (hydrationCalls === 2)
                          return yield* CodeGraphStoreError.of('synthetic hydration fault; do not expose this error');
                        return yield* store.cacheFacts(...args);
                      }),
                  }),
                )
              : publication;
            expect(advanced.published).toBe(true);
            expect(advanced.sourceCommit).toBe(target.headCommit);
            expect(advanced.generation).toBe(2);
            expect(advanced.contributionEvidence).toMatchObject({
              selectedResults: 3,
              verifiedResults: 3,
              resultDigestsTruncated: false,
              hydration: failHydration
                ? {status: 'failed', hydratedResults: null}
                : {status: 'completed', hydratedResults: 3},
              index: {reusedFiles: 0, totalFiles: 3},
            });
            expect(advanced.contributionEvidence?.resultManifestDigests).toEqual(
              receipts.map(item => item.resultManifestDigest).sort(),
            );
            expect(JSON.stringify(advanced)).not.toContain('synthetic hydration fault');
            // Compare whole logical graphs, independently built from the same baseline and target Git source.
            const actual = yield* runCodeGraphCheckpointExport(config(home), {
              cwd: repo,
              output: path.join(root, 'actual.cgcp'),
              quiet: true,
            });
            const clean = yield* runCodeGraphCheckpointExport(config(controlHome), {
              cwd: repo,
              output: path.join(root, 'clean.cgcp'),
              quiet: true,
            });
            expect(actual.logicalDigest).toBe(clean.logicalDigest);
            const forced = yield* indexer.index({cwd: repo, force: true, ensureVectors: false, threadnoteHome: home});
            expect(forced.reusedFiles).toBe(0);
            const unchanged = yield* advanceGraphPublisherFrontier(config(home), {cas, cwd: repo, forceFreeze: true});
            expect(unchanged.published).toBe(false);
            expect(unchanged.contributionEvidence).toBeUndefined();
          }).pipe(provideTestLayer(ApplicationLayer)),
        ),
      180_000,
    );
  }
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
const commit = Effect.fn(function* (repo: string, message: string) {
  yield* git(repo, ['add', '.']);
  yield* git(repo, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    message,
  ]);
});
