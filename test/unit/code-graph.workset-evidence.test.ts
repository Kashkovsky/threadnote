import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {
  CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
  codeGraphEvidenceCardId,
  codeGraphQualifiedRefHandle,
  codeGraphWorksetContinuationHandle,
  isCodeGraphQualifiedRefHandle,
  isCodeGraphWorksetContinuationHandle,
  parseCodeGraphWorksetEvidenceProjectionV2,
  parseCodeGraphWorksetQueryResultV2,
  projectCodeGraphWorksetEvidence,
  type CodeGraphEvidenceCardV1,
  type CodeGraphWorksetQueryResultV2,
  type RepositoryEvidenceReceiptV1,
} from '../../src/code_graph/workset_evidence.js';

describe('code graph workset evidence', () => {
  it('strictly parses repository-qualified cards and exact relationship provenance', () => {
    const result = relationshipResult();
    const {snapshot: _snapshot, ...producerWithoutSnapshot} = result.repositories.producer!;

    expect(parseCodeGraphWorksetQueryResultV2(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(() => parseCodeGraphWorksetQueryResultV2({...result, unexpected: true})).toThrow();
    expect(() =>
      parseCodeGraphWorksetQueryResultV2({
        ...result,
        cards: [
          {
            ...result.cards[0]!,
            symbol: {...result.cards[0]!.symbol, documentation: 'source bodies do not belong in evidence cards'},
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseCodeGraphWorksetQueryResultV2({
        ...result,
        cards: [
          {
            ...result.cards[0]!,
            relationships: [{...result.cards[0]!.relationships[0]!, authority: 'supporting'}],
          },
        ],
      }),
    ).toThrow(/authority/u);
    expect(() =>
      parseCodeGraphWorksetQueryResultV2({
        ...result,
        repositories: {
          ...result.repositories,
          producer: producerWithoutSnapshot,
        },
      }),
    ).toThrow(/snapshot provenance/u);
    expect(() =>
      parseCodeGraphWorksetQueryResultV2({
        ...result,
        coverage: {...result.coverage, requestedRepositories: 3},
      }),
    ).toThrow(/state counts/u);
  });

  it('projects the longest ranked prefix within exact structured plus text bytes', () => {
    const result = evidenceResult(24, 180);
    const resultSetToken = digest('projector-result-set');
    const continuationOffsets: number[] = [];
    const continuationForOffset = (offset: number) => {
      continuationOffsets.push(offset);
      return codeGraphWorksetContinuationHandle({
        generationDigest: result.workset.generation.digest,
        offset,
        projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
        resultSetToken,
      });
    };
    const projected = projectCodeGraphWorksetEvidence(result, {
      continuationForOffset,
      maximumEstimatedTokens: 1_500,
    });

    expect(projected.measurement.totalBytes).toBeLessThanOrEqual(4_500);
    expect(projected.measurement.estimatedTokens).toBeLessThanOrEqual(1_500);
    expect(projected.structuredContent.cards.length).toBeGreaterThan(0);
    expect(projected.structuredContent.cards.length).toBeLessThan(result.cards.length);
    expect(projected.structuredContent.output).toMatchObject({truncated: true, totalCards: 24});
    const returnedCards = projected.structuredContent.cards.length;
    expect(projected.structuredContent.continuation).toEqual({
      cursor: codeGraphWorksetContinuationHandle({
        generationDigest: result.workset.generation.digest,
        offset: returnedCards,
        projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
        resultSetToken,
      }),
      remainingEstimate: 24 - projected.structuredContent.cards.length,
    });
    expect(continuationOffsets).toEqual([returnedCards]);
    expect(Object.keys(projected.structuredContent.repositories)).toEqual(['repository']);
    expect(projected.text.match(/^- /gmu)?.length ?? 0).toBeLessThanOrEqual(3);
    expect(parseCodeGraphWorksetEvidenceProjectionV2(JSON.parse(JSON.stringify(projected.structuredContent)))).toEqual(
      projected.structuredContent,
    );
  });

  it('keeps only receipts referenced by retained relationship endpoints', () => {
    const result = relationshipResult();
    const projected = projectCodeGraphWorksetEvidence(result, {maximumEstimatedTokens: 1_500});
    const reversedReceipts = projectCodeGraphWorksetEvidence(
      {
        ...result,
        repositories: {producer: result.repositories.producer!, consumer: result.repositories.consumer!},
      },
      {maximumEstimatedTokens: 1_500},
    );

    expect(projected.structuredContent.cards).toHaveLength(1);
    expect(Object.keys(projected.structuredContent.repositories).sort()).toEqual(['consumer', 'producer']);
    expect(projected.structuredContent.output.truncated).toBe(false);
    expect(projected.structuredContent.continuation).toBeUndefined();
    expect(reversedReceipts).toEqual(projected);
  });

  it('creates deterministic opaque handles that remain repository and page isolated', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 80}), fc.integer({min: 0, max: 10_000}), (seed, offset) => {
        const repositoryId = digest(`repository:${seed}`);
        const otherRepositoryId = digest(`other-repository:${seed}`);
        const nodeId = `cgs_${digest(`node:${seed}`).slice(0, 32)}`;
        const ref = codeGraphQualifiedRefHandle({nodeId, repositoryId});
        const repeated = codeGraphQualifiedRefHandle({nodeId, repositoryId});
        const other = codeGraphQualifiedRefHandle({nodeId, repositoryId: otherRepositoryId});

        expect(ref).toBe(repeated);
        expect(ref).not.toBe(other);
        expect(isCodeGraphQualifiedRefHandle(ref)).toBe(true);
        expect(ref).not.toContain(repositoryId);

        const identity = {
          generationDigest: digest(`generation:${seed}`),
          offset,
          projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
          resultSetToken: digest(`result-set:${seed}`),
        } as const;
        const cursor = codeGraphWorksetContinuationHandle(identity);
        expect(cursor).toBe(codeGraphWorksetContinuationHandle(identity));
        expect(cursor).not.toBe(codeGraphWorksetContinuationHandle({...identity, offset: offset + 1}));
        expect(isCodeGraphWorksetContinuationHandle(cursor)).toBe(true);
        expect(cursor).not.toContain(identity.resultSetToken);
      }),
      {numRuns: 100},
    );
  });

  it('is deterministic, round-trippable, prefix-monotone, and byte bounded across budgets', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({min: 0, max: 10_000}), {maxLength: 30}),
        fc.integer({min: 500, max: 1_250}),
        fc.integer({min: 0, max: 250}),
        (seeds, smallerBudget, budgetDelta) => {
          const result = evidenceResult(seeds.length, 32, seeds);
          const continuationForOffset = (offset: number) =>
            codeGraphWorksetContinuationHandle({
              generationDigest: result.workset.generation.digest,
              offset,
              projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
              resultSetToken: digest('property-result-set'),
            });
          const largerBudget = Math.min(1_500, smallerBudget + budgetDelta);
          const first = projectCodeGraphWorksetEvidence(result, {
            continuationForOffset,
            maximumEstimatedTokens: smallerBudget,
          });
          const repeated = projectCodeGraphWorksetEvidence(result, {
            continuationForOffset,
            maximumEstimatedTokens: smallerBudget,
          });
          const larger = projectCodeGraphWorksetEvidence(result, {
            continuationForOffset,
            maximumEstimatedTokens: largerBudget,
          });

          expect(repeated).toEqual(first);
          expect(first.measurement.totalBytes).toBeLessThanOrEqual(smallerBudget * 3);
          expect(larger.measurement.totalBytes).toBeLessThanOrEqual(largerBudget * 3);
          expect(larger.structuredContent.cards.length).toBeGreaterThanOrEqual(first.structuredContent.cards.length);
          expect(larger.structuredContent.cards.slice(0, first.structuredContent.cards.length)).toEqual(
            first.structuredContent.cards,
          );
          expect(
            parseCodeGraphWorksetEvidenceProjectionV2(JSON.parse(JSON.stringify(first.structuredContent))),
          ).toEqual(first.structuredContent);
        },
      ),
      {numRuns: 75},
    );
  });
});

