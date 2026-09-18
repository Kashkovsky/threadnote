import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as fc from 'fast-check';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {
  threadnote5LocalAuthorityManifestHash,
  threadnote5ProcedureVerificationReceiptDigest,
} from '../../src/evaluation/threadnote-5-release-readiness-authority.js';
import {
  canonicalizeThreadnote5CaptureOutputPathsV1,
  canonicalizeThreadnote5ScenarioRuntimeBoundariesV1,
  captureThreadnote5ReleaseCandidateV1,
} from '../../src/evaluation/threadnote-5-release-readiness-capture.js';
import {
  APPROVED_THREADNOTE_5_SCENARIOS,
  THREADNOTE_5_RELEASE_SCENARIOS,
  type Threadnote5SourceV1,
} from '../../src/evaluation/threadnote-5-release-readiness-contract.js';
import {
  deriveThreadnote5LocalScenarioClaims,
  threadnote5LocalSubsystemReceiptDigest,
  verifyThreadnote5LocalSubsystemReceipts,
  type Threadnote5LocalSubsystemReceiptRecordV1,
} from '../../src/evaluation/threadnote-5-release-readiness-receipts.js';
import {parseContextBriefV1, renderContextBriefText} from '../../src/context_brief/projector.js';
import {createProcedureVerificationReceipt, parseProcedureManifest} from '../../src/procedure/contract.js';
import fixtureJson from '../evaluation/fixtures/threadnote-5-task-loop-v1/fixture.json' with {type: 'json'};
import {
  PRODUCTION_CAPTURE_CANDIDATE,
  productionCaptureFixture,
} from '../helpers/threadnote-5-production-capture-fixture.js';

const CANDIDATE: Threadnote5SourceV1 = {
  commit: '1'.repeat(40),
  executableSha256: '2'.repeat(64),
  id: 'threadnote-5.0.0',
  version: `5.0.0-local.g${'1'.repeat(40)}`,
};

