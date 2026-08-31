import {Effect, FileSystem, Path} from 'effect';
import {
  CODE_GRAPH_SOURCE_SPAN_CANONICALIZATION_V1,
  createCodeGraphSourceSpanCanonicalizer,
} from '../code_graph/citation_primitives.js';
import {codeGraphCitationSourceKey, readCodeGraphCitationSources} from '../code_graph/citation_source.js';
import {decodeUtf8} from '../code_graph/inventory_content.js';
import {CodeGraphQueryService} from '../code_graph/query.js';
import {CodeGraphStore} from '../code_graph/store.js';
import {CodeGraphStoreError, type CodeGraphStatus, type CodeGraphSymbol} from '../code_graph/types.js';
import {
  resolveCodeGraphQualifiedRefTargets,
  type ResolvedCodeGraphQualifiedRefTargetV1,
} from '../code_graph/workset_query_v2.js';
import {sha256Hex} from '../effect/digest.js';
import {SystemInfo} from '../effect/system.js';
import {
  createMemoryCodeCitation,
  MAX_MEMORY_CODE_CITATIONS,
  MEMORY_CODE_CITATION_VERSION,
  type MemoryCodeCitationV1,
} from './code_citation.js';
import type {RuntimeConfig} from '../types.js';

const LOCAL_SYMBOL_REF = /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u;
const QUALIFIED_SYMBOL_REF = /^cgr_[0-9a-f]{40}$/u;

export const MEMORY_CODE_CITATION_GRAPH_PREPARATION_COMMAND = 'threadnote graph index --no-vectors' as const;
export const MEMORY_CODE_CITATION_WORKSET_PREPARATION_COMMAND = 'threadnote workset prepare' as const;

export type MemoryCodeCitationCaptureRecoveryCode = 'exact-current-evidence-unavailable' | 'ready-graph-unavailable';
export type MemoryCodeCitationCaptureFailureCode = 'code-reference-unresolved';

export type MemoryCodeCitationGraphPreparationV1 =
  | {
      readonly action: 'index-current-graph';
      readonly arguments: readonly [];
      readonly command: typeof MEMORY_CODE_CITATION_GRAPH_PREPARATION_COMMAND;
      readonly target: 'callerCwd';
    }
  | {
      readonly action: 'prepare-workset';
      readonly arguments: readonly [worksetName: string];
      readonly command: typeof MEMORY_CODE_CITATION_WORKSET_PREPARATION_COMMAND;
      readonly target: 'workset';
    };

export interface MemoryCodeCitationCaptureRecoveryV1 {
  readonly code: MemoryCodeCitationCaptureRecoveryCode;
  readonly indexingStarted: false;
  readonly observedGraph: {
    readonly freshness: CodeGraphStatus['freshness'];
    readonly readySnapshot: 'absent' | 'available';
    readonly stale: boolean;
  };
  readonly preparation: MemoryCodeCitationGraphPreparationV1;
  readonly recovery: 'prepare-current-graph';
  readonly retryCondition: 'after-current-graph-ready';
  readonly retryable: true;
  readonly type: 'memory-code-citation-capture-recovery';
  readonly version: 1;
}

export interface ExpectedMemoryCodeCitationCallerIdentity {
  readonly repositoryId: string;
  readonly worktreeId: string;
}

export class MemoryCodeCitationCaptureError extends Error {
  override readonly name = 'MemoryCodeCitationCaptureError';
  readonly failureCode?: MemoryCodeCitationCaptureFailureCode;
  readonly recovery?: MemoryCodeCitationCaptureRecoveryV1;
  /** Immediate retry eligibility preserved from a classified graph-store failure. */
  readonly retryable: boolean;

  constructor(
    message: string,
    recovery?: MemoryCodeCitationCaptureRecoveryV1,
    failureCode?: MemoryCodeCitationCaptureFailureCode,
    retryable = false,
  ) {
    super(message);
    this.recovery = recovery;
    this.failureCode = failureCode;
    this.retryable = retryable;
  }
}

