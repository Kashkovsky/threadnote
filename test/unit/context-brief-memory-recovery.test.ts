import {it as effectIt} from '@effect/vitest';
import {Effect, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {beforeEach, describe, expect, vi} from 'vitest';
import type {MemoryCodeCitationV1} from '../../src/memory/code_citation.js';
import type {MemoryRecord} from '../../src/memory/document.js';
import type {RuntimeConfig} from '../../src/types.js';
import type {ContextBriefPlanV1} from '../../src/context_brief/types.js';
import {contextBriefCodeAnchorTelemetryFields} from '../../src/telemetry/context_brief.js';
import {TestError} from '../helpers/test-error.js';

const mocks = vi.hoisted(() => ({
  captureMemoryCodeCitations: vi.fn(),
  expireRecallIndexValidation: vi.fn(),
  finalizeDeferredCodeAnchorsForRoute: vi.fn(),
  loadRecallCodeLinks: vi.fn(),
  loadRecallIndexData: vi.fn(),
  loadRecallMemoryIdentities: vi.fn(),
  readMemoryRecordsByUri: vi.fn(),
  resolveRepositoryIdentity: vi.fn(),
  withCodeAnchorFinalizationAnonymousTelemetry: vi.fn(),
}));

vi.mock('../../src/memory/code_citation_capture.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/memory/code_citation_capture.js')>();
  return {...actual, captureMemoryCodeCitations: mocks.captureMemoryCodeCitations};
});

vi.mock('../../src/memory/index.js', () => ({readMemoryRecordsByUri: mocks.readMemoryRecordsByUri}));

vi.mock('../../src/recall/index.js', () => ({
  expireRecallIndexValidation: mocks.expireRecallIndexValidation,
  loadRecallCodeLinks: mocks.loadRecallCodeLinks,
  loadRecallIndexData: mocks.loadRecallIndexData,
  loadRecallMemoryIdentities: mocks.loadRecallMemoryIdentities,
}));

vi.mock('../../src/code_graph/repository.js', () => ({
  resolveRepositoryIdentity: mocks.resolveRepositoryIdentity,
}));

vi.mock('../../src/memory/deferred_code_anchor.js', () => ({
  finalizeDeferredCodeAnchorsForRoute: mocks.finalizeDeferredCodeAnchorsForRoute,
}));

vi.mock('../../src/telemetry/code_anchor_finalization.js', () => ({
  withCodeAnchorFinalizationAnonymousTelemetry: mocks.withCodeAnchorFinalizationAnonymousTelemetry,
}));

import {retrieveContextBriefCodeLinkedMemoryEvidence} from '../../src/context_brief/index.js';
import {MemoryCodeCitationCaptureError} from '../../src/memory/code_citation_capture.js';

const MEMORY_URI = 'threadnote://user/tester/memories/durable/projects/threadnote/recovery.md';
const CONFIG: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/threadnote-home',
  agentId: 'threadnote',
  manifestPath: '/threadnote-home/seed-manifest.yaml',
  user: 'tester',
};

