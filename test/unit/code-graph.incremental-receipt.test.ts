import {it as effectIt} from '@effect/vitest';
import {Effect, Option} from 'effect';
import {describe, expect} from 'vitest';
import {assessIncrementalOverlay} from '../../src/code_graph/indexer_incremental.js';
import type {CodeGraphLanguagePackRegistryShape} from '../../src/code_graph/languages/registry.js';
import type {CodeGraphLayout} from '../../src/code_graph/layout.js';
import {
  CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
  type CodeGraphReusableBaseReceipt,
  type CodeGraphStoreShape,
} from '../../src/code_graph/store.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSnapshot} from '../../src/code_graph/types.js';

describe('incremental reusable-base receipt', () => {
  effectIt.effect('reuses the admitted immutable receipt and fails closed on a mismatched identity', () =>
    Effect.gen(function* () {
      const snapshot = readySnapshot('base');
      const file = inventoryFile();
      const facts = [{diagnostics: [], edges: [], path: file.path, symbols: []}] satisfies CodeGraphFileFacts[];
      const receipt = reusableReceipt(snapshot.id);
      let receiptReads = 0;
      const store = {
        reusableBaseReceipt: () =>
          Effect.sync(() => {
            receiptReads += 1;
            return receipt;
          }),
      } as unknown as CodeGraphStoreShape;
      const common = {
        building: {...snapshot, id: 'overlay', state: 'building' as const},
        committedBase: {
          diagnostics: [],
          leaseToken: Option.none<string>(),
          snapshot,
          stagingReusable: false,
        },
        force: false,
        incrementalOverlayEnabled: true,
        inventory: {
          committedFiles: [file],
          committedParsedFiles: 0,
          diagnostics: [],
          dirty: true,
          files: [file],
          parsedFiles: 1,
          skipped: 0,
        },
        languagePacks: {} as CodeGraphLanguagePackRegistryShape,
        layout: {databasePath: '/tmp/graph.sqlite'} as CodeGraphLayout,
        store,
        totalFiles: 1,
      };
      const preassessment = {
        baseFileSetFingerprint: 'files',
        committedWorkspace: workspace,
        facts,
        files: [file],
        mode: 'compatible' as const,
      };

      const supplied = yield* assessIncrementalOverlay(
        {...common, committedBaseReceipt: receipt},
        workspace,
        preassessment,
      );
      expect(supplied.mode).toBe('eligible');
      expect(receiptReads).toBe(0);

      const mismatched = yield* assessIncrementalOverlay(
        {...common, committedBaseReceipt: {...receipt, snapshotId: 'other'}},
        workspace,
        preassessment,
      );
      expect(mismatched).toEqual({mode: 'fallback', reason: 'staging-unavailable'});
      expect(receiptReads).toBe(0);

      const loaded = yield* assessIncrementalOverlay(common, workspace, preassessment);
      expect(loaded.mode).toBe('eligible');
      expect(receiptReads).toBe(1);
    }),
  );
});

const workspace = {diagnostics: [], fingerprint: 'workspace', projects: [], workspaces: []} as const;

function reusableReceipt(snapshotId: string): CodeGraphReusableBaseReceipt {
  return {
    aliasCount: 0,
    fileSetFingerprint: 'files',
    formatVersion: CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
    lookupCount: 0,
    packProvenance: [],
    reexportCount: 0,
    resolutionSurfaceVersion: 1,
    snapshotId,
    workspaceFingerprint: workspace.fingerprint,
  };
}

function readySnapshot(id: string): CodeGraphSnapshot {
  return {
    commit: 'a'.repeat(40),
    dirty: false,
    edgeCount: 0,
    extractorSet: 'extractors',
    fileCount: 1,
    id,
    repositoryId: 'repository',
    state: 'ready',
    symbolCount: 0,
    worktreeId: 'worktree',
  };
}

function inventoryFile(): CodeGraphInventoryFile {
  return {
    blobId: 'b'.repeat(40),
    contentHash: 'c'.repeat(64),
    language: 'typescript',
    mode: '100644',
    path: 'src/value.ts',
    size: 1,
    source: 'commit',
  };
}