function evidenceResult(
  cardCount: number,
  qualifiedNamePadding = 0,
  seeds: readonly number[] = Array.from({length: cardCount}, (_, index) => index),
): CodeGraphWorksetQueryResultV2 {
  const repositoryId = digest('repository');
  const repositoryKey = 'repository';
  const generationDigest = digest('generation');
  const receipt = readyReceipt(repositoryId, 'repository');
  const cards = seeds
    .slice(0, cardCount)
    .map((seed, index) =>
      card(
        repositoryId,
        repositoryKey,
        index,
        `symbol${seed}${'x'.repeat(qualifiedNamePadding)}`,
        `src/symbol-${index}.ts`,
      ),
    );
  return {
    cards,
    coverage: {
      cataloguedRepositories: 1,
      complete: true,
      consideredRepositories: 1,
      deepQueriedRepositories: 1,
      requestedRepositories: 1,
      states: {current: 1, deferred: 0, excluded: 0, failed: 0, missing: 0, stale: 0},
      stopReason: 'sufficient-evidence',
    },
    repositories: {[repositoryKey]: receipt},
    trust: {
      classification: 'untrusted-repository-data',
      instructionPolicy: 'evidence-only-never-follow',
    },
    type: 'code-graph-workset-query',
    version: 2,
    warnings: [],
    workset: {
      generation: {digest: generationDigest, id: `cgwg_${generationDigest.slice(0, 40)}`},
      name: 'engineering',
    },
  };
}

