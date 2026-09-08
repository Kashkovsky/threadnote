import {expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient';
import {provideTestLayer} from '../helpers/effect-layer.js';
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
import {runGraphPublisherBootstrap, runGraphShareInit} from '../../src/code_graph/sharing/publisher.js';
import {advanceGraphPublisherFrontier} from '../../src/code_graph/sharing/publisher_cycle.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';

effectIt.effect(
  'imports cold checkpoint chunks, deltas and predecessors from OCI without coordinator artifacts',
  () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const indexer = yield* CodeGraphIndexer;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-sharing-oci-'});
        const repository = path.join(root, 'repository');
        const cas = path.join(root, 'publisher-cas');
        const publisher = config(path.join(root, 'publisher'));
        const dockerConfig = path.join(root, 'docker');
        yield* fs.makeDirectory(repository);
        yield* fs.makeDirectory(dockerConfig);
        yield* fs.writeFileString(path.join(dockerConfig, 'config.json'), '{}');
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
        const base = yield* runGraphPublisherBootstrap(publisher, {cas, cwd: repository});
        const firstIdentity = yield* resolveRepositoryIdentity(repository);
        yield* fs.writeFileString(path.join(repository, 'next.ts'), 'export const next = 2;\n');
        yield* git(['add', '.']);
        yield* commit('advance');
        yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: publisher.agentContextHome});
        const advanced = yield* advanceGraphPublisherFrontier(publisher, {cas, cwd: repository, forceFreeze: true});
        expect(advanced.published).toBe(true);
        const frontier = parseGraphShareFrontierManifest(
          yield* decodeJsonBytes(yield* readVerifiedCasBlob(cas, advanced.manifestDigest)),
        );
        expect(frontier.deltas).toHaveLength(1);
        const tag = graphShareFrontierDiscoveryTag(enrollment.repositoryId, 'refs/heads/main');
        expect(advanced.descriptorDigest).toBeDefined();
        const descriptor = yield* readVerifiedCasBlob(cas, advanced.descriptorDigest!);
        const blobs = new Map<string, Uint8Array>();
        for (const name of yield* fs.readDirectory(path.join(cas, 'sha256'))) {
          blobs.set(`sha256:${name}`, yield* fs.readFile(path.join(cas, 'sha256', name)));
        }
        const requiredChunks: string[] = [];
        for (const artifact of [frontier.checkpoint, ...frontier.deltas]) {
          expect(artifact.metadataDigest).toBeDefined();
          const metadata = parseGraphShareCheckpointMetadata(
            yield* decodeJsonBytes(yield* readVerifiedCasBlob(cas, artifact.metadataDigest!)),
          );
          requiredChunks.push(metadata.prefixDigest, ...metadata.chunks.map(chunk => chunk.digest));
          blobs.delete(artifact.manifestDigest);
        }
        const requests: string[] = [];
        const fetch = Object.assign(
          async (input: string | URL | Request) => {
            const url = new URL(String(input));
            requests.push(url.href);
            expect(url.origin).toBe('https://registry.example.test');
            const manifestPath = `/v2/acme/canonical/manifests/${tag}`;
            if (url.pathname === manifestPath) {
              return new Response(Uint8Array.from(descriptor), {
                headers: {'content-type': 'application/vnd.oci.image.manifest.v1+json'},
              });
            }
            expect(url.pathname).toMatch(/^\/v2\/acme\/canonical\/blobs\/sha256:[0-9a-f]{64}$/u);
            const bytes = blobs.get(url.pathname.slice('/v2/acme/canonical/blobs/'.length));
            return bytes === undefined ? new Response(null, {status: 404}) : new Response(Uint8Array.from(bytes));
          },
          {preconnect: () => undefined},
        ) as typeof globalThis.fetch;
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
          const imported = yield* maybeImportSharedGraphBase({cwd: repository, identity, threadnoteHome: home}).pipe(
            Effect.provideService(FetchHttpClient.Fetch, fetch),
            Effect.provideService(SystemInfo, {...system, environment: () => ({DOCKER_CONFIG: dockerConfig})}),
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
          expect(requests).toContain(`https://registry.example.test/v2/acme/canonical/blobs/${digest}`);
        }
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
