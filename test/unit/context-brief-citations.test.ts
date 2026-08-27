import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import fc from 'fast-check';
import {Effect, Layer} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  aggregatePreciseStatus,
  cleanPublishedCitationFenceMatches,
  routeContextBriefWorksetValidation,
  validateContextBriefFileCitation,
  validateContextBriefSymbolCitation,
  type ContextBriefPreciseEvidenceStatus,
} from '../../src/context_brief/index.js';
import {createCodeGraphSourceSpanCanonicalizer} from '../../src/code_graph/citation_primitives.js';
import {createMemoryCodeCitation} from '../../src/memory_code_citation.js';
import type {
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphStatus,
  CodeGraphSymbol,
} from '../../src/code_graph/types.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {codeGraphWorksetManifestDigest} from '../../src/code_graph/workset_catalog/workset.js';
import {SystemInfo} from '../../src/effect/system.js';
import type {ResolvedWorkset} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const SOURCE_HASH = 'a'.repeat(64);
const CHANGED_HASH = 'b'.repeat(64);
const OBSERVED_AT = '2026-08-26T00:00:00.000Z';
const citation = createMemoryCodeCitation({
  extractorSet: 'native-code-graph-13',
  fileContentHash: {algorithm: 'sha256', value: SOURCE_HASH},
  path: 'src/original.ts',
  repositoryId: 'c'.repeat(64),
  repositoryIdentityKind: 'remote',
  sourceCommit: 'd'.repeat(40),
  sourceDirty: false,
  sourceSnapshotId: `cgsn_${'e'.repeat(40)}`,
  target: {kind: 'file'},
  version: 1,
});
const snapshot: CodeGraphSnapshot = {
  commit: 'f'.repeat(40),
  dirty: false,
  edgeCount: 0,
  extractorSet: 'native-code-graph-13',
  fileCount: 1,
  id: `cgsn_${'1'.repeat(40)}`,
  repositoryId: citation.repositoryId,
  state: 'ready',
  symbolCount: 0,
  worktreeId: '2'.repeat(64),
};

