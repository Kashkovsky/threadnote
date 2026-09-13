import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {codeGraphCheckpointAbiInputV1} from '../../src/code_graph/checkpoint/compatibility.js';
import {codeGraphCheckpointAbiDigestV1} from '../../src/code_graph/checkpoint/pack.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {putCasBytes, readVerifiedCasBlob} from '../../src/code_graph/sharing/cas.js';
import {decodeJsonBytes, readJsonFile, writePrivateJsonFile} from '../../src/code_graph/sharing/atomic.js';
import {loadGraphShareCoordinatorState} from '../../src/code_graph/sharing/control_server.js';
import {
  graphWorkerAdmissionStatePath,
  readGraphWorkerAdmissionStore,
} from '../../src/code_graph/sharing/control_result_admission.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {graphShareEnrollmentPath, graphSharingLayout} from '../../src/code_graph/sharing/layout.js';
import {
  casProfilePointer,
  parseGraphShareEnrollment,
  parseGraphShareProfile,
  parseGraphShareProfilePointer,
} from '../../src/code_graph/sharing/profile.js';
import {advanceGraphPublisherFrontier} from '../../src/code_graph/sharing/publisher_cycle.js';
import {runGraphPublisherBootstrap, runGraphShareInit} from '../../src/code_graph/sharing/publisher.js';
import {announceGraphShareResult} from '../../src/code_graph/sharing/receipts.js';
import {
  admitGraphWorkerAnnouncement,
  emptyGraphWorkerAdmissionStore,
} from '../../src/code_graph/sharing/worker_admission_state.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

