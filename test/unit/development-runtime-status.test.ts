import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  parseDevelopmentRuntimeStatusArguments,
  resolveDevelopmentInstallAdvice,
} from '../../scripts/development-runtime-status.js';
import type {DevelopmentRuntimeOwnershipConflict} from '../../scripts/install-local-standalone.js';

const conflictArbitrary = fc.constantFrom(
  'different-source-checkout',
  'invalid-ownership-record',
  'untracked-development-activation',
) satisfies fc.Arbitrary<DevelopmentRuntimeOwnershipConflict>;

describe('development runtime status', () => {
  it('parses only the explicit status switch', () => {
    expect(parseDevelopmentRuntimeStatusArguments(['--', '--json'])).toEqual({json: true});
    expect(parseDevelopmentRuntimeStatusArguments([])).toEqual({json: false});
    expect(() => parseDevelopmentRuntimeStatusArguments(['--take-over-global-runtime'])).toThrow(
      'Unknown development runtime status option',
    );
  });

  it('classifies install advice from dirty and ownership facts', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.option(conflictArbitrary, {nil: undefined}), (dirty, conflict) => {
        const advice = resolveDevelopmentInstallAdvice({conflict, dirty});
        if (dirty) {
          expect(advice.canInstallWithoutTakeOver).toBe(false);
          expect(advice.requiresTakeOver).toBe(false);
          expect(advice.blockedReason).toContain('dirty');
          expect(advice.suggestedCommand).not.toContain('dev:install-global');
          return;
        }
        if (conflict !== undefined) {
          expect(advice.canInstallWithoutTakeOver).toBe(false);
          expect(advice.requiresTakeOver).toBe(true);
          expect(advice.suggestedCommand).toContain('--take-over-global-runtime');
          expect(advice.suggestedCommand).toContain('--terminate-superseded');
          return;
        }
        expect(advice).toEqual({
          blockedReason: undefined,
          canInstallWithoutTakeOver: true,
          requiresTakeOver: false,
          suggestedCommand: 'bun run dev:install-global -- --terminate-superseded',
        });
      }),
      {numRuns: 64},
    );
  });
});
