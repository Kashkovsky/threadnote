import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '../helpers/node-child-process.js';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '../helpers/node-fs.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import {Context, Effect, Layer, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {
  inventoryRepositoryFromReusableCleanBase,
  worktreeBuildRequestObservation,
} from '../../src/code_graph/inventory.js';
import {inventoryRepositoryFromReusableCleanBaseSlice} from '../../src/code_graph/inventory_sparse.js';
import {CodeGraphQueryService} from '../../src/code_graph/query.js';
import {
  BUILTIN_LANGUAGE_PACK_REGISTRY,
  CodeGraphLanguagePackRegistry,
  createCodeGraphLanguagePackRegistry,
  type CodeGraphLanguagePackRegistryShape,
} from '../../src/code_graph/languages/registry.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {
  CodeGraphStore,
  materializedShardDerivationIdentity,
  type CodeGraphVisualizationCatalog,
} from '../../src/code_graph/store.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION, type CodeGraphIndexSummary} from '../../src/code_graph/types.js';

describe('cross-session code graph increments', () => {
  it.effect(
    're-promotes a recent clean increment after a dirty-to-clean round trip',
    () => {
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository(16);
        const home = join(root, '.threadnote-round-trip');
        const initial = yield* indexAndLoadEffect(root, home);
        expect(initial.summary.materialization?.mode).toBe('full');

        writeUseFile(root, 'committed clean revision');
        git(root, ['add', 'src/use.ts']);
        git(root, ['commit', '-qm', 'clean increment']);
        const committed = yield* indexAndLoadEffect(root, home);
        expect(committed.summary.materialization).toEqual({
          mode: 'incremental-clean',
          resolutionLookupKeyForm: 'typescript-path-unscoped',
          resolutionPublicationGate: 'own-path-local',
          stagedFiles: 1,
          totalFiles: 18,
        });

        writeUseFile(root, 'temporary dirty revision');
        const dirty = yield* indexAndLoadEffect(root, home);
        expect(dirty.summary.materialization?.mode).toBe('incremental-overlay');
        expect(persistedSnapshotState(committed.databasePath, committed.summary.snapshot.id)).toBe('ready');

        git(root, ['checkout', '--', 'src/use.ts']);
        const restored = yield* indexAndLoadEffect(root, home);
        expect(restored.summary.snapshot.id).toBe(committed.summary.snapshot.id);
        expect(restored.summary.materialization).toEqual({
          mode: 'reused-snapshot',
          stagedFiles: 0,
          totalFiles: 18,
        });
        expect(projectGraph(restored.graph)).toEqual(projectGraph(committed.graph));
        expect(restored.health).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => (root === undefined ? undefined : rmSync(root, {force: true, recursive: true}))),
        ),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      );
    },
    60_000,
  );

  it.effect('reuses a persisted clean base for a body-only dirty overlay', () => {
    let fullHome: string | undefined;
    let incrementalHome: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository(32);
      writeFileSync(join(root, 'package.json'), '{"name":"sparse-fixture","version":"1.0.0"}\n');
      git(root, ['add', 'package.json']);
      git(root, ['commit', '-qm', 'add attribution context']);
      incrementalHome = mkdtempSync(join(tmpdir(), 'threadnote-incremental-home-'));
      fullHome = mkdtempSync(join(tmpdir(), 'threadnote-full-home-'));
      const indexer = yield* CodeGraphIndexer;
      const clean = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
      expect(clean.materialization?.mode).toBe('full');

      writeUseFile(root, 'second body-only revision');

      const identity = yield* resolveRepositoryIdentity(root);
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const layout = codeGraphLayout(path, incrementalHome, identity.checkoutId, identity.worktreeId);
      const observation = yield* worktreeBuildRequestObservation(identity, incrementalHome);
      const base = yield* store.reusableCleanBaseForCommit(
        layout.databasePath,
        identity.repositoryId,
        identity.headCommit,
      );
      expect(base).toBeDefined();
      const baseSlice = yield* store.reusableCleanBaseForCommitPaths!(
        layout.databasePath,
        identity.repositoryId,
        identity.headCommit,
        ['src/use.ts'],
      );
      expect(baseSlice).toMatchObject({
        files: [{path: 'src/use.ts', source: 'commit'}],
        snapshot: {fileCount: 35},
      });
      expect(
        yield* store.existingSnapshotFilePaths!(layout.databasePath, baseSlice!.snapshot.id, [
          'src/use.ts',
          'src/missing.ts',
        ]),
      ).toEqual(['src/use.ts']);
      expect(
        yield* store.snapshotProjectClosureFiles!(layout.databasePath, baseSlice!.snapshot.id, ['src']),
      ).toHaveLength(34);
      expect(
        yield* store.snapshotProjectClosureFiles!(layout.databasePath, baseSlice!.snapshot.id, ['']),
      ).toBeUndefined();
      const baseFacts = yield* store.loadSnapshotMaterializedFileShards!(
        layout.databasePath,
        baseSlice!.snapshot.id,
        baseSlice!.files,
      );
      expect(baseFacts.facts.get('src/use.ts')?.path).toBe('src/use.ts');
      expect(
        yield* store.reusableCleanBaseForCommitPaths!(layout.databasePath, identity.repositoryId, identity.headCommit, [
          'src/use.ts',
          'src/use.ts',
        ]),
      ).toBeUndefined();
      expect(
        yield* store.reusableCleanBaseForCommitPaths!(layout.databasePath, identity.repositoryId, identity.headCommit, [
          'src/missing.ts',
        ]),
      ).toBeUndefined();
      const command = yield* CommandExecutor;
      const gitCommands: string[] = [];
      const observedCommand = CommandExecutor.of({
        ...command,
        execute: (executable, args, options) => {
          if (executable === 'git') gitCommands.push(args.join(' '));
          return command.execute(executable, args, options);
        },
      });
      const sparseInventory = yield* inventoryRepositoryFromReusableCleanBaseSlice(identity, baseSlice!, {
        overlayObservation: observation.overlay,
      }).pipe(Effect.provideService(CommandExecutor, observedCommand));
      expect(Option.isSome(sparseInventory)).toBe(true);
      if (Option.isSome(sparseInventory)) {
        expect(sparseInventory.value).toMatchObject({
          files: [{path: 'src/use.ts', source: 'worktree'}],
          base: {files: [{path: 'src/use.ts', source: 'commit'}], snapshot: {fileCount: 35}},
        });
      }
      const fastInventory = yield* inventoryRepositoryFromReusableCleanBase(identity, base!, {
        overlayObservation: observation.overlay,
      }).pipe(Effect.provideService(CommandExecutor, observedCommand));
      expect(Option.isSome(fastInventory)).toBe(true);
      expect(gitCommands.some(command => command.includes(' ls-tree '))).toBe(false);

      const incremental = yield* indexAndLoadEffect(root, incrementalHome);
      const full = yield* indexer.index({
        cwd: root,
        incrementalOverlay: false,
        threadnoteHome: fullHome,
      });
      const rebuilt = yield* loadGraphEffect(root, fullHome, full);

      expect(incremental.summary.materialization).toEqual({
        mode: 'incremental-overlay',
        resolutionLookupKeyForm: 'typescript-path-scoped',
        resolutionPublicationGate: 'own-path-local',
        stagedFiles: 1,
        totalFiles: 35,
      });
      expect(incremental.summary.incrementalWork).toMatchObject({
        attributionContextFiles: 1,
        baseFactsLoaded: 1,
        changedFiles: 1,
        inventoryFilesInspected: 1,
        probedDependencyPaths: expect.any(Number),
        totalFiles: 35,
      });
      expect(incremental.summary.incrementalWork!.probedDependencyPaths).toBeLessThanOrEqual(16);
      expect(incremental.summary.snapshot.graphContentId).toMatch(/^cgc_[0-9a-f]{40}$/u);
      expect(projectGraph(incremental.graph)).toEqual(projectGraph(rebuilt));
      expect(yield* analysisDigestEffect(incrementalHome, incremental.summary)).toBe(
        yield* analysisDigestEffect(fullHome, full),
      );
      expect(normalizeCatalog(incremental.catalog)).toEqual(
        normalizeCatalog(yield* loadVisualizationCatalogEffect(fullHome, full)),
      );
      expect(incremental.health).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
      expect(
        incremental.graph.edges.some(
          edge => edge.sourceName === 'useHelper' && edge.relation === 'calls' && edge.targetName === 'helper',
        ),
      ).toBe(true);
      const delta = persistedDeltaStats(incremental.databasePath, incremental.summary.snapshot.id);
      expect(delta).toEqual({
        activeLeases: 0,
        edgePaths: ['src/use.ts'],
        filePaths: ['src/use.ts'],
        symbolPaths: ['src/use.ts'],
      });
      expect(incremental.summary.diagnostics).toContain(
        'Dirty overlay reused persisted clean base for 1 modified file(s).',
      );
      expect(incremental.summary.diagnostics).toContain(
        'Reused persisted clean inventory admission for 1 changed path(s) without hydrating the complete base.',
      );
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, incrementalHome, fullHome])),
    );
  });

  it.effect('reuses persisted admission for a deleted source and matches a full rebuild', () => {
    let fullHome: string | undefined;
    let incrementalHome: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository(8);
      incrementalHome = mkdtempSync(join(tmpdir(), 'threadnote-deleted-admission-home-'));
      fullHome = mkdtempSync(join(tmpdir(), 'threadnote-deleted-admission-full-home-'));
      yield* indexAndLoadEffect(root, incrementalHome);
      rmSync(join(root, 'src', 'passive-0.ts'));

      const incremental = yield* indexAndLoadEffect(root, incrementalHome);
      const indexer = yield* CodeGraphIndexer;
      const rebuiltSummary = yield* indexer.index({
        cwd: root,
        incrementalOverlay: false,
        threadnoteHome: fullHome,
      });
      const rebuilt = yield* loadGraphEffect(root, fullHome, rebuiltSummary);

      expect(incremental.summary.diagnostics).toContain(
        'Reused persisted clean inventory admission for 1 changed path(s).',
      );
      expect(projectGraph(incremental.graph)).toEqual(projectGraph(rebuilt));
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, incrementalHome, fullHome])),
    );
  });

  it.effect('falls back to full admission when the inventory receipt is absent', () => {
    let home: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository(8);
      home = mkdtempSync(join(tmpdir(), 'threadnote-missing-inventory-receipt-home-'));
      const clean = yield* indexAndLoadEffect(root, home);
      clearInventoryReuseReceipt(clean.databasePath, clean.summary.snapshot.id);
      writeUseFile(root, 'dirty without inventory receipt');

      const dirty = yield* indexAndLoadEffect(root, home);
      expect(dirty.summary.materialization?.mode).toBe('incremental-overlay');
      expect(dirty.summary.diagnostics).not.toContain(
        'Reused persisted clean inventory admission for 1 changed path(s).',
      );
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, home])),
    );
  });

  it.effect('falls back to full admission when ignore controls change', () => {
    let home: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository(8);
      writeFileSync(join(root, '.gitignore'), '# initial\n');
      git(root, ['add', '.gitignore']);
      git(root, ['commit', '--amend', '-qm', 'fixture with ignore policy']);
      home = mkdtempSync(join(tmpdir(), 'threadnote-changed-ignore-admission-home-'));
      yield* indexAndLoadEffect(root, home);
      writeFileSync(join(root, '.gitignore'), '# changed\n');
      writeUseFile(root, 'dirty with changed ignore policy');

      const dirty = yield* indexAndLoadEffect(root, home);
      expect(
        dirty.summary.diagnostics.some(diagnostic =>
          diagnostic.startsWith('Reused persisted clean inventory admission for '),
        ),
      ).toBe(false);
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, home])),
    );
  });

  it.effect('does not union different-base clean increments into full-materialization shards', () => {
    let home: string | undefined;
    let root: string | undefined;
    let siblingRoot: string | undefined;
    return Effect.gen(function* () {
      const fixture = createConvergentIncrementalRepository();
      root = fixture.root;
      siblingRoot = fixture.siblingRoot;
      home = mkdtempSync(join(tmpdir(), 'threadnote-convergent-incremental-home-'));
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;

      const baseA = yield* indexer.index({cwd: root, force: true, threadnoteHome: home});
      git(root, ['checkout', '-q', 'target-a']);
      const targetA = yield* indexAndLoadEffect(root, home);
      const baseB = yield* indexer.index({cwd: siblingRoot, force: true, threadnoteHome: home});
      git(siblingRoot, ['checkout', '-q', 'target-b']);
      const targetB = yield* indexAndLoadEffect(siblingRoot, home);

      expect(targetA.summary.materialization?.mode).toBe('incremental-clean');
      expect(targetB.summary.materialization?.mode).toBe('incremental-clean');
      expect(targetA.summary.snapshot.baseSnapshotId).toBe(baseA.snapshot.id);
      expect(targetB.summary.snapshot.baseSnapshotId).toBe(baseB.snapshot.id);
      expect(targetA.summary.snapshot.graphContentId).toBeDefined();
      expect(targetB.summary.snapshot.graphContentId).toBe(targetA.summary.snapshot.graphContentId);
      expect(projectGraph(targetB.graph)).toEqual(projectGraph(targetA.graph));
      const [receiptA, receiptB] = yield* Effect.all(
        [
          store.reusableBaseReceipt(targetA.databasePath, baseA.snapshot.id),
          store.reusableBaseReceipt(targetB.databasePath, baseB.snapshot.id),
        ],
        {concurrency: 1},
      );
      expect(receiptA).toBeDefined();
      expect(receiptB?.workspaceFingerprint).toBe(receiptA?.workspaceFingerprint);
      const targetDerivation = materializedShardDerivationIdentity(
        targetA.summary.snapshot.extractorSet,
        receiptA!.workspaceFingerprint,
        targetA.summary.snapshot.graphContentId!,
      );

      expect(materializedShardCount(targetA.databasePath, targetDerivation)).toBe(0);
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [siblingRoot, root, home])),
    );
  });

  it.effect('matches full rebuilds when changed-file relationships are added or deleted', () => {
    const temporaryPaths: string[] = [];
    return Effect.gen(function* () {
      const indexer = yield* CodeGraphIndexer;
      for (const operation of ['add', 'delete'] as const) {
        const root = createRepository();
        temporaryPaths.push(root);
        const incrementalHome = mkdtempSync(join(tmpdir(), `threadnote-${operation}-incremental-home-`));
        temporaryPaths.push(incrementalHome);
        const fullHome = mkdtempSync(join(tmpdir(), `threadnote-${operation}-full-home-`));
        temporaryPaths.push(fullHome);
        if (operation === 'add') writeUseFileWithoutCall(root, 'clean no-call revision');
        git(root, ['add', '.']);
        git(root, ['commit', '--amend', '-qm', 'fixture']);
        yield* indexAndLoadEffect(root, incrementalHome);
        if (operation === 'add') writeUseFile(root, 'dirty call revision');
        else writeUseFileWithoutCall(root, 'dirty no-call revision');

        const incremental = yield* indexAndLoadEffect(root, incrementalHome);
        const fullSummary = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
        const full = yield* loadGraphEffect(root, fullHome, fullSummary);
        expect(incremental.summary.materialization?.mode).toBe('incremental-overlay');
        expect(projectGraph(incremental.graph)).toEqual(projectGraph(full));
        expect(
          incremental.graph.edges.some(
            edge => edge.sourceName === 'useHelper' && edge.relation === 'calls' && edge.targetName === 'helper',
          ),
        ).toBe(operation === 'add');
      }
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => temporaryPaths)),
    );
  });

  it.effect('resolves changed consumers through persisted barrel aliases and declaration-only overloads', () => {
    let fullHome: string | undefined;
    let incrementalHome: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createBarrelRepository();
      incrementalHome = mkdtempSync(join(tmpdir(), 'threadnote-barrel-incremental-home-'));
      fullHome = mkdtempSync(join(tmpdir(), 'threadnote-barrel-full-home-'));
      const clean = yield* indexAndLoadEffect(root, incrementalHome);
      expect(reusableReceiptStats(clean.databasePath, clean.summary.snapshot.id)).toMatchObject({
        formatVersion: 2,
        inventoryReceipt: true,
        reexports: 2,
      });
      expect(reusableReceiptStats(clean.databasePath, clean.summary.snapshot.id).aliases).toBeGreaterThan(0);
      writeBarrelConsumer(root, 'dirty');
      const incremental = yield* indexAndLoadEffect(root, incrementalHome);
      const indexer = yield* CodeGraphIndexer;
      const fullSummary = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
      const full = yield* loadGraphEffect(root, fullHome, fullSummary);

      expect(incremental.summary.materialization?.mode).toBe('incremental-overlay');
      expect(projectGraph(incremental.graph)).toEqual(projectGraph(full));
      const implementation = incremental.graph.symbols.find(
        symbol => symbol.name === 'helper' && symbol.signature?.includes('string | number'),
      );
      const decodeDeclarations = incremental.graph.symbols.filter(symbol => symbol.name === 'decode');
      expect(implementation).toBeDefined();
      expect(
        incremental.graph.edges.some(
          edge => edge.relation === 'calls' && edge.sourceName === 'useHelper' && edge.targetId === implementation?.id,
        ),
      ).toBe(true);
      expect(
        new Set(
          incremental.graph.edges
            .filter(
              edge => edge.relation === 'calls' && edge.sourceName === 'useHelper' && edge.targetName === 'decode',
            )
            .map(edge => edge.targetId),
        ),
      ).toEqual(new Set(decodeDeclarations.map(symbol => symbol.id)));
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, incrementalHome, fullHome])),
    );
  });

  it.effect('falls back conservatively when the clean base predates reusable receipts', () => {
    let home: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository();
      home = mkdtempSync(join(tmpdir(), 'threadnote-old-base-home-'));
      const clean = yield* indexAndLoadEffect(root, home);
      deleteReusableReceipt(clean.databasePath, clean.summary.snapshot.id);
      writeUseFile(root, 'dirty revision after upgrade');

      const dirty = yield* indexAndLoadEffect(root, home);
      expect(dirty.summary.materialization).toEqual({
        fallbackReason: 'staging-unavailable',
        mode: 'full',
        stagedFiles: 2,
        totalFiles: 2,
      });
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, home])),
    );
  });

  it.effect(
    're-extracts only the changed language pack across a compatible extractor rollout',
    () => {
      let home: string | undefined;
      let referenceHome: string | undefined;
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository(6);
        writeFileSync(join(root, 'README.md'), '# Mixed language fixture\n');
        git(root, ['add', 'README.md']);
        git(root, ['commit', '--amend', '-qm', 'fixture']);
        home = mkdtempSync(join(tmpdir(), 'threadnote-pack-rollout-home-'));
        referenceHome = mkdtempSync(join(tmpdir(), 'threadnote-pack-rollout-reference-home-'));
        const initialRegistry = createCodeGraphLanguagePackRegistry(BUILTIN_LANGUAGE_PACK_REGISTRY.packs);
        const nextRegistry = createCodeGraphLanguagePackRegistry(
          BUILTIN_LANGUAGE_PACK_REGISTRY.packs.map(pack =>
            pack.id === 'typescript'
              ? {...pack, extractor: {...pack.extractor, version: `${pack.extractor.version}-compatible-next`}}
              : pack,
          ),
        );

        const initial = yield* indexWithRegistry(root, home, initialRegistry);
        expect(initial.materialization?.mode).toBe('full');
        const incremental = yield* indexWithRegistry(root, home, nextRegistry);
        const rebuilt = yield* indexWithRegistry(root, referenceHome, nextRegistry, true);
        expect(incremental.materialization).toEqual({
          mode: 'incremental-clean',
          resolutionLookupKeyForm: 'typescript-path-unscoped',
          resolutionPublicationGate: 'own-path-local',
          stagedFiles: 8,
          totalFiles: 9,
        });
        expect(projectGraph(yield* loadGraphEffect(root, home, incremental))).toEqual(
          projectGraph(yield* loadGraphEffect(root, referenceHome, rebuilt)),
        );
      }).pipe(
        Effect.ensuring(removeTemporaryPaths(() => [root, home, referenceHome])),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      );
    },
    60_000,
  );

  it.effect(
    'refreshes a clean ready snapshot when the current language pack accepts a previously omitted AXL source',
    () => {
      let home: string | undefined;
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository();
        home = mkdtempSync(join(tmpdir(), 'threadnote-axl-pack-upgrade-home-'));
        const axlPath = 'crates/aspect-cli/src/builtins/aspect/bazel.axl';
        mkdirSync(join(root, 'crates/aspect-cli/src/builtins/aspect'), {recursive: true});
        writeFileSync(join(root, 'BUILD.bazel'), 'exports_files(["package.json"])\n');
        writeFileSync(join(root, axlPath), 'UPGRADE_MARKER = 1\n');
        git(root, ['add', '.']);
        git(root, ['commit', '--amend', '-qm', 'fixture with AXL source']);

        const legacyRegistry = createCodeGraphLanguagePackRegistry(
          BUILTIN_LANGUAGE_PACK_REGISTRY.packs.map(pack =>
            pack.id === 'bazel'
              ? {...pack, files: pack.files.filter(matcher => matcher.value !== '.axl'), version: '1.0.0'}
              : pack,
          ),
        );
        const legacy = yield* indexWithRegistry(root, home, legacyRegistry);
        const query = yield* CodeGraphQueryService;
        const before = yield* query.status(home, root, {requestMaintenance: false});

        expect(legacy.snapshot.fileCount).toBe(3);
        expect(before).toMatchObject({freshness: 'stale', stale: true});

        const refreshed = yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: axlPath,
          refresh: true,
          requestMaintenance: false,
          threadnoteHome: home,
        });

        expect(refreshed.freshness).toBe('current');
        expect(refreshed.snapshot.id).not.toBe(legacy.snapshot.id);
        expect(refreshed.nodes).toEqual(
          expect.arrayContaining([expect.objectContaining({language: 'starlark', path: axlPath})]),
        );
      }).pipe(
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
        Effect.ensuring(removeTemporaryPaths(() => [root, home])),
      );
    },
    60_000,
  );

  it.effect('fails closed when a global extractor change is not explained by pack provenance', () => {
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository(4);
      const home = join(root, '.threadnote-global-extractor');
      const initial = yield* indexAndLoadEffect(root, home);
      replaceSnapshotExtractorSet(initial.databasePath, initial.summary.snapshot.id, 'unexplained-global-change');
      writeUseFile(root, 'changed alongside a global extractor rollout');

      const next = yield* indexAndLoadEffect(root, home);
      expect(next.summary.materialization).toEqual({
        fallbackReason: 'extractor-context-changed',
        mode: 'full',
        stagedFiles: 6,
        totalFiles: 6,
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => (root === undefined ? undefined : rmSync(root, {force: true, recursive: true}))),
      ),
      provideTestLayer(ApplicationLayer),
    );
  });

  it.effect('does not let a stale peer failure poison an already-ready reusable base', () => {
    let home: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository();
      home = mkdtempSync(join(tmpdir(), 'threadnote-peer-failure-home-'));
      yield* indexAndLoadEffect(root, home);
      writeUseFile(root, 'dirty peer-failure revision');
      const dirty = yield* indexAndLoadEffect(root, home);
      const baseSnapshotId = dirty.summary.snapshot.baseSnapshotId;
      expect(baseSnapshotId).toBeDefined();

      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const layout = codeGraphLayout(path, home, dirty.summary.identity.checkoutId, dirty.summary.identity.worktreeId);
      yield* store.markFailed(layout.databasePath, baseSnapshotId!, 'late failure from a peer builder');
      const state = {
        receipt: yield* store.reusableBaseReceipt(layout.databasePath, baseSnapshotId!),
        snapshot: yield* store.readySnapshotById(layout.databasePath, baseSnapshotId!),
      };

      expect(state.snapshot?.state).toBe('ready');
      expect(state.receipt?.snapshotId).toBe(baseSnapshotId);
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, home])),
    );
  });

  it.effect('prevents an overlapping older extractor generation from replacing the active graph', () => {
    let home: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository();
      home = mkdtempSync(join(tmpdir(), 'threadnote-extractor-generation-home-'));
      const current = yield* indexAndLoadEffect(root, home);
      const legacySnapshotId = 'cgsn_legacy_generation_8';
      insertLegacyReadySnapshot(current.databasePath, current.summary, legacySnapshotId);
      expect(() =>
        promoteLegacySnapshot(current.databasePath, current.summary.identity.worktreeId, legacySnapshotId),
      ).toThrow('older extractor generation');

      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const layout = codeGraphLayout(
        path,
        home,
        current.summary.identity.checkoutId,
        current.summary.identity.worktreeId,
      );
      const promotionError = yield* store
        .promote(layout.databasePath, current.summary.identity, legacySnapshotId)
        .pipe(Effect.flip);
      expect(promotionError.message).toContain('incompatible extractor generation');

      const state = yield* store.readySnapshot(layout.databasePath, current.summary.identity.worktreeId);
      expect(state?.id).toBe(current.summary.snapshot.id);
      expect(extractorGenerationState(current.databasePath, current.summary.snapshot.id)).toEqual({
        generation: CODE_GRAPH_EXTRACTOR_GENERATION,
        minimum: CODE_GRAPH_EXTRACTOR_GENERATION,
      });
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, home])),
    );
  });
});

