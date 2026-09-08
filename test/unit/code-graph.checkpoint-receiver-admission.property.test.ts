import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {CodeGraphCheckpointReceiverFileVerifier} from '../../src/code_graph/checkpoint/receiver_admission.js';
import type {CodeGraphCheckpointFileRecordV1} from '../../src/code_graph/checkpoint/schema.js';

function file(id: number): CodeGraphCheckpointFileRecordV1 {
  return {
    blobId: id.toString(16).padStart(40, '0'),
    contentHash: id.toString(16).padStart(64, '0'),
    kind: 'file',
    language: 'typescript',
    mode: '100644',
    path: `src/file-${id}.ts`,
    size: 10,
    source: 'commit',
  };
}

describe('checkpoint receiver file admission', () => {
  it('accepts exactly equal file sets regardless of traversal order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({min: 0, max: 50}), {maxLength: 12}),
        fc.uniqueArray(fc.integer({min: 0, max: 50}), {maxLength: 12}),
        (receiver, donor) => {
          const verify = (ids: readonly number[]) => {
            const verifier = new CodeGraphCheckpointReceiverFileVerifier(receiver.map(file));
            return ids.every(id => verifier.accept(file(id))) && verifier.complete;
          };
          expect(verify([...receiver].reverse())).toBe(true);
          expect(verify(donor)).toBe(receiver.length === donor.length && donor.every(id => receiver.includes(id)));
        },
      ),
      {numRuns: 100},
    );
  });

  it('rejects duplicate records and changed identities', () => {
    const original = file(1);
    const duplicate = new CodeGraphCheckpointReceiverFileVerifier([original]);
    expect(duplicate.accept(original)).toBe(true);
    expect(duplicate.accept(original)).toBe(false);
    expect(duplicate.complete).toBe(false);
    for (const changed of [
      {...original, blobId: 'a'.repeat(40)},
      {...original, contentHash: 'a'.repeat(64)},
      {...original, language: 'javascript'},
      {...original, mode: '100755'},
    ]) {
      const verifier = new CodeGraphCheckpointReceiverFileVerifier([original]);
      expect(verifier.accept(changed)).toBe(false);
      expect(verifier.complete).toBe(false);
    }
  });

  it('admits receiptless full or structural sets without admitting partial media or missing source', () => {
    const source = file(1);
    const images = [
      {...file(2), path: 'assets/one.png'},
      {...file(3), path: 'assets/two.png'},
    ];
    const complete = (records: readonly CodeGraphCheckpointFileRecordV1[]) => {
      const verifier = new CodeGraphCheckpointReceiverFileVerifier([source, ...images], {allowStructuralOnly: true});
      return records.every(record => verifier.accept(record)) && verifier.complete;
    };
    expect(complete([source])).toBe(true);
    expect(complete([...images, source])).toBe(true);
    expect(complete([source, images[0]])).toBe(false);
    expect(complete(images)).toBe(false);
    expect(complete([])).toBe(false);
  });
});
