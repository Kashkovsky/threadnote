import {BunFileSystem, BunPath} from '@effect/platform-bun';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {formatMemoryDocument} from '../../src/memory/document.js';
import {
  readGitBetaMemorySources,
  writeOperatorJsonExclusive,
  writeRemoteMemoryExportBundle,
} from '../../src/remote_memory/operator_files.js';
import {
  planGitBetaImport,
  materializeGitBetaImport,
  planRemoteMemoryExport,
} from '../../src/remote_memory/portability.js';

describe('remote memory portability filesystem boundaries', () => {
  effectIt.effect('reads a bounded Git beta tree and writes a verified export without overwriting a destination', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-portability-'});
        const source = path.join(root, 'source');
        const target = path.join(root, 'export');
        yield* fs.makeDirectory(path.join(source, 'durable', 'projects', 'threadnote'), {recursive: true});
        const content = memory('threadnote', 'decision', 'Portable decision.');
        yield* fs.writeFileString(path.join(source, 'durable', 'projects', 'threadnote', 'decision.md'), content);

        const sources = yield* readGitBetaMemorySources({directory: source, team: 'engineering', user: 'cloud-user'});
        expect(sources).toEqual([
          {
            content,
            sourceUri:
              'threadnote://user/cloud-user/memories/shared/engineering/durable/projects/threadnote/decision.md',
            version: 1,
          },
        ]);
        const plan = planGitBetaImport({
          aliasCompatibilityEndsAt: '2027-12-31T23:59:59.000Z',
          dryRun: false,
          records: sources,
          shareId: 'share-1',
        });
        const exportPlan = planRemoteMemoryExport(materializeGitBetaImport(plan, sources));
        yield* writeRemoteMemoryExportBundle(target, exportPlan);

        expect(yield* fs.readFileString(path.join(target, 'durable', 'projects', 'threadnote', 'decision.md'))).toBe(
          content,
        );
        const manifest = JSON.parse(yield* fs.readFileString(path.join(target, 'threadnote-export.v1.json'))) as {
          bundleDigest: string;
        };
        expect(manifest.bundleDigest).toBe(exportPlan.bundleDigest);
        const duplicate = yield* Effect.exit(writeRemoteMemoryExportBundle(target, exportPlan));
        expect(duplicate._tag).toBe('Failure');
      }),
    ).pipe(provideTestLayer(BunFileSystem.layer), provideTestLayer(BunPath.layer)),
  );

  effectIt.effect('does not follow source symlinks and writes operator JSON exclusively', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-portability-'});
        const source = path.join(root, 'source');
        const sourceWithLinkedAncestor = path.join(root, 'source-linked-ancestor');
        const linkedTree = path.join(root, 'linked-tree');
        const outside = path.join(root, 'outside.md');
        const output = path.join(root, 'receipt.json');
        yield* fs.makeDirectory(path.join(source, 'durable', 'projects', 'threadnote'), {recursive: true});
        yield* fs.writeFileString(outside, memory('threadnote', 'outside', 'Must not be followed.'));
        yield* fs.symlink(outside, path.join(source, 'durable', 'projects', 'threadnote', 'outside.md'));

        const scan = yield* Effect.exit(
          readGitBetaMemorySources({directory: source, team: 'engineering', user: 'cloud-user'}),
        );
        expect(scan._tag).toBe('Failure');

        yield* fs.makeDirectory(path.join(sourceWithLinkedAncestor), {recursive: true});
        yield* fs.makeDirectory(path.join(linkedTree, 'projects'), {recursive: true});
        yield* fs.symlink(linkedTree, path.join(sourceWithLinkedAncestor, 'durable'));
        const ancestorScan = yield* Effect.exit(
          readGitBetaMemorySources({
            directory: sourceWithLinkedAncestor,
            team: 'engineering',
            user: 'cloud-user',
          }),
        );
        expect(ancestorScan._tag).toBe('Failure');

        yield* writeOperatorJsonExclusive(output, {digest: sha256HexSync('fixture'), version: 1});
        const duplicate = yield* Effect.exit(writeOperatorJsonExclusive(output, {version: 2}));
        expect(duplicate._tag).toBe('Failure');
      }),
    ).pipe(provideTestLayer(BunFileSystem.layer), provideTestLayer(BunPath.layer)),
  );
});

function memory(project: string, topic: string, body: string): string {
  return formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      project,
      sourceAgentClient: 'cursor',
      status: 'active',
      timestamp: '2026-08-13T00:00:00.000Z',
      topic,
    },
    body,
  );
}
