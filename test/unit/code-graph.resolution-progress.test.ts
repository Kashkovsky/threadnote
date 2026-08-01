import {Deferred, Effect, Ref} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {CodeGraphStore, type CodeGraphResolutionProgressCallback} from '../../src/code_graph/store.js';
import type {
  CodeGraphEdge,
  CodeGraphInventoryFile,
  CodeGraphReference,
  CodeGraphResolutionActivity,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '../../src/code_graph/types.js';
import {join, mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {force: true, recursive: true})));
});

describe('code graph reference-resolution progress', () => {
  it('reports every bounded page, including pages with no matches, and cooperatively yields between pages', async () => {
    const fixture = await resolutionFixture();
    const caller = symbol('caller', 'caller');
    const references = Array.from({length: 1_201}, (_, index) => unresolvedReference(fixture.file, caller, index));
    const observations: CodeGraphResolutionActivity[] = [];

    const result = await runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          const firstPage = yield* Deferred.make<void>();
          const completed = yield* Ref.make(false);
          const schedulerTurns = yield* Ref.make(0);
          yield* Effect.forkScoped(
            Deferred.await(firstPage).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  while (!(yield* Ref.get(completed))) {
                    yield* Ref.update(schedulerTurns, turns => turns + 1);
                    yield* Effect.yieldNow;
                  }
                }),
              ),
            ),
          );
          const onProgress: CodeGraphResolutionProgressCallback = progress =>
            Effect.gen(function* () {
              observations.push(progress);
              if (progress.pageCompleted === 0) yield* Deferred.succeed(firstPage, undefined);
            });
          const summary = yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
              yield* store.stageActivationFacts(
                fixture.databasePath,
                [caller],
                references.map(entry => entry.edge),
                references.map(entry => entry.reference),
              );
              return yield* store.resolveStagedReferences(fixture.databasePath, onProgress);
            }),
          );
          yield* Ref.set(completed, true);
          yield* Effect.yieldNow;
          return {schedulerTurns: yield* Ref.get(schedulerTurns), summary};
        }),
      ),
    );

    expect(observations.map(progress => progress.pageCompleted)).toEqual([0, 1, 2, 3]);
    expect(observations.map(progress => progress.referencesCompleted)).toEqual([0, 500, 1_000, 1_201]);
    expect(observations.every(progress => progress.pageTotal === 3 && progress.referencesTotal === 1_201)).toBe(true);
    expect(observations.at(-1)).toMatchObject({
      pagesCompleted: 3,
      pass: 1,
      referencesExamined: 1_201,
      resolved: 0,
    });
    expect(observations.every(progress => progress.elapsedMilliseconds >= progress.matchingMilliseconds)).toBe(true);
    expect(result.summary).toMatchObject({
      pagesCompleted: 3,
      passesCompleted: 1,
      referencesExamined: 1_201,
      resolved: 0,
      transactionMilliseconds: 0,
    });
    expect(result.schedulerTurns).toBeGreaterThan(0);
  });
});

async function resolutionFixture() {
  const root = await mkdtemp('threadnote-resolution-progress-');
  temporaryRoots.push(root);
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: 'c'.repeat(64),
    displayName: 'resolution-progress-fixture',
    gitCommonDirectory: root,
    headCommit: '1'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: 'r'.repeat(64),
    worktreeId: 'w'.repeat(64),
  };
  const file: CodeGraphInventoryFile = {
    blobId: 'b'.repeat(40),
    contentHash: 'h'.repeat(64),
    language: 'typescript',
    mode: '100644',
    path: 'src/resolution.ts',
    size: 128,
    source: 'commit',
  };
  return {databasePath: join(root, 'graph-v3.sqlite'), file, identity};
}

function symbol(id: string, name: string): CodeGraphSymbol {
  return {
    contentHash: `hash-${id}`,
    exported: true,
    id,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [`typescript:name:${name}`],
    name,
    path: 'src/resolution.ts',
    qualifiedName: name,
    resolutionDomain: 'typescript',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function unresolvedReference(
  file: CodeGraphInventoryFile,
  caller: CodeGraphSymbol,
  index: number,
): {readonly edge: CodeGraphEdge; readonly reference: CodeGraphReference} {
  const suffix = String(index).padStart(4, '0');
  const edge: CodeGraphEdge = {
    confidence: 0.7,
    evidencePath: file.path,
    evidenceSpan: caller.span,
    id: `unresolved-${suffix}`,
    provenance: 'syntactic',
    relation: 'calls',
    sourceId: caller.id,
    sourceName: caller.name,
    targetName: `missing-${suffix}`,
  };
  return {
    edge,
    reference: {
      edgeId: edge.id,
      evidencePath: file.path,
      evidenceSpan: caller.span,
      lookupTiers: [[`typescript:name:missing-${suffix}`]],
      provenance: 'syntactic',
      relation: 'calls',
      resolutionDomain: 'typescript',
      sourceId: caller.id,
      sourceName: caller.name,
      targetName: edge.targetName,
    },
  };
}
