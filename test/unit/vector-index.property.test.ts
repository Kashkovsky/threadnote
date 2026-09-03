import {TestError} from '../helpers/test-error.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database} from 'bun:sqlite';
import {createHash} from '../helpers/node-crypto.js';
import {join} from '../helpers/node-path.js';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {Effect, Layer, Option, Result} from 'effect';
import {LocalModelRuntime} from '../../src/effect/ai/local-model-runtime.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';
import {LocalModelStore, type LocalModelStoreShape} from '../../src/models/store.js';
import {chunkRecallDocument, type RecallChunk} from '../../src/search/chunker.js';
import {
  ensureVectorIndex,
  purgeVectorIndex,
  rebuildVectorIndex,
  VectorCorpusGenerationChanged,
  vectorIndexDatabaseFilename,
  vectorIndexMatchesGeneration,
  vectorIndexStatus,
} from '../../src/search/vector-index.js';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

interface VectorCorpusMutation {
  readonly id: number;
  readonly kind: 'set-alpha' | 'set-beta';
  readonly variant: number;
}

interface VectorCorpusRemove {
  readonly id: number;
  readonly kind: 'remove';
}

type VectorCorpusOperation = VectorCorpusMutation | VectorCorpusRemove;

interface VectorDocumentState {
  readonly alphaVariant: number;
  readonly betaVariant: number;
}

const manifest = BUILTIN_MODEL_MANIFESTS.find(model => model.id === 'bge-small-en-v1.5-q8')!;
const vectorCorpusMutation = (kind: VectorCorpusMutation['kind']) =>
  FC.record({
    id: FC.integer({max: 3, min: 0}),
    kind: FC.constant(kind),
    variant: FC.integer({max: 5, min: 1}),
  });
const vectorCorpusOperation = FC.oneof(
  vectorCorpusMutation('set-alpha'),
  vectorCorpusMutation('set-beta'),
  FC.record({
    id: FC.integer({max: 3, min: 0}),
    kind: FC.constant('remove' as const),
  }),
);
const vectorCorpusScenario = FC.record({
  alphaMutation: vectorCorpusMutation('set-alpha'),
  betaMutation: vectorCorpusMutation('set-beta'),
  extraOperations: FC.array(vectorCorpusOperation, {maxLength: 2}),
  removal: FC.record({
    id: FC.integer({max: 1, min: 0}),
    kind: FC.constant('remove' as const),
  }),
}).map(({alphaMutation, betaMutation, extraOperations, removal}) => [
  alphaMutation,
  betaMutation,
  removal,
  ...extraOperations,
]);
const generationRequestScenario = FC.record({
  initial: FC.integer({max: 3, min: 0}),
  operations: FC.array(
    FC.oneof(
      FC.record({generation: FC.integer({max: 3, min: 0}), kind: FC.constant('advance' as const)}),
      FC.record({generation: FC.integer({max: 3, min: 0}), kind: FC.constant('ensure' as const)}),
    ),
    {maxLength: 8, minLength: 1},
  ),
});

const modelStoreLayer = Layer.succeed(
  LocalModelStore,
  LocalModelStore.of({
    install: () => Effect.die(TestError.make({message: 'Unexpected install'})),
    path: home => `${home}/models/property.gguf`,
    remove: () => Effect.succeed(false),
    status: home => Effect.succeed(installation(home)),
    verify: home => Effect.succeed(installation(home)),
  } satisfies LocalModelStoreShape),
);