interface CaptureTarget {
  readonly cwd: string;
  readonly index: number;
  readonly preparation: MemoryCodeCitationGraphPreparationV1;
  readonly ref: string;
  readonly target: {readonly kind: 'file'; readonly path: string} | {readonly kind: 'symbol'; readonly nodeId: string};
}

/**
 * Capture immutable code evidence only from an already-published, exact-current
 * graph. This path never attaches, indexes, refreshes, or requests maintenance.
 */
export const captureMemoryCodeCitations = Effect.fn('memoryCodeCitation.capture')(function* (
  config: RuntimeConfig,
  input: {
    readonly callerCwd: string;
    readonly expectedCallerIdentity?: ExpectedMemoryCodeCitationCallerIdentity;
    readonly refs?: readonly string[];
  },
) {
  const refs = yield* Effect.try({
    try: () => normalizeMemoryCodeRefs(input.refs ?? []),
    catch: cause => captureError('code references', cause),
  });
  if (refs.length === 0) return [] as readonly MemoryCodeCitationV1[];
  const path = yield* Path.Path;
  if (!path.isAbsolute(input.callerCwd)) {
    return yield* Effect.fail(new MemoryCodeCitationCaptureError('Code citation callerCwd must be absolute.'));
  }

  const query = yield* CodeGraphQueryService;
  if (input.expectedCallerIdentity) {
    const callerBefore = yield* query
      .status(config.agentContextHome, input.callerCwd, {
        observeWorktree: true,
        requestMaintenance: false,
      })
      .pipe(Effect.mapError(error => captureError('caller repository identity', error)));
    yield* requireExpectedCallerIdentity(callerBefore, input.expectedCallerIdentity);
  }

  const invalidQualifiedRef = refs.find(ref => ref.startsWith('cgr_') && !QUALIFIED_SYMBOL_REF.test(ref));
  if (invalidQualifiedRef !== undefined) {
    return yield* Effect.fail(
      new MemoryCodeCitationCaptureError(`Invalid qualified code graph reference: ${invalidQualifiedRef}.`),
    );
  }
  const qualifiedRefs = refs.filter(ref => QUALIFIED_SYMBOL_REF.test(ref));
  const qualifiedTargets = yield* resolveCodeGraphQualifiedRefTargets(config, qualifiedRefs, input.callerCwd).pipe(
    Effect.mapError(error => captureError('qualified code references', error)),
  );
  const qualifiedByRef = new Map(qualifiedTargets.map(target => [target.ref, target]));
  const targets = yield* Effect.forEach(refs, (ref, index) =>
    resolveCaptureTarget(input.callerCwd, ref, index, qualifiedByRef),
  );
  const groups = new Map<string, CaptureTarget[]>();
  for (const target of targets) {
    const group = groups.get(target.cwd) ?? [];
    group.push(target);
    groups.set(target.cwd, group);
  }
  const capturedGroups = yield* Effect.forEach(
    [...groups.entries()],
    ([cwd, group]) =>
      captureRepositoryGroup(config, cwd, group, cwd === input.callerCwd ? input.expectedCallerIdentity : undefined),
    {concurrency: 4},
  );
  if (input.expectedCallerIdentity) {
    const callerAfter = yield* query
      .status(config.agentContextHome, input.callerCwd, {
        observeWorktree: true,
        requestMaintenance: false,
      })
      .pipe(Effect.mapError(error => captureError('caller repository identity', error)));
    yield* requireExpectedCallerIdentity(callerAfter, input.expectedCallerIdentity);
  }
  const ordered = capturedGroups.flat().sort((left, right) => left.index - right.index);
  const seen = new Set<string>();
  const citations: MemoryCodeCitationV1[] = [];
  for (const item of ordered) {
    if (seen.has(item.citation.id)) continue;
    seen.add(item.citation.id);
    citations.push(item.citation);
  }
  return citations;
});

