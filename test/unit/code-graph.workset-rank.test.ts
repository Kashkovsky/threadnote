import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {rankCodeGraphWorksetEvidenceCards} from '../../src/code_graph/workset_rank.js';
import {
  normalizeCodeGraphWorksetRouterQuery,
  rankCodeGraphWorksetRouterCandidates,
} from '../../src/code_graph/workset_router.js';
import type {CodeGraphQueryNode, CodeGraphQueryResult} from '../../src/code_graph/types.js';
import type {CodeGraphWorksetCatalogRoutingSymbolRecordV1} from '../../src/code_graph/workset_catalog/types.js';

describe('code graph workset global evidence ranking', () => {
  it('keeps same-name symbols distinct across repository identities and qualifies local relationships', () => {
    const fixture = routerFixture([0, 1]);
    const first = graph('repository-0', 0, [node(0, 'SharedName')], true);
    const second = graph('repository-1', 1, [node(1, 'SharedName')]);
    const cards = rankCodeGraphWorksetEvidenceCards({
      repositories: [first, second],
      router: fixture,
    });

    expect(cards).toHaveLength(2);
    expect(new Set(cards.map(card => card.ref)).size).toBe(2);
    expect(cards.map(card => card.repositoryKey).sort()).toEqual(['repository-0', 'repository-1']);
    expect(cards.find(card => card.repositoryKey === 'repository-0')?.relationships[0]).toMatchObject({
      authority: 'authoritative',
      evidence: {repositoryKey: 'repository-0'},
    });
  });

  it('is invariant to repository completion order and duplicate local-node order', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({min: 0, max: 15}), {minLength: 1, maxLength: 12}), seeds => {
        const repositories = [...new Set(seeds.map(seed => seed % 4))];
        const fixture = routerFixture(repositories);
        const deep = repositories.map(repository => {
          const nodes = seeds.filter(seed => seed % 4 === repository).map(seed => node(seed, `Service${seed}`));
          return graph(`repository-${repository}`, repository, [...nodes, ...nodes].reverse());
        });
        const forward = rankCodeGraphWorksetEvidenceCards({repositories: deep, router: fixture});
        const reversed = rankCodeGraphWorksetEvidenceCards({repositories: [...deep].reverse(), router: fixture});

        expect(reversed).toEqual(forward);
        expect(new Set(forward.map(card => card.id)).size).toBe(forward.length);
      }),
      {numRuns: 100},
    );
  });

  it('places one strong card per routed repository before repeated local matches', () => {
    const fixture = routerFixture([0, 1, 2]);
    const cards = rankCodeGraphWorksetEvidenceCards({
      repositories: [
        graph('repository-0', 0, [node(0, 'FirstA'), node(4, 'SecondA'), node(8, 'ThirdA')]),
        graph('repository-1', 1, [node(1, 'FirstB'), node(5, 'SecondB')]),
        graph('repository-2', 2, [node(2, 'FirstC')]),
      ],
      router: fixture,
    });

    expect(cards.slice(0, 3).map(card => card.repositoryKey)).toEqual(['repository-0', 'repository-1', 'repository-2']);
    expect(cards.slice(3).map(card => card.repositoryKey)).toContain('repository-0');
  });

  it('bounds the diversity prefix to the initial four-repository batch before global score fill', () => {
    const query = normalizeCodeGraphWorksetRouterQuery('service');
    const exactFirst = {
      ...routingSymbol(0, 0),
      lookupKeys: ['service'],
      name: 'FirstA',
      qualifiedName: 'fixture.FirstA',
    };
    const exactSecond = {
      ...routingSymbol(4, 0),
      lookupKeys: ['service'],
      name: 'SecondA',
      qualifiedName: 'fixture.SecondA',
    };
    const fixture = rankCodeGraphWorksetRouterCandidates({
      exactHits: [
        {catalogRank: 1, symbol: exactFirst},
        {catalogRank: 2, symbol: exactSecond},
      ],
      lexicalHits: [1, 2, 3, 4, 5].map((repository, index) => ({
        catalogRank: index + 3,
        symbol: routingSymbol(repository, repository),
      })),
      limits: {repositoryLimit: 32, symbolLimit: 32, symbolsPerRepository: 4},
      query,
    });
    const cards = rankCodeGraphWorksetEvidenceCards({
      repositories: [
        graph('repository-0', 0, [node(0, 'FirstA'), node(4, 'SecondA')]),
        ...[1, 2, 3, 4, 5].map(repository =>
          graph(`repository-${repository}`, repository, [node(repository, `Service${repository}`)]),
        ),
      ],
      router: fixture,
    });

    expect(cards.slice(0, 4).map(card => card.repositoryKey)).toEqual([
      'repository-0',
      'repository-1',
      'repository-2',
      'repository-3',
    ]);
    expect(cards[4]?.repositoryKey).toBe('repository-0');
    expect(cards.slice(0, 5).map(card => card.repositoryKey)).not.toContain('repository-4');
  });

  it('rejects a deep result from a different routed snapshot', () => {
    const fixture = routerFixture([0]);
    const deep = graph('repository-0', 0, [node(0, 'Service')]);
    expect(() =>
      rankCodeGraphWorksetEvidenceCards({
        repositories: [{...deep, graph: {...deep.graph, snapshot: {...deep.graph.snapshot, id: 'different'}}}],
        router: fixture,
      }),
    ).toThrow(/routed snapshot/u);
  });
});

function routerFixture(repositories: readonly number[]) {
  const query = normalizeCodeGraphWorksetRouterQuery('service');
  return rankCodeGraphWorksetRouterCandidates({
    exactHits: [],
    lexicalHits: repositories.map((repository, index) => ({
      catalogRank: index + 1,
      symbol: routingSymbol(repository, repository),
    })),
    limits: {repositoryLimit: 32, symbolLimit: 32, symbolsPerRepository: 4},
    query,
  });
}

function graph(
  repositoryKey: string,
  repository: number,
  nodes: readonly CodeGraphQueryNode[],
  withRelationship = false,
) {
  const repositoryId = digest(`repository-${repository}`);
  const source = nodes[0]!;
  const targetId = `cgs_${digest(`target-${repository}`).slice(0, 32)}`;
  const graph: CodeGraphQueryResult = {
    edges: withRelationship
      ? [
          {
            confidence: 1,
            evidencePath: source.path,
            evidenceSpan: source.span,
            id: `cge_${digest(`edge-${repository}`).slice(0, 32)}`,
            provenance: 'resolved',
            relation: 'calls',
            sourceId: source.id,
            sourceName: source.name,
            targetId,
            targetName: 'target',
          },
        ]
      : [],
    freshness: 'current',
    nodes,
    operation: 'query',
    repository: {displayName: repositoryKey, repositoryId},
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
  return {graph, repositoryKey};
}

function node(seed: number, name: string): CodeGraphQueryNode {
  return {
    contentHash: digest(`content-${seed}`),
    exported: true,
    id: `cgs_${digest(`node-${seed}`).slice(0, 32)}`,
    kind: 'function',
    language: 'typescript',
    name,
    packageName: `@fixture/repository-${seed % 4}`,
    path: `src/service-${seed}.ts`,
    qualifiedName: `fixture.${name}`,
    score: 1 - seed / 1_000,
    span: {column: 1, endColumn: 8, endLine: seed + 1, line: seed + 1},
  };
}

function routingSymbol(seed: number, repository: number): CodeGraphWorksetCatalogRoutingSymbolRecordV1 {
  const value = node(seed, `Service${seed}`);
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
