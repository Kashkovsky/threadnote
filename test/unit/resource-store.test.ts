import {symlink, writeFile as writeFileBytes} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {Effect, FileSystem, Option} from 'effect';
import {
  ResourceAlreadyExists,
  ResourceConflict,
  ResourceIoFailed,
  ResourcePathUnsafe,
  ResourceStore,
  resourceMutationLockFailureMessage,
} from '../../src/effect/resource-store.js';
import {loadRecallExactMatches, loadRecallIndex} from '../../src/recall/index.js';
import {InvalidResourceId, parseResourceId} from '../../src/storage/resource-id.js';
import {mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('ResourceId', () => {
  it('keeps threadnote URIs canonical', () => {
    expect(parseResourceId('threadnote://resources/repos/threadnote/guide%20file.md#heading')).toEqual({
      anchor: 'heading',
      canonicalUri: 'threadnote://resources/repos/threadnote/guide%20file.md#heading',
      inputScheme: 'threadnote',
      namespace: 'resources',
      segments: ['repos', 'threadnote', 'guide file.md'],
    });
  });

  it('accepts a legacy scheme only as an input alias and emits a threadnote URI', () => {
    expect(parseResourceId('viking://resources/repos/threadnote/guide.md')).toMatchObject({
      canonicalUri: 'threadnote://resources/repos/threadnote/guide.md',
      inputScheme: 'viking',
    });
  });

  it.each([
    'file:///tmp/memory.md',
    'threadnote://resources/../escape.md',
    'threadnote://resources/%2e%2e/escape.md',
    'threadnote://resources/folder%2Fescape.md',
    'threadnote://resources/folder\\escape.md',
    'threadnote://resources/CON',
    'threadnote://resources/trailing.',
    'threadnote://resources/a//b',
    'threadnote://resources/a?query=unsafe',
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
      const parsed = parseResourceId(`threadnote://resources/${encodeURIComponent(segment)}`);
      expect(parsed.segments).toEqual([segment]);
      expect(parseResourceId(parsed.canonicalUri)).toEqual(parsed);
    },
    {fastCheck: {numRuns: 50}},
  );
});

describe('native ResourceStore', () => {
  const location = (home: string) => ({account: 'local', home, user: 'test-user'});

  it('reports privacy-safe lock ownership and bounded recovery guidance', () => {
    const uri = 'threadnote://resources/repos/threadnote/locked.md';
    const message = resourceMutationLockFailureMessage(uri, 4242);

    expect(message).toContain(uri);
    expect(message).toContain('Local process 4242');
    expect(message).toContain('threadnote processes');
    expect(message).toContain('threadnote doctor --dry-run');
    expect(message).not.toContain('/locks/');
    expect(message).not.toContain('token');
  });

  it('atomically creates, reads, compares, replaces, lists, greps, and removes resources', async () => {
    const home = await mkdtemp('threadnote-resource-store-');
    try {
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/storage.md';
          const content = '# Storage\n\nfirst value';
          const created = yield* store.write(location(home), uri, content, {mode: 'create'});

          expect(created.uri).toBe(uri);
          expect(yield* store.read(location(home), uri)).toBe(content);
          expect(yield* store.readBounded(location(home), uri, Buffer.byteLength(content) - 1)).toEqual({
            truncated: true,
          });
          expect(yield* store.readBounded(location(home), uri, Buffer.byteLength(content))).toEqual({
            content,
            truncated: false,
          });
          const bomUri = 'threadnote://resources/repos/threadnote/bom.txt';
          const bomContent = '\uFEFFpreserved byte-order mark';
          yield* store.write(location(home), bomUri, bomContent, {mode: 'create'});
          expect(yield* store.readBounded(location(home), bomUri, Buffer.byteLength(bomContent))).toEqual({
            content: bomContent,
            truncated: false,
          });
          expect((yield* store.stat(location(home), uri)).type).toBe('file');
          expect(
            (yield* store.list(location(home), 'threadnote://user/test-user/memories', {recursive: true})).map(
              entry => entry.uri,
            ),
          ).toContain(uri);
          expect(
            (yield* store.glob(location(home), 'threadnote://user/test-user/memories', '**/*.md')).map(
              entry => entry.uri,
            ),
          ).toContain(uri);
          expect(yield* store.grep(location(home), 'threadnote://user/test-user/memories', 'FIRST')).toEqual([
            {line: 3, text: 'first value', uri},
          ]);
          expect(
            yield* store.grepMany(location(home), 'threadnote://user/test-user/memories', ['storage', 'FIRST']),
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
          yield* store.remove(location(home), bomUri);
          expect(
            (yield* store.list(location(home), 'threadnote://user/test-user/memories', {recursive: true})).some(
              entry => entry.uri === uri,
            ),
          ).toBe(false);
        }),
      );
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('rejects invalid UTF-8 instead of returning replacement text from a bounded read', async () => {
    const home = await mkdtemp('threadnote-resource-utf8-');
    const uri = 'threadnote://resources/repos/threadnote/invalid-utf8.txt';
    try {
      const resourceDirectory = join(home, 'data', 'local', 'resources', 'repos', 'threadnote');
      await mkdir(resourceDirectory, {recursive: true});
      await writeFileBytes(join(resourceDirectory, 'invalid-utf8.txt'), Uint8Array.of(0xc3, 0x28));

      const failure = await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          return yield* Effect.flip(store.readBounded(location(home), uri, 100));
        }),
      );

      expect(failure).toBeInstanceOf(ResourceIoFailed);
      expect(failure).toMatchObject({operation: 'read', uri});
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('fails closed when a custom bounded-read filesystem omits file identity or modification clocks', async () => {
    const home = await mkdtemp('threadnote-resource-mtime-');
    const uri = 'threadnote://resources/repos/threadnote/no-mtime.txt';
    try {
      const resourceDirectory = join(home, 'data', 'local', 'resources', 'repos', 'threadnote');
      await mkdir(resourceDirectory, {recursive: true});
      await writeFile(join(resourceDirectory, 'no-mtime.txt'), 'bounded content');

      for (const omitted of ['inode', 'mtime'] as const) {
        const failure = await runEffect(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const withoutIdentity = (info: FileSystem.File.Info): FileSystem.File.Info => ({
              ...info,
              ...(omitted === 'inode' ? {ino: Option.none()} : {mtime: Option.none()}),
            });
            const customFs = FileSystem.FileSystem.of({
              ...fs,
              open: (filePath, options) =>
                fs.open(filePath, options).pipe(
                  Effect.map(opened => ({
                    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
                    fd: opened.fd,
                    read: buffer => opened.read(buffer),
                    readAlloc: size => opened.readAlloc(size),
                    seek: (offset, from) => opened.seek(offset, from),
                    stat: opened.stat.pipe(Effect.map(withoutIdentity)),
                    sync: opened.sync,
                    truncate: length => opened.truncate(length),
                    write: buffer => opened.write(buffer),
                    writeAll: buffer => opened.writeAll(buffer),
                  })),
                ),
              stat: filePath => fs.stat(filePath).pipe(Effect.map(withoutIdentity)),
            });
            const store = yield* ResourceStore.pipe(
              Effect.provide(ResourceStore.layerWith()),
              Effect.provideService(FileSystem.FileSystem, customFs),
            );
            return yield* Effect.flip(store.readBounded(location(home), uri, 100));
          }),
        );

        expect(failure, omitted).toBeInstanceOf(ResourcePathUnsafe);
      }
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('rejects create conflicts and portable case-fold collisions', async () => {
    const home = await mkdtemp('threadnote-resource-collision-');
    try {
      const program = Effect.gen(function* () {
        const store = yield* ResourceStore;
        const upper = 'threadnote://resources/repos/threadnote/Alpha.md';
        yield* store.write(location(home), upper, 'one', {mode: 'create'});
        expect(yield* Effect.flip(store.write(location(home), upper, 'two', {mode: 'create'}))).toBeInstanceOf(
          ResourceAlreadyExists,
        );
        expect(
          yield* Effect.flip(
            store.write(location(home), 'threadnote://resources/repos/threadnote/alpha.md', 'two', {mode: 'create'}),
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
          const uri = 'threadnote://resources/repos/threadnote/new-resource.md';
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
      const uri = 'threadnote://resources/repos/threadnote/replaced-resource.md';
      const resourcePath = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'replaced-resource.md');
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
      await utimes(resourcePath, new Date(original.mtimeMs), new Date(original.mtimeMs));
      const refreshed = await runEffect(
        loadRecallIndex(config, {
          includeInactive: false,
          query: 'omega-99',
        }),
      );
      expect(refreshed[0]?.text).toContain('omega-99');
      expect(refreshed[0]?.text).not.toContain('alpha-42');
      const scope = 'threadnote://resources/repos/threadnote';
      await expect(
        runEffect(
          loadRecallExactMatches(config, {
            includeInactive: false,
            terms: ['alpha-42'],
            uriScopes: [scope],
          }),
        ),
      ).resolves.toEqual([]);
      await expect(
        runEffect(
          loadRecallExactMatches(config, {
            includeInactive: false,
            terms: ['omega-99'],
            uriScopes: [scope],
          }),
        ),
      ).resolves.toEqual([{terms: ['omega-99'], uri}]);
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
          const uri = 'threadnote://resources/repos/threadnote/committed.md';
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

  it('classifies a protected remove failure as a remove error instead of lock contention', async () => {
    const home = await mkdtemp('threadnote-resource-remove-error-');
    try {
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          const parentUri = 'threadnote://resources/repos/threadnote/non-empty';
          yield* store.write(location(home), `${parentUri}/child.md`, 'child', {mode: 'create'});

          const failure = yield* Effect.flip(store.remove(location(home), parentUri));

          expect(failure).toBeInstanceOf(ResourceIoFailed);
          expect(failure).toMatchObject({operation: 'remove', uri: parentUri});
          expect(failure.message).toBe(`Resource remove failed for ${parentUri}.`);
          expect(failure.message).not.toContain('lock');
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
              uri: 'threadnote://resources/repos/threadnote/first.md',
            },
            {
              content: 'second batch resource',
              options: {mode: 'upsert'},
              type: 'write',
              uri: 'threadnote://resources/repos/threadnote/second.md',
            },
          ]);
          expect(yield* store.read(location(home), 'threadnote://resources/repos/threadnote/first.md')).toContain(
            'first',
          );
          expect(yield* store.read(location(home), 'threadnote://resources/repos/threadnote/second.md')).toContain(
            'second',
          );
        }),
      );
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('serializes recursive parent removal with descendant writes across store instances', async () => {
    const home = await mkdtemp('threadnote-resource-parent-lock-');
    const parentUri = 'threadnote://resources/repos/threadnote/locked-parent';
    const childUri = `${parentUri}/child.md`;
    const lockPath = join(home, 'locks', 'resources', 'local', 'mutations.lock');
    try {
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          yield* store.write(location(home), childUri, 'before', {mode: 'create'});
        }),
      );
      const completionOrder: string[] = [];
      let signalRemoveContention = () => {};
      let signalWriteContention = () => {};
      const removeContended = new Promise<void>(resolve => {
        signalRemoveContention = resolve;
      });
      const writeContended = new Promise<void>(resolve => {
        signalWriteContention = resolve;
      });
      const layer = ResourceStore.layerWith({
        onMutationLockCompleted: event =>
          Effect.sync(() => {
            if (event.uri === parentUri) completionOrder.push('remove');
            if (event.uri === childUri) completionOrder.push('write');
          }),
        onMutationLockContention: event =>
          Effect.sync(() => {
            if (event.uri === parentUri) signalRemoveContention();
            if (event.uri === childUri) signalWriteContention();
          }),
      });
      const [removeStore, writeStore] = await Promise.all([
        runEffect(ResourceStore.pipe(Effect.provide(layer))),
        runEffect(ResourceStore.pipe(Effect.provide(layer))),
      ]);

      await mkdir(join(home, 'locks', 'resources', 'local'), {recursive: true});
      await writeFile(lockPath, `${process.pid}:test-barrier\n`);
      const remove = runEffect(removeStore.remove(location(home), parentUri, {recursive: true}));
      const write = runEffect(writeStore.write(location(home), childUri, 'after', {mode: 'upsert'}));

      await Promise.all([removeContended, writeContended]);
      await runEffect(
        writeStore.write({account: 'other', home, user: 'test-user'}, 'threadnote://resources/independent.md', 'ok', {
          mode: 'create',
        }),
      );
      await rm(lockPath, {force: true});
      await Promise.all([remove, write]);

      const child = await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          return yield* Effect.option(store.read(location(home), childUri));
        }),
      );
      expect(completionOrder).toHaveLength(2);
      if (completionOrder.at(-1) === 'write') {
        expect(child._tag).toBe('Some');
        if (child._tag === 'Some') expect(child.value).toBe('after');
      } else {
        expect(child._tag).toBe('None');
      }
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it.runIf(process.platform !== 'win32')('rejects a symlink escape inside the canonical tree', async () => {
    const home = await mkdtemp('threadnote-resource-symlink-');
    const outside = await mkdtemp('threadnote-resource-outside-');
    try {
      const resources = join(home, 'data', 'local', 'resources');
      await mkdir(resources, {recursive: true});
      await writeFile(join(outside, 'secret.md'), 'outside');
      await symlink(outside, join(resources, 'escape'));

      await expect(
        runEffect(
          Effect.gen(function* () {
            const store = yield* ResourceStore;
            return yield* store.read(location(home), 'threadnote://resources/escape/secret.md');
          }),
        ),
      ).rejects.toBeInstanceOf(ResourcePathUnsafe);
    } finally {
      await rm(home, {force: true, recursive: true});
      await rm(outside, {force: true, recursive: true});
    }
  });

  it.runIf(process.platform !== 'win32')(
    'recursively removes a subtree without following descendant symlinks',
    async () => {
      const home = await mkdtemp('threadnote-resource-recursive-symlink-');
      const outside = await mkdtemp('threadnote-resource-recursive-outside-');
      try {
        const subtree = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'retired');
        const outsideFile = join(outside, 'keep.md');
        await mkdir(subtree, {recursive: true});
        await writeFile(join(subtree, 'inside.md'), 'inside');
        await writeFile(outsideFile, 'outside');
        await symlink(outside, join(subtree, 'external'));

        await runEffect(
          Effect.gen(function* () {
            const store = yield* ResourceStore;
            yield* store.remove(location(home), 'threadnote://resources/repos/threadnote/retired', {recursive: true});
          }),
        );

        await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside');
        await expect(stat(subtree)).rejects.toThrow();
      } finally {
        await rm(home, {force: true, recursive: true});
        await rm(outside, {force: true, recursive: true});
      }
    },
  );

  it.runIf(process.platform !== 'win32')('rejects a symlinked account storage root', async () => {
    const home = await mkdtemp('threadnote-resource-account-symlink-');
    const outside = await mkdtemp('threadnote-resource-account-outside-');
    try {
      await mkdir(join(home, 'data'), {recursive: true});
      await symlink(outside, join(home, 'data', 'local'));
      const destination = join(outside, 'resources', 'repos', 'threadnote', 'redirected.md');

      await expect(
        runEffect(
          Effect.gen(function* () {
            const store = yield* ResourceStore;
            return yield* store.write(
              location(home),
              'threadnote://resources/repos/threadnote/redirected.md',
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
