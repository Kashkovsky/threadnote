import {Clock, Context, Effect, FileSystem, Layer, Option, Path} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {LocalModelRuntime, type LocalModelRuntimeShape} from '../effect/ai/local-model-runtime.js';
import {LocalModelCatalog, type LocalModelCatalogShape} from '../models/catalog.js';
import {readModelSelection} from '../models/selection.js';
import {LocalModelStore, type LocalModelStoreShape} from '../models/store.js';
import {normalizeVector, searchExactVectors} from '../search/vector-search.js';
import {
  decodeVectorSidecar,
  encodeVectorSidecar,
  type VectorSidecar,
  type VectorSidecarEntry,
} from '../search/vector-sidecar.js';
import type {CodeGraphLayout} from './layout.js';
import type {CodeGraphProgress, CodeGraphSnapshot, CodeGraphSymbol} from './types.js';

const CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION = 1;
const CODE_GRAPH_VECTOR_POINTER_VERSION = 1;
const CODE_GRAPH_SEMANTIC_MINIMUM_SCORE = 0.64;
const EMBED_BATCH_SIZE = 128;
const MAX_CACHED_VECTOR_GENERATIONS = 4;

interface CodeGraphVectorPointer {
  readonly count: number;
  readonly createdAt: string;
  readonly dimensions: number;
  readonly generation: string;
  readonly modelId: string;
  readonly modelSha256: string;
  readonly sidecarSha256: string;
  readonly snapshotId: string;
  readonly templateVersion: number;
  readonly version: typeof CODE_GRAPH_VECTOR_POINTER_VERSION;
}

interface CachedVectorGeneration {
  readonly sidecar: VectorSidecar;
}

type VectorGenerationCache = Map<string, CachedVectorGeneration>;

export interface CodeGraphEmbeddingStatus {
  readonly embedded: number;
  readonly modelId?: string;
  readonly ready: boolean;
  readonly reason?: string;
  readonly reused: number;
}

export type CodeGraphEmbeddingCheck =
  | {readonly modelId: string; readonly reused: number; readonly state: 'ready'}
  | {readonly reason: string; readonly state: 'stale' | 'unavailable'};

export interface CodeGraphEmbeddingIndexShape {
  readonly check: (
    threadnoteHome: string,
    layout: CodeGraphLayout,
    snapshotId: string,
  ) => Effect.Effect<CodeGraphEmbeddingCheck, unknown>;
  readonly ensure: (
    threadnoteHome: string,
    layout: CodeGraphLayout,
    snapshot: CodeGraphSnapshot,
    symbols: readonly CodeGraphSymbol[],
    options?: {
      readonly activeWorktreeIds?: ReadonlySet<string>;
      readonly force?: boolean;
      readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
    },
  ) => Effect.Effect<CodeGraphEmbeddingStatus, unknown>;
  readonly search: (
    threadnoteHome: string,
    layout: CodeGraphLayout,
    snapshotId: string,
    query: string,
    limit: number,
  ) => Effect.Effect<ReadonlyMap<string, number>, unknown>;
}

export class CodeGraphEmbeddingIndex extends Context.Service<CodeGraphEmbeddingIndex, CodeGraphEmbeddingIndexShape>()(
  'threadnote/codeGraph/CodeGraphEmbeddingIndex',
) {
  static readonly layer = Layer.effect(
    CodeGraphEmbeddingIndex,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const catalog = yield* LocalModelCatalog;
      const modelStore = yield* LocalModelStore;
      const runtime = yield* LocalModelRuntime;
      const generationCache: VectorGenerationCache = new Map();
      return CodeGraphEmbeddingIndex.of({
        check: (threadnoteHome, layout, snapshotId) =>
          checkGraphVectors({catalog, fs, generationCache, layout, modelStore, path, snapshotId, threadnoteHome}).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
        ensure: (threadnoteHome, layout, snapshot, symbols, options) =>
          ensureGraphVectors({
            activeWorktreeIds: options?.activeWorktreeIds,
            catalog,
            force: options?.force === true,
            fs,
            generationCache,
            layout,
            modelStore,
            onProgress: options?.onProgress,
            path,
            runtime,
            snapshot,
            symbols,
            threadnoteHome,
          }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path)),
        search: (threadnoteHome, layout, snapshotId, query, limit) =>
          searchGraphVectors({
            catalog,
            fs,
            generationCache,
            layout,
            limit,
            modelStore,
            path,
            query,
            runtime,
            snapshotId,
            threadnoteHome,
          }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path)),
      });
    }),
  );
}