function resolveCaptureTarget(
  callerCwd: string,
  ref: string,
  index: number,
  qualifiedByRef: ReadonlyMap<string, ResolvedCodeGraphQualifiedRefTargetV1>,
) {
  return Effect.gen(function* () {
    if (QUALIFIED_SYMBOL_REF.test(ref)) {
      const target = qualifiedByRef.get(ref);
      if (target === undefined) {
        return yield* Effect.fail(
          new MemoryCodeCitationCaptureError(
            `Qualified code graph reference is unresolved: ${ref}.`,
            undefined,
            'code-reference-unresolved',
          ),
        );
      }
      return {
        cwd: target.cwd,
        index,
        preparation:
          target.route.kind === 'caller' ? callerGraphPreparation() : worksetGraphPreparation(target.route.name),
        ref,
        target: {kind: 'symbol', nodeId: target.nodeId},
      } satisfies CaptureTarget;
    }
    if (LOCAL_SYMBOL_REF.test(ref)) {
      return {
        cwd: callerCwd,
        index,
        preparation: callerGraphPreparation(),
        ref,
        target: {kind: 'symbol', nodeId: ref},
      } satisfies CaptureTarget;
    }
    if (ref.startsWith('cgs_')) {
      return yield* Effect.fail(new MemoryCodeCitationCaptureError(`Invalid local code graph reference: ${ref}.`));
    }
    return {
      cwd: callerCwd,
      index,
      preparation: callerGraphPreparation(),
      ref,
      target: {kind: 'file', path: ref},
    } satisfies CaptureTarget;
  });
}

