import {expect, it} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as FC from 'effect/testing/FastCheck';
import {Cause, Effect, Exit, Fiber} from 'effect';
import {describe} from 'vitest';
import {MCP_RESOURCE_READ_MAX_BYTES, readThreadnoteMcpResource} from '../../src/effect/ai/mcp_resource.js';
import {ResourceStore, type ResourceStoreShape} from '../../src/effect/resource-store.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const config = {account: 'local', agentContextHome: '/unused', user: 'test-user'} as const;
const uri = 'threadnote://resources/bounded-resource.txt';

describe('MCP protocol resource reads', () => {
  it.effect('returns the bounded-read error when the store reports truncation', () =>
    Effect.gen(function* () {
      const store = resourceStore({
        readBounded: () => Effect.succeed({truncated: true}),
      });

      const exit = yield* readThreadnoteMcpResource(config, uri).pipe(
        Effect.provideService(ResourceStore, store),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(provideTestLayer(BunServices.layer)),
  );

  it.effect('preserves cancellation while the authoritative resource read is pending', () =>
    Effect.gen(function* () {
      const store = resourceStore({readBounded: () => Effect.never});
      const fiber = yield* readThreadnoteMcpResource(config, uri).pipe(
        Effect.provideService(ResourceStore, store),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    }).pipe(provideTestLayer(BunServices.layer)),
  );

  it.effect.prop(
    'enforces the UTF-8 byte bound after every read even when metadata was stale',
    {
      character: FC.constantFrom('a', 'é', '😀'),
      delta: FC.integer({max: 8, min: -8}),
    },
    ({character, delta}) => {
      const targetBytes = MCP_RESOURCE_READ_MAX_BYTES + delta;
      const characterBytes = Buffer.byteLength(character, 'utf8');
      const count = Math.floor(targetBytes / characterBytes);
      const content = `${character.repeat(count)}${'x'.repeat(targetBytes - count * characterBytes)}`;
      const store = resourceStore({
        // Deliberately violate the store's bounded-read contract so this
        // property exercises the protocol boundary's independent byte check.
        readBounded: () => Effect.succeed({content, truncated: false}),
      });
      return readThreadnoteMcpResource(config, uri).pipe(
        Effect.provideService(ResourceStore, store),
        Effect.exit,
        Effect.tap(exit =>
          Effect.sync(() => {
            expect(Buffer.byteLength(content, 'utf8')).toBe(targetBytes);
            expect(Exit.isSuccess(exit)).toBe(targetBytes <= MCP_RESOURCE_READ_MAX_BYTES);
          }),
        ),
        Effect.asVoid,
        provideTestLayer(BunServices.layer),
      );
    },
    {fastCheck: {numRuns: 36}},
  );
});

function resourceStore(options: {readonly readBounded: ResourceStoreShape['readBounded']}): ResourceStoreShape {
  return ResourceStore.of({
    readBounded: options.readBounded,
  } as unknown as ResourceStoreShape);
}