const indexAndLoadEffect = Effect.fn('test.indexAndLoad')(function* (root: string, home: string) {
  const indexer = yield* CodeGraphIndexer;
  const summary = yield* indexer.index({cwd: root, threadnoteHome: home});
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
  const graph = yield* store.loadGraph(layout.databasePath, summary.snapshot.id);
  return {
    catalog: yield* store.loadVisualizationCatalog(layout.databasePath),
    databasePath: layout.databasePath,
    graph,
    health: yield* store.diagnose(layout.databasePath),
    summary,
  };
});

const loadGraphEffect = Effect.fn('test.loadGraph')(function* (
  root: string,
  home: string,
  summary: CodeGraphIndexSummary,
) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
  return yield* store.loadGraph(layout.databasePath, summary.snapshot.id);
});

const analysisDigestEffect = Effect.fn('test.analysisDigest')(function* (home: string, summary: CodeGraphIndexSummary) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
  yield* store.ensureAnalysisSummary(layout.databasePath, summary.snapshot.id);
  return Option.map(
    yield* store.loadAnalysisSummary(layout.databasePath, summary.snapshot.id),
    value => value.digest,
  ).pipe(Option.getOrThrow);
});

const indexWithRegistry = Effect.fn('test.indexWithRegistry')(function* (
  root: string,
  home: string,
  registry: CodeGraphLanguagePackRegistryShape,
  force = false,
) {
  const layer = Layer.fresh(CodeGraphIndexer.layer).pipe(
    Layer.provide(Layer.succeed(CodeGraphLanguagePackRegistry, registry)),
    Layer.provide(ApplicationLayer),
  );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      const indexer = Context.get(context, CodeGraphIndexer);
      return yield* indexer.index({cwd: root, force, threadnoteHome: home});
    }),
  );
});