const checkGraphVectors = Effect.fn('codeGraph.checkVectors')(function* (input: {
  readonly catalog: LocalModelCatalogShape;
  readonly fs: FileSystem.FileSystem;
  readonly generationCache: VectorGenerationCache;
  readonly layout: CodeGraphLayout;
  readonly modelStore: LocalModelStoreShape;
  readonly path: Path.Path;
  readonly snapshotId: string;
  readonly threadnoteHome: string;
}) {
  const selected = yield* selectedEmbeddingModel(input.threadnoteHome, input.catalog, input.modelStore).pipe(
    Effect.match({
      onFailure: cause => ({reason: messageOf(cause), state: 'unavailable'}) as const,
      onSuccess: value => value,
    }),
  );
  if ('state' in selected) return selected;
  const active = yield* readVectorGeneration(
    input.fs,
    input.path,
    input.path.join(input.layout.vectorRoot, selected.manifest.id),
    requiredWorktreeId(input.layout),
    input.generationCache,
  ).pipe(
    Effect.match({
      onFailure: cause => ({reason: messageOf(cause), state: 'stale'}) as const,
      onSuccess: value => value,
    }),
  );
  if ('state' in active) return active;
  if (
    active.pointer.snapshotId !== input.snapshotId ||
    active.pointer.modelSha256 !== selected.manifest.sha256 ||
    active.pointer.templateVersion !== CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION
  ) {
    return {reason: 'Code graph vectors do not match the ready snapshot.', state: 'stale'} as const;
  }
  return {
    modelId: selected.manifest.id,
    reused: active.sidecar.entries.length,
    state: 'ready',
  } as const;
});

