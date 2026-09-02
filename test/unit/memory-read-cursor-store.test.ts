import * as BunServices from '@effect/platform-bun/BunServices';
import {Database} from 'bun:sqlite';
import {expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  memoryReadCursorNamespace,
  PersistentMemoryReadCursorStoreError,
  putPersistentMemoryReadCursor,
  takePersistentMemoryReadCursor,
} from '../../src/memory/read_cursor_store.js';
import {
  MEMORY_READ_CURSOR_TTL_MILLISECONDS,
  memoryReadCursorToken,
  memoryReadSourceHashes,
  type MemoryReadCursorState,
} from '../../src/memory/read_projection.js';

const CURSOR_DATABASE_RELATIVE_PATH = ['threadnote', 'mcp', 'read-context-cursors-v1.sqlite'] as const;

effectIt.effect('persists private opaque cursors for exactly ten minutes across store instances', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-read-cursors-'});
      const namespace = namespaceFor({});
      const now = 10_000;
      const usableCursor = memoryReadCursorToken('usable-private-cursor');
      const expiredCursor = memoryReadCursorToken('expired-private-cursor');
      const isolatedCursor = memoryReadCursorToken('namespace-private-cursor');
      const state = stateFor('primary');

      yield* putPersistentMemoryReadCursor(home, namespace, usableCursor, state, now);
      yield* putPersistentMemoryReadCursor(home, namespace, expiredCursor, state, now);
      yield* putPersistentMemoryReadCursor(home, namespace, isolatedCursor, state, now);

      expect(
        yield* takePersistentMemoryReadCursor(
          home,
          namespace,
          usableCursor,
          now + MEMORY_READ_CURSOR_TTL_MILLISECONDS - 1,
        ),
      ).toEqual(state);
      expect(yield* takePersistentMemoryReadCursor(home, namespace, usableCursor, now)).toBeUndefined();

      const otherNamespace = namespaceFor({user: 'other-user'});
      expect(yield* takePersistentMemoryReadCursor(home, otherNamespace, isolatedCursor, now)).toBeUndefined();
      expect(yield* takePersistentMemoryReadCursor(home, namespace, isolatedCursor, now)).toEqual(state);
      expect(
        yield* takePersistentMemoryReadCursor(
          home,
          namespace,
          expiredCursor,
          now + MEMORY_READ_CURSOR_TTL_MILLISECONDS,
        ),
      ).toBeUndefined();

      expect(usableCursor).toMatch(/^tnrc_[0-9a-f]{32}$/u);
      expect(usableCursor).not.toContain(state.uris[0]);
      const databasePath = path.join(home, ...CURSOR_DATABASE_RELATIVE_PATH);
      if (process.platform !== 'win32') {
        expect((yield* fs.stat(path.dirname(databasePath))).mode & 0o777).toBe(0o700);
        expect((yield* fs.stat(databasePath)).mode & 0o777).toBe(0o600);
      }
    }),
  ).pipe(provideTestLayer(BunServices.layer)),
);

effectIt.effect('isolates every authority dimension and fails closed on collisions and corrupt state', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-read-cursor-corruption-'});
      const namespaces = [
        namespaceFor({}),
        namespaceFor({account: 'other-account'}),
        namespaceFor({memoryRoot: 'threadnote://shared/team/memories', team: 'team'}),
        namespaceFor({toolName: 'read'}),
        namespaceFor({user: 'other-user'}),
      ];
      expect([...new Set(namespaces)]).toHaveLength(namespaces.length);
      expect(namespaces.every(namespace => /^[0-9a-f]{64}$/u.test(namespace))).toBe(true);

      const state = stateFor('collision');
      for (const options of [{ttlMilliseconds: MEMORY_READ_CURSOR_TTL_MILLISECONDS + 1}, {maximumEntries: 257}]) {
        const rejectedBound = yield* putPersistentMemoryReadCursor(
          home,
          namespaces[0],
          memoryReadCursorToken(JSON.stringify(options)),
          state,
          99,
          options,
        ).pipe(Effect.match({onFailure: error => error, onSuccess: () => undefined}));
        expect(rejectedBound).toBeInstanceOf(PersistentMemoryReadCursorStoreError);
      }
      const collisionCursor = memoryReadCursorToken('collision');
      yield* putPersistentMemoryReadCursor(home, namespaces[0], collisionCursor, state, 100);
      const collision = yield* putPersistentMemoryReadCursor(
        home,
        namespaces[0],
        collisionCursor,
        stateFor('replacement-must-not-win'),
        101,
      ).pipe(Effect.match({onFailure: error => error, onSuccess: () => undefined}));
      expect(collision).toBeInstanceOf(PersistentMemoryReadCursorStoreError);
      expect(yield* takePersistentMemoryReadCursor(home, namespaces[0], collisionCursor, 102)).toEqual(state);

      const corruptCursor = memoryReadCursorToken('corrupt');
      yield* putPersistentMemoryReadCursor(home, namespaces[0], corruptCursor, state, 200);
      const databasePath = path.join(home, ...CURSOR_DATABASE_RELATIVE_PATH);
      yield* Effect.sync(() => {
        const database = new Database(databasePath, {strict: true});
        try {
          database
            .query('UPDATE read_context_cursors SET state_json = ? WHERE namespace = ? AND token = ?')
            .run('{"version":1}', namespaces[0], corruptCursor);
        } finally {
          database.close();
        }
      });
      const corrupt = yield* takePersistentMemoryReadCursor(home, namespaces[0], corruptCursor, 201).pipe(
        Effect.match({onFailure: error => error, onSuccess: () => undefined}),
      );
      expect(corrupt).toBeInstanceOf(PersistentMemoryReadCursorStoreError);
      expect(yield* takePersistentMemoryReadCursor(home, namespaces[0], corruptCursor, 201)).toBeUndefined();
    }),
  ).pipe(provideTestLayer(BunServices.layer)),
);