function projectGraph(graph: {readonly edges: readonly unknown[]; readonly symbols: readonly unknown[]}) {
  return JSON.parse(JSON.stringify({edges: graph.edges, symbols: graph.symbols})) as {
    readonly edges: readonly unknown[];
    readonly symbols: readonly unknown[];
  };
}

function persistedSnapshotState(databasePath: string, snapshotId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return (database.query('SELECT state FROM snapshots WHERE id = ?').get(snapshotId) as {state?: string} | null)
      ?.state;
  } finally {
    database.close(false);
  }
}

function materializedShardCount(databasePath: string, derivationIdentity: string): number {
  const database = new Database(databasePath, {readonly: true});
  try {
    return Number(
      database
        .query<{readonly count: number}, [string]>(
          'SELECT COUNT(*) AS count FROM materialized_file_shards WHERE derivation_identity = ?',
        )
        .get(derivationIdentity)?.count ?? 0,
    );
  } finally {
    database.close();
  }
}

function normalizeCatalog(catalog: CodeGraphVisualizationCatalog | undefined): unknown {
  if (catalog === undefined) return undefined;
  const {activatedAt: _activatedAt, snapshot, ...stable} = catalog;
  const {
    baseSnapshotId: _baseSnapshotId,
    completedAt: _completedAt,
    graphContentId: _graphContentId,
    id: _id,
    ...stableSnapshot
  } = snapshot;
  return {...stable, snapshot: stableSnapshot};
}

