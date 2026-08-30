import {Clock, Data, Effect, FileSystem, Option, Path, Result} from 'effect';
import {CodeGraphQueryService} from '../code_graph/query.js';
import {withMemoryUriLocks} from '../effect/memory_lock.js';
import {sha256Hex} from '../effect/digest.js';
import {ResourceStore} from '../effect/resource-store.js';
import {uriSegment} from '../manifest.js';
import {parseResourceId} from '../storage/resource-id.js';
import type {DoctorCheck, RuntimeConfig} from '../types.js';
import {
  captureMemoryCodeCitations,
  type MemoryCodeCitationCaptureRecoveryV1,
  MemoryCodeCitationCaptureError,
  normalizeMemoryCodeRefs,
} from './code_citation_capture.js';
import {MEMORY_SCHEMA_VERSION, type MemoryCodeCitationV1} from './code_citation.js';
import {discardMemoryRelocation} from './relocation.js';
import {
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryMetadata,
  type MemoryRecord,
} from './document.js';

export const DEFERRED_CODE_ANCHOR_INTENT_VERSION = 1 as const;
export const DEFERRED_CODE_ANCHOR_FINALIZATION_VERSION = 1 as const;
export const DEFAULT_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT = 25;
export const MAX_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT = 100;
const MAX_DEFERRED_CODE_ANCHOR_INTENT_BYTES = 128 * 1024;
const DEFERRED_CODE_ANCHOR_SCAN_CURSOR_NAME = 'scan-cursor-v1';
const MAX_DEFERRED_CODE_ANCHOR_CURSOR_BYTES = 512;

export class DeferredCodeAnchorError extends Data.TaggedError('DeferredCodeAnchorError')<{
  readonly message: string;
}> {}

const deferredCodeAnchorError = (message: string) => new DeferredCodeAnchorError({message});

export type MemoryCodeCitationPolicy = 'defer' | 'require-current';

export interface DeferredCodeAnchorWriteRequest {
  readonly callerCwd: string;
  readonly codeRefs: readonly string[];
  readonly recovery: MemoryCodeCitationCaptureRecoveryV1;
}

export function withDeferredCodeAnchorMutationLocks<A, E, R>(
  fs: FileSystem.FileSystem,
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  uris: readonly (string | undefined)[],
  effect: Effect.Effect<A, E, R>,
) {
  const scopeKey = `threadnote-internal://deferred-code-anchor-mutations/${encodeURIComponent(config.account)}/${encodeURIComponent(config.user)}`;
  return withMemoryUriLocks(fs, config.agentContextHome, [scopeKey, ...uris], effect);
}

export interface DeferredCodeAnchorIntentV1 {
  /** The caller explicitly supplied every locator; graph-readiness deferral may be the private default. */
  readonly authorization: 'explicit-code-refs';
  readonly callerCwd: string;
  readonly codeRefs: readonly string[];
  readonly createdAt: string;
  readonly expectedMemoryHash: string;
  readonly intentId: string;
  readonly memoryId: string;
  readonly memoryUri: string;
  readonly repositoryId: string;
  readonly recovery: MemoryCodeCitationCaptureRecoveryV1;
  readonly type: 'threadnote-deferred-code-anchor-intent';
  readonly version: typeof DEFERRED_CODE_ANCHOR_INTENT_VERSION;
  readonly visibility: 'private-local';
  readonly worktreeId: string;
}

export type DeferredCodeAnchorEligibility =
  | {readonly state: 'eligible'}
  | {
      readonly reason:
        | 'canonical-memory-changed'
        | 'canonical-memory-missing'
        | 'memory-already-cited'
        | 'memory-id-changed'
        | 'memory-no-longer-active'
        | 'memory-no-longer-personal';
      readonly state: 'conflict';
    };

export interface DeferredCodeAnchorFinalizeItemV1 {
  readonly citationCount?: number;
  readonly code?: string;
  readonly memoryUri?: string;
  readonly reason?: string;
  readonly state: 'conflict' | 'failed' | 'finalized' | 'pending';
}

export interface DeferredCodeAnchorFinalizationReceiptV1 {
  readonly conflictCount: number;
  readonly failedCount: number;
  readonly finalizedCount: number;
  readonly items: readonly DeferredCodeAnchorFinalizeItemV1[];
  readonly pendingCount: number;
  readonly scannedCount: number;
  readonly type: 'threadnote-deferred-code-anchor-finalization';
  readonly version: typeof DEFERRED_CODE_ANCHOR_FINALIZATION_VERSION;
}

interface StoredDeferredCodeAnchorIntent {
  readonly kind: 'valid';
  readonly intent: DeferredCodeAnchorIntentV1;
  readonly name: string;
  readonly path: string;
}

interface InvalidDeferredCodeAnchorIntent {
  readonly kind: 'invalid';
  readonly name: string;
  readonly path: string;
  readonly uriDigest?: string;
}

type DeferredCodeAnchorIntentEntry = InvalidDeferredCodeAnchorIntent | StoredDeferredCodeAnchorIntent;