describe('SQLite vector index properties', () => {
  it.effect.prop(
    'preserves the pointer model across sequential generation advances and fenced ensures',
    {
      scenario: generationRequestScenario,
    },
    ({scenario}) =>
      Effect.promise(async () => {
        const home = await mkdtemp('threadnote-vector-generation-property-');
        const runtimeLayer = deterministicRuntimeLayer(() => undefined);
        let currentGeneration = generationName(scenario.initial);
        try {
          const initial = await ensureGeneration(home, currentGeneration, currentGeneration, runtimeLayer);
          expect(Result.isSuccess(initial)).toBe(true);
          expect(await runEffect(vectorIndexMatchesGeneration(home, manifest, currentGeneration))).toBe(true);

          for (const operation of scenario.operations) {
            if (operation.kind === 'advance') {
              currentGeneration = generationName(operation.generation);
              continue;
            }
            const requestedGeneration = generationName(operation.generation);
            const before = await generationPointerState(home);
            const result = await ensureGeneration(home, requestedGeneration, currentGeneration, runtimeLayer);
            if (requestedGeneration === currentGeneration) {
              expect(Result.isSuccess(result)).toBe(true);
              expect(await runEffect(vectorIndexMatchesGeneration(home, manifest, currentGeneration))).toBe(true);
            } else {
              expect(Result.isFailure(result)).toBe(true);
              if (Result.isFailure(result)) {
                expect(result.failure).toBeInstanceOf(VectorCorpusGenerationChanged);
              }
              expect(await generationPointerState(home)).toEqual(before);
            }
          }
        } finally {
          await rm(home, {force: true, recursive: true});
        }
      }),
    {fastCheck: {numRuns: 16}, timeout: 60_000},
  );

  it.effect.prop(
    'matches a corpus model across arbitrary incremental updates and clean rebuilds',
    {
      operations: vectorCorpusScenario,
    },
    ({operations}) =>
      Effect.promise(async () => {
        const home = await mkdtemp('threadnote-vector-property-');
        const model = baselineModel();
        const embeddedInputs: string[] = [];
        const runtimeLayer = deterministicRuntimeLayer(inputs => embeddedInputs.push(...inputs));
        try {
          let previousChunks: readonly RecallChunk[] = [];
          let candidates = candidatesFor(model);
          let chunks = chunksFor(candidates);
          const initial = await rebuild(home, candidates, runtimeLayer);
          assertBuildResult(initial, previousChunks, chunks);
          expect(takeEmbeddedInputs(embeddedInputs)).toEqual(expectedEmbeddingInputs(previousChunks, chunks));
          await assertVectorIndexMatchesModel(home, candidates, chunks);
          previousChunks = chunks;

          for (const operation of operations) {
            applyOperation(model, operation);
            candidates = candidatesFor(model);
            chunks = chunksFor(candidates);
            const result = await rebuild(home, candidates, runtimeLayer);
            assertBuildResult(result, previousChunks, chunks);
            expect(takeEmbeddedInputs(embeddedInputs)).toEqual(expectedEmbeddingInputs(previousChunks, chunks));
            await assertVectorIndexMatchesModel(home, candidates, chunks);
            previousChunks = chunks;
          }

          const unchanged = await rebuild(home, candidates, runtimeLayer);
          expect(unchanged).toMatchObject({
            chunkCount: chunks.length,
            embeddedChunkCount: 0,
            ready: true,
            reusedChunkCount: chunks.length,
          });
          expect(takeEmbeddedInputs(embeddedInputs)).toEqual([]);
          await assertVectorIndexMatchesModel(home, candidates, chunks);

          expect(await runEffect(purgeVectorIndex(home, manifest.id))).toBe(true);
          const rebuilt = await rebuild(home, candidates, runtimeLayer);
          expect(rebuilt).toMatchObject({
            chunkCount: chunks.length,
            embeddedChunkCount: chunks.length,
            ready: true,
            reusedChunkCount: 0,
          });
          expect(takeEmbeddedInputs(embeddedInputs)).toEqual(expectedEmbeddingInputs([], chunks));
          await assertVectorIndexMatchesModel(home, candidates, chunks);
        } finally {
          await rm(home, {force: true, recursive: true});
        }
      }),
    {fastCheck: {numRuns: 6}, timeout: 60_000},
  );
});

async function ensureGeneration(
  home: string,
  requestedGeneration: string,
  currentGeneration: string,
  runtimeLayer: ReturnType<typeof deterministicRuntimeLayer>,
) {
  return runEffect(
    ensureVectorIndex(
      {agentContextHome: home},
      manifest,
      [
        {
          text: `# ${requestedGeneration}\n\nStable property-test corpus for ${requestedGeneration}.`,
          uri: `threadnote://resources/repos/property/${requestedGeneration}.md`,
        },
      ],
      {
        corpusGeneration: requestedGeneration,
        currentCorpusGeneration: () => Effect.succeed(Option.some(currentGeneration)),
      },
    ).pipe(provideTestLayer(runtimeLayer), provideTestLayer(modelStoreLayer), Effect.result),
  );
}

