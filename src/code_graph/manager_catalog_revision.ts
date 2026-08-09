import {Effect, Path} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {codeGraphDatabasePaths} from './maintenance.js';
import {compareCodeUnits} from './ordering.js';
import {CodeGraphStore} from './store.js';
import {type CodeGraphActiveViewIdentity} from './store_models.js';

export const MANAGER_CATALOG_REVISION_VISIBLE_VIEW_LIMIT = 32;

export interface ManagerGraphCatalogRevisionDatabase {
  readonly checkoutId: string;
  readonly state: 'ready' | 'unavailable';
  readonly views: readonly CodeGraphActiveViewIdentity[];
  readonly viewsTruncated: boolean;
}

/** Stable, path-free and order-independent revision for visible active pointers. */
export function managerGraphCatalogRevision(databases: readonly ManagerGraphCatalogRevisionDatabase[]): string {
  const canonical = databases
    .map(database => ({
      checkoutId: database.checkoutId,
      state: database.state,
      views: database.views
        .map(view => ({
          activatedAt: view.activatedAt ?? '',
          repositoryId: view.repositoryId,
          snapshotId: view.snapshotId,
          worktreeId: view.worktreeId,
        }))
        .sort(compareRevisionViews),
      viewsTruncated: database.viewsTruncated,
    }))
    .sort((left, right) => compareCodeUnits(left.checkoutId, right.checkoutId));
  return sha256HexSync(`threadnote-manager-graph-catalog-revision-v1\n${JSON.stringify(canonical)}`);
}

/** Read only the first visible active-pointer identities from each local graph. */
export const observeManagerGraphCatalogRevision = Effect.fn('codeGraph.observeManagerCatalogRevision')(function* (
  threadnoteHome: string,
) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  const observations = yield* Effect.forEach(
    databases,
    database => {
      const checkoutId = path.basename(path.dirname(database));
      return store.loadActiveViewIdentities(database, MANAGER_CATALOG_REVISION_VISIBLE_VIEW_LIMIT + 1).pipe(
        Effect.map(views => ({
          checkoutId,
          state: 'ready' as const,
          views: views.slice(0, MANAGER_CATALOG_REVISION_VISIBLE_VIEW_LIMIT),
          viewsTruncated: views.length > MANAGER_CATALOG_REVISION_VISIBLE_VIEW_LIMIT,
        })),
        Effect.catch(() =>
          Effect.succeed({
            checkoutId,
            state: 'unavailable' as const,
            views: [],
            viewsTruncated: false,
          }),
        ),
      );
    },
    {concurrency: 2},
  );
  return managerGraphCatalogRevision(observations);
});

function compareRevisionViews(
  left: {
    readonly activatedAt: string;
    readonly repositoryId: string;
    readonly snapshotId: string;
    readonly worktreeId: string;
  },
  right: {
    readonly activatedAt: string;
    readonly repositoryId: string;
    readonly snapshotId: string;
    readonly worktreeId: string;
  },
): number {
  return (
    compareCodeUnits(left.repositoryId, right.repositoryId) ||
    compareCodeUnits(left.worktreeId, right.worktreeId) ||
    compareCodeUnits(left.snapshotId, right.snapshotId) ||
    compareCodeUnits(left.activatedAt, right.activatedAt)
  );
}