const ensureGraphVectors = Effect.fn('codeGraph.ensureVectors')(function* (input: {
  readonly activeWorktreeIds?: ReadonlySet<string>;
  readonly catalog: LocalModelCatalogShape;
  readonly force: boolean;
  readonly fs: FileSystem.FileSystem;
  readonly generationCache: VectorGenerationCache;
  readonly layout: CodeGraphLayout;
  readonly modelStore: LocalModelStoreShape;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly path: Path.Path;
  readonly runtime: LocalModelRuntimeShape;
  readonly snapshot: CodeGraphSnapshot;
  readonly symbols: readonly CodeGraphSymbol[];
  readonly threadnoteHome: string;
}) {
  const selected = yield* selectedEmbeddingModel(input.threadnoteHome, input.catalog, input.modelStore).pipe(
    Effect.catch(cause => Effect.succeed({reason: messageOf(cause)} as const)),
  );
  if ('reason' in selected) return {embedded: 0, ready: false, reason: selected.reason, reused: 0};
  const root = input.path.join(input.layout.vectorRoot, selected.manifest.id);
  const worktreeId = requiredWorktreeId(input.layout);
  if (input.activeWorktreeIds) {
    yield* reconcileVectorPointers(input.fs, input.path, root, new Set([...input.activeWorktreeIds, worktreeId]));
  }
  const active = yield* readVectorGeneration(input.fs, input.path, root, worktreeId, input.generationCache).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (
    !input.force &&
    active?.pointer.snapshotId === input.snapshot.id &&
    active.pointer.modelSha256 === selected.manifest.sha256 &&
    active.pointer.templateVersion === CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION
  ) {
    yield* pruneGenerations(input.fs, input.path, root);
    return {embedded: 0, modelId: selected.manifest.id, ready: true, reused: active.sidecar.entries.length};
  }
  const reusableGeneration = input.force
    ? undefined
    : (active ??
      (yield* readMostRecentVectorGeneration(input.fs, input.path, root, input.generationCache).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )));
  if (
    reusableGeneration?.pointer.snapshotId === input.snapshot.id &&
    reusableGeneration.pointer.modelSha256 === selected.manifest.sha256 &&
    reusableGeneration.pointer.templateVersion === CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION
  ) {
    yield* writePointer(input.fs, input.path, root, worktreeId, reusableGeneration.pointer);
    return {
      embedded: 0,
      modelId: selected.manifest.id,
      ready: true,
      reused: reusableGeneration.sidecar.entries.length,
    };
  }
  const highValue = selectGraphEmbeddingSymbols(input.symbols);
  const reusable = new Map<string, readonly number[]>();
  for (const entry of reusableGeneration?.sidecar.entries ?? []) reusable.set(reuseKey(entry), entry.vector);
  const projected = highValue.map(symbol => projectSymbol(symbol));
  const vectorById = new Map<string, readonly number[]>();
  let reused = 0;
  for (const item of projected) {
    const vector = reusable.get(`${item.id}\0${item.fingerprint}`);
    if (vector) {
      vectorById.set(item.id, vector);
      reused += 1;
    }
  }
  const missing = projected.filter(item => !vectorById.has(item.id));
  let embedded = 0;
  yield* input.onProgress?.({embedded, phase: 'embedding', reused, total: projected.length}) ?? Effect.void;
  for (let start = 0; start < missing.length; start += EMBED_BATCH_SIZE) {
    const batch = missing.slice(start, start + EMBED_BATCH_SIZE);
    const vectors = yield* input.runtime.embedMany({
      inputs: batch.map(item => `${selected.manifest.promptPrefixes?.document ?? ''}${item.text}`),
      manifest: selected.manifest,
      modelPath: selected.modelPath,
    });
    for (const [index, item] of batch.entries()) vectorById.set(item.id, normalizeVector(vectors[index]!));
    embedded += batch.length;
    yield* input.onProgress?.({embedded, phase: 'embedding', reused, total: projected.length}) ?? Effect.void;
  }
  const entries: VectorSidecarEntry[] = projected.map(item => ({
    fingerprint: item.fingerprint,
    id: item.id,
    uri: item.id,
    vector: vectorById.get(item.id)!,
  }));
  const sidecar: VectorSidecar = {
    entries,
    metadata: {
      chunkerVersion: CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION,
      dimensions: selected.manifest.dimensions!,
      modelId: selected.manifest.id,
      modelSha256: selected.manifest.sha256,
      normalized: 'l2',
    },
    version: 1,
  };
  const encoded = yield* Effect.try({
    try: () => encodeVectorSidecar(sidecar),
    catch: cause => new Error(`Could not encode code graph vectors: ${messageOf(cause)}`, {cause}),
  });
  const generation = `${yield* Clock.currentTimeMillis}-${worktreeId.slice(-8)}-${input.snapshot.id.slice(-8)}`;
  const generationRoot = input.path.join(root, 'generations', generation);
  yield* input.fs.makeDirectory(generationRoot, {recursive: true, mode: 0o700});
  yield* input.fs.writeFile(input.path.join(generationRoot, 'vectors.bin'), encoded, {mode: 0o600});
  const pointer: CodeGraphVectorPointer = {
    count: entries.length,
    createdAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
    dimensions: selected.manifest.dimensions!,
    generation,
    modelId: selected.manifest.id,
    modelSha256: selected.manifest.sha256,
    sidecarSha256: sha256HexSync(encoded),
    snapshotId: input.snapshot.id,
    templateVersion: CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION,
    version: CODE_GRAPH_VECTOR_POINTER_VERSION,
  };
  cacheVectorGeneration(input.generationCache, vectorGenerationCacheKey(root, pointer), {sidecar});
  yield* writePointer(input.fs, input.path, root, worktreeId, pointer);
  yield* pruneGenerations(input.fs, input.path, root);
  return {embedded, modelId: selected.manifest.id, ready: true, reused};
});

