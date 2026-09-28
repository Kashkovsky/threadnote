import {Effect, FileSystem, Path, Schema} from 'effect';
import {decodeJsonBytes, readBoundedPrivateBytes, writeDurablePrivateJsonFile} from '../atomic.js';
import {SHA256_DIGEST, type Sha256Digest} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import {graphSharingLayout, graphSharingPublisherEvidencePath} from '../layout.js';
import type {GraphPublisherContributionEvidence} from '../publication_evidence.js';

const Digest = Schema.String.check(Schema.isPattern(SHA256_DIGEST));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PublisherEvidenceRecord = Schema.Struct({
  contributionEvidence: Schema.Struct({
    canonicalInputPolicy: Schema.Literal('publisher-recompute'),
    selectedResults: Count,
    sourceUse: Schema.Struct({
      consumedActions: Count,
      consumedResultManifestDigests: Schema.Array(Digest).check(Schema.isMaxLength(128)),
      resultDigestsTruncated: Schema.Boolean,
      sourceVerifiedFiles: Count,
    }),
    verifiedResults: Count,
  }),
  generation: Count,
  manifestDigest: Digest,
  repositoryId: Schema.String,
  schemaVersion: Schema.Literal(1),
  sourceCommit: Schema.String,
});

export type GraphPublisherEvidenceRecordV1 = typeof PublisherEvidenceRecord.Type;

/** Private per-generation proof; it is written before the canonical pointer advances. */
export const writeGraphPublisherEvidenceRecord = Effect.fn('codeGraph.sharing.writePublisherEvidence')(
  function* (input: {
    readonly contributionEvidence: GraphPublisherContributionEvidence;
    readonly generation: number;
    readonly manifestDigest: Sha256Digest;
    readonly repositoryId: string;
    readonly sourceCommit: string;
    readonly threadnoteHome: string;
  }) {
    const sourceUse = input.contributionEvidence.sourceUse;
    if (sourceUse === undefined) return yield* graphSharingFailure('Published graph is missing source-use evidence.');
    const path = yield* Path.Path;
    const record: GraphPublisherEvidenceRecordV1 = {
      contributionEvidence: {
        canonicalInputPolicy: input.contributionEvidence.canonicalInputPolicy,
        selectedResults: input.contributionEvidence.selectedResults,
        sourceUse,
        verifiedResults: input.contributionEvidence.verifiedResults,
      },
      generation: input.generation,
      manifestDigest: input.manifestDigest,
      repositoryId: input.repositoryId,
      schemaVersion: 1,
      sourceCommit: input.sourceCommit,
    };
    yield* writeDurablePrivateJsonFile(
      graphSharingPublisherEvidencePath(
        path,
        graphSharingLayout(path, input.threadnoteHome).root,
        input.repositoryId,
        input.manifestDigest,
      ),
      record,
    );
    return record;
  },
);

export const readGraphPublisherEvidenceRecord = Effect.fn('codeGraph.sharing.readPublisherEvidence')(function* (input: {
  readonly manifestDigest: Sha256Digest;
  readonly repositoryId: string;
  readonly threadnoteHome: string;
}) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const target = graphSharingPublisherEvidencePath(
    path,
    graphSharingLayout(path, input.threadnoteHome).root,
    input.repositoryId,
    input.manifestDigest,
  );
  if (!(yield* fs.exists(target))) return undefined;
  const record = yield* Schema.decodeUnknownEffect(PublisherEvidenceRecord)(
    yield* decodeJsonBytes(yield* readBoundedPrivateBytes(target, 32_768)),
  ).pipe(Effect.mapError(cause => graphSharingFailure('Publisher source-use evidence is invalid.', cause)));
  if (record.manifestDigest !== input.manifestDigest || record.repositoryId !== input.repositoryId)
    return yield* graphSharingFailure('Publisher source-use evidence does not match the requested frontier.');
  return record;
});