function generationName(id: number): string {
  return `lexical-generation-${id}`;
}

async function generationPointerState(home: string): Promise<readonly boolean[]> {
  return Promise.all(
    Array.from({length: 4}, (_unused, generation) =>
      runEffect(vectorIndexMatchesGeneration(home, manifest, generationName(generation))),
    ),
  );
}

function baselineModel(): Map<number, VectorDocumentState> {
  return new Map([
    [0, {alphaVariant: 0, betaVariant: 0}],
    [1, {alphaVariant: 0, betaVariant: 0}],
  ]);
}

function applyOperation(model: Map<number, VectorDocumentState>, operation: VectorCorpusOperation): void {
  if (operation.kind === 'remove') {
    model.delete(operation.id);
    return;
  }
  const current = model.get(operation.id) ?? {alphaVariant: 0, betaVariant: 0};
  model.set(
    operation.id,
    operation.kind === 'set-alpha'
      ? {...current, alphaVariant: operation.variant}
      : {...current, betaVariant: operation.variant},
  );
}

function candidatesFor(model: ReadonlyMap<number, VectorDocumentState>) {
  return [...model]
    .map(([id, state]) => ({
      text: [
        '# Shared contract',
        'Shared vector-index content retained by every generated document.',
        `# Stable document ${id}`,
        `Stable content owned only by document ${id}.`,
        '# Alpha revision',
        `Document ${id} alpha variant ${state.alphaVariant}.`,
        '# Beta revision',
        `Document ${id} beta variant ${state.betaVariant}.`,
      ].join('\n\n'),
      uri: uriFor(id),
    }))
    .sort((left, right) => left.uri.localeCompare(right.uri));
}

function chunksFor(candidates: ReturnType<typeof candidatesFor>): readonly RecallChunk[] {
  return candidates.flatMap(candidate => {
    const chunks = chunkRecallDocument(candidate.uri, candidate.text);
    expect(chunks).toHaveLength(4);
    return chunks;
  });
}

async function rebuild(
  home: string,
  candidates: ReturnType<typeof candidatesFor>,
  runtimeLayer: ReturnType<typeof deterministicRuntimeLayer>,
) {
  return runEffect(
    rebuildVectorIndex({agentContextHome: home}, manifest, candidates).pipe(
      provideTestLayer(runtimeLayer),
      provideTestLayer(modelStoreLayer),
    ),
  );
}

async function assertVectorIndexMatchesModel(
  home: string,
  candidates: ReturnType<typeof candidatesFor>,
  expectedChunks: readonly RecallChunk[],
): Promise<void> {
  expect(await runEffect(vectorIndexStatus(home, manifest, candidates))).toMatchObject({
    chunkCount: expectedChunks.length,
    ready: true,
  });

  const database = new Database(vectorDatabasePath(home), {readonly: true});
  try {
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(database.query('SELECT COUNT(*) AS count FROM vector_generations').get()).toEqual({count: 1});
    expect(database.query("SELECT COUNT(*) AS count FROM vector_generations WHERE state <> 'ready'").get()).toEqual({
      count: 0,
    });
    expect(database.query('SELECT COUNT(*) AS count FROM vector_pointer').get()).toEqual({count: 1});
    expect(database.query('SELECT COUNT(*) AS count FROM vector_chunks').get()).toEqual({
      count: expectedChunks.length,
    });
    expect(
      database
        .query(
          `SELECT COUNT(*) AS count
           FROM vector_chunks AS chunk
           WHERE NOT EXISTS (
             SELECT 1
             FROM vector_pointer AS pointer
             WHERE pointer.generation = chunk.generation
           )`,
        )
        .get(),
    ).toEqual({count: 0});
    expect(
      database
        .query(
          `SELECT COUNT(*) AS count
           FROM vector_values AS value
           LEFT JOIN vector_chunks AS chunk ON chunk.vector_id = value.id
           WHERE chunk.vector_id IS NULL`,
        )
        .get(),
    ).toEqual({count: 0});

    const uniqueFingerprints = new Set(expectedChunks.map(chunk => chunk.fingerprint));
    expect(database.query('SELECT COUNT(*) AS count FROM vector_values').get()).toEqual({
      count: uniqueFingerprints.size,
    });
    const rows = storedVectorRows(database);
    expect(rows).toHaveLength(expectedChunks.length);
    const byChunkId = new Map(rows.map(row => [row.chunk_id, row]));
    expect(byChunkId.size).toBe(expectedChunks.length);
    for (const chunk of expectedChunks) {
      const row = byChunkId.get(chunk.id);
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        chunk_id: chunk.id,
        fingerprint: chunk.fingerprint,
        uri: chunk.uri,
      });
      expect(decodeVector(row!.vector)).toEqual(expectedStoredVector(embeddingInput(chunk)));
    }
    expect(new Set(rows.map(row => row.vector_id)).size).toBe(uniqueFingerprints.size);
  } finally {
    database.close();
  }
}

