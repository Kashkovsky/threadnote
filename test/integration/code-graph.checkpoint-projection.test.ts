import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '../helpers/node-child-process.js';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '../helpers/node-fs.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {codeGraphCheckpointAbiInputV1} from '../../src/code_graph/checkpoint/compatibility.js';
import {
  CodeGraphCheckpointProjectionError,
  projectCodeGraphCheckpointV1,
} from '../../src/code_graph/checkpoint/projection.js';
import {
  compareCodeGraphCheckpointRecords,
  type CodeGraphCheckpointMetadataV1,
  type CodeGraphCheckpointRecordV1,
} from '../../src/code_graph/checkpoint/schema.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';

interface ProjectionCapture {
  readonly metadata: CodeGraphCheckpointMetadataV1;
  readonly records: readonly CodeGraphCheckpointRecordV1[];
}

describe('code graph checkpoint projection', () => {
  effectIt.effect(
    'projects one clean ready snapshot deterministically across page boundaries',
    () => {
      let fixtureRoot: string | undefined;
      return Effect.gen(function* () {
        const fixture = createRepository();
        fixtureRoot = fixture.root;
        const indexer = yield* CodeGraphIndexer;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const indexed = yield* indexer.index({cwd: fixture.repository, threadnoteHome: fixture.home});
        const databasePath = codeGraphLayout(
          path,
          fixture.home,
          indexed.identity.checkoutId,
          indexed.identity.worktreeId,
        ).databasePath;
        const provenance = yield* store.snapshotPackProvenance(databasePath, indexed.snapshot.id);
        expect(provenance).toBeDefined();
        const abi = codeGraphCheckpointAbiInputV1(provenance!);

        const capture = (pageSize: number) => {
          let metadata: CodeGraphCheckpointMetadataV1 | undefined;
          const records: CodeGraphCheckpointRecordV1[] = [];
          return projectCodeGraphCheckpointV1({
            abi,
            databasePath,
            identity: indexed.identity,
            pageSize,
            snapshotId: indexed.snapshot.id,
            writeMetadata: value => Effect.sync(() => (metadata = value)),
            writeRecords: page => Effect.sync(() => records.push(...page)),
          }).pipe(
            Effect.map(summary => {
              expect(metadata).toBeDefined();
              expect(summary.counts.file).toBe(indexed.snapshot.fileCount);
              expect(summary.counts['file-fact']).toBe(summary.counts.file);
              return {metadata: metadata!, records} satisfies ProjectionCapture;
            }),
          );
        };

        const oneRowPages = yield* capture(1);
        const maximumPages = yield* capture(1_000);
        expect(oneRowPages).toEqual(maximumPages);
        for (let index = 1; index < oneRowPages.records.length; index += 1) {
          expect(
            compareCodeGraphCheckpointRecords(oneRowPages.records[index - 1], oneRowPages.records[index]),
          ).toBeLessThan(0);
        }
        expect(oneRowPages.metadata.reuse?.inventory).toBeDefined();
        expect(oneRowPages.metadata.reuse?.inventory).not.toHaveProperty('environmentFingerprint');
        for (const file of oneRowPages.metadata.reuse?.inventory?.attributionFiles ?? []) {
          expect(file).not.toHaveProperty('content');
          expect(file.blobSize).toBeGreaterThanOrEqual(file.size);
        }

        writeFileSync(join(fixture.repository, 'src', 'math.ts'), 'export const double = () => 99;\n');
        const dirtyError = yield* projectCodeGraphCheckpointV1({
          abi,
          databasePath,
          identity: indexed.identity,
          snapshotId: indexed.snapshot.id,
          writeMetadata: () => Effect.void,
          writeRecords: () => Effect.void,
        }).pipe(Effect.flip);
        expect(dirtyError).toBeInstanceOf(CodeGraphCheckpointProjectionError);
        expect(String(dirtyError)).toContain('not clean before checkpoint projection');
      }).pipe(
        Effect.ensuring(
          Effect.sync(() =>
            fixtureRoot === undefined ? undefined : rmSync(fixtureRoot, {force: true, recursive: true}),
          ),
        ),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      );
    },
    60_000,
  );
});

function createRepository(): {readonly home: string; readonly repository: string; readonly root: string} {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-checkpoint-projection-'));
  const repository = join(root, 'repository');
  const home = join(root, 'threadnote-home');
  mkdirSync(join(repository, 'src'), {recursive: true});
  mkdirSync(home, {recursive: true});
  writeFileSync(
    join(repository, 'package.json'),
    `${JSON.stringify(
      {
        dependencies: {'left-pad': '^1.3.0'},
        name: '@acme/checkpoint-projection',
        private: true,
        type: 'module',
        version: '1.0.0',
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repository, 'tsconfig.json'),
    `${JSON.stringify({compilerOptions: {module: 'NodeNext', target: 'ES2022'}, include: ['src']}, null, 2)}\n`,
  );
  writeFileSync(join(repository, 'src', 'math.ts'), 'export const double = (value: number): number => value * 2;\n');
  writeFileSync(join(repository, 'src', 'index.ts'), 'export {double} from "./math.js";\n');
  git(repository, ['init', '-q']);
  git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/checkpoint-projection.git']);
  git(repository, ['add', '.']);
  git(repository, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'checkpoint projection fixture',
  ]);
  return {home, repository, root};
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}
