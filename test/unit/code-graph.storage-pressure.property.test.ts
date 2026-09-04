import {TestError} from '../helpers/test-error.js';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  classifyCodeGraphStoragePressure,
  codeGraphStorageAccounting,
  type CodeGraphStoragePressure,
} from '../../src/code_graph/storage_pressure.js';

const severity: Readonly<Record<Exclude<CodeGraphStoragePressure, 'unknown'>, number>> = {
  normal: 0,
  elevated: 1,
  critical: 2,
};

describe('code graph storage pressure properties', () => {
  it('can only strengthen as available bytes fall for one physical observation', () => {
    fc.assert(
      fc.property(
        fc.record({
          filesystemBytes: fc.nat({max: 8_000_000_000}),
          highAvailableBytes: fc.nat({max: 16_000_000_000}),
          temporaryBytes: fc.nat({max: 2_000_000_000}),
          walBytes: fc.nat({max: 2_000_000_000}),
        }),
        fc.nat({max: 16_000_000_000}),
        (sample, lowerSeed) => {
          const lowAvailableBytes = Math.min(sample.highAvailableBytes, lowerSeed);
          const observation = {
            filesystemBytes: sample.filesystemBytes,
            reclaimablePageBytes: 0,
            temporaryBytes: sample.temporaryBytes,
            walBytes: sample.walBytes,
          };
          const high = classifyCodeGraphStoragePressure({
            ...observation,
            availableBytes: sample.highAvailableBytes,
          }).pressure;
          const low = classifyCodeGraphStoragePressure({...observation, availableBytes: lowAvailableBytes}).pressure;
          if (high === 'unknown' || low === 'unknown')
            throw TestError.make({message: 'known byte observations became unknown'});
          expect(severity[low]).toBeGreaterThanOrEqual(severity[high]);
        },
      ),
      {numRuns: 200},
    );
  });

  it('keeps logical rows, allocated freelist pages, WAL, TEMP, and filesystem bytes separate', () => {
    fc.assert(
      fc.property(
        fc.record({
          availableBytes: fc.nat({max: 16_000_000_000}),
          filesystemBytes: fc.nat({max: 8_000_000_000}),
          logicalRowsDeleted: fc.nat({max: 1_000_000}),
          reclaimableBytes: fc.nat({max: 4_000_000_000}),
          temporaryBytes: fc.nat({max: 2_000_000_000}),
          walBytes: fc.nat({max: 2_000_000_000}),
        }),
        sample => {
          const accounting = codeGraphStorageAccounting(
            {
              availableBytes: sample.availableBytes,
              filesystemBytes: sample.filesystemBytes,
              pageStorage: {
                freelistPages: sample.reclaimableBytes,
                pageCount: sample.reclaimableBytes,
                pageSize: 1,
                reclaimableBytes: sample.reclaimableBytes,
                reclaimableRatio: 0,
                state: 'available',
                threshold: {
                  minimumReclaimableBytes: 0,
                  minimumReclaimableRatio: 0,
                  recommended: false,
                },
              },
              temporaryBytes: sample.temporaryBytes,
              walBytes: sample.walBytes,
            },
            sample.logicalRowsDeleted,
          );
          expect(accounting).toMatchObject({
            filesystemBytes: sample.filesystemBytes,
            logicalRowsDeleted: sample.logicalRowsDeleted,
            reclaimablePageBytes: sample.reclaimableBytes,
            temporaryBytes: sample.temporaryBytes,
            walBytes: sample.walBytes,
          });
        },
      ),
      {numRuns: 200},
    );
  });
});
