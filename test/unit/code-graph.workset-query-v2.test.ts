import {it as effectIt} from '@effect/vitest';
import fc from 'fast-check';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {codeGraphProtobufMoniker} from '../../src/code_graph/cross_repository/monikers.js';
import {expandCodeGraphWorksetRouterWithBridges} from '../../src/code_graph/cross_repository/query_expansion.js';
import {
  resolveCodeGraphCrossRepositoryBridges,
  type CodeGraphCrossRepositoryBridgeV1,
} from '../../src/code_graph/cross_repository/resolver.js';
import {
  CODE_GRAPH_QUALIFIED_REF_TARGET_STATUS_OPTIONS,
  runCodeGraphWorksetQueryV2Core,
  type CodeGraphWorksetQueryV2InputV1,
} from '../../src/code_graph/workset_query_v2.js';
import {
  normalizeCodeGraphWorksetRouterQuery,
  rankCodeGraphWorksetRouterCandidates,
  type CodeGraphWorksetRouterResultV1,
} from '../../src/code_graph/workset_router.js';
import type {CodeGraphQueryNode, CodeGraphQueryResult} from '../../src/code_graph/types.js';
import type {
  CodeGraphWorksetCatalogPublishedGenerationV1,
  CodeGraphWorksetCatalogRoutingSymbolRecordV1,
} from '../../src/code_graph/workset_catalog/types.js';