export interface DeferredMemoryObservation {
  readonly content: string;
  readonly hash: string;
  readonly record: MemoryRecord;
}

/**
 * Stage the private intent before the canonical memory write. A crash can leave
 * an orphaned intent, but cannot leave a successfully stored deferred memory
 * without its recovery intent. Finalization reconciles orphans fail-closed.
 */
export const stageDeferredCodeAnchorIntent = Effect.fn('memoryCodeAnchor.stage')(function* (
  config: RuntimeConfig,
  input: {
    readonly memoryContent: string;
    readonly memoryMetadata: MemoryMetadata;
    readonly memoryUri: string;
    readonly request: DeferredCodeAnchorWriteRequest;
  },
) {
  const canonicalUri = canonicalPersonalMemoryUri(config, input.memoryUri);
  const record = parseMemoryDocument(canonicalUri, input.memoryContent);
  if (!record || !record.metadata.memoryId) {
    return yield* Effect.fail(
      deferredCodeAnchorError('Deferred code anchors require a canonical memory with a stable memory_id.'),
    );
  }
  if (record.metadata.status !== 'active') {
    return yield* Effect.fail(deferredCodeAnchorError('Deferred code anchors may be staged only for active memories.'));
  }
  if (record.metadata.visibility === 'shared' || record.metadata.visibility === 'external') {
    return yield* Effect.fail(
      deferredCodeAnchorError('Deferred code anchors are private-local and cannot be staged for shared memory.'),
    );
  }
  if ((record.metadata.codeCitations?.length ?? 0) > 0) {
    return yield* Effect.fail(deferredCodeAnchorError('Deferred code anchors require an uncited canonical memory.'));
  }
  if (record.metadata.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    return yield* Effect.fail(
      deferredCodeAnchorError(`Deferred code anchors require memory schema version ${MEMORY_SCHEMA_VERSION}.`),
    );
  }
  if (input.memoryMetadata.memoryId !== record.metadata.memoryId) {
    return yield* Effect.fail(
      deferredCodeAnchorError('Deferred code-anchor memory identity changed during preparation.'),
    );
  }

  const refs = normalizeMemoryCodeRefs(input.request.codeRefs);
  if (refs.length === 0) {
    return yield* Effect.fail(deferredCodeAnchorError('Deferred code anchors require at least one code reference.'));
  }
  const path = yield* Path.Path;
  if (!path.isAbsolute(input.request.callerCwd)) {
    return yield* Effect.fail(deferredCodeAnchorError('Deferred code-anchor callerCwd must be absolute.'));
  }
  const query = yield* CodeGraphQueryService;
  const status = yield* query.status(config.agentContextHome, input.request.callerCwd, {
    observeWorktree: true,
    requestMaintenance: false,
  });
  const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const expectedMemoryHash = yield* memoryContentHash(input.memoryContent);
  const intentId = yield* deferredCodeAnchorIntentId({
    callerCwd: input.request.callerCwd,
    codeRefs: refs,
    expectedMemoryHash,
    memoryId: record.metadata.memoryId,
    memoryUri: canonicalUri,
    repositoryId: status.identity.repositoryId,
    recovery: input.request.recovery,
    worktreeId: status.identity.worktreeId,
  });
  const intent: DeferredCodeAnchorIntentV1 = {
    authorization: 'explicit-code-refs',
    callerCwd: input.request.callerCwd,
    codeRefs: refs,
    createdAt,
    expectedMemoryHash,
    intentId,
    memoryId: record.metadata.memoryId,
    memoryUri: canonicalUri,
    repositoryId: status.identity.repositoryId,
    recovery: input.request.recovery,
    type: 'threadnote-deferred-code-anchor-intent',
    version: DEFERRED_CODE_ANCHOR_INTENT_VERSION,
    visibility: 'private-local',
    worktreeId: status.identity.worktreeId,
  };
  yield* writeDeferredCodeAnchorIntent(config, intent);
  return intent;
});

export const hasDeferredCodeAnchorIntent = Effect.fn('memoryCodeAnchor.has')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
) {
  return (yield* findUrisWithDeferredCodeAnchorIntents(config, [memoryUri])).size === 1;
});

export const findUrisWithDeferredCodeAnchorIntents = Effect.fn('memoryCodeAnchor.findUris')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUris: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* existingPrivateDeferredCodeAnchorRoot(config);
  if (root === undefined) return new Set<string>();
  const names = yield* fs.readDirectory(root);
  const keyed = yield* Effect.forEach(
    [...new Set(memoryUris.map(uri => parseResourceId(uri).canonicalUri))],
    uri => deferredCodeAnchorUriDigest(uri).pipe(Effect.map(digest => ({digest, uri}))),
    {concurrency: 4},
  );
  return new Set(
    keyed
      .filter(candidate => names.some(name => isDeferredCodeAnchorIntentNameForDigest(name, candidate.digest)))
      .map(candidate => candidate.uri),
  );
});

export const discardDeferredCodeAnchorIntent = Effect.fn('memoryCodeAnchor.discard')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* deferredCodeAnchorIntentPaths(config, memoryUri);
  yield* Effect.forEach(paths, path => fs.remove(path, {force: true}), {concurrency: 4});
});