describe('Context Brief code-citation classification', () => {
  it('accepts a clean published fence only while every code-bearing identity stays exact', () => {
    const before: CodeGraphStatus = {
      databasePath: '/threadnote/graph.sqlite',
      freshness: 'current',
      identity: {
        caseMode: 'sensitive',
        checkoutId: 'checkout',
        displayName: 'example/threadnote',
        gitCommonDirectory: '/work/.git',
        headCommit: snapshot.commit,
        objectFormat: 'sha1',
        remoteIdentity: 'https://github.com/example/threadnote.git',
        repoRoot: '/work',
        repositoryId: snapshot.repositoryId,
        worktreeId: snapshot.worktreeId,
      },
      languagePacks: [],
      readySnapshot: snapshot,
      stale: false,
    };
    const clean = {dirty: false as const, fingerprint: undefined};
    expect(cleanPublishedCitationFenceMatches(before, before.identity, clean, snapshot)).toBe(true);

    fc.assert(
      fc.property(
        fc.constantFrom(
          'checkout',
          'repository',
          'worktree',
          'head',
          'dirty',
          'snapshot',
          'commit',
          'snapshot-repository',
          'snapshot-worktree',
        ),
        mutation => {
          const identity = {
            ...before.identity,
            ...(mutation === 'checkout' ? {checkoutId: 'changed-checkout'} : {}),
            ...(mutation === 'repository' ? {repositoryId: '9'.repeat(64)} : {}),
            ...(mutation === 'worktree' ? {worktreeId: 'changed-worktree'} : {}),
            ...(mutation === 'head' ? {headCommit: '9'.repeat(40)} : {}),
          };
          const overlay = mutation === 'dirty' ? undefined : clean;
          const active = {
            ...snapshot,
            ...(mutation === 'snapshot' ? {id: `cgsn_${'9'.repeat(40)}`} : {}),
            ...(mutation === 'commit' ? {commit: '9'.repeat(40)} : {}),
            ...(mutation === 'snapshot-repository' ? {repositoryId: '9'.repeat(64)} : {}),
            ...(mutation === 'snapshot-worktree' ? {worktreeId: 'changed-worktree'} : {}),
          };
          expect(cleanPublishedCitationFenceMatches(before, identity, overlay, active)).toBe(false);
        },
      ),
      {numRuns: 100},
    );
  });

  it('classifies exact and relocated file evidence while abstaining on incomplete or ambiguous absence', () => {
    expect(
      validateContextBriefFileCitation(
        citation,
        {file: file(citation.path, SOURCE_HASH), path: citation.path},
        {contentHash: SOURCE_HASH, files: [file(citation.path, SOURCE_HASH)], truncated: false},
        snapshot,
        OBSERVED_AT,
      ).status,
    ).toBe('exact');
    expect(
      validateContextBriefFileCitation(
        citation,
        {path: citation.path},
        {contentHash: SOURCE_HASH, files: [file('src/moved.ts', SOURCE_HASH)], truncated: false},
        snapshot,
        OBSERVED_AT,
      ),
    ).toMatchObject({observedPath: 'src/moved.ts', status: 'relocated'});
    expect(
      validateContextBriefFileCitation(
        citation,
        {path: citation.path},
        {contentHash: SOURCE_HASH, files: [], truncated: false},
        snapshot,
        OBSERVED_AT,
      ),
    ).toMatchObject({coverage: 'incomplete', reason: 'graph-incomplete', status: 'unknown'});
    expect(
      validateContextBriefFileCitation(
        citation,
        {path: citation.path},
        {
          contentHash: SOURCE_HASH,
          files: [file('src/a.ts', SOURCE_HASH), file('src/b.ts', SOURCE_HASH)],
          truncated: false,
        },
        snapshot,
        OBSERVED_AT,
      ).status,
    ).toBe('unknown');
  });

  it('never rescues an occupied changed locator with an unchanged copy elsewhere', () => {
    expect(
      validateContextBriefFileCitation(
        citation,
        {file: file(citation.path, CHANGED_HASH), path: citation.path},
        {contentHash: SOURCE_HASH, files: [file('src/copy.ts', SOURCE_HASH)], truncated: false},
        snapshot,
        OBSERVED_AT,
      ),
    ).toMatchObject({observedPath: citation.path, reason: 'source-changed', status: 'changed'});
  });

  it('emits deleted only when the snapshot proves complete repository-file coverage', () => {
    expect(
      validateContextBriefFileCitation(
        citation,
        {path: citation.path},
        {contentHash: SOURCE_HASH, files: [], truncated: false},
        snapshot,
        OBSERVED_AT,
        'complete',
      ),
    ).toMatchObject({coverage: 'current-complete', reason: 'source-deleted', status: 'deleted'});
  });

  it('aggregates without ever making changed, deleted, or unknown evidence fresh', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<ContextBriefPreciseEvidenceStatus>('exact', 'relocated'), {
          maxLength: 7,
        }),
        fc.constantFrom<ContextBriefPreciseEvidenceStatus>('changed', 'deleted', 'unknown'),
        (safe, unsafe) => {
          const aggregate = aggregatePreciseStatus([...safe, unsafe].map(status => ({status})));
          expect(aggregate).toBe(unsafe);
        },
      ),
      {numRuns: 100},
    );
  });

  effectIt.effect('marks a same-path symbol span move as relocated when its cited fragment survives', () => {
    const source = 'export function target() {}\n';
    const movedSource = `\n${source}`;
    const cited = symbolCitation(source);
    const current = symbol({
      contentHash: sha256HexSync(movedSource),
      id: cited.target.kind === 'symbol' ? cited.target.nodeId : '',
      path: cited.path,
      span: {column: 1, endColumn: source.trimEnd().length + 1, endLine: 2, line: 2},
    });

    return validateContextBriefSymbolCitation(
      cited as typeof cited & {readonly target: Extract<typeof cited.target, {readonly kind: 'symbol'}>},
      current,
      undefined,
      {file: file(cited.path, current.contentHash), path: cited.path},
      undefined,
      snapshot,
      () => Effect.succeed(createCodeGraphSourceSpanCanonicalizer(movedSource)),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() =>
          expect(receipt).toMatchObject({
            observedNodeId: current.id,
            observedSpan: current.span,
            status: 'relocated',
            strategy: 'node-id',
          }),
        ),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, SystemInfo.layer)),
    );
  });

  effectIt.effect('uses unknown instead of deletion when exact file bytes survive degraded symbol extraction', () => {
    const source = 'export function target() {}\n';
    const cited = symbolCitation(source);
    return validateContextBriefSymbolCitation(
      cited as typeof cited & {readonly target: Extract<typeof cited.target, {readonly kind: 'symbol'}>},
      undefined,
      undefined,
      {file: file(cited.path, cited.fileContentHash.value), path: cited.path},
      {
        contentHash: cited.fileContentHash.value,
        files: [file(cited.path, cited.fileContentHash.value)],
        truncated: false,
      },
      snapshot,
      () => Effect.die(new Error('source should not be read without a symbol candidate')),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() => expect(receipt).toMatchObject({reason: 'graph-incomplete', status: 'unknown'})),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, SystemInfo.layer)),
    );
  });

  effectIt.effect('abstains when a semantic locator has two candidates even if one fragment matches', () => {
    const source = 'export function target() {}\n';
    const cited = symbolCitation(source);
    const matching = symbol({
      contentHash: cited.fileContentHash.value,
      id: `cgs_${'7'.repeat(32)}`,
      path: 'src/moved.ts',
    });
    const unread = symbol({contentHash: '8'.repeat(64), id: `cgs_${'9'.repeat(32)}`, path: 'src/unread.ts'});
    const locator = {
      kind: matching.kind,
      language: matching.language,
      name: matching.name,
      qualifiedName: matching.qualifiedName,
      version: 1 as const,
    };
    return validateContextBriefSymbolCitation(
      cited as typeof cited & {readonly target: Extract<typeof cited.target, {readonly kind: 'symbol'}>},
      undefined,
      {locator, symbols: [matching, unread], truncated: false},
      {path: cited.path},
      {contentHash: cited.fileContentHash.value, files: [file(matching.path, matching.contentHash)], truncated: false},
      snapshot,
      repositoryPath =>
        repositoryPath === unread.path
          ? Effect.fail('unread-candidate' as const)
          : Effect.succeed(createCodeGraphSourceSpanCanonicalizer(source)),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() => expect(receipt).toMatchObject({reason: 'ambiguous-relocation', status: 'unknown'})),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, SystemInfo.layer)),
    );
  });

  effectIt.effect('abstains on duplicate semantic candidates even when the old source path is occupied', () => {
    const source = 'export function target() {}\n';
    const cited = symbolCitation(source);
    const first = symbol({contentHash: cited.fileContentHash.value, id: `cgs_${'7'.repeat(32)}`, path: 'src/a.ts'});
    const second = symbol({contentHash: cited.fileContentHash.value, id: `cgs_${'8'.repeat(32)}`, path: 'src/b.ts'});
    const locator = {
      kind: first.kind,
      language: first.language,
      name: first.name,
      qualifiedName: first.qualifiedName,
      version: 1 as const,
    };
    return validateContextBriefSymbolCitation(
      cited as typeof cited & {readonly target: Extract<typeof cited.target, {readonly kind: 'symbol'}>},
      undefined,
      {locator, symbols: [first, second], truncated: false},
      {file: file(cited.path, CHANGED_HASH), path: cited.path},
      {contentHash: cited.fileContentHash.value, files: [file(first.path, first.contentHash)], truncated: true},
      snapshot,
      () => Effect.die(new Error('ambiguous candidates must not be inspected')),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() => expect(receipt).toMatchObject({reason: 'ambiguous-relocation', status: 'unknown'})),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, SystemInfo.layer)),
    );
  });

  effectIt.effect('accepts a unique symbol relocation when an unrelated file reuses the old path', () => {
    const source = 'export function target() {}\n';
    const cited = symbolCitation(source);
    const moved = symbol({
      contentHash: cited.fileContentHash.value,
      id: `cgs_${'7'.repeat(32)}`,
      path: 'src/moved.ts',
    });
    const locator = {
      kind: moved.kind,
      language: moved.language,
      name: moved.name,
      qualifiedName: moved.qualifiedName,
      version: 1 as const,
    };
    return validateContextBriefSymbolCitation(
      cited as typeof cited & {readonly target: Extract<typeof cited.target, {readonly kind: 'symbol'}>},
      undefined,
      {locator, symbols: [moved], truncated: false},
      {file: file(cited.path, CHANGED_HASH), path: cited.path},
      {contentHash: cited.fileContentHash.value, files: [file(moved.path, moved.contentHash)], truncated: false},
      snapshot,
      () => Effect.succeed(createCodeGraphSourceSpanCanonicalizer(source)),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() =>
          expect(receipt).toMatchObject({observedNodeId: moved.id, reason: 'relocated', status: 'relocated'}),
        ),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, SystemInfo.layer)),
    );
  });

  effectIt.effect('keeps an original changed symbol authoritative over an unchanged duplicate', () => {
    const source = 'export function target() {}\n';
    const changedSource = 'export function target() { return 1; }\n';
    const cited = symbolCitation(source);
    const original = symbol({
      contentHash: sha256HexSync(changedSource),
      id: `cgs_${'7'.repeat(32)}`,
      path: cited.path,
      span: cited.target.kind === 'symbol' ? cited.target.span : undefined,
    });
    const copy = symbol({contentHash: cited.fileContentHash.value, id: `cgs_${'8'.repeat(32)}`, path: 'src/copy.ts'});
    const locator = {
      kind: original.kind,
      language: original.language,
      name: original.name,
      qualifiedName: original.qualifiedName,
      version: 1 as const,
    };
    return validateContextBriefSymbolCitation(
      cited as typeof cited & {readonly target: Extract<typeof cited.target, {readonly kind: 'symbol'}>},
      undefined,
      {locator, symbols: [original, copy], truncated: false},
      {file: file(cited.path, original.contentHash), path: cited.path},
      {contentHash: cited.fileContentHash.value, files: [file(copy.path, copy.contentHash)], truncated: false},
      snapshot,
      repositoryPath =>
        Effect.succeed(createCodeGraphSourceSpanCanonicalizer(repositoryPath === cited.path ? changedSource : source)),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() =>
          expect(receipt).toMatchObject({observedNodeId: original.id, reason: 'source-changed', status: 'changed'}),
        ),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, SystemInfo.layer)),
    );
  });

  effectIt.effect('abstains when changed file bytes have no symbol evidence after parser degradation', () => {
    const source = 'export function target() {}\n';
    const cited = symbolCitation(source);
    return validateContextBriefSymbolCitation(
      cited as typeof cited & {readonly target: Extract<typeof cited.target, {readonly kind: 'symbol'}>},
      undefined,
      undefined,
      {file: file(cited.path, CHANGED_HASH), path: cited.path},
      {contentHash: cited.fileContentHash.value, files: [], truncated: false},
      snapshot,
      () => Effect.die(new Error('source should not be read without a symbol candidate')),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() => expect(receipt).toMatchObject({reason: 'graph-incomplete', status: 'unknown'})),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, SystemInfo.layer)),
    );
  });

  effectIt.effect('emits symbol deletion only under complete file-inventory coverage', () => {
    const source = 'export function target() {}\n';
    const cited = symbolCitation(source);
    return validateContextBriefSymbolCitation(
      cited as typeof cited & {readonly target: Extract<typeof cited.target, {readonly kind: 'symbol'}>},
      undefined,
      undefined,
      {path: cited.path},
      {contentHash: cited.fileContentHash.value, files: [], truncated: false},
      snapshot,
      () => Effect.die(new Error('source should not be read without a symbol candidate')),
      OBSERVED_AT,
      'complete',
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() =>
          expect(receipt).toMatchObject({coverage: 'current-complete', reason: 'source-deleted', status: 'deleted'}),
        ),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, SystemInfo.layer)),
    );
  });

  effectIt.effect('rejects an exact node whose semantic locator disagrees with the citation', () => {
    const source = 'export function target() {}\n';
    const forged = symbolCitation(source, {name: 'forged', qualifiedName: 'forged'});
    const current = symbol({
      contentHash: forged.fileContentHash.value,
      id: forged.target.kind === 'symbol' ? forged.target.nodeId : '',
      path: forged.path,
    });
    return validateContextBriefSymbolCitation(
      forged as typeof forged & {readonly target: Extract<typeof forged.target, {readonly kind: 'symbol'}>},
      current,
      undefined,
      {file: file(forged.path, forged.fileContentHash.value), path: forged.path},
      undefined,
      snapshot,
      () => Effect.succeed(createCodeGraphSourceSpanCanonicalizer(source)),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() => expect(receipt).toMatchObject({reason: 'validation-error', status: 'unknown'})),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, SystemInfo.layer)),
    );
  });

  it('routes a 128-member workset to at most the 32 cited repositories before status probes', () => {
    const projects = Array.from({length: 128}, (_, index) => ({
      name: `project-${index}`,
      path: `/work/project-${index}`,
      seed: [],
      uri: `threadnote://projects/project-${index}`,
    }));
    const workset: ResolvedWorkset = {name: 'large', projects, unresolvedProjects: []};
    const repositoryIds = projects.map((_, index) => index.toString(16).padStart(64, '0'));
    const admitted = new Set(repositoryIds.slice(0, 32));
    const published = {
      digest: 'generation',
      id: 'generation-id',
      manifestDigest: codeGraphWorksetManifestDigest(workset),
      members: projects.map((project, index) => ({
        checkoutId: `checkout-${index}`,
        commitId: 'a'.repeat(40),
        ordinal: index,
        projectionDigest: `projection-${index}`,
        repositoryId: repositoryIds[index]!,
        repositoryKey: project.name,
        snapshotDigest: `snapshot-digest-${index}`,
        snapshotId: `cgsn_${index.toString(16).padStart(40, '0')}`,
        symbolCount: 1,
        worktreeId: index.toString(16).padStart(64, 'f'),
      })),
      worksetName: workset.name,
    } as const;
    const route = routeContextBriefWorksetValidation(workset, published, admitted);

    expect(route.stale).toBe(false);
    expect(route.ambiguousRepositoryIds.size).toBe(0);
    expect(route.members).toHaveLength(32);
    expect(new Set(route.members.map(member => member.published.repositoryId))).toEqual(admitted);
    expect(
      routeContextBriefWorksetValidation(workset, published, admitted, {
        digest: 'different-generation',
        id: 'different-generation-id',
      }),
    ).toMatchObject({members: [], stale: true});
  });
});

