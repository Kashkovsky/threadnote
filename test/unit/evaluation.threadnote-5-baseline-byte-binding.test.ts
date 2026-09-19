/* oxlint-disable effecttsgo/node-builtin-import -- These regressions exercise the Promise filesystem boundary and adversarial writes. */
import {chmod, mkdtemp, open, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  copyThreadnote5BaselineBoundBytes,
  verifyThreadnote5BaselineBoundBytes,
  writeThreadnote5BaselineBoundBytes,
} from '../../scripts/threadnote-5-baseline-byte-binding.js';
import {
  pinBaselineExecutableCopy,
  verifyPinnedBaselineExecutable,
} from '../../scripts/threadnote-5-baseline-filesystem-boundary.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';

const domains = [
  'threadnote-5-baseline-public-evidence-v1',
  'threadnote-5-baseline-private-replay-v1',
  'threadnote-5-baseline-replay-recovery-v1',
] as const;
const chunkSize = 64 * 1_024;

describe('baseline exact-byte read transactions', () => {
  it('rejects executable mutation between its last read and final stat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-executable-final-stat-'));
    const source = join(root, 'source');
    const pinned = join(root, 'pinned');
    const bytes = 'a'.repeat(chunkSize * 2);
    try {
      await writeFile(source, bytes, {mode: 0o500});
      const identity = await pinBaselineExecutableCopy(source, pinned, sha256HexSync(bytes));
      await expect(
        verifyPinnedBaselineExecutable(identity, {
          beforeFinalStat: async () => {
            await chmod(pinned, 0o700);
            await writeFile(pinned, `b${bytes.slice(1)}`);
            await chmod(pinned, 0o500);
          },
        }),
      ).rejects.toThrow(/changed while it was being hashed/u);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it.each(['unread', 'already-copied'] as const)(
    'rejects mutation of %s bytes during recovery copying',
    async region => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote-copy-mutation-'));
      const source = await open(join(root, 'source'), 'wx+', 0o600);
      const destination = await open(join(root, 'destination'), 'wx+', 0o600);
      try {
        const binding = await writeThreadnote5BaselineBoundBytes(source, 'a'.repeat(chunkSize * 2), domains[1]);
        await expect(
          copyThreadnote5BaselineBoundBytes(source, binding, destination, domains[2], {
            afterChunk: async position => {
              if (position === chunkSize) {
                await source.write(Buffer.from('b'), 0, 1, region === 'unread' ? chunkSize : 0);
                await source.sync();
              }
            },
          }),
        ).rejects.toThrow(/source changed while its bound bytes were copied/u);
      } finally {
        await source.close();
        await destination.close();
        await rm(root, {recursive: true, force: true});
      }
    },
  );

  it('rejects an equal-length write after the last hashed byte in every evidence domain', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...domains),
        fc.integer({min: 0, max: chunkSize * 2 - 1}),
        async (domain, offset) => {
          const root = await mkdtemp(join(tmpdir(), 'threadnote-final-stat-mutation-'));
          const handle = await open(join(root, 'bound'), 'wx+', 0o600);
          try {
            const binding = await writeThreadnote5BaselineBoundBytes(handle, 'a'.repeat(chunkSize * 2), domain);
            await expect(
              verifyThreadnote5BaselineBoundBytes(handle, binding, 'Final evidence', {
                beforeFinalStat: async () => {
                  await handle.write(Buffer.from('b'), 0, 1, offset);
                  await handle.sync();
                },
              }),
            ).rejects.toThrow(/bytes changed after they were bound/u);
          } finally {
            await handle.close();
            await rm(root, {recursive: true, force: true});
          }
        },
      ),
      {examples: domains.map(domain => [domain, 0]), numRuns: 9},
    );
  });

  it('rejects overwriting an earlier chunk while later chunks are still being read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-earlier-chunk-mutation-'));
    const handle = await open(join(root, 'bound'), 'wx+', 0o600);
    try {
      const binding = await writeThreadnote5BaselineBoundBytes(handle, 'a'.repeat(chunkSize * 2), domains[0]);
      await expect(
        verifyThreadnote5BaselineBoundBytes(handle, binding, 'Final evidence', {
          afterChunk: async position => {
            if (position === chunkSize) await handle.write(Buffer.from('b'), 0, 1, 0);
          },
        }),
      ).rejects.toThrow(/bytes changed after they were bound/u);
    } finally {
      await handle.close();
      await rm(root, {recursive: true, force: true});
    }
  });
});
