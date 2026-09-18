import {it as effectIt} from '@effect/vitest';
import {DateTime, Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {getAgentAdapter} from '../../src/agent_integration/adapters.js';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {THREADNOTE_MCP_CLIENT_ENV, THREADNOTE_MCP_SURFACE_ENV} from '../../src/constants.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {MCP_TOOLSET_ENV} from '../../src/mcp/toolset.js';
import {canonicalMemoryDocumentContent, parseMemoryDocument} from '../../src/memory/document.js';
import {loadRecallIndexData} from '../../src/recall/index.js';
import {
  observeCurrentActivationSurfaceV1,
  type CurrentActivationSurfaceV1,
} from '../../src/activation/production_evidence.js';
import {produceSecondSurfaceProofV1} from '../../src/activation/second_surface_producer.js';
import {
  issueSecondSurfaceProofChallengeV1,
  secondSurfaceChallengeIdV1,
  verifySecondSurfaceProofAttestationV1,
} from '../../src/activation/second_surface_store.js';
import type {SecondSurfaceProofContextV1} from '../../src/activation/second_surface.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('transport-attested second-surface proof', () => {
  it('keeps the challenge identity stable across only the start timestamp', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 500_000}), offset => {
        const fixture = proofContext(surface('gemini-cli'), surface('qwen-code'));
        const later = new Date(Date.parse(fixture.startedAt) + offset).toISOString();
        expect(secondSurfaceChallengeIdV1({...fixture, startedAt: later})).toBe(secondSurfaceChallengeIdV1(fixture));
      }),
      {numRuns: 32},
    );
  });

  effectIt.effect('rejects wrong transports and accepts the real managed-surface producer exactly once', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-proof-'});
        const userHome = path.join(root, 'user');
        const home = path.join(userHome, '.threadnote');
        const repository = path.join(root, 'repository');
        yield* fs.makeDirectory(repository, {recursive: true});
        yield* command.execute('git', ['init', '--quiet'], {
          cwd: repository,
          maxOutputBytes: 4_096,
          timeoutMs: 5_000,
        });
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'tester',
        };
        const baseEnvironment = {...system.environment(), XDG_CONFIG_HOME: path.join(root, 'config')};
        const setupSystem = SystemInfo.of({
          ...system,
          homeDirectory: userHome,
          environment: () => baseEnvironment,
        });
        const [primary, secondary] = yield* Effect.gen(function* () {
          const primaryAdapter = getAgentAdapter('gemini-cli')!;
          const secondaryAdapter = getAgentAdapter('qwen-code')!;
          yield* primaryAdapter.actions.install(config, primaryAdapter, {apply: true});
          yield* secondaryAdapter.actions.install(config, secondaryAdapter, {apply: true});
          return yield* Effect.all([
            observeCurrentActivationSurfaceV1(config, primaryAdapter),
            observeCurrentActivationSurfaceV1(config, secondaryAdapter),
          ]);
        }).pipe(Effect.provideService(SystemInfo, setupSystem));
        const memory = sharedMemory();
        const memoryPath = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'shared',
          'default',
          'durable',
          'projects',
          'threadnote',
          'activation.md',
        );
        yield* fs.makeDirectory(path.dirname(memoryPath), {recursive: true});
        yield* fs.writeFileString(memoryPath, memory.content);
        yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
        const repositoryIdentity = yield* resolveRepositoryIdentity(repository);
        const context = proofContext(primary, secondary, {
          contentHash: sha256HexSync(canonicalMemoryDocumentContent(memory.content)),
          repositoryIdentityHash: repositoryIdentity.repositoryId,
          startedAt: DateTime.formatIso(yield* DateTime.now),
        });
        const challenge = yield* issueSecondSurfaceProofChallengeV1(config, context);
        const invoke = (environment: NodeJS.ProcessEnv, transport: 'http' | 'stdio' = 'stdio') =>
          produceSecondSurfaceProofV1(config, {
            callerCwd: repository,
            challengeId: challenge.challengeId,
            project: 'threadnote',
            query: 'Prove the activation decision.',
            topic: 'activation-decision',
            transport,
          }).pipe(Effect.provideService(SystemInfo, SystemInfo.of({...setupSystem, environment: () => environment})));
        const secondaryEnvironment = {
          ...baseEnvironment,
          [MCP_TOOLSET_ENV]: 'core',
          [THREADNOTE_MCP_CLIENT_ENV]: 'qwen',
          [THREADNOTE_MCP_SURFACE_ENV]: 'qwen-code',
        };
        expect((yield* invoke(secondaryEnvironment, 'http').pipe(Effect.exit))._tag).toBe('Failure');
        expect(
          (yield* invoke({
            ...secondaryEnvironment,
            [THREADNOTE_MCP_CLIENT_ENV]: 'gemini',
            [THREADNOTE_MCP_SURFACE_ENV]: 'gemini-cli',
          }).pipe(Effect.exit))._tag,
        ).toBe('Failure');
        expect((yield* invoke({...secondaryEnvironment, [MCP_TOOLSET_ENV]: 'full'}).pipe(Effect.exit))._tag).toBe(
          'Failure',
        );
        const unrelatedContext = {
          ...context,
          activationId: '8'.repeat(64),
          activationReceiptRevision: '7'.repeat(64),
          queryFingerprint: sha256HexSync(
            canonicalJson({
              project: 'threadnote',
              task: 'Find only the unrelated platypus retention policy.',
              topic: 'platypus-retention',
            }),
          ),
        };
        const unrelatedChallenge = yield* issueSecondSurfaceProofChallengeV1(config, unrelatedContext);
        expect(
          (yield* produceSecondSurfaceProofV1(config, {
            callerCwd: repository,
            challengeId: unrelatedChallenge.challengeId,
            project: 'threadnote',
            query: 'Find only the unrelated platypus retention policy.',
            topic: 'platypus-retention',
            transport: 'stdio',
          }).pipe(
            Effect.provideService(SystemInfo, SystemInfo.of({...setupSystem, environment: () => secondaryEnvironment})),
            Effect.exit,
          ))._tag,
        ).toBe('Failure');
        const receipt = yield* invoke(secondaryEnvironment);
        expect(receipt.surfaceId).toBe('qwen-code');
        expect(receipt.transport).toBe('stdio');
        expect(receipt.proof.decisionMemoryId).toBe('tn_activation_attested');
        expect(yield* invoke(secondaryEnvironment)).toEqual(receipt);
        expect(
          (yield* verifySecondSurfaceProofAttestationV1(config, challenge, {
            ...receipt,
            attestationHash: 'f'.repeat(64),
          }).pipe(Effect.exit))._tag,
        ).toBe('Failure');
        const replayContext = {...context, activationId: 'f'.repeat(64), activationReceiptRevision: 'e'.repeat(64)};
        const replayChallenge = yield* issueSecondSurfaceProofChallengeV1(config, replayContext);
        expect(
          (yield* verifySecondSurfaceProofAttestationV1(config, replayChallenge, receipt).pipe(Effect.exit))._tag,
        ).toBe('Failure');
        const serialized = JSON.stringify(receipt);
        expect(serialized).not.toContain(memory.record.body);
        expect(serialized).not.toContain('Prove the activation decision.');
      }),
    ).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});

