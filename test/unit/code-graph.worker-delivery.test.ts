import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Path} from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {putCasBytes} from '../../src/code_graph/sharing/cas.js';
import {graphShareParseActionKey} from '../../src/code_graph/sharing/action.js';
import {
  enqueuePersistedGraphShareContribution,
  readGraphShareContributionQueue,
} from '../../src/code_graph/sharing/contribution.js';
import {sha256Digest, sha256HexFromDigest} from '../../src/code_graph/sharing/digest.js';
import {graphSharingUnavailable} from '../../src/code_graph/sharing/errors.js';
import {graphSharingCasBlobPath} from '../../src/code_graph/sharing/layout.js';
import {graphShareParseResultArtifact} from '../../src/code_graph/sharing/parse_result.js';
import {
  acknowledgeGraphShareSignedCandidatePage,
  graphShareSignedCandidateIdentity,
  listGraphShareSignedCandidatePageIds,
  persistGraphShareSignedCandidates,
  readGraphShareSignedCandidatePage,
} from '../../src/code_graph/sharing/signed_candidate.js';
import {
  graphWorkerDeliveryScope,
  listGraphWorkerDeliveryPrincipalScopes,
  listGraphWorkerDeliveryOutboxOperations,
  markGraphWorkerDeliveryAdmitted,
  prepareGraphWorkerDeliveryOutbox,
  readGraphWorkerDeliveryOutboxOperation,
  retireExpiredPreparedGraphWorkerDeliveryOutbox,
  retireSupersededGraphWorkerDeliveryOutbox,
} from '../../src/code_graph/sharing/worker_delivery_outbox.js';
import {
  finishAdmittedGraphWorkerResult,
  reclaimExpiredGraphWorkerGenerations,
  submitPreparedGraphWorkerResult,
} from '../../src/code_graph/sharing/worker_delivery.js';
import {signGraphWorkerResultAnnouncement} from '../../src/code_graph/sharing/worker_announcement.js';
import {createGraphWorkerResultArtifact} from '../../src/code_graph/sharing/worker_result.js';
import {makeGraphWorkerSigner} from '../../src/code_graph/sharing/worker_signing.js';
import {
  advanceGraphWorkerCandidateScan,
  nextGraphWorkerCandidateScan,
} from '../../src/code_graph/sharing/worker_candidate_scan.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const layer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));
const encode = (value: unknown) => new TextEncoder().encode(canonicalJson(value));

const fixture = Effect.fn('test.workerDelivery.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-worker-delivery-'});
  const signer = yield* makeGraphWorkerSigner(home, sha256Digest('credential identity'));
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const sourceCommit = '1'.repeat(40);
  const repositoryId = 'c'.repeat(64);
  const action = {
    contentHash: 'a'.repeat(64),
    extractorSet: 'b'.repeat(64),
    languageAndRole: 'typescript:source',
    normalizedPath: 'src/index.ts',
    repositoryId,
  };
  const result = graphShareParseResultArtifact({
    ...action,
    actionKey: graphShareParseActionKey(action),
    gitBlobId: 'd'.repeat(40),
    facts: {path: action.normalizedPath, diagnostics: [], edges: [], symbols: []},
  });
  const resultBytes = encode(result);
  const resultDigest = sha256Digest(resultBytes);
  yield* putCasBytes(`${home}/cas`, resultBytes);
  const profileDigest = sha256Digest('profile');
  const authority = {
    expiresAt: now + 3600,
    graphAbi: 'e'.repeat(64),
    principalId: sha256Digest('first principal'),
    profileDigest,
    repositoryId,
    signingPublicKey: signer.publicKey,
    workerId: 'gw_' + 'f'.repeat(32),
  };
  const candidate = {
    actionKey: result.actionKey,
    batchId: sourceCommit,
    casRoot: `${home}/cas`,
    extractorSet: action.extractorSet,
    graphAbi: authority.graphAbi,
    organization: 'threadnote',
    partialCoverage: false,
    platform: {architecture: 'x64' as const, os: 'linux' as const},
    profileDigest,
    queuedAtMilliseconds: now * 1000,
    releaseIdentity: '4.6.11-local.gfixture',
    resourceLimits: [],
    resultDigest,
    resultSize: resultBytes.byteLength,
    semanticDigest: result.semanticDigest,
    snapshotId: `cgsn_${'2'.repeat(40)}`,
    sourceCommit,
  };
  yield* persistGraphShareSignedCandidates(home, repositoryId, [candidate]);
  const [candidatePageId] = yield* listGraphShareSignedCandidatePageIds(home, repositoryId);
  const selfAttestation = sha256Digest(
    canonicalJson({kind: 'contributor-self', payloadDigest: resultDigest, schemaVersion: 1}),
  );
  yield* enqueuePersistedGraphShareContribution(
    home,
    repositoryId,
    'join',
    {
      actionKey: result.actionKey,
      attestationDigest: selfAttestation,
      batchId: sourceCommit,
      resultManifestDigest: resultDigest,
      semanticDigest: result.semanticDigest,
    },
    'passive',
  );
  const artifact = yield* createGraphWorkerResultArtifact({
    metadata: {
      batchId: sourceCommit,
      graphAbi: authority.graphAbi,
      identityClass: 'oauth-principal',
      issuedAt: now,
      partialCoverage: false,
      platform: candidate.platform,
      principalId: authority.principalId,
      profileDigest,
      releaseIdentity: candidate.releaseIdentity,
      repositoryId,
      resourceLimits: [],
      sourceCommit,
      workerId: authority.workerId,
    },
    resultBytes,
    signer,
  });
  const announcement = yield* signGraphWorkerResultAnnouncement({artifact, expected: authority, signer});
  const prepared = yield* prepareGraphWorkerDeliveryOutbox({
    announcement,
    artifact,
    authority,
    candidate,
    candidatePageId,
    repositoryId,
    threadnoteHome: home,
  });
  const scope = graphWorkerDeliveryScope(authority, candidate.organization);
  return {artifact, authority, candidate, candidatePageId, home, prepared, repositoryId, resultBytes, scope, signer};
});