describe('signed worker publisher', () => {
  effectIt.effect(
    'ignores legacy, quarantined, and revoked receipts for an OCI-worker profile',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-signed-publisher-'});
          const repository = path.join(root, 'repository');
          const cas = path.join(root, 'cas');
          const home = path.join(root, 'home');
          const policyFile = path.join(root, 'policy.json');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.writeFileString(
            path.join(repository, 'package.json'),
            '{"name":"signed-publisher-test","private":true,"type":"module"}\n',
          );
          yield* fs.writeFileString(path.join(repository, 'src', 'index.ts'), 'export const original = 1;\n');
          yield* git(repository, ['init', '-q', '--initial-branch=main']);
          yield* git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/signed-publisher-test.git']);
          yield* git(repository, ['add', '.']);
          yield* commit(repository, 'base');
          yield* runGraphShareInit(config(home), {cas, cwd: repository, organization: 'acme', writeConfig: true});
          const enrollmentPath = graphShareEnrollmentPath(path, repository);
          const enrollment = parseGraphShareEnrollment(yield* readJsonFile(enrollmentPath));
          const original = parseGraphShareProfile(
            yield* decodeJsonBytes(
              yield* readVerifiedCasBlob(cas, parseGraphShareProfilePointer(enrollment.profile).digest),
            ),
          );
          const profile = {...original, registry: {...original.registry, worker: 'oci://registry.example/acme/work'}};
          const profileDigest = yield* putCasBytes(cas, new TextEncoder().encode(canonicalJson(profile)));
          yield* writePrivateJsonFile(enrollmentPath, {...enrollment, profile: casProfilePointer(profileDigest)});
          yield* git(repository, ['add', '.threadnote/graph-share.json']);
          yield* commit(repository, 'enroll');
          const identity = yield* resolveRepositoryIdentity(repository);
          const policy = {
            audience: 'https://graph.example',
            grants: [],
            issuer: 'https://auth.example',
            jwksUrl: 'https://auth.example/.well-known/jwks.json',
            organization: 'acme',
            profileDigest,
            repositoryId: identity.repositoryId,
            schemaVersion: 1 as const,
          };
          yield* writePrivateJsonFile(policyFile, policy);
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: repository, ensureVectors: false, force: true, threadnoteHome: home});
          yield* runGraphPublisherBootstrap(config(home), {cas, cwd: repository});
          yield* fs.writeFileString(path.join(repository, 'src', 'next.ts'), 'export const next = 2;\n');
          yield* git(repository, ['add', 'src/next.ts']);
          yield* commit(repository, 'advance');
          const nextIdentity = yield* resolveRepositoryIdentity(repository);
          const source = yield* indexer.index({
            cwd: repository,
            ensureVectors: false,
            force: true,
            includeOverlay: false,
            sourceOnly: true,
            threadnoteHome: home,
          });
          const store = yield* CodeGraphStore;
          const graphLayout = codeGraphLayout(path, home, nextIdentity.checkoutId, nextIdentity.worktreeId);
          const packs = yield* store.snapshotPackProvenance(graphLayout.databasePath, source.snapshot.id);
          expect(packs).toBeDefined();
          const targetAbi = codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(packs!)).digest;
          const coordinatorOptions = {organization: 'acme', repositoryId: identity.repositoryId, threadnoteHome: home};
          const coordinator = yield* loadGraphShareCoordinatorState(coordinatorOptions);
          const receipts = announceGraphShareResult(coordinator.receipts, {
            actionKey: 'a'.repeat(64),
            attestationDigest: sha256Digest('legacy-attestation'),
            batchId: nextIdentity.headCommit,
            resultManifestDigest: sha256Digest('untrusted-legacy-result'),
            semanticDigest: sha256Digest('legacy-semantic'),
          }).store;
          yield* writePrivateJsonFile(graphSharingLayout(path, home).coordinatorStatePath, {...coordinator, receipts});
          const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
          const worker = {
            expiresAt: nowSeconds + 3600,
            graphAbi: targetAbi,
            principalId: sha256Digest('revoked-principal'),
            profileDigest,
            repositoryId: identity.repositoryId,
            signingPublicKey: 'f'.repeat(64),
            workerId: `gw_${'1'.repeat(32)}`,
          };
          const signed = [
            signedAnnouncement(1, '1'.repeat(64), nextIdentity.headCommit, worker),
            signedAnnouncement(2, '1'.repeat(64), nextIdentity.headCommit, worker),
            signedAnnouncement(3, '2'.repeat(64), nextIdentity.headCommit, worker),
          ];
          const admissions = signed.reduce(
            (store, announcement) =>
              admitGraphWorkerAnnouncement(store, {
                announcement,
                authority: worker,
                nowSeconds,
                sourceCommit: nextIdentity.headCommit,
              }).store,
            emptyGraphWorkerAdmissionStore(),
          );
          expect(admissions.quarantine).toHaveLength(1);
          const admissionPath = yield* graphWorkerAdmissionStatePath(home, policy);
          yield* fs.makeDirectory(path.dirname(admissionPath), {recursive: true});
          yield* writePrivateJsonFile(admissionPath, admissions);
          const result = yield* advanceGraphPublisherFrontier(config(home), {
            authorizationPolicy: policyFile,
            cas,
            cwd: repository,
            forceFreeze: true,
          });
          expect(result.published).toBe(true);
          expect(result.contributionEvidence?.selectedResults).toBe(0);
          expect(result.contributionEvidence?.verifiedResults).toBe(0);
          expect(result.sourceCommit).toBe(nextIdentity.headCommit);
          expect((yield* readGraphWorkerAdmissionStore(home, policy)).receipts).toHaveLength(0);
          yield* writePrivateJsonFile(admissionPath, admissions);
          const reconciled = yield* advanceGraphPublisherFrontier(config(home), {
            authorizationPolicy: policyFile,
            cas,
            cwd: repository,
            forceFreeze: true,
          });
          expect(reconciled.published).toBe(false);
          expect(reconciled.manifestDigest).toBe(result.manifestDigest);
          expect((yield* readGraphWorkerAdmissionStore(home, policy)).receipts).toHaveLength(0);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    180_000,
  );
});

const config = (agentContextHome: string) => ({agentContextHome}) as Parameters<typeof runGraphShareInit>[0];
const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', args, {cwd}).pipe(Effect.asVoid);
const commit = (cwd: string, message: string) =>
  git(cwd, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', message]);

function signedAnnouncement(
  seed: number,
  actionKey: string,
  sourceCommit: string,
  worker: {
    readonly principalId: string;
    readonly profileDigest: string;
    readonly repositoryId: string;
    readonly signingPublicKey: string;
    readonly workerId: string;
  },
) {
  const fields = {
    actionKey,
    attestationDigest: sha256Digest(`attestation-${seed}`),
    batchId: sourceCommit.slice(0, 40),
    principalId: worker.principalId,
    profileDigest: worker.profileDigest,
    repositoryId: worker.repositoryId,
    resultManifestDigest: sha256Digest(`result-${seed}`),
    semanticDigest: sha256Digest(`semantic-${seed}`),
    workerId: worker.workerId,
  };
  return {
    algorithm: 'ed25519' as const,
    body: {
      ...fields,
      idempotencyKey: sha256Digest('threadnote.graph.worker.result-operation.v1\0' + canonicalJson(fields)),
    },
    publicKey: worker.signingPublicKey,
    schemaVersion: 1 as const,
    signature: seed.toString(16).padStart(128, '0'),
  };
}