function proofContext(
  primary: CurrentActivationSurfaceV1,
  secondary: CurrentActivationSurfaceV1,
  overrides: Partial<SecondSurfaceProofContextV1['decision']> &
    Partial<Pick<SecondSurfaceProofContextV1, 'repositoryIdentityHash' | 'startedAt'>> = {},
): SecondSurfaceProofContextV1 {
  return {
    activationId: 'a'.repeat(64),
    activationReceiptRevision: 'b'.repeat(64),
    catalogRevision: 'agent-catalog-v1-test',
    catalogSnapshotHash: 'c'.repeat(64),
    decision: {
      canonicalUri: 'threadnote://user/tester/memories/shared/default/durable/projects/threadnote/activation.md',
      contentHash: overrides.contentHash ?? 'd'.repeat(64),
      memoryId: 'tn_activation_attested',
      publicationReceiptHash: 'e'.repeat(64),
    },
    primary: primary.snapshot,
    queryFingerprint: sha256HexSync(
      canonicalJson({project: 'threadnote', task: 'Prove the activation decision.', topic: 'activation-decision'}),
    ),
    repositoryIdentityHash: overrides.repositoryIdentityHash ?? '1'.repeat(64),
    repositoryState: 'clean',
    secondary: secondary.snapshot,
    startedAt: overrides.startedAt ?? '2026-09-18T08:00:00.000Z',
    teamId: 'default',
    teamShareStateHash: '2'.repeat(64),
  };
}

function surface(id: string): CurrentActivationSurfaceV1 {
  const fingerprint = sha256HexSync(
    canonicalJson({installedVersion: '5.0.0', protocol: 'threadnote-mcp-stdio-v1', toolset: 'core'}),
  );
  return {
    evidenceHash: '9'.repeat(64),
    snapshot: {
      access: 'local-stdio',
      capabilitiesFingerprint: '3'.repeat(64),
      configurationState: 'current',
      mcpCapability: 'managed',
      mcpConfigFingerprint: '4'.repeat(64),
      mcpReceiptFingerprint: '5'.repeat(64),
      mcpServerFingerprint: fingerprint,
      surfaceId: id,
    },
  };
}

function sharedMemory() {
  const content = [
    'MEMORY',
    'kind: durable',
    'status: active',
    'project: threadnote',
    'topic: activation-decision',
    'source_agent_client: codex',
    'timestamp: 2026-09-18T08:00:00.000Z',
    'memory_id: tn_activation_attested',
    'visibility: shared',
    'authority: user_approved',
    'trust: approved',
    '',
    '# Decision',
    'Use the reviewed activation path.',
  ].join('\n');
  const record = parseMemoryDocument(
    'threadnote://user/tester/memories/shared/default/durable/projects/threadnote/activation.md',
    content,
  );
  if (record === undefined) throw new Error('Expected valid shared memory fixture.');
  return {content, record};
}
