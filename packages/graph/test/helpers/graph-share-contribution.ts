import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {graphShareParseActionKey} from '@threadnote/graph/sharing/action';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {graphShareParseResultArtifact} from '@threadnote/graph/sharing/parse/result';

export function graphShareContributionFixture(repositoryId: string, normalizedPath = 'src/fixture.ts') {
  const input = {
    repositoryId,
    contentHash: 'a'.repeat(64),
    extractorSet: 'b'.repeat(64),
    languageAndRole: 'typescript:source',
    normalizedPath,
  };
  const artifact = graphShareParseResultArtifact({
    ...input,
    actionKey: graphShareParseActionKey(input),
    gitBlobId: 'c'.repeat(40),
    facts: {path: input.normalizedPath, diagnostics: [], edges: [], symbols: []},
  });
  const resultBytes = new TextEncoder().encode(canonicalJson(artifact));
  const resultManifestDigest = sha256Digest(resultBytes);
  const attestationBytes = new TextEncoder().encode(
    canonicalJson({kind: 'contributor-self', payloadDigest: resultManifestDigest, schemaVersion: 1}),
  );
  return {
    resultBytes,
    attestationBytes,
    announcement: {
      actionKey: artifact.actionKey,
      batchId: 'd'.repeat(40),
      semanticDigest: artifact.semanticDigest,
      resultManifestDigest,
      attestationDigest: sha256Digest(attestationBytes),
    },
  };
}