describe('code graph Workset Search V2 core', () => {
  it('resolves qualified references without observing dirty worktree state', () => {
    expect(CODE_GRAPH_QUALIFIED_REF_TARGET_STATUS_OPTIONS).toEqual({
      observeWorktree: false,
      requestMaintenance: false,
    });
  });

  effectIt.effect('returns compact qualified evidence and persists every referenced handle', () =>
    Effect.gen(function* () {
      const fixture = makeFixture(4);
      const persisted: string[] = [];
      const execution = yield* runCodeGraphWorksetQueryV2Core(
        dependencies(fixture, {
          persistRefs: refs => persisted.push(...refs.map(ref => `${ref.repositoryId}:${ref.nodeId}`)),
        }),
        fixture.input,
      );

      expect(execution.logicalResult.cards).toHaveLength(2);
      expect(execution.logicalResult.coverage).toMatchObject({
        cataloguedRepositories: 4,
        complete: true,
        consideredRepositories: 4,
        deepQueriedRepositories: 4,
        stopReason: 'sufficient-evidence',
      });
      expect(persisted).toHaveLength(2);
      expect(execution.projected.measurement.estimatedTokens).toBeLessThanOrEqual(1_250);
      expect(execution.projected.structuredContent.cards.every(card => card.ref.startsWith('cgr_'))).toBe(true);
      expect(JSON.stringify(execution.projected)).not.toContain('cgwr_');
      expect(JSON.stringify(execution.projected)).not.toContain('cgwsc_');
    }),
  );

  effectIt.effect('attributes the bounded evidence projection to query serialization', () =>
    Effect.gen(function* () {
      const fixture = makeFixture(4);
      const observedStages: string[] = [];
      const execution = yield* runCodeGraphWorksetQueryV2Core(dependencies(fixture), fixture.input, {
        telemetry: {
          skip: () => Effect.void,
          stage: (phase, stage, effect, disposition) =>
            effect.pipe(
              Effect.tap(() =>
                Effect.sync(() => observedStages.push([phase, stage, disposition].filter(Boolean).join(':'))),
              ),
            ),
        },
      });

      expect(execution.projected.measurement.totalBytes).toBeGreaterThan(0);
      expect(observedStages).toEqual(['graph.query.execute:query-serialization']);
    }),
  );

  effectIt.effect('reports a failed ready-snapshot read without changing evidence from other repositories', () =>
    Effect.gen(function* () {
      const fixture = makeFixture(4);
      const baseline = yield* runCodeGraphWorksetQueryV2Core(dependencies(fixture), fixture.input);
      const failed = yield* runCodeGraphWorksetQueryV2Core(
        dependencies(fixture, {failRepositoryKey: 'repository-3'}),
        fixture.input,
      );

      expect(failed.logicalResult.repositories['repository-3']).toMatchObject({deepQueried: true, state: 'failed'});
      expect(failed.logicalResult.cards).toEqual(baseline.logicalResult.cards);
      expect(failed.instrumentation.deepQueryFailures).toBe(1);
    }),
  );

  effectIt.effect('interrupts an admitted deep-read batch at the query deadline and reports it truthfully', () =>
    Effect.gen(function* () {
      const fixture = makeFixture(4);
      const delays = new Map(fixture.input.members.map(member => [member.repositoryKey, 1_000] as const));
      const execution = yield* runCodeGraphWorksetQueryV2Core(dependencies(fixture, {delays}), {
        ...fixture.input,
        deadlineMilliseconds: 350,
      }).pipe(TestClock.withLive);

      expect(execution.logicalResult.coverage.stopReason).toBe('deadline');
      expect(execution.logicalResult.cards).toEqual([]);
      expect(execution.logicalResult.warnings).toContain('The workset query stopped at its read deadline.');
    }),
  );

  effectIt.effect('accounts for runtime preflight elapsed before the core read begins', () =>
    Effect.gen(function* () {
      const fixture = makeFixture(4);
      const baseDependencies = dependencies(fixture);
      const admitted = yield* runCodeGraphWorksetQueryV2Core(
        {...baseDependencies, nowMilliseconds: Effect.succeed(1_000)},
        {...fixture.input, deadlineMilliseconds: 1_000},
        {startedAtMilliseconds: 1_000},
      );
      const expired = yield* runCodeGraphWorksetQueryV2Core(
        {...baseDependencies, nowMilliseconds: Effect.succeed(1_000)},
        {...fixture.input, deadlineMilliseconds: 1_000},
        {startedAtMilliseconds: 0},
      );

      expect(admitted.instrumentation.deepQueriedRepositories).toBe(4);
      expect(expired.logicalResult.coverage.stopReason).toBe('deadline');
      expect(expired.instrumentation.deepQueriedRepositories).toBe(0);
      expect(expired.logicalResult.cards).toEqual([]);
      expect(expired.logicalResult.warnings).toContain('The workset query stopped at its read deadline.');
    }),
  );

  effectIt.effect('retains repositories that completed before another deep read reached the deadline', () =>
    Effect.gen(function* () {
      const fixture = makeFixture(4);
      const delays = new Map(
        fixture.input.members.map((member, index) => [member.repositoryKey, index === 0 ? 0 : 1_000] as const),
      );
      const execution = yield* runCodeGraphWorksetQueryV2Core(dependencies(fixture, {delays}), {
        ...fixture.input,
        deadlineMilliseconds: 350,
      }).pipe(TestClock.withLive);

      expect(execution.logicalResult.coverage.stopReason).toBe('deadline');
      expect(execution.logicalResult.cards.map(card => card.repositoryKey)).toEqual(['repository-0']);
      expect(execution.logicalResult.repositories['repository-0']).toMatchObject({deepQueried: true, state: 'current'});
    }),
  );

  effectIt.effect('shares one absolute deadline across queued repository waves', () =>
    Effect.gen(function* () {
      const base = makeFixture(20);
      const fixture = {
        ...base,
        graphs: new Map(
          [...base.graphs].map(([repositoryKey, value], index) => [
            repositoryKey,
            index < 8 ? {...value, nodes: []} : value,
          ]),
        ),
      };
      const uncertain = {
        ...fixture,
        router: {
          ...fixture.router,
          uncertainty: {reasons: ['close-repository-scores'], shouldExpand: true, state: 'ambiguous'} as const,
        },
      };
      const delays = new Map(
        uncertain.router.repositories.map(
          (repository, index) => [repository.repositoryKey, index < 8 ? 0 : index < 12 ? 750 : 1_000] as const,
        ),
      );
      const started = Date.now();
      const execution = yield* runCodeGraphWorksetQueryV2Core(dependencies(uncertain, {delays, realClock: true}), {
        ...uncertain.input,
        deadlineMilliseconds: 950,
        evidenceCards: 40,
      }).pipe(TestClock.withLive);

      expect(Date.now() - started).toBeLessThan(1_250);
      expect(execution.logicalResult.coverage.stopReason).toBe('deadline');
      expect(execution.logicalResult.cards.map(card => card.repositoryKey)).toEqual(
        uncertain.router.repositories.slice(8, 12).map(repository => repository.repositoryKey),
      );
      expect(execution.instrumentation.deepQueriedRepositories).toBe(16);
      for (const repository of uncertain.router.repositories.slice(16, 20)) {
        expect(execution.logicalResult.repositories[repository.repositoryKey]?.deepQueried).toBe(false);
      }
    }),
  );

  effectIt.effect('validates a second repository batch when routing remains uncertain despite enough cards', () =>
    Effect.gen(function* () {
      const fixture = makeFixture(20);
      const uncertain = {
        ...fixture,
        router: {
          ...fixture.router,
          uncertainty: {reasons: ['close-repository-scores'], shouldExpand: true, state: 'ambiguous'} as const,
        },
      };
      const execution = yield* runCodeGraphWorksetQueryV2Core(dependencies(uncertain), {
        ...uncertain.input,
        evidenceCards: 40,
      });

      expect(execution.instrumentation.expansionBatches).toBe(2);
      expect(execution.instrumentation.deepQueriedRepositories).toBe(8);
      expect(execution.logicalResult.coverage.stopReason).toBe('work-budget');
      expect(execution.logicalResult.warnings).toContain(
        'The workset query stopped after its bounded ambiguity-validation work budget.',
      );
    }),
  );

  effectIt.effect('stops a confident catalog route after the first batch yields validated evidence', () =>
    Effect.gen(function* () {
      const fixture = makeFixture(12);
      const execution = yield* runCodeGraphWorksetQueryV2Core(dependencies(fixture), {
        ...fixture.input,
        evidenceCards: 40,
      });

      expect(execution.instrumentation.deepQueriedRepositories).toBe(4);
      expect(execution.instrumentation.expansionBatches).toBe(1);
      expect(execution.logicalResult.coverage.stopReason).toBe('sufficient-evidence');
    }),
  );

  effectIt.effect('defaults to a 40-card logical sequence independently of the compact response projection', () =>
    Effect.gen(function* () {
      const fixture = makeFixture(32);
      const expanded = withNodesPerGraph(fixture, 12);
      const {evidenceCards: _evidenceCards, ...input} = fixture.input;
      const execution = yield* runCodeGraphWorksetQueryV2Core(dependencies(expanded), input);

      expect(execution.logicalResult.cards).toHaveLength(40);
      expect(execution.instrumentation.cards).toBe(40);
      expect(execution.logicalResult.coverage.stopReason).toBe('result-budget');
      expect(execution.projected.structuredContent.output).toMatchObject({
        totalCards: 40,
        truncated: true,
      });
      expect(execution.projected.measurement.estimatedTokens).toBeLessThanOrEqual(1_250);
      expect(execution.projected.structuredContent.cards.length).toBeLessThan(40);
      expect(execution.projected.structuredContent.continuation).toBeDefined();
    }),
  );

  effectIt.effect.prop(
    'preserves the ranked prefix when the logical evidence budget increases',
    {budgets: fc.tuple(fc.integer({min: 1, max: 48}), fc.integer({min: 1, max: 48}))},
    ({budgets: [leftBudget, rightBudget]}) =>
      Effect.gen(function* () {
        const fixture = withNodesPerGraph(makeFixture(32), 12);
        const smallerBudget = Math.min(leftBudget, rightBudget);
        const largerBudget = Math.max(leftBudget, rightBudget);
        const smaller = yield* runCodeGraphWorksetQueryV2Core(dependencies(fixture), {
          ...fixture.input,
          evidenceCards: smallerBudget,
        });
        const larger = yield* runCodeGraphWorksetQueryV2Core(dependencies(fixture), {
          ...fixture.input,
          evidenceCards: largerBudget,
        });

        expect(larger.logicalResult.cards.slice(0, smaller.logicalResult.cards.length)).toEqual(
          smaller.logicalResult.cards,
        );
        expect(larger.instrumentation.deepQueriedRepositories).toBe(smaller.instrumentation.deepQueriedRepositories);
      }),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect('keeps a bridge endpoint stable when a larger budget also admits its local card', () =>
    Effect.gen(function* () {
      const base = withNodesPerGraph(makeFixture(4), 32);
      const bridge = protobufBridge(base.input.published);
      const graph = base.graphs.get('repository-0')!;
      const fixture = {
        ...base,
        graphs: new Map(base.graphs).set('repository-0', {
          ...graph,
          nodes: [
            ...graph.nodes,
            {
              ...graph.nodes[0]!,
              id: protobufBridgeNodeId(0),
              language: 'protobuf',
              name: 'session.proto',
              path: 'proto/repository-0.proto',
              qualifiedName: 'fixture/session/v1/session.proto',
              score: 0.1,
            },
          ],
        }),
      };
      const bridgeExpansion = {
        bridgeSet: {
          digest: digest('bridge-set'),
          generationId: fixture.input.published.id,
          totalBridges: 1,
        },
        bridges: [bridge],
        complete: true,
        seededRepositories: 1,
        warnings: [],
      };
      const smaller = yield* runCodeGraphWorksetQueryV2Core(dependencies(fixture, {bridgeExpansion}), {
        ...fixture.input,
        evidenceCards: 24,
      });
      const larger = yield* runCodeGraphWorksetQueryV2Core(dependencies(fixture, {bridgeExpansion}), {
        ...fixture.input,
        evidenceCards: 40,
      });

      expect(larger.logicalResult.cards.slice(0, smaller.logicalResult.cards.length)).toEqual(
        smaller.logicalResult.cards,
      );
      expect(smaller.logicalResult.cards.map(card => card.ref)).toContain(
        bridge.source.reference.kind === 'qualified-ref' ? bridge.source.reference.ref : '',
      );
    }),
  );

  effectIt.effect('keeps bridge relationship ownership stable when the source enters after a top-ranked target', () =>
    Effect.gen(function* () {
      const fixture = makeFixture(2);
      const bridge = protobufBridge(fixture.input.published, 1, 0);
      const bridgeExpansion = {
        bridgeSet: {
          digest: digest('reverse-bridge-set'),
          generationId: fixture.input.published.id,
          totalBridges: 1,
        },
        bridges: [bridge],
        complete: true,
        seededRepositories: 1,
        warnings: [],
      };
      const smaller = yield* runCodeGraphWorksetQueryV2Core(dependencies(fixture, {bridgeExpansion}), {
        ...fixture.input,
        evidenceCards: 1,
      });
      const larger = yield* runCodeGraphWorksetQueryV2Core(dependencies(fixture, {bridgeExpansion}), {
        ...fixture.input,
        evidenceCards: 2,
      });

      expect(larger.logicalResult.cards.slice(0, 1)).toEqual(smaller.logicalResult.cards);
      expect(smaller.logicalResult.cards[0]?.relationships).toEqual([]);
      expect(larger.logicalResult.cards[1]?.relationships).toHaveLength(1);
    }),
  );

  effectIt.effect.prop(
    'is invariant to bounded asynchronous repository completion order',
    {completionOrder: fc.shuffledSubarray([0, 1, 2, 3], {minLength: 4, maxLength: 4})},
    ({completionOrder}) =>
      Effect.gen(function* () {
        const fixture = makeFixture(4);
        const delays = new Map(completionOrder.map((repository, index) => [`repository-${repository}`, index]));
        const forward = yield* runCodeGraphWorksetQueryV2Core(dependencies(fixture), fixture.input);
        const reordered = yield* runCodeGraphWorksetQueryV2Core(dependencies(fixture, {delays}), fixture.input).pipe(
          TestClock.withLive,
        );
        expect(reordered.logicalResult).toEqual(forward.logicalResult);
      }),
    {fastCheck: {numRuns: 30}},
  );

  effectIt.effect(
    'expands a routed repository through an exact protobuf bridge and returns the dual-sided contract',
    () =>
      Effect.gen(function* () {
        const fixture = makeFixture(2);
        const bridge = protobufBridge(fixture.input.published);
        const firstRepository = fixture.router.repositories[0]!;
        const routed = {
          ...fixture,
          input: {...fixture.input, evidenceCards: 4},
          router: {
            ...fixture.router,
            expansion: {exhausted: true, repositories: [firstRepository], requestedBatchSize: 4},
            repositories: [firstRepository],
            symbols: fixture.router.symbols.filter(
              symbol => symbol.symbol.repositoryKey === firstRepository.repositoryKey,
            ),
          },
        };
        const execution = yield* runCodeGraphWorksetQueryV2Core(
          dependencies(routed, {
            bridgeExpansion: {
              bridgeSet: {
                digest: digest('bridge-set'),
                generationId: fixture.input.published.id,
                totalBridges: 1,
              },
              bridges: [bridge],
              complete: true,
              seededRepositories: 1,
              warnings: [],
            },
          }),
          routed.input,
        );

        expect(execution.instrumentation).toMatchObject({
          bridgeEdgesConsidered: 1,
          bridgeExpandedRepositories: 1,
          bridgeExpansionComplete: true,
          deepQueriedRepositories: 2,
        });
        expect([...new Set(execution.logicalResult.cards.map(card => card.repositoryKey))]).toEqual([
          'repository-0',
          'repository-1',
        ]);
        expect(
          execution.logicalResult.cards
            .filter(card => card.symbol.language === 'protobuf')
            .map(card => ({name: card.symbol.name, path: card.symbol.path})),
        ).toEqual([
          {name: 'session.proto', path: 'proto/repository-0.proto'},
          {name: 'session.proto', path: 'proto/repository-1.proto'},
        ]);
        expect(execution.logicalResult.cards.flatMap(card => card.relationships)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              authority: 'authoritative',
              provenance: 'declared',
              relation: 'imports',
              source: {
                ref: bridge.source.reference.kind === 'qualified-ref' ? bridge.source.reference.ref : '',
                repositoryKey: 'repository-0',
              },
              target: {
                ref: bridge.target.reference.kind === 'qualified-ref' ? bridge.target.reference.ref : '',
                repositoryKey: 'repository-1',
              },
            }),
          ]),
        );
      }),
  );

  it('promotes an existing low-ranked contract neighbor directly after its strongest seed', () => {
    const fixture = makeFixture(20);
    const bridge = protobufBridge(fixture.input.published, 0, 19);
    const expanded = expandCodeGraphWorksetRouterWithBridges(fixture.router, fixture.input.published, {
      bridgeSet: {
        digest: digest('bridge-set'),
        generationId: fixture.input.published.id,
        totalBridges: 1,
      },
      bridges: [bridge],
      complete: true,
      seededRepositories: 16,
      warnings: [],
    });

    expect(expanded.repositories.slice(0, 3).map(repository => repository.repositoryKey)).toEqual([
      'repository-0',
      'repository-19',
      'repository-1',
    ]);
    expect(expanded.repositories.slice(0, 3).map(repository => repository.rank)).toEqual([1, 2, 3]);
  });
});

