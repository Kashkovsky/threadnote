import {Effect, Path} from 'effect';
import {codeGraphLayout} from '../layout.js';
import {CodeGraphStore} from '../store.js';
import type {RepositoryIdentity} from '../types.js';
import {
  buildCodeGraphReadySnapshotRoutingProjectionScoped,
  streamCodeGraphReadySnapshotRoutingProjectionScoped,
} from './snapshot_projection.js';
import {
  appendCodeGraphWorksetCatalogProjectionPage,
  beginCodeGraphWorksetCatalogProjection,
  completeCodeGraphWorksetCatalogProjection,
} from './store.js';
import {CodeGraphWorksetCatalogError} from './types.js';

export interface CodeGraphWorksetRoutingProjectionRequestV1 {
  readonly identity: Pick<RepositoryIdentity, 'checkoutId' | 'repositoryId' | 'worktreeId'>;
  readonly leaseDurationMilliseconds?: number;
  readonly pageSize?: number;
  /** @internal Test/benchmark observer for the largest live normalized symbol page. */
  readonly observeBufferedSymbols?: (count: number) => void;
  /** @internal Test/benchmark observer for the session-local reverse routing surface. */
  readonly observePreparedRoutingSurface?: (counts: {readonly lookupKeys: number; readonly terms: number}) => void;
  readonly snapshotId?: string;
  readonly threadnoteHome: string;
}

/** Runtime adapter that resolves the authoritative per-checkout graph path. */
export const buildCodeGraphWorksetRoutingProjectionScoped = Effect.fn(
  'codeGraphWorksetCatalog.buildRoutingProjectionScoped',
)(function* (request: CodeGraphWorksetRoutingProjectionRequestV1) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const layout = yield* Effect.try({
    try: () => codeGraphLayout(path, request.threadnoteHome, request.identity.checkoutId, request.identity.worktreeId),
    catch: cause =>
      CodeGraphWorksetCatalogError.of('invalid-input', 'Workset routing projection identity is invalid.', {cause}),
  });
  return yield* buildCodeGraphReadySnapshotRoutingProjectionScoped(store, {
    checkoutId: request.identity.checkoutId,
    databasePath: layout.databasePath,
    ...(request.leaseDurationMilliseconds === undefined
      ? {}
      : {leaseDurationMilliseconds: request.leaseDurationMilliseconds}),
    ...(request.pageSize === undefined ? {} : {pageSize: request.pageSize}),
    ...(request.observeBufferedSymbols === undefined ? {} : {observeBufferedSymbols: request.observeBufferedSymbols}),
    ...(request.observePreparedRoutingSurface === undefined
      ? {}
      : {observePreparedRoutingSurface: request.observePreparedRoutingSurface}),
    repositoryId: request.identity.repositoryId,
    ...(request.snapshotId === undefined ? {} : {snapshotId: request.snapshotId}),
    worktreeId: request.identity.worktreeId,
  });
});

/** Stream one leased ready snapshot into the home-global catalog with page-bounded memory. */
export const stageCodeGraphWorksetRoutingProjectionScoped = Effect.fn(
  'codeGraphWorksetCatalog.stageRoutingProjectionScoped',
)(function* (request: CodeGraphWorksetRoutingProjectionRequestV1) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const layout = yield* Effect.try({
    try: () => codeGraphLayout(path, request.threadnoteHome, request.identity.checkoutId, request.identity.worktreeId),
    catch: cause =>
      CodeGraphWorksetCatalogError.of('invalid-input', 'Workset routing projection identity is invalid.', {cause}),
  });
  return yield* streamCodeGraphReadySnapshotRoutingProjectionScoped(
    store,
    {
      checkoutId: request.identity.checkoutId,
      databasePath: layout.databasePath,
      ...(request.leaseDurationMilliseconds === undefined
        ? {}
        : {leaseDurationMilliseconds: request.leaseDurationMilliseconds}),
      ...(request.pageSize === undefined ? {} : {pageSize: request.pageSize}),
      ...(request.observeBufferedSymbols === undefined ? {} : {observeBufferedSymbols: request.observeBufferedSymbols}),
      ...(request.observePreparedRoutingSurface === undefined
        ? {}
        : {observePreparedRoutingSurface: request.observePreparedRoutingSurface}),
      repositoryId: request.identity.repositoryId,
      ...(request.snapshotId === undefined ? {} : {snapshotId: request.snapshotId}),
      worktreeId: request.identity.worktreeId,
    },
    {
      append: (projectionDigest, stagingToken, symbols) =>
        appendCodeGraphWorksetCatalogProjectionPage(request.threadnoteHome, {
          projectionDigest,
          stagingToken,
          symbols,
        }),
      begin: (receipt, reservedLogicalBytes) =>
        beginCodeGraphWorksetCatalogProjection(request.threadnoteHome, receipt, reservedLogicalBytes),
      complete: (projectionDigest, stagingToken) =>
        completeCodeGraphWorksetCatalogProjection(request.threadnoteHome, {
          projectionDigest,
          stagingToken,
        }).pipe(Effect.asVoid),
    },
  );
});

/** Build one projection and release its lease when the projection returns. */
export const buildCodeGraphWorksetRoutingProjection = Effect.fn('codeGraphWorksetCatalog.buildRoutingProjection')(
  function* (request: CodeGraphWorksetRoutingProjectionRequestV1) {
    const {assertLease: _assertLease, ...built} = yield* buildCodeGraphWorksetRoutingProjectionScoped(request).pipe(
      Effect.scoped,
    );
    return built;
  },
);
