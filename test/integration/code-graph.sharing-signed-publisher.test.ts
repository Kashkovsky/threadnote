import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest';
import {exportJWK, generateKeyPair, SignJWT} from 'jose';
import {graphRegistryFixture} from '../helpers/graph-registry.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {codeGraphCheckpointAbiInputV1} from '../../src/code_graph/checkpoint/compatibility.js';
import {codeGraphCheckpointAbiDigestV1} from '../../src/code_graph/checkpoint/pack.js';
import {graphShareLanguageAndRole, graphShareParseActionKey} from '../../src/code_graph/sharing/action.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {maybeImportSharedGraphBase, runGraphShareJoin} from '../../src/code_graph/sharing/client.js';
import {putCasBytes, readVerifiedCasBlob} from '../../src/code_graph/sharing/cas.js';
import {decodeJsonBytes, readJsonFile, writePrivateJsonFile} from '../../src/code_graph/sharing/atomic.js';
import {loadGraphShareCoordinatorState} from '../../src/code_graph/sharing/control_server.js';
import {enrollGraphControlWorker} from '../../src/code_graph/sharing/control_enrollment.js';
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
import {
  runGraphPublisherBootstrap,
  runGraphPublisherListen,
  runGraphShareInit,
} from '../../src/code_graph/sharing/publisher.js';
import {
  graphShareParseResultArtifact,
  type GraphShareParseResultV1,
} from '../../src/code_graph/sharing/parse_result.js';
import {announceGraphShareResult} from '../../src/code_graph/sharing/receipts.js';
import {signGraphWorkerResultAnnouncement} from '../../src/code_graph/sharing/worker_announcement.js';
import {createGraphWorkerResultArtifact} from '../../src/code_graph/sharing/worker_result.js';
import {makeGraphWorkerSigner} from '../../src/code_graph/sharing/worker_signing.js';
import {
  admitGraphWorkerAnnouncement,
  emptyGraphWorkerAdmissionStore,
} from '../../src/code_graph/sharing/worker_admission_state.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