const searchGraphVectors = Effect.fn('codeGraph.searchVectors')(function* (input: {
  readonly catalog: LocalModelCatalogShape;
  readonly fs: FileSystem.FileSystem;
  readonly generationCache: VectorGenerationCache;
  readonly layout: CodeGraphLayout;
  readonly limit: number;
  readonly modelStore: LocalModelStoreShape;
  readonly path: Path.Path;
  readonly query: string;
  readonly runtime: LocalModelRuntimeShape;
  readonly snapshotId: string;
  readonly threadnoteHome: string;
}) {
  const selected = yield* selectedEmbeddingModel(input.threadnoteHome, input.catalog, input.modelStore);
  const root = input.path.join(input.layout.vectorRoot, selected.manifest.id);
  const active = yield* readVectorGeneration(
    input.fs,
    input.path,
    root,
    requiredWorktreeId(input.layout),
    input.generationCache,
  );
  if (
    active.pointer.snapshotId !== input.snapshotId ||
    active.pointer.modelSha256 !== selected.manifest.sha256 ||
    active.pointer.templateVersion !== CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION
  ) {
    return new Map<string, number>();
  }
  const [queryVector] = yield* input.runtime.embedMany({
    inputs: [`${selected.manifest.promptPrefixes?.query ?? ''}${input.query}`],
    manifest: selected.manifest,
    modelPath: selected.modelPath,
  });
  const matches = searchExactVectors(queryVector!, active.sidecar.entries, {
    dimensions: selected.manifest.dimensions!,
    limit: Math.max(1, Math.min(active.sidecar.entries.length, input.limit)),
    minimumScore: CODE_GRAPH_SEMANTIC_MINIMUM_SCORE,
  });
  return new Map(matches.map(match => [match.id, Math.max(0, match.score)]));
});

const selectedEmbeddingModel = Effect.fn('codeGraph.selectedEmbeddingModel')(function* (
  threadnoteHome: string,
  catalog: LocalModelCatalogShape,
  store: LocalModelStoreShape,
) {
  const selection = yield* readModelSelection(threadnoteHome);
  const modelId = selection.roles.embedding;
  if (!modelId) return yield* Effect.fail(new Error('No core embedding model is selected.'));
  const manifest = yield* catalog.get(modelId);
  if (manifest.role !== 'embedding' || !manifest.dimensions) {
    return yield* Effect.fail(new Error(`Selected model ${modelId} is not an embedding model.`));
  }
  const verified = yield* store.verify(threadnoteHome, manifest);
  return {manifest, modelPath: verified.path};
});

export function selectGraphEmbeddingSymbols(symbols: readonly CodeGraphSymbol[]): readonly CodeGraphSymbol[] {
  const selected = symbols.filter(
    symbol =>
      symbol.exported ||
      ['class', 'document', 'function', 'heading', 'interface', 'method', 'module', 'package', 'type'].includes(
        symbol.kind,
      ),
  );
  return [...new Map(selected.map(symbol => [symbol.id, symbol])).values()].sort(
    (left, right) =>
      vectorPriority(right) - vectorPriority(left) ||
      left.path.localeCompare(right.path) ||
      left.qualifiedName.localeCompare(right.qualifiedName) ||
      left.id.localeCompare(right.id),
  );
}

function vectorPriority(symbol: CodeGraphSymbol): number {
  const kind =
    {
      class: 9,
      document: 4,
      function: 10,
      heading: 5,
      interface: 9,
      method: 8,
      module: 6,
      package: 7,
      type: 8,
    }[symbol.kind] ?? 0;
  return (symbol.exported ? 100 : 0) + kind + (symbol.documentation ? 1 : 0);
}

