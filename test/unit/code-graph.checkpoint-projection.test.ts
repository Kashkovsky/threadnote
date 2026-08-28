import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  CODE_GRAPH_CHECKPOINT_GIT_PATHSPEC_BYTES_MAXIMUM,
  CodeGraphCheckpointProjectionError,
  codeGraphCheckpointCoverage,
  codeGraphCheckpointGitPathBatches,
  parseGitTreeEntries,
} from '../../src/code_graph/checkpoint/projection.js';
import {CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION} from '../../src/code_graph/inventory_policy.js';

const safePathSegment = FC.string({
  maxLength: 64,
  minLength: 1,
  unit: FC.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-'),
}).filter(segment => segment !== '.' && segment !== '..');

const safePath = FC.array(safePathSegment, {maxLength: 8, minLength: 1}).map(segments => segments.join('/'));

describe('code graph checkpoint projection', () => {
  it.prop(
    'partitions Git pathspecs without loss, reordering, empty pages, or byte-budget overruns',
    {paths: FC.uniqueArray(safePath, {maxLength: 500})},
    ({paths}) => {
      const files = paths.map((path, ordinal) => ({ordinal, path}));
      const batches = codeGraphCheckpointGitPathBatches(files);

      expect(batches.flat()).toEqual(files);
      expect(batches.every(batch => batch.length > 0)).toBe(true);
      for (const batch of batches) {
        expect(argvPathBytes(batch.map(file => file.path))).toBeLessThanOrEqual(
          CODE_GRAPH_CHECKPOINT_GIT_PATHSPEC_BYTES_MAXIMUM,
        );
      }
    },
    {fastCheck: {numRuns: 150}},
  );

  it('keeps the normal 1,000-file page within two bounded Git processes', () => {
    const files = Array.from({length: 1_000}, (_, index) => ({
      path: `packages/example/src/generated/module-${index.toString().padStart(4, '0')}.ts`,
    }));
    const batches = codeGraphCheckpointGitPathBatches(files);

    expect(batches.length).toBeLessThanOrEqual(2);
    expect(batches.flat()).toEqual(files);
  });

  it.prop(
    'accounts for every skipped file while preserving unknown non-policy bytes explicitly',
    {
      eligibleFiles: FC.integer({max: 1_000_000, min: 0}),
      policyBytes: FC.integer({max: 1_000_000_000, min: 0}),
      policyFiles: FC.integer({max: 100_000, min: 0}),
      residualFiles: FC.integer({max: 100_000, min: 0}),
    },
    ({eligibleFiles, policyBytes, policyFiles, residualFiles}) => {
      const coverage = codeGraphCheckpointCoverage(eligibleFiles, {
        policyExclusions: {
          bytes: policyBytes,
          files: policyFiles,
          policyVersion: CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
          reasons: [{bytes: policyBytes, files: policyFiles, reason: 'svg'}],
        },
        skipped: policyFiles + residualFiles,
      });

      expect(coverage.eligibleFiles).toBe(eligibleFiles);
      expect(coverage.excludedFiles).toBe(policyFiles + residualFiles);
      expect(coverage.reasons.reduce((total, reason) => total + reason.files, 0)).toBe(coverage.excludedFiles);
      expect(coverage.state).toBe(coverage.excludedFiles === 0 ? 'complete' : 'partial');
      expect(coverage.reasons.find(reason => reason.code === 'inventory-other')?.bytes ?? 0).toBe(0);
    },
    {fastCheck: {numRuns: 200}},
  );

  it('parses exact NUL-framed Git tree metadata for both object formats', () => {
    const sha1 = 'a'.repeat(40);
    const sha256 = 'b'.repeat(64);
    expect(parseGitTreeEntries(new TextEncoder().encode(`100644\tblob\t${sha1}\t12\tsrc/a file.ts\0`), 'sha1')).toEqual(
      new Map([['src/a file.ts', {blobId: sha1, mode: '100644', path: 'src/a file.ts', size: 12}]]),
    );
    expect(parseGitTreeEntries(new TextEncoder().encode(`100755\tblob\t${sha256}\t7\tbin/tool\0`), 'sha256')).toEqual(
      new Map([['bin/tool', {blobId: sha256, mode: '100755', path: 'bin/tool', size: 7}]]),
    );
  });

  it('rejects missing terminators, non-blobs, unsafe paths, and wrong object widths', () => {
    const cases = [
      `100644\tblob\t${'a'.repeat(40)}\t1\tsrc/a.ts`,
      `100644\ttree\t${'a'.repeat(40)}\t1\tsrc/a.ts\0`,
      `100644\tblob\t${'a'.repeat(40)}\t1\t../escape.ts\0`,
      `100644\tblob\t${'a'.repeat(64)}\t1\tsrc/a.ts\0`,
    ];
    for (const value of cases) {
      expect(() => parseGitTreeEntries(new TextEncoder().encode(value), 'sha1')).toThrow(
        CodeGraphCheckpointProjectionError,
      );
    }
  });
});

function argvPathBytes(paths: readonly string[]): number {
  const encoder = new TextEncoder();
  return paths.reduce((total, path) => total + encoder.encode(path).byteLength + 1, 0);
}