const captureRepositoryGroup = Effect.fn('memoryCodeCitation.captureRepositoryGroup')(function* (
  config: RuntimeConfig,
  cwd: string,
  targets: readonly CaptureTarget[],
  expectedCallerIdentity?: ExpectedMemoryCodeCitationCallerIdentity,
) {
  const query = yield* CodeGraphQueryService;
  const store = yield* CodeGraphStore;
  const fs = yield* FileSystem.FileSystem;
  const before = yield* query
    .status(config.agentContextHome, cwd, {
      observeWorktree: true,
      requestMaintenance: false,
    })
    .pipe(Effect.mapError(error => captureError(cwd, error)));
  if (expectedCallerIdentity) yield* requireExpectedCallerIdentity(before, expectedCallerIdentity);
  const snapshot = yield* Effect.try({
    try: () => requireExactCurrentSnapshot(before, captureGroupPreparation(targets)),
    catch: cause => captureError(cwd, cause),
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(store.acquireSnapshotLease(before.databasePath, snapshot.id, 60_000), token =>
        store.releaseSnapshotLease(before.databasePath, token).pipe(Effect.catch(() => Effect.void)),
      );
      const repositoryRoot = yield* fs
        .realPath(before.identity.repoRoot)
        .pipe(Effect.mapError(error => captureError(before.identity.repoRoot, error)));

      const fileTargets = targets.filter(
        (target): target is CaptureTarget & {readonly target: {readonly kind: 'file'; readonly path: string}} =>
          target.target.kind === 'file',
      );
      const symbolTargets = targets.filter(
        (target): target is CaptureTarget & {readonly target: {readonly kind: 'symbol'; readonly nodeId: string}} =>
          target.target.kind === 'symbol',
      );
      const evidence = yield* store
        .effectiveSnapshotCitationEvidence(before.databasePath, snapshot.id, {
          paths: fileTargets.map(target => target.target.path),
          symbolIds: symbolTargets.map(target => target.target.nodeId),
        })
        .pipe(Effect.mapError(error => captureError(cwd, error)));
      const files = evidence.filesByPaths;
      const symbols = evidence.symbolsByIds;
      const fileByPath = new Map(
        files.flatMap(observation => (observation.file ? [[observation.path, observation.file]] : [])),
      );
      const symbolById = new Map(symbols.map(symbol => [symbol.id, symbol]));
      const sourceBytes = yield* readCodeGraphCitationSources({
        objectFormat: before.identity.objectFormat,
        repositoryRoot,
        sourceCommit: snapshot.commit,
        sources: [
          ...fileTargets.flatMap(target => {
            const file = fileByPath.get(target.target.path);
            return file === undefined
              ? []
              : [{expectedContentHash: file.contentHash, repositoryPath: file.path, requireBytes: false}];
          }),
          ...symbolTargets.flatMap(target => {
            const symbol = symbolById.get(target.target.nodeId);
            return symbol === undefined
              ? []
              : [{expectedContentHash: symbol.contentHash, repositoryPath: symbol.path, requireBytes: true}];
          }),
        ],
      });
      const sourceCache = new Map<
        string,
        {
          readonly bytes: Uint8Array;
          readonly canonicalizer?: ReturnType<typeof createCodeGraphSourceSpanCanonicalizer>;
        }
      >();
      const readSource = (repositoryPath: string, expectedContentHash: string, needsText: boolean) =>
        Effect.gen(function* () {
          const cacheKey = `${repositoryPath}\0${expectedContentHash}`;
          const cached = sourceCache.get(cacheKey);
          if (cached && (!needsText || cached.canonicalizer !== undefined)) return cached;
          const bytes =
            cached?.bytes ?? sourceBytes.get(codeGraphCitationSourceKey({expectedContentHash, repositoryPath}));
          if (bytes === undefined) {
            return yield* Effect.fail(
              new MemoryCodeCitationCaptureError(`Code citation source changed during capture: ${repositoryPath}.`),
            );
          }
          const source = needsText ? decodeUtf8(bytes) : undefined;
          if (needsText && source === undefined) {
            return yield* Effect.fail(
              new MemoryCodeCitationCaptureError(`Cited symbol source is not valid UTF-8: ${repositoryPath}.`),
            );
          }
          const loaded = {
            ...(source === undefined ? {} : {canonicalizer: createCodeGraphSourceSpanCanonicalizer(source)}),
            bytes,
          };
          sourceCache.set(cacheKey, loaded);
          return loaded;
        });
      const captureFileCitation = Effect.fn('memoryCodeCitation.captureFile')(function* (
        repositoryPath: string,
        contentHash: string,
        index: number,
      ) {
        yield* readSource(repositoryPath, contentHash, false);
        return {
          citation: yield* createCitation({
            extractorSet: snapshot.extractorSet,
            fileContentHash: {algorithm: 'sha256', value: contentHash},
            path: repositoryPath,
            repositoryId: before.identity.repositoryId,
            repositoryIdentityKind: before.identity.remoteIdentity ? 'remote' : 'local',
            sourceCommit: snapshot.commit,
            sourceDirty: snapshot.dirty,
            ...(snapshot.graphContentId === undefined ? {} : {sourceGraphContentId: snapshot.graphContentId}),
            sourceSnapshotId: snapshot.id,
            target: {kind: 'file'},
            version: MEMORY_CODE_CITATION_VERSION,
          }),
          index,
        };
      });

      const results = yield* Effect.forEach(
        targets,
        target =>
          Effect.gen(function* () {
            if (target.target.kind === 'file') {
              const file = fileByPath.get(target.target.path);
              if (!file) {
                return yield* Effect.fail(
                  new MemoryCodeCitationCaptureError(
                    `Code citation path is not present in the exact current graph: ${target.target.path}. Use a graph-indexed repository-relative path.`,
                    undefined,
                    'code-reference-unresolved',
                  ),
                );
              }
              return yield* captureFileCitation(file.path, file.contentHash, target.index);
            }
            const symbol = symbolById.get(target.target.nodeId);
            if (!symbol) {
              return yield* Effect.fail(
                new MemoryCodeCitationCaptureError(
                  `Code graph symbol is absent from the exact current graph: ${target.target.nodeId}.`,
                  undefined,
                  'code-reference-unresolved',
                ),
              );
            }
            if (isFileRootSymbol(symbol)) {
              return yield* captureFileCitation(symbol.path, symbol.contentHash, target.index);
            }
            return yield* captureSymbolCitation(before, snapshot, symbol, target.index, readSource);
          }).pipe(Effect.mapError(error => captureError(target.ref, error))),
        {concurrency: 4},
      );

      const after = yield* query
        .status(config.agentContextHome, cwd, {
          observeWorktree: true,
          requestMaintenance: false,
        })
        .pipe(Effect.mapError(error => captureError(cwd, error)));
      if (!sameExactSnapshot(before, after)) {
        return yield* Effect.fail(
          new MemoryCodeCitationCaptureError(
            'Repository graph or worktree changed while code citations were captured.',
          ),
        );
      }
      if (expectedCallerIdentity) yield* requireExpectedCallerIdentity(after, expectedCallerIdentity);
      return results;
    }),
  );
});

