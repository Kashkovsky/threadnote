import fc from 'fast-check';
import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {
  CODE_GRAPH_WORKSET_ROUTER_LIMITS,
  CodeGraphWorksetRouterError,
  codeGraphWorksetRouterExactMatches,
  normalizeCodeGraphWorksetRouterQuery,
  rankCodeGraphWorksetRouterCandidates,
  routeCodeGraphWorksetCatalogCandidates,
  type CodeGraphWorksetCatalogCandidatePageV1,
  type CodeGraphWorksetCatalogCandidateSourceV1,
} from '../../src/code_graph/workset_router.js';
import type {
  CodeGraphWorksetCatalogPublishedGenerationV1,
  CodeGraphWorksetCatalogRoutingSymbolRecordV1,
} from '../../src/code_graph/workset_catalog/types.js';

describe('code graph workset router', () => {
  it('gives exact identities a versioned, inspectable score advantage', () => {
    const query = normalizeCodeGraphWorksetRouterQuery('TargetSymbol');
    const exact = symbol(1, 0, {name: 'TargetSymbol', terms: [{term: 'target symbol', weight: 2}]});
    const lexical = symbol(2, 0, {name: 'NearbySymbol', terms: [{term: 'target symbol', weight: 20}]});
    const ranked = rankCodeGraphWorksetRouterCandidates({
      exactHits: [{catalogRank: 1, symbol: exact}],
      lexicalHits: [{catalogRank: 1, symbol: lexical}],
      query,
    });

    expect(ranked.symbols[0]?.symbol.nodeId).toBe(exact.nodeId);
    expect(ranked.symbols[0]?.exactMatches).toContain('name');
    expect(ranked.symbols[0]?.scoreReceipt).toMatchObject({total: ranked.symbols[0]?.score, version: 1});
    expect(ranked.symbols[0]?.scoreReceipt.signals).toEqual(
      expect.arrayContaining([expect.objectContaining({feature: 'exact-name', contribution: 1_100})]),
    );
    expect(ranked.repositories[0]?.scoreReceipt.total).toBe(ranked.repositories[0]?.score);
  });

  it('recognizes exact lookup, qualified, package, and path routing fields without a DSL', () => {
    const candidate = symbol(1, 0, {
      lookupKeys: ['contract.UserService'],
      packageName: '@fixture/contracts',
      path: 'src/contracts/user-service.ts',
      qualifiedName: 'contracts.UserService',
    });

    expect(
      codeGraphWorksetRouterExactMatches(normalizeCodeGraphWorksetRouterQuery('contract.UserService'), candidate),
    ).toEqual(['lookup-key']);
    expect(
      codeGraphWorksetRouterExactMatches(normalizeCodeGraphWorksetRouterQuery('contracts.UserService'), candidate),
    ).toEqual(['qualified-name']);
    expect(
      codeGraphWorksetRouterExactMatches(normalizeCodeGraphWorksetRouterQuery('@fixture/contracts'), candidate),
    ).toEqual(['package']);
    expect(
      codeGraphWorksetRouterExactMatches(
        normalizeCodeGraphWorksetRouterQuery('src/contracts/user-service.ts'),
        candidate,
      ),
    ).toEqual(['path']);
    expect(
      codeGraphWorksetRouterExactMatches(normalizeCodeGraphWorksetRouterQuery('contracts/user-service.ts'), candidate),
    ).toEqual(['path-suffix']);
  });

  it('keeps the lexical projection of plain task text token-bounded', () => {
    const query = normalizeCodeGraphWorksetRouterQuery(
      `${'oversized'.repeat(40)} ${Array.from({length: 40}, (_, index) => `term${index}`).join(' ')}`,
    );

    expect(query.terms).toHaveLength(CODE_GRAPH_WORKSET_ROUTER_LIMITS.queryTokensMaximum);
    expect(
      query.terms.every(
        term => Buffer.byteLength(term, 'utf8') <= CODE_GRAPH_WORKSET_ROUTER_LIMITS.queryTermBytesMaximum,
      ),
    ).toBe(true);
    expect(query.termsTruncated).toBe(true);
  });

  it('reserves the first result pass for repository diversity before global fill', () => {
    const query = normalizeCodeGraphWorksetRouterQuery('service');
    const hits = [
      {catalogRank: 1, symbol: symbol(1, 0)},
      {catalogRank: 2, symbol: symbol(2, 0)},
      {catalogRank: 3, symbol: symbol(3, 0)},
      {catalogRank: 4, symbol: symbol(4, 1)},
      {catalogRank: 5, symbol: symbol(5, 2)},
    ];
    const ranked = rankCodeGraphWorksetRouterCandidates({
      exactHits: [],
      lexicalHits: hits,
      limits: {diversityRepositoryLimit: 3, symbolLimit: 4, symbolsPerRepository: 3},
      query,
    });

    expect(ranked.symbols.slice(0, 3).map(entry => entry.symbol.repositoryKey)).toEqual([
      'repository-0',
      'repository-1',
      'repository-2',
    ]);
    expect(ranked.symbols.slice(0, 3).every(entry => entry.selectionReason === 'repository-diversity')).toBe(true);
    expect(ranked.symbols[3]?.symbol.repositoryKey).toBe('repository-0');
    expect(ranked.symbols[3]?.selectionReason).toBe('global-score');
  });

  it('keeps ranking, fairness, and output bounds independent of candidate input order', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({min: 0, max: 200}), {maxLength: 50}), seeds => {
        const query = normalizeCodeGraphWorksetRouterQuery('service');
        const hits = seeds.map(seed => ({catalogRank: seed + 1, symbol: symbol(seed + 20, seed % 11)}));
        const limits = {
          candidateLimitPerLane: 64,
          diversityRepositoryLimit: 5,
          repositoryLimit: 10,
          symbolLimit: 17,
          symbolsPerRepository: 3,
        } as const;
        const forward = rankCodeGraphWorksetRouterCandidates({exactHits: [], lexicalHits: hits, limits, query});
        const reversed = rankCodeGraphWorksetRouterCandidates({
          exactHits: [],
          lexicalHits: [...hits].reverse(),
          limits,
          query,
        });

        expect(reversed).toEqual(forward);
        expect(forward.repositories.length).toBeLessThanOrEqual(limits.repositoryLimit);
        expect(forward.symbols.length).toBeLessThanOrEqual(limits.symbolLimit);
        const counts = new Map<string, number>();
        for (const candidate of forward.symbols) {
          counts.set(candidate.symbol.repositoryKey, (counts.get(candidate.symbol.repositoryKey) ?? 0) + 1);
        }
        expect(Math.max(0, ...counts.values())).toBeLessThanOrEqual(limits.symbolsPerRepository);
      }),
      {numRuns: 150},
    );
  });

  it('uses bounded indexed source requests and wraps lane keysets in an opaque stable continuation', async () => {
    const published = generation(2);
    let exactCalls = 0;
    let lexicalCalls = 0;
    const exactRequests: string[] = [];
    const fairnessBounds: number[] = [];
    const source: CodeGraphWorksetCatalogCandidateSourceV1 = {
      mode: 'catalog-index',
      readExactCandidates: request => {
        exactCalls += 1;
        exactRequests.push(request.after ?? '<start>');
        fairnessBounds.push(request.maximumHitsPerMember);
        return Effect.succeed(
          exactCalls === 1
            ? page('exact', published, [{catalogRank: 1, symbol: symbol(1, 0)}], 'exact-next')
            : page('exact', published, []),
        );
      },
      readGeneration: () => Effect.succeed(published),
      readLexicalCandidates: () => {
        lexicalCalls += 1;
        return Effect.succeed(page('lexical', published, []));
      },
    };
    const request = {
      limits: {candidateLimitPerLane: 2},
      query: 'symbol-1',
      worksetName: published.worksetName,
    } as const;
    const first = await Effect.runPromise(routeCodeGraphWorksetCatalogCandidates(source, request));

    expect(first.continuation).toMatch(/^cgwr_[A-Za-z0-9_-]+$/u);
    expect(first.continuation).not.toContain('exact-next');
    expect(first.retrieval).toMatchObject({candidateLimitPerLane: 2, exactHits: 1, lexicalHits: 0});
    expect(first.coverage).toEqual({
      consideredMemberCount: 2,
      eligibleMemberCount: 2,
      source: 'catalog-index',
      state: 'complete',
    });

    const second = await Effect.runPromise(
      routeCodeGraphWorksetCatalogCandidates(source, {...request, cursor: first.continuation}),
    );
    expect(second.continuation).toBeUndefined();
    expect(exactRequests).toEqual(['<start>', 'exact-next']);
    expect(fairnessBounds).toEqual([2, 2]);
    expect(exactCalls).toBe(2);
    expect(lexicalCalls).toBe(1);

    await expect(
      Effect.runPromise(
        routeCodeGraphWorksetCatalogCandidates(source, {
          ...request,
          cursor: first.continuation,
          query: 'different query',
        }),
      ),
    ).rejects.toMatchObject({reason: 'stale-cursor'} satisfies Partial<CodeGraphWorksetRouterError>);

    await expect(
      Effect.runPromise(
        routeCodeGraphWorksetCatalogCandidates(source, {
          ...request,
          cursor: first.continuation,
          limits: {candidateLimitPerLane: 3},
        }),
      ),
    ).rejects.toMatchObject({reason: 'stale-cursor'} satisfies Partial<CodeGraphWorksetRouterError>);
  });

  it('allows explicit partial coverage only from an in-memory test source', async () => {
    const published = generation(2);
    let lexicalCalls = 0;
    const partialPage = (lane: 'exact' | 'lexical') =>
      page(lane, published, [], undefined, {consideredMemberCount: 1, eligibleMemberCount: 2, state: 'partial'});
    const inMemory: CodeGraphWorksetCatalogCandidateSourceV1 = {
      mode: 'in-memory-test',
      readExactCandidates: () => Effect.succeed(partialPage('exact')),
      readGeneration: () => Effect.succeed(published),
      readLexicalCandidates: () => {
        lexicalCalls += 1;
        return Effect.succeed(
          lexicalCalls === 1
            ? page('lexical', published, [{catalogRank: 1, symbol: symbol(1, 0)}], 'partial-next', {
                consideredMemberCount: 1,
                eligibleMemberCount: 2,
                state: 'partial',
              })
            : partialPage('lexical'),
        );
      },
    };
    const request = {query: 'service', worksetName: published.worksetName};

    const first = await Effect.runPromise(routeCodeGraphWorksetCatalogCandidates(inMemory, request));
    expect(first).toMatchObject({
      coverage: {consideredMemberCount: 1, source: 'in-memory-test', state: 'partial'},
      uncertainty: {state: 'partial'},
    });
    expect(first.continuation).toBeDefined();
    expect(
      await Effect.runPromise(
        routeCodeGraphWorksetCatalogCandidates(inMemory, {...request, cursor: first.continuation}),
      ),
    ).toMatchObject({
      coverage: {consideredMemberCount: 1, source: 'in-memory-test', state: 'partial'},
      uncertainty: {state: 'partial'},
    });

    const production = {
      ...inMemory,
      mode: 'catalog-index' as const,
      readLexicalCandidates: () => Effect.succeed(partialPage('lexical')),
    };
    await expect(Effect.runPromise(routeCodeGraphWorksetCatalogCandidates(production, request))).rejects.toMatchObject({
      reason: 'source-contract',
    } satisfies Partial<CodeGraphWorksetRouterError>);
  });

  it('rejects source pages that exceed the requested candidate bound', async () => {
    const published = generation(3);
    const oversized = Array.from({length: 3}, (_, index) => ({
      catalogRank: index + 1,
      symbol: symbol(index + 1, index),
    }));
    const source: CodeGraphWorksetCatalogCandidateSourceV1 = {
      mode: 'catalog-index',
      readExactCandidates: () => Effect.succeed(page('exact', published, [])),
      readGeneration: () => Effect.succeed(published),
      readLexicalCandidates: () => Effect.succeed(page('lexical', published, oversized)),
    };

    await expect(
      Effect.runPromise(
        routeCodeGraphWorksetCatalogCandidates(source, {
          limits: {candidateLimitPerLane: 2},
          query: 'service',
          worksetName: published.worksetName,
        }),
      ),
    ).rejects.toMatchObject({reason: 'source-contract'} satisfies Partial<CodeGraphWorksetRouterError>);
  });

  it('keeps public hard bounds conservative', () => {
    expect(CODE_GRAPH_WORKSET_ROUTER_LIMITS.candidateLimitPerLaneDefault).toBeLessThanOrEqual(
      CODE_GRAPH_WORKSET_ROUTER_LIMITS.candidateLimitPerLaneMaximum,
    );
    expect(CODE_GRAPH_WORKSET_ROUTER_LIMITS.symbolLimitDefault).toBeLessThanOrEqual(
      CODE_GRAPH_WORKSET_ROUTER_LIMITS.symbolLimitMaximum,
    );
  });
});