const loadVisualizationCatalogEffect = Effect.fn('test.loadVisualizationCatalog')(function* (
  home: string,
  summary: CodeGraphIndexSummary,
) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
  return yield* store.loadVisualizationCatalog(layout.databasePath);
});

function createRepository(passiveFiles = 0): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-cross-session-incremental-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(join(root, 'src', 'helper.ts'), 'export function helper(): string { return "ok"; }\n');
  writeUseFile(root, 'first revision');
  for (let index = 0; index < passiveFiles; index += 1) {
    writeFileSync(
      join(root, 'src', `passive-${index}.ts`),
      `export function passive${index}(): number { return ${index}; }\n`,
    );
  }
  git(root, ['init', '-q']);
  configureTestGitIdentity(root);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function createConvergentIncrementalRepository(): {readonly root: string; readonly siblingRoot: string} {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-convergent-incremental-'));
  const siblingRoot = `${root}-sibling`;
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(join(root, 'src/a.ts'), 'export const a = "old-a";\n');
  writeFileSync(join(root, 'src/b.ts'), 'export const b = "old-b";\n');
  git(root, ['init', '-q']);
  configureTestGitIdentity(root);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'common']);
  const common = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();

  git(root, ['checkout', '-qb', 'target-a', common]);
  writeFileSync(join(root, 'src/b.ts'), 'export const b = "final-b";\n');
  git(root, ['add', 'src/b.ts']);
  git(root, ['commit', '-qm', 'base a']);
  git(root, ['branch', 'base-a']);
  writeFileSync(join(root, 'src/a.ts'), 'export const a = "final-a";\n');
  git(root, ['add', 'src/a.ts']);
  git(root, ['commit', '-qm', 'target a']);

  git(root, ['checkout', '-qb', 'target-b', common]);
  writeFileSync(join(root, 'src/a.ts'), 'export const a = "final-a";\n');
  git(root, ['add', 'src/a.ts']);
  git(root, ['commit', '-qm', 'base b']);
  git(root, ['branch', 'base-b']);
  writeFileSync(join(root, 'src/b.ts'), 'export const b = "final-b";\n');
  git(root, ['add', 'src/b.ts']);
  git(root, ['commit', '-qm', 'target b']);

  git(root, ['checkout', '-q', 'base-a']);
  git(root, ['worktree', 'add', '-q', siblingRoot, 'base-b']);
  return {root, siblingRoot};
}

function createBarrelRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-cross-session-barrel-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(
    join(root, 'src', 'helper.ts'),
    [
      'export function helper(value: string): string;',
      'export function helper(value: number): number;',
      'export function helper(value: string | number): string | number { return value; }',
      'export declare function decode(): string;',
      'export declare function decode(left: string, right: string): string;',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'src', 'index.ts'), 'export {decode, helper} from "./helper.js";\n');
  writeBarrelConsumer(root, 'clean');
  git(root, ['init', '-q']);
  configureTestGitIdentity(root);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'barrel fixture']);
  return root;
}

function writeUseFile(root: string, revision: string): void {
  writeFileSync(
    join(root, 'src', 'use.ts'),
    [
      'import {helper} from "./helper.js";',
      'export function useHelper(): string {',
      `  const revision = ${JSON.stringify(revision)};`,
      '  return `${revision}:${helper()}`;',
      '}',
      '',
    ].join('\n'),
  );
}

function writeUseFileWithoutCall(root: string, revision: string): void {
  writeFileSync(
    join(root, 'src', 'use.ts'),
    [
      'import {helper} from "./helper.js";',
      'export function useHelper(): string {',
      `  const revision = ${JSON.stringify(revision)};`,
      '  void helper;',
      '  return revision;',
      '}',
      '',
    ].join('\n'),
  );
}

