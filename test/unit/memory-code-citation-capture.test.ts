import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import type {CodeGraphStoreShape} from '../../src/code_graph/store_shape.js';
import {codeGraphCommittedFileContentHash} from '../../src/code_graph/content_identity.js';
import {CodeGraphQueryService} from '../../src/code_graph/query.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import type {
  CodeGraphEffectiveSnapshotCitationEvidence,
  CodeGraphEffectiveSnapshotCitationEvidenceRequest,
} from '../../src/code_graph/citation_primitives.js';
import type {CodeGraphInventoryFile, CodeGraphStatus, CodeGraphSymbol} from '../../src/code_graph/types.js';
import {validateContextBriefMemoryCitations} from '../../src/context_brief/citation_validation.js';
import {StandaloneBrokerLayer} from '../../src/effect/runtime.js';
import {captureMemoryCodeCitations} from '../../src/memory_code_citation_capture.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const SOURCE = 'export function value() {\n  return "😀";\n}\n';
const SOURCE_HASH = codeGraphCommittedFileContentHash('sha1', new TextEncoder().encode(SOURCE));
const REPOSITORY_ID = '1'.repeat(64);
const COMMIT = '2'.repeat(40);
const SNAPSHOT_ID = `cgsn_${'3'.repeat(40)}`;
const SYMBOL_ID = `cgs_${'4'.repeat(32)}`;
const MODULE_ID = `cgs_${'6'.repeat(32)}`;

describe('memory code citation capture and validation', () => {
  effectIt.effect('captures exact file and symbol evidence and reuses snapshot-scoped validation receipts', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-capture-'});
      yield* fs.makeDirectory(path.join(root, 'src'), {recursive: true});
      yield* fs.writeFileString(path.join(root, 'src', 'value.ts'), SOURCE);

      const fixture = citationFixture(root);
      const citations = yield* captureMemoryCodeCitations(CONFIG, {
        callerCwd: root,
        refs: ['src/value.ts', MODULE_ID, SYMBOL_ID],
      }).pipe(provideTestLayer(fixture.layer));

      // A module-root cgs_ reference intentionally becomes the same file
      // citation as its path, then canonical citation IDs deduplicate it.
      expect(citations).toHaveLength(2);
      expect(citations[0]).toMatchObject({
        fileContentHash: {algorithm: 'sha256', value: SOURCE_HASH},
        path: 'src/value.ts',
        repositoryId: REPOSITORY_ID,
        repositoryIdentityKind: 'remote',
        sourceCommit: COMMIT,
        sourceDirty: false,
        sourceSnapshotId: SNAPSHOT_ID,
        target: {kind: 'file'},
      });
      expect(citations[1]).toMatchObject({
        path: 'src/value.ts',
        target: {
          fragmentCanonicalization: 'utf8-source-span-v1',
          kind: 'symbol',
          nodeId: SYMBOL_ID,
          span: fixture.symbol.span,
        },
      });

      const candidate = {
        citationErrorCount: 0,
        codeCitations: citations,
        excerpt: 'The value helper is the stable boundary.',
        kind: 'durable' as const,
        project: 'threadnote',
        rank: 0,
        topic: 'value-helper',
        uri: 'threadnote://user/test/memories/durable/projects/threadnote/value-helper.md',
      };
      const first = yield* validateContextBriefMemoryCitations(CONFIG, {callerCwd: root, kind: 'repository'}, [
        candidate,
      ]).pipe(provideTestLayer(fixture.layer));
      const callsAfterFirstValidation = fixture.evidenceCalls();
      yield* TestClock.adjust('1 second');
      const second = yield* validateContextBriefMemoryCitations(CONFIG, {callerCwd: root, kind: 'repository'}, [
        candidate,
      ]).pipe(provideTestLayer(fixture.layer));

      expect(first[0]?.receipts.map(receipt => receipt.status)).toEqual(['exact', 'exact']);
      expect(first[0]?.cacheHits).toBeUndefined();
      expect(new Set(first[0]?.receipts.map(receipt => receipt.observedAt)).size).toBe(1);
      expect(new Set(second[0]?.receipts.map(receipt => receipt.observedAt)).size).toBe(1);
      expect(second[0]?.receipts[0]?.observedAt).not.toBe(first[0]?.receipts[0]?.observedAt);
      expect(first[0]?.receipts.every(receipt => receipt.snapshotCompletedAt === '2026-08-26T00:00:00.000Z')).toBe(
        true,
      );
      expect(second[0]?.cacheHits).toBe(2);
      expect(fixture.evidenceCalls()).toBe(callsAfterFirstValidation);
      expect(fixture.leases()).toEqual({acquired: 3, released: 3});
      expect(fixture.validationSessions()).toBe(2);
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );
});

