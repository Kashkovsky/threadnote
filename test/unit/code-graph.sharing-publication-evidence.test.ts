import {describe, expect, it} from 'vitest';
import * as FC from 'effect/testing/FastCheck';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {graphPublisherContributionEvidence} from '../../src/code_graph/sharing/publication_evidence.js';

describe('publisher contribution evidence', () => {
  it('bounds digest evidence independently of arrival order while preserving counts and inputs', () => {
    FC.assert(
      FC.property(
        FC.oneof(
          FC.array(FC.string({maxLength: 20}), {maxLength: 128}),
          FC.array(FC.string({maxLength: 20}), {minLength: 129, maxLength: 200}),
        ),
        values => {
          const digests = values.map(sha256Digest);
          const before = [...digests];
          const input = {
            hydration: {status: 'completed' as const, hydratedResults: digests.length},
            index: {reusedFiles: 3, skippedFiles: 1, snapshot: {id: 'snapshot', fileCount: 5}},
            selectedResults: digests.length,
            verifiedResultDigests: digests,
          };
          const result = graphPublisherContributionEvidence(input);
          expect(result.canonicalInputPolicy).toBe('publisher-recompute');
          expect(graphPublisherContributionEvidence({...input, verifiedResultDigests: [...digests].reverse()})).toEqual(
            result,
          );
          expect(digests).toEqual(before);
          expect(result.resultManifestDigests.length).toBe(Math.min(128, digests.length));
          expect(result.resultDigestsTruncated).toBe(digests.length > 128);
          expect(result.verifiedResults).toBe(digests.length);
          expect(result.selectedResults).toBe(digests.length);
          expect(result.index).toEqual({reusedFiles: 3, skippedFiles: 1, snapshotId: 'snapshot', totalFiles: 5});
          expect(result.resultManifestDigests.every(digest => digests.includes(digest))).toBe(true);
        },
      ),
      {numRuns: 40},
    );
  });
});