function writeBarrelConsumer(root: string, revision: string): void {
  writeFileSync(
    join(root, 'src', 'use.ts'),
    [
      'import {decode, helper} from "./index.js";',
      'export function useHelper(): string {',
      `  return helper(${JSON.stringify(revision)}) + decode() + decode("a", "b");`,
      '}',
      '',
    ].join('\n'),
  );
}

function persistedDeltaStats(databasePath: string, snapshotId: string) {
  const database = new Database(databasePath, {readonly: true});
  try {
    const paths = (table: 'edges' | 'snapshot_files' | 'symbols', column: 'evidence_path' | 'path') =>
      database
        .query<{readonly path: string}, [string]>(
          `SELECT DISTINCT ${column} AS path FROM ${table} WHERE snapshot_id = ? ORDER BY path`,
        )
        .all(snapshotId)
        .map(row => row.path);
    return {
      activeLeases: Number(
        database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM snapshot_leases').get()?.count ?? 0,
      ),
      edgePaths: paths('edges', 'evidence_path'),
      filePaths: paths('snapshot_files', 'path'),
      symbolPaths: paths('symbols', 'path'),
    };
  } finally {
    database.close();
  }
}

function reusableReceiptStats(
  databasePath: string,
  snapshotId: string,
): {
  readonly aliases: number;
  readonly formatVersion: number;
  readonly inventoryReceipt: boolean;
  readonly reexports: number;
} {
  const database = new Database(databasePath, {readonly: true});
  try {
    const aliases = database
      .query<{readonly aliases: number}, [string]>(
        "SELECT COUNT(*) AS aliases FROM snapshot_symbol_lookup WHERE snapshot_id = ? AND provenance = 'alias'",
      )
      .get(snapshotId);
    const receipt = database
      .query<{readonly formatVersion: number; readonly inventoryReceiptJson: string | null}, [string]>(
        `SELECT format_version AS formatVersion, inventory_receipt_json AS inventoryReceiptJson
         FROM snapshot_reuse_receipts WHERE snapshot_id = ?`,
      )
      .get(snapshotId);
    const reexports = database
      .query<{readonly reexports: number}, [string]>(
        'SELECT COUNT(*) AS reexports FROM snapshot_reexport_provenance WHERE snapshot_id = ?',
      )
      .get(snapshotId);
    return {
      aliases: Number(aliases?.aliases ?? 0),
      formatVersion: Number(receipt?.formatVersion ?? 0),
      inventoryReceipt: receipt?.inventoryReceiptJson !== null && receipt?.inventoryReceiptJson !== undefined,
      reexports: Number(reexports?.reexports ?? 0),
    };
  } finally {
    database.close();
  }
}

