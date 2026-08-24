import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_RESOLUTION_PASS_MAXIMUM,
  codeGraphResolutionPassAdmitted,
  nextPersistentUnresolvedReferenceBatchRows,
} from '../../src/code_graph/store_resolution.js';
import {
  aggregatePersistentReferenceResolutionCapacityBoundaries,
  PERSISTENT_FULL_RESOLUTION_RESERVATION_PAGES,
  PERSISTENT_FULL_RESOLUTION_TRANSACTION_PAGES,
  planPersistentReferenceResolutionPages,
} from '../../src/code_graph/store_resolution_core.js';

describe('code graph resolution pass bounds', () => {
  it('adapts unresolved publication from the proven page size without exceeding 10k hydrated rows', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({max: 60_000, min: 0}), {maxLength: 64}), durations => {
        let current = 1_500;
        for (const duration of durations) {
          const next = nextPersistentUnresolvedReferenceBatchRows(current, duration);
          expect(Number.isSafeInteger(next)).toBe(true);
          expect(next).toBeGreaterThanOrEqual(250);
          expect(next).toBeLessThanOrEqual(10_000);
          expect(next).toBeLessThanOrEqual(current * 2);
          if (duration >= 2_000 && duration <= 5_000) expect(next).toBe(current);
          else if (duration > 5_000) expect(next).toBeLessThanOrEqual(current);
          else expect(next).toBeGreaterThanOrEqual(current);
          current = next;
        }
      }),
      {numRuns: 250},
    );
    let current = 1_500;
    const growth = Array.from({length: 4}, () => (current = nextPersistentUnresolvedReferenceBatchRows(current, 0)));
    expect(growth).toEqual([3_000, 6_000, 10_000, 10_000]);
  });

  it('admits exactly the finite non-negative pass prefix', () => {
    fc.assert(
      fc.property(fc.integer({max: 1_000, min: -1_000}), completed => {
        expect(codeGraphResolutionPassAdmitted(completed)).toBe(
          completed >= 0 && completed < CODE_GRAPH_RESOLUTION_PASS_MAXIMUM,
        );
      }),
      {numRuns: 250},
    );
    expect(codeGraphResolutionPassAdmitted(Number.POSITIVE_INFINITY)).toBe(false);
    expect(codeGraphResolutionPassAdmitted(1.5)).toBe(false);
  });

  it('aggregates compatible page capacities without overflow or order dependence', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            finalFactBytes: fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
            rowCount: fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
          }),
          {maxLength: 16, minLength: 1},
        ),
        pages => {
          const boundaries = pages.map(page => ({
            ...page,
            operation: 'resolve persistent code graph references' as const,
          }));
          const expectedBytes = pages.reduce((total, page) => total + BigInt(page.finalFactBytes), 0n);
          const expectedRows = pages.reduce((total, page) => total + BigInt(page.rowCount), 0n);
          const maximum = BigInt(Number.MAX_SAFE_INTEGER);
          const expected = {
            finalFactBytes: Number(expectedBytes > maximum ? maximum : expectedBytes),
            operation: 'resolve persistent code graph references',
            rowCount: Number(expectedRows > maximum ? maximum : expectedRows),
          };
          expect(aggregatePersistentReferenceResolutionCapacityBoundaries(boundaries)).toEqual(expected);
          expect(aggregatePersistentReferenceResolutionCapacityBoundaries([...boundaries].reverse())).toEqual(expected);
        },
      ),
      {numRuns: 250},
    );
  });

  it('fails closed for absent, invalid, or incompatible capacity evidence', () => {
    expect(aggregatePersistentReferenceResolutionCapacityBoundaries([])).toMatchObject({
      finalFactBytes: Number.NaN,
      rowCount: Number.NaN,
    });
    expect(
      aggregatePersistentReferenceResolutionCapacityBoundaries([
        {finalFactBytes: 1, operation: 'resolve persistent code graph references', rowCount: 1},
        {
          finalFactBytes: 1,
          mainFilesystem: 'temporary',
          operation: 'resolve temporary code graph references',
          rowCount: 1,
          transientFilesystem: 'temporary',
        },
      ]),
    ).toMatchObject({finalFactBytes: Number.NaN, rowCount: Number.NaN});
    expect(
      aggregatePersistentReferenceResolutionCapacityBoundaries([
        {finalFactBytes: Number.NaN, operation: 'resolve persistent code graph references', rowCount: 1},
      ]),
    ).toMatchObject({finalFactBytes: Number.NaN, rowCount: Number.NaN});
  });

  it('keeps transaction groups within reservation memory bounds without changing page order', () => {
    expect(PERSISTENT_FULL_RESOLUTION_RESERVATION_PAGES).toBeGreaterThanOrEqual(
      PERSISTENT_FULL_RESOLUTION_TRANSACTION_PAGES,
    );
    expect(PERSISTENT_FULL_RESOLUTION_RESERVATION_PAGES % PERSISTENT_FULL_RESOLUTION_TRANSACTION_PAGES).toBe(0);
    fc.assert(
      fc.property(fc.array(fc.integer(), {maxLength: 257}), pages => {
        const reservations = planPersistentReferenceResolutionPages(pages);
        expect(reservations.flatMap(reservation => reservation.pages)).toEqual(pages);
        expect(reservations).toHaveLength(Math.ceil(pages.length / PERSISTENT_FULL_RESOLUTION_RESERVATION_PAGES));
        for (const reservation of reservations) {
          expect(reservation.pages.length).toBeGreaterThan(0);
          expect(reservation.pages.length).toBeLessThanOrEqual(PERSISTENT_FULL_RESOLUTION_RESERVATION_PAGES);
          expect(reservation.transactions.flat()).toEqual(reservation.pages);
          for (const transaction of reservation.transactions) {
            expect(transaction.length).toBeGreaterThan(0);
            expect(transaction.length).toBeLessThanOrEqual(PERSISTENT_FULL_RESOLUTION_TRANSACTION_PAGES);
          }
        }
        expect(reservations.flatMap(reservation => reservation.transactions)).toHaveLength(
          Math.ceil(pages.length / PERSISTENT_FULL_RESOLUTION_TRANSACTION_PAGES),
        );
      }),
      {numRuns: 250},
    );

    const boundary = planPersistentReferenceResolutionPages(Array.from({length: 17}, (_, index) => index));
    expect(boundary.map(reservation => reservation.pages.length)).toEqual([8, 8, 1]);
    expect(boundary.map(reservation => reservation.transactions.map(transaction => transaction.length))).toEqual([
      [4, 4],
      [4, 4],
      [1],
    ]);
  });
});