describe('Context Brief code-linked memory recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureMemoryCodeCitations.mockImplementation(
      (_config: RuntimeConfig, input: {readonly refs?: readonly string[]}) =>
        Effect.succeed((input.refs ?? []).map(codeCitation)),
    );
    mocks.loadRecallCodeLinks.mockReturnValue(Effect.succeed([]));
    mocks.loadRecallMemoryIdentities.mockReturnValue(Effect.succeed([]));
    mocks.readMemoryRecordsByUri.mockReturnValue(Effect.succeed([]));
    mocks.resolveRepositoryIdentity.mockReturnValue(
      Effect.fail(TestError.make({message: 'identity intentionally unavailable'})),
    );
    mocks.expireRecallIndexValidation.mockReturnValue(Effect.void);
    mocks.finalizeDeferredCodeAnchorsForRoute.mockReturnValue(Effect.void);
    mocks.withCodeAnchorFinalizationAnonymousTelemetry.mockImplementation(
      (_route: string, effect: Effect.Effect<unknown, unknown, unknown>) => effect,
    );
  });

  effectIt.effect('preserves resolved anchor ordinals when canonical memory reads fail after capture', () =>
    Effect.gen(function* () {
      const refs = ['src/first.ts', 'src/second.ts'];
      mocks.loadRecallCodeLinks.mockImplementation(
        (_config: RuntimeConfig, input: {readonly anchors: readonly MemoryCodeCitationV1[]}) =>
          Effect.succeed([
            {
              anchorOrdinal: 0,
              citationId: input.anchors[0].id,
              matchKind: 'file-path',
              uri: MEMORY_URI,
            },
          ]),
      );
      mocks.readMemoryRecordsByUri.mockReturnValue(Effect.fail(TestError.make({message: 'canonical read failed'})));

      const result = yield* contextBriefRecoveryTestEffect(
        retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(refs)),
      );

      expect(result.codeAnchorCoverage).toEqual({complete: true, matchedMemories: 0, requested: 2, resolved: 2});
      expect(result.gaps).toEqual(['code-anchor-recall-unavailable']);
      expect(mocks.captureMemoryCodeCitations).toHaveBeenCalledTimes(1);
    }),
  );

  effectIt.effect('preserves resolved anchors when stable identity lookup fails after canonical reads', () =>
    Effect.gen(function* () {
      const refs = ['src/first.ts'];
      const citation = codeCitation(refs[0], 0);
      mocks.captureMemoryCodeCitations.mockReturnValue(Effect.succeed([citation]));
      mocks.loadRecallCodeLinks.mockReturnValue(
        Effect.succeed([{anchorOrdinal: 0, citationId: citation.id, matchKind: 'file-path', uri: MEMORY_URI}]),
      );
      mocks.readMemoryRecordsByUri.mockReturnValue(Effect.succeed([memoryRecord(citation)]));
      mocks.loadRecallMemoryIdentities.mockReturnValue(Effect.fail(TestError.make({message: 'identity index failed'})));

      const result = yield* contextBriefRecoveryTestEffect(
        retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(refs)),
      );

      expect(result.codeAnchorCoverage).toEqual({complete: true, matchedMemories: 0, requested: 1, resolved: 1});
      expect(result.gaps).toEqual(['code-anchor-recall-unavailable']);
    }),
  );

  effectIt.effect(
    'reports mixed resolved and unresolved anchors as partial without whole-phase resolution failure',
    () =>
      Effect.gen(function* () {
        const refs = ['src/first.ts', 'src/missing.ts', 'src/third.ts'];
        mocks.captureMemoryCodeCitations.mockImplementation(
          (_config: RuntimeConfig, input: {readonly refs?: readonly string[]}) => {
            const requested = input.refs ?? [];
            if (requested.length > 1 || requested[0] === refs[1]) {
              return Effect.fail(unresolvedCaptureError());
            }
            return Effect.succeed([codeCitation(requested[0], refs.indexOf(requested[0]))]);
          },
        );

        const result = yield* contextBriefRecoveryTestEffect(
          retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(refs)),
        );

        expect(result.codeAnchorCoverage).toEqual({
          complete: false,
          matchedMemories: 0,
          requested: 3,
          resolved: 2,
          unresolvedOrdinals: [1],
        });
        expect(result.gaps).toContain('code-anchors-unresolved');
        expect(result.gaps).not.toContain('code-anchor-resolution-unavailable');
        expect(
          contextBriefCodeAnchorTelemetryFields({
            ...result.codeAnchorCoverage!,
            gaps: result.gaps,
            recoveryPresent: true,
          }),
        ).toMatchObject({
          contextBriefCodeAnchorCoverage: 'partial',
          contextBriefGapClass: 'unresolved',
        });
        expect(mocks.captureMemoryCodeCitations).toHaveBeenCalledTimes(4);
      }),
  );

  effectIt.effect('surfaces an unavailable fallback read without discarding resolved anchor ordinals', () =>
    Effect.gen(function* () {
      const refs = ['src/first.ts', 'src/missing.ts', 'src/unavailable.ts'];
      mocks.captureMemoryCodeCitations.mockImplementation(
        (_config: RuntimeConfig, input: {readonly refs?: readonly string[]}) => {
          const requested = input.refs ?? [];
          if (requested.length > 1 || requested[0] === refs[1]) return Effect.fail(unresolvedCaptureError());
          if (requested[0] === refs[2]) return Effect.fail(MemoryCodeCitationCaptureError.of('permission denied'));
          return Effect.succeed([codeCitation(requested[0], 0)]);
        },
      );

      const result = yield* contextBriefRecoveryTestEffect(
        retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(refs)),
      );

      expect(result.codeAnchorCoverage).toEqual({
        complete: false,
        matchedMemories: 0,
        requested: 3,
        resolved: 1,
        unresolvedOrdinals: [1, 2],
      });
      expect(result.gaps).toEqual([
        'code-anchor-recall-no-active-memory',
        'code-anchor-resolution-unavailable',
        'code-anchors-unresolved',
      ]);
      expect(
        contextBriefCodeAnchorTelemetryFields({
          ...result.codeAnchorCoverage!,
          gaps: result.gaps,
          recoveryPresent: true,
        }),
      ).toMatchObject({
        contextBriefCodeAnchorCoverage: 'unavailable',
        contextBriefGapClass: 'unavailable',
      });
      expect(mocks.captureMemoryCodeCitations).toHaveBeenCalledTimes(4);
    }),
  );

  effectIt.effect('bounds eight-ref global failures and retries only classified transient capture errors', () =>
    Effect.gen(function* () {
      const refs = Array.from({length: 8}, (_, index) => `src/ref-${index}.ts`);
      const fatalExecutions: string[][] = [];
      mocks.captureMemoryCodeCitations.mockImplementation(
        (_config: RuntimeConfig, input: {readonly refs?: readonly string[]}) =>
          Effect.suspend(() => {
            fatalExecutions.push([...(input.refs ?? [])]);
            return Effect.fail(MemoryCodeCitationCaptureError.of('fatal'));
          }),
      );

      const fatal = yield* Effect.result(
        contextBriefRecoveryTestEffect(retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(refs))),
      );

      expect(Result.isFailure(fatal)).toBe(true);
      expect(mocks.captureMemoryCodeCitations).toHaveBeenCalledTimes(1);
      expect(fatalExecutions).toEqual([refs]);

      mocks.captureMemoryCodeCitations.mockReset();
      const transientExecutions: string[][] = [];
      mocks.captureMemoryCodeCitations.mockImplementation(
        (_config: RuntimeConfig, input: {readonly refs?: readonly string[]}) =>
          Effect.suspend(() => {
            transientExecutions.push([...(input.refs ?? [])]);
            return Effect.fail(MemoryCodeCitationCaptureError.of('transient', undefined, undefined, true));
          }),
      );

      const transient = yield* Effect.result(
        contextBriefRecoveryTestEffect(retrieveContextBriefCodeLinkedMemoryEvidence(CONFIG, codeAnchorPlan(refs))),
      ).pipe(TestClock.withLive);

      expect(Result.isFailure(transient)).toBe(true);
      expect(mocks.captureMemoryCodeCitations).toHaveBeenCalledTimes(1);
      expect(transientExecutions).toEqual([refs, refs, refs]);
    }),
  );
});