function deleteReusableReceipt(databasePath: string, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    database.query('DELETE FROM snapshot_reuse_receipts WHERE snapshot_id = ?').run(snapshotId);
  } finally {
    database.close();
  }
}

function clearInventoryReuseReceipt(databasePath: string, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    database
      .query('UPDATE snapshot_reuse_receipts SET inventory_receipt_json = NULL WHERE snapshot_id = ?')
      .run(snapshotId);
  } finally {
    database.close();
  }
}

function replaceSnapshotExtractorSet(databasePath: string, snapshotId: string, extractorSet: string): void {
  const database = new Database(databasePath);
  try {
    database.query('UPDATE snapshots SET extractor_set = ? WHERE id = ?').run(extractorSet, snapshotId);
  } finally {
    database.close();
  }
}

function insertLegacyReadySnapshot(databasePath: string, summary: CodeGraphIndexSummary, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    database
      .query(
        `INSERT INTO snapshots (
          id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set,
          dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, NULL, ?, 0, NULL, 'ready', 0, 0, 0, ?, ?)`,
      )
      .run(
        snapshotId,
        summary.identity.repositoryId,
        summary.identity.worktreeId,
        summary.identity.headCommit,
        'native-code-graph-8-fixture',
        '2026-07-31T00:00:00.000Z',
        '2026-07-31T00:00:01.000Z',
      );
  } finally {
    database.close();
  }
}