type Fixture = Effect.Success<ReturnType<typeof fixture>>;

const prepareGeneration = Effect.fn('test.workerDelivery.prepareGeneration')(function* (f: Fixture, workerId: string) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const authority = {...f.authority, expiresAt: now + 3600, workerId};
  const artifact = yield* createGraphWorkerResultArtifact({
    metadata: {
      batchId: f.candidate.batchId,
      graphAbi: authority.graphAbi,
      identityClass: 'oauth-principal',
      issuedAt: now,
      partialCoverage: false,
      platform: f.candidate.platform,
      principalId: authority.principalId,
      profileDigest: authority.profileDigest,
      releaseIdentity: f.candidate.releaseIdentity,
      repositoryId: authority.repositoryId,
      resourceLimits: [],
      sourceCommit: f.candidate.sourceCommit,
      workerId,
    },
    resultBytes: f.resultBytes,
    signer: f.signer,
  });
  const announcement = yield* signGraphWorkerResultAnnouncement({artifact, expected: authority, signer: f.signer});
  return yield* prepareGraphWorkerDeliveryOutbox({
    announcement,
    artifact,
    authority,
    candidate: f.candidate,
    candidatePageId: f.candidatePageId,
    repositoryId: f.repositoryId,
    threadnoteHome: f.home,
  });
});