function citationFixture(root: string) {
  const file: CodeGraphInventoryFile = {
    blobId: 'fixture-blob',
    contentHash: SOURCE_HASH,
    language: 'typescript',
    mode: '100644',
    path: 'src/value.ts',
    size: new TextEncoder().encode(SOURCE).byteLength,
    source: 'commit',
  };
  const symbol: CodeGraphSymbol = {
    contentHash: SOURCE_HASH,
    exported: true,
    id: SYMBOL_ID,
    kind: 'function',
    language: 'typescript',
    name: 'value',
    path: file.path,
    qualifiedName: 'value',
    signature: 'export function value(): string',
    span: {column: 1, endColumn: 2, endLine: 3, line: 1},
  };
  const moduleSymbol: CodeGraphSymbol = {
    ...symbol,
    id: MODULE_ID,
    kind: 'module',
    name: file.path,
    qualifiedName: file.path,
    signature: undefined,
    span: {column: 1, endColumn: 1, endLine: 1, line: 1},
  };
  const status: CodeGraphStatus = {
    databasePath: `${root}/graph.sqlite`,
    freshness: 'current',
    identity: {
      caseMode: 'sensitive',
      checkoutId: 'fixture-checkout',
      displayName: 'example/threadnote',
      gitCommonDirectory: `${root}/.git`,
      headCommit: COMMIT,
      objectFormat: 'sha1',
      remoteIdentity: 'https://github.com/example/threadnote.git',
      repoRoot: root,
      repositoryId: REPOSITORY_ID,
      worktreeId: 'fixture-worktree',
    },
    languagePacks: [],
    readySnapshot: {
      commit: COMMIT,
      completedAt: '2026-08-26T00:00:00.000Z',
      dirty: false,
      edgeCount: 0,
      extractorSet: 'fixture-extractor-set',
      fileCount: 1,
      graphContentId: `cgc_${'5'.repeat(40)}`,
      id: SNAPSHOT_ID,
      repositoryId: REPOSITORY_ID,
      state: 'ready',
      symbolCount: 1,
      worktreeId: 'fixture-worktree',
    },
    stale: false,
  };
  let evidenceCalls = 0;
  let acquired = 0;
  let released = 0;
  let validationSessions = 0;
  const evidence = (request: CodeGraphEffectiveSnapshotCitationEvidenceRequest) => {
    evidenceCalls += 1;
    return {
      fileInventoryCoverage: 'complete',
      filesByContentHashes: (request.contentHashes ?? []).map(contentHash => ({
        contentHash,
        files: contentHash === SOURCE_HASH ? [file] : [],
        truncated: false,
      })),
      filesByPaths: (request.paths ?? []).map(repositoryPath => ({
        ...(repositoryPath === file.path ? {file} : {}),
        path: repositoryPath,
      })),
      symbolsByIds: [moduleSymbol, symbol].filter(candidate => (request.symbolIds ?? []).includes(candidate.id)),
      symbolsBySemanticLocators: (request.semanticLocators ?? []).map(locator => ({
        locator,
        symbols: [symbol],
        truncated: false,
      })),
    } satisfies CodeGraphEffectiveSnapshotCitationEvidence;
  };
  const store = CodeGraphStore.of({
    acquireSnapshotLease: () => Effect.sync(() => `lease-${++acquired}`),
    effectiveSnapshotCitationEvidence: (
      _databasePath: string,
      _snapshotId: string,
      request: CodeGraphEffectiveSnapshotCitationEvidenceRequest,
    ) => Effect.sync(() => evidence(request)),
    releaseSnapshotLease: () => Effect.sync(() => void ++released),
  } as unknown as CodeGraphStoreShape);
  const withStatusSession: NonNullable<Parameters<typeof CodeGraphQueryService.of>[0]['withStatusSession']> = (
    _home,
    _cwd,
    _expected,
    _options,
    use,
  ) => Effect.sync(() => void ++validationSessions).pipe(Effect.andThen(use(status)));
  const query = CodeGraphQueryService.of({
    status: () => Effect.succeed(status),
    withStatusSession,
  } as unknown as Parameters<typeof CodeGraphQueryService.of>[0]);
  return {
    evidenceCalls: () => evidenceCalls,
    layer: Layer.merge(Layer.succeed(CodeGraphStore, store), Layer.succeed(CodeGraphQueryService, query)),
    leases: () => ({acquired, released}),
    symbol,
    validationSessions: () => validationSessions,
  };
}

const CONFIG: RuntimeConfig = {
  account: 'test',
  agentContextHome: '/threadnote-home',
  agentId: 'test-agent',
  manifestPath: '/manifest.yaml',
  user: 'test-user',
};
