import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  graphViewRemovalApprovalDialog,
  graphViewRemovalTargetIsAbsent,
  type ManagerGraphViewRemovalResponse,
  type ManagerGraphViewRemovalState,
  withoutRemovedGraphCatalogView,
  withoutRemovedGraphDiagnosticsView,
} from '../../src/manager/graph_removal.js';
import type {CodeGraphLocalDiagnosticsReport} from '../../src/code_graph/diagnostics.js';
import type {GraphCatalog, GraphRepository, GraphRepositoryGroup} from '../../src/manager/graph.js';

describe('Manager graph view removal', () => {
  it('offers destructive approval only for the exact ready preview', () => {
    const preview = response('ready');

    expect(graphViewRemovalApprovalDialog(preview)).toEqual({
      confirmLabel: 'Remove view',
      detail: preview.output,
      message:
        'Review this exact dry-run preview. Threadnote will reject the approval if the target changes before removal.',
      title: 'Remove this indexed view?',
      tone: 'danger',
    });
    for (const state of ['already-removed', 'not-found', 'removed', 'stale-target'] as const) {
      expect(graphViewRemovalApprovalDialog(response(state))).toBeUndefined();
    }
  });

  it('removes a confirmed view from both live Manager projections before an authoritative refresh', () => {
    const target = {
      checkoutId: 'checkout',
      expectedSnapshotId: 'snapshot-worktree-b',
      worktreeId: 'worktree-b',
    };
    const catalog = catalogFixture(['worktree-a', 'worktree-b']);
    const diagnostics = diagnosticsFixture(['worktree-a', 'worktree-b']);

    expect(graphViewRemovalTargetIsAbsent(response('removed'))).toBe(true);
    expect(graphViewRemovalTargetIsAbsent(response('already-removed'))).toBe(true);
    expect(graphViewRemovalTargetIsAbsent(response('not-found'))).toBe(true);
    expect(graphViewRemovalTargetIsAbsent(response('stale-target'))).toBe(false);
    expect(
      withoutRemovedGraphCatalogView(catalog, target)?.repositories[0]?.views.map(view => view.worktreeId),
    ).toEqual(['worktree-a']);
    expect(
      withoutRemovedGraphDiagnosticsView(diagnostics, target)?.databases[0]?.views.map(view => view.viewWorktreeId),
    ).toEqual(['worktree-a']);
    expect(withoutRemovedGraphDiagnosticsView(diagnostics, target)?.summary.viewCount).toBe(1);
  });

  it('applies removal projections idempotently for any selected view', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({minLength: 1, maxLength: 12}), {minLength: 1, maxLength: 12}), ids => {
        const worktreeId = ids[0];
        const target = {checkoutId: 'checkout', expectedSnapshotId: `snapshot-${worktreeId}`, worktreeId};
        const catalogOnce = withoutRemovedGraphCatalogView(catalogFixture(ids), target);
        const diagnosticsOnce = withoutRemovedGraphDiagnosticsView(diagnosticsFixture(ids), target);

        expect(withoutRemovedGraphCatalogView(catalogOnce, target)).toEqual(catalogOnce);
        expect(withoutRemovedGraphDiagnosticsView(diagnosticsOnce, target)).toEqual(diagnosticsOnce);
      }),
      {numRuns: 100},
    );
  });
});

function response(state: ManagerGraphViewRemovalState): ManagerGraphViewRemovalResponse {
  return {
    approvalDigest: `sha256:${'a'.repeat(64)}`,
    output: 'Would remove exact view and preserve shared snapshot data.',
    result: {state},
  };
}

function catalogFixture(worktreeIds: readonly string[]): GraphCatalog {
  const views = worktreeIds.map(viewFixture);
  return {
    builds: [],
    diagnostics: [],
    repositories:
      views.length === 0
        ? []
        : [
            {
              defaultViewId: views[0].id,
              displayName: 'Repository',
              id: 'repository-group',
              repositoryId: 'repository',
              views,
              viewsTruncated: false,
            } satisfies GraphRepositoryGroup,
          ],
    waiterCount: 0,
    waiters: [],
  };
}

function diagnosticsFixture(worktreeIds: readonly string[]): CodeGraphLocalDiagnosticsReport {
  return {
    databases: [
      {
        builds: [],
        checkoutId: 'checkout',
        healthState: 'checked',
        issues: [],
        lifecycle: [],
        storage: {checkoutId: 'checkout', state: 'missing'},
        views: worktreeIds.map(worktreeId => ({
          localAssociation: {available: false, state: 'missing'},
          managementAvailable: true,
          metrics: 'deferred',
          model: 'workspace',
          projectCount: 0,
          projectsTruncated: false,
          repository: {displayName: 'Repository', repositoryId: 'repository'},
          snapshot: {
            commit: 'commit',
            dirty: false,
            edgeCount: 0,
            extractorSet: 'extractors',
            fileCount: 0,
            graphContentId: `snapshot-${worktreeId}`,
            id: `snapshot-${worktreeId}`,
            repositoryId: 'repository',
            state: 'ready',
            symbolCount: 0,
            worktreeId,
          },
          viewWorktreeId: worktreeId,
          workspaceCount: 0,
          workspacesTruncated: false,
        })),
        waiters: [],
      },
    ],
    generatedAt: '2026-08-10T00:00:00.000Z',
    mode: {analyze: false, deep: false},
    obsoleteStores: {bytes: 0, checkouts: [], fileCount: 0, unsafeEntryCount: 0},
    summary: {
      activeBuildCount: 0,
      analysisCompleteCount: 0,
      analysisPartialCount: 0,
      databaseCount: 1,
      deferredDatabaseCount: 0,
      healthyDatabaseCount: 1,
      migrationPendingDatabaseCount: 0,
      readySnapshotCount: worktreeIds.length,
      totalStorageBytes: 0,
      unhealthyDatabaseCount: 0,
      unreadableDatabaseCount: 0,
      viewCount: worktreeIds.length,
      waiterCount: 0,
    },
    type: 'code-graph-diagnostics',
    version: 2,
  };
}

function viewFixture(worktreeId: string): GraphRepository {
  return {
    accounting: {attributedSymbols: 0, componentSymbols: 0, fallbackSymbols: 0, omittedSymbols: 0, totalSymbols: 0},
    checkoutId: 'checkout',
    displayName: 'Repository',
    id: `view-${worktreeId}`,
    label: worktreeId,
    localAssociation: {available: false, state: 'missing'},
    metrics: 'deferred',
    model: 'workspace',
    projectCount: 0,
    projects: [],
    projectsTruncated: false,
    snapshot: {
      commit: 'commit',
      dirty: false,
      edgeCount: 0,
      fileCount: 0,
      id: `snapshot-${worktreeId}`,
      symbolCount: 0,
    },
    worktreeId,
    workspaceCount: 0,
    workspaces: [],
    workspacesTruncated: false,
  };
}
