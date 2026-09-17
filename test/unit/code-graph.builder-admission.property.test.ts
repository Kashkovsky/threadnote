import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_BUILDER_BACKGROUND_AGING_MILLISECONDS as aging,
  CODE_GRAPH_BUILDER_HOME_CAPACITY as capacity,
  orderCodeGraphBuilderAdmissionQueue as projectQueue,
  orderCodeGraphBuilderAdmissionTickets as order,
  selectCodeGraphBuilderAdmissionTickets as select,
} from '../../src/code_graph/builder_admission_scheduler.js';

const candidate = fc.record({
  admissionClass: fc.constantFrom('background' as const, 'current-required' as const),
  checkoutId: fc.constantFrom('a', 'b', 'c'),
  createdAt: fc.integer({min: 0, max: aging * 2}),
  token: fc.uuid(),
});
const tickets = fc.uniqueArray(candidate, {maxLength: 40, selector: value => value.token});

describe('checkout-aware builder scheduler properties', () => {
  it('is deterministic, permutation independent, and non-mutating with bounded capacity', () => {
    fc.assert(
      fc.property(
        tickets,
        fc.array(fc.constantFrom('a', 'b', 'c'), {maxLength: capacity}),
        fc.integer({min: 0, max: aging * 3}),
        fc.func(fc.integer()),
        (input, active, now, priority) => {
          const original = structuredClone(input);
          const permuted = [...input].sort(
            (left, right) => priority(left.token) - priority(right.token) || left.token.localeCompare(right.token),
          );
          const result = select(input, active, now);
          expect(select(permuted, active, now)).toEqual(result);
          expect(order(permuted, now)).toEqual(order(input, now));
          expect(select(input, active, now)).toEqual(result);
          expect(input).toEqual(original);
          expect(result.length + active.length).toBeLessThanOrEqual(capacity);
          expect(new Set(result.map(value => value.token)).size).toBe(result.length);
          expect(result.every(value => input.includes(value))).toBe(true);
        },
      ),
      {numRuns: 200},
    );
  });

  it('projects a deterministic advisory order while every slot is occupied', () => {
    fc.assert(
      fc.property(tickets, fc.integer({min: 0, max: aging * 3}), fc.func(fc.integer()), (input, now, priority) => {
        const active = ['a', 'b'];
        const permuted = [...input].sort(
          (left, right) => priority(left.token) - priority(right.token) || left.token.localeCompare(right.token),
        );
        expect(select(input, active, now)).toEqual([]);
        expect(projectQueue(permuted, active, now)).toEqual(projectQueue(input, active, now));
        expect(projectQueue(input, active, now)).toHaveLength(input.length);
      }),
      {numRuns: 200},
    );
  });

  it('chooses checkout diversity before a second occupant, including within a single selection', () => {
    fc.assert(
      fc.property(tickets, fc.array(fc.constantFrom('a', 'b', 'c'), {maxLength: capacity - 1}), (input, active) => {
        const selected = select(input, active, aging * 2);
        const occupied = new Set(active);
        const remaining = [...input];
        for (const ticket of selected) {
          if (remaining.some(value => !occupied.has(value.checkoutId)))
            expect(occupied.has(ticket.checkoutId)).toBe(false);
          occupied.add(ticket.checkoutId);
          remaining.splice(remaining.indexOf(ticket), 1);
        }
      }),
      {numRuns: 200},
    );
  });

  it('has a total FIFO order within each effective rank, including equal timestamp tokens', () => {
    fc.assert(
      fc.property(tickets, fc.integer({min: 0, max: aging * 3}), (input, now) => {
        const ordered = order(input, now);
        const rank = (ticket: typeof candidate extends fc.Arbitrary<infer T> ? T : never) =>
          ticket.admissionClass === 'current-required' || now - ticket.createdAt >= aging ? 0 : 1;
        for (let index = 1; index < ordered.length; index++) {
          const previous = ordered[index - 1];
          const current = ordered[index];
          expect(rank(previous)).toBeLessThanOrEqual(rank(current));
          if (rank(previous) === rank(current)) {
            expect(previous.createdAt).toBeLessThanOrEqual(current.createdAt);
            if (previous.createdAt === current.createdAt) expect(previous.token < current.token).toBe(true);
          }
        }
      }),
      {numRuns: 200},
    );
  });

  it('ages background ahead of every later foreground arrival from the same occupancy tier', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 0, max: 1_000_000}),
        fc.array(fc.integer({min: 1, max: aging * 2}), {maxLength: 40}),
        (createdAt, offsets) => {
          const background = {admissionClass: 'background' as const, checkoutId: 'a', createdAt, token: 'background'};
          const current = offsets.map((offset, index) => ({
            admissionClass: 'current-required' as const,
            checkoutId: 'a',
            createdAt: createdAt + offset,
            token: String(index),
          }));
          expect(select([...current, background], [], createdAt + aging)[0]).toBe(background);
          if (current.length > 0)
            expect(order([...current, background], createdAt + aging - 1)[0]).not.toBe(background);
        },
      ),
      {numRuns: 200},
    );
  });
});
