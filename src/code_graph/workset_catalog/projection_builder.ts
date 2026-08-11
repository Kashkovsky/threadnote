import {Effect, Path} from 'effect';
import {codeGraphLayout} from '../layout.js';
import {CodeGraphStore} from '../store.js';
import type {RepositoryIdentity} from '../types.js';
import {buildCodeGraphReadySnapshotRoutingProjection} from './snapshot_projection.js';
import {CodeGraphWorksetCatalogError} from './types.js';

export interface CodeGraphWorksetRoutingProjectionRequestV1 {
  readonly identity: Pick<RepositoryIdentity, 'checkoutId' | 'repositoryId' | 'worktreeId'>;
  readonly leaseDurationMilliseconds?: number;
  readonly pageSize?: number;
  readonly snapshotId?: string;
  readonly threadnoteHome: string;
}

/** Runtime adapter that resolves the authoritative per-checkout graph path. */
export const buildCodeGraphWorksetRoutingProjection = Effect.fn('codeGraphWorksetCatalog.buildRoutingProjection')(
  function* (request: CodeGraphWorksetRoutingProjectionRequestV1) {
    const path = yield* Path.Path;
    const store = yield* CodeGraphStore;
    const layout = yield* Effect.try({
      try: () =>
        codeGraphLayout(path, request.threadnoteHome, request.identity.checkoutId, request.identity.worktreeId),
      catch: cause =>
        new CodeGraphWorksetCatalogError('invalid-input', 'Workset routing projection identity is invalid.', {cause}),
    });
    return yield* buildCodeGraphReadySnapshotRoutingProjection(store, {
      checkoutId: request.identity.checkoutId,
      databasePath: layout.databasePath,
      ...(request.leaseDurationMilliseconds === undefined
        ? {}
        : {leaseDurationMilliseconds: request.leaseDurationMilliseconds}),
      ...(request.pageSize === undefined ? {} : {pageSize: request.pageSize}),
      repositoryId: request.identity.repositoryId,
      ...(request.snapshotId === undefined ? {} : {snapshotId: request.snapshotId}),
      worktreeId: request.identity.worktreeId,
    });
  },
);
