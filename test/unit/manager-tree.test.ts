import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {expect} from 'vitest';
import {emptyManagerTree, readManagerTreeRoot} from '../../src/manager/tree.js';

effectIt.effect('does not mistake a disappearing descendant for an absent Manager tree root', () =>
  Effect.gen(function* () {
    const missingDescendant = {reason: {_tag: 'NotFound'}} as const;
    const failure = yield* readManagerTreeRoot(
      Effect.void,
      Effect.fail(missingDescendant),
      emptyManagerTree('memories', 'threadnote://user/denys/memories'),
    ).pipe(Effect.flip);

    expect(failure).toBe(missingDescendant);
  }),
);