function storedVectorRows(database: Database) {
  return database
    .query(
      `SELECT
         chunk.uri,
         chunk.chunk_id,
         chunk.fingerprint,
         chunk.vector_id,
         value.vector
       FROM vector_pointer AS pointer
       JOIN vector_chunks AS chunk ON chunk.generation = pointer.generation
       JOIN vector_values AS value ON value.id = chunk.vector_id
       WHERE pointer.singleton = 1
       ORDER BY chunk.uri, chunk.chunk_id`,
    )
    .all() as readonly {
    readonly chunk_id: string;
    readonly fingerprint: string;
    readonly uri: string;
    readonly vector: unknown;
    readonly vector_id: number;
  }[];
}

function deterministicRuntimeLayer(onEmbed: (inputs: readonly string[]) => void) {
  return Layer.succeed(
    LocalModelRuntime,
    LocalModelRuntime.of({
      diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
      embedMany: ({inputs, manifest: requested}) => {
        onEmbed(inputs);
        return Effect.succeed(inputs.map(input => deterministicVector(requested.dimensions ?? 0, input)));
      },
      generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
      rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
    }),
  );
}

function deterministicVector(dimensions: number, input: string): readonly number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const digest = createHash('sha256').update(input).digest();
  for (const [index, byte] of digest.entries()) vector[index] = byte + 1;
  return vector;
}

function expectedStoredVector(input: string): readonly number[] {
  const vector = deterministicVector(manifest.dimensions, input);
  const magnitude = Math.sqrt(vector.reduce((total, component) => total + component * component, 0));
  return vector.map(component => Math.fround(component / magnitude));
}

function decodeVector(value: unknown): readonly number[] {
  const bytes =
    value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : undefined;
  if (!bytes) throw TestError.make({message: 'Stored vector is not a binary SQLite value.'});
  expect(bytes.byteLength).toBe(manifest.dimensions * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({length: manifest.dimensions}, (_, index) => view.getFloat32(index * 4, true));
}

function assertBuildResult(
  result: Awaited<ReturnType<typeof rebuild>>,
  previousChunks: readonly RecallChunk[],
  chunks: readonly RecallChunk[],
): void {
  const reusableFingerprints = new Set(previousChunks.map(chunk => chunk.fingerprint));
  const reusedChunkCount = chunks.filter(chunk => reusableFingerprints.has(chunk.fingerprint)).length;
  expect(result).toMatchObject({
    chunkCount: chunks.length,
    embeddedChunkCount: chunks.length - reusedChunkCount,
    ready: true,
    reusedChunkCount,
  });
}

function expectedEmbeddingInputs(
  previousChunks: readonly RecallChunk[],
  chunks: readonly RecallChunk[],
): readonly string[] {
  const reusableFingerprints = new Set(previousChunks.map(chunk => chunk.fingerprint));
  return chunks
    .filter(chunk => !reusableFingerprints.has(chunk.fingerprint))
    .map(embeddingInput)
    .sort();
}

function embeddingInput(chunk: RecallChunk): string {
  return `${manifest.promptPrefixes?.document ?? ''}${chunk.content}`;
}

function takeEmbeddedInputs(inputs: string[]): readonly string[] {
  return inputs.splice(0).sort();
}

function installation(home: string) {
  return {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: `${home}/models/property.gguf`,
    verified: true,
  };
}

function uriFor(id: number): string {
  return `threadnote://resources/repos/property/document-${id}.md`;
}

function vectorDatabasePath(home: string): string {
  return join(home, 'indexes', 'vectors', manifest.id, vectorIndexDatabaseFilename());
}