const requireExpectedCallerIdentity = Effect.fn('memoryCodeCitation.requireExpectedCallerIdentity')(function* (
  status: CodeGraphStatus,
  expected: ExpectedMemoryCodeCitationCallerIdentity,
) {
  if (status.identity.repositoryId !== expected.repositoryId || status.identity.worktreeId !== expected.worktreeId) {
    return yield* Effect.fail(
      new MemoryCodeCitationCaptureError('Code citation caller repository identity changed during capture.'),
    );
  }
});

function isFileRootSymbol(symbol: CodeGraphSymbol): boolean {
  return ['asset', 'document', 'file', 'module', 'resource'].includes(symbol.kind);
}

const captureSymbolCitation = Effect.fn('memoryCodeCitation.captureSymbol')(function* (
  status: CodeGraphStatus,
  snapshot: NonNullable<CodeGraphStatus['readySnapshot']>,
  symbol: CodeGraphSymbol,
  index: number,
  readSource: (
    path: string,
    expectedContentHash: string,
    needsText: boolean,
  ) => Effect.Effect<
    {
      readonly bytes: Uint8Array;
      readonly canonicalizer?: ReturnType<typeof createCodeGraphSourceSpanCanonicalizer>;
    },
    unknown,
    SystemInfo
  >,
) {
  const loaded = yield* readSource(symbol.path, symbol.contentHash, true);
  const fragment = loaded.canonicalizer!.fragment(symbol.span);
  if (!fragment.ok) {
    return yield* Effect.fail(
      new MemoryCodeCitationCaptureError(
        `Code graph returned an invalid source span for ${symbol.id}: ${fragment.reason}.`,
      ),
    );
  }
  const signatureHash = symbol.signature === undefined ? undefined : yield* sha256Hex(symbol.signature);
  return {
    citation: yield* createCitation({
      extractorSet: snapshot.extractorSet,
      fileContentHash: {algorithm: 'sha256', value: symbol.contentHash},
      path: symbol.path,
      repositoryId: status.identity.repositoryId,
      repositoryIdentityKind: status.identity.remoteIdentity ? 'remote' : 'local',
      sourceCommit: snapshot.commit,
      sourceDirty: snapshot.dirty,
      ...(snapshot.graphContentId === undefined ? {} : {sourceGraphContentId: snapshot.graphContentId}),
      sourceSnapshotId: snapshot.id,
      target: {
        fragmentCanonicalization: CODE_GRAPH_SOURCE_SPAN_CANONICALIZATION_V1,
        fragmentHash: {algorithm: 'sha256', value: fragment.fragment.sha256},
        kind: 'symbol',
        language: symbol.language,
        name: symbol.name,
        nodeId: symbol.id,
        qualifiedName: symbol.qualifiedName,
        ...(signatureHash === undefined ? {} : {signatureHash: {algorithm: 'sha256' as const, value: signatureHash}}),
        span: symbol.span,
        symbolKind: symbol.kind,
      },
      version: MEMORY_CODE_CITATION_VERSION,
    }),
    index,
  };
});

export function normalizeMemoryCodeRefs(refs: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) throw new MemoryCodeCitationCaptureError('Code references must not be empty.');
    if (
      !LOCAL_SYMBOL_REF.test(ref) &&
      !QUALIFIED_SYMBOL_REF.test(ref) &&
      (ref.startsWith('/') ||
        ref.includes('\\') ||
        ref.split('/').some(segment => !segment || segment === '.' || segment === '..'))
    ) {
      throw new MemoryCodeCitationCaptureError(`Code reference must be a safe repository-relative path: ${ref}.`);
    }
    if (!seen.has(ref)) {
      seen.add(ref);
      normalized.push(ref);
    }
  }
  if (normalized.length > MAX_MEMORY_CODE_CITATIONS) {
    throw new MemoryCodeCitationCaptureError(`A memory may cite at most ${MAX_MEMORY_CODE_CITATIONS} code references.`);
  }
  return normalized;
}