function projectSymbol(symbol: CodeGraphSymbol): {
  readonly fingerprint: string;
  readonly id: string;
  readonly text: string;
} {
  const text = [
    `${symbol.kind} ${symbol.qualifiedName}`,
    symbol.signature ? `signature: ${symbol.signature}` : '',
    symbol.packageName ? `package: ${symbol.packageName}` : '',
    `path: ${symbol.path}`,
    symbol.documentation ? `documentation: ${symbol.documentation.slice(0, 1_024)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    fingerprint: sha256HexSync(`code-graph-embedding-v${CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION}\n${text}`),
    id: symbol.id,
    text,
  };
}

function reuseKey(entry: VectorSidecarEntry): string {
  return `${entry.id}\0${entry.fingerprint}`;
}

const readVectorPointer = Effect.fn('codeGraph.readVectorPointer')(function* (
  fs: FileSystem.FileSystem,
  pointerPath: string,
) {
  const pointerContent = yield* fs.readFileString(pointerPath);
  return yield* Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(pointerContent);
      assertPointer(parsed);
      return parsed;
    },
    catch: cause => new Error(`Code graph vector pointer is invalid: ${messageOf(cause)}`, {cause}),
  });
});

function validateVectorGeneration(pointer: CodeGraphVectorPointer, sidecar: VectorSidecar): void {
  if (
    sidecar.entries.length !== pointer.count ||
    sidecar.metadata.dimensions !== pointer.dimensions ||
    sidecar.metadata.modelId !== pointer.modelId ||
    sidecar.metadata.modelSha256 !== pointer.modelSha256
  ) {
    throw new Error('Code graph vector metadata does not match its active pointer.');
  }
}

function vectorGenerationCacheKey(root: string, pointer: CodeGraphVectorPointer): string {
  return `${root}\0${pointer.generation}\0${pointer.sidecarSha256}`;
}

function cacheVectorGeneration(cache: VectorGenerationCache, key: string, generation: CachedVectorGeneration): void {
  cache.delete(key);
  cache.set(key, generation);
  while (cache.size > MAX_CACHED_VECTOR_GENERATIONS) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== 'string') break;
    cache.delete(oldest);
  }
}

const readVectorGeneration = Effect.fn('codeGraph.readVectorGeneration')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  worktreeId: string,
  cache: VectorGenerationCache,
) {
  return yield* readVectorGenerationAt(fs, path, root, vectorPointerPath(path, root, worktreeId), cache);
});

const readVectorGenerationAt = Effect.fn('codeGraph.readVectorGenerationAt')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  pointerPath: string,
  cache: VectorGenerationCache,
) {
  const pointer = yield* readVectorPointer(fs, pointerPath);
  const cacheKey = vectorGenerationCacheKey(root, pointer);
  const cached = cache.get(cacheKey);
  if (cached) {
    yield* Effect.try({
      try: () => validateVectorGeneration(pointer, cached.sidecar),
      catch: cause => new Error(messageOf(cause), {cause}),
    });
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return {pointer, sidecar: cached.sidecar};
  }
  const bytes = yield* fs.readFile(path.join(root, 'generations', pointer.generation, 'vectors.bin'));
  if (sha256HexSync(bytes) !== pointer.sidecarSha256) {
    return yield* Effect.fail(new Error('Code graph vector checksum does not match.'));
  }
  const sidecar = yield* Effect.try({
    try: () => decodeVectorSidecar(bytes),
    catch: cause => new Error(`Code graph vector sidecar is invalid: ${messageOf(cause)}`, {cause}),
  });
  yield* Effect.try({
    try: () => validateVectorGeneration(pointer, sidecar),
    catch: cause => new Error(messageOf(cause), {cause}),
  });
  cacheVectorGeneration(cache, cacheKey, {sidecar});
  return {pointer, sidecar};
});

const readMostRecentVectorGeneration = Effect.fn('codeGraph.readMostRecentVectorGeneration')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  cache: VectorGenerationCache,
) {
  const pointerRoot = path.join(root, 'pointers');
  const names = (yield* fs.readDirectory(pointerRoot).pipe(Effect.catch(() => Effect.succeed([]))))
    .filter(name => name.endsWith('.json'))
    .sort()
    .slice(0, 100);
  const pointerPaths = [path.join(root, 'active.json'), ...names.map(name => path.join(pointerRoot, name))];
  const pointers = yield* Effect.forEach(
    pointerPaths,
    pointerPath =>
      readVectorPointer(fs, pointerPath).pipe(
        Effect.map(pointer => ({pointer, pointerPath})),
        Effect.option,
      ),
    {concurrency: 8},
  );
  const distinct = new Map<string, {readonly pointer: CodeGraphVectorPointer; readonly pointerPath: string}>();
  for (const candidate of pointers) {
    if (Option.isNone(candidate)) continue;
    const key = vectorGenerationCacheKey(root, candidate.value.pointer);
    const existing = distinct.get(key);
    if (!existing || candidate.value.pointer.createdAt > existing.pointer.createdAt) {
      distinct.set(key, candidate.value);
    }
  }
  const ordered = [...distinct.values()].sort((left, right) =>
    right.pointer.createdAt.localeCompare(left.pointer.createdAt),
  );
  for (const candidate of ordered) {
    const decoded = yield* readVectorGenerationAt(fs, path, root, candidate.pointerPath, cache).pipe(Effect.option);
    if (Option.isSome(decoded)) return decoded.value;
  }
  return undefined;
});

const writePointer = Effect.fn('codeGraph.writeVectorPointer')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  worktreeId: string,
  pointer: CodeGraphVectorPointer,
) {
  const pointerRoot = path.join(root, 'pointers');
  yield* fs.makeDirectory(pointerRoot, {recursive: true, mode: 0o700});
  const target = vectorPointerPath(path, root, worktreeId);
  const temporary = path.join(pointerRoot, `${worktreeId}.${pointer.generation}.tmp`);
  yield* fs.writeFileString(temporary, `${JSON.stringify(pointer, undefined, 2)}\n`, {mode: 0o600});
  yield* fs
    .rename(temporary, target)
    .pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.catch(() => Effect.void))));
  yield* fs.remove(path.join(root, 'active.json'), {force: true}).pipe(Effect.catch(() => Effect.void));
});

const pruneGenerations = Effect.fn('codeGraph.pruneVectorGenerations')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
) {
  const pointerRoot = path.join(root, 'pointers');
  const retained = new Set<string>();
  for (const name of yield* fs.readDirectory(pointerRoot)) {
    if (!name.endsWith('.json')) continue;
    const content = yield* fs.readFileString(path.join(pointerRoot, name)).pipe(Effect.option);
    if (content._tag === 'None') {
      yield* fs.remove(path.join(pointerRoot, name), {force: true}).pipe(Effect.catch(() => Effect.void));
      continue;
    }
    try {
      const pointer: unknown = JSON.parse(content.value);
      assertPointer(pointer);
      retained.add(pointer.generation);
    } catch {
      yield* fs.remove(path.join(pointerRoot, name), {force: true}).pipe(Effect.catch(() => Effect.void));
    }
  }
  const generations = path.join(root, 'generations');
  for (const name of yield* fs.readDirectory(generations)) {
    if (!retained.has(name)) yield* fs.remove(path.join(generations, name), {recursive: true, force: true});
  }
});

const reconcileVectorPointers = Effect.fn('codeGraph.reconcileVectorPointers')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  activeWorktreeIds: ReadonlySet<string>,
) {
  const pointerRoot = path.join(root, 'pointers');
  const names = yield* fs.readDirectory(pointerRoot).pipe(Effect.catch(() => Effect.succeed([])));
  for (const name of names) {
    const match = /^([0-9a-f]{64})\.json$/.exec(name);
    if (match && !activeWorktreeIds.has(match[1]!)) {
      yield* fs.remove(path.join(pointerRoot, name), {force: true});
    }
  }
});

function vectorPointerPath(path: Path.Path, root: string, worktreeId: string): string {
  if (!/^[0-9a-f]{64}$/.test(worktreeId)) throw new Error('Code graph worktree identity is invalid.');
  return path.join(root, 'pointers', `${worktreeId}.json`);
}

function requiredWorktreeId(layout: CodeGraphLayout): string {
  return layout.worktreeId;
}

function assertPointer(value: unknown): asserts value is CodeGraphVectorPointer {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Code graph vector pointer is invalid.');
  }
  const pointer = value as Partial<CodeGraphVectorPointer>;
  if (
    pointer.version !== CODE_GRAPH_VECTOR_POINTER_VERSION ||
    pointer.templateVersion !== CODE_GRAPH_EMBEDDING_TEMPLATE_VERSION ||
    typeof pointer.snapshotId !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(pointer.snapshotId) ||
    typeof pointer.generation !== 'string' ||
    !/^\d{1,20}-[0-9a-f]{8}-[A-Za-z0-9_-]{1,64}$/.test(pointer.generation) ||
    !pointer.modelId ||
    typeof pointer.modelSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(pointer.modelSha256) ||
    typeof pointer.sidecarSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(pointer.sidecarSha256) ||
    !Number.isInteger(pointer.count) ||
    pointer.count === undefined ||
    pointer.count < 0 ||
    !Number.isInteger(pointer.dimensions) ||
    pointer.dimensions === undefined ||
    pointer.dimensions <= 0
  ) {
    throw new Error('Code graph vector pointer is invalid.');
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