interface Fixture {
  readonly graphs: ReadonlyMap<string, CodeGraphQueryResult>;
  readonly input: CodeGraphWorksetQueryV2InputV1;
  readonly router: CodeGraphWorksetRouterResultV1;
}

function dependencies(
  fixture: Fixture,
  options: {
    readonly bridgeExpansion?: {
      readonly bridgeSet?: {readonly digest: string; readonly generationId: string; readonly totalBridges: number};
      readonly bridges: readonly CodeGraphCrossRepositoryBridgeV1[];
      readonly complete: boolean;
      readonly seededRepositories: number;
      readonly warnings: readonly string[];
    };
    readonly delays?: ReadonlyMap<string, number>;
    readonly failRepositoryKey?: string;
    readonly persistRefs?: (refs: readonly {readonly nodeId: string; readonly repositoryId: string}[]) => void;
    readonly realClock?: boolean;
  } = {},
) {
  return {
    deepQuery: (repository: {readonly repositoryKey: string}) => {
      if (repository.repositoryKey === options.failRepositoryKey) return Effect.fail('bounded failure');
      const graph = fixture.graphs.get(repository.repositoryKey)!;
      const delay = options.delays?.get(repository.repositoryKey) ?? 0;
      return delay === 0 ? Effect.succeed(graph) : Effect.sleep(delay).pipe(Effect.as(graph));
    },
    nowMilliseconds: options.realClock ? Effect.sync(() => Date.now()) : Effect.succeed(0),
    persist: (result: {readonly cards: readonly unknown[]}, refs: readonly {nodeId: string; repositoryId: string}[]) =>
      Effect.sync(() => {
        options.persistRefs?.(refs);
        return {
          cardCount: result.cards.length,
          continuationForOffset: (offset: number) => `cgwc_${digest(`cursor-${offset}`).slice(0, 40)}`,
          createdAt: '2026-08-11T00:00:00.000Z',
          expiresAt: '2026-08-11T00:30:00.000Z',
          generation: fixture.input.published,
          id: `cgwrs_${'a'.repeat(40)}`,
          initialCursor: `cgwc_${'b'.repeat(40)}`,
          projectorVersion: 1,
          totalBytes: 1,
          worksetName: fixture.input.worksetName,
        };
      }),
    readBridgeExpansion: () =>
      Effect.succeed(options.bridgeExpansion ?? {bridges: [], complete: true, seededRepositories: 0, warnings: []}),
    route: Effect.succeed(fixture.router),
  };
}