export const discardOtherDeferredCodeAnchorIntents = Effect.fn('memoryCodeAnchor.discardOther')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
  retainedIntentId: string,
) {
  const retainedPath = yield* deferredCodeAnchorIntentPath(config, memoryUri, retainedIntentId);
  const paths = (yield* deferredCodeAnchorIntentPaths(config, memoryUri)).filter(path => path !== retainedPath);
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.forEach(paths, path => fs.remove(path, {force: true}), {concurrency: 4});
  return paths.length;
});

export const discardDeferredCodeAnchorIntentsWithin = Effect.fn('memoryCodeAnchor.discardWithin')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
) {
  const canonical = parseResourceId(memoryUri).canonicalUri;
  yield* discardDeferredCodeAnchorIntent(config, canonical);
  const stored = yield* listDeferredCodeAnchorIntents(config);
  const prefix = `${canonical}/`;
  const matching = stored.filter(
    (entry): entry is StoredDeferredCodeAnchorIntent =>
      entry.kind === 'valid' && entry.intent.memoryUri.startsWith(prefix),
  );
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.forEach(matching, entry => fs.remove(entry.path, {force: true}), {concurrency: 4});
  return matching.length;
});

export function classifyDeferredCodeAnchorEligibility(
  intent: DeferredCodeAnchorIntentV1,
  observation: DeferredMemoryObservation | undefined,
): DeferredCodeAnchorEligibility {
  if (!observation) return {reason: 'canonical-memory-missing', state: 'conflict'};
  if (observation.record.metadata.memoryId !== intent.memoryId) {
    return {reason: 'memory-id-changed', state: 'conflict'};
  }
  if (observation.hash !== intent.expectedMemoryHash) {
    return {reason: 'canonical-memory-changed', state: 'conflict'};
  }
  if (observation.record.metadata.status !== 'active') {
    return {reason: 'memory-no-longer-active', state: 'conflict'};
  }
  if (observation.record.metadata.visibility === 'shared' || observation.record.metadata.visibility === 'external') {
    return {reason: 'memory-no-longer-personal', state: 'conflict'};
  }
  if ((observation.record.metadata.codeCitations?.length ?? 0) > 0) {
    return {reason: 'memory-already-cited', state: 'conflict'};
  }
  return {state: 'eligible'};
}

export const finalizeDeferredCodeAnchors = Effect.fn('memoryCodeAnchor.finalize')(function* (
  config: RuntimeConfig,
  options: {readonly limit?: number; readonly uris?: readonly string[]} = {},
) {
  const limit = boundedFinalizeLimit(options.limit);
  const requestedUris = new Set((options.uris ?? []).map(uri => canonicalPersonalMemoryUri(config, uri)));
  const requestedDigests = new Set(
    yield* Effect.forEach([...requestedUris], uri => deferredCodeAnchorUriDigest(uri), {concurrency: 4}),
  );
  const matching = (yield* listDeferredCodeAnchorIntents(config)).filter(
    entry =>
      requestedUris.size === 0 ||
      (entry.kind === 'valid'
        ? requestedUris.has(entry.intent.memoryUri)
        : entry.uriDigest !== undefined && requestedDigests.has(entry.uriDigest)),
  );
  const stored =
    requestedUris.size === 0
      ? yield* selectDeferredCodeAnchorFinalizationWindow(config, matching, limit)
      : matching.slice(0, limit);
  const items: DeferredCodeAnchorFinalizeItemV1[] = [];
  for (const entry of stored) {
    if (entry.kind === 'invalid') {
      items.push({
        code: 'invalid-intent',
        reason: 'Private deferred code-anchor intent is unreadable or malformed.',
        state: 'failed',
      });
      continue;
    }
    const finalized = yield* finalizeDeferredCodeAnchor(config, entry).pipe(Effect.result);
    items.push(
      Result.isSuccess(finalized)
        ? finalized.success
        : {
            code: 'finalization-error',
            memoryUri: entry.intent.memoryUri,
            reason: 'Deferred code-anchor finalization failed safely; retry or run threadnote doctor --dry-run.',
            state: 'failed',
          },
    );
  }
  return {
    conflictCount: items.filter(item => item.state === 'conflict').length,
    failedCount: items.filter(item => item.state === 'failed').length,
    finalizedCount: items.filter(item => item.state === 'finalized').length,
    items,
    pendingCount: items.filter(item => item.state === 'pending').length,
    scannedCount: items.length,
    type: 'threadnote-deferred-code-anchor-finalization',
    version: DEFERRED_CODE_ANCHOR_FINALIZATION_VERSION,
  } satisfies DeferredCodeAnchorFinalizationReceiptV1;
});