function codeAnchorPlan(codeRefs: readonly string[]): ContextBriefPlanV1['codeAnchors'] {
  return {
    candidateLimit: 24,
    codeRefs,
    project: 'threadnote',
    scope: {callerCwd: '/workspace/threadnote', kind: 'repository', project: 'threadnote'},
  };
}

function codeCitation(path: string, ordinal = 0): MemoryCodeCitationV1 {
  const digit = ((Math.max(ordinal, 0) % 15) + 1).toString(16);
  return {
    extractorSet: 'fixture-extractor',
    fileContentHash: {algorithm: 'sha256', value: digit.repeat(64)},
    id: `tncc_${digit.repeat(40)}`,
    path,
    repositoryId: 'a'.repeat(64),
    repositoryIdentityKind: 'remote',
    sourceCommit: 'b'.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${'c'.repeat(40)}`,
    target: {kind: 'file'},
    version: 1,
  };
}

function memoryRecord(citation: MemoryCodeCitationV1): MemoryRecord {
  return {
    body: 'The recovered memory remains bounded.',
    content: 'fixture',
    headerTitle: 'MEMORY',
    metadata: {
      codeCitations: [citation],
      kind: 'durable',
      memoryId: 'tn_context_brief_recovery',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-08-31T00:00:00.000Z',
      topic: 'context-brief-recovery',
    },
    uri: MEMORY_URI,
  };
}

function unresolvedCaptureError(): MemoryCodeCitationCaptureError {
  return MemoryCodeCitationCaptureError.of('unresolved', undefined, 'code-reference-unresolved');
}

function contextBriefRecoveryTestEffect<A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> {
  // Every required boundary is replaced above with an Effect that requires no services.
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- fully mocked focused unit boundary
  return effect as Effect.Effect<A, E>;
}
