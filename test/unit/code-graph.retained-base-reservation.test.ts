import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, beforeEach, describe, expect} from 'vitest';
import {
  CODE_GRAPH_RETAINED_BASE_HOME_MAXIMUM,
  reserveCodeGraphRetainedBase,
} from '../../src/code_graph/retained_base_reservation.js';
import {SystemInfo} from '../../src/effect/system.js';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';

const RETAINED_BASE_TEST_LAYER = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));

describe('code graph retained-base home reservations', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp('threadnote-retained-base-');
  });

  afterEach(async () => {
    await rm(home, {force: true, recursive: true});
  });

  effectIt.effect('deduplicates a physical base, caps the home at two, and admits after expiry', () =>
    Effect.gen(function* () {
      const reserve = (physicalSnapshotId: string) =>
        reserveCodeGraphRetainedBase({durationMilliseconds: 1_000, physicalSnapshotId, threadnoteHome: home});

      expect(CODE_GRAPH_RETAINED_BASE_HOME_MAXIMUM).toBe(2);
      expect(yield* reserve('base-a')).toBe(true);
      expect(yield* reserve('base-a')).toBe(true);
      expect(yield* reserve('base-b')).toBe(true);
      expect(yield* reserve('base-c')).toBe(false);

      yield* TestClock.adjust(1_001);
      expect(yield* reserve('base-c')).toBe(true);
    }).pipe(provideTestLayer(RETAINED_BASE_TEST_LAYER)),
  );
});