function file(path: string, contentHash: string): CodeGraphInventoryFile {
  return {
    blobId: `snapshot:${contentHash}`,
    contentHash,
    language: 'typescript',
    mode: '100644',
    path,
    size: 12,
    source: 'commit',
  };
}

function symbolCitation(
  source: string,
  overrides: Partial<Extract<ReturnType<typeof createMemoryCodeCitation>['target'], {readonly kind: 'symbol'}>> = {},
) {
  const text = source.trimEnd();
  return createMemoryCodeCitation({
    extractorSet: snapshot.extractorSet,
    fileContentHash: {algorithm: 'sha256', value: sha256HexSync(source)},
    path: 'src/original.ts',
    repositoryId: snapshot.repositoryId,
    repositoryIdentityKind: 'remote',
    sourceCommit: citation.sourceCommit,
    sourceDirty: false,
    sourceSnapshotId: citation.sourceSnapshotId,
    target: {
      fragmentCanonicalization: 'utf8-source-span-v1',
      fragmentHash: {algorithm: 'sha256', value: sha256HexSync(text)},
      kind: 'symbol',
      language: 'typescript',
      name: 'target',
      nodeId: `cgs_${'6'.repeat(32)}`,
      qualifiedName: 'target',
      signatureHash: {algorithm: 'sha256', value: sha256HexSync('export function target(): void')},
      span: {column: 1, endColumn: text.length + 1, endLine: 1, line: 1},
      symbolKind: 'function',
      ...overrides,
    },
    version: 1,
  });
}

function symbol(
  overrides: Partial<CodeGraphSymbol> & Pick<CodeGraphSymbol, 'contentHash' | 'id' | 'path'>,
): CodeGraphSymbol {
  return {
    ...overrides,
    contentHash: overrides.contentHash,
    exported: true,
    id: overrides.id,
    kind: 'function',
    language: 'typescript',
    name: 'target',
    path: overrides.path,
    qualifiedName: 'target',
    signature: 'export function target(): void',
    span: overrides.span ?? {column: 1, endColumn: 'export function target() {}'.length + 1, endLine: 1, line: 1},
  };
}