describe('automatic signed graph worker delivery', () => {
  effectIt.effect('preserves exact prepared bytes on outage and retires only after echoed admission and page ACK', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        let uploaded = 0;
        const request = {repositoryId: f.repositoryId, threadnoteHome: f.home};
        const first = yield* submitPreparedGraphWorkerResult(request, f.scope, f.prepared.operation, {
          isAuthorized: Effect.succeed(true),
          upload: Effect.sync(() => {
            uploaded += 1;
          }),
          announce: Effect.fail(graphSharingUnavailable('Coordinator unavailable.')),
        }).pipe(Effect.result);
        expect(first._tag).toBe('Failure');
        expect(uploaded).toBe(1);
        const restarted = yield* readGraphWorkerDeliveryOutboxOperation(
          f.home,
          f.scope,
          f.prepared.operation.operationId,
        );
        expect(restarted?.operation.state).toBe('prepared');
        expect(restarted?.artifact).toEqual(f.artifact);
        expect(
          (yield* readGraphShareSignedCandidatePage(f.home, f.repositoryId, f.candidatePageId))?.candidates,
        ).toHaveLength(1);
        expect((yield* readGraphShareContributionQueue(f.home, f.repositoryId, 'passive')).announcements).toHaveLength(
          1,
        );
        yield* submitPreparedGraphWorkerResult(request, f.scope, restarted!.operation, {
          isAuthorized: Effect.succeed(true),
          upload: Effect.sync(() => {
            uploaded += 1;
          }),
          announce: Effect.succeed({
            status: 201,
            body: {idempotencyKey: restarted!.operation.operationId, status: 'accepted'},
          }),
        });
        expect(uploaded).toBe(2);
        expect(yield* listGraphShareSignedCandidatePageIds(f.home, f.repositoryId)).toEqual([]);
        expect((yield* readGraphShareContributionQueue(f.home, f.repositoryId, 'passive')).announcements).toEqual([]);
        expect(yield* listGraphWorkerDeliveryOutboxOperations(f.home, f.scope)).toEqual([]);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('does not enumerate or dispatch an old principal outbox after credentials switch', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const switched = {...f.scope, principalId: sha256Digest('second principal')};
        expect(yield* listGraphWorkerDeliveryOutboxOperations(f.home, switched)).toEqual([]);
        expect(yield* listGraphWorkerDeliveryPrincipalScopes(f.home, switched)).toEqual([switched]);
        expect(
          (yield* Effect.result(
            retireSupersededGraphWorkerDeliveryOutbox({
              admittedOperationId: f.prepared.operation.operationId,
              admittedScope: switched,
              candidateAbsent: true,
              candidateIdentity: f.prepared.operation.candidateIdentity,
              oldScope: f.scope,
              threadnoteHome: f.home,
            }),
          ))._tag,
        ).toBe('Failure');
        let uploaded = false;
        const denied = yield* submitPreparedGraphWorkerResult(
          {repositoryId: f.repositoryId, threadnoteHome: f.home},
          f.scope,
          f.prepared.operation,
          {
            isAuthorized: Effect.succeed(false),
            upload: Effect.sync(() => {
              uploaded = true;
            }),
            announce: Effect.succeed({
              status: 201,
              body: {idempotencyKey: f.prepared.operation.operationId, status: 'accepted'},
            }),
          },
        ).pipe(Effect.result);
        expect(denied._tag).toBe('Failure');
        expect(uploaded).toBe(false);
        expect((yield* listGraphWorkerDeliveryOutboxOperations(f.home, f.scope))[0].state).toBe('prepared');
        expect(
          (yield* readGraphShareSignedCandidatePage(f.home, f.repositoryId, f.candidatePageId))?.candidates,
        ).toHaveLength(1);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('keeps the candidate queued when admission returns a different operation ID', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const attempted = yield* submitPreparedGraphWorkerResult(
          {repositoryId: f.repositoryId, threadnoteHome: f.home},
          f.scope,
          f.prepared.operation,
          {
            isAuthorized: Effect.succeed(true),
            upload: Effect.void,
            announce: Effect.succeed({
              status: 201,
              body: {idempotencyKey: sha256Digest('different'), status: 'accepted'},
            }),
          },
        ).pipe(Effect.result);
        expect(attempted._tag).toBe('Failure');
        expect((yield* listGraphWorkerDeliveryOutboxOperations(f.home, f.scope))[0].state).toBe('prepared');
        expect(
          (yield* readGraphShareSignedCandidatePage(f.home, f.repositoryId, f.candidatePageId))?.candidates,
        ).toHaveLength(1);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('finds an exact candidate moved to a new page before retiring an admitted operation', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const identity = graphShareSignedCandidateIdentity(f.candidate);
        yield* acknowledgeGraphShareSignedCandidatePage(f.home, f.repositoryId, f.candidatePageId, new Set([identity]));
        const other = {...f.candidate, snapshotId: `cgsn_${'3'.repeat(40)}`};
        yield* persistGraphShareSignedCandidates(f.home, f.repositoryId, [f.candidate, other]);
        const [newPageId] = yield* listGraphShareSignedCandidatePageIds(f.home, f.repositoryId);
        expect(newPageId).not.toBe(f.candidatePageId);
        const admitted = yield* markGraphWorkerDeliveryAdmitted({
          scope: f.scope,
          candidateIdentity: identity,
          candidatePageId: f.candidatePageId,
          operationId: f.prepared.operation.operationId,
          response: {idempotencyKey: f.prepared.operation.operationId, status: 'accepted'},
          threadnoteHome: f.home,
        });
        yield* finishAdmittedGraphWorkerResult(
          {repositoryId: f.repositoryId, threadnoteHome: f.home},
          f.scope,
          admitted,
        );
        const [remainingPage] = yield* listGraphShareSignedCandidatePageIds(f.home, f.repositoryId);
        expect((yield* readGraphShareSignedCandidatePage(f.home, f.repositoryId, remainingPage))?.candidates).toEqual([
          other,
        ]);
        expect(yield* listGraphWorkerDeliveryOutboxOperations(f.home, f.scope)).toEqual([]);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('finishes a prior admitted worker after enrollment rotates its worker ID', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const newer = {...f.scope, workerId: 'gw_' + '9'.repeat(32)};
        expect((yield* listGraphWorkerDeliveryPrincipalScopes(f.home, newer)).map(scope => scope.workerId)).toContain(
          f.scope.workerId,
        );
        const admitted = yield* markGraphWorkerDeliveryAdmitted({
          scope: f.scope,
          candidateIdentity: f.prepared.operation.candidateIdentity,
          candidatePageId: f.candidatePageId,
          operationId: f.prepared.operation.operationId,
          response: {idempotencyKey: f.prepared.operation.operationId, status: 'accepted'},
          threadnoteHome: f.home,
        });
        yield* finishAdmittedGraphWorkerResult(
          {repositoryId: f.repositoryId, threadnoteHome: f.home},
          f.scope,
          admitted,
        );
        expect(yield* listGraphShareSignedCandidatePageIds(f.home, f.repositoryId)).toEqual([]);
        expect(yield* listGraphWorkerDeliveryOutboxOperations(f.home, f.scope)).toEqual([]);
        expect(yield* listGraphWorkerDeliveryPrincipalScopes(f.home, newer)).toEqual([newer]);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('retires an old prepared generation only after a newer same-candidate admission', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const authority = {...f.authority, workerId: 'gw_' + '9'.repeat(32)};
        const newer = yield* createGraphWorkerResultArtifact({
          metadata: {
            batchId: f.candidate.batchId,
            graphAbi: authority.graphAbi,
            identityClass: 'oauth-principal',
            issuedAt: Math.floor((yield* Clock.currentTimeMillis) / 1000),
            partialCoverage: false,
            platform: f.candidate.platform,
            principalId: authority.principalId,
            profileDigest: authority.profileDigest,
            releaseIdentity: f.candidate.releaseIdentity,
            repositoryId: authority.repositoryId,
            resourceLimits: [],
            sourceCommit: f.candidate.sourceCommit,
            workerId: authority.workerId,
          },
          resultBytes: f.resultBytes,
          signer: f.signer,
        });
        const announcement = yield* signGraphWorkerResultAnnouncement({
          artifact: newer,
          expected: authority,
          signer: f.signer,
        });
        const prepared = yield* prepareGraphWorkerDeliveryOutbox({
          announcement,
          artifact: newer,
          authority,
          candidate: f.candidate,
          candidatePageId: f.candidatePageId,
          repositoryId: f.repositoryId,
          threadnoteHome: f.home,
        });
        const newScope = graphWorkerDeliveryScope(authority, f.candidate.organization);
        expect((yield* listGraphWorkerDeliveryOutboxOperations(f.home, f.scope))[0].state).toBe('prepared');
        const admitted = yield* markGraphWorkerDeliveryAdmitted({
          scope: newScope,
          candidateIdentity: prepared.operation.candidateIdentity,
          candidatePageId: f.candidatePageId,
          operationId: prepared.operation.operationId,
          response: {idempotencyKey: prepared.operation.operationId, status: 'accepted'},
          threadnoteHome: f.home,
        });
        yield* finishAdmittedGraphWorkerResult(
          {repositoryId: f.repositoryId, threadnoteHome: f.home},
          newScope,
          admitted,
        );
        expect(yield* listGraphWorkerDeliveryOutboxOperations(f.home, f.scope)).toEqual([]);
        expect(yield* listGraphWorkerDeliveryOutboxOperations(f.home, newScope)).toEqual([]);
        expect(yield* listGraphWorkerDeliveryPrincipalScopes(f.home, newScope)).toEqual([newScope]);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect(
    'reclaims an expired prepared generation only while its exact candidate and CAS result remain durable',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_750_000_000_000);
        const f = yield* fixture();
        yield* TestClock.adjust(3_601_000);
        const old = yield* listGraphWorkerDeliveryOutboxOperations(f.home, f.scope);
        expect(old).toHaveLength(1);
        expect(
          yield* retireExpiredPreparedGraphWorkerDeliveryOutbox({
            operationId: old[0].operationId,
            scope: f.scope,
            threadnoteHome: f.home,
          }),
        ).toBe(true);
        expect(yield* listGraphWorkerDeliveryOutboxOperations(f.home, f.scope)).toEqual([]);
        expect(yield* listGraphShareSignedCandidatePageIds(f.home, f.repositoryId)).toEqual([f.candidatePageId]);
        const next = yield* prepareGeneration(f, `gw_${'9'.repeat(32)}`);
        expect(next.prepared).toBe(true);
      }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('retains expired prepared evidence when its source candidate or CAS result is missing', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_750_000_000_000);
      const missingCandidate = yield* fixture();
      const missingResult = yield* fixture();
      yield* acknowledgeGraphShareSignedCandidatePage(
        missingCandidate.home,
        missingCandidate.repositoryId,
        missingCandidate.candidatePageId,
        new Set([graphShareSignedCandidateIdentity(missingCandidate.candidate)]),
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.remove(
        graphSharingCasBlobPath(
          path,
          missingResult.candidate.casRoot,
          sha256HexFromDigest(missingResult.candidate.resultDigest),
        ),
      );
      yield* TestClock.adjust(3_601_000);
      for (const f of [missingCandidate, missingResult]) {
        expect(
          yield* retireExpiredPreparedGraphWorkerDeliveryOutbox({
            operationId: f.prepared.operation.operationId,
            scope: f.scope,
            threadnoteHome: f.home,
          }),
        ).toBe(false);
        expect(yield* listGraphWorkerDeliveryOutboxOperations(f.home, f.scope)).toHaveLength(1);
      }
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect(
    'frees a full worker-generation index after renewal without dropping the queued source',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_750_000_000_000);
        const f = yield* fixture();
        for (let index = 1; index < 128; index++) {
          const workerId = `gw_${index.toString(16).padStart(32, '0')}`;
          yield* prepareGeneration(f, workerId);
        }
        const current = {...f.scope, workerId: `gw_${'9'.repeat(32)}`};
        expect((yield* listGraphWorkerDeliveryPrincipalScopes(f.home, current)).length).toBe(129);
        yield* TestClock.adjust(3_601_000);
        yield* reclaimExpiredGraphWorkerGenerations(f.home, current);
        expect((yield* listGraphWorkerDeliveryPrincipalScopes(f.home, current)).length).toBe(128);
        expect(yield* listGraphShareSignedCandidatePageIds(f.home, f.repositoryId)).toEqual([f.candidatePageId]);
        const prepared = yield* prepareGeneration(f, current.workerId);
        expect(prepared.prepared).toBe(true);
        expect(yield* listGraphWorkerDeliveryOutboxOperations(f.home, current)).toHaveLength(1);
      }).pipe(provideTestLayer(layer)),
    120_000,
  );

  effectIt.effect('advances past failed candidates without dropping them and eventually reaches the tail', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* acknowledgeGraphShareSignedCandidatePage(
          f.home,
          f.repositoryId,
          f.candidatePageId,
          new Set([graphShareSignedCandidateIdentity(f.candidate)]),
        );
        const candidates = Array.from({length: 10}, (_, index) => ({
          ...f.candidate,
          snapshotId: `cgsn_${index.toString(16).padStart(40, '0')}`,
        }));
        yield* persistGraphShareSignedCandidates(f.home, f.repositoryId, candidates);
        const first = yield* nextGraphWorkerCandidateScan(f.home, f.repositoryId);
        expect(first.map(item => item.candidate.snapshotId)).toEqual(
          candidates.slice(0, 8).map(item => item.snapshotId),
        );
        yield* advanceGraphWorkerCandidateScan(f.home, f.repositoryId, first.at(-1)!);
        const next = yield* nextGraphWorkerCandidateScan(f.home, f.repositoryId);
        expect(next[0].candidate.snapshotId).toBe(candidates[8].snapshotId);
        expect(next[1].candidate.snapshotId).toBe(candidates[9].snapshotId);
        expect(yield* listGraphShareSignedCandidatePageIds(f.home, f.repositoryId)).toHaveLength(1);
        expect(
          (yield* readGraphShareSignedCandidatePage(f.home, f.repositoryId, first[0].pageId))?.candidates,
        ).toHaveLength(10);
      }).pipe(provideTestLayer(layer)),
    ),
  );
});