function makeFixture(size: number): Fixture {
  const query = normalizeCodeGraphWorksetRouterQuery('service');
  const symbols = Array.from({length: size}, (_, repository) => routingSymbol(repository));
  const ranked = rankCodeGraphWorksetRouterCandidates({
    exactHits: [],
    lexicalHits: symbols.map((symbol, index) => ({catalogRank: index + 1, symbol})),
    limits: {repositoryLimit: 32, symbolLimit: 32, symbolsPerRepository: 4},
    query,
  });
  const published = generation(size);
  const router: CodeGraphWorksetRouterResultV1 = {
    coverage: {
      consideredMemberCount: size,
      eligibleMemberCount: size,
      source: 'catalog-index',
      state: 'complete',
    },
    expansion: ranked.expansion,
    generationId: published.id,
    query,
    repositories: ranked.repositories,
    retrieval: {
      candidateLimitPerLane: 128,
      exactHits: 0,
      exactLaneExhausted: true,
      lexicalHits: size,
      lexicalLaneExhausted: true,
    },
    symbols: ranked.symbols,
    uncertainty: {reasons: [], shouldExpand: false, state: 'confident'},
    version: 1,
    worksetName: 'fixture',
  };
  const graphs = new Map(
    Array.from({length: size}, (_, repository) => [`repository-${repository}`, graph(repository)]),
  );
  const input: CodeGraphWorksetQueryV2InputV1 = {
    evidenceCards: 2,
    members: published.members.map(member => ({
      deepQueryEligible: true,
      published: member,
      receipt: {
        considered: true,
        deepQueried: false,
        repositoryId: member.repositoryId,
        snapshot: {
          checkoutId: member.checkoutId,
          commit: member.commitId,
          digest: member.snapshotDigest,
          dirty: false,
          freshness: 'current',
          id: member.snapshotId,
          projectionDigest: member.projectionDigest,
          provenance: 'ready-snapshot',
          worktreeId: member.worktreeId,
        },
        state: 'current',
      },
      repositoryKey: member.repositoryKey,
    })),
    published,
    query: 'service',
    worksetName: 'fixture',
  };
  return {graphs, input, router};
}