function page(
  lane: 'exact' | 'lexical',
  published: CodeGraphWorksetCatalogPublishedGenerationV1,
  hits: CodeGraphWorksetCatalogCandidatePageV1['hits'],
  next?: string,
  coverage: CodeGraphWorksetCatalogCandidatePageV1['coverage'] = {
    consideredMemberCount: published.members.length,
    eligibleMemberCount: published.members.length,
    state: 'complete',
  },
): CodeGraphWorksetCatalogCandidatePageV1 {
  return {
    coverage,
    generationId: published.id,
    hits,
    lane,
    ...(next === undefined ? {} : {next}),
  };
}

function generation(memberCount: number): CodeGraphWorksetCatalogPublishedGenerationV1 {
  return {
    digest: digest('generation'),
    id: `cgwg_${digest('generation-id').slice(0, 40)}`,
    manifestDigest: digest('manifest'),
    members: Array.from({length: memberCount}, (_, repository) => {
      const entry = symbol(repository + 1, repository);
      return {
        checkoutId: digest(`checkout-${repository}`),
        commitId: digest(`commit-${repository}`).slice(0, 40),
        ordinal: repository,
        projectionDigest: entry.projectionDigest,
        repositoryId: entry.repositoryId,
        repositoryKey: entry.repositoryKey,
        snapshotDigest: digest(`snapshot-digest-${repository}`),
        snapshotId: entry.snapshotId,
        symbolCount: 10,
        worktreeId: digest(`worktree-${repository}`),
      };
    }),
    worksetName: 'engineering',
  };
}

function symbol(
  seed: number,
  repository: number,
  overrides: Partial<CodeGraphWorksetCatalogRoutingSymbolRecordV1> = {},
): CodeGraphWorksetCatalogRoutingSymbolRecordV1 {
  return {
    exported: true,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [`symbol-${seed}`],
    name: `symbol-${seed}`,
    nodeId: `cgs_${digest(`node-${seed}`).slice(0, 40)}`,
    ordinal: repository,
    packageName: `@fixture/repository-${repository}`,
    path: `src/service-${seed}.ts`,
    projectionDigest: digest(`projection-${repository}`),
    qualifiedName: `fixture.repository${repository}.symbol${seed}`,
    repositoryId: digest(`repository-${repository}`),
    repositoryKey: `repository-${repository}`,
    snapshotId: `cgsn_${digest(`snapshot-${repository}`).slice(0, 40)}`,
    span: {column: 1, endColumn: 10, endLine: seed + 1, line: seed + 1},
    terms: [{term: 'service', weight: 1}],
    ...overrides,
  };
}

function digest(value: string): string {
  return sha256HexSync(value);
}
