import {symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {Effect} from 'effect';
import {
  ResourceAlreadyExists,
  ResourceConflict,
  ResourcePathUnsafe,
  ResourceStore,
} from '../../src/effect/resource-store.js';
import {loadRecallIndex} from '../../src/recall/index.js';
import {InvalidResourceId, parseResourceId} from '../../src/storage/resource-id.js';
import {mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('ResourceId', () => {
  it('canonicalizes compatibility aliases without changing viking URI identity', () => {
    expect(parseResourceId('threadnote://resources/repos/threadnote/guide%20file.md#heading')).toEqual({
      anchor: 'heading',
      canonicalUri: 'viking://resources/repos/threadnote/guide%20file.md#heading',
      inputScheme: 'threadnote',
      namespace: 'resources',
      segments: ['repos', 'threadnote', 'guide file.md'],
    });
  });

  it.each([
    'file:///tmp/memory.md',
    'viking://resources/../escape.md',
    'viking://resources/%2e%2e/escape.md',
    'viking://resources/folder%2Fescape.md',
    'viking://resources/folder\\escape.md',
    'viking://resources/CON',
    'viking://resources/trailing.',
    'viking://resources/a//b',
    'viking://resources/a?query=unsafe',
  ])('rejects unsafe identifier %s', value => {
    expect(() => parseResourceId(value)).toThrow(InvalidResourceId);
  });

  it.prop(
    'round-trips portable generated segments',
    {
      segment: FC.string({maxLength: 30, minLength: 1}).filter(
        value =>
          value === value.trim() &&
          value === value.normalize('NFC') &&
          !/[<>:"|?*\\/#%]/.test(value) &&
          !/[ .]$/.test(value) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value) &&
          !['.', '..'].includes(value.toLowerCase()) &&
          [...value].every(character => character.codePointAt(0)! > 0x1f),
      ),
    },
    ({segment}) => {
      const parsed = parseResourceId(`viking://resources/${encodeURIComponent(segment)}`);
      expect(parsed.segments).toEqual([segment]);
      expect(parseResourceId(parsed.canonicalUri)).toEqual(parsed);
    },
    {fastCheck: {numRuns: 50}},
  );
});

describe('native ResourceStore', () => {
  const location = (home: string) => ({account: 'local', home, user: 'test-user'});

  it('atomically creates, reads, compares, replaces, lists, greps, and removes resources', async () => {
    const home = await mkdtemp('threadnote-resource-store-');
    try {
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          const uri = 'viking://user/test-user/memories/durable/projects/threadnote/storage.md';
          const created = yield* store.write(location(home), uri, '# Storage\n\nfirst value', {mode: 'create'});

          expect(created.uri).toBe(uri);
          expect(yield* store.read(location(home), uri)).toBe('# Storage\n\nfirst value');
          expect((yield* store.stat(location(home), uri)).type).toBe('file');
          expect(
            (yield* store.list(location(home), 'viking://user/test-user/memories', {recursive: true})).map(
              entry => entry.uri,
            ),
          ).toContain(uri);
          expect(
            (yield* store.glob(location(home), 'viking://user/test-user/memories', '**/*.md')).map(entry => entry.uri),
          ).toContain(uri);
          expect(yield* store.grep(location(home), 'viking://user/test-user/memories', 'FIRST')).toEqual([
            {line: 3, text: 'first value', uri},
          ]);
          expect(
            yield* store.grepMany(location(home), 'viking://user/test-user/memories', ['storage', 'FIRST']),
          ).toEqual([
            {line: 1, term: 'storage', text: '# Storage', uri},
            {line: 3, term: 'FIRST', text: 'first value', uri},
          ]);

          const replaced = yield* store.write(location(home), uri, '# Storage\n\nsecond value', {
            expectedFingerprint: created.fingerprint,
            mode: 'replace',
          });
          expect(replaced.fingerprint).not.toBe(created.fingerprint);
          expect(yield* store.read(location(home), uri)).toContain('second value');

          const conflict = yield* Effect.flip(
            store.write(location(home), uri, 'third value', {
              expectedFingerprint: created.fingerprint,
              mode: 'replace',
            }),
          );
          expect(conflict).toBeInstanceOf(ResourceConflict);

          yield* store.remove(location(home), uri);
          expect(
            (yield* store.list(location(home), 'viking://user/test-user/memories', {recursive: true})).some(
              entry => entry.uri === uri,
            ),
          ).toBe(false);
        }),
      );
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('rejects create conflicts and portable case-fold collisions', async () => {
    const home = await mkdtemp('threadnote-resource-collision-');
    try {
      const program = Effect.gen(function* () {
        const store = yield* ResourceStore;
        const upper = 'viking://resources/repos/threadnote/Alpha.md';
        yield* store.write(location(home), upper, 'one', {mode: 'create'});
        expect(yield* Effect.flip(store.write(location(home), upper, 'two', {mode: 'create'}))).toBeInstanceOf(
          ResourceAlreadyExists,
        );
        expect(
          yield* Effect.flip(
            store.write(location(home), 'viking://resources/repos/threadnote/alpha.md', 'two', {mode: 'create'}),
          ),
        ).toBeInstanceOf(ResourcePathUnsafe);
      });
      await runEffect(program);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('invalidates a warm recall index after a canonical mutation', async () => {
    const home = await mkdtemp('threadnote-resource-index-invalidation-');
    try {
      const config = {account: 'local', agentContextHome: home, user: 'test-user'};
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          expect(yield* loadRecallIndex(config, {includeInactive: false})).toEqual([]);
          const uri = 'viking://resources/repos/threadnote/new-resource.md';
          yield* store.write(location(home), uri, '# New resource\n\nmutation-invalidation-anchor', {
            mode: 'create',
          });

          const refreshed = yield* loadRecallIndex(config, {
            includeInactive: false,
            query: 'mutation-invalidation-anchor',
          });
          expect(refreshed.map(candidate => candidate.uri)).toContain(uri);
        }),
      );
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('does not reuse a warm candidate after a same-size replacement with preserved timestamps', async () => {
    const home = await mkdtemp('threadnote-resource-index-replacement-');
    try {
      const config = {account: 'local', agentContextHome: home, user: 'test-user'};
      const uri = 'viking://resources/repos/threadnote/replaced-resource.md';
      const resourcePath = join(
        home,
        'data',
        'viking',
        'local',
        'resources',
        'repos',
        'threadnote',
        'replaced-resource.md',
      );
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          yield* store.write(location(home), uri, '# First\n\nalpha-42', {mode: 'create'});
          expect((yield* loadRecallIndex(config, {includeInactive: false}))[0]?.text).toContain('alpha-42');
        }),
      );
      const original = await stat(resourcePath);
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          yield* store.write(location(home), uri, '# Other\n\nomega-99', {mode: 'replace'});
        }),
      );
      await utimes(resourcePath, original.mtimeMs, original.mtimeMs);
      const refreshed = await runEffect(
        loadRecallIndex(config, {
          includeInactive: false,
          query: 'omega-99',
        }),
      );
      expect(refreshed[0]?.text).toContain('omega-99');
      expect(refreshed[0]?.text).not.toContain('alpha-42');
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('keeps committed mutations successful when derived-index invalidation fails', async () => {
    const home = await mkdtemp('threadnote-resource-index-failure-');
    try {
      await writeFile(join(home, 'cache'), 'blocks the derived cache directory');
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          const uri = 'viking://resources/repos/threadnote/committed.md';
          yield* store.write(location(home), uri, 'committed despite cache failure', {mode: 'create'});
          expect(yield* store.read(location(home), uri)).toBe('committed despite cache failure');
          yield* store.remove(location(home), uri);
          expect(yield* Effect.exit(store.read(location(home), uri))).toMatchObject({_tag: 'Failure'});
        }),
      );
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('applies a bulk mutation set behind one public invalidation boundary', async () => {
    const home = await mkdtemp('threadnote-resource-batch-');
    try {
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          yield* store.mutate(location(home), [
            {
              content: 'first batch resource',
              options: {mode: 'upsert'},
              type: 'write',
              uri: 'viking://resources/repos/threadnote/first.md',
            },
            {
              content: 'second batch resource',
              options: {mode: 'upsert'},
              type: 'write',
              uri: 'viking://resources/repos/threadnote/second.md',
            },
          ]);
          expect(yield* store.read(location(home), 'viking://resources/repos/threadnote/first.md')).toContain('first');
          expect(yield* store.read(location(home), 'viking://resources/repos/threadnote/second.md')).toContain(
            'second',
          );
        }),
      );
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it.runIf(process.platform !== 'win32')('rejects a symlink escape inside the canonical tree', async () => {
    const home = await mkdtemp('threadnote-resource-symlink-');
    const outside = await mkdtemp('threadnote-resource-outside-');
    try {
      const resources = join(home, 'data', 'viking', 'local', 'resources');
      await mkdir(resources, {recursive: true});
      await writeFile(join(outside, 'secret.md'), 'outside');
      await symlink(outside, join(resources, 'escape'));

      await expect(
        runEffect(
          Effect.gen(function* () {
            const store = yield* ResourceStore;
            return yield* store.read(location(home), 'viking://resources/escape/secret.md');
          }),
        ),
      ).rejects.toBeInstanceOf(ResourcePathUnsafe);
    } finally {
      await rm(home, {force: true, recursive: true});
      await rm(outside, {force: true, recursive: true});
    }
  });

  it.runIf(process.platform !== 'win32')('rejects a symlinked account storage root', async () => {
    const home = await mkdtemp('threadnote-resource-account-symlink-');
    const outside = await mkdtemp('threadnote-resource-account-outside-');
    try {
      await mkdir(join(home, 'data', 'viking'), {recursive: true});
      await symlink(outside, join(home, 'data', 'viking', 'local'));
      const destination = join(outside, 'resources', 'repos', 'threadnote', 'redirected.md');

      await expect(
        runEffect(
          Effect.gen(function* () {
            const store = yield* ResourceStore;
            return yield* store.write(
              location(home),
              'viking://resources/repos/threadnote/redirected.md',
              'must not escape',
              {mode: 'create'},
            );
          }),
        ),
      ).rejects.toBeInstanceOf(ResourcePathUnsafe);
      await expect(readFile(destination, 'utf8')).rejects.toThrow();
    } finally {
      await rm(home, {force: true, recursive: true});
      await rm(outside, {force: true, recursive: true});
    }
  });
});