function extractorGenerationState(
  databasePath: string,
  snapshotId: string,
): {readonly generation: number; readonly minimum: number} {
  const database = new Database(databasePath, {readonly: true});
  try {
    const generation = database
      .query<{readonly generation: number}, [string]>(
        'SELECT generation FROM snapshot_extractor_generations WHERE snapshot_id = ?',
      )
      .get(snapshotId);
    const minimum = database
      .query<{readonly minimum: string}, []>(
        "SELECT value AS minimum FROM schema_metadata WHERE key = 'minimum_extractor_generation'",
      )
      .get();
    return {generation: Number(generation?.generation ?? 0), minimum: Number(minimum?.minimum ?? 0)};
  } finally {
    database.close();
  }
}

function promoteLegacySnapshot(databasePath: string, worktreeId: string, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    database
      .query(
        `INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(worktree_id) DO UPDATE SET
           snapshot_id = excluded.snapshot_id,
           activated_at = excluded.activated_at`,
      )
      .run(worktreeId, snapshotId, '2026-07-31T00:00:02.000Z');
  } finally {
    database.close();
  }
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}

function configureTestGitIdentity(cwd: string): void {
  git(cwd, ['config', 'user.name', 'Threadnote Test']);
  git(cwd, ['config', 'user.email', 'test@threadnote.local']);
}

function removeTemporaryPaths(paths: () => readonly (string | undefined)[]) {
  return Effect.sync(() => {
    for (const path of paths()) {
      if (path !== undefined) rmSync(path, {force: true, recursive: true});
    }
  });
}
