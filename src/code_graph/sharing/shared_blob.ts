import {Effect, Schema} from 'effect';
import {putCasBytes, readVerifiedCasBlob} from './cas.js';
import {graphShareControlGetCas} from './control_client.js';
import {parseSha256Digest, sha256Digest} from './digest.js';
import {GraphSharingError, graphSharingFailure, graphSharingUnavailable} from './errors.js';

export type GraphShareBlobSource = (digest: string) => Effect.Effect<Uint8Array, GraphSharingError>;

export const ensureSharedGraphBlob = Effect.fn('codeGraph.sharing.ensureSharedBlob')(function* (
  casRoot: string,
  digest: string,
  coordinatorUrl: string | undefined,
  source?: GraphShareBlobSource,
) {
  return yield* readVerifiedCasBlob(casRoot, digest).pipe(
    Effect.catchIf(
      error => Schema.is(GraphSharingError)(error) && error.kind === 'unavailable',
      () =>
        Effect.gen(function* () {
          const bytes = yield* source !== undefined
            ? source(digest)
            : coordinatorUrl !== undefined
              ? graphShareControlGetCas(coordinatorUrl, digest)
              : graphSharingUnavailable('Shared graph artifact is missing.');
          if (sha256Digest(bytes) !== parseSha256Digest(digest)) {
            return yield* graphSharingFailure('Shared graph artifact digest is invalid.');
          }
          yield* putCasBytes(casRoot, bytes);
          return bytes;
        }),
    ),
  );
});