describe('Threadnote 5 production capture', () => {
  effectIt.effect('freezes the corrected 15-observation and 24-source-record shape', () =>
    Effect.sync(() => {
      expect(APPROVED_THREADNOTE_5_SCENARIOS).toHaveLength(15);
      expect(APPROVED_THREADNOTE_5_SCENARIOS.reduce((sum, scenario) => sum + scenario.subsystems.length, 0)).toBe(24);
      expect(APPROVED_THREADNOTE_5_SCENARIOS.find(item => item.id === 'solo')?.subsystems).toContain('value-report');
      expect(APPROVED_THREADNOTE_5_SCENARIOS.find(item => item.id === 'git-shared')?.subsystems).toContain(
        'value-report',
      );
      expect(APPROVED_THREADNOTE_5_SCENARIOS.find(item => item.id === 'offline')?.subsystems).toContain('value-report');
    }),
  );

  effectIt.effect('canonicalizes separately captured runtime boundaries under input permutations', () =>
    Effect.sync(() => {
      const boundaries = runtimeBoundaries();
      const expected = canonicalizeThreadnote5ScenarioRuntimeBoundariesV1(
        CANDIDATE,
        THREADNOTE_5_RELEASE_SCENARIOS,
        boundaries,
      );
      fc.assert(
        fc.property(
          fc.shuffledSubarray(boundaries, {minLength: boundaries.length, maxLength: boundaries.length}),
          shuffled => {
            expect(
              canonicalizeThreadnote5ScenarioRuntimeBoundariesV1(CANDIDATE, THREADNOTE_5_RELEASE_SCENARIOS, shuffled),
            ).toEqual(expected);
          },
        ),
        {numRuns: 30},
      );
    }),
  );

  effectIt.effect('rejects direct and normalized aliases for concurrent capture outputs', () =>
    Effect.sync(() => {
      const resolvePath = (value: string) => new URL(value, 'file:///capture-root/').pathname;
      expect(() =>
        canonicalizeThreadnote5CaptureOutputPathsV1({
          canonicalReceiptsOutputPath: 'capture.json',
          evidenceOutputPath: 'capture.json',
          resolvePath,
        }),
      ).toThrow(/must be different files/u);
      expect(() =>
        canonicalizeThreadnote5CaptureOutputPathsV1({
          canonicalReceiptsOutputPath: 'receipts/../capture.json',
          evidenceOutputPath: './capture.json',
          resolvePath,
        }),
      ).toThrow(/must be different files/u);
    }),
  );

  effectIt.effect('canonicalizes source records through the same derivation used by verification', () =>
    Effect.sync(() => {
      const records = [procedureRecord(), outputBudgetRecord()];
      const authority = authorityForProcedure(records[0]);
      const expected = deriveThreadnote5LocalScenarioClaims({
        authorityManifest: authority,
        candidate: CANDIDATE,
        expectedAuthorityManifestSha256: threadnote5LocalAuthorityManifestHash(authority),
        retainedRecords: records,
      });
      fc.assert(
        fc.property(fc.boolean(), reverse => {
          const actual = deriveThreadnote5LocalScenarioClaims({
            authorityManifest: authority,
            candidate: CANDIDATE,
            expectedAuthorityManifestSha256: threadnote5LocalAuthorityManifestHash(authority),
            retainedRecords: reverse ? [...records].reverse() : records,
          });
          expect(actual).toEqual(expected);
        }),
        {numRuns: 20},
      );
    }),
  );

  effectIt.effect('fails closed before sealing incomplete, drifting, or oversized production inputs', () =>
    Effect.sync(() => {
      const authority = {candidate: CANDIDATE, entries: [], version: 1 as const};
      const common = {
        authorityManifest: authority,
        candidate: CANDIDATE,
        expectedAuthorityManifestSha256: threadnote5LocalAuthorityManifestHash(authority),
        fixture: fixtureJson,
        retainedSubsystemReceipts: [],
      };
      expect(() => captureThreadnote5ReleaseCandidateV1({...common, runtimeBoundaries: runtimeBoundaries()})).toThrow(
        /exactly 15 observations and 24 source records/u,
      );
      const drifting = runtimeBoundaries().map((boundary, index) =>
        index === 0
          ? {...boundary, postRuntime: {...boundary.postRuntime, executableSha256: '9'.repeat(64)}}
          : boundary,
      );
      expect(() => captureThreadnote5ReleaseCandidateV1({...common, runtimeBoundaries: drifting})).toThrow(
        /runtime boundaries are missing, duplicated, mislabeled, or drifting/u,
      );
      const oversized = runtimeBoundaries().map((boundary, index) =>
        index === 0 ? {...boundary, padding: 'x'.repeat(256 * 1024)} : boundary,
      );
      expect(() => captureThreadnote5ReleaseCandidateV1({...common, runtimeBoundaries: oversized})).toThrow(
        /within size limits/u,
      );
    }),
  );

  effectIt.effect('captures and replays the complete production-shaped matrix canonically', () =>
    Effect.sync(() => {
      const fixture = productionCaptureFixture();
      const authorityHash = threadnote5LocalAuthorityManifestHash(fixture.authorityManifest);
      const boundaries = runtimeBoundaries(PRODUCTION_CAPTURE_CANDIDATE);
      const input = {
        authorityManifest: fixture.authorityManifest,
        candidate: PRODUCTION_CAPTURE_CANDIDATE,
        expectedAuthorityManifestSha256: authorityHash,
        fixture: fixtureJson,
      };
      const expected = captureThreadnote5ReleaseCandidateV1({
        ...input,
        retainedSubsystemReceipts: fixture.records,
        runtimeBoundaries: boundaries,
      });

      expect(expected.evidence.candidateObservations).toHaveLength(15);
      expect(expected.retainedSubsystemReceipts).toHaveLength(24);
      expect(
        verifyThreadnote5LocalSubsystemReceipts({
          authorityManifest: fixture.authorityManifest,
          candidate: PRODUCTION_CAPTURE_CANDIDATE,
          expectedAuthorityManifestSha256: authorityHash,
          observations: expected.evidence.candidateObservations,
          retainedRecords: expected.retainedSubsystemReceipts,
        }),
      ).toMatchObject({receiptCount: 24, state: 'verified'});

      fc.assert(
        fc.property(
          fc.shuffledSubarray([...fixture.records], {
            minLength: fixture.records.length,
            maxLength: fixture.records.length,
          }),
          fc.shuffledSubarray([...boundaries], {minLength: boundaries.length, maxLength: boundaries.length}),
          (records, runtimeBoundaries) => {
            expect(
              captureThreadnote5ReleaseCandidateV1({
                ...input,
                retainedSubsystemReceipts: records,
                runtimeBoundaries,
              }),
            ).toEqual(expected);
          },
        ),
        {numRuns: 12},
      );
    }),
  );
});

