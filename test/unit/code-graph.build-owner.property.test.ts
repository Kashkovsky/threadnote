import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {classifyCodeGraphBuildOwner, type CodeGraphBuildOwnerLiveness} from '../../src/code_graph/build_owner.js';

describe('code graph build owner liveness', () => {
  it.each([
    [false, 'start-a', undefined, 'dead'],
    [true, 'start-a', 'start-a', 'live'],
    [true, 'start-a', 'start-b', 'dead'],
    [true, undefined, 'start-a', 'unknown'],
    [true, 'start-a', undefined, 'unknown'],
  ] as const)('classifies running=%s stored=%s current=%s as %s', (isRunning, stored, current, expected) => {
    expect(
      classifyCodeGraphBuildOwner(
        {buildId: '01234567-89ab-cdef', processId: 42, ...(stored ? {processStartIdentity: stored} : {})},
        {isRunning, ...(current ? {processStartIdentity: current} : {})},
      ),
    ).toBe(expected);
  });

  it('matches the exact tri-state process-instance model for arbitrary identities', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(fc.string({minLength: 1, maxLength: 32}), {nil: undefined}),
        fc.option(fc.string({minLength: 1, maxLength: 32}), {nil: undefined}),
        (isRunning, stored, current) => {
          const expected: CodeGraphBuildOwnerLiveness = !isRunning
            ? 'dead'
            : stored === undefined || current === undefined
              ? 'unknown'
              : stored === current
                ? 'live'
                : 'dead';
          expect(
            classifyCodeGraphBuildOwner(
              {
                buildId: '01234567-89ab-cdef',
                processId: 42,
                ...(stored === undefined ? {} : {processStartIdentity: stored}),
              },
              {isRunning, ...(current === undefined ? {} : {processStartIdentity: current})},
            ),
          ).toBe(expected);
        },
      ),
      {numRuns: 200},
    );
  });
});