export const deferredCodeAnchorDoctorCheck = Effect.fn('memoryCodeAnchor.doctorCheck')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
) {
  const entries = yield* listDeferredCodeAnchorIntents(config);
  const invalid = entries.filter(entry => entry.kind === 'invalid').length;
  if (invalid > 0) {
    return {
      detail: `${invalid} malformed or unreadable private intent(s); run \`threadnote finalize-code-refs\` for a bounded failure receipt`,
      name: 'deferred code anchors',
      status: 'fail',
    } satisfies DoctorCheck;
  }
  if (entries.length > 0) {
    return {
      detail: `${entries.length} private code-anchor intent(s) are pending finalization`,
      name: 'deferred code anchors',
      status: 'warn',
    } satisfies DoctorCheck;
  }
  return {
    detail: 'no pending private code-anchor intents',
    name: 'deferred code anchors',
    status: 'ok',
  } satisfies DoctorCheck;
});

const finalizeDeferredCodeAnchor = Effect.fn('memoryCodeAnchor.finalizeOne')(function* (
  config: RuntimeConfig,
  entry: StoredDeferredCodeAnchorIntent,
) {
  const fs = yield* FileSystem.FileSystem;
  const query = yield* CodeGraphQueryService;
  const admission = yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [entry.intent.memoryUri],
    Effect.gen(function* () {
      const initial = yield* readDeferredMemoryObservation(config, entry.intent.memoryUri);
      const eligibility = classifyDeferredCodeAnchorEligibility(entry.intent, initial);
      if (eligibility.state === 'conflict') {
        yield* discardStoredDeferredCodeAnchorIntent(entry);
        return {
          item: {
            memoryUri: entry.intent.memoryUri,
            reason: eligibility.reason,
            state: 'conflict',
          } satisfies DeferredCodeAnchorFinalizeItemV1,
          state: 'rejected' as const,
        };
      }
      const status = yield* query.status(config.agentContextHome, entry.intent.callerCwd, {
        observeWorktree: true,
        requestMaintenance: false,
      });
      if (
        status.identity.repositoryId !== entry.intent.repositoryId ||
        status.identity.worktreeId !== entry.intent.worktreeId
      ) {
        yield* discardStoredDeferredCodeAnchorIntent(entry);
        return {
          item: {
            memoryUri: entry.intent.memoryUri,
            reason: 'caller-repository-identity-changed',
            state: 'conflict',
          } satisfies DeferredCodeAnchorFinalizeItemV1,
          state: 'rejected' as const,
        };
      }
      return {state: 'eligible' as const};
    }),
  );
  if (admission.state === 'rejected') return admission.item;

  const captured = yield* captureMemoryCodeCitations(config, {
    callerCwd: entry.intent.callerCwd,
    expectedCallerIdentity: {
      repositoryId: entry.intent.repositoryId,
      worktreeId: entry.intent.worktreeId,
    },
    refs: entry.intent.codeRefs,
  }).pipe(Effect.result);
  if (Result.isFailure(captured)) {
    if (captured.failure instanceof MemoryCodeCitationCaptureError && captured.failure.recovery) {
      return {
        code: captured.failure.recovery.code,
        memoryUri: entry.intent.memoryUri,
        reason: 'exact-current-graph-unavailable',
        state: 'pending',
      } satisfies DeferredCodeAnchorFinalizeItemV1;
    }
    return {
      code: 'citation-capture-failed',
      memoryUri: entry.intent.memoryUri,
      reason: 'Code citation capture failed safely; retry or run threadnote doctor --dry-run.',
      state: 'failed',
    } satisfies DeferredCodeAnchorFinalizeItemV1;
  }
  const citations = captured.success;
  return yield* withDeferredCodeAnchorMutationLocks(
    fs,
    config,
    [entry.intent.memoryUri],
    Effect.gen(function* () {
      const current = yield* readDeferredMemoryObservation(config, entry.intent.memoryUri);
      const currentEligibility = classifyDeferredCodeAnchorEligibility(entry.intent, current);
      if (currentEligibility.state === 'conflict') {
        yield* discardStoredDeferredCodeAnchorIntent(entry);
        return {
          memoryUri: entry.intent.memoryUri,
          reason: currentEligibility.reason,
          state: 'conflict',
        } satisfies DeferredCodeAnchorFinalizeItemV1;
      }
      const record = current!.record;
      const sourceCommit = commonCitationSourceCommit(citations);
      const memory = formatMemoryDocument(
        record.headerTitle,
        {
          ...record.metadata,
          codeCitations: citations,
          schemaVersion: MEMORY_SCHEMA_VERSION,
          ...(sourceCommit === undefined ? {} : {sourceCommit}),
          sourceObservedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        },
        record.body,
      );
      const store = yield* ResourceStore;
      yield* store.write(resourceStoreLocation(config), entry.intent.memoryUri, memory, {mode: 'upsert'});
      yield* discardMemoryRelocation(config, entry.intent.memoryUri);
      const verified = yield* store.read(resourceStoreLocation(config), entry.intent.memoryUri);
      const verifiedRecord = parseMemoryDocument(entry.intent.memoryUri, verified);
      if (!verifiedRecord || !deferredCodeAnchorFinalizationVerified(memory, verified)) {
        return yield* Effect.fail(
          deferredCodeAnchorError(`Deferred code-anchor verification failed for ${entry.intent.memoryUri}.`),
        );
      }
      yield* discardDeferredCodeAnchorIntent(config, entry.intent.memoryUri);
      return {
        citationCount: citations.length,
        memoryUri: entry.intent.memoryUri,
        state: 'finalized',
      } satisfies DeferredCodeAnchorFinalizeItemV1;
    }),
  );
});

