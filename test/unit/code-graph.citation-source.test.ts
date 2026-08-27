import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {codeGraphCitationSourceKey, readCodeGraphCitationSources} from '../../src/code_graph/citation_source.js';
import {codeGraphCommittedFileContentHash} from '../../src/code_graph/content_identity.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {StandaloneBrokerLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const encoder = new TextEncoder();

describe('code graph citation source reads', () => {
  effectIt.effect('batches exact commit bytes when a clean/smudge filter changes checkout spelling', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-source-'});
      const repositoryRoot = yield* fs.realPath(root);
      yield* fs.makeDirectory(path.join(root, 'src'), {recursive: true});
      const committed = encoder.encode('export const value = 1;\n');
      const checkout = encoder.encode('export const value = 1;\r\n');
      yield* fs.writeFile(path.join(root, 'src', 'value.ts'), checkout);
      const expectedContentHash = codeGraphCommittedFileContentHash('sha1', committed);
      const blobId = gitBlobId('sha1', committed);
      const sourceCommit = '1'.repeat(40);
      const base = yield* CommandExecutor;
      let gitReads = 0;
      const observed = CommandExecutor.of({
        ...base,
        executeBytes: (executable, args, options) =>
          Effect.sync(() => {
            gitReads += 1;
            expect(executable).toBe('git');
            expect(options?.env?.GIT_NO_LAZY_FETCH).toBe('1');
            if (args.includes('--batch-check')) {
              expect(args).toEqual(['-C', repositoryRoot, 'cat-file', '--batch-check', '-z']);
              expect(options?.input).toEqual(encoder.encode(`${sourceCommit}:src/value.ts\0`));
              return {exitCode: 0, stderr: '', stdout: encoder.encode(`${blobId} blob ${committed.byteLength}\n`)};
            }
            expect(args).toEqual(['-C', repositoryRoot, 'cat-file', '--batch', '-z']);
            expect(options?.input).toEqual(encoder.encode(`${blobId}\0`));
            return {exitCode: 0, stderr: '', stdout: batchBlob(blobId, committed)};
          }),
      });

      const committedSource = {expectedContentHash, repositoryPath: 'src/value.ts', requireBytes: true};
      const committedResult = yield* readCodeGraphCitationSources({
        objectFormat: 'sha1',
        repositoryRoot,
        sourceCommit,
        sources: [committedSource],
      }).pipe(Effect.provideService(CommandExecutor, observed));
      expect(committedResult.get(codeGraphCitationSourceKey(committedSource))).toEqual(committed);
      expect(gitReads).toBe(2);

      const fileOnlySource = {...committedSource, requireBytes: false};
      const fileOnlyResult = yield* readCodeGraphCitationSources({
        objectFormat: 'sha1',
        repositoryRoot,
        sourceCommit,
        sources: [fileOnlySource],
      }).pipe(Effect.provideService(CommandExecutor, observed));
      expect(fileOnlyResult.get(codeGraphCitationSourceKey(fileOnlySource))).toEqual(new Uint8Array());
      expect(gitReads).toBe(3);

      const checkoutSource = {
        expectedContentHash: sha256HexSync(checkout),
        repositoryPath: 'src/value.ts',
        requireBytes: true,
      };
      const checkoutResult = yield* readCodeGraphCitationSources({
        objectFormat: 'sha1',
        repositoryRoot,
        sourceCommit,
        sources: [checkoutSource],
      }).pipe(Effect.provideService(CommandExecutor, observed));
      expect(checkoutResult.get(codeGraphCitationSourceKey(checkoutSource))).toEqual(checkout);
      expect(gitReads).toBe(3);
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('does not fetch a missing promised blob while validation abstains', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-missing-'});
      const repositoryRoot = yield* fs.realPath(root);
      const sourceCommit = '2'.repeat(40);
      const source = {
        expectedContentHash: codeGraphCommittedFileContentHash('sha1', encoder.encode('missing\n')),
        repositoryPath: 'src/missing.ts',
        requireBytes: true,
      };
      const base = yield* CommandExecutor;
      let gitReads = 0;
      const observed = CommandExecutor.of({
        ...base,
        executeBytes: (_executable, args, options) =>
          Effect.sync(() => {
            gitReads += 1;
            expect(args).toContain('--batch-check');
            expect(options?.env?.GIT_NO_LAZY_FETCH).toBe('1');
            return {
              exitCode: 0,
              stderr: '',
              stdout: encoder.encode(`${sourceCommit}:${source.repositoryPath} missing\n`),
            };
          }),
      });

      const result = yield* readCodeGraphCitationSources({
        objectFormat: 'sha1',
        repositoryRoot,
        sourceCommit,
        sources: [source],
      }).pipe(Effect.provideService(CommandExecutor, observed));
      expect(result.has(codeGraphCitationSourceKey(source))).toBe(false);
      expect(gitReads).toBe(1);
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('admits long missing-path inspection output within the bounded command budget', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-long-missing-'});
      const repositoryRoot = yield* fs.realPath(root);
      const sourceCommit = '4'.repeat(40);
      const sources = Array.from({length: 32}, (_, index) => ({
        expectedContentHash: 'a'.repeat(64),
        repositoryPath: `src/${String(index).padStart(2, '0')}-${'x'.repeat(2_800)}.ts`,
        requireBytes: false,
      }));
      const stdout = encoder.encode(
        sources.map(source => `${sourceCommit}:${source.repositoryPath} missing\n`).join(''),
      );
      const base = yield* CommandExecutor;
      const observed = CommandExecutor.of({
        ...base,
        executeBytes: (_executable, args, options) =>
          Effect.sync(() => {
            expect(args).toContain('--batch-check');
            expect(options?.maxOutputBytes).toBeGreaterThanOrEqual(stdout.byteLength);
            return {exitCode: 0, stderr: '', stdout};
          }),
      });

      const result = yield* readCodeGraphCitationSources({
        objectFormat: 'sha1',
        repositoryRoot,
        sourceCommit,
        sources,
      }).pipe(Effect.provideService(CommandExecutor, observed));
      expect(result.size).toBe(0);
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('charges exact commit sizes after mismatched worktree reservations are released', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-budget-'});
      const repositoryRoot = yield* fs.realPath(root);
      yield* fs.makeDirectory(path.join(root, 'src'), {recursive: true});
      yield* fs.writeFile(path.join(root, 'src', 'a.ts'), encoder.encode('x'));
      yield* fs.writeFile(path.join(root, 'src', 'b.ts'), encoder.encode('y'));
      const committed = [encoder.encode('abc'), encoder.encode('def')];
      const sourceCommit = '3'.repeat(40);
      const sources = committed.map((bytes, index) => ({
        expectedContentHash: codeGraphCommittedFileContentHash('sha1', bytes),
        repositoryPath: `src/${index === 0 ? 'a' : 'b'}.ts`,
        requireBytes: true,
      }));
      const blobIds = committed.map(bytes => gitBlobId('sha1', bytes));
      const base = yield* CommandExecutor;
      const observed = CommandExecutor.of({
        ...base,
        executeBytes: (_executable, args, options) =>
          Effect.sync(() => {
            if (args.includes('--batch-check')) {
              expect(options?.input).toEqual(
                encoder.encode(sources.map(source => `${sourceCommit}:${source.repositoryPath}\0`).join('')),
              );
              return {
                exitCode: 0,
                stderr: '',
                stdout: encoder.encode(blobIds.map(blobId => `${blobId} blob 3\n`).join('')),
              };
            }
            expect(args).toContain('--batch');
            expect(options?.input).toEqual(encoder.encode(`${blobIds[0]}\0`));
            return {exitCode: 0, stderr: '', stdout: batchBlob(blobIds[0]!, committed[0]!)};
          }),
      });

      const result = yield* readCodeGraphCitationSources({
        objectFormat: 'sha1',
        repositoryRoot,
        retainedBytesLimit: 4,
        sourceCommit,
        sources,
      }).pipe(Effect.provideService(CommandExecutor, observed));
      expect(result.get(codeGraphCitationSourceKey(sources[0]!))).toEqual(committed[0]);
      expect(result.has(codeGraphCitationSourceKey(sources[1]!))).toBe(false);
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );
});

function gitBlobId(algorithm: 'sha1' | 'sha256', bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher(algorithm);
  hasher.update(`blob ${bytes.byteLength}\0`);
  hasher.update(bytes);
  return hasher.digest('hex');
}

function batchBlob(blobId: string, bytes: Uint8Array): Uint8Array {
  const header = encoder.encode(`${blobId} blob ${bytes.byteLength}\n`);
  const output = new Uint8Array(header.byteLength + bytes.byteLength + 1);
  output.set(header);
  output.set(bytes, header.byteLength);
  output[output.byteLength - 1] = 0x0a;
  return output;
}