function createCitation(input: Parameters<typeof createMemoryCodeCitation>[0]) {
  return Effect.try({
    try: () => createMemoryCodeCitation(input),
    catch: cause => captureError('canonical citation metadata', cause),
  });
}

function requireExactCurrentSnapshot(
  status: CodeGraphStatus,
  preparation: MemoryCodeCitationGraphPreparationV1,
): NonNullable<CodeGraphStatus['readySnapshot']> {
  if (status.readySnapshot === undefined) {
    throw new MemoryCodeCitationCaptureError(
      `Code citations require an already-published ready graph; ${captureRecoveryMessage(preparation)} No indexing was started.`,
      captureRecovery(status, 'ready-graph-unavailable', preparation),
    );
  }
  if (status.stale || status.freshness !== 'current') {
    throw new MemoryCodeCitationCaptureError(
      `Code citations require exact current graph evidence; ${captureRecoveryMessage(preparation)} No indexing was started.`,
      captureRecovery(status, 'exact-current-evidence-unavailable', preparation),
    );
  }
  return status.readySnapshot;
}

function captureRecovery(
  status: CodeGraphStatus,
  code: MemoryCodeCitationCaptureRecoveryCode,
  preparation: MemoryCodeCitationGraphPreparationV1,
): MemoryCodeCitationCaptureRecoveryV1 {
  return {
    code,
    indexingStarted: false,
    observedGraph: {
      freshness: status.freshness,
      readySnapshot: status.readySnapshot === undefined ? 'absent' : 'available',
      stale: status.stale,
    },
    preparation,
    recovery: 'prepare-current-graph',
    retryCondition: 'after-current-graph-ready',
    retryable: true,
    type: 'memory-code-citation-capture-recovery',
    version: 1,
  };
}

function callerGraphPreparation(): MemoryCodeCitationGraphPreparationV1 {
  return {
    action: 'index-current-graph',
    arguments: [],
    command: MEMORY_CODE_CITATION_GRAPH_PREPARATION_COMMAND,
    target: 'callerCwd',
  };
}

function worksetGraphPreparation(worksetName: string): MemoryCodeCitationGraphPreparationV1 {
  return {
    action: 'prepare-workset',
    arguments: [worksetName],
    command: MEMORY_CODE_CITATION_WORKSET_PREPARATION_COMMAND,
    target: 'workset',
  };
}

function captureGroupPreparation(targets: readonly CaptureTarget[]): MemoryCodeCitationGraphPreparationV1 {
  return targets.find(target => target.preparation.target === 'callerCwd')?.preparation ?? targets[0]!.preparation;
}

function captureRecoveryMessage(preparation: MemoryCodeCitationGraphPreparationV1): string {
  return preparation.target === 'callerCwd'
    ? `run \`${preparation.command}\` from callerCwd, then retry.`
    : `prepare the routed Workset ${JSON.stringify(preparation.arguments[0])} with \`${preparation.command} <workset>\`, then retry.`;
}

function sameExactSnapshot(before: CodeGraphStatus, after: CodeGraphStatus): boolean {
  return (
    !after.stale &&
    after.freshness === 'current' &&
    before.databasePath === after.databasePath &&
    before.identity.repositoryId === after.identity.repositoryId &&
    before.identity.worktreeId === after.identity.worktreeId &&
    before.readySnapshot?.id === after.readySnapshot?.id
  );
}

function captureError(target: string, cause: unknown): MemoryCodeCitationCaptureError {
  return cause instanceof MemoryCodeCitationCaptureError
    ? cause
    : new MemoryCodeCitationCaptureError(
        `Could not capture code citation ${target}: ${cause instanceof Error ? cause.message : String(cause)}`,
        undefined,
        undefined,
        cause instanceof CodeGraphStoreError && cause.retryable,
      );
}