export function deferredCodeAnchorFinalizationVerified(expected: string, actual: string): boolean {
  return canonicalMemoryDocumentContent(actual) === canonicalMemoryDocumentContent(expected);
}

const readDeferredMemoryObservation = Effect.fn('memoryCodeAnchor.readMemory')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
) {
  const store = yield* ResourceStore;
  const content = yield* store.read(resourceStoreLocation(config), memoryUri).pipe(
    Effect.map(Option.some),
    Effect.catchTag('ResourceNotFound', () => Effect.succeed(Option.none())),
  );
  if (Option.isNone(content)) return undefined;
  const record = parseMemoryDocument(memoryUri, content.value);
  if (!record) return undefined;
  return {
    content: content.value,
    hash: yield* memoryContentHash(content.value),
    record,
  } satisfies DeferredMemoryObservation;
});

const writeDeferredCodeAnchorIntent = Effect.fn('memoryCodeAnchor.writeIntent')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  intent: DeferredCodeAnchorIntentV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* ensurePrivateDeferredCodeAnchorRoot(config);
  const digest = yield* deferredCodeAnchorUriDigest(intent.memoryUri);
  const target = path.join(root, `${digest}-${intent.intentId}.json`);
  const temporary = `${target}.${randomDeferredCodeAnchorTemporarySuffix()}.tmp`;
  yield* fs.writeFileString(temporary, `${JSON.stringify(intent, undefined, 2)}\n`, {flag: 'wx', mode: 0o600});
  yield* fs
    .rename(temporary, target)
    .pipe(Effect.catch(error => fs.remove(temporary, {force: true}).pipe(Effect.andThen(Effect.fail(error)))));
  if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
    return yield* Effect.fail(deferredCodeAnchorError('Deferred code-anchor intent must not be a symbolic link.'));
  }
  yield* fs.chmod(target, 0o600);
});

const listDeferredCodeAnchorIntents = Effect.fn('memoryCodeAnchor.listIntents')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* existingPrivateDeferredCodeAnchorRoot(config);
  if (root === undefined) return [] as DeferredCodeAnchorIntentEntry[];
  const names = yield* fs.readDirectory(root);
  const entries: DeferredCodeAnchorIntentEntry[] = [];
  for (const name of [...names].sort()) {
    if (!name.endsWith('.json')) continue;
    const intentPath = path.join(root, name);
    const content = yield* readPrivateDeferredCodeAnchorIntent(fs, intentPath);
    const candidate = content === undefined ? undefined : parseDeferredCodeAnchorIntent(content);
    const parsed =
      candidate && (yield* storedDeferredCodeAnchorIntentMatchesAddress(config, candidate, name))
        ? candidate
        : undefined;
    entries.push(
      parsed
        ? {intent: parsed, kind: 'valid', name, path: intentPath}
        : {kind: 'invalid', name, path: intentPath, uriDigest: deferredCodeAnchorUriDigestFromName(name)},
    );
  }
  return entries;
});

const selectDeferredCodeAnchorFinalizationWindow = Effect.fn('memoryCodeAnchor.selectWindow')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  entries: readonly DeferredCodeAnchorIntentEntry[],
  limit: number,
) {
  if (entries.length <= limit) return entries;
  const cursor = yield* readDeferredCodeAnchorScanCursor(config);
  const start =
    cursor === undefined
      ? 0
      : Math.max(
          0,
          entries.findIndex(entry => entry.name > cursor),
        );
  const selected = [...entries.slice(start), ...entries.slice(0, start)].slice(0, limit);
  yield* writeDeferredCodeAnchorScanCursor(config, selected[selected.length - 1]!.name);
  return selected;
});

const readDeferredCodeAnchorScanCursor = Effect.fn('memoryCodeAnchor.readScanCursor')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* existingPrivateDeferredCodeAnchorRoot(config);
  if (root === undefined) return undefined;
  const cursorPath = path.join(root, DEFERRED_CODE_ANCHOR_SCAN_CURSOR_NAME);
  const content = yield* readPrivateDeferredCodeAnchorIntent(fs, cursorPath);
  if (content === undefined || new TextEncoder().encode(content).byteLength > MAX_DEFERRED_CODE_ANCHOR_CURSOR_BYTES) {
    return undefined;
  }
  const cursor = content.endsWith('\n') ? content.slice(0, -1) : content;
  return isDeferredCodeAnchorCursorValue(cursor) ? cursor : undefined;
});