describe('signed worker publisher', () => {
  effectIt.effect(
    'admits signed results through the authenticated publisher listener and source-verifies canonical publication',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const registry = yield* graphRegistryFixture();
          const indexer = yield* CodeGraphIndexer;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-signed-publisher-valid-'});
          const repository = path.join(root, 'repository');
          const contributor = path.join(root, 'contributor');
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
          const profile = parseGraphShareProfile({
            ...original,
            registry: {
              canonical: 'oci://registry.example.test/acme/canonical',
              worker: 'oci://registry.example.test/acme/worker',
            },
          });
          const profileDigest = yield* putCasBytes(cas, new TextEncoder().encode(canonicalJson(profile)));
          yield* writePrivateJsonFile(enrollmentPath, {...enrollment, profile: casProfilePointer(profileDigest)});
          yield* git(repository, ['add', '.threadnote/graph-share.json']);
          yield* commit(repository, 'enroll');
          const identity = yield* resolveRepositoryIdentity(repository);
          const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
          const policy = {
            audience: 'https://graph.example',
            grants: [{expiresAt: nowSeconds + 3600, scopes: ['graph:contribute' as const], subject: 'test-worker'}],
            issuer: 'https://auth.example.test/',
            jwksUrl: 'https://auth.example.test/.well-known/jwks.json',
            organization: 'acme',
            profileDigest,
            repositoryId: identity.repositoryId,
            schemaVersion: 1 as const,
          };
          yield* writePrivateJsonFile(policyFile, policy);
          const signer = yield* makeGraphWorkerSigner(home, sha256Digest('test credential identity'));
          const worker = yield* enrollGraphControlWorker({
            home,
            initialPolicy: policy,
            principal: {
              expiresAt: nowSeconds + 3600,
              issuer: policy.issuer,
              scopes: new Set(['graph:contribute']),
              subject: 'test-worker',
            },
            readCurrentPolicy: Effect.succeed(policy),
            request: {
              idempotencyKey: 'signed-publisher-valid',
              profileDigest,
              repositoryId: identity.repositoryId,
              signingPublicKey: signer.publicKey,
            },
          });
          yield* indexer.index({cwd: repository, ensureVectors: false, force: true, threadnoteHome: home});
          yield* registry.provide(runGraphPublisherBootstrap(config(home), {cas, cwd: repository}));
          yield* git(root, ['clone', '-q', repository, contributor]);
          yield* git(contributor, ['remote', 'set-url', 'origin', 'https://github.com/acme/signed-publisher-test.git']);
          yield* fs.writeFileString(path.join(contributor, 'src', 'next.ts'), 'export const next = 2;\n');
          yield* git(contributor, ['add', 'src/next.ts']);
          yield* commit(contributor, 'advance');
          const nextIdentity = yield* resolveRepositoryIdentity(contributor);
          let parsed: GraphShareParseResultV1 | undefined;
          const source = yield* indexer.index({
            cwd: contributor,
            ensureVectors: false,
            force: true,
            includeOverlay: false,
            sourceOnly: true,
            sourceVerification: {
              observeParserBatch: group =>
                Effect.sync(() => {
                  const file = group.files.find(item => item.path === 'src/next.ts');
                  const facts = group.facts.find(item => item.facts.path === file?.path);
                  if (file === undefined || facts === undefined) return;
                  const action = {
                    contentHash: file.contentHash,
                    extractorSet: group.cacheIdentity,
                    languageAndRole: graphShareLanguageAndRole(file.language, 'source'),
                    normalizedPath: file.path,
                    repositoryId: identity.repositoryId,
                  };
                  parsed = graphShareParseResultArtifact({
                    ...action,
                    actionKey: graphShareParseActionKey(action),
                    facts: facts.facts,
                    gitBlobId: file.blobId,
                  });
                }),
              materializeFacts: batch => Effect.succeed(batch.facts),
            },
            threadnoteHome: home,
          });
          if (parsed === undefined) return yield* Effect.die('Fresh source parser result was not captured');
          const graphLayout = codeGraphLayout(path, home, nextIdentity.checkoutId, nextIdentity.worktreeId);
          const packs = yield* store.snapshotPackProvenance(graphLayout.databasePath, source.snapshot.id);
          if (packs === undefined) return yield* Effect.die('Fresh source pack provenance is unavailable');
          const targetAbi = codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(packs)).digest;
          const authority = {
            expiresAt: worker.body.expiresAt,
            graphAbi: targetAbi,
            principalId: worker.body.principalId,
            profileDigest,
            repositoryId: identity.repositoryId,
            signingPublicKey: signer.publicKey,
            workerId: worker.body.workerId,
          };
          const artifact = yield* createGraphWorkerResultArtifact({
            metadata: {
              batchId: nextIdentity.headCommit.slice(0, 40),
              graphAbi: targetAbi,
              identityClass: 'oauth-principal',
              issuedAt: nowSeconds,
              partialCoverage: false,
              platform: {architecture: 'x64', os: 'linux'},
              principalId: authority.principalId,
              profileDigest,
              releaseIdentity: '4.6.11-local.gsynthetic',
              repositoryId: identity.repositoryId,
              resourceLimits: [],
              sourceCommit: nextIdentity.headCommit,
              workerId: authority.workerId,
            },
            resultBytes: new TextEncoder().encode(canonicalJson(parsed)),
            signer,
          });
          const announcement = yield* signGraphWorkerResultAnnouncement({artifact, expected: authority, signer});
          const absentAction = {
            contentHash: 'f'.repeat(64),
            extractorSet: parsed.extractorSet,
            languageAndRole: 'typescript:source',
            normalizedPath: 'src/absent.ts',
            repositoryId: identity.repositoryId,
          };
          const absentParsed = graphShareParseResultArtifact({
            ...absentAction,
            actionKey: graphShareParseActionKey(absentAction),
            facts: {path: absentAction.normalizedPath, diagnostics: [], edges: [], symbols: []},
            gitBlobId: 'f'.repeat(40),
          });
          const absentArtifact = yield* createGraphWorkerResultArtifact({
            metadata: {
              batchId: nextIdentity.headCommit.slice(0, 40),
              graphAbi: targetAbi,
              identityClass: 'oauth-principal',
              issuedAt: nowSeconds,
              partialCoverage: false,
              platform: {architecture: 'x64', os: 'linux'},
              principalId: authority.principalId,
              profileDigest,
              releaseIdentity: '4.6.11-local.gsynthetic',
              repositoryId: identity.repositoryId,
              resourceLimits: [],
              sourceCommit: nextIdentity.headCommit,
              workerId: authority.workerId,
            },
            resultBytes: new TextEncoder().encode(canonicalJson(absentParsed)),
            signer,
          });
          const absentAnnouncement = yield* signGraphWorkerResultAnnouncement({
            artifact: absentArtifact,
            expected: authority,
            signer,
          });
          for (const item of [artifact, absentArtifact]) {
            registry.workerManifests.set(item.manifestDigest, item.manifestBytes);
            for (const bytes of [new TextEncoder().encode('{}'), item.resultBytes, item.attestationBytes])
              registry.workerBlobs.set(sha256Digest(bytes), bytes);
          }
          const jwtKey = yield* Effect.promise(() => generateKeyPair('RS256'));
          const jwk = {...(yield* Effect.promise(() => exportJWK(jwtKey.publicKey))), alg: 'RS256', kid: 'fixture'};
          const nativeFetch = globalThis.fetch;
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
                String(input) === policy.jwksUrl
                  ? Promise.resolve(new Response(JSON.stringify({keys: [jwk]}), {status: 200}))
                  : nativeFetch(input, init)) as typeof globalThis.fetch;
            }),
            () => Effect.sync(() => { globalThis.fetch = nativeFetch; }),
          );
          const token = yield* Effect.promise(() =>
            new SignJWT({scope: 'graph:contribute'})
              .setProtectedHeader({alg: 'RS256', kid: 'fixture'})
              .setIssuer(policy.issuer)
              .setAudience(policy.audience)
              .setSubject('test-worker')
              .setIssuedAt(nowSeconds)
              .setExpirationTime(nowSeconds + 600)
              .sign(jwtKey.privateKey),
          );
          const ready = yield* Deferred.make<string>();
          const holdWatch = yield* Deferred.make<void>();
          const listener = yield* Effect.forkScoped(
            registry.provide(runGraphPublisherListen(config(home), {
              authorizationPolicy: policyFile,
              cas,
              cwd: repository,
              listen: '127.0.0.1:0',
              // The server is live before onReady completes; hold its watch until admissions are settled.
              onReady: output => Deferred.succeed(ready, output.coordinatorUrl).pipe(
                Effect.andThen(Deferred.await(holdWatch)),
              ),
            })),
          );
          const coordinatorUrl = yield* Deferred.await(ready);
          yield* git(repository, ['fetch', '-q', contributor, 'main']);
          yield* git(repository, ['merge', '-q', '--ff-only', 'FETCH_HEAD']);
          const post = (body: unknown, bearer = token) => Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient;
            const request = HttpClientRequest.post(`${coordinatorUrl}/v1/results`).pipe(
              HttpClientRequest.setHeaders({
                authorization: `Bearer ${bearer}`,
                'x-threadnote-profile-digest': profileDigest,
                'x-threadnote-repository-id': identity.repositoryId,
              }),
              request => HttpClientRequest.bodyUint8Array(
                request,
                new TextEncoder().encode(JSON.stringify(body)),
                'application/json',
              ),
            );
            const response = yield* client.execute(request);
            return {body: yield* response.json, status: response.status};
          });
          expect(yield* post(announcement, 'invalid')).toEqual({body: {error: 'unauthorized'}, status: 401});
          expect(yield* post(announcement)).toEqual({
            body: {idempotencyKey: announcement.body.idempotencyKey, status: 'accepted'},
            status: 201,
          });
          expect(yield* post(absentAnnouncement)).toEqual({
            body: {idempotencyKey: absentAnnouncement.body.idempotencyKey, status: 'accepted'},
            status: 201,
          });
          expect((yield* readGraphWorkerAdmissionStore(home, policy)).receipts).toHaveLength(2);
          yield* Fiber.interrupt(listener);
          const result = yield* registry.provide(advanceGraphPublisherFrontier(config(home), {
            authorizationPolicy: policyFile,
            cas,
            cwd: repository,
            forceFreeze: true,
          }));
          expect(result.published).toBe(true);
          expect(result.sourceCommit).toBe(nextIdentity.headCommit);
          expect(result.contributionEvidence).toMatchObject({
            selectedResults: 1,
            verifiedResults: 1,
            sourceUse: {consumedActions: 1, consumedResultManifestDigests: [artifact.manifestDigest]},
          });
          expect(registry.requests.some(request =>
            request.method === 'GET' && request.pathname === `/v2/acme/worker/manifests/${artifact.manifestDigest}`,
          )).toBe(true);
          expect(registry.manifests.size).toBeGreaterThan(0);
          expect((yield* readGraphWorkerAdmissionStore(home, policy)).receipts).toHaveLength(0);
          const clientRepo = path.join(root, 'client');
          const clientHome = path.join(root, 'client-home');
          const clientCas = path.join(root, 'client-cas');
          yield* git(root, ['clone', '-q', repository, clientRepo]);
          yield* git(clientRepo, ['remote', 'set-url', 'origin', 'https://github.com/acme/signed-publisher-test.git']);
          yield* putCasBytes(clientCas, new TextEncoder().encode(canonicalJson(profile)));
          yield* runGraphShareJoin(config(clientHome), {cas: clientCas, cwd: clientRepo, readOnly: true});
          const clientIdentity = yield* resolveRepositoryIdentity(clientRepo);
          const imported = yield* registry.provide(
            maybeImportSharedGraphBase({cwd: clientRepo, identity: clientIdentity, threadnoteHome: clientHome}),
          );
          expect(imported).toMatchObject({imported: true, atGeneration: result.generation});
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    180_000,
  );

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
          yield* writePrivateJsonFile(graphSharingLayout(path, home).coordinatorStatePath, coordinator);
          const reconciled = yield* advanceGraphPublisherFrontier(config(home), {
            authorizationPolicy: policyFile,
            cas,
            cwd: repository,
            forceFreeze: true,
          });
          expect(reconciled.published).toBe(false);
          expect(reconciled.manifestDigest).toBe(result.manifestDigest);
          expect((yield* readGraphWorkerAdmissionStore(home, policy)).receipts).toHaveLength(0);
          const latestCoordinator = yield* loadGraphShareCoordinatorState(coordinatorOptions);
          expect(latestCoordinator.machine.generation).toBe(result.generation);
          expect(latestCoordinator.machine.publishedFrontier).toBe(nextIdentity.headCommit);
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
