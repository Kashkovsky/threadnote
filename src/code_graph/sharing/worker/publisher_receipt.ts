import {Effect} from 'effect';
import {canonicalJson} from '../../checkpoint/canonical_json.js';
import {parseSha256Digest, sha256Digest} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import type {GraphShareSourceVerifiedReceipt} from '../source_verification.js';
import type {GraphWorkerAdmissionReceiptV2} from './admission_state.js';
import {verifyGraphWorkerResultAnnouncement} from './announcement.js';
import {readGraphWorkerResultArtifact, type GraphWorkerResultAuthority} from './result.js';

/** Reauthenticate an admitted OCI result before source-verifying canonical assembly. */
export const verifyPublisherWorkerReceipt = Effect.fn('codeGraph.sharing.verifyPublisherWorkerReceipt')(function* <
  E,
  R,
>(input: {
  readonly authority: Omit<GraphWorkerResultAuthority, 'graphAbi'>;
  readonly expectedGraphAbi: string;
  readonly reader: {
    readonly readWorkerManifest: (digest: string) => Effect.Effect<Uint8Array, E, R>;
    readonly readBlob: (digest: string, size?: number) => Effect.Effect<Uint8Array, E, R>;
  };
  readonly receipt: GraphWorkerAdmissionReceiptV2;
  readonly sourceCommit: string;
}) {
  const receipt = structuredClone(input.receipt);
  const authority = {...input.authority, graphAbi: input.expectedGraphAbi};
  if (
    receipt.graphAbi !== input.expectedGraphAbi ||
    receipt.sourceCommit !== input.sourceCommit ||
    receipt.authorityExpiresAt <= receipt.admittedAt ||
    receipt.announcementDigest !== sha256Digest(canonicalJson(receipt.announcement)) ||
    receipt.signedBodyDigest !== sha256Digest(canonicalJson(receipt.announcement.body))
  )
    return yield* graphSharingFailure('Admitted worker receipt is invalid.');
  const body = yield* verifyGraphWorkerResultAnnouncement(receipt.announcement, authority);
  const result = yield* readGraphWorkerResultArtifact(input.reader, body.resultManifestDigest, authority);
  const claims = result.attestation.claims;
  if (
    body.actionKey !== claims.actionKey ||
    body.attestationDigest !== result.attestationDigest ||
    body.batchId !== claims.batchId ||
    body.principalId !== claims.principalId ||
    body.profileDigest !== claims.profileDigest ||
    body.repositoryId !== claims.repositoryId ||
    body.resultManifestDigest !== result.manifestDigest ||
    body.semanticDigest !== claims.semanticDigest ||
    body.workerId !== claims.workerId ||
    claims.sourceCommit !== input.sourceCommit ||
    claims.graphAbi !== receipt.graphAbi ||
    claims.issuedAt > receipt.admittedAt + 120 ||
    claims.issuedAt >= receipt.authorityExpiresAt
  )
    return yield* graphSharingFailure('Admitted worker result differs from signed source or authority.');
  return {
    announcement: {
      actionKey: body.actionKey,
      attestationDigest: parseSha256Digest(body.attestationDigest),
      batchId: body.batchId,
      resultManifestDigest: parseSha256Digest(body.resultManifestDigest),
      semanticDigest: parseSha256Digest(body.semanticDigest),
    },
    parsed: result.parsed,
    sourceCommit: claims.sourceCommit,
    graphAbi: claims.graphAbi,
    operationId: body.idempotencyKey,
  } satisfies GraphShareSourceVerifiedReceipt & {
    readonly graphAbi: string;
    readonly operationId: string;
  };
});