const writeDeferredCodeAnchorScanCursor = Effect.fn('memoryCodeAnchor.writeScanCursor')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  cursor: string,
) {
  if (!isDeferredCodeAnchorCursorValue(cursor)) {
    return yield* Effect.fail(deferredCodeAnchorError('Deferred code-anchor scan cursor is invalid.'));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* ensurePrivateDeferredCodeAnchorRoot(config);
  const target = path.join(root, DEFERRED_CODE_ANCHOR_SCAN_CURSOR_NAME);
  const temporary = `${target}.${randomDeferredCodeAnchorTemporarySuffix()}.tmp`;
  yield* fs.writeFileString(temporary, `${cursor}\n`, {flag: 'wx', mode: 0o600});
  yield* fs
    .rename(temporary, target)
    .pipe(Effect.catch(error => fs.remove(temporary, {force: true}).pipe(Effect.andThen(Effect.fail(error)))));
  if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
    return yield* Effect.fail(deferredCodeAnchorError('Deferred code-anchor scan cursor must not be a symbolic link.'));
  }
  yield* fs.chmod(target, 0o600);
});

function isDeferredCodeAnchorCursorValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_DEFERRED_CODE_ANCHOR_CURSOR_BYTES &&
    value.endsWith('.json') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !/[\r\n]/u.test(value)
  );
}

const readPrivateDeferredCodeAnchorIntent = Effect.fn('memoryCodeAnchor.readPrivateIntent')(function* (
  fs: FileSystem.FileSystem,
  intentPath: string,
) {
  if (Option.isSome(yield* fs.readLink(intentPath).pipe(Effect.option))) return undefined;
  const before = yield* fs.stat(intentPath).pipe(Effect.option);
  if (
    Option.isNone(before) ||
    before.value.type !== 'File' ||
    Number(before.value.size) > MAX_DEFERRED_CODE_ANCHOR_INTENT_BYTES ||
    (before.value.mode & 0o077) !== 0
  ) {
    return undefined;
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* fs.open(intentPath, {flag: 'r'});
      const openedBefore = yield* opened.stat;
      const pathOpened = yield* fs.stat(intentPath);
      if (
        Option.isSome(yield* fs.readLink(intentPath).pipe(Effect.option)) ||
        !sameDeferredCodeAnchorIntentFile(before.value, openedBefore) ||
        !sameDeferredCodeAnchorIntentFile(before.value, pathOpened)
      ) {
        return undefined;
      }
      const bytes = new Uint8Array(MAX_DEFERRED_CODE_ANCHOR_INTENT_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = Number(yield* opened.read(bytes.subarray(offset)));
        if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - offset) return undefined;
        if (count === 0) break;
        offset += count;
      }
      const openedAfter = yield* opened.stat;
      const pathAfter = yield* fs.stat(intentPath);
      if (
        Option.isSome(yield* fs.readLink(intentPath).pipe(Effect.option)) ||
        !sameDeferredCodeAnchorIntentFile(before.value, openedAfter) ||
        !sameDeferredCodeAnchorIntentFile(before.value, pathAfter) ||
        offset > MAX_DEFERRED_CODE_ANCHOR_INTENT_BYTES ||
        BigInt(offset) !== before.value.size
      ) {
        return undefined;
      }
      return yield* Effect.try({
        try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, offset)),
        catch: () => undefined,
      });
    }),
  ).pipe(Effect.catch(() => Effect.succeed(undefined)));
});

function sameDeferredCodeAnchorIntentFile(left: FileSystem.File.Info, right: FileSystem.File.Info): boolean {
  return (
    left.type === 'File' &&
    right.type === 'File' &&
    left.dev === right.dev &&
    Option.getOrUndefined(left.ino) === Option.getOrUndefined(right.ino) &&
    left.size === right.size &&
    left.mode === right.mode &&
    Option.getOrUndefined(left.mtime)?.getTime() === Option.getOrUndefined(right.mtime)?.getTime()
  );
}

const discardStoredDeferredCodeAnchorIntent = Effect.fn('memoryCodeAnchor.discardStored')(function* (
  entry: StoredDeferredCodeAnchorIntent,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(entry.path, {force: true});
});

function parseDeferredCodeAnchorIntent(content: string): DeferredCodeAnchorIntentV1 | undefined {
  try {
    const value: unknown = JSON.parse(content);
    if (!isRecord(value)) return undefined;
    if (
      !hasExactKeys(value, [
        'authorization',
        'callerCwd',
        'codeRefs',
        'createdAt',
        'expectedMemoryHash',
        'intentId',
        'memoryId',
        'memoryUri',
        'recovery',
        'repositoryId',
        'type',
        'version',
        'visibility',
        'worktreeId',
      ]) ||
      value.type !== 'threadnote-deferred-code-anchor-intent' ||
      value.version !== DEFERRED_CODE_ANCHOR_INTENT_VERSION ||
      value.authorization !== 'explicit-code-refs' ||
      value.visibility !== 'private-local' ||
      typeof value.intentId !== 'string' ||
      !/^tnca_[a-f0-9]{32}$/u.test(value.intentId) ||
      typeof value.memoryId !== 'string' ||
      value.memoryId.length === 0 ||
      typeof value.memoryUri !== 'string' ||
      typeof value.expectedMemoryHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.expectedMemoryHash) ||
      typeof value.repositoryId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.repositoryId) ||
      typeof value.worktreeId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.worktreeId) ||
      typeof value.callerCwd !== 'string' ||
      typeof value.createdAt !== 'string' ||
      !isCanonicalIsoDate(value.createdAt) ||
      !Array.isArray(value.codeRefs) ||
      !value.codeRefs.every(ref => typeof ref === 'string') ||
      !isMemoryCodeCitationRecovery(value.recovery)
    ) {
      return undefined;
    }
    const codeRefs = normalizeMemoryCodeRefs(value.codeRefs);
    if (codeRefs.length !== value.codeRefs.length) return undefined;
    return {...value, codeRefs} as unknown as DeferredCodeAnchorIntentV1;
  } catch {
    return undefined;
  }
}

