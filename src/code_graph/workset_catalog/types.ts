export const CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION = 1 as const;

export const CODE_GRAPH_WORKSET_CATALOG_LIMITS = {
  lookupKeysPerSymbol: 64,
  membersPerGeneration: 4_096,
  readPageMaximum: 1_000,
  symbolsPerProjection: 250_000,
  termsPerSymbol: 64,
} as const;

export type CodeGraphWorksetCatalogErrorReason =
  'busy' | 'corrupt' | 'incompatible' | 'invalid-input' | 'missing' | 'storage';

export class CodeGraphWorksetCatalogError extends Error {
  override readonly name = 'CodeGraphWorksetCatalogError';

  constructor(
    readonly reason: CodeGraphWorksetCatalogErrorReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface CodeGraphWorksetCatalogSpanV1 {
  readonly column: number;
  readonly endColumn: number;
  readonly endLine: number;
  readonly line: number;
}

export interface CodeGraphWorksetRoutingTermV1 {
  readonly term: string;
  readonly weight: number;
}

export interface CodeGraphWorksetRoutingSymbolV1 {
  readonly exported: boolean;
  readonly kind: string;
  readonly language: string;
  readonly lookupKeys: readonly string[];
  readonly name: string;
  readonly nodeId: string;
  readonly packageName?: string;
  /** Repository-relative, slash-normalized evidence path. */
  readonly path: string;
  readonly qualifiedName: string;
  readonly span: CodeGraphWorksetCatalogSpanV1;
  readonly terms: readonly CodeGraphWorksetRoutingTermV1[];
}

export interface CodeGraphWorksetRoutingProjectionDraftV1 {
  readonly checkoutId: string;
  readonly commitId: string;
  readonly componentCount: number;
  readonly extractorGeneration: number;
  readonly projectorVersion: typeof CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION;
  readonly repositoryId: string;
  /** Digest of the ready repository snapshot from which this projection was derived. */
  readonly snapshotDigest: string;
  readonly snapshotId: string;
  readonly symbols: readonly CodeGraphWorksetRoutingSymbolV1[];
  readonly worktreeId: string;
}

export interface CodeGraphWorksetRoutingProjectionV1 extends CodeGraphWorksetRoutingProjectionDraftV1 {
  readonly projectionDigest: string;
}

export interface CodeGraphWorksetCatalogGenerationMemberV1 {
  readonly projection: CodeGraphWorksetRoutingProjectionV1;
  readonly repositoryKey: string;
}

export interface CodeGraphWorksetCatalogGenerationInputV1 {
  readonly manifestDigest: string;
  readonly members: readonly CodeGraphWorksetCatalogGenerationMemberV1[];
  readonly worksetName: string;
}

export interface CodeGraphWorksetCatalogGenerationIdentityV1 {
  readonly digest: string;
  readonly id: string;
  readonly members: readonly CodeGraphWorksetCatalogGenerationMemberV1[];
}

export interface CodeGraphWorksetCatalogGenerationDigestMemberV1 {
  readonly projectionDigest: string;
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly snapshotId: string;
}

export interface CodeGraphWorksetCatalogGenerationReceiptV1 {
  readonly digest: string;
  readonly id: string;
  readonly manifestDigest: string;
  readonly memberCount: number;
  readonly state: 'ready' | 'staging';
  readonly worksetName: string;
}

export interface CodeGraphWorksetCatalogPublishedMemberV1 {
  readonly checkoutId: string;
  readonly commitId: string;
  readonly ordinal: number;
  readonly projectionDigest: string;
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly snapshotDigest: string;
  readonly snapshotId: string;
  readonly symbolCount: number;
  readonly worktreeId: string;
}

export interface CodeGraphWorksetCatalogPublishedGenerationV1 {
  readonly digest: string;
  readonly id: string;
  readonly manifestDigest: string;
  readonly members: readonly CodeGraphWorksetCatalogPublishedMemberV1[];
  readonly worksetName: string;
}

export interface CodeGraphWorksetCatalogRoutingSymbolRecordV1 extends CodeGraphWorksetRoutingSymbolV1 {
  readonly ordinal: number;
  readonly projectionDigest: string;
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly snapshotId: string;
}

export interface CodeGraphWorksetCatalogRoutingSymbolCursorV1 {
  readonly nodeId: string;
  readonly ordinal: number;
}

export interface CodeGraphWorksetCatalogRoutingSymbolPageV1 {
  readonly generationId: string;
  readonly next?: CodeGraphWorksetCatalogRoutingSymbolCursorV1;
  readonly symbols: readonly CodeGraphWorksetCatalogRoutingSymbolRecordV1[];
  readonly worksetName: string;
}

export type CodeGraphWorksetCatalogHealthV1 =
  | {readonly state: 'missing'}
  | {readonly schemaVersion: number; readonly state: 'incompatible'}
  | {readonly detail: string; readonly state: 'corrupt' | 'unavailable'}
  | {
      readonly projectionCount: number;
      readonly publishedWorksets: number;
      readonly readyGenerations: number;
      readonly schemaVersion: number;
      readonly stagingGenerations: number;
      readonly state: 'ok';
    };

export interface CodeGraphWorksetCatalogMaintenanceOptionsV1 {
  /** Delete at most this many retired generations in one call. */
  readonly generationLimit?: number;
  /** Delete at most this many unreferenced projections in one call. */
  readonly projectionLimit?: number;
  /** Optional ISO instant; staging generations older than it are retired first. */
  readonly stagingBefore?: string;
}

export interface CodeGraphWorksetCatalogMaintenanceResultV1 {
  readonly projectionsDeleted: number;
  readonly retiredGenerationsDeleted: number;
  readonly stagingGenerationsRetired: number;
}

export interface CodeGraphWorksetCatalogRecoveryResultV1 {
  readonly previousState: CodeGraphWorksetCatalogHealthV1['state'];
  readonly rebuilt: boolean;
}