function withNodesPerGraph(fixture: Fixture, nodesPerGraph: number): Fixture {
  return {
    ...fixture,
    graphs: new Map(
      [...fixture.graphs].map(([repositoryKey, graph], index) => [
        repositoryKey,
        {
          ...graph,
          nodes: [
            ...graph.nodes,
            ...Array.from({length: nodesPerGraph - graph.nodes.length}, (_, offset) => ({
              ...graph.nodes[0]!,
              id: `cgs_${digest(`secondary-node-${index}-${offset}`).slice(0, 32)}`,
              name: `SecondaryService${index}_${offset}`,
              path: `src/secondary-service-${index}-${offset}.ts`,
              qualifiedName: `fixture.SecondaryService${index}_${offset}`,
              score: 0.5 - offset / 100,
            })),
          ],
        },
      ]),
    ),
  };
}

function generation(size: number): CodeGraphWorksetCatalogPublishedGenerationV1 {
  const generationDigest = digest('generation');
  return {
    digest: generationDigest,
    id: `cgwg_${generationDigest.slice(0, 40)}`,
    manifestDigest: digest('manifest'),
    members: Array.from({length: size}, (_, repository) => ({
      checkoutId: digest(`checkout-${repository}`),
      commitId: digest(`commit-${repository}`).slice(0, 40),
      ordinal: repository,
      projectionDigest: digest(`projection-${repository}`),
      repositoryId: digest(`repository-${repository}`),
      repositoryKey: `repository-${repository}`,
      snapshotDigest: digest(`snapshot-digest-${repository}`),
      snapshotId: `cgsn_${digest(`snapshot-${repository}`).slice(0, 40)}`,
      symbolCount: 1,
      worktreeId: digest(`worktree-${repository}`),
    })),
    worksetName: 'fixture',
  };
}