const storedDeferredCodeAnchorIntentMatchesAddress = Effect.fn('memoryCodeAnchor.validateAddress')(function* (
  config: Pick<RuntimeConfig, 'user'>,
  intent: DeferredCodeAnchorIntentV1,
  name: string,
) {
  const path = yield* Path.Path;
  if (!path.isAbsolute(intent.callerCwd)) return false;
  const canonicalUri = yield* Effect.sync(() => {
    try {
      return canonicalPersonalMemoryUri(config, intent.memoryUri);
    } catch {
      return undefined;
    }
  });
  if (canonicalUri === undefined || canonicalUri !== intent.memoryUri) return false;
  const digest = yield* deferredCodeAnchorUriDigest(canonicalUri);
  if (name !== `${digest}.json` && name !== `${digest}-${intent.intentId}.json`) return false;
  return (
    (yield* deferredCodeAnchorIntentId({
      callerCwd: intent.callerCwd,
      codeRefs: intent.codeRefs,
      expectedMemoryHash: intent.expectedMemoryHash,
      memoryId: intent.memoryId,
      memoryUri: intent.memoryUri,
      repositoryId: intent.repositoryId,
      recovery: intent.recovery,
      worktreeId: intent.worktreeId,
    })) === intent.intentId
  );
});

function deferredCodeAnchorIntentId(input: {
  readonly callerCwd: string;
  readonly codeRefs: readonly string[];
  readonly expectedMemoryHash: string;
  readonly memoryId: string;
  readonly memoryUri: string;
  readonly repositoryId: string;
  readonly recovery: MemoryCodeCitationCaptureRecoveryV1;
  readonly worktreeId: string;
}) {
  return sha256Hex(
    [
      input.memoryUri,
      input.memoryId,
      input.expectedMemoryHash,
      input.repositoryId,
      input.worktreeId,
      input.callerCwd,
      input.recovery.code,
      input.recovery.observedGraph.freshness,
      input.recovery.observedGraph.readySnapshot,
      String(input.recovery.observedGraph.stale),
      input.recovery.preparation.action,
      input.recovery.preparation.target,
      input.recovery.preparation.command,
      ...input.recovery.preparation.arguments,
      ...input.codeRefs,
    ].join('\n'),
  ).pipe(Effect.map(digest => `tnca_${digest.slice(0, 32)}`));
}

function isMemoryCodeCitationRecovery(value: unknown): value is MemoryCodeCitationCaptureRecoveryV1 {
  if (!isRecord(value) || value.type !== 'memory-code-citation-capture-recovery' || value.version !== 1) return false;
  if (
    !hasExactKeys(value, [
      'code',
      'indexingStarted',
      'observedGraph',
      'preparation',
      'recovery',
      'retryCondition',
      'retryable',
      'type',
      'version',
    ]) ||
    (value.code !== 'exact-current-evidence-unavailable' && value.code !== 'ready-graph-unavailable') ||
    value.indexingStarted !== false ||
    value.recovery !== 'prepare-current-graph' ||
    value.retryCondition !== 'after-current-graph-ready' ||
    value.retryable !== true ||
    !isRecord(value.observedGraph) ||
    !isRecord(value.preparation)
  ) {
    return false;
  }
  if (
    !hasExactKeys(value.observedGraph, ['freshness', 'readySnapshot', 'stale']) ||
    !['current', 'deferred', 'stale'].includes(String(value.observedGraph.freshness)) ||
    !['absent', 'available'].includes(String(value.observedGraph.readySnapshot)) ||
    typeof value.observedGraph.stale !== 'boolean'
  ) {
    return false;
  }
  if (value.preparation.target === 'callerCwd') {
    return (
      hasExactKeys(value.preparation, ['action', 'arguments', 'command', 'target']) &&
      value.preparation.action === 'index-current-graph' &&
      value.preparation.command === 'threadnote graph index --no-vectors' &&
      Array.isArray(value.preparation.arguments) &&
      value.preparation.arguments.length === 0
    );
  }
  return (
    value.preparation.target === 'workset' &&
    hasExactKeys(value.preparation, ['action', 'arguments', 'command', 'target']) &&
    value.preparation.action === 'prepare-workset' &&
    value.preparation.command === 'threadnote workset prepare' &&
    Array.isArray(value.preparation.arguments) &&
    value.preparation.arguments.length === 1 &&
    typeof value.preparation.arguments[0] === 'string' &&
    value.preparation.arguments[0].length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCanonicalIsoDate(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function randomDeferredCodeAnchorTemporarySuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

const deferredCodeAnchorIntentPath = Effect.fn('memoryCodeAnchor.intentPath')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
  intentId: string,
) {
  const path = yield* Path.Path;
  const digest = yield* deferredCodeAnchorUriDigest(memoryUri);
  return path.join(yield* deferredCodeAnchorRoot(config), `${digest}-${intentId}.json`);
});

const deferredCodeAnchorIntentPaths = Effect.fn('memoryCodeAnchor.intentPaths')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* existingPrivateDeferredCodeAnchorRoot(config);
  if (root === undefined) return [] as string[];
  const digest = yield* deferredCodeAnchorUriDigest(memoryUri);
  return (yield* fs.readDirectory(root))
    .filter(name => isDeferredCodeAnchorIntentNameForDigest(name, digest))
    .map(name => path.join(root, name));
});