function runtimeBoundaries(candidate: Threadnote5SourceV1 = CANDIDATE) {
  const runtime = {executableSha256: candidate.executableSha256, sourceCommit: candidate.commit};
  return THREADNOTE_5_RELEASE_SCENARIOS.map(scenario => ({postRuntime: runtime, preRuntime: runtime, scenario}));
}

function procedureRecord(): Threadnote5LocalSubsystemReceiptRecordV1 {
  const artifactText = 'artifact';
  const manifest = parseProcedureManifest({
    artifact: {id: 'team.example/review', semanticVersion: '1.2.3', sha256: sha256HexSync(artifactText)},
    compatible: {capabilities: ['filesystem.read'], surfaceIds: ['terminal']},
    dependencies: [],
    owner: 'owner-opaque-42',
    presentation: {summary: 'Review the repository.', taskKeywords: ['review']},
    relatedDurableMemoryIds: [],
    reviewedOn: '2026-09-17',
    rollout: {channel: 'stable', percentage: 100},
    schemaVersion: 2,
    verification: {commands: [{argv: ['bun', 'test'], id: 'unit'}], fixtures: []},
  });
  const receipt = createProcedureVerificationReceipt(manifest, {
    hostVersion: 'host',
    threadnoteVersion: CANDIDATE.version,
    verifiedAt: '2026-09-17T12:00:00.000Z',
    verifier: 'verifier',
  });
  return record('verified-procedures', 'procedure', {
    attempts: [
      {artifactText, manifest, statusInput: {capabilities: ['filesystem.read'], receipt, surfaceIds: ['terminal']}},
    ],
  });
}

function outputBudgetRecord(): Threadnote5LocalSubsystemReceiptRecordV1 {
  const structuredContent = parseContextBriefV1({
    activeHandoffs: [],
    coverage: {
      gaps: [],
      memory: {},
      omissions: {
        activeHandoffs: 0,
        coverageGaps: 0,
        durableDecisions: 0,
        graphCards: 0,
        graphContracts: 0,
        recommendedFollowUps: 0,
        stalenessAndConflicts: 0,
      },
    },
    durableDecisions: [],
    graph: {cards: [], contracts: []},
    mode: 'brief',
    output: {omittedItems: 0, projectorVersion: 2, returnedItems: 0, truncated: false},
    recommendedFollowUps: [],
    scope: {},
    stalenessAndConflicts: [],
    task: {summary: 'x', truncated: false},
    trust: {},
    type: 'context-brief',
    version: 2,
  });
  return record('output-budgets', 'context-brief', {
    attempts: [
      {
        event: {candidate: CANDIDATE},
        request: {budgetTokens: 1_500, mode: 'brief', scope: {callerCwd: '/repo', kind: 'repository'}, task: 'x'},
        result: {structuredContent, text: renderContextBriefText(structuredContent)},
      },
    ],
  });
}

function authorityForProcedure(record: Threadnote5LocalSubsystemReceiptRecordV1) {
  const attempt = (record.artifact as {readonly attempts: readonly Record<string, unknown>[]}).attempts[0];
  const manifest = parseProcedureManifest(attempt.manifest);
  const receipt = (attempt.statusInput as {readonly receipt: unknown}).receipt;
  return {
    candidate: CANDIDATE,
    entries: [
      {
        artifactId: manifest.artifact.id,
        automaticExecutionCount: 0,
        commandResults: manifest.verification.commands.map(command => ({
          commandId: command.id,
          exitCode: 0,
          outputDigest: sha256HexSync(`verified-output:${command.id}`),
        })),
        receiptDigest: threadnote5ProcedureVerificationReceiptDigest(receipt),
        recordDigest: record.digest,
        semanticVersion: manifest.artifact.semanticVersion,
        type: 'procedure-verification' as const,
      },
    ],
    version: 1 as const,
  };
}

function record(
  scenario: Threadnote5LocalSubsystemReceiptRecordV1['scenario'],
  kind: Threadnote5LocalSubsystemReceiptRecordV1['kind'],
  artifact: unknown,
): Threadnote5LocalSubsystemReceiptRecordV1 {
  const unsigned = {artifact, candidate: CANDIDATE, kind, scenario, version: 1 as const};
  return {...unsigned, digest: threadnote5LocalSubsystemReceiptDigest(unsigned)};
}