effectIt.effect.prop(
  'matches a bounded global single-use TTL model across namespace and time interleavings',
  {
    steps: FC.array(
      FC.record({
        advanceMilliseconds: FC.integer({max: 12, min: 0}),
        putNamespace: FC.integer({max: 2, min: 0}),
        takeNamespace: FC.integer({max: 2, min: 0}),
        takeToken: FC.nat(40),
      }),
      {maxLength: 24, minLength: 1},
    ),
  },
  ({steps}) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-read-cursor-property-'});
        const namespaces = [namespaceFor({}), namespaceFor({toolName: 'read'}), namespaceFor({user: 'other-user'})];
        const capacity = 3;
        const ttlMilliseconds = 20;
        const model = new Map<
          string,
          {
            readonly createdAt: number;
            readonly expiresAt: number;
            readonly namespace: string;
            readonly state: MemoryReadCursorState;
            readonly token: string;
          }
        >();
        let now = 0;

        for (const [index, step] of steps.entries()) {
          now += step.advanceMilliseconds;
          pruneModel(model, now);
          const namespace = namespaces[step.putNamespace];
          const token = memoryReadCursorToken(`property-${index}`);
          const state = stateFor(`property-${index}`);
          yield* putPersistentMemoryReadCursor(home, namespace, token, state, now, {
            maximumEntries: capacity,
            ttlMilliseconds,
          });
          const insertedKey = modelKey(namespace, token);
          model.set(insertedKey, {createdAt: now, expiresAt: now + ttlMilliseconds, namespace, state, token});
          evictModelToCapacity(model, capacity, insertedKey);

          const targetIndex = step.takeToken % (index + 1);
          const targetToken = memoryReadCursorToken(`property-${targetIndex}`);
          const targetNamespace = namespaces[step.takeNamespace];
          pruneModel(model, now);
          const targetKey = modelKey(targetNamespace, targetToken);
          const expected = model.get(targetKey)?.state;
          model.delete(targetKey);
          expect(yield* takePersistentMemoryReadCursor(home, targetNamespace, targetToken, now)).toEqual(expected);

          const databasePath = path.join(home, ...CURSOR_DATABASE_RELATIVE_PATH);
          const count = yield* Effect.sync(() => {
            const database = new Database(databasePath, {readonly: true, strict: true});
            try {
              return Number(
                database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM read_context_cursors').get()
                  ?.count ?? 0,
              );
            } finally {
              database.close();
            }
          });
          expect(count).toBe(model.size);
          expect(count).toBeLessThanOrEqual(capacity);
        }
      }),
    ).pipe(provideTestLayer(BunServices.layer)),
  {fastCheck: {numRuns: 30}},
);

function namespaceFor(override: Partial<Parameters<typeof memoryReadCursorNamespace>[0]>): string {
  return memoryReadCursorNamespace({
    account: 'local',
    toolName: 'read_context',
    user: 'test-user',
    ...override,
  });
}

function stateFor(identity: string): MemoryReadCursorState {
  const resource = {text: `canonical ${identity}`, uri: `threadnote://test/${identity}.md`};
  return {
    mode: 'content',
    position: {characterOffset: Math.min(3, resource.text.length), resourceIndex: 0},
    sourceHashes: memoryReadSourceHashes([resource]),
    uris: [resource.uri],
  };
}

function modelKey(namespace: string, token: string): string {
  return `${namespace}:${token}`;
}

function pruneModel<Entry extends {readonly expiresAt: number}>(model: Map<string, Entry>, now: number): void {
  for (const [key, entry] of model) if (entry.expiresAt <= now) model.delete(key);
}

function evictModelToCapacity<
  Entry extends {
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly namespace: string;
    readonly token: string;
  },
>(model: Map<string, Entry>, capacity: number, insertedKey: string): void {
  const excess = Math.max(0, model.size - capacity);
  const victims = [...model.entries()]
    .filter(([key]) => key !== insertedKey)
    .sort(
      (left, right) =>
        left[1].createdAt - right[1].createdAt ||
        left[1].expiresAt - right[1].expiresAt ||
        left[1].token.localeCompare(right[1].token),
    )
    .slice(0, excess);
  for (const [key] of victims) model.delete(key);
}