function deferredCodeAnchorUriDigest(memoryUri: string) {
  return sha256Hex(parseResourceId(memoryUri).canonicalUri);
}

function deferredCodeAnchorUriDigestFromName(name: string): string | undefined {
  const match = /^([a-f0-9]{64})(?:-tnca_[a-f0-9]+)?\.json$/u.exec(name);
  return match?.[1];
}

function isDeferredCodeAnchorIntentNameForDigest(name: string, digest: string): boolean {
  return name === `${digest}.json` || (name.startsWith(`${digest}-tnca_`) && name.endsWith('.json'));
}

const deferredCodeAnchorRoot = Effect.fn('memoryCodeAnchor.root')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
) {
  const path = yield* Path.Path;
  return path.join(
    config.agentContextHome,
    'data',
    uriSegment(config.account),
    'user',
    uriSegment(config.user),
    'private',
    'deferred-code-anchors',
    'v1',
  );
});

const ensurePrivateDeferredCodeAnchorRoot = Effect.fn('memoryCodeAnchor.ensurePrivateRoot')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* deferredCodeAnchorRoot(config);
  if (Option.isSome(yield* fs.readLink(root).pipe(Effect.option))) {
    return yield* Effect.fail(deferredCodeAnchorError('Deferred code-anchor outbox must not be a symbolic link.'));
  }
  const before = yield* fs.stat(root).pipe(Effect.option);
  if (Option.isSome(before) && before.value.type !== 'Directory') {
    return yield* Effect.fail(deferredCodeAnchorError('Deferred code-anchor outbox must be a private directory.'));
  }
  yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  if (Option.isSome(yield* fs.readLink(root).pipe(Effect.option))) {
    return yield* Effect.fail(deferredCodeAnchorError('Deferred code-anchor outbox must not be a symbolic link.'));
  }
  yield* fs.chmod(root, 0o700);
  const after = yield* fs.stat(root);
  if (after.type !== 'Directory' || (after.mode & 0o077) !== 0) {
    return yield* Effect.fail(deferredCodeAnchorError('Deferred code-anchor outbox must be a private directory.'));
  }
  return root;
});

const existingPrivateDeferredCodeAnchorRoot = Effect.fn('memoryCodeAnchor.existingPrivateRoot')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* deferredCodeAnchorRoot(config);
  if (Option.isSome(yield* fs.readLink(root).pipe(Effect.option))) {
    return yield* Effect.fail(deferredCodeAnchorError('Deferred code-anchor outbox must not be a symbolic link.'));
  }
  const info = yield* fs.stat(root).pipe(Effect.option);
  if (Option.isNone(info)) return undefined;
  if (info.value.type !== 'Directory' || (info.value.mode & 0o077) !== 0) {
    return yield* Effect.fail(deferredCodeAnchorError('Deferred code-anchor outbox must be a private directory.'));
  }
  return root;
});

function canonicalPersonalMemoryUri(config: Pick<RuntimeConfig, 'user'>, memoryUri: string): string {
  const canonical = parseResourceId(memoryUri).canonicalUri;
  const personalPrefix = `threadnote://user/${uriSegment(config.user)}/memories/`;
  if (!canonical.startsWith(personalPrefix) || canonical.startsWith(`${personalPrefix}shared/`)) {
    throw deferredCodeAnchorError('Deferred code anchors require a personal canonical memory URI.');
  }
  return canonical;
}

function boundedFinalizeLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT) {
    throw deferredCodeAnchorError(
      `Deferred code-anchor finalization limit must be between 1 and ${MAX_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT}.`,
    );
  }
  return value;
}

function commonCitationSourceCommit(citations: readonly MemoryCodeCitationV1[]): string | undefined {
  const commits = new Set(citations.map(citation => citation.sourceCommit));
  return commits.size === 1 ? citations[0]?.sourceCommit : undefined;
}

function memoryContentHash(content: string) {
  return sha256Hex(canonicalMemoryDocumentContent(content));
}

function resourceStoreLocation(config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>) {
  return {account: config.account, home: config.agentContextHome, user: config.user} as const;
}
