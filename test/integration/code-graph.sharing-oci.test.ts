import {expect, it as effectIt} from '@effect/vitest';
import {Console, Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {graphRegistryFixture} from '../helpers/graph-registry.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {parseGraphShareFrontierManifest} from '../../src/code_graph/sharing/artifacts.js';
import {decodeJsonBytes, writePrivateJsonFile} from '../../src/code_graph/sharing/atomic.js';
import {putCasBytes, readVerifiedCasBlob} from '../../src/code_graph/sharing/cas.js';
import {parseGraphShareCheckpointMetadata} from '../../src/code_graph/sharing/checkpoint_cas.js';
import {maybeImportSharedGraphBase, runGraphShareJoin} from '../../src/code_graph/sharing/client.js';
import {parseSha256Digest} from '../../src/code_graph/sharing/digest.js';
import {readAcceptedGraphShareFrontier} from '../../src/code_graph/sharing/frontier_acceptance.js';
import {graphShareFrontierDiscoveryTag} from '../../src/code_graph/sharing/namespace.js';
import {parseGraphShareProfile} from '../../src/code_graph/sharing/profile.js';
import {readSharedGraphProvenance} from '../../src/code_graph/sharing/provenance.js';
import {runGraphShareInit} from '../../src/code_graph/sharing/publisher.js';
import {
  runGraphPublisherBootstrapCommand,
  runGraphPublisherServeCommand,
} from '../../src/code_graph/sharing/commands.js';
import {readGraphPublisherRegistryStatus} from '../../src/code_graph/sharing/publisher_registry.js';
import {advanceGraphPublisherFrontier} from '../../src/code_graph/sharing/publisher_cycle.js';
import {collectGraphShareRegistryPublication} from '../../src/code_graph/sharing/registry_closure.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

effectIt.effect(
  'imports cold checkpoint chunks, deltas and predecessors from OCI without coordinator artifacts',
  () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const registry = yield* graphRegistryFixture();
        const parentConsole = yield* Console.Console;
        const messages: string[] = [];
        const bootstrapCommand = (options: {cas: string; cwd: string}) =>
          registry.provide(runGraphPublisherBootstrapCommand(publisher, options)).pipe(
            Effect.provideService(Console.Console, {
              ...parentConsole,
              log: (...args) => {
                messages.push(args.join(' '));
              },
            }),
          );
        const indexer = yield* CodeGraphIndexer;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-sharing-oci-'});
        const repository = path.join(root, 'repository');
        const cas = path.join(root, 'publisher-cas');
        const publisher = config(path.join(root, 'publisher'));
        yield* fs.makeDirectory(repository);
        const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
        const commit = (message: string) =>
          git(['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', message]);
        yield* git(['init', '-q', '--initial-branch=main']);
        yield* git(['config', 'core.ignorecase', 'false']);
        yield* git(['remote', 'add', 'origin', 'https://github.com/acme/oci-test.git']);
        yield* fs.writeFileString(path.join(repository, '.gitignore'), '.threadnote/\n');
        yield* fs.writeFileString(path.join(repository, 'index.ts'), 'export const shared = 1;\n');
        yield* git(['add', '.']);
        yield* commit('base');
        const initial = yield* runGraphShareInit(publisher, {
          cas,
          cwd: repository,
          organization: 'acme',
          writeConfig: true,
        });
        const previousProfile = parseGraphShareProfile(
          yield* decodeJsonBytes(yield* readVerifiedCasBlob(cas, initial.enrollment.profile.slice('cas://'.length))),
        );
        const profile = {
          ...previousProfile,
          coordinator: {url: 'http://127.0.0.1:1'},
          registry: {canonical: 'oci://registry.example.test/acme/canonical', worker: 'cas://local/worker'},
        };
        const profileBytes = new TextEncoder().encode(canonicalJson(profile));
        const profileDigest = yield* putCasBytes(cas, profileBytes);
        const enrollment = {...initial.enrollment, profile: `cas://${profileDigest}`};
        yield* writePrivateJsonFile(path.join(repository, '.threadnote', 'graph-share.json'), enrollment);
        yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: publisher.agentContextHome});
        registry.state.outage = true;
        const pending = yield* bootstrapCommand({cas, cwd: repository});
        expect(pending.publication.status).toBe('pending');
        expect(messages.at(-1)).toContain('pending');
        expect(messages.at(-1)).not.toMatch(/^Published/u);
        yield* registry.provide(runGraphPublisherServeCommand(publisher, {cas, cwd: repository})).pipe(
          Effect.provideService(Console.Console, {
            ...parentConsole,
            log: (...args) => {
              messages.push(args.join(' '));
            },
          }),
        );
        expect(messages.at(-1)).toContain('pending');
        expect(messages.at(-1)).not.toMatch(/^Published/u);
        const requestsBeforeStatus = registry.requests.length;
        const pendingStatus = yield* readGraphPublisherRegistryStatus(publisher, {cas, cwd: repository});
        expect(pendingStatus).toMatchObject({localCandidate: {generation: 1}, publication: {status: 'pending'}});
        expect(pendingStatus.publication?.acknowledged).toBeUndefined();
        expect(registry.requests).toHaveLength(requestsBeforeStatus);
        registry.state.outage = false;
        yield* Effect.sleep(17_100);
        const base = yield* bootstrapCommand({cas, cwd: repository});
        expect(messages.at(-1)).toMatch(/^Published generation 1/u);
        expect(base.publication.status).toBe('acknowledged');
        const firstIdentity = yield* resolveRepositoryIdentity(repository);
        yield* fs.writeFileString(path.join(repository, 'next.ts'), 'export const next = 2;\n');
        yield* git(['add', '.']);
        yield* commit('advance');
        yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: publisher.agentContextHome});
        const advanced = yield* registry.provide(
          advanceGraphPublisherFrontier(publisher, {cas, cwd: repository, forceFreeze: true}),
        );
        expect(advanced.publication.status).toBe('acknowledged');
        expect(advanced.published).toBe(true);
        const writesBeforeBootstrapRetry = registry.requests.filter(request => request.method === 'PUT').length;
        const bootstrappedAgain = yield* bootstrapCommand({cas, cwd: repository});
        expect(messages.at(-1)).toMatch(/^Published generation 2/u);
        expect(yield* readGraphPublisherRegistryStatus(publisher, {cas, cwd: repository})).toMatchObject({
          localCandidate: {generation: 2},
          publication: {status: 'acknowledged', acknowledged: {generation: 2}},
        });
        expect(bootstrappedAgain.generation).toBe(2);
        expect(bootstrappedAgain.manifestDigest).toBe(advanced.manifestDigest);
        expect(registry.requests.filter(request => request.method === 'PUT')).toHaveLength(writesBeforeBootstrapRetry);
        const frontier = parseGraphShareFrontierManifest(
          yield* decodeJsonBytes(yield* readVerifiedCasBlob(cas, advanced.manifestDigest)),
        );
        expect(frontier.deltas).toHaveLength(1);
        const unrelated = yield* putCasBytes(cas, new TextEncoder().encode('unrelated CAS object must stay local'));
        const publicationInput = {
          casRoot: cas,
          checkpointCount: 3,
          pointer: {
            manifestDigest: advanced.manifestDigest,
            envelopeDigest: advanced.envelopeDigest,
            schemaVersion: 1 as const,
          },
          scope: {
            repositoryId: enrollment.repositoryId,
            profileDigest,
            publisherKeyFingerprint: parseSha256Digest(enrollment.publisherKeyFingerprint),
            branch: 'refs/heads/main',
          },
        };
        const publication = yield* collectGraphShareRegistryPublication(publicationInput);
        expect(publication.historyFloor.generation).toBe(1);
        expect(publication.frontier.generation).toBe(2);
        expect(publication.retention.entries.some(entry => entry.digest === unrelated)).toBe(false);
        expect(publication.descriptorDigest).toBe(advanced.descriptorDigest);
        const tag = graphShareFrontierDiscoveryTag(enrollment.repositoryId, 'refs/heads/main');
        expect(advanced.descriptorDigest).toBeDefined();
        expect(registry.manifests.has(tag)).toBe(true);
        const requiredChunks: string[] = [];
        for (const artifact of [frontier.checkpoint, ...frontier.deltas]) {
          expect(artifact.metadataDigest).toBeDefined();
          const metadata = parseGraphShareCheckpointMetadata(
            yield* decodeJsonBytes(yield* readVerifiedCasBlob(cas, artifact.metadataDigest!)),
          );
          requiredChunks.push(metadata.prefixDigest, ...metadata.chunks.map(chunk => chunk.digest));
          expect(registry.blobs.has(artifact.manifestDigest)).toBe(false);
        }
        for (const [label, expectedGeneration, deltaCount] of [
          ['current', 2, 1],
          ['older', 1, 0],
        ] as const) {
          if (label === 'older') yield* git(['checkout', '--detach', firstIdentity.headCommit]);
          const home = path.join(root, label);
          const clientCas = path.join(root, `${label}-cas`);
          yield* putCasBytes(clientCas, profileBytes);
          yield* runGraphShareJoin(config(home), {cas: clientCas, cwd: repository, readOnly: true});
          expect(yield* fs.readDirectory(path.join(clientCas, 'sha256'))).toHaveLength(1);
          const identity = yield* resolveRepositoryIdentity(repository);
          const imported = yield* registry.provide(
            maybeImportSharedGraphBase({cwd: repository, identity, threadnoteHome: home}),
          );
          expect(imported).toMatchObject({
            imported: true,
            atGeneration: expectedGeneration,
            checkpointDigest: base.checkpointDigest,
          });
          expect(yield* readSharedGraphProvenance(home, identity.checkoutId)).toMatchObject({deltaCount});
          expect(
            yield* readAcceptedGraphShareFrontier(home, {
              repositoryId: enrollment.repositoryId,
              profileDigest,
              publisherKeyFingerprint: parseSha256Digest(enrollment.publisherKeyFingerprint),
              branch: 'refs/heads/main',
            }),
          ).toMatchObject({generation: 2});
        }
        expect(requiredChunks.length).toBeGreaterThan(2);
        for (const digest of requiredChunks) {
          expect(registry.requests).toContainEqual({method: 'GET', pathname: `/v2/acme/canonical/blobs/${digest}`});
          expect(publication.retention.entries.some(entry => entry.digest === digest)).toBe(true);
        }
        yield* fs.remove(path.join(cas, 'sha256', requiredChunks[0].slice('sha256:'.length)));
        const beforeFailure = yield* fs.readDirectory(path.join(cas, 'sha256'));
        expect(yield* Effect.result(collectGraphShareRegistryPublication(publicationInput))).toMatchObject({
          failure: {kind: 'unavailable'},
        });
        expect(yield* fs.readDirectory(path.join(cas, 'sha256'))).toEqual(beforeFailure);
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  180_000,
);

function config(home: string) {
  return {
    account: 'local' as const,
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user: 'local',
  };
}