function graph(repository: number): CodeGraphQueryResult {
  const value = node(repository);
  return {
    edges: [],
    freshness: 'current',
    nodes: [value],
    operation: 'query',
    repository: {displayName: `repository-${repository}`, repositoryId: digest(`repository-${repository}`)},
    snapshot: {
      commit: digest(`commit-${repository}`).slice(0, 40),
      dirty: false,
      id: `cgsn_${digest(`snapshot-${repository}`).slice(0, 40)}`,
      worktreeId: digest(`worktree-${repository}`),
    },
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    version: 1,
    warnings: [],
  };
}

function node(repository: number): CodeGraphQueryNode {
  return {
    contentHash: digest(`content-${repository}`),
    exported: true,
    id: `cgs_${digest(`node-${repository}`).slice(0, 32)}`,
    kind: 'function',
    language: 'typescript',
    name: `Service${repository}`,
    packageName: `@fixture/repository-${repository}`,
    path: `src/service-${repository}.ts`,
    qualifiedName: `fixture.Service${repository}`,
    score: 1 - repository / 1_000,
    span: {column: 1, endColumn: 8, endLine: repository + 1, line: repository + 1},
  };
}

function protobufBridge(
  published: CodeGraphWorksetCatalogPublishedGenerationV1,
  sourceIndex = 0,
  targetIndex = 1,
): CodeGraphCrossRepositoryBridgeV1 {
  const source = published.members[sourceIndex]!;
  const target = published.members[targetIndex]!;
  const moniker = (role: 'import' | 'export', repository: number) =>
    codeGraphProtobufMoniker({
      evidence: {
        path: `proto/repository-${repository}.proto`,
        span: {column: 1, endColumn: 16, endLine: 2, line: 2},
      },
      importPath: 'fixture/session/v1/session.proto',
      kind: 'file',
      role,
      symbolId: protobufBridgeNodeId(repository),
    });
  return resolveCodeGraphCrossRepositoryBridges([
    {
      monikers: [moniker('import', sourceIndex)],
      repositoryId: source.repositoryId,
      repositoryKey: source.repositoryKey,
      snapshotId: source.snapshotId,
    },
    {
      monikers: [moniker('export', targetIndex)],
      repositoryId: target.repositoryId,
      repositoryKey: target.repositoryKey,
      snapshotId: target.snapshotId,
    },
  ]).bridges[0]!;
}

function protobufBridgeNodeId(repository: number): string {
  return `cgs_${digest(`protobuf-file-${repository}`).slice(0, 32)}`;
}

function routingSymbol(repository: number): CodeGraphWorksetCatalogRoutingSymbolRecordV1 {
  const value = node(repository);
  return {
    exported: value.exported,
    kind: value.kind,
    language: value.language,
    lookupKeys: [value.name],
    name: value.name,
    nodeId: value.id,
    ordinal: repository,
    packageName: value.packageName,
    path: value.path,
    projectionDigest: digest(`projection-${repository}`),
    qualifiedName: value.qualifiedName,
    repositoryId: digest(`repository-${repository}`),
    repositoryKey: `repository-${repository}`,
    snapshotId: `cgsn_${digest(`snapshot-${repository}`).slice(0, 40)}`,
    span: value.span,
    terms: [{term: 'service', weight: 1}],
  };
}

function digest(value: string): string {
  return sha256HexSync(value);
}