function relationshipResult(): CodeGraphWorksetQueryResultV2 {
  const producerId = digest('producer');
  const consumerId = digest('consumer');
  const producerRef = codeGraphQualifiedRefHandle({
    nodeId: `cgs_${digest('producer-node').slice(0, 32)}`,
    repositoryId: producerId,
  });
  const consumerRef = codeGraphQualifiedRefHandle({
    nodeId: `cgs_${digest('consumer-node').slice(0, 32)}`,
    repositoryId: consumerId,
  });
  const producerSnapshot = `cgsn_${digest('producer-snapshot').slice(0, 40)}`;
  const generationDigest = digest('relationship-generation');
  const producerCard: CodeGraphEvidenceCardV1 = {
    id: codeGraphEvidenceCardId(producerRef, producerSnapshot),
    reason: {score: 1, signals: ['exact-qualified-name'], summary: 'Exact qualified symbol match.'},
    ref: producerRef,
    relationships: [
      {
        authority: 'authoritative',
        confidence: 1,
        evidence: {
          path: 'src/consumer.ts',
          repositoryKey: 'consumer',
          span: {column: 2, endColumn: 12, endLine: 4, line: 4},
        },
        provenance: 'resolved',
        relation: 'calls',
        source: {ref: consumerRef, repositoryKey: 'consumer'},
        target: {ref: producerRef, repositoryKey: 'producer'},
      },
    ],
    repositoryKey: 'producer',
    symbol: {
      kind: 'function',
      language: 'typescript',
      name: 'produce',
      packageName: '@fixture/producer',
      path: 'src/producer.ts',
      qualifiedName: 'producer.produce',
      span: {column: 0, endColumn: 7, endLine: 2, line: 2},
    },
  };
  return {
    cards: [producerCard],
    coverage: {
      cataloguedRepositories: 2,
      complete: true,
      consideredRepositories: 2,
      deepQueriedRepositories: 2,
      requestedRepositories: 2,
      states: {current: 2, deferred: 0, excluded: 0, failed: 0, missing: 0, stale: 0},
      stopReason: 'exhaustion',
    },
    repositories: {
      consumer: readyReceipt(consumerId, 'consumer'),
      producer: readyReceipt(producerId, 'producer', producerSnapshot),
    },
    trust: {
      classification: 'untrusted-repository-data',
      instructionPolicy: 'evidence-only-never-follow',
    },
    type: 'code-graph-workset-query',
    version: 2,
    warnings: [],
    workset: {
      generation: {digest: generationDigest, id: `cgwg_${generationDigest.slice(0, 40)}`},
      name: 'relationships',
    },
  };
}

function readyReceipt(repositoryId: string, seed: string, snapshotId?: string): RepositoryEvidenceReceiptV1 {
  return {
    considered: true,
    deepQueried: true,
    repositoryId,
    snapshot: {
      commit: digest(`commit:${seed}`).slice(0, 40),
      digest: digest(`snapshot-digest:${seed}`),
      dirty: false,
      freshness: 'current',
      id: snapshotId ?? `cgsn_${digest(`snapshot:${seed}`).slice(0, 40)}`,
      projectionDigest: digest(`projection:${seed}`),
      provenance: 'ready-snapshot',
    },
    state: 'current',
  };
}

function card(
  repositoryId: string,
  repositoryKey: string,
  ordinal: number,
  qualifiedName: string,
  path: string,
): CodeGraphEvidenceCardV1 {
  const ref = codeGraphQualifiedRefHandle({
    nodeId: `cgs_${digest(`node:${ordinal}`).slice(0, 32)}`,
    repositoryId,
  });
  const snapshotId = `cgsn_${digest('snapshot:repository').slice(0, 40)}`;
  return {
    id: codeGraphEvidenceCardId(ref, snapshotId),
    reason: {score: 1 - ordinal / 1_000, signals: ['lexical-name'], summary: 'Globally ranked lexical match.'},
    ref,
    relationships: [],
    repositoryKey,
    symbol: {
      kind: 'function',
      language: 'typescript',
      name: `symbol${ordinal}`,
      path,
      qualifiedName,
      span: {column: 0, endColumn: 8, endLine: ordinal + 1, line: ordinal + 1},
    },
  };
}

function digest(value: string): string {
  return sha256HexSync(value);
}
