import fc from 'fast-check';
import {describe, expect, it} from '@effect/vitest';
import {
  CODE_GRAPH_CACHE_PERSISTENT_CAPACITY_CALIBRATION,
  CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_CALIBRATION,
  codeGraphDirectPersistentCapacityDemand,
  codeGraphPersistentCapacityDemand,
  CodeGraphDiskCapacityObservationError,
  CodeGraphDiskCapacityPressureError,
  codeGraphDiskCapacityFailure,
  codeGraphUtf8ByteLength,
  evaluateCodeGraphDiskCapacity,
  isCodeGraphCapacityPause,
  saturatingCapacityAdd,
  saturatingCapacityMultiply,
  sqliteWalCapacityBytes,
  type CodeGraphDiskCapacityInput,
} from '../../src/code_graph/disk_capacity.js';
import {
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CodeGraphStoreNoSpaceError,
  CodeGraphStoreTransientIoError,
} from '../../src/code_graph/types.js';

const boundedBytes = fc.integer({max: 2 ** 42, min: 0});
const capacityMagnitude = fc.oneof(
  boundedBytes,
  fc.constant(0),
  fc.constant(Number.MAX_SAFE_INTEGER - 1),
  fc.constant(Number.MAX_SAFE_INTEGER),
);

describe('code graph disk capacity properties', () => {
  it('binds persistent-extension revision 8 into both calibration identities', () => {
    for (const calibration of [
      CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_CALIBRATION,
      CODE_GRAPH_CACHE_PERSISTENT_CAPACITY_CALIBRATION,
    ]) {
      const revisionIdentity = `extension-r${CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION}`;
      expect(calibration.identityBase).toContain(`:${revisionIdentity}`);
      expect(calibration.identityBase.replace(revisionIdentity, 'extension-r7')).not.toBe(calibration.identityBase);
    }
  });

  it('uses an independently versioned cache-payload calibration for both cache operations', () => {
    for (const operation of [
      'cache code graph file facts' as const,
      'cache materialized code graph file shards' as const,
    ]) {
      const demand = codeGraphPersistentCapacityDemand({
        boundary: {finalFactBytes: 8 * 1_048_576, operation, rowCount: 512},
        lexicalFormatVersion: 1,
        pageSize: 4_096,
        walAutoCheckpointPages: 1_000,
      });
      expect(demand.state).toBe('measured');
      expect(demand.calibrationIdentity).toContain(':cache-payload:capacity-v2:');
      if (demand.state === 'measured') {
        expect(demand.mainHighWaterBytes).toBeGreaterThanOrEqual(40 * 1_048_576);
        expect(demand.transientHighWaterBytes).toBeGreaterThanOrEqual(24 * 1_048_576);
      }
    }
  });

  it.prop(
    'keeps every cache demand component monotone in payload bytes and row count through saturation',
    {
      bytes: capacityMagnitude,
      moreBytes: capacityMagnitude,
      moreRows: capacityMagnitude,
      operation: fc.constantFrom(
        'cache code graph file facts' as const,
        'cache materialized code graph file shards' as const,
      ),
      rows: capacityMagnitude,
    },
    ({bytes, moreBytes, moreRows, operation, rows}) => {
      const demand = (finalFactBytes: number, rowCount: number) =>
        codeGraphPersistentCapacityDemand({
          boundary: {finalFactBytes, operation, rowCount},
          lexicalFormatVersion: 1,
          pageSize: 4_096,
          walAutoCheckpointPages: 1_000,
        });
      const original = demand(bytes, rows);
      const largerPayload = demand(saturatingCapacityAdd(bytes, moreBytes), rows);
      const moreRowsDemand = demand(bytes, saturatingCapacityAdd(rows, moreRows));

      expect(original.state).toBe('measured');
      expect(largerPayload.state).toBe('measured');
      expect(moreRowsDemand.state).toBe('measured');
      if (original.state !== 'measured' || largerPayload.state !== 'measured' || moreRowsDemand.state !== 'measured') {
        return;
      }
      for (const increased of [largerPayload, moreRowsDemand]) {
        expect(increased.mainHighWaterBytes).toBeGreaterThanOrEqual(original.mainHighWaterBytes);
        expect(increased.transientHighWaterBytes).toBeGreaterThanOrEqual(original.transientHighWaterBytes);
        expect(increased.recoveryFloorBytes).toBeGreaterThanOrEqual(original.recoveryFloorBytes);
      }
    },
    {fastCheck: {numRuns: 400}},
  );

  it.prop(
    'models exact WAL header/frame bytes and saturates safely',
    {pageFrames: capacityMagnitude, pageSize: capacityMagnitude},
    ({pageFrames, pageSize}) => {
      const exact = 32n + BigInt(pageFrames) * (BigInt(pageSize) + 24n);
      const expected = Number(exact > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : exact);
      expect(sqliteWalCapacityBytes(pageSize, pageFrames)).toBe(expected);
    },
    {fastCheck: {numRuns: 400}},
  );

  it('saturates every byte calculation at the safe-integer boundary', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}), {maxLength: 12}),
        fc.integer({max: 10_000, min: 0}),
        (values, multiplier) => {
          const sum = saturatingCapacityAdd(...values);
          const product = saturatingCapacityMultiply(sum, multiplier);

          expect(Number.isSafeInteger(sum)).toBe(true);
          expect(Number.isSafeInteger(product)).toBe(true);
          expect(sum).toBeGreaterThanOrEqual(0);
          expect(product).toBeGreaterThanOrEqual(0);
          expect(sum).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
          expect(product).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
        },
      ),
      {numRuns: 250},
    );
  });

  it('counts UTF-8 bytes exactly without allocating encoded payloads', () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(
        fc
          .array(fc.integer({max: 0xffff, min: 0}), {maxLength: 256})
          .map(codeUnits => String.fromCharCode(...codeUnits)),
        value => {
          expect(codeGraphUtf8ByteLength(value)).toBe(encoder.encode(value).byteLength);
        },
      ),
      {numRuns: 500},
    );
  });

  it('is monotone in available/freelist bytes and antitone in demand/reservations', () => {
    fc.assert(
      fc.property(
        boundedBytes,
        boundedBytes,
        boundedBytes,
        boundedBytes,
        boundedBytes,
        boundedBytes,
        (available, addedAvailable, freelist, addedFreelist, reserved, addedReserved) => {
          const demand = codeGraphDirectPersistentCapacityDemand({
            finalFactBytes: 8 * 1_048_576,
            lexicalFormatVersion: 1,
            observedMainHighWaterBytes: 40 * 1_048_576,
            observedTransientHighWaterBytes: 24 * 1_048_576,
            pageSize: 4_096,
            rowCount: 10_000,
            walAutoCheckpointPages: 1_000,
          });
          expect(demand.state).toBe('measured');
          if (demand.state !== 'measured') return;
          const base = capacityInput({available, demand, freelist, reserved});
          const moreCapacity = evaluateCodeGraphDiskCapacity(
            capacityInput({
              available: saturatingCapacityAdd(available, addedAvailable),
              demand,
              freelist: saturatingCapacityAdd(freelist, addedFreelist),
              reserved,
            }),
          );
          const moreDemand = evaluateCodeGraphDiskCapacity(
            capacityInput({
              available,
              demand: {
                ...demand,
                mainHighWaterBytes: saturatingCapacityAdd(demand.mainHighWaterBytes, addedReserved),
              },
              freelist,
              reserved: saturatingCapacityAdd(reserved, addedReserved),
            }),
          );
          const original = evaluateCodeGraphDiskCapacity(base);

          if (original.state === 'healthy') expect(moreCapacity.state).toBe('healthy');
          if (original.state === 'pressure') expect(moreDemand.state).toBe('pressure');
        },
      ),
      {numRuns: 300},
    );
  });

  it('conserves demand when durable and transient storage share a filesystem', () => {
    fc.assert(
      fc.property(boundedBytes, boundedBytes, boundedBytes, boundedBytes, (main, transient, recovery, freelist) => {
        const input: CodeGraphDiskCapacityInput = {
          demand: {
            calibrationIdentity: 'property-v1',
            mainHighWaterBytes: main,
            recoveryFloorBytes: recovery,
            state: 'measured',
            transientFilesystem: 'temporary',
            transientHighWaterBytes: transient,
          },
          durableAvailableBytes: Number.MAX_SAFE_INTEGER,
          filesystemsShared: true,
          freelistBytes: freelist,
          reservedDurableBytes: 17,
          reservedTemporaryBytes: 29,
          temporaryAvailableBytes: Number.MAX_SAFE_INTEGER,
        };
        const decision = evaluateCodeGraphDiskCapacity(input);

        expect(decision.state).toBe('healthy');
        if (decision.state !== 'healthy') return;
        expect(decision.filesystems).toEqual([
          {
            availableBytes: Number.MAX_SAFE_INTEGER,
            requiredBytes: saturatingCapacityAdd(
              Math.max(0, main - Math.min(main, freelist)),
              transient,
              recovery,
              17,
              29,
            ),
            role: 'shared',
          },
        ]);
      }),
      {numRuns: 250},
    );
  });

  it('fails closed for unknown topology or fresh available bytes', () => {
    const demand = codeGraphDirectPersistentCapacityDemand({
      finalFactBytes: 1,
      lexicalFormatVersion: 1,
      pageSize: 4_096,
      rowCount: 1,
      walAutoCheckpointPages: 1_000,
    });

    expect(
      evaluateCodeGraphDiskCapacity({
        demand,
        durableAvailableBytes: undefined,
        filesystemsShared: false,
        freelistBytes: 0,
        reservedDurableBytes: 0,
        reservedTemporaryBytes: 0,
        temporaryAvailableBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({reason: 'available-space-unknown', state: 'unknown'});
    expect(
      evaluateCodeGraphDiskCapacity({
        demand,
        durableAvailableBytes: Number.MAX_SAFE_INTEGER,
        filesystemsShared: undefined,
        freelistBytes: 0,
        reservedDurableBytes: 0,
        reservedTemporaryBytes: 0,
        temporaryAvailableBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({reason: 'filesystem-topology-unknown', state: 'unknown'});
  });

  it('makes an earlier reservation visible to the next capacity decision', () => {
    const demand = codeGraphDirectPersistentCapacityDemand({
      finalFactBytes: 1_048_576,
      lexicalFormatVersion: 1,
      pageSize: 4_096,
      rowCount: 1_000,
      walAutoCheckpointPages: 1_000,
    });
    const first = evaluateCodeGraphDiskCapacity(capacityInput({available: 20 * 1_048_576, demand}));
    expect(first.state).toBe('healthy');
    if (first.state !== 'healthy') return;

    const second = evaluateCodeGraphDiskCapacity(
      capacityInput({available: 20 * 1_048_576, demand, reserved: first.filesystems[0]?.requiredBytes}),
    );
    expect(second.state).toBe('pressure');
  });

  it('constructs a typed path-free proactive no-space failure', () => {
    const decision = evaluateCodeGraphDiskCapacity({
      demand: {
        calibrationIdentity: 'fixture-v1',
        mainHighWaterBytes: 10,
        recoveryFloorBytes: 10,
        state: 'measured',
        transientFilesystem: 'durable',
        transientHighWaterBytes: 10,
      },
      durableAvailableBytes: 0,
      filesystemsShared: false,
      freelistBytes: 0,
      reservedDurableBytes: 0,
      reservedTemporaryBytes: 0,
      temporaryAvailableBytes: Number.MAX_SAFE_INTEGER,
    });
    const failure = codeGraphDiskCapacityFailure(decision, '/Users/private/graph.sqlite');

    expect(failure).toBeInstanceOf(CodeGraphDiskCapacityPressureError);
    expect(failure).toBeInstanceOf(CodeGraphStoreNoSpaceError);
    expect(failure).toMatchObject({
      code: 'no-space',
      operation: 'protect code graph storage',
      recovery: 'free-space',
      retryable: false,
    });
    expect(failure.message).not.toMatch(/[\\/]/u);
    expect(failure.operation).not.toContain('/Users/private');
    expect(Object.keys(failure)).not.toContain('decision');
    expect(isCodeGraphCapacityPause(failure)).toBe(true);

    for (const operation of [
      'cache code graph file facts',
      'cache materialized code graph file shards',
      'publish persistent code graph snapshot',
      'register persistent code graph materialization plan',
      'stage persistent code graph facts',
      'stage persistent code graph inventory',
      'stage persistent code graph workspace',
    ] as const) {
      const bounded = codeGraphDiskCapacityFailure(decision, operation);
      expect(bounded.operation).toBe(operation);
      expect(bounded.message).not.toMatch(/[\\/]/u);
    }
  });

  it('maps unknown observation to a path-free retryable capacity pause instead of false no-space', () => {
    const failure = codeGraphDiskCapacityFailure(
      {
        calibrationIdentity: 'fixture-v1',
        reason: 'available-space-unknown',
        state: 'unknown',
      },
      '/Users/private/graph.sqlite',
    );

    expect(failure).toBeInstanceOf(CodeGraphDiskCapacityObservationError);
    expect(failure).toMatchObject({
      code: 'transient-io',
      operation: 'observe code graph storage capacity',
      recovery: 'retry-read-only',
      retryable: true,
    });
    expect(failure.message).not.toMatch(/[\\/]/u);
    expect(isCodeGraphCapacityPause(failure)).toBe(true);
    expect(
      isCodeGraphCapacityPause(
        new CodeGraphStoreTransientIoError('fixture', {operation: 'observe code graph storage capacity'}),
      ),
    ).toBe(false);
    expect(
      isCodeGraphCapacityPause(new CodeGraphStoreNoSpaceError('classified write-time no-space', {operation: 'write'})),
    ).toBe(false);
  });

  it('fails closed when page, checkpoint, or batch-counter evidence is invalid', () => {
    const base = {
      finalFactBytes: 1_048_576,
      lexicalFormatVersion: 1,
      pageSize: 4_096,
      rowCount: 1_000,
      walAutoCheckpointPages: 1_000,
    } as const;

    for (const demand of [
      codeGraphDirectPersistentCapacityDemand({...base, finalFactBytes: -1}),
      codeGraphDirectPersistentCapacityDemand({...base, finalFactBytes: Number.NaN}),
      codeGraphDirectPersistentCapacityDemand({...base, lexicalFormatVersion: 0}),
      codeGraphDirectPersistentCapacityDemand({...base, pageSize: 0}),
      codeGraphDirectPersistentCapacityDemand({...base, pageSize: Number.NaN}),
      codeGraphDirectPersistentCapacityDemand({...base, walAutoCheckpointPages: 0}),
      codeGraphDirectPersistentCapacityDemand({...base, walAutoCheckpointPages: Number.NaN}),
      codeGraphDirectPersistentCapacityDemand({...base, rowCount: -1}),
    ]) {
      expect(evaluateCodeGraphDiskCapacity(capacityInput({available: Number.MAX_SAFE_INTEGER, demand}))).toMatchObject({
        state: 'unknown',
      });
    }
  });

  it('fails closed for invalid reservations but conservatively ignores invalid freelist evidence', () => {
    const demand = codeGraphDirectPersistentCapacityDemand({
      finalFactBytes: 1_048_576,
      lexicalFormatVersion: 1,
      pageSize: 4_096,
      rowCount: 1_000,
      walAutoCheckpointPages: 1_000,
    });
    const valid = capacityInput({available: Number.MAX_SAFE_INTEGER, demand, freelist: 0});

    for (const reservedDurableBytes of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluateCodeGraphDiskCapacity({...valid, reservedDurableBytes})).toMatchObject({
        reason: 'reservation-input-unknown',
        state: 'unknown',
      });
    }
    const withoutFreelist = evaluateCodeGraphDiskCapacity(valid);
    expect(evaluateCodeGraphDiskCapacity({...valid, freelistBytes: Number.NaN})).toEqual(withoutFreelist);
    expect(evaluateCodeGraphDiskCapacity({...valid, freelistBytes: -1})).toEqual(withoutFreelist);
  });

  it('binds the actual page and WAL profile into the recovery floor and calibration identity', () => {
    const small = codeGraphDirectPersistentCapacityDemand({
      finalFactBytes: 1,
      lexicalFormatVersion: 1,
      pageSize: 4_096,
      rowCount: 0,
      walAutoCheckpointPages: 1_000,
    });
    const tuned = codeGraphDirectPersistentCapacityDemand({
      finalFactBytes: 1,
      lexicalFormatVersion: 1,
      pageSize: 8_192,
      rowCount: 0,
      walAutoCheckpointPages: 8_000,
    });
    const lexical = codeGraphDirectPersistentCapacityDemand({
      finalFactBytes: 1,
      lexicalFormatVersion: 2,
      pageSize: 4_096,
      rowCount: 0,
      walAutoCheckpointPages: 1_000,
    });

    expect(small.state).toBe('measured');
    expect(tuned.state).toBe('measured');
    expect(lexical.state).toBe('measured');
    if (small.state !== 'measured' || tuned.state !== 'measured' || lexical.state !== 'measured') return;
    expect(small.recoveryFloorBytes).toBe(4_120_032);
    expect(tuned.recoveryFloorBytes).toBe(65_728_032);
    expect(small.recoveryFloorBytes).toBe(sqliteWalCapacityBytes(4_096, 1_000));
    expect(tuned.recoveryFloorBytes).toBe(sqliteWalCapacityBytes(8_192, 8_000));
    expect(tuned.calibrationIdentity).not.toBe(small.calibrationIdentity);
    expect(lexical.calibrationIdentity).not.toBe(small.calibrationIdentity);
  });

  it('uses exact staged row counts when compact facts would otherwise underreserve', () => {
    const demand = codeGraphDirectPersistentCapacityDemand({
      finalFactBytes: 1_024,
      lexicalFormatVersion: 1,
      pageSize: 4_096,
      rowCount: 1_000_000,
      walAutoCheckpointPages: 1_000,
    });

    expect(demand.state).toBe('measured');
    if (demand.state !== 'measured') return;
    expect(demand.mainHighWaterBytes).toBe(256_000_000);
    expect(demand.transientHighWaterBytes).toBe(256_000_000);
  });
});

function capacityInput(input: {
  readonly available: number;
  readonly demand: CodeGraphDiskCapacityInput['demand'];
  readonly freelist?: number;
  readonly reserved?: number;
}): CodeGraphDiskCapacityInput {
  return {
    demand: input.demand,
    durableAvailableBytes: input.available,
    filesystemsShared: false,
    freelistBytes: input.freelist ?? 0,
    reservedDurableBytes: input.reserved ?? 0,
    reservedTemporaryBytes: 0,
    temporaryAvailableBytes: Number.MAX_SAFE_INTEGER,
  };
}
