#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This evaluation runner owns pinned local executable, artifact, and process-group boundaries. */

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createHash} from 'node:crypto';
import {cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve, sep} from 'node:path';
import {Effect} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  matchedEvaluationReferenceEnvironmentPolicyV1,
  matchedEvaluationPromptHashV1,
  parseMatchedEvaluationCorpusV1,
  parseMatchedEvaluationManifestV1,
  type MatchedEvaluationManifestV1,
  type MatchedEvaluationArm,
  type MatchedEvaluationArmDefinitionV1,
  MATCHED_EVALUATION_ARMS,
} from '@threadnote/threadnote/evaluation/matched-evaluation';
import {
  parseMatchedEvaluationObservationV1,
  parseMatchedEvaluationOutcomesJsonlV1,
  runMatchedEvaluationV1,
  summarizeMatchedEvaluationV1,
  type MatchedEvaluationRunRequestV1,
  type MatchedEvaluationUnavailableReason,
} from '@threadnote/threadnote/evaluation/matched-evaluation-runner';
import {
  createMatchedContinuationPhaseTwoVerificationCheckReceiptV1,
  createMatchedContinuationPhaseTwoVerificationPlanV1,
  createMatchedContinuationPhaseTwoVerificationReceiptV1,
  parseMatchedContinuationPhaseTwoVerificationPlanV1,
  parseMatchedContinuationPytestFailureIdsV1,
  type MatchedContinuationPhaseTwoVerificationCheckReceiptV1,
  type MatchedContinuationPhaseTwoVerificationPlanV1,
  type MatchedContinuationPhaseTwoVerificationReceiptV1,
} from '@threadnote/threadnote/evaluation/matched-verification';
import {
  assertMatchedTokenEfficiencyObservationContextV1,
  assertMatchedTokenEfficiencyStudyMatchesV1,
  createMatchedTokenEfficiencyTaskContextV1,
  evaluateMatchedTokenEfficiencyV1,
  matchedTokenEfficiencyCitationHashV1,
  matchedTokenEfficiencyGraphContentHashV1,
  matchedTokenEfficiencyGraphSnapshotHashV1,
  parseMatchedTokenEfficiencyStudyV1,
  renderMatchedTokenEfficiencyArticleEvidenceV1,
  type MatchedTokenEfficiencyStudyV1,
} from '@threadnote/threadnote/evaluation/matched-token-efficiency';
import {captureCodeMemoryLinkProcessGroup} from './code-memory-link-process-boundary.js';
import {
  matchedEvaluationPreparedHomeFixtureHashV1,
  parseMatchedEvaluationCodexAdapterConfigV1,
} from './matched-evaluation-codex-adapter.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';
import {
  assertMatchedEvaluationPinnedFileV1,
  assertMatchedEvaluationRepositoryV1,
  compareAndSwapMatchedEvaluationLedgerV1,
  observeMatchedEvaluationRepositoryV1,
  type MatchedEvaluationRepositoryObservationV1,
  stageMatchedEvaluationPinnedFileV1,
  withMatchedEvaluationArtifactLockV1,
} from './matched-evaluation-runtime-integrity.js';

export const MATCHED_EVALUATION_RUNTIME_VERSION = 4 as const;

export interface MatchedEvaluationRuntimeV1 {
  readonly arms: readonly MatchedEvaluationRuntimeArmV1[];
  readonly artifactDirectory: string;
  readonly repositories: readonly MatchedEvaluationRuntimeRepositoryV1[];
  readonly timeoutMilliseconds: number;
  readonly verificationPlanHash: string | null;
  readonly version: typeof MATCHED_EVALUATION_RUNTIME_VERSION;
}

export interface MatchedEvaluationRuntimeArmV1 {
  readonly adapterArguments: readonly string[];
  readonly adapterConfigFile: string;
  readonly adapterExecutable: string;
  readonly arm: MatchedEvaluationArm;
  readonly environmentKeys: readonly string[];
  readonly toolExecutable: string | null;
  readonly toolLockFile: string | null;
}

export interface MatchedEvaluationRuntimeRepositoryV1 {
  readonly clusterId: string | null;
  readonly repositoryDirectory: string;
  readonly repositoryIdentityHash: string;
}

export function projectMatchedEvaluationAdapterTaskV1(
  request: Pick<MatchedEvaluationRunRequestV1, 'arm' | 'task'>,
  study: MatchedTokenEfficiencyStudyV1 | null,
) {
  const taskContext = study?.taskContexts.find(context => context.taskId === request.task.taskId) ?? null;
  if (study !== null && taskContext === null) {
    throw new Error(`Token-efficiency study has no prepared context for ${request.task.taskId}.`);
  }
  return {
    agentTask: {
      category: request.task.category,
      /** Memory contents must be discovered through the pinned arm, never injected into an adapter request. */
      memoryFixtures: [] as const,
      prompt: request.task.prompt,
      repositoryFixtureHash: request.task.repositoryFixtureHash,
      taskId: request.task.taskId,
      variant: request.task.variant,
    },
    preparedContext:
      request.arm === 'threadnote-compact' || request.arm === 'threadnote-source'
        ? {memoryAccess: 'linked' as const, studyHash: study?.studyHash ?? null, taskContext}
        : request.arm === 'threadnote-graph'
          ? {
              graphContext:
                taskContext === null
                  ? null
                  : {
                      clusterId: taskContext.clusterId,
                      graphContentHash: taskContext.graphContentHash,
                      graphSnapshotHash: taskContext.graphSnapshotHash,
                      repositoryFixtureHash: taskContext.repositoryFixtureHash,
                      taskId: taskContext.taskId,
                    },
              memoryAccess: 'disabled' as const,
              studyHash: study?.studyHash ?? null,
            }
          : null,
  };
}

export function projectMatchedEvaluationContinuationAdapterTaskV2(
  request: Pick<MatchedEvaluationRunRequestV1, 'arm' | 'task'>,
  study: MatchedTokenEfficiencyStudyV1,
  plan: MatchedEvaluationContinuationPilotPlanCurrent,
) {
  const sourceContext = study.taskContexts.find(context => context.taskId === request.task.taskId);
  if (sourceContext === undefined) {
    throw new Error(`Token-efficiency study has no prepared context for ${request.task.taskId}.`);
  }
  const prepared = plan.checkpoint.preparedContext;
  return {
    agentTask: {
      category: request.task.category,
      memoryFixtures: [] as const,
      prompt: plan.phaseTwoPrompt,
      repositoryFixtureHash: plan.checkpoint.repositoryFixtureHash,
      taskId: request.task.taskId,
      variant: request.task.variant,
    },
    preparedContext:
      request.arm === 'threadnote-compact'
        ? {
            memoryAccess: 'linked' as const,
            studyHash: study.studyHash,
            taskContext: {
              ...sourceContext,
              graphContentHash: prepared.graphContentHash,
              graphSnapshotHash: prepared.graphSnapshotHash,
              linkReceiptsHash: prepared.linkReceiptsHash,
              repositoryFixtureHash: plan.checkpoint.repositoryFixtureHash,
              taskContextHash: prepared.taskContextHash,
            },
          }
        : request.arm === 'threadnote-graph'
          ? {
              graphContext: {
                clusterId: sourceContext.clusterId,
                graphContentHash: prepared.graphContentHash,
                graphSnapshotHash: prepared.graphSnapshotHash,
                repositoryFixtureHash: plan.checkpoint.repositoryFixtureHash,
                taskId: request.task.taskId,
              },
              memoryAccess: 'disabled' as const,
              studyHash: study.studyHash,
            }
          : null,
  };
}

type MatchedEvaluationProjectedAdapterTask = ReturnType<typeof projectMatchedEvaluationAdapterTaskV1>;

export interface MatchedEvaluationContinuationPhaseOneTaskPacketV1 {
  readonly phaseOneAllowedPaths: readonly string[];
  readonly phaseOneDirective: string;
  readonly phaseOneFocusedChecks: readonly string[];
  readonly phaseTwoFocusedChecks: readonly string[];
  readonly phaseTwoPrompt: string;
  readonly repositoryName: string;
  readonly sourceRevision: string;
  readonly sourceTaskPrompt: string;
  readonly status: 'draft-unsealed';
  readonly taskKey: string;
  readonly version: 1;
}

export interface MatchedEvaluationContinuationPhaseOneSelectionV1 {
  readonly continuationAttempts: MatchedEvaluationContinuationPilotPlanV2['attempts'];
  readonly phaseOnePrompt: string;
  readonly phaseOnePromptSha256: string;
  readonly phaseOneRunNonce: string;
  readonly sourceTask: MatchedEvaluationContinuationPilotPlanV2['sourceTask'];
  readonly taskPacket: MatchedEvaluationContinuationPhaseOneTaskPacketV1;
  readonly taskPacketSha256: string;
  readonly version: 1;
}

export interface MatchedEvaluationContinuationPhaseOneReceiptV1 {
  readonly continuationAttempts: MatchedEvaluationContinuationPhaseOneSelectionV1['continuationAttempts'];
  readonly evidenceSha256: {
    readonly adapterArtifactHash: string;
    readonly adapterConfigurationFileSha256: string;
    readonly artifactSha256: string;
    readonly requestSha256: string;
    readonly responseSha256: string;
    readonly transcriptSha256: string;
  };
  readonly metrics: ReturnType<typeof parseMatchedEvaluationObservationV1>['metrics'];
  readonly phaseOnePromptSha256: string;
  readonly phaseOneRunNonce: string;
  readonly selectionSha256: string;
  readonly taskId: string;
  readonly taskPacketSha256: string;
  readonly transcriptHash: string;
  readonly version: 1;
}

export interface ResolvedRuntimeArm {
  readonly config: MatchedEvaluationRuntimeArmV1;
  readonly adapterConfigFile: string;
  readonly definition: MatchedEvaluationArmDefinitionV1;
  readonly toolExecutable: string | null;
  readonly toolPayload?: {readonly root: string; readonly hash: string};
}

export interface MatchedEvaluationContinuationAdapterConfigOverrideV2 {
  readonly adapterConfigFile: string;
  readonly adapterConfigurationHash: string;
}

export function matchedEvaluationContinuationAdapterConfigurationPathsV2(planPath: string) {
  const root = join(dirname(planPath), 'checkpoint-adapter-config');
  return {
    'threadnote-compact': join(root, 'threadnote-compact.json'),
    'threadnote-graph': join(root, 'threadnote-graph.json'),
  } as const;
}

export async function assertMatchedEvaluationContinuationAdapterConfigurationsV2(input: {
  readonly manifest: MatchedEvaluationManifestV1;
  readonly plan: MatchedEvaluationContinuationPilotPlanCurrent;
  readonly planPath: string;
  readonly runtime: MatchedEvaluationRuntimeV1;
}): Promise<
  ReadonlyMap<'threadnote-compact' | 'threadnote-graph', MatchedEvaluationContinuationAdapterConfigOverrideV2>
> {
  const paths = matchedEvaluationContinuationAdapterConfigurationPathsV2(input.planPath);
  const specifications = [
    {
      arm: 'threadnote-graph' as const,
      expectedContext: {
        graphContentHash: input.plan.checkpoint.preparedContext.graphContentHash,
        graphSnapshotHash: input.plan.checkpoint.preparedContext.graphSnapshotHash,
        linkReceiptsHash: null,
        memoryAccess: 'disabled' as const,
        taskContextHash: null,
      },
      expectedHash: input.plan.checkpoint.adapterConfigurations.threadnoteGraphSha256,
      preparedHome: input.plan.checkpoint.preparedGraphHome,
    },
    {
      arm: 'threadnote-compact' as const,
      expectedContext: {
        graphContentHash: input.plan.checkpoint.preparedContext.graphContentHash,
        graphSnapshotHash: input.plan.checkpoint.preparedContext.graphSnapshotHash,
        linkReceiptsHash: input.plan.checkpoint.preparedContext.linkReceiptsHash,
        memoryAccess: 'linked' as const,
        taskContextHash: input.plan.checkpoint.preparedContext.taskContextHash,
      },
      expectedHash: input.plan.checkpoint.adapterConfigurations.threadnoteCompactSha256,
      preparedHome: input.plan.checkpoint.preparedHome,
    },
  ];
  const overrides = await Promise.all(
    specifications.map(async specification => {
      const definition = input.manifest.arms.find(candidate => candidate.arm === specification.arm);
      if (definition === undefined) throw new Error(`Continuation manifest lacks ${specification.arm}.`);
      const runtimeArm = input.runtime.arms.find(candidate => candidate.arm === specification.arm);
      if (runtimeArm === undefined) throw new Error(`Continuation runtime lacks ${specification.arm}.`);
      const [sourceConfigFile, checkpointConfigFile] = await Promise.all([
        canonicalRegularFile(runtimeArm.adapterConfigFile, `${specification.arm} source adapter configuration`),
        canonicalRegularFile(paths[specification.arm], `${specification.arm} checkpoint adapter configuration`),
      ]);
      const [sourceHash, checkpointHash, sourceInput, checkpointInput] = await Promise.all([
        sha256File(sourceConfigFile),
        sha256File(checkpointConfigFile),
        readJson(sourceConfigFile),
        readJson(checkpointConfigFile),
      ]);
      if (sourceHash !== definition.adapterConfigurationHash) {
        throw new Error(`${specification.arm} source adapter configuration differs from its manifest identity.`);
      }
      if (checkpointHash !== specification.expectedHash) {
        throw new Error(`${specification.arm} checkpoint adapter configuration differs from the sealed plan.`);
      }
      const source = parseMatchedEvaluationCodexAdapterConfigV1(sourceInput);
      const checkpoint = parseMatchedEvaluationCodexAdapterConfigV1(checkpointInput);
      const {contextHomes: _sourceHomes, ...sourcePolicy} = source;
      const {contextHomes, ...checkpointPolicy} = checkpoint;
      if (JSON.stringify(sourcePolicy) !== JSON.stringify(checkpointPolicy)) {
        throw new Error(`${specification.arm} checkpoint adapter configuration changes the frozen execution policy.`);
      }
      if (contextHomes.length !== 1 || contextHomes[0]?.taskId !== input.plan.taskId) {
        throw new Error(`${specification.arm} checkpoint adapter configuration must contain only its task home.`);
      }
      const home = contextHomes[0];
      if (
        JSON.stringify(home.expectedContext) !== JSON.stringify(specification.expectedContext) ||
        home.homeFixtureHash !== specification.preparedHome.fixtureHash ||
        matchedEvaluationContinuationPreparedHomeIdentityHashV2(home) !== specification.preparedHome.identitySha256
      ) {
        throw new Error(`${specification.arm} checkpoint prepared home differs from the sealed plan.`);
      }
      await canonicalDirectory(home.homeDirectory, `${specification.arm} checkpoint prepared home`);
      if ((await matchedEvaluationPreparedHomeFixtureHashV1(home.homeDirectory)) !== home.homeFixtureHash) {
        throw new Error(`${specification.arm} checkpoint prepared home differs from its fixture hash.`);
      }
      return [
        specification.arm,
        {adapterConfigFile: checkpointConfigFile, adapterConfigurationHash: checkpointHash},
      ] as const;
    }),
  );
  return new Map(overrides);
}

export interface ResolvedRuntimeRepository {
  readonly clusterId: string | null;
  readonly expected: MatchedEvaluationRepositoryObservationV1;
  readonly repositoryDirectory: string;
}

export function selectMatchedEvaluationPilotRowsV1(
  manifest: Pick<MatchedEvaluationManifestV1, 'activeArms' | 'blindAssignment' | 'schedule'>,
  taskId: string,
) {
  const expectedArms = ['files', 'threadnote-graph', 'threadnote-compact'] as const;
  if (manifest.activeArms === undefined || JSON.stringify([...manifest.activeArms]) !== JSON.stringify(expectedArms)) {
    throw new Error('Pilot requires manifest.activeArms to be exactly files, threadnote-graph, threadnote-compact.');
  }
  const rows = manifest.schedule.filter(row => row.taskId === taskId);
  if (rows.length === 0) throw new Error(`Pilot task ${taskId} is not in the manifest schedule.`);
  const firstRepetition = Math.min(...rows.map(row => row.repetition));
  const selected = rows.filter(row => row.repetition === firstRepetition);
  if (
    selected.length !== 3 ||
    new Set(selected.map(row => manifest.blindAssignment[row.blindLabel])).size !== 3 ||
    selected.some(
      row => !expectedArms.includes(manifest.blindAssignment[row.blindLabel] as (typeof expectedArms)[number]),
    )
  ) {
    throw new Error('Pilot could not select exactly one first-repetition row per active arm.');
  }
  return [...selected].sort((left, right) => left.runOrder - right.runOrder);
}

const BASE_CONTINUATION_VARIANTS = ['files-bare', 'manual-handoff', 'threadnote-graph', 'threadnote-resume'] as const;
const CONTINUATION_VARIANTS = [...BASE_CONTINUATION_VARIANTS, 'threadnote-preloaded-resume'] as const;

type MatchedEvaluationContinuationVariantV1 = (typeof CONTINUATION_VARIANTS)[number];

export interface MatchedEvaluationContinuationTreatmentV1 {
  readonly automaticHandoffUri: string | null;
  readonly contextMode: 'brief' | 'resume' | null;
  readonly manualHandoff: string | null;
  readonly manualHandoffSha256: string | null;
  readonly resumeEvidenceMarker: string | null;
  readonly variant: MatchedEvaluationContinuationVariantV1;
}

export interface MatchedEvaluationContinuationPilotPlanV1 {
  readonly attempts: readonly {
    readonly blindLabel: 'A' | 'B' | 'C' | 'D' | 'E';
    readonly runNonce: string;
    readonly runOrder: number;
    readonly variant: MatchedEvaluationContinuationVariantV1;
  }[];
  readonly baseTaskPromptSha256: string;
  readonly candidate: {readonly toolArtifactHash: string; readonly toolVersion: string};
  readonly checkpoint: {
    readonly automaticHandoffUri: string;
    readonly handoff: string;
    readonly handoffSha256: string;
    readonly phaseOneAccounting: {
      readonly elapsedMilliseconds: number;
      readonly providerTokens: {
        readonly cachedInputTokens: number;
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly reasoningOutputTokens: number;
        readonly totalTokens: number;
      } | null;
      readonly providerTokensMeasured: boolean;
    };
    readonly repositoryFixtureHash: string;
    readonly repositoryRevision: string;
    readonly resumeEvidenceMarker: string;
    readonly automaticHandoffReadSha256: string;
  };
  readonly retries: 0;
  readonly taskId: string;
  readonly version: 1;
}

export interface MatchedEvaluationContinuationPilotPlanV2 {
  readonly attempts: MatchedEvaluationContinuationPilotPlanV1['attempts'];
  readonly candidate: MatchedEvaluationContinuationPilotPlanV1['candidate'];
  readonly checkpoint: MatchedEvaluationContinuationPilotPlanV1['checkpoint'] & {
    readonly adapterConfigurations: {
      readonly threadnoteCompactSha256: string;
      readonly threadnoteGraphSha256: string;
    };
    readonly phaseOnePatchSha256: string;
    readonly phaseOnePrompt: string;
    readonly phaseOnePromptSha256: string;
    readonly phaseOneExecution: {
      readonly adapterArtifactHash: string;
      readonly adapterConfigurationFileSha256: string;
      readonly adapterConfigurationHash: string;
      readonly adapterProtocol: string;
      readonly appServerExecutableSha256: string;
      readonly appServerVersion: string;
      readonly artifactSha256: string;
      readonly environmentPolicyHash: string;
      readonly model: {
        readonly id: string;
        readonly parametersHash: string;
        readonly provider: string;
        readonly reasoningEffort: string;
      };
      readonly requestSha256: string;
      readonly responseSha256: string;
      readonly runNonce: string;
      readonly transcriptHash: string;
      readonly transcriptSha256: string;
    };
    readonly preparedHome: {
      readonly fixtureHash: string;
      readonly identitySha256: string;
    };
    readonly preparedGraphHome: {
      readonly fixtureHash: string;
      readonly identitySha256: string;
    };
    readonly preparedContext: {
      readonly graphContentHash: string;
      readonly graphSnapshotHash: string;
      readonly linkReceiptsHash: string;
      readonly taskContextHash: string;
    };
  };
  readonly phaseTwoPrompt: string;
  readonly phaseTwoPromptSha256: string;
  readonly retries: 0;
  readonly sourceTask: {
    readonly prompt: string;
    readonly promptSha256: string;
    readonly repositoryFixtureHash: string;
    readonly repositoryRevision: string;
    readonly taskId: string;
  };
  readonly taskId: string;
  readonly version: 2;
}

export interface MatchedEvaluationContinuationPilotPlanV3 extends Omit<
  MatchedEvaluationContinuationPilotPlanV2,
  'version'
> {
  readonly phaseTwoVerification: MatchedContinuationPhaseTwoVerificationPlanV1;
  readonly version: 3;
}

export type MatchedEvaluationContinuationPilotPlanCurrent =
  MatchedEvaluationContinuationPilotPlanV2 | MatchedEvaluationContinuationPilotPlanV3;

export type MatchedEvaluationContinuationPilotPlan =
  MatchedEvaluationContinuationPilotPlanV1 | MatchedEvaluationContinuationPilotPlanCurrent;

export function parseMatchedEvaluationContinuationPhaseOneTaskPacketV1(
  value: unknown,
): MatchedEvaluationContinuationPhaseOneTaskPacketV1 {
  const packet = object(value, 'continuation phase-one task packet');
  exactKeys(
    packet,
    [
      'phaseOneAllowedPaths',
      'phaseOneDirective',
      'phaseOneFocusedChecks',
      'phaseTwoFocusedChecks',
      'phaseTwoPrompt',
      'repositoryName',
      'sourceRevision',
      'sourceTaskPrompt',
      'status',
      'taskKey',
      'version',
    ],
    'continuation phase-one task packet',
  );
  if (packet.version !== 1 || packet.status !== 'draft-unsealed') {
    invalid('continuation phase-one task packet version or status is invalid');
  }
  const paths = stringArray(packet.phaseOneAllowedPaths, 1, 16, 4_096, 'phase-one allowed paths');
  if (
    new Set(paths).size !== paths.length ||
    paths.some(path => isAbsolute(path) || path.startsWith('.') || path.split('/').some(segment => segment === '..'))
  ) {
    invalid('continuation phase-one allowed paths are invalid');
  }
  return {
    phaseOneAllowedPaths: paths,
    phaseOneDirective: boundedString(packet.phaseOneDirective, 1, 8_000, 'phase-one directive'),
    phaseOneFocusedChecks: stringArray(packet.phaseOneFocusedChecks, 1, 8, 4_096, 'phase-one focused checks'),
    phaseTwoFocusedChecks: stringArray(packet.phaseTwoFocusedChecks, 1, 8, 4_096, 'phase-two focused checks'),
    phaseTwoPrompt: boundedString(packet.phaseTwoPrompt, 1, 12_000, 'phase-two prompt'),
    repositoryName: matchingString(packet.repositoryName, /^[a-z0-9][a-z0-9._-]{1,127}$/u, 'repository name'),
    sourceRevision: matchingString(packet.sourceRevision, /^[0-9a-f]{40}$/u, 'source revision'),
    sourceTaskPrompt: boundedString(packet.sourceTaskPrompt, 1, 12_000, 'source task prompt'),
    status: packet.status,
    taskKey: matchingString(packet.taskKey, /^[a-z][a-z0-9-]{2,127}$/u, 'task key'),
    version: packet.version,
  };
}

export function createMatchedEvaluationContinuationPhaseOneSelectionV1(input: {
  readonly packet: MatchedEvaluationContinuationPhaseOneTaskPacketV1;
  readonly taskPacketSha256: string;
  readonly task: MatchedEvaluationManifestV1['tasks'][number];
  readonly taskPrompt: string;
  readonly repositoryRevision: string;
}): MatchedEvaluationContinuationPhaseOneSelectionV1 {
  if (input.packet.sourceTaskPrompt !== input.taskPrompt) {
    throw new Error('Continuation phase-one task packet differs from the frozen source prompt.');
  }
  if (input.packet.sourceRevision !== input.repositoryRevision) {
    throw new Error('Continuation phase-one task packet differs from the frozen source revision.');
  }
  const packetHash = matchingString(input.taskPacketSha256, HASH, 'phase-one task packet hash');
  const phaseOnePrompt = `${input.packet.sourceTaskPrompt}\n\n${input.packet.phaseOneDirective}`;
  const variants = CONTINUATION_VARIANTS.map(variant => ({
    score: sha256Bytes(
      Buffer.from(`matched-continuation-treatment-order-v1\0${packetHash}\0${input.task.taskId}\0${variant}`),
    ),
    variant,
  })).sort((left, right) => left.score.localeCompare(right.score));
  const labels = ['A', 'B', 'C', 'D', 'E'] as const;
  return {
    continuationAttempts: variants.map(({variant}, index) => ({
      blindLabel: labels[index],
      runNonce: `run_${sha256Bytes(
        Buffer.from(`matched-continuation-phase-two-run-v1\0${packetHash}\0${input.task.taskId}\0${variant}`),
      ).slice(0, 32)}`,
      runOrder: index + 1,
      variant,
    })),
    phaseOnePrompt,
    phaseOnePromptSha256: sha256Bytes(Buffer.from(phaseOnePrompt)),
    phaseOneRunNonce: `run_${sha256Bytes(
      Buffer.from(`matched-continuation-phase-one-run-v1\0${packetHash}\0${input.task.taskId}`),
    ).slice(0, 32)}`,
    sourceTask: {
      prompt: input.taskPrompt,
      promptSha256: input.task.promptHash,
      repositoryFixtureHash: input.task.repositoryFixtureHash,
      repositoryRevision: input.repositoryRevision,
      taskId: input.task.taskId,
    },
    taskPacket: input.packet,
    taskPacketSha256: packetHash,
    version: 1,
  };
}

export function parseMatchedEvaluationContinuationPhaseOneSelectionV1(
  value: unknown,
): MatchedEvaluationContinuationPhaseOneSelectionV1 {
  const selection = object(value, 'continuation phase-one selection');
  exactKeys(
    selection,
    [
      'continuationAttempts',
      'phaseOnePrompt',
      'phaseOnePromptSha256',
      'phaseOneRunNonce',
      'sourceTask',
      'taskPacket',
      'taskPacketSha256',
      'version',
    ],
    'continuation phase-one selection',
  );
  if (selection.version !== 1) invalid('continuation phase-one selection version is invalid');
  const taskPacket = parseMatchedEvaluationContinuationPhaseOneTaskPacketV1(selection.taskPacket);
  const phaseOnePrompt = boundedString(selection.phaseOnePrompt, 1, 20_000, 'continuation phase-one prompt');
  const expectedPhaseOnePrompt = `${taskPacket.sourceTaskPrompt}\n\n${taskPacket.phaseOneDirective}`;
  if (phaseOnePrompt !== expectedPhaseOnePrompt) invalid('continuation phase-one prompt differs from its packet');
  const phaseOnePromptSha256 = matchingString(
    selection.phaseOnePromptSha256,
    HASH,
    'continuation phase-one prompt hash',
  );
  if (phaseOnePromptSha256 !== sha256Bytes(Buffer.from(phaseOnePrompt))) {
    invalid('continuation phase-one prompt hash differs');
  }
  const sourceTask = object(selection.sourceTask, 'continuation phase-one source task');
  exactKeys(
    sourceTask,
    ['prompt', 'promptSha256', 'repositoryFixtureHash', 'repositoryRevision', 'taskId'],
    'continuation phase-one source task',
  );
  const sourcePrompt = boundedString(sourceTask.prompt, 1, 12_000, 'continuation phase-one source prompt');
  const parsedSourceTask = {
    prompt: sourcePrompt,
    promptSha256: matchingString(sourceTask.promptSha256, HASH, 'continuation phase-one source prompt hash'),
    repositoryFixtureHash: matchingString(
      sourceTask.repositoryFixtureHash,
      HASH,
      'continuation phase-one source fixture hash',
    ),
    repositoryRevision: matchingString(
      sourceTask.repositoryRevision,
      /^[0-9a-f]{40}$/u,
      'continuation phase-one source revision',
    ),
    taskId: matchingString(sourceTask.taskId, /^tsk_[0-9a-f]{16,64}$/u, 'continuation phase-one task id'),
  };
  if (
    parsedSourceTask.prompt !== taskPacket.sourceTaskPrompt ||
    parsedSourceTask.promptSha256 !== matchedEvaluationPromptHashV1(parsedSourceTask.prompt) ||
    parsedSourceTask.repositoryRevision !== taskPacket.sourceRevision
  ) {
    invalid('continuation phase-one source task differs from its packet');
  }
  const attempts = parseContinuationPhaseOneAttemptsV1(
    selection.continuationAttempts,
    'continuation phase-one attempts',
  );
  return {
    continuationAttempts: [...attempts].sort((left, right) => left.runOrder - right.runOrder),
    phaseOnePrompt,
    phaseOnePromptSha256,
    phaseOneRunNonce: matchingString(
      selection.phaseOneRunNonce,
      /^run_[0-9a-f]{32}$/u,
      'continuation phase-one run nonce',
    ),
    sourceTask: parsedSourceTask,
    taskPacket,
    taskPacketSha256: matchingString(selection.taskPacketSha256, HASH, 'continuation phase-one packet hash'),
    version: 1,
  };
}

export function parseMatchedEvaluationContinuationPhaseOneReceiptV1(
  value: unknown,
): MatchedEvaluationContinuationPhaseOneReceiptV1 {
  const receipt = object(value, 'continuation phase-one receipt');
  exactKeys(
    receipt,
    [
      'continuationAttempts',
      'evidenceSha256',
      'metrics',
      'phaseOnePromptSha256',
      'phaseOneRunNonce',
      'selectionSha256',
      'taskId',
      'taskPacketSha256',
      'transcriptHash',
      'version',
    ],
    'continuation phase-one receipt',
  );
  if (receipt.version !== 1) invalid('continuation phase-one receipt version is invalid');
  const evidence = object(receipt.evidenceSha256, 'continuation phase-one receipt evidence');
  exactKeys(
    evidence,
    [
      'adapterArtifactHash',
      'adapterConfigurationFileSha256',
      'artifactSha256',
      'requestSha256',
      'responseSha256',
      'transcriptSha256',
    ],
    'continuation phase-one receipt evidence',
  );
  const evidenceSha256 = {
    adapterArtifactHash: matchingString(evidence.adapterArtifactHash, HASH, 'phase-one receipt adapter hash'),
    adapterConfigurationFileSha256: matchingString(
      evidence.adapterConfigurationFileSha256,
      HASH,
      'phase-one receipt adapter config hash',
    ),
    artifactSha256: matchingString(evidence.artifactSha256, HASH, 'phase-one receipt artifact hash'),
    requestSha256: matchingString(evidence.requestSha256, HASH, 'phase-one receipt request hash'),
    responseSha256: matchingString(evidence.responseSha256, HASH, 'phase-one receipt response hash'),
    transcriptSha256: matchingString(evidence.transcriptSha256, HASH, 'phase-one receipt transcript hash'),
  };
  const transcriptHash = matchingString(receipt.transcriptHash, HASH, 'phase-one receipt transcript hash');
  const observation = parseMatchedEvaluationObservationV1({
    artifactHash: evidenceSha256.artifactSha256,
    metrics: receipt.metrics,
    transcriptHash,
    version: 5,
  });
  return {
    continuationAttempts: parseContinuationPhaseOneAttemptsV1(
      receipt.continuationAttempts,
      'continuation phase-one receipt attempts',
    ),
    evidenceSha256,
    metrics: observation.metrics,
    phaseOnePromptSha256: matchingString(receipt.phaseOnePromptSha256, HASH, 'phase-one receipt prompt hash'),
    phaseOneRunNonce: matchingString(receipt.phaseOneRunNonce, /^run_[0-9a-f]{32}$/u, 'phase-one receipt run nonce'),
    selectionSha256: matchingString(receipt.selectionSha256, HASH, 'phase-one receipt selection hash'),
    taskId: matchingString(receipt.taskId, /^tsk_[0-9a-f]{16,64}$/u, 'phase-one receipt task id'),
    taskPacketSha256: matchingString(receipt.taskPacketSha256, HASH, 'phase-one receipt task packet hash'),
    transcriptHash,
    version: 1,
  };
}

export function assertMatchedEvaluationContinuationPhaseOneReceiptV1(input: {
  readonly evidenceSha256: MatchedEvaluationContinuationPhaseOneReceiptV1['evidenceSha256'];
  readonly receipt: MatchedEvaluationContinuationPhaseOneReceiptV1;
  readonly responseObservation: ReturnType<typeof parseMatchedEvaluationObservationV1>;
  readonly selection: MatchedEvaluationContinuationPhaseOneSelectionV1;
  readonly selectionSha256: string;
}): void {
  if (
    JSON.stringify(input.receipt.continuationAttempts) !== JSON.stringify(input.selection.continuationAttempts) ||
    JSON.stringify(input.receipt.evidenceSha256) !== JSON.stringify(input.evidenceSha256) ||
    JSON.stringify(input.receipt.metrics) !== JSON.stringify(input.responseObservation.metrics) ||
    input.receipt.phaseOnePromptSha256 !== input.selection.phaseOnePromptSha256 ||
    input.receipt.phaseOneRunNonce !== input.selection.phaseOneRunNonce ||
    input.receipt.selectionSha256 !== input.selectionSha256 ||
    input.receipt.taskId !== input.selection.sourceTask.taskId ||
    input.receipt.taskPacketSha256 !== input.selection.taskPacketSha256 ||
    input.receipt.transcriptHash !== input.responseObservation.transcriptHash ||
    input.responseObservation.artifactHash !== input.receipt.evidenceSha256.artifactSha256 ||
    input.responseObservation.transcriptHash !== input.receipt.evidenceSha256.transcriptSha256
  ) {
    throw new Error('Continuation phase-one receipt differs from the sealed selection or preserved evidence.');
  }
}

function parseContinuationPhaseOneAttemptsV1(
  value: unknown,
  label: string,
): MatchedEvaluationContinuationPhaseOneSelectionV1['continuationAttempts'] {
  const attempts = array(value, label).map((entry, index) => {
    const attempt = object(entry, `${label} entry ${index}`);
    exactKeys(attempt, ['blindLabel', 'runNonce', 'runOrder', 'variant'], `${label} entry ${index}`);
    return {
      blindLabel: literal(attempt.blindLabel, ['A', 'B', 'C', 'D', 'E'] as const, `${label} entry ${index} label`),
      runNonce: matchingString(attempt.runNonce, /^run_[0-9a-f]{32}$/u, `${label} entry ${index} nonce`),
      runOrder: boundedPositiveInteger(attempt.runOrder, 1, 5, `${label} entry ${index} order`),
      variant: literal(attempt.variant, CONTINUATION_VARIANTS, `${label} entry ${index} variant`),
    };
  });
  const expectedVariants =
    attempts.length === BASE_CONTINUATION_VARIANTS.length
      ? BASE_CONTINUATION_VARIANTS
      : attempts.length === CONTINUATION_VARIANTS.length
        ? CONTINUATION_VARIANTS
        : null;
  if (
    expectedVariants === null ||
    new Set(attempts.map(attempt => attempt.blindLabel)).size !== expectedVariants.length ||
    new Set(attempts.map(attempt => attempt.runNonce)).size !== expectedVariants.length ||
    new Set(attempts.map(attempt => attempt.runOrder)).size !== expectedVariants.length ||
    new Set(attempts.map(attempt => attempt.variant)).size !== expectedVariants.length ||
    expectedVariants.some(variant => !attempts.some(attempt => attempt.variant === variant))
  ) {
    invalid(`${label} must contain the complete four- or five-treatment set`);
  }
  return [...attempts].sort((left, right) => left.runOrder - right.runOrder);
}

export interface MatchedEvaluationContinuationSupplementV1 {
  readonly adapterArtifactSha256: string;
  readonly parentReportSha256: string;
  readonly parentSelectionSha256: string;
  readonly parentVariants: readonly (typeof BASE_CONTINUATION_VARIANTS)[number][];
  readonly variant: 'threadnote-preloaded-resume';
  readonly version: 1;
}

export function parseMatchedEvaluationContinuationPilotPlanV1(value: unknown): MatchedEvaluationContinuationPilotPlan {
  const plan = object(value, 'continuation pilot plan');
  const version = plan.version;
  if (version !== 1 && version !== 2 && version !== 3) invalid('continuation pilot plan version is invalid');
  exactKeys(
    plan,
    version === 1
      ? ['attempts', 'baseTaskPromptSha256', 'candidate', 'checkpoint', 'retries', 'taskId', 'version']
      : [
          'attempts',
          'candidate',
          'checkpoint',
          'phaseTwoPrompt',
          'phaseTwoPromptSha256',
          ...(version === 3 ? ['phaseTwoVerification'] : []),
          'retries',
          'sourceTask',
          'taskId',
          'version',
        ],
    'continuation pilot plan',
  );
  if (plan.retries !== 0) invalid('continuation pilot retries must be zero');
  const candidate = object(plan.candidate, 'continuation pilot candidate');
  exactKeys(candidate, ['toolArtifactHash', 'toolVersion'], 'continuation pilot candidate');
  const checkpoint = object(plan.checkpoint, 'continuation pilot checkpoint');
  exactKeys(
    checkpoint,
    [
      'automaticHandoffReadSha256',
      'automaticHandoffUri',
      'handoff',
      'handoffSha256',
      'phaseOneAccounting',
      ...(version !== 1
        ? [
            'adapterConfigurations',
            'phaseOneExecution',
            'phaseOnePatchSha256',
            'phaseOnePrompt',
            'phaseOnePromptSha256',
            'preparedContext',
            'preparedGraphHome',
            'preparedHome',
          ]
        : []),
      'repositoryFixtureHash',
      'repositoryRevision',
      'resumeEvidenceMarker',
    ],
    'continuation pilot checkpoint',
  );
  const handoff = boundedString(checkpoint.handoff, 1, 16 * 1_024, 'continuation pilot handoff');
  const handoffSha256 = matchingString(checkpoint.handoffSha256, HASH, 'continuation pilot handoff hash');
  if (sha256Bytes(Buffer.from(handoff)) !== handoffSha256) invalid('continuation pilot handoff hash differs');
  for (const heading of ['Task:', 'Decisions:', 'Constraints:', 'Rationale:', 'Verification:', 'Next step:']) {
    if (!handoff.includes(heading)) invalid(`continuation pilot handoff lacks ${heading}`);
  }
  const resumeEvidenceMarker = boundedString(
    checkpoint.resumeEvidenceMarker,
    8,
    256,
    'continuation pilot resume evidence marker',
  );
  if (!handoff.includes(resumeEvidenceMarker)) invalid('continuation pilot handoff lacks its resume evidence marker');
  const phaseOneAccounting = object(checkpoint.phaseOneAccounting, 'continuation pilot phase-one accounting');
  exactKeys(
    phaseOneAccounting,
    ['elapsedMilliseconds', 'providerTokens', 'providerTokensMeasured'],
    'continuation pilot phase-one accounting',
  );
  if (typeof phaseOneAccounting.providerTokensMeasured !== 'boolean') {
    invalid('continuation pilot phase-one provider-token measurement flag is invalid');
  }
  const parsedProviderTokens = (() => {
    if (phaseOneAccounting.providerTokens === null) {
      if (phaseOneAccounting.providerTokensMeasured) {
        invalid('continuation pilot measured phase-one provider tokens are missing');
      }
      return null;
    }
    if (!phaseOneAccounting.providerTokensMeasured) {
      invalid('continuation pilot unmeasured phase-one provider tokens must be null');
    }
    const providerTokens = object(phaseOneAccounting.providerTokens, 'continuation pilot phase-one provider tokens');
    exactKeys(
      providerTokens,
      ['cachedInputTokens', 'inputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'],
      'continuation pilot phase-one provider tokens',
    );
    const parsed = {
      cachedInputTokens: boundedNonnegativeInteger(
        providerTokens.cachedInputTokens,
        10_000_000,
        'phase-one cached input tokens',
      ),
      inputTokens: boundedNonnegativeInteger(providerTokens.inputTokens, 10_000_000, 'phase-one input tokens'),
      outputTokens: boundedNonnegativeInteger(providerTokens.outputTokens, 10_000_000, 'phase-one output tokens'),
      reasoningOutputTokens: boundedNonnegativeInteger(
        providerTokens.reasoningOutputTokens,
        10_000_000,
        'phase-one reasoning output tokens',
      ),
      totalTokens: boundedNonnegativeInteger(providerTokens.totalTokens, 10_000_000, 'phase-one total tokens'),
    };
    if (
      parsed.cachedInputTokens > parsed.inputTokens ||
      parsed.reasoningOutputTokens > parsed.outputTokens ||
      parsed.totalTokens !== parsed.inputTokens + parsed.outputTokens
    ) {
      invalid('continuation pilot phase-one token components are inconsistent');
    }
    return parsed;
  })();
  const attempts = array(plan.attempts, 'continuation pilot attempts').map((entry, index) => {
    const attempt = object(entry, `continuation pilot attempt ${index}`);
    exactKeys(attempt, ['blindLabel', 'runNonce', 'runOrder', 'variant'], `continuation pilot attempt ${index}`);
    return {
      blindLabel: literal(
        attempt.blindLabel,
        ['A', 'B', 'C', 'D', 'E'] as const,
        `continuation pilot attempt ${index} blind label`,
      ),
      runNonce: matchingString(attempt.runNonce, /^run_[0-9a-f]{32}$/u, `continuation pilot attempt ${index} nonce`),
      runOrder: boundedPositiveInteger(attempt.runOrder, 1, 5, `continuation pilot attempt ${index} order`),
      variant: literal(attempt.variant, CONTINUATION_VARIANTS, `continuation pilot attempt ${index} variant`),
    };
  });
  const expectedVariants =
    attempts.length === BASE_CONTINUATION_VARIANTS.length
      ? BASE_CONTINUATION_VARIANTS
      : attempts.length === CONTINUATION_VARIANTS.length
        ? CONTINUATION_VARIANTS
        : null;
  if (
    expectedVariants === null ||
    new Set(attempts.map(attempt => attempt.variant)).size !== expectedVariants.length ||
    expectedVariants.some(variant => !attempts.some(attempt => attempt.variant === variant)) ||
    new Set(attempts.map(attempt => attempt.runNonce)).size !== attempts.length ||
    new Set(attempts.map(attempt => attempt.blindLabel)).size !== attempts.length ||
    new Set(attempts.map(attempt => attempt.runOrder)).size !== attempts.length
  ) {
    invalid('continuation pilot must contain one unique attempt per variant');
  }
  const common = {
    attempts: [...attempts].sort((left, right) => left.runOrder - right.runOrder),
    candidate: {
      toolArtifactHash: matchingString(candidate.toolArtifactHash, HASH, 'continuation pilot tool artifact hash'),
      toolVersion: boundedString(candidate.toolVersion, 1, 128, 'continuation pilot tool version'),
    },
    checkpoint: {
      automaticHandoffUri: boundedString(
        checkpoint.automaticHandoffUri,
        1,
        2_048,
        'continuation pilot automatic handoff URI',
      ),
      handoff,
      handoffSha256,
      phaseOneAccounting: {
        elapsedMilliseconds: boundedNonnegativeInteger(
          phaseOneAccounting.elapsedMilliseconds,
          86_400_000,
          'phase-one elapsed milliseconds',
        ),
        providerTokens: parsedProviderTokens,
        providerTokensMeasured: phaseOneAccounting.providerTokensMeasured,
      },
      repositoryFixtureHash: matchingString(
        checkpoint.repositoryFixtureHash,
        HASH,
        'continuation pilot repository fixture hash',
      ),
      repositoryRevision: matchingString(
        checkpoint.repositoryRevision,
        /^[0-9a-f]{40}$/u,
        'continuation pilot repository revision',
      ),
      resumeEvidenceMarker,
      automaticHandoffReadSha256: matchingString(
        checkpoint.automaticHandoffReadSha256,
        HASH,
        'continuation pilot automatic handoff read hash',
      ),
    },
    retries: 0 as const,
    taskId: matchingString(plan.taskId, /^tsk_[0-9a-f]{16,64}$/u, 'continuation pilot task id'),
  };
  if (version === 1) {
    return {
      ...common,
      baseTaskPromptSha256: matchingString(plan.baseTaskPromptSha256, HASH, 'continuation pilot task prompt hash'),
      version,
    };
  }
  if (!common.checkpoint.phaseOneAccounting.providerTokensMeasured) {
    invalid('continuation pilot v2 requires measured phase-one provider tokens');
  }
  const phaseOnePrompt = boundedString(checkpoint.phaseOnePrompt, 1, 12_000, 'continuation pilot phase-one prompt');
  const phaseOnePromptSha256 = matchingString(
    checkpoint.phaseOnePromptSha256,
    HASH,
    'continuation pilot phase-one prompt hash',
  );
  if (sha256Bytes(Buffer.from(phaseOnePrompt)) !== phaseOnePromptSha256) {
    invalid('continuation pilot phase-one prompt hash differs');
  }
  const phaseTwoPrompt = boundedString(plan.phaseTwoPrompt, 1, 12_000, 'continuation pilot phase-two prompt');
  const phaseTwoPromptSha256 = matchingString(
    plan.phaseTwoPromptSha256,
    HASH,
    'continuation pilot phase-two prompt hash',
  );
  if (sha256Bytes(Buffer.from(phaseTwoPrompt)) !== phaseTwoPromptSha256) {
    invalid('continuation pilot phase-two prompt hash differs');
  }
  const sourceTask = object(plan.sourceTask, 'continuation pilot source task');
  exactKeys(
    sourceTask,
    ['prompt', 'promptSha256', 'repositoryFixtureHash', 'repositoryRevision', 'taskId'],
    'continuation pilot source task',
  );
  const sourcePrompt = boundedString(sourceTask.prompt, 1, 12_000, 'continuation pilot source task prompt');
  const sourcePromptSha256 = matchingString(
    sourceTask.promptSha256,
    HASH,
    'continuation pilot source task prompt hash',
  );
  if (matchedEvaluationPromptHashV1(sourcePrompt) !== sourcePromptSha256) {
    invalid('continuation pilot source task prompt hash differs');
  }
  const parsedSourceTask = {
    prompt: sourcePrompt,
    promptSha256: sourcePromptSha256,
    repositoryFixtureHash: matchingString(
      sourceTask.repositoryFixtureHash,
      HASH,
      'continuation pilot source repository fixture hash',
    ),
    repositoryRevision: matchingString(
      sourceTask.repositoryRevision,
      /^[0-9a-f]{40}$/u,
      'continuation pilot source repository revision',
    ),
    taskId: matchingString(sourceTask.taskId, /^tsk_[0-9a-f]{16,64}$/u, 'continuation pilot source task id'),
  };
  if (parsedSourceTask.taskId !== common.taskId) invalid('continuation pilot source task id differs');
  if (parsedSourceTask.repositoryRevision === common.checkpoint.repositoryRevision) {
    invalid('continuation pilot v2 checkpoint must differ from the source revision');
  }
  if (parsedSourceTask.repositoryFixtureHash === common.checkpoint.repositoryFixtureHash) {
    invalid('continuation pilot v2 checkpoint fixture must differ from the source fixture');
  }
  if (phaseOnePrompt === phaseTwoPrompt || parsedSourceTask.prompt === phaseTwoPrompt) {
    invalid('continuation pilot phase prompts must be distinct');
  }
  if (!phaseOnePrompt.includes(parsedSourceTask.prompt)) {
    invalid('continuation pilot phase-one prompt must include the exact source task prompt');
  }
  const current = {
    ...common,
    checkpoint: {
      ...common.checkpoint,
      adapterConfigurations: parseContinuationAdapterConfigurationsV2(checkpoint.adapterConfigurations),
      phaseOnePatchSha256: matchingString(
        checkpoint.phaseOnePatchSha256,
        HASH,
        'continuation pilot phase-one patch hash',
      ),
      phaseOneExecution: parseContinuationPhaseOneExecutionV2(checkpoint.phaseOneExecution),
      phaseOnePrompt,
      phaseOnePromptSha256,
      preparedContext: parseContinuationPreparedContextV2(checkpoint.preparedContext),
      preparedGraphHome: parseContinuationPreparedHomeV2(
        checkpoint.preparedGraphHome,
        'continuation pilot prepared graph home',
      ),
      preparedHome: parseContinuationPreparedHomeV2(checkpoint.preparedHome, 'continuation pilot prepared home'),
    },
    phaseTwoPrompt,
    phaseTwoPromptSha256,
    sourceTask: parsedSourceTask,
  };
  if (version === 2) {
    return {...current, version};
  }
  const phaseTwoVerification = parseMatchedContinuationPhaseTwoVerificationPlanV1(plan.phaseTwoVerification);
  if (phaseTwoVerification.taskId !== common.taskId) {
    invalid('continuation pilot phase-two verification task id differs');
  }
  return {
    ...current,
    phaseTwoVerification,
    version,
  };
}

/** Verify that a fifth treatment extends, rather than reruns, one completed four-arm pilot. */
export function assertMatchedEvaluationContinuationSupplementV1(input: {
  readonly adapterArtifactSha256: string;
  readonly parentReport: unknown;
  readonly parentReportSha256: string;
  readonly parentSelection: unknown;
  readonly parentSelectionSha256: string;
  readonly plan: MatchedEvaluationContinuationPilotPlan;
}): MatchedEvaluationContinuationSupplementV1 {
  if (input.plan.attempts.length !== CONTINUATION_VARIANTS.length) {
    throw new Error('Continuation supplement requires a five-treatment sealed plan.');
  }
  const supplement = input.plan.attempts.find(attempt => attempt.variant === 'threadnote-preloaded-resume');
  if (supplement === undefined || supplement.blindLabel !== 'E' || supplement.runOrder !== 5) {
    throw new Error('Continuation supplement must reserve label E and order 5 for preloaded resume.');
  }
  const selection = object(input.parentSelection, 'continuation supplement parent selection');
  const report = object(input.parentReport, 'continuation supplement parent report');
  const selectionRows = array(selection.rows, 'continuation supplement parent rows');
  const reportRows = array(report.rows, 'continuation supplement report rows');
  const reportAttempts = array(report.attempts, 'continuation supplement parent attempts');
  if (
    report.completed !== true ||
    selection.comparativeClaimsEligible !== false ||
    report.comparativeClaimsEligible !== false ||
    selection.version !== 1 ||
    report.version !== 1 ||
    selection.taskId !== input.plan.taskId ||
    report.taskId !== input.plan.taskId
  ) {
    throw new Error('Continuation supplement parent is not one completed non-comparative pilot.');
  }
  for (const field of ['candidate', 'checkpoint'] as const) {
    const expected =
      field === 'candidate'
        ? input.plan.candidate
        : projectMatchedEvaluationContinuationSelectionCheckpointV1(input.plan);
    if (!sameJson(selection[field], expected) || !sameJson(report[field], expected)) {
      throw new Error(`Continuation supplement parent ${field} differs from the sealed plan.`);
    }
  }
  if (
    !sameJson(report.identities, selection.identities) ||
    !sameJson(reportRows, selectionRows) ||
    selectionRows.length !== BASE_CONTINUATION_VARIANTS.length ||
    reportAttempts.length !== BASE_CONTINUATION_VARIANTS.length
  ) {
    throw new Error('Continuation supplement parent selection and report differ.');
  }
  const parentVariants = selectionRows.map((entry, index) => {
    const row = object(entry, `continuation supplement parent row ${index}`);
    const attempt = object(reportAttempts[index], `continuation supplement parent attempt ${index}`);
    const variant = literal(
      row.variant,
      BASE_CONTINUATION_VARIANTS,
      `continuation supplement parent row ${index} variant`,
    );
    const planned = input.plan.attempts.find(candidate => candidate.variant === variant);
    if (
      planned === undefined ||
      row.taskId !== input.plan.taskId ||
      row.blindLabel !== planned.blindLabel ||
      row.runNonce !== planned.runNonce ||
      row.runOrder !== planned.runOrder ||
      attempt.status !== 'completed' ||
      attempt.variant !== variant ||
      attempt.runNonce !== planned.runNonce ||
      attempt.runOrder !== planned.runOrder ||
      attempt.arm !== row.arm
    ) {
      throw new Error('Continuation supplement parent attempt differs from its sealed completed row.');
    }
    return variant;
  });
  if (
    new Set(parentVariants).size !== BASE_CONTINUATION_VARIANTS.length ||
    BASE_CONTINUATION_VARIANTS.some(variant => !parentVariants.includes(variant))
  ) {
    throw new Error('Continuation supplement parent does not contain the four baseline variants.');
  }
  return {
    adapterArtifactSha256: matchingString(
      input.adapterArtifactSha256,
      HASH,
      'continuation supplement adapter artifact hash',
    ),
    parentReportSha256: matchingString(input.parentReportSha256, HASH, 'continuation supplement parent report hash'),
    parentSelectionSha256: matchingString(
      input.parentSelectionSha256,
      HASH,
      'continuation supplement parent selection hash',
    ),
    parentVariants,
    variant: 'threadnote-preloaded-resume',
    version: 1,
  };
}

function parseContinuationPhaseOneExecutionV2(
  value: unknown,
): MatchedEvaluationContinuationPilotPlanV2['checkpoint']['phaseOneExecution'] {
  const execution = object(value, 'continuation pilot phase-one execution');
  exactKeys(
    execution,
    [
      'adapterArtifactHash',
      'adapterConfigurationFileSha256',
      'adapterConfigurationHash',
      'adapterProtocol',
      'appServerExecutableSha256',
      'appServerVersion',
      'artifactSha256',
      'environmentPolicyHash',
      'model',
      'requestSha256',
      'responseSha256',
      'runNonce',
      'transcriptHash',
      'transcriptSha256',
    ],
    'continuation pilot phase-one execution',
  );
  const model = object(execution.model, 'continuation pilot phase-one model');
  exactKeys(model, ['id', 'parametersHash', 'provider', 'reasoningEffort'], 'continuation pilot phase-one model');
  return {
    adapterArtifactHash: matchingString(
      execution.adapterArtifactHash,
      HASH,
      'continuation pilot phase-one adapter artifact hash',
    ),
    adapterConfigurationFileSha256: matchingString(
      execution.adapterConfigurationFileSha256,
      HASH,
      'continuation pilot phase-one adapter configuration file hash',
    ),
    adapterConfigurationHash: matchingString(
      execution.adapterConfigurationHash,
      HASH,
      'continuation pilot phase-one adapter configuration hash',
    ),
    adapterProtocol: boundedString(execution.adapterProtocol, 1, 128, 'continuation pilot phase-one adapter protocol'),
    appServerExecutableSha256: matchingString(
      execution.appServerExecutableSha256,
      HASH,
      'continuation pilot phase-one app-server executable hash',
    ),
    appServerVersion: boundedString(
      execution.appServerVersion,
      1,
      128,
      'continuation pilot phase-one app-server version',
    ),
    artifactSha256: matchingString(execution.artifactSha256, HASH, 'continuation pilot phase-one artifact hash'),
    environmentPolicyHash: matchingString(
      execution.environmentPolicyHash,
      HASH,
      'continuation pilot phase-one environment policy hash',
    ),
    model: {
      id: boundedString(model.id, 1, 128, 'continuation pilot phase-one model id'),
      parametersHash: matchingString(model.parametersHash, HASH, 'continuation pilot phase-one model parameters hash'),
      provider: boundedString(model.provider, 1, 128, 'continuation pilot phase-one model provider'),
      reasoningEffort: boundedString(model.reasoningEffort, 1, 64, 'continuation pilot phase-one reasoning effort'),
    },
    requestSha256: matchingString(execution.requestSha256, HASH, 'continuation pilot phase-one request hash'),
    responseSha256: matchingString(execution.responseSha256, HASH, 'continuation pilot phase-one response hash'),
    runNonce: matchingString(execution.runNonce, /^run_[0-9a-f]{32}$/u, 'continuation pilot phase-one run nonce'),
    transcriptHash: matchingString(execution.transcriptHash, HASH, 'continuation pilot phase-one transcript hash'),
    transcriptSha256: matchingString(execution.transcriptSha256, HASH, 'continuation pilot phase-one transcript hash'),
  };
}

function parseContinuationPreparedContextV2(
  value: unknown,
): MatchedEvaluationContinuationPilotPlanV2['checkpoint']['preparedContext'] {
  const context = object(value, 'continuation pilot prepared context');
  exactKeys(
    context,
    ['graphContentHash', 'graphSnapshotHash', 'linkReceiptsHash', 'taskContextHash'],
    'continuation pilot prepared context',
  );
  return {
    graphContentHash: matchingString(context.graphContentHash, HASH, 'continuation pilot graph content hash'),
    graphSnapshotHash: matchingString(context.graphSnapshotHash, HASH, 'continuation pilot graph snapshot hash'),
    linkReceiptsHash: matchingString(context.linkReceiptsHash, HASH, 'continuation pilot link receipts hash'),
    taskContextHash: matchingString(context.taskContextHash, HASH, 'continuation pilot task context hash'),
  };
}

function parseContinuationAdapterConfigurationsV2(
  value: unknown,
): MatchedEvaluationContinuationPilotPlanV2['checkpoint']['adapterConfigurations'] {
  const configurations = object(value, 'continuation pilot checkpoint adapter configurations');
  exactKeys(
    configurations,
    ['threadnoteCompactSha256', 'threadnoteGraphSha256'],
    'continuation pilot checkpoint adapter configurations',
  );
  return {
    threadnoteCompactSha256: matchingString(
      configurations.threadnoteCompactSha256,
      HASH,
      'continuation pilot compact adapter configuration hash',
    ),
    threadnoteGraphSha256: matchingString(
      configurations.threadnoteGraphSha256,
      HASH,
      'continuation pilot graph adapter configuration hash',
    ),
  };
}

function parseContinuationPreparedHomeV2(
  value: unknown,
  label: string,
): MatchedEvaluationContinuationPilotPlanV2['checkpoint']['preparedHome'] {
  const home = object(value, label);
  exactKeys(home, ['fixtureHash', 'identitySha256'], label);
  return {
    fixtureHash: matchingString(home.fixtureHash, HASH, `${label} fixture hash`),
    identitySha256: matchingString(home.identitySha256, HASH, `${label} identity hash`),
  };
}

/** Bind the v2 phase-one claims to immutable sibling evidence before any phase-two attempt starts. */
export async function assertMatchedEvaluationContinuationPhaseOneEvidenceV2(input: {
  readonly plan: MatchedEvaluationContinuationPilotPlanCurrent;
  readonly planPath: string;
}): Promise<{readonly agentPatch: string}> {
  const evidenceDirectory = join(dirname(input.planPath), 'phase-one');
  const paths = {
    adapter: join(evidenceDirectory, 'adapter'),
    adapterConfig: join(evidenceDirectory, 'adapter-config.json'),
    artifact: join(evidenceDirectory, 'artifact.json'),
    request: join(evidenceDirectory, 'request.json'),
    response: join(evidenceDirectory, 'response.json'),
    transcript: join(evidenceDirectory, 'transcript.jsonl'),
  };
  const execution = input.plan.checkpoint.phaseOneExecution;
  const [
    adapterArtifactHash,
    adapterConfigurationFileSha256,
    artifactSha256,
    requestSha256,
    responseSha256,
    transcriptSha256,
    configInput,
    artifactInput,
    requestInput,
    responseInput,
  ] = await Promise.all([
    boundedRegularFileHash(paths.adapter, 128 * 1_024 * 1_024, 'continuation phase-one adapter'),
    boundedRegularFileHash(paths.adapterConfig, MAXIMUM_JSON_BYTES, 'continuation phase-one adapter config'),
    boundedRegularFileHash(paths.artifact, MAXIMUM_JSON_BYTES, 'continuation phase-one artifact'),
    boundedRegularFileHash(paths.request, MAXIMUM_JSON_BYTES, 'continuation phase-one request'),
    boundedRegularFileHash(paths.response, MAXIMUM_JSON_BYTES, 'continuation phase-one response'),
    boundedRegularFileHash(paths.transcript, MAXIMUM_TRANSCRIPT_BYTES, 'continuation phase-one transcript'),
    readJson(paths.adapterConfig),
    readJson(paths.artifact),
    readJson(paths.request),
    readJson(paths.response),
  ]);
  const observedHashes = {
    adapterArtifactHash,
    adapterConfigurationFileSha256,
    artifactSha256,
    requestSha256,
    responseSha256,
    transcriptSha256,
  };
  for (const [field, value] of Object.entries(observedHashes)) {
    if (execution[field as keyof typeof observedHashes] !== value) {
      throw new Error(`Continuation phase-one evidence differs: ${field}.`);
    }
  }
  const config = object(configInput, 'continuation phase-one adapter config');
  const appServer = object(config.appServer, 'continuation phase-one app server');
  const configModel = object(config.model, 'continuation phase-one config model');
  if (
    appServer.executableSha256 !== execution.appServerExecutableSha256 ||
    appServer.version !== execution.appServerVersion ||
    execution.adapterConfigurationFileSha256 !== execution.adapterConfigurationHash ||
    config.environmentPolicyHash !== execution.environmentPolicyHash ||
    configModel.id !== execution.model.id ||
    configModel.parametersHash !== execution.model.parametersHash ||
    configModel.provider !== execution.model.provider ||
    configModel.reasoningEffort !== execution.model.reasoningEffort
  ) {
    throw new Error('Continuation phase-one adapter config differs from the sealed execution identity.');
  }
  const request = object(requestInput, 'continuation phase-one request');
  const agentTask = object(request.agentTask, 'continuation phase-one agent task');
  const requestModel = object(request.model, 'continuation phase-one request model');
  if (
    request.adapterArtifactHash !== execution.adapterArtifactHash ||
    request.adapterConfigurationHash !== execution.adapterConfigurationHash ||
    request.adapterProtocol !== execution.adapterProtocol ||
    request.environmentPolicyHash !== execution.environmentPolicyHash ||
    request.runNonce !== execution.runNonce ||
    agentTask.prompt !== input.plan.checkpoint.phaseOnePrompt ||
    agentTask.repositoryFixtureHash !== input.plan.sourceTask.repositoryFixtureHash ||
    agentTask.taskId !== input.plan.taskId ||
    requestModel.model !== execution.model.id ||
    requestModel.parametersHash !== execution.model.parametersHash ||
    requestModel.provider !== execution.model.provider
  ) {
    throw new Error('Continuation phase-one request differs from the sealed execution identity.');
  }
  const artifact = object(artifactInput, 'continuation phase-one artifact');
  const agentResult = object(artifact.agentResult, 'continuation phase-one agent result');
  const artifactRepository = object(artifact.repository, 'continuation phase-one artifact repository');
  if (
    artifact.runNonce !== execution.runNonce ||
    artifact.taskId !== input.plan.taskId ||
    artifactRepository.fixtureHash !== input.plan.sourceTask.repositoryFixtureHash ||
    artifactRepository.revision !== input.plan.sourceTask.repositoryRevision ||
    typeof artifact.patch !== 'string' ||
    artifact.patch.length === 0
  ) {
    throw new Error('Continuation phase-one artifact differs from the sealed source task or contains no patch.');
  }
  const response = object(responseInput, 'continuation phase-one response');
  const metrics = object(response.metrics, 'continuation phase-one response metrics');
  const safety = object(metrics.safety, 'continuation phase-one response safety');
  const timing = object(metrics.timing, 'continuation phase-one response timing');
  const usage = object(metrics.usage, 'continuation phase-one response usage');
  const providerTokens = object(usage.providerTokens, 'continuation phase-one provider tokens');
  let independentlyAttestedExpectedFailure = false;
  if (agentResult.completed === false) {
    const completion = object(metrics.completion, 'continuation phase-one response completion');
    const validity = object(metrics.validity, 'continuation phase-one response validity');
    const verification = object(metrics.verification, 'continuation phase-one response verification');
    independentlyAttestedExpectedFailure =
      completion.completed === false &&
      validity.valid === true &&
      verification.taskId === input.plan.taskId &&
      verification.status === 'task-failed' &&
      verification.exitCode === 1;
  }
  if (agentResult.completed !== true && !independentlyAttestedExpectedFailure) {
    throw new Error('Continuation phase-one agent result lacks an independently attested expected failure.');
  }
  if (
    (safety.blockedActions !== 0 && !independentlyAttestedExpectedFailure) ||
    response.transcriptHash !== execution.transcriptHash ||
    timing.endToEndMilliseconds !== input.plan.checkpoint.phaseOneAccounting.elapsedMilliseconds ||
    providerTokens.cachedInputTokens !== input.plan.checkpoint.phaseOneAccounting.providerTokens?.cachedInputTokens ||
    providerTokens.inputTokens !== input.plan.checkpoint.phaseOneAccounting.providerTokens?.inputTokens ||
    providerTokens.outputTokens !== input.plan.checkpoint.phaseOneAccounting.providerTokens?.outputTokens ||
    providerTokens.reasoningOutputTokens !==
      input.plan.checkpoint.phaseOneAccounting.providerTokens?.reasoningOutputTokens ||
    providerTokens.totalTokens !== input.plan.checkpoint.phaseOneAccounting.providerTokens?.totalTokens
  ) {
    throw new Error('Continuation phase-one accounting differs from the sealed response.');
  }
  return {agentPatch: artifact.patch};
}

function continuationTreatment(
  variant: MatchedEvaluationContinuationVariantV1,
  checkpoint: Pick<
    MatchedEvaluationContinuationPilotPlan['checkpoint'],
    'automaticHandoffUri' | 'handoff' | 'handoffSha256' | 'resumeEvidenceMarker'
  >,
): {readonly arm: MatchedEvaluationArm; readonly treatment: MatchedEvaluationContinuationTreatmentV1} {
  switch (variant) {
    case 'files-bare':
      return {
        arm: 'files',
        treatment: {
          automaticHandoffUri: null,
          contextMode: null,
          manualHandoff: null,
          manualHandoffSha256: null,
          resumeEvidenceMarker: null,
          variant,
        },
      };
    case 'manual-handoff':
      return {
        arm: 'files',
        treatment: {
          automaticHandoffUri: null,
          contextMode: null,
          manualHandoff: checkpoint.handoff,
          manualHandoffSha256: checkpoint.handoffSha256,
          resumeEvidenceMarker: null,
          variant,
        },
      };
    case 'threadnote-graph':
      return {
        arm: 'threadnote-graph',
        treatment: {
          automaticHandoffUri: null,
          contextMode: 'brief',
          manualHandoff: null,
          manualHandoffSha256: null,
          resumeEvidenceMarker: null,
          variant,
        },
      };
    case 'threadnote-resume':
      return {
        arm: 'threadnote-compact',
        treatment: {
          automaticHandoffUri: checkpoint.automaticHandoffUri,
          contextMode: 'resume',
          manualHandoff: null,
          manualHandoffSha256: null,
          resumeEvidenceMarker: checkpoint.resumeEvidenceMarker,
          variant,
        },
      };
    case 'threadnote-preloaded-resume':
      return {
        arm: 'threadnote-compact',
        treatment: {
          automaticHandoffUri: checkpoint.automaticHandoffUri,
          contextMode: 'resume',
          manualHandoff: null,
          manualHandoffSha256: null,
          resumeEvidenceMarker: checkpoint.resumeEvidenceMarker,
          variant,
        },
      };
  }
}

export function projectMatchedEvaluationContinuationSelectionCheckpointV1(
  plan: MatchedEvaluationContinuationPilotPlan,
) {
  return {
    automaticHandoffUri: plan.checkpoint.automaticHandoffUri,
    handoffSha256: plan.checkpoint.handoffSha256,
    ...(plan.version !== 1
      ? {
          adapterConfigurations: plan.checkpoint.adapterConfigurations,
          phaseOneExecution: plan.checkpoint.phaseOneExecution,
          phaseOnePatchSha256: plan.checkpoint.phaseOnePatchSha256,
          phaseOnePromptSha256: plan.checkpoint.phaseOnePromptSha256,
          preparedContext: plan.checkpoint.preparedContext,
          preparedGraphHome: plan.checkpoint.preparedGraphHome,
          preparedHome: plan.checkpoint.preparedHome,
        }
      : {}),
    phaseOneAccounting: plan.checkpoint.phaseOneAccounting,
    repositoryFixtureHash: plan.checkpoint.repositoryFixtureHash,
    repositoryRevision: plan.checkpoint.repositoryRevision,
    resumeEvidenceMarker: plan.checkpoint.resumeEvidenceMarker,
    automaticHandoffReadSha256: plan.checkpoint.automaticHandoffReadSha256,
  };
}

function continuationPosition(index: number): 1 | 2 | 3 | 4 | 5 {
  switch (index) {
    case 0:
      return 1;
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
      return 4;
    case 4:
      return 5;
    default:
      throw new Error('Continuation pilot has an impossible attempt position.');
  }
}

const HASH = /^[0-9a-f]{64}$/u;
const CLUSTER_ID = /^cluster_[0-9a-f]{16,64}$/u;
const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;
const BLOCKED_ENVIRONMENT_KEYS = new Set([
  'DO_NOT_TRACK',
  'HOME',
  'LANG',
  'LC_ALL',
  'MATCHED_EVALUATION_ADAPTER_CONFIG',
  'MATCHED_EVALUATION_ADAPTER_EXECUTABLE',
  'MATCHED_EVALUATION_TOOL',
  'PATH',
  'THREADNOTE_TELEMETRY',
  'TMPDIR',
]);
const MAXIMUM_JSON_BYTES = 8 * 1_024 * 1_024;
const MAXIMUM_TRANSCRIPT_BYTES = 64 * 1_024 * 1_024;
const PRODUCTION_RELEASE_ARCHIVE_HASH = 'c234c12d56807fdd94ad0ffbfceafb45140ee73304fc6399da65051a35670fb1';
const PRODUCTION_RELEASE_EXECUTABLE_HASH = 'e8cef51bc029705614928c7ea69a5cb39e1b05f43f272ca495a947f5d5e32c15';

const program = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  yield* Effect.tryPromise({
    try: () => {
      if (options.continuationFinalizeDirectory !== null) {
        return finalizeMatchedEvaluationContinuationCheckpointFromFilesV1({
          corpusPath: options.corpusPath,
          manifestPath: options.manifestPath,
          outputDirectory: options.continuationFinalizeDirectory,
          runtimePath: options.runtimePath,
          studyPath: options.studyPath!,
        });
      }
      if (options.continuationPhaseOneTaskPacketPath !== null) {
        return runMatchedEvaluationContinuationPhaseOneFromFilesV1({
          corpusPath: options.corpusPath,
          manifestPath: options.manifestPath,
          outputDirectory: options.continuationPhaseOneDirectory!,
          runtimePath: options.runtimePath,
          studyPath: options.studyPath!,
          taskPacketPath: options.continuationPhaseOneTaskPacketPath,
        });
      }
      if (options.continuationPilotPlanPath !== null) {
        return runMatchedEvaluationContinuationPilotFromFilesV1({
          corpusPath: options.corpusPath,
          manifestPath: options.manifestPath,
          parentPilotDirectory: options.continuationParentPilotDirectory,
          pilotDirectory: options.pilotDirectory!,
          planPath: options.continuationPilotPlanPath,
          runtimePath: options.runtimePath,
          studyPath: options.studyPath!,
        });
      }
      return options.pilotTaskId === null
        ? runMatchedEvaluationFromFilesV1(options)
        : runMatchedEvaluationPilotFromFilesV1({
            corpusPath: options.corpusPath,
            manifestPath: options.manifestPath,
            runtimePath: options.runtimePath,
            studyPath: options.studyPath!,
            taskId: options.pilotTaskId,
            pilotDirectory: options.pilotDirectory!,
          });
    },
    catch: cause => ScriptError.make({message: 'Matched evaluation stopped.', cause}),
  });
});

export async function runMatchedEvaluationFromFilesV1(options: {
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly runtimePath: string;
  readonly studyPath?: string | null;
}): Promise<void> {
  const [corpus, manifest, runtime, study] = await Promise.all([
    readJson(options.corpusPath).then(parseMatchedEvaluationCorpusV1),
    readJson(options.manifestPath).then(parseMatchedEvaluationManifestV1),
    readJson(options.runtimePath).then(parseMatchedEvaluationRuntimeV1),
    options.studyPath === null || options.studyPath === undefined
      ? Promise.resolve(null)
      : readJson(options.studyPath).then(parseMatchedTokenEfficiencyStudyV1),
  ]);
  if (study !== null) assertMatchedTokenEfficiencyStudyMatchesV1(study, corpus, manifest);
  if (runtime.verificationPlanHash !== (study?.verificationPlanHash ?? null)) {
    throw new Error('Runtime and study disagree on the sealed verification plan.');
  }
  const repositories = await resolveMatchedEvaluationRuntimeRepositoriesV1(runtime, study, manifest.repository);
  await assertLocalArtifactDirectory(runtime.artifactDirectory);
  await withMatchedEvaluationArtifactLockV1(runtime.artifactDirectory, async () => {
    await assertResolvedRuntimeRepositories(repositories);
    const outcomesPath = resolve(runtime.artifactDirectory, 'outcomes.jsonl');
    const summaryPath = resolve(runtime.artifactDirectory, 'summary.json');
    let expectedLedgerText = await readOptionalText(outcomesPath, 16 * 1_024 * 1_024);
    const existing = parseMatchedEvaluationOutcomesJsonlV1(expectedLedgerText);
    const ledgerOutcomes = [...existing];
    const resolved = new Map<MatchedEvaluationArm, ResolvedRuntimeArm>();
    const unavailable = new Map<
      MatchedEvaluationArm,
      {readonly detail: string; readonly reason: MatchedEvaluationUnavailableReason}
    >();
    const outcomes = await runMatchedEvaluationV1({
      availability: async (arm, definition) => {
        const resolution = await resolveRuntimeArm(runtime, arm, definition);
        if ('reason' in resolution) {
          unavailable.set(arm, resolution);
          return {available: false, ...resolution};
        }
        resolved.set(arm, resolution);
        return {available: true};
      },
      corpus,
      execute: async request => {
        const repository = requiredRuntimeRepository(repositories, request.task.taskId, study);
        await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected);
        const result = await executeArm(
          runtime,
          requiredResolvedArm(resolved, request.arm),
          repository,
          request,
          study,
        );
        await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected);
        return result;
      },
      manifest,
      onOutcome: async outcome => {
        if (ledgerOutcomes.length !== outcome.runOrder) {
          throw new Error('Outcome ledger prefix differs from the in-memory run prefix.');
        }
        const replacement = `${[...ledgerOutcomes, outcome].map(value => JSON.stringify(value)).join('\n')}\n`;
        await compareAndSwapMatchedEvaluationLedgerV1(outcomesPath, expectedLedgerText, replacement);
        expectedLedgerText = replacement;
        ledgerOutcomes.push(outcome);
      },
      outcomes: existing,
    });
    await assertResolvedRuntimeRepositories(repositories);
    const summary = summarizeMatchedEvaluationV1(manifest, outcomes);
    await atomicWrite(summaryPath, `${JSON.stringify(summary, undefined, 2)}\n`);
    const tokenEfficiencyReport =
      study === null ? null : evaluateMatchedTokenEfficiencyV1({corpus, manifest, outcomes, study});
    if (tokenEfficiencyReport !== null) {
      await Promise.all([
        atomicWrite(
          resolve(runtime.artifactDirectory, 'token-efficiency-report.json'),
          `${JSON.stringify(tokenEfficiencyReport, undefined, 2)}\n`,
        ),
        atomicWrite(
          resolve(runtime.artifactDirectory, 'article-evidence.md'),
          renderMatchedTokenEfficiencyArticleEvidenceV1(tokenEfficiencyReport),
        ),
      ]);
    }
    process.stdout.write(
      `${JSON.stringify({
        artifactDirectory: runtime.artifactDirectory,
        completed: outcomes.filter(outcome => outcome.status === 'completed').length,
        comparativeClaimsEligible: summary.comparativeClaimsEligible,
        manifestHash: manifest.manifestHash,
        tokenEfficiencyReportHash: tokenEfficiencyReport?.reportHash ?? null,
        unavailable: Object.fromEntries(unavailable),
        version: MATCHED_EVALUATION_RUNTIME_VERSION,
      })}\n`,
    );
  });
}

/** Execute exactly one frozen first-repetition row for each of the three pilot arms. */
export async function runMatchedEvaluationPilotFromFilesV1(options: {
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly runtimePath: string;
  readonly studyPath: string;
  readonly taskId: string;
  readonly pilotDirectory: string;
}): Promise<void> {
  const [corpus, manifest, runtime, study] = await Promise.all([
    readJson(options.corpusPath).then(parseMatchedEvaluationCorpusV1),
    readJson(options.manifestPath).then(parseMatchedEvaluationManifestV1),
    readJson(options.runtimePath).then(parseMatchedEvaluationRuntimeV1),
    readJson(options.studyPath).then(parseMatchedTokenEfficiencyStudyV1),
  ]);
  assertMatchedTokenEfficiencyStudyMatchesV1(study, corpus, manifest);
  if (runtime.verificationPlanHash !== study.verificationPlanHash) {
    throw new Error('Runtime and study disagree on the sealed verification plan.');
  }
  if (!manifest.tasks.some(task => task.taskId === options.taskId))
    throw new Error(`Pilot task ${options.taskId} is not in the manifest.`);
  const pilotDirectory = absolutePath(options.pilotDirectory, 'pilot directory');
  if (pilotDirectory === runtime.artifactDirectory)
    throw new Error('Pilot directory must be separate from the full-study artifact directory.');
  await mkdir(pilotDirectory, {recursive: true, mode: 0o700});
  if ((await realpath(pilotDirectory)) !== pilotDirectory)
    throw new Error('Pilot directory must use its canonical path.');
  const markerPath = resolve(pilotDirectory, 'pilot-selection.json');
  const selected = selectMatchedEvaluationPilotRowsV1(manifest, options.taskId);
  const selection = {
    completionMeaning:
      'completed is true only when all three adapter attempts completed; finished means the pilot loop stopped without retry.',
    comparativeClaimsEligible: false,
    identities: {
      manifestHash: manifest.manifestHash,
      runtimeVersion: runtime.version,
      studyHash: study.studyHash,
      verificationPlanHash: study.verificationPlanHash,
    },
    limitations: [
      'One task, one repetition, no CI, non-generalizable exploratory pilot.',
      'No full-study ledger or report is produced.',
    ],
    rows: selected.map(row => ({...row, arm: manifest.blindAssignment[row.blindLabel]})),
    taskId: options.taskId,
    version: 1,
  };
  try {
    await writeFile(markerPath, `${JSON.stringify(selection, undefined, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (cause) {
    if ((cause as {code?: string}).code === 'EEXIST')
      throw new Error('Pilot selection already exists; resume/retry is not supported.', {cause});
    throw cause;
  }
  const pilotRuntime = {...runtime, artifactDirectory: pilotDirectory};
  const repositories = await resolveMatchedEvaluationRuntimeRepositoriesV1(pilotRuntime, study, manifest.repository);
  await assertResolvedRuntimeRepositories(repositories);
  const preflight = await Promise.all(
    selected.map(async row => {
      const arm = manifest.blindAssignment[row.blindLabel];
      const definition = manifest.arms.find(candidate => candidate.arm === arm);
      if (definition === undefined) throw new Error(`Pilot schedule arm ${arm} is not defined.`);
      const resolution = await resolveRuntimeArm(pilotRuntime, arm, definition);
      if ('reason' in resolution) throw new Error(`Pilot runtime unavailable for ${arm}: ${resolution.detail}`);
      return [arm, resolution] as const;
    }),
  );
  const resolved = new Map(preflight);
  const reportPath = resolve(pilotDirectory, 'pilot-report.json');
  const attempts: Array<Record<string, unknown>> = [];
  const writeReport = async (completed: boolean) =>
    atomicWrite(reportPath, `${JSON.stringify({...selection, attempts, completed}, undefined, 2)}\n`);
  await writeReport(false);
  for (const row of selected) {
    const arm = manifest.blindAssignment[row.blindLabel];
    const definition = manifest.arms.find(candidate => candidate.arm === arm);
    if (definition === undefined) throw new Error(`Pilot schedule arm ${arm} is not defined.`);
    const rawArtifactPath = resolve(pilotDirectory, 'runs', row.runNonce, 'artifact.json');
    const requestPath = resolve(pilotDirectory, 'runs', row.runNonce, 'request.json');
    const responsePath = resolve(pilotDirectory, 'runs', row.runNonce, 'response.json');
    const transcriptPath = resolve(pilotDirectory, 'transcripts', `${row.runNonce}.jsonl`);
    const checkpointPath = `${transcriptPath}.agent.jsonl`;
    const request = {
      arm,
      armDefinition: definition,
      manifest,
      schedule: row,
      task: corpus.tasks.find(task => task.taskId === options.taskId)!,
    };
    await assertMatchedEvaluationRepositoryV1(
      repositories.get(study.taskContexts.find(context => context.taskId === options.taskId)?.clusterId ?? null)!
        .repositoryDirectory,
      repositories.get(study.taskContexts.find(context => context.taskId === options.taskId)?.clusterId ?? null)!
        .expected,
    );
    try {
      const observation = await executeArm(
        pilotRuntime,
        requiredResolvedArm(resolved, arm),
        requiredRuntimeRepository(repositories, options.taskId, study),
        request,
        study,
      );
      attempts.push({
        arm,
        metrics: observation.metrics,
        rawArtifactPath,
        requestPath,
        responsePath,
        checkpointPath,
        runNonce: row.runNonce,
        runOrder: row.runOrder,
        status: 'completed',
        taskId: options.taskId,
        transcriptHash: observation.transcriptHash,
        transcriptPath,
      });
    } catch (cause) {
      if (!(cause instanceof Error) || !cause.message.includes('adapter failed with exit code')) throw cause;
      attempts.push({
        arm,
        diagnostics: cause.message.slice(-2_048),
        metrics: null,
        providerUsage: null,
        rawArtifactPath,
        requestPath,
        responsePath,
        checkpointPath,
        runNonce: row.runNonce,
        runOrder: row.runOrder,
        status: 'failed',
        taskId: options.taskId,
        transcriptPath,
      });
    } finally {
      await assertMatchedEvaluationRepositoryV1(
        requiredRuntimeRepository(repositories, options.taskId, study).repositoryDirectory,
        requiredRuntimeRepository(repositories, options.taskId, study).expected,
      );
    }
    await writeReport(false);
  }
  await assertResolvedRuntimeRepositories(repositories);
  const allCompleted = attempts.every(attempt => attempt.status === 'completed');
  await writeReport(allCompleted);
  process.stdout.write(
    `${JSON.stringify({artifactDirectory: pilotDirectory, attemptCount: attempts.length, comparativeClaimsEligible: false, completed: allCompleted, finished: true, version: 1})}\n`,
  );
}

/** Execute one common test-only Phase 1 after sealing its prompt and later treatment order. */
export async function runMatchedEvaluationContinuationPhaseOneFromFilesV1(options: {
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly outputDirectory: string;
  readonly runtimePath: string;
  readonly studyPath: string;
  readonly taskPacketPath: string;
}): Promise<void> {
  const [corpus, manifest, runtime, study, taskPacketBytes] = await Promise.all([
    readJson(options.corpusPath).then(parseMatchedEvaluationCorpusV1),
    readJson(options.manifestPath).then(parseMatchedEvaluationManifestV1),
    readJson(options.runtimePath).then(parseMatchedEvaluationRuntimeV1),
    readJson(options.studyPath).then(parseMatchedTokenEfficiencyStudyV1),
    readFile(options.taskPacketPath),
  ]);
  assertMatchedTokenEfficiencyStudyMatchesV1(study, corpus, manifest);
  if (runtime.verificationPlanHash !== study.verificationPlanHash) {
    throw new Error('Runtime and study disagree on the sealed verification plan.');
  }
  const packet = parseMatchedEvaluationContinuationPhaseOneTaskPacketV1(
    JSON.parse(taskPacketBytes.toString('utf8')) as unknown,
  );
  const matchingTasks = corpus.tasks.filter(task => task.prompt === packet.sourceTaskPrompt);
  if (matchingTasks.length !== 1) {
    throw new Error('Continuation phase-one packet must match exactly one frozen corpus task.');
  }
  const corpusTask = matchingTasks[0];
  const manifestTask = manifest.tasks.find(task => task.taskId === corpusTask.taskId);
  if (manifestTask === undefined) throw new Error(`Manifest lacks task ${corpusTask.taskId}.`);
  const taskContext = study.taskContexts.find(context => context.taskId === corpusTask.taskId);
  if (taskContext === undefined) throw new Error(`Study lacks task context ${corpusTask.taskId}.`);
  const cluster = study.clusters.find(candidate => candidate.clusterId === taskContext.clusterId);
  if (cluster === undefined) throw new Error(`Study lacks cluster ${taskContext.clusterId}.`);
  if (
    cluster.revision !== packet.sourceRevision ||
    cluster.repositoryFixtureHash !== corpusTask.repositoryFixtureHash ||
    manifestTask.promptHash !== matchedEvaluationPromptHashV1(packet.sourceTaskPrompt)
  ) {
    throw new Error('Continuation phase-one packet differs from the frozen task identity.');
  }
  const outputDirectory = absolutePath(options.outputDirectory, 'continuation phase-one output directory');
  if (outputDirectory === runtime.artifactDirectory) {
    throw new Error('Continuation phase-one output must differ from the full-study artifact directory.');
  }
  await mkdir(outputDirectory, {recursive: true, mode: 0o700});
  if ((await realpath(outputDirectory)) !== outputDirectory) {
    throw new Error('Continuation phase-one output directory must use its canonical path.');
  }
  const selection = createMatchedEvaluationContinuationPhaseOneSelectionV1({
    packet,
    repositoryRevision: cluster.revision,
    task: manifestTask,
    taskPacketSha256: sha256Bytes(taskPacketBytes),
    taskPrompt: corpusTask.prompt,
  });
  await writeFile(resolve(outputDirectory, 'phase-one-task-packet.json'), taskPacketBytes, {flag: 'wx', mode: 0o600});
  const selectionPath = resolve(outputDirectory, 'phase-one-selection.json');
  try {
    await writeFile(selectionPath, `${JSON.stringify(selection, undefined, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (cause) {
    if ((cause as {code?: string}).code === 'EEXIST') {
      throw new Error('Continuation phase-one selection already exists; retry is not supported.', {cause});
    }
    throw cause;
  }
  const filesDefinition = manifest.arms.find(definition => definition.arm === 'files');
  if (filesDefinition === undefined) throw new Error('Manifest lacks the files arm definition.');
  const executionDirectory = resolve(outputDirectory, 'phase-one-execution');
  const phaseOneRuntime = {...runtime, artifactDirectory: executionDirectory};
  const repositories = await resolveMatchedEvaluationRuntimeRepositoriesV1(phaseOneRuntime, study, manifest.repository);
  await assertResolvedRuntimeRepositories(repositories);
  const resolution = await resolveRuntimeArm(phaseOneRuntime, 'files', filesDefinition);
  if ('reason' in resolution) {
    throw new Error(`Continuation phase-one files runtime unavailable: ${resolution.detail}`);
  }
  const blindLabel = Object.entries(manifest.blindAssignment).find(([, arm]) => arm === 'files')?.[0] as
    MatchedEvaluationRunRequestV1['schedule']['blindLabel'] | undefined;
  if (blindLabel === undefined) throw new Error('Manifest blind assignment lacks the files arm.');
  const request: MatchedEvaluationRunRequestV1 = {
    arm: 'files',
    armDefinition: filesDefinition,
    manifest,
    schedule: {
      blindLabel,
      position: 1,
      repetition: 0,
      runNonce: selection.phaseOneRunNonce,
      runOrder: 0,
      taskId: corpusTask.taskId,
    },
    task: {...corpusTask, prompt: selection.phaseOnePrompt},
  };
  const repository = requiredRuntimeRepository(repositories, corpusTask.taskId, study);
  await executeArm(phaseOneRuntime, resolution, repository, request, study);
  await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected);
  const runDirectory = resolve(executionDirectory, 'runs', selection.phaseOneRunNonce);
  const transcriptPath = resolve(executionDirectory, 'transcripts', `${selection.phaseOneRunNonce}.jsonl`);
  const evidenceDirectory = resolve(outputDirectory, 'phase-one');
  await mkdir(evidenceDirectory, {mode: 0o700});
  const evidence = [
    [resolve(runDirectory, 'runtime', 'adapter'), resolve(evidenceDirectory, 'adapter')],
    [resolve(runDirectory, 'runtime', 'adapter-config.json'), resolve(evidenceDirectory, 'adapter-config.json')],
    [resolve(runDirectory, 'artifact.json'), resolve(evidenceDirectory, 'artifact.json')],
    [resolve(runDirectory, 'request.json'), resolve(evidenceDirectory, 'request.json')],
    [resolve(runDirectory, 'response.json'), resolve(evidenceDirectory, 'response.json')],
    [transcriptPath, resolve(evidenceDirectory, 'transcript.jsonl')],
  ] as const;
  await Promise.all(
    evidence.map(async ([source, destination]) =>
      writeFile(destination, await readFile(source), {
        flag: 'wx',
        mode: destination.endsWith('/adapter') ? 0o700 : 0o600,
      }),
    ),
  );
  await sealMatchedEvaluationContinuationPhaseOneEvidenceV1({outputDirectory});
  process.stdout.write(`${JSON.stringify({outputDirectory, taskId: corpusTask.taskId, version: 1})}\n`);
}

/** Seal preserved Phase-1 evidence without repeating the provider call. */
export async function sealMatchedEvaluationContinuationPhaseOneEvidenceV1(options: {
  readonly outputDirectory: string;
}): Promise<MatchedEvaluationContinuationPhaseOneReceiptV1> {
  const outputDirectory = await canonicalDirectory(options.outputDirectory, 'continuation phase-one output directory');
  const evidenceDirectory = resolve(outputDirectory, 'phase-one');
  const selectionPath = resolve(outputDirectory, 'phase-one-selection.json');
  const [selectionInput, taskPacketBytes, artifactInput, observationInput] = await Promise.all([
    readJson(selectionPath),
    readFile(resolve(outputDirectory, 'phase-one-task-packet.json')),
    readJson(resolve(evidenceDirectory, 'artifact.json')),
    readJson(resolve(evidenceDirectory, 'response.json')),
  ]);
  const selection = parseMatchedEvaluationContinuationPhaseOneSelectionV1(selectionInput);
  if (sha256Bytes(taskPacketBytes) !== selection.taskPacketSha256) {
    throw new Error('Continuation phase-one task packet bytes differ from the sealed selection.');
  }
  const observation = parseMatchedEvaluationObservationV1(observationInput);
  assertMatchedEvaluationContinuationPhaseOneResultV1(artifactInput, observation, selection.sourceTask.taskId);
  const [
    adapterArtifactHash,
    adapterConfigurationFileSha256,
    artifactSha256,
    requestSha256,
    responseSha256,
    transcriptSha256,
  ] = await Promise.all([
    boundedRegularFileHash(resolve(evidenceDirectory, 'adapter'), 128 * 1_024 * 1_024, 'phase-one adapter'),
    boundedRegularFileHash(
      resolve(evidenceDirectory, 'adapter-config.json'),
      MAXIMUM_JSON_BYTES,
      'phase-one adapter config',
    ),
    boundedRegularFileHash(resolve(evidenceDirectory, 'artifact.json'), MAXIMUM_JSON_BYTES, 'phase-one artifact'),
    boundedRegularFileHash(resolve(evidenceDirectory, 'request.json'), MAXIMUM_JSON_BYTES, 'phase-one request'),
    boundedRegularFileHash(resolve(evidenceDirectory, 'response.json'), MAXIMUM_JSON_BYTES, 'phase-one response'),
    boundedRegularFileHash(
      resolve(evidenceDirectory, 'transcript.jsonl'),
      MAXIMUM_TRANSCRIPT_BYTES,
      'phase-one transcript',
    ),
  ]);
  const receipt: MatchedEvaluationContinuationPhaseOneReceiptV1 = {
    continuationAttempts: selection.continuationAttempts,
    evidenceSha256: {
      adapterArtifactHash,
      adapterConfigurationFileSha256,
      artifactSha256,
      requestSha256,
      responseSha256,
      transcriptSha256,
    },
    metrics: observation.metrics,
    phaseOnePromptSha256: selection.phaseOnePromptSha256,
    phaseOneRunNonce: selection.phaseOneRunNonce,
    selectionSha256: await boundedRegularFileHash(
      selectionPath,
      MAXIMUM_JSON_BYTES,
      'continuation phase-one selection',
    ),
    taskId: selection.sourceTask.taskId,
    taskPacketSha256: selection.taskPacketSha256,
    transcriptHash: observation.transcriptHash,
    version: 1,
  } as const;
  await atomicWrite(resolve(outputDirectory, 'phase-one-receipt.json'), `${JSON.stringify(receipt, undefined, 2)}\n`);
  return receipt;
}

export function assertMatchedEvaluationContinuationPhaseOneResultV1(
  artifactInput: unknown,
  observationInput: unknown,
  taskId: string,
): void {
  const artifact = object(artifactInput, 'continuation phase-one artifact');
  const agentResult = object(artifact.agentResult, 'continuation phase-one agent result');
  if (typeof artifact.patch !== 'string' || artifact.patch.length === 0) {
    throw new Error('Continuation phase-one agent did not return a nonempty test patch.');
  }
  const observation = parseMatchedEvaluationObservationV1(observationInput);
  const verification = observation.metrics.verification;
  if (
    observation.metrics.validity.valid !== true ||
    verification === null ||
    verification.taskId !== taskId ||
    verification.status !== 'task-failed' ||
    verification.exitCode === 0
  ) {
    throw new Error('Continuation phase-one deterministic verifier did not attest the expected failing regression.');
  }
  // Phase 1 deliberately asks the agent to complete a regression-only assignment while
  // the phase-two verifier must still fail. Those two completion signals describe
  // different contracts and are therefore not expected to agree.
  if (typeof agentResult.completed !== 'boolean') {
    throw new Error('Continuation phase-one agent completion evidence is invalid.');
  }
}

/** Turn preserved Phase-1 evidence into one direct-child checkpoint and sealed v2 continuation plan. */
export async function finalizeMatchedEvaluationContinuationCheckpointFromFilesV1(options: {
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly outputDirectory: string;
  readonly runtimePath: string;
  readonly studyPath: string;
}): Promise<void> {
  const outputDirectory = await canonicalDirectory(options.outputDirectory, 'continuation checkpoint output directory');
  const selectionPath = resolve(outputDirectory, 'phase-one-selection.json');
  const [
    corpus,
    manifest,
    runtime,
    study,
    taskPacketBytes,
    selectionInput,
    receiptInput,
    artifactInput,
    requestInput,
    responseInput,
  ] = await Promise.all([
    readJson(options.corpusPath).then(parseMatchedEvaluationCorpusV1),
    readJson(options.manifestPath).then(parseMatchedEvaluationManifestV1),
    readJson(options.runtimePath).then(parseMatchedEvaluationRuntimeV1),
    readJson(options.studyPath).then(parseMatchedTokenEfficiencyStudyV1),
    readFile(resolve(outputDirectory, 'phase-one-task-packet.json')),
    readJson(selectionPath),
    readJson(resolve(outputDirectory, 'phase-one-receipt.json')),
    readJson(resolve(outputDirectory, 'phase-one', 'artifact.json')),
    readJson(resolve(outputDirectory, 'phase-one', 'request.json')),
    readJson(resolve(outputDirectory, 'phase-one', 'response.json')),
  ]);
  assertMatchedTokenEfficiencyStudyMatchesV1(study, corpus, manifest);
  const selection = parseMatchedEvaluationContinuationPhaseOneSelectionV1(selectionInput);
  const phaseOneReceipt = parseMatchedEvaluationContinuationPhaseOneReceiptV1(receiptInput);
  if (sha256Bytes(taskPacketBytes) !== selection.taskPacketSha256) {
    throw new Error('Continuation phase-one task packet bytes differ from the sealed selection.');
  }
  const corpusTask = corpus.tasks.find(task => task.taskId === selection.sourceTask.taskId);
  if (corpusTask === undefined || corpusTask.prompt !== selection.sourceTask.prompt) {
    throw new Error('Continuation checkpoint selection differs from the frozen corpus task.');
  }
  const taskContext = study.taskContexts.find(context => context.taskId === corpusTask.taskId);
  if (taskContext === undefined) throw new Error(`Study lacks task context ${corpusTask.taskId}.`);
  const cluster = study.clusters.find(candidate => candidate.clusterId === taskContext.clusterId);
  if (cluster === undefined) throw new Error(`Study lacks cluster ${taskContext.clusterId}.`);
  const runtimeRepository = runtime.repositories.find(repository => repository.clusterId === cluster.clusterId);
  if (runtimeRepository === undefined) throw new Error(`Runtime lacks cluster ${cluster.clusterId}.`);
  await assertMatchedEvaluationRepositoryV1(runtimeRepository.repositoryDirectory, {
    dirty: false,
    fixtureHash: cluster.repositoryFixtureHash,
    identityHash: cluster.repositoryIdentityHash,
    revision: cluster.revision,
  });
  const artifact = object(artifactInput, 'continuation phase-one artifact');
  const request = object(requestInput, 'continuation phase-one request');
  const response = object(responseInput, 'continuation phase-one response');
  const responseObservation = parseMatchedEvaluationObservationV1(responseInput);
  const [
    adapterArtifactHash,
    adapterConfigurationFileSha256,
    artifactSha256,
    requestSha256,
    responseSha256,
    transcriptSha256,
    selectionSha256,
  ] = await Promise.all([
    boundedRegularFileHash(resolve(outputDirectory, 'phase-one', 'adapter'), 128 * 1_024 * 1_024, 'phase-one adapter'),
    boundedRegularFileHash(
      resolve(outputDirectory, 'phase-one', 'adapter-config.json'),
      MAXIMUM_JSON_BYTES,
      'phase-one adapter config',
    ),
    boundedRegularFileHash(
      resolve(outputDirectory, 'phase-one', 'artifact.json'),
      MAXIMUM_JSON_BYTES,
      'phase-one artifact',
    ),
    boundedRegularFileHash(
      resolve(outputDirectory, 'phase-one', 'request.json'),
      MAXIMUM_JSON_BYTES,
      'phase-one request',
    ),
    boundedRegularFileHash(
      resolve(outputDirectory, 'phase-one', 'response.json'),
      MAXIMUM_JSON_BYTES,
      'phase-one response',
    ),
    boundedRegularFileHash(
      resolve(outputDirectory, 'phase-one', 'transcript.jsonl'),
      MAXIMUM_TRANSCRIPT_BYTES,
      'phase-one transcript',
    ),
    boundedRegularFileHash(selectionPath, MAXIMUM_JSON_BYTES, 'continuation phase-one selection'),
  ]);
  assertMatchedEvaluationContinuationPhaseOneReceiptV1({
    evidenceSha256: {
      adapterArtifactHash,
      adapterConfigurationFileSha256,
      artifactSha256,
      requestSha256,
      responseSha256,
      transcriptSha256,
    },
    receipt: phaseOneReceipt,
    responseObservation,
    selection,
    selectionSha256,
  });
  assertMatchedEvaluationContinuationPhaseOneResultV1(artifactInput, responseObservation, corpusTask.taskId);
  const agentPatch = boundedString(artifact.patch, 1, 8 * 1_024 * 1_024, 'continuation phase-one agent patch');
  if (request.runNonce !== selection.phaseOneRunNonce || artifact.runNonce !== selection.phaseOneRunNonce) {
    throw new Error('Continuation phase-one evidence differs from its sealed selection.');
  }
  const checkpointRepository = resolve(outputDirectory, 'checkpoint-repository');
  const checkpointAlreadyExists = await lstat(checkpointRepository).then(
    entry => {
      if (!entry.isDirectory()) throw new Error('Continuation checkpoint path exists but is not a directory.');
      return true;
    },
    cause => {
      if (isMissing(cause)) return false;
      throw cause;
    },
  );
  if (!checkpointAlreadyExists) {
    await captureContinuationGit(runtimeRepository.repositoryDirectory, [
      'worktree',
      'add',
      '--detach',
      checkpointRepository,
      selection.sourceTask.repositoryRevision,
    ]);
  }
  const agentPatchPath = resolve(outputDirectory, 'phase-one', 'agent.patch');
  const preservedAgentPatch = await readFile(agentPatchPath, 'utf8').catch(cause => {
    if (isMissing(cause)) return null;
    throw cause;
  });
  if (preservedAgentPatch === null) {
    await writeFile(agentPatchPath, agentPatch, {encoding: 'utf8', flag: 'wx', mode: 0o600});
  } else if (preservedAgentPatch !== agentPatch) {
    throw new Error('Continuation checkpoint preserved patch differs from the phase-one artifact.');
  }
  if (!checkpointAlreadyExists) {
    await captureContinuationGit(checkpointRepository, ['apply', '--index', '--whitespace=nowarn', agentPatchPath]);
  }
  const changedPaths = (
    await captureContinuationGit(
      checkpointRepository,
      checkpointAlreadyExists
        ? ['diff', '--name-only', '-z', selection.sourceTask.repositoryRevision, 'HEAD', '--']
        : ['diff', '--cached', '--name-only', '-z'],
    )
  )
    .split('\0')
    .filter(Boolean)
    .sort();
  const allowedPaths = [...selection.taskPacket.phaseOneAllowedPaths].sort();
  if (changedPaths.length !== allowedPaths.length || changedPaths.some((path, index) => path !== allowedPaths[index])) {
    throw new Error('Continuation phase-one patch changes a path outside the sealed test-only boundary.');
  }
  const filesConfig = parseMatchedEvaluationCodexAdapterConfigV1(
    await readJson(resolve(outputDirectory, 'phase-one', 'adapter-config.json')),
  );
  const phaseTwoCommands = matchContinuationPhaseTwoCommandsV1({
    approvedCommands: filesConfig.approvedCommands,
    commandTexts: selection.taskPacket.phaseTwoFocusedChecks,
    taskId: corpusTask.taskId,
  });
  const focusedCommand = phaseTwoCommands[0];
  const focusedCheck = await runMatchedEvaluationContinuationFocusedCheckV1({
    commandTokens: focusedCommand.tokens,
    repositoryDirectory: checkpointRepository,
    safeExecutablePath: filesConfig.safeExecutablePath,
    temporaryDirectory: resolve(outputDirectory, 'phase-one-check-tmp'),
  });
  if (focusedCheck.exitCode !== 1) {
    throw new Error(
      `Continuation phase-one focused check must fail with exit code 1, received ${focusedCheck.exitCode}.`,
    );
  }
  if (!checkpointAlreadyExists) {
    await captureContinuationGit(checkpointRepository, [
      '-c',
      'user.name=Threadnote Evaluation',
      '-c',
      'user.email=evaluation@threadnote.invalid',
      'commit',
      '-m',
      `test: add ${selection.taskPacket.taskKey} regression checkpoint`,
    ]);
  }
  const checkpoint = await observeMatchedEvaluationRepositoryV1(checkpointRepository);
  if (checkpoint.dirty || checkpoint.identityHash !== cluster.repositoryIdentityHash) {
    throw new Error('Continuation checkpoint repository is dirty or has a different identity.');
  }
  const phaseOnePatchSha256 = sha256Bytes(Buffer.from(agentPatch));
  await assertMatchedEvaluationContinuationCheckpointV2({
    agentPatch,
    baseFixtureHash: selection.sourceTask.repositoryFixtureHash,
    baseRevision: selection.sourceTask.repositoryRevision,
    checkpoint,
    patchSha256: phaseOnePatchSha256,
    repositoryDirectory: checkpointRepository,
  });
  const phaseTwoVerification = await prepareMatchedEvaluationContinuationPhaseTwoVerificationPlanV1({
    commands: phaseTwoCommands,
    protectedPaths: selection.taskPacket.phaseOneAllowedPaths,
    repositoryDirectory: checkpointRepository,
    safeExecutablePath: filesConfig.safeExecutablePath,
    taskId: corpusTask.taskId,
    temporaryRoot: resolve(outputDirectory, 'phase-two-verification-baseline-tmp'),
  });

  const graphArm = runtime.arms.find(arm => arm.arm === 'threadnote-graph');
  const compactArm = runtime.arms.find(arm => arm.arm === 'threadnote-compact');
  const graphDefinition = manifest.arms.find(arm => arm.arm === 'threadnote-graph');
  const compactDefinition = manifest.arms.find(arm => arm.arm === 'threadnote-compact');
  if (
    graphArm?.toolExecutable === null ||
    graphArm?.toolExecutable === undefined ||
    compactArm?.toolExecutable !== graphArm.toolExecutable ||
    graphDefinition?.tool.artifactHash === null ||
    graphDefinition === undefined ||
    compactDefinition === undefined
  ) {
    throw new Error('Continuation checkpoint runtime lacks one shared pinned Threadnote candidate.');
  }
  const sourceGraphConfig = parseMatchedEvaluationCodexAdapterConfigV1(await readJson(graphArm.adapterConfigFile));
  const sourceCompactConfig = parseMatchedEvaluationCodexAdapterConfigV1(await readJson(compactArm.adapterConfigFile));
  const sourceGraphHome = sourceGraphConfig.contextHomes.find(home => home.taskId === corpusTask.taskId);
  const sourceCompactHome = sourceCompactConfig.contextHomes.find(home => home.taskId === corpusTask.taskId);
  if (
    sourceGraphHome === undefined ||
    sourceCompactHome === undefined ||
    sourceGraphHome.project !== sourceCompactHome.project ||
    JSON.stringify(sourceGraphHome.identity) !== JSON.stringify(sourceCompactHome.identity)
  ) {
    throw new Error('Continuation checkpoint source homes do not share one task identity.');
  }
  const graphHome = resolve(outputDirectory, 'checkpoint-homes', 'graph');
  const compactHome = resolve(outputDirectory, 'checkpoint-homes', 'compact');
  await mkdir(resolve(outputDirectory, 'checkpoint-homes'), {mode: 0o700});
  const threadnoteEnvironment = {
    HOME: '/nonexistent',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: sourceGraphConfig.safeExecutablePath,
    THREADNOTE_ACCOUNT: sourceGraphHome.identity.account,
    THREADNOTE_TELEMETRY: '0',
    THREADNOTE_USER: sourceGraphHome.identity.user,
  } as const;
  await captureCodeMemoryLinkProcessGroup({
    arguments: [
      'project',
      'create',
      sourceGraphHome.project,
      '--home',
      graphHome,
      '--path',
      checkpointRepository,
      '--json',
    ],
    command: graphArm.toolExecutable,
    cwd: checkpointRepository,
    environment: threadnoteEnvironment,
    label: 'Continuation checkpoint project registration',
    maxOutputBytes: 512 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  const graphIndex = await captureCodeMemoryLinkProcessGroup({
    arguments: [
      'graph',
      'index',
      '--home',
      graphHome,
      '--cwd',
      checkpointRepository,
      '--project',
      sourceGraphHome.project,
      '--full',
      '--no-vectors',
      '--json',
    ],
    command: graphArm.toolExecutable,
    cwd: checkpointRepository,
    environment: threadnoteEnvironment,
    label: 'Continuation checkpoint graph index',
    maxOutputBytes: 2 * 1_024 * 1_024,
    timeoutMilliseconds: 30 * 60_000,
  });
  const graphIndexResult = parseLastJsonLine(graphIndex.stdout, 'continuation checkpoint graph index');
  const indexSnapshot = object(graphIndexResult.snapshot, 'continuation checkpoint graph snapshot');
  if (graphIndexResult.type !== 'code-graph-index' || indexSnapshot.commit !== checkpoint.revision) {
    throw new Error('Continuation checkpoint graph index differs from the checkpoint revision.');
  }
  const graphStatus = await captureCodeMemoryLinkProcessGroup({
    arguments: [
      'graph',
      'status',
      '--home',
      graphHome,
      '--cwd',
      checkpointRepository,
      '--project',
      sourceGraphHome.project,
      '--json',
    ],
    command: graphArm.toolExecutable,
    cwd: checkpointRepository,
    environment: threadnoteEnvironment,
    label: 'Continuation checkpoint graph status',
    maxOutputBytes: 512 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  const graphStatusResult = object(JSON.parse(graphStatus.stdout) as unknown, 'continuation checkpoint graph status');
  const statusSnapshot = object(graphStatusResult.readySnapshot, 'continuation checkpoint graph status snapshot');
  if (statusSnapshot.commit !== checkpoint.revision || statusSnapshot.state !== 'ready') {
    throw new Error('Continuation checkpoint graph is not exact-current and ready.');
  }
  const graphContentHash = matchedTokenEfficiencyGraphContentHashV1(
    boundedString(statusSnapshot.graphContentId, 1, 256, 'checkpoint graph content id'),
  );
  const graphSnapshotHash = matchedTokenEfficiencyGraphSnapshotHashV1(
    boundedString(statusSnapshot.id, 1, 256, 'checkpoint graph snapshot id'),
  );
  if (graphSnapshotHash === taskContext.graphSnapshotHash) {
    throw new Error('Continuation checkpoint graph snapshot unexpectedly equals the source snapshot.');
  }
  await cp(graphHome, compactHome, {errorOnExist: true, force: false, recursive: true});
  const resumeEvidenceMarker = `threadnote-resume-${phaseOnePatchSha256.slice(0, 20)}`;
  const handoff = [
    `Task: ${selection.taskPacket.phaseTwoPrompt}`,
    `Decisions: Phase 1 added only the committed regression in ${changedPaths.join(', ')}; production code is unchanged. ${resumeEvidenceMarker}`,
    'Constraints: Keep the committed regression unchanged, preserve public behavior, use no network access, and implement the smallest general production correction.',
    'Rationale: The direct-child checkpoint isolates cross-session continuation from initial test discovery and makes every treatment start from the same failing regression.',
    `Verification: ${focusedCommand.tokens.join(' ')} fails with exit code 1 at this checkpoint, as required before the production fix.`,
    'Blockers: none.',
    'Risks: Adjacent compatibility behavior may encode the old implementation and must remain covered by the sealed Phase 2 checks.',
    `Next step: ${selection.taskPacket.phaseTwoPrompt}`,
  ].join('\n');
  const memory = await captureCodeMemoryLinkProcessGroup({
    arguments: [
      'remember',
      '--home',
      compactHome,
      '--kind',
      'handoff',
      '--status',
      'active',
      '--project',
      sourceCompactHome.project,
      '--topic',
      `continuation-${corpusTask.taskId}`,
      ...changedPaths.flatMap(path => ['--code-ref', path]),
      '--require-current-code-refs',
      '--text',
      handoff,
    ],
    command: graphArm.toolExecutable,
    cwd: checkpointRepository,
    environment: threadnoteEnvironment,
    label: 'Continuation checkpoint automatic handoff',
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  const automaticHandoffUri = matchingString(
    memory.stdout.trim().replace(/^Stored memory:\s*/u, ''),
    /^threadnote:\/\/[^\s]+$/u,
    'continuation automatic handoff URI',
  );
  const automaticHandoffRead = await captureCodeMemoryLinkProcessGroup({
    arguments: ['read', '--home', compactHome, automaticHandoffUri],
    command: graphArm.toolExecutable,
    cwd: checkpointRepository,
    environment: threadnoteEnvironment,
    label: 'Continuation checkpoint automatic handoff read',
    maxOutputBytes: 1 * 1_024 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  if (!automaticHandoffRead.stdout.includes(handoff) || !automaticHandoffRead.stdout.includes(resumeEvidenceMarker)) {
    throw new Error('Continuation checkpoint automatic handoff cannot be read back exactly.');
  }
  const managedMemoryId = matchingString(
    uniquePrefixedLine(automaticHandoffRead.stdout, 'memory_id: ', 'continuation automatic handoff memory id'),
    /^tn_[A-Za-z0-9_-]{1,128}$/u,
    'continuation automatic handoff memory id',
  );
  const citationInput = object(
    JSON.parse(
      uniquePrefixedLine(automaticHandoffRead.stdout, 'code_citation: ', 'continuation automatic handoff citation'),
    ) as unknown,
    'continuation automatic handoff citation',
  );
  const citationTarget = object(citationInput.target, 'continuation automatic handoff citation target');
  const citationId = matchingString(
    citationInput.id,
    /^tncc_[0-9a-f]{40}$/u,
    'continuation automatic handoff citation id',
  );
  if (
    citationInput.sourceCommit !== checkpoint.revision ||
    citationInput.sourceDirty !== false ||
    citationInput.sourceSnapshotId !== statusSnapshot.id ||
    citationInput.sourceGraphContentId !== statusSnapshot.graphContentId ||
    citationInput.path !== changedPaths[0] ||
    citationTarget.kind !== 'file'
  ) {
    throw new Error('Continuation checkpoint automatic handoff citation is not exact-current for the regression.');
  }
  const fixtureMemoryId = `mem_${sha256Bytes(
    Buffer.from(`matched-continuation-automatic-handoff-v1\0${corpusTask.taskId}`),
  ).slice(0, 32)}`;
  const linkReceipts = [
    {
      citationHash: matchedTokenEfficiencyCitationHashV1({citationId, fixtureMemoryId, managedMemoryId}),
      memoryId: fixtureMemoryId,
      status: 'exact' as const,
    },
  ];
  const resumeBrief = await captureMatchedEvaluationContinuationAgentBriefV1({
    budgetTokens: sourceCompactConfig.contextBudgetTokens,
    executable: graphArm.toolExecutable,
    home: compactHome,
    project: sourceCompactHome.project,
    repositoryDirectory: checkpointRepository,
    task: selection.taskPacket.phaseTwoPrompt,
    threadnoteEnvironment,
  });
  const activeHandoffs = array(resumeBrief.parsed.activeHandoffs, 'continuation checkpoint active handoffs');
  const automaticHandoffDelivered = activeHandoffs.some(candidate => {
    const handoffEvidence = object(candidate, 'continuation checkpoint active handoff');
    return handoffEvidence.uri === automaticHandoffUri;
  });
  if (
    resumeBrief.parsed.evidenceState !== 'sufficient' ||
    !automaticHandoffDelivered ||
    !resumeBrief.text.includes(resumeEvidenceMarker)
  ) {
    throw new Error('Continuation checkpoint agent resume brief does not surface the exact automatic handoff.');
  }
  const checkpointContext = createMatchedTokenEfficiencyTaskContextV1({
    asIssuedContext: taskContext.asIssuedContext,
    clusterId: taskContext.clusterId,
    graphContentHash,
    graphSnapshotHash,
    linkReceipts,
    memoryFixtureHash: sha256Bytes(
      Buffer.from(
        `matched-continuation-memory-fixture-v1\0${automaticHandoffUri}\0${managedMemoryId}\0${citationId}\0${sha256Bytes(Buffer.from(handoff))}`,
      ),
    ),
    repositoryFixtureHash: checkpoint.fixtureHash,
    taskId: taskContext.taskId,
  });
  const [graphHomeFixtureHash, compactHomeFixtureHash] = await Promise.all([
    matchedEvaluationPreparedHomeFixtureHashV1(graphHome),
    matchedEvaluationPreparedHomeFixtureHashV1(compactHome),
  ]);
  const preparedGraphHome = {
    expectedContext: {
      graphContentHash,
      graphSnapshotHash,
      linkReceiptsHash: null,
      memoryAccess: 'disabled' as const,
      taskContextHash: null,
    },
    homeDirectory: graphHome,
    homeFixtureHash: graphHomeFixtureHash,
    identity: sourceGraphHome.identity,
    project: sourceGraphHome.project,
    taskId: corpusTask.taskId,
  };
  const preparedCompactHome = {
    expectedContext: {
      graphContentHash,
      graphSnapshotHash,
      linkReceiptsHash: checkpointContext.linkReceiptsHash,
      memoryAccess: 'linked' as const,
      taskContextHash: checkpointContext.taskContextHash,
    },
    homeDirectory: compactHome,
    homeFixtureHash: compactHomeFixtureHash,
    identity: sourceCompactHome.identity,
    project: sourceCompactHome.project,
    taskId: corpusTask.taskId,
  };
  const adapterConfigDirectory = resolve(outputDirectory, 'checkpoint-adapter-config');
  await mkdir(adapterConfigDirectory, {mode: 0o700});
  const graphConfigPath = resolve(adapterConfigDirectory, 'threadnote-graph.json');
  const compactConfigPath = resolve(adapterConfigDirectory, 'threadnote-compact.json');
  const graphConfigBytes = Buffer.from(
    `${JSON.stringify({...sourceGraphConfig, contextHomes: [preparedGraphHome]}, undefined, 2)}\n`,
  );
  const compactConfigBytes = Buffer.from(
    `${JSON.stringify({...sourceCompactConfig, contextHomes: [preparedCompactHome]}, undefined, 2)}\n`,
  );
  await Promise.all([
    writeFile(graphConfigPath, graphConfigBytes, {flag: 'wx', mode: 0o600}),
    writeFile(compactConfigPath, compactConfigBytes, {flag: 'wx', mode: 0o600}),
  ]);
  const metrics = object(response.metrics, 'continuation phase-one response metrics');
  const timing = object(metrics.timing, 'continuation phase-one response timing');
  const usage = object(metrics.usage, 'continuation phase-one response usage');
  const providerTokens = object(usage.providerTokens, 'continuation phase-one provider tokens');
  const phaseOneConfig = object(
    await readJson(resolve(outputDirectory, 'phase-one', 'adapter-config.json')),
    'continuation phase-one config',
  );
  const phaseOneAppServer = object(phaseOneConfig.appServer, 'continuation phase-one app server');
  const phaseOneModel = object(phaseOneConfig.model, 'continuation phase-one model');
  const phaseOneResponseTranscriptHash = matchingString(response.transcriptHash, HASH, 'phase-one transcript hash');
  const plan = parseMatchedEvaluationContinuationPilotPlanV1({
    attempts: selection.continuationAttempts,
    candidate: {
      toolArtifactHash: compactDefinition.tool.artifactHash,
      toolVersion: compactDefinition.tool.version,
    },
    checkpoint: {
      adapterConfigurations: {
        threadnoteCompactSha256: sha256Bytes(compactConfigBytes),
        threadnoteGraphSha256: sha256Bytes(graphConfigBytes),
      },
      automaticHandoffReadSha256: sha256Bytes(Buffer.from(automaticHandoffRead.stdout)),
      automaticHandoffUri,
      handoff,
      handoffSha256: sha256Bytes(Buffer.from(handoff)),
      phaseOneAccounting: {
        elapsedMilliseconds: timing.endToEndMilliseconds,
        providerTokens,
        providerTokensMeasured: true,
      },
      phaseOneExecution: {
        adapterArtifactHash: await boundedRegularFileHash(
          resolve(outputDirectory, 'phase-one', 'adapter'),
          128 * 1_024 * 1_024,
          'phase-one adapter',
        ),
        adapterConfigurationFileSha256: await boundedRegularFileHash(
          resolve(outputDirectory, 'phase-one', 'adapter-config.json'),
          MAXIMUM_JSON_BYTES,
          'phase-one adapter config',
        ),
        adapterConfigurationHash: request.adapterConfigurationHash,
        adapterProtocol: request.adapterProtocol,
        appServerExecutableSha256: phaseOneAppServer.executableSha256,
        appServerVersion: phaseOneAppServer.version,
        artifactSha256: await boundedRegularFileHash(
          resolve(outputDirectory, 'phase-one', 'artifact.json'),
          MAXIMUM_JSON_BYTES,
          'phase-one artifact',
        ),
        environmentPolicyHash: request.environmentPolicyHash,
        model: {
          id: phaseOneModel.id,
          parametersHash: phaseOneModel.parametersHash,
          provider: phaseOneModel.provider,
          reasoningEffort: phaseOneModel.reasoningEffort,
        },
        requestSha256: await boundedRegularFileHash(
          resolve(outputDirectory, 'phase-one', 'request.json'),
          MAXIMUM_JSON_BYTES,
          'phase-one request',
        ),
        responseSha256: await boundedRegularFileHash(
          resolve(outputDirectory, 'phase-one', 'response.json'),
          MAXIMUM_JSON_BYTES,
          'phase-one response',
        ),
        runNonce: selection.phaseOneRunNonce,
        transcriptHash: phaseOneResponseTranscriptHash,
        transcriptSha256: await boundedRegularFileHash(
          resolve(outputDirectory, 'phase-one', 'transcript.jsonl'),
          MAXIMUM_TRANSCRIPT_BYTES,
          'phase-one transcript',
        ),
      },
      phaseOnePatchSha256,
      phaseOnePrompt: selection.phaseOnePrompt,
      phaseOnePromptSha256: selection.phaseOnePromptSha256,
      preparedContext: {
        graphContentHash,
        graphSnapshotHash,
        linkReceiptsHash: checkpointContext.linkReceiptsHash,
        taskContextHash: checkpointContext.taskContextHash,
      },
      preparedGraphHome: {
        fixtureHash: graphHomeFixtureHash,
        identitySha256: matchedEvaluationContinuationPreparedHomeIdentityHashV2(preparedGraphHome),
      },
      preparedHome: {
        fixtureHash: compactHomeFixtureHash,
        identitySha256: matchedEvaluationContinuationPreparedHomeIdentityHashV2(preparedCompactHome),
      },
      repositoryFixtureHash: checkpoint.fixtureHash,
      repositoryRevision: checkpoint.revision,
      resumeEvidenceMarker,
    },
    phaseTwoPrompt: selection.taskPacket.phaseTwoPrompt,
    phaseTwoPromptSha256: sha256Bytes(Buffer.from(selection.taskPacket.phaseTwoPrompt)),
    retries: 0,
    sourceTask: selection.sourceTask,
    taskId: corpusTask.taskId,
    phaseTwoVerification,
    version: 3,
  });
  if (plan.version !== 3) throw new Error('Continuation checkpoint finalizer produced a legacy plan.');
  const planPath = resolve(outputDirectory, 'continuation-plan.json');
  await writeFile(planPath, `${JSON.stringify(plan, undefined, 2)}\n`, {flag: 'wx', mode: 0o600});
  const continuationRuntime = {
    ...runtime,
    artifactDirectory: resolve(outputDirectory, 'pilot'),
    repositories: runtime.repositories.map(repository =>
      repository.clusterId === cluster.clusterId
        ? {...repository, repositoryDirectory: checkpointRepository}
        : repository,
    ),
  };
  const continuationRuntimePath = resolve(outputDirectory, 'continuation-runtime.json');
  await writeFile(continuationRuntimePath, `${JSON.stringify(continuationRuntime, undefined, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  await Promise.all([
    assertMatchedEvaluationContinuationPhaseOneEvidenceV2({plan, planPath}),
    assertMatchedEvaluationContinuationAdapterConfigurationsV2({
      manifest,
      plan,
      planPath,
      runtime,
    }),
  ]);
  const receipt = {
    checkpoint,
    focusedCheck: {
      diagnosticSha256: sha256Bytes(Buffer.from(`${focusedCheck.stdout}\0${focusedCheck.stderr}`)),
      exitCode: focusedCheck.exitCode,
    },
    graphContentHash,
    graphSnapshotHash,
    phaseOneReceiptSha256: await boundedRegularFileHash(
      resolve(outputDirectory, 'phase-one-receipt.json'),
      MAXIMUM_JSON_BYTES,
      'continuation phase-one receipt',
    ),
    planSha256: await boundedRegularFileHash(planPath, MAXIMUM_JSON_BYTES, 'continuation plan'),
    runtimeSha256: await boundedRegularFileHash(continuationRuntimePath, MAXIMUM_JSON_BYTES, 'continuation runtime'),
    taskId: corpusTask.taskId,
    version: 1,
  } as const;
  await atomicWrite(
    resolve(outputDirectory, 'continuation-checkpoint-receipt.json'),
    `${JSON.stringify(receipt, undefined, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({checkpoint, outputDirectory, taskId: corpusTask.taskId, version: 1})}\n`);
}

/** Execute one sealed fresh phase-two attempt for each continuation treatment. */
export async function runMatchedEvaluationContinuationPilotFromFilesV1(options: {
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly parentPilotDirectory?: string | null;
  readonly pilotDirectory: string;
  readonly planPath: string;
  readonly runtimePath: string;
  readonly studyPath: string;
}): Promise<void> {
  const planText = await readRequiredText(options.planPath, MAXIMUM_JSON_BYTES);
  let planInput: unknown;
  try {
    planInput = JSON.parse(planText) as unknown;
  } catch (cause) {
    throw new Error(`${options.planPath} is not valid JSON.`, {cause});
  }
  const plan = parseMatchedEvaluationContinuationPilotPlanV1(planInput);
  if (plan.version !== 3) {
    throw new Error('Continuation pilot execution requires a version 3 plan with full Phase-2 verification.');
  }
  const planFileHash = sha256Bytes(Buffer.from(planText));
  const phaseOneEvidence = await assertMatchedEvaluationContinuationPhaseOneEvidenceV2({
    plan,
    planPath: options.planPath,
  });
  const [corpus, manifest, runtime, study] = await Promise.all([
    readJson(options.corpusPath).then(parseMatchedEvaluationCorpusV1),
    readJson(options.manifestPath).then(parseMatchedEvaluationManifestV1),
    readJson(options.runtimePath).then(parseMatchedEvaluationRuntimeV1),
    readJson(options.studyPath).then(parseMatchedTokenEfficiencyStudyV1),
  ]);
  const supplement =
    options.parentPilotDirectory === null || options.parentPilotDirectory === undefined
      ? null
      : await readContinuationSupplementV1(
          options.parentPilotDirectory,
          plan,
          await runtimeAdapterArtifactHashV1(runtime, 'threadnote-compact'),
        );
  assertMatchedTokenEfficiencyStudyMatchesV1(study, corpus, manifest);
  if (runtime.verificationPlanHash !== study.verificationPlanHash) {
    throw new Error('Runtime and study disagree on the sealed verification plan.');
  }
  const adapterConfigOverrides = await assertMatchedEvaluationContinuationAdapterConfigurationsV2({
    manifest,
    plan,
    planPath: options.planPath,
    runtime,
  });
  const task = corpus.tasks.find(candidate => candidate.taskId === plan.taskId);
  if (task === undefined) throw new Error(`Continuation pilot task ${plan.taskId} is not in the corpus.`);
  if (
    task.prompt !== plan.sourceTask.prompt ||
    matchedEvaluationPromptHashV1(task.prompt) !== plan.sourceTask.promptSha256 ||
    task.repositoryFixtureHash !== plan.sourceTask.repositoryFixtureHash
  ) {
    throw new Error('Continuation pilot source task differs from the frozen corpus.');
  }
  const repositoryStudy = continuationCheckpointStudyV2(study, plan.sourceTask, plan.checkpoint);
  for (const arm of ['threadnote-graph', 'threadnote-compact'] as const) {
    const definition = manifest.arms.find(candidate => candidate.arm === arm);
    if (
      definition === undefined ||
      definition.tool.artifactHash !== plan.candidate.toolArtifactHash ||
      definition.tool.version !== plan.candidate.toolVersion
    ) {
      throw new Error(`Continuation pilot ${arm} runtime differs from the sealed candidate.`);
    }
  }
  const pilotDirectory = absolutePath(options.pilotDirectory, 'continuation pilot directory');
  if (pilotDirectory === runtime.artifactDirectory) {
    throw new Error('Continuation pilot directory must be separate from the full-study artifact directory.');
  }
  await mkdir(pilotDirectory, {recursive: true, mode: 0o700});
  if ((await realpath(pilotDirectory)) !== pilotDirectory) {
    throw new Error('Continuation pilot directory must use its canonical path.');
  }
  const plannedAttempts =
    supplement === null
      ? plan.attempts
      : plan.attempts.filter(attempt => attempt.variant === 'threadnote-preloaded-resume');
  const selected = plannedAttempts.map(attempt => {
    const {arm, treatment} = continuationTreatment(attempt.variant, plan.checkpoint);
    return {
      arm,
      row: {
        blindLabel: attempt.blindLabel,
        position: continuationPosition(attempt.runOrder - 1),
        repetition: 1,
        runNonce: attempt.runNonce,
        runOrder: attempt.runOrder,
        taskId: plan.taskId,
      },
      treatment,
      variant: attempt.variant,
    };
  });
  const selection = {
    candidate: plan.candidate,
    checkpoint: projectMatchedEvaluationContinuationSelectionCheckpointV1(plan),
    completionMeaning: `completed is true only when all ${selected.length} fresh phase-two adapter attempts completed; verified completion is verifier-authoritative per attempt.`,
    comparativeClaimsEligible: false,
    identities: {
      manifestHash: manifest.manifestHash,
      planFileHash,
      runtimeVersion: runtime.version,
      studyHash: study.studyHash,
      verificationPlanHash: study.verificationPlanHash,
    },
    limitations: [
      'One development-calibration task, one attempt per treatment, no confidence interval or general product claim.',
      'The common phase-one checkpoint cost is reported separately and is not duplicated into each phase-two attempt.',
      ...(plan.checkpoint.phaseOneAccounting.providerTokensMeasured
        ? []
        : ['The common phase-one provider-token cost is unavailable and excluded from whole-workflow totals.']),
      'No retries are allowed; failed attempts remain in failure-inclusive completion accounting.',
      ...(supplement === null
        ? []
        : [
            'This is a non-blinded supplementary fifth treatment selected after the four-arm parent pilot; it estimates the preloading mechanism only and is not a randomized five-way comparison.',
          ]),
    ],
    phaseTwoPromptSha256: plan.phaseTwoPromptSha256,
    phaseTwoVerificationPlanHash: plan.phaseTwoVerification.planHash,
    planVersion: plan.version,
    sourceTask: {
      promptSha256: plan.sourceTask.promptSha256,
      repositoryFixtureHash: plan.sourceTask.repositoryFixtureHash,
      repositoryRevision: plan.sourceTask.repositoryRevision,
      taskId: plan.sourceTask.taskId,
    },
    rows: selected.map(({arm, row, variant}) => ({...row, arm, variant})),
    ...(supplement === null ? {} : {supplementaryTo: supplement}),
    taskId: plan.taskId,
    version: 2,
  };
  const markerPath = resolve(pilotDirectory, 'continuation-pilot-selection.json');
  try {
    await writeFile(markerPath, `${JSON.stringify(selection, undefined, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (cause) {
    if ((cause as {code?: string}).code === 'EEXIST') {
      throw new Error('Continuation pilot selection already exists; resume/retry is not supported.', {cause});
    }
    throw cause;
  }
  const pilotRuntime = {...runtime, artifactDirectory: pilotDirectory};
  const repositories = await resolveMatchedEvaluationRuntimeRepositoriesV1(
    pilotRuntime,
    repositoryStudy,
    manifest.repository,
  );
  await assertResolvedRuntimeRepositories(repositories);
  const checkpointRepository = requiredRuntimeRepository(repositories, plan.taskId, study);
  if (
    checkpointRepository.expected.fixtureHash !== plan.checkpoint.repositoryFixtureHash ||
    checkpointRepository.expected.revision !== plan.checkpoint.repositoryRevision
  ) {
    throw new Error('Continuation pilot runtime repository differs from the frozen checkpoint.');
  }
  await assertMatchedEvaluationContinuationCheckpointV2({
    baseFixtureHash: plan.sourceTask.repositoryFixtureHash,
    baseRevision: plan.sourceTask.repositoryRevision,
    checkpoint: checkpointRepository.expected,
    agentPatch: phaseOneEvidence.agentPatch,
    patchSha256: plan.checkpoint.phaseOnePatchSha256,
    repositoryDirectory: checkpointRepository.repositoryDirectory,
  });
  const requiredArms = [...new Set([...selected.map(attempt => attempt.arm), 'files' as const])];
  const preflight = await Promise.all(
    requiredArms.map(async arm => {
      const definition = manifest.arms.find(candidate => candidate.arm === arm);
      if (definition === undefined) throw new Error(`Continuation pilot arm ${arm} is not defined.`);
      const resolution = await resolveRuntimeArm(
        pilotRuntime,
        arm,
        definition,
        supplement?.adapterArtifactSha256 ?? null,
        adapterConfigOverrides.get(arm as 'threadnote-compact' | 'threadnote-graph') ?? null,
      );
      if ('reason' in resolution)
        throw new Error(`Continuation pilot runtime unavailable for ${arm}: ${resolution.detail}`);
      return [arm, resolution] as const;
    }),
  );
  const resolved = new Map(preflight);
  const verificationAdapterConfig = parseMatchedEvaluationCodexAdapterConfigV1(
    await readJson(requiredResolvedArm(resolved, 'files').config.adapterConfigFile),
  );
  for (const check of plan.phaseTwoVerification.checks) {
    if (
      !verificationAdapterConfig.approvedCommands.some(
        command => command.taskId === plan.taskId && sameJson(command.tokens, check.commandTokens),
      )
    ) {
      throw new Error('Continuation phase-two verification plan contains a command outside the approved policy.');
    }
  }
  await assertContinuationAutomaticHandoffV1({
    plan,
    resolvedCompactArm: requiredResolvedArm(resolved, 'threadnote-compact'),
  });
  const reportPath = resolve(pilotDirectory, 'continuation-pilot-report.json');
  const attempts: Array<Record<string, unknown>> = [];
  const writeReport = async (completed: boolean) =>
    atomicWrite(reportPath, `${JSON.stringify({...selection, attempts, completed}, undefined, 2)}\n`);
  await writeReport(false);
  for (const selectedAttempt of selected) {
    const {arm, row, treatment, variant} = selectedAttempt;
    const definition = manifest.arms.find(candidate => candidate.arm === arm);
    if (definition === undefined) throw new Error(`Continuation pilot arm ${arm} is not defined.`);
    const rawArtifactPath = resolve(pilotDirectory, 'runs', row.runNonce, 'artifact.json');
    const requestPath = resolve(pilotDirectory, 'runs', row.runNonce, 'request.json');
    const responsePath = resolve(pilotDirectory, 'runs', row.runNonce, 'response.json');
    const transcriptPath = resolve(pilotDirectory, 'transcripts', `${row.runNonce}.jsonl`);
    const checkpointPath = `${transcriptPath}.agent.jsonl`;
    const request: MatchedEvaluationRunRequestV1 = {arm, armDefinition: definition, manifest, schedule: row, task};
    const repository = requiredRuntimeRepository(repositories, plan.taskId, study);
    const projectedTaskOverride = projectMatchedEvaluationContinuationAdapterTaskV2(request, study, plan);
    await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected);
    try {
      const observation = await executeArm(
        pilotRuntime,
        requiredResolvedArm(resolved, arm),
        repository,
        request,
        study,
        treatment,
        projectedTaskOverride,
      );
      const [requestSha256, responseSha256, artifactSha256] = await Promise.all([
        boundedRegularFileHash(requestPath, MAXIMUM_JSON_BYTES, 'continuation pilot request'),
        boundedRegularFileHash(responsePath, MAXIMUM_JSON_BYTES, 'continuation pilot response'),
        boundedRegularFileHash(rawArtifactPath, MAXIMUM_JSON_BYTES, 'continuation pilot artifact'),
      ]);
      if (artifactSha256 !== observation.artifactHash) {
        throw new Error('Continuation pilot report artifact hash differs from the adapter observation.');
      }
      const phaseTwoVerification = await verifyMatchedEvaluationContinuationArtifactV1({
        artifactHash: artifactSha256,
        artifactPath: rawArtifactPath,
        checkpointRepository: repository.repositoryDirectory,
        checkpointRevision: plan.checkpoint.repositoryRevision,
        plan: plan.phaseTwoVerification,
        safeExecutablePath: verificationAdapterConfig.safeExecutablePath,
      });
      attempts.push({
        arm,
        artifactSha256,
        checkpointPath,
        metrics: observation.metrics,
        phaseTwoVerification,
        rawArtifactPath,
        requestPath,
        responsePath,
        responseSha256,
        runNonce: row.runNonce,
        runOrder: row.runOrder,
        requestSha256,
        status: 'completed',
        taskId: plan.taskId,
        transcriptHash: observation.transcriptHash,
        transcriptPath,
        variant,
      });
    } catch (cause) {
      if (!(cause instanceof Error) || !cause.message.includes('adapter failed with exit code')) throw cause;
      const [failureAccounting, requestSha256, responseSha256, artifactSha256] = await Promise.all([
        readContinuationFailureAccounting(checkpointPath),
        optionalBoundedRegularFileHash(requestPath, MAXIMUM_JSON_BYTES, 'continuation pilot failed request'),
        optionalBoundedRegularFileHash(responsePath, MAXIMUM_JSON_BYTES, 'continuation pilot failed response'),
        optionalBoundedRegularFileHash(rawArtifactPath, MAXIMUM_JSON_BYTES, 'continuation pilot failed artifact'),
      ]);
      attempts.push({
        accountingStatus: failureAccounting === null ? 'unavailable-before-checkpoint' : 'retained-agent-checkpoint',
        arm,
        artifactSha256,
        checkpointPath,
        diagnostics: cause.message.slice(-2_048),
        metrics: null,
        providerUsage: failureAccounting?.providerUsage ?? null,
        rawArtifactPath,
        requestPath,
        responsePath,
        responseSha256,
        runNonce: row.runNonce,
        runOrder: row.runOrder,
        requestSha256,
        status: 'failed',
        taskId: plan.taskId,
        timing: failureAccounting?.timing ?? null,
        transcriptPath,
        variant,
      });
    } finally {
      await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected);
    }
    await writeReport(false);
  }
  await assertResolvedRuntimeRepositories(repositories);
  const allCompleted = attempts.every(attempt => attempt.status === 'completed');
  await writeReport(allCompleted);
  process.stdout.write(
    `${JSON.stringify({artifactDirectory: pilotDirectory, attemptCount: attempts.length, comparativeClaimsEligible: false, completed: allCompleted, finished: true, version: 2})}\n`,
  );
}

export function parseMatchedEvaluationRuntimeV1(value: unknown): MatchedEvaluationRuntimeV1 {
  const runtime = object(value, 'runtime');
  exactKeys(
    runtime,
    ['arms', 'artifactDirectory', 'repositories', 'timeoutMilliseconds', 'verificationPlanHash', 'version'],
    'runtime',
  );
  if (runtime.version !== MATCHED_EVALUATION_RUNTIME_VERSION) invalid('runtime version must be 4');
  const arms = array(runtime.arms, 'runtime arms').map((entry, index) => parseRuntimeArm(entry, index));
  const repositories = array(runtime.repositories, 'runtime repositories').map((entry, index) =>
    parseRuntimeRepository(entry, index),
  );
  if (repositories.length === 0 || repositories.length > 64) invalid('runtime repositories must contain 1-64 entries');
  unique(
    arms.map(arm => arm.arm),
    'runtime arm ids',
  );
  unique(
    repositories.map(repository => repository.clusterId ?? 'single-repository'),
    'runtime repository cluster ids',
  );
  unique(
    repositories.map(repository => repository.repositoryDirectory),
    'runtime repository directories',
  );
  return {
    arms,
    artifactDirectory: absolutePath(runtime.artifactDirectory, 'runtime artifact directory'),
    repositories,
    timeoutMilliseconds: boundedPositiveInteger(runtime.timeoutMilliseconds, 60_000, 7_200_000, 'runtime timeout'),
    verificationPlanHash:
      runtime.verificationPlanHash === null
        ? null
        : matchingString(runtime.verificationPlanHash, HASH, 'runtime verification plan hash'),
    version: MATCHED_EVALUATION_RUNTIME_VERSION,
  };
}

export async function resolveMatchedEvaluationRuntimeRepositoriesV1(
  runtime: MatchedEvaluationRuntimeV1,
  study: MatchedTokenEfficiencyStudyV1 | null,
  manifestRepository: MatchedEvaluationRepositoryObservationV1,
): Promise<ReadonlyMap<string | null, ResolvedRuntimeRepository>> {
  const resolved = new Map<string | null, ResolvedRuntimeRepository>();
  if (study === null) {
    if (runtime.repositories.length !== 1 || runtime.repositories[0]?.clusterId !== null) {
      throw new Error('A non-study matched evaluation requires one unclustered runtime repository.');
    }
    const repository = runtime.repositories[0];
    if (repository.repositoryIdentityHash !== manifestRepository.identityHash) {
      throw new Error('Runtime repository identity differs from the content-addressed manifest.');
    }
    await canonicalDirectory(repository.repositoryDirectory, 'runtime repository directory');
    await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, manifestRepository);
    resolved.set(null, {
      clusterId: null,
      expected: manifestRepository,
      repositoryDirectory: repository.repositoryDirectory,
    });
    return resolved;
  }
  if (
    runtime.repositories.length !== study.clusters.length ||
    runtime.repositories.some(entry => entry.clusterId === null)
  ) {
    throw new Error('Token-efficiency runtime repositories do not exactly cover the held-out clusters.');
  }
  await Promise.all(
    study.clusters.map(async cluster => {
      const repository = runtime.repositories.find(candidate => candidate.clusterId === cluster.clusterId);
      if (repository === undefined) throw new Error(`Runtime repository is missing cluster ${cluster.clusterId}.`);
      if (repository.repositoryIdentityHash !== cluster.repositoryIdentityHash) {
        throw new Error(`Runtime repository identity differs for cluster ${cluster.clusterId}.`);
      }
      const expected = {
        dirty: false,
        fixtureHash: cluster.repositoryFixtureHash,
        identityHash: cluster.repositoryIdentityHash,
        revision: cluster.revision,
      } satisfies MatchedEvaluationRepositoryObservationV1;
      await canonicalDirectory(repository.repositoryDirectory, `runtime repository ${cluster.clusterId}`);
      await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, expected);
      resolved.set(cluster.clusterId, {
        clusterId: cluster.clusterId,
        expected,
        repositoryDirectory: repository.repositoryDirectory,
      });
    }),
  );
  return resolved;
}

export function continuationCheckpointStudyV2(
  study: MatchedTokenEfficiencyStudyV1,
  sourceTask: MatchedEvaluationContinuationPilotPlanCurrent['sourceTask'],
  checkpoint: MatchedEvaluationContinuationPilotPlanCurrent['checkpoint'],
): MatchedTokenEfficiencyStudyV1 {
  const taskContext = study.taskContexts.find(candidate => candidate.taskId === sourceTask.taskId);
  if (taskContext === undefined) throw new Error('Continuation source task lacks a study context.');
  const cluster = study.clusters.find(candidate => candidate.clusterId === taskContext.clusterId);
  if (
    cluster === undefined ||
    cluster.repositoryFixtureHash !== sourceTask.repositoryFixtureHash ||
    cluster.revision !== sourceTask.repositoryRevision
  ) {
    throw new Error('Continuation source repository differs from the frozen study cluster.');
  }
  if (checkpoint.preparedContext.graphSnapshotHash === taskContext.graphSnapshotHash) {
    throw new Error('Continuation checkpoint must use a checkpoint-specific prepared graph snapshot.');
  }
  return {
    ...study,
    clusters: study.clusters.map(candidate =>
      candidate.clusterId === cluster.clusterId
        ? {
            ...candidate,
            repositoryFixtureHash: checkpoint.repositoryFixtureHash,
            revision: checkpoint.repositoryRevision,
          }
        : candidate,
    ),
  };
}

async function assertResolvedRuntimeRepositories(
  repositories: ReadonlyMap<string | null, ResolvedRuntimeRepository>,
): Promise<void> {
  await Promise.all(
    [...repositories.values()].map(repository =>
      assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected),
    ),
  );
}

export async function assertMatchedEvaluationContinuationCheckpointV2(input: {
  readonly agentPatch?: string;
  readonly baseFixtureHash: string;
  readonly baseRevision: string;
  readonly checkpoint: MatchedEvaluationRepositoryObservationV1;
  readonly patchSha256: string;
  readonly repositoryDirectory: string;
}): Promise<void> {
  if (input.checkpoint.dirty) throw new Error('Continuation checkpoint must be clean.');
  await assertMatchedEvaluationRepositoryV1(input.repositoryDirectory, input.checkpoint);
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-base-')));
  const patchDirectory = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-patch-')));
  let baseWorktreeCreated = false;
  try {
    await captureContinuationGit(input.repositoryDirectory, [
      'worktree',
      'add',
      '--detach',
      baseDirectory,
      input.baseRevision,
    ]);
    baseWorktreeCreated = true;
    const base = await observeMatchedEvaluationRepositoryV1(baseDirectory);
    if (
      base.dirty ||
      base.fixtureHash !== input.baseFixtureHash ||
      base.identityHash !== input.checkpoint.identityHash ||
      base.revision !== input.baseRevision
    ) {
      throw new Error('Continuation source repository differs from the sealed base fixture.');
    }
    if (input.agentPatch !== undefined) {
      if (input.agentPatch.length === 0 || Buffer.byteLength(input.agentPatch) > 8 * 1_024 * 1_024) {
        throw new Error('Continuation phase-one agent patch is empty or oversized.');
      }
      const patchPath = join(patchDirectory, 'agent.patch');
      await writeFile(patchPath, input.agentPatch, {encoding: 'utf8', flag: 'wx', mode: 0o600});
      await captureContinuationGit(baseDirectory, ['apply', '--index', '--whitespace=nowarn', patchPath]);
      const [agentTree, checkpointTree] = await Promise.all([
        captureContinuationGit(baseDirectory, ['write-tree']),
        captureContinuationGit(input.repositoryDirectory, ['rev-parse', `${input.checkpoint.revision}^{tree}`]),
      ]);
      if (agentTree.trim() !== checkpointTree.trim()) {
        throw new Error('Continuation checkpoint differs from the preserved phase-one agent patch.');
      }
    }
  } finally {
    if (baseWorktreeCreated) {
      await captureContinuationGit(input.repositoryDirectory, ['worktree', 'remove', '--force', baseDirectory]);
    }
    await rm(baseDirectory, {force: true, recursive: true});
    await rm(patchDirectory, {force: true, recursive: true});
  }
  const parent = await captureContinuationGit(input.repositoryDirectory, [
    'rev-list',
    '--parents',
    '--max-count=1',
    input.checkpoint.revision,
  ]);
  const lineage = parent.trim().split(/\s+/u);
  if (lineage.length !== 2 || lineage[0] !== input.checkpoint.revision || lineage[1] !== input.baseRevision) {
    throw new Error('Continuation checkpoint must be one direct non-merge commit after the frozen source revision.');
  }
  const patch = await captureContinuationGit(
    input.repositoryDirectory,
    [
      'diff',
      '--binary',
      '--full-index',
      '--no-color',
      '--no-ext-diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      input.baseRevision,
      input.checkpoint.revision,
      '--',
      '.',
      ':(exclude).context/**',
      ':(exclude)**/.context/**',
    ],
    8 * 1_024 * 1_024,
  );
  if (patch.length === 0) throw new Error('Continuation checkpoint phase-one patch must be nonempty.');
  const sealedPatch = input.agentPatch ?? patch;
  if (sha256Bytes(Buffer.from(sealedPatch)) !== input.patchSha256) {
    throw new Error('Continuation checkpoint phase-one patch differs from the sealed hash.');
  }
}

async function captureContinuationGit(
  repositoryDirectory: string,
  arguments_: readonly string[],
  maxOutputBytes = 64 * 1_024,
): Promise<string> {
  const result = await captureCodeMemoryLinkProcessGroup({
    arguments: ['-C', repositoryDirectory, ...arguments_],
    command: 'git',
    cwd: repositoryDirectory,
    environment: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      HOME: '/nonexistent',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    },
    label: 'Continuation checkpoint provenance',
    maxOutputBytes,
    timeoutMilliseconds: 30_000,
  });
  return result.stdout;
}

async function runMatchedEvaluationContinuationFocusedCheckV1(input: {
  readonly commandTokens: readonly string[];
  readonly repositoryDirectory: string;
  readonly safeExecutablePath: string;
  readonly temporaryDirectory: string;
}) {
  let executableIndex = 0;
  const environmentAssignments: Record<string, string> = {};
  while (
    executableIndex < input.commandTokens.length &&
    /^[A-Z][A-Z0-9_]*=/u.test(input.commandTokens[executableIndex])
  ) {
    const token = input.commandTokens[executableIndex];
    const separator = token.indexOf('=');
    environmentAssignments[token.slice(0, separator)] = token.slice(separator + 1);
    executableIndex += 1;
  }
  const command = input.commandTokens[executableIndex];
  if (command === undefined) throw new Error('Continuation focused check lacks an executable.');
  await mkdir(input.temporaryDirectory, {recursive: true, mode: 0o700});
  return captureCodeMemoryLinkProcessGroup({
    allowFailure: true,
    arguments: input.commandTokens.slice(executableIndex + 1),
    command,
    cwd: input.repositoryDirectory,
    environment: {
      ...environmentAssignments,
      HOME: input.temporaryDirectory,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: input.safeExecutablePath,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
      TMPDIR: input.temporaryDirectory,
    },
    label: 'Continuation phase-one focused check',
    maxOutputBytes: 1 * 1_024 * 1_024,
    timeoutMilliseconds: 15 * 60_000,
  });
}

function matchContinuationPhaseTwoCommandsV1(input: {
  readonly approvedCommands: ReturnType<typeof parseMatchedEvaluationCodexAdapterConfigV1>['approvedCommands'];
  readonly commandTexts: readonly string[];
  readonly taskId: string;
}) {
  if (input.commandTexts.length === 0 || input.commandTexts.length > 8) {
    throw new Error('Continuation phase-two verification must contain 1-8 commands.');
  }
  const matched = input.commandTexts.map((commandText, index) => {
    const canonicalText = commandText.replaceAll('{python}', 'python').trim();
    const candidates = input.approvedCommands.filter(
      command => command.taskId === input.taskId && command.tokens.join(' ') === canonicalText,
    );
    if (candidates.length !== 1) {
      throw new Error(`Continuation phase-two command ${index} is not one unique sealed approved command.`);
    }
    return candidates[0];
  });
  if (new Set(matched.map(command => JSON.stringify(command.tokens))).size !== matched.length) {
    throw new Error('Continuation phase-two verification commands must be unique.');
  }
  return matched;
}

async function prepareMatchedEvaluationContinuationPhaseTwoVerificationPlanV1(input: {
  readonly commands: ReturnType<typeof matchContinuationPhaseTwoCommandsV1>;
  readonly protectedPaths: readonly string[];
  readonly repositoryDirectory: string;
  readonly safeExecutablePath: string;
  readonly taskId: string;
  readonly temporaryRoot: string;
}): Promise<MatchedContinuationPhaseTwoVerificationPlanV1> {
  const checks: Array<{
    readonly allowedBaselineFailureIds: readonly string[];
    readonly commandTokens: readonly string[];
    readonly diagnosticParser: 'pytest-summary-v1';
    readonly policy: 'must-pass' | 'no-new-failures';
  }> = [];
  try {
    for (const [index, command] of input.commands.entries()) {
      const result = await runMatchedEvaluationContinuationFocusedCheckV1({
        commandTokens: command.tokens,
        repositoryDirectory: input.repositoryDirectory,
        safeExecutablePath: input.safeExecutablePath,
        temporaryDirectory: resolve(input.temporaryRoot, `check-${index + 1}`),
      });
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(`Continuation phase-two baseline command ${index} failed as infrastructure.`);
      }
      const failureIds = parseMatchedContinuationPytestFailureIdsV1(result.stdout, result.stderr);
      if (index === 0) {
        if (result.exitCode !== 1 || failureIds.length === 0) {
          throw new Error('Continuation phase-two target check must fail at the Phase-1 checkpoint.');
        }
        checks.push({
          allowedBaselineFailureIds: [],
          commandTokens: command.tokens,
          diagnosticParser: 'pytest-summary-v1',
          policy: 'must-pass',
        });
      } else {
        if (result.exitCode === 1 && failureIds.length === 0) {
          throw new Error(`Continuation phase-two baseline command ${index} has unparseable failures.`);
        }
        checks.push({
          allowedBaselineFailureIds: failureIds,
          commandTokens: command.tokens,
          diagnosticParser: 'pytest-summary-v1',
          policy: 'no-new-failures',
        });
      }
    }
  } finally {
    await rm(input.temporaryRoot, {force: true, recursive: true});
  }
  return createMatchedContinuationPhaseTwoVerificationPlanV1({
    checks,
    protectedPaths: input.protectedPaths,
    taskId: input.taskId,
  });
}

export async function verifyMatchedEvaluationContinuationArtifactV1(input: {
  readonly artifactHash: string;
  readonly artifactPath: string;
  readonly checkpointRepository: string;
  readonly checkpointRevision: string;
  readonly plan: MatchedContinuationPhaseTwoVerificationPlanV1;
  readonly safeExecutablePath: string;
}): Promise<MatchedContinuationPhaseTwoVerificationReceiptV1> {
  const artifact = object(await readJson(input.artifactPath), 'continuation phase-two artifact');
  const patch = boundedString(artifact.patch, 1, 8 * 1_024 * 1_024, 'continuation phase-two patch');
  const startedAt = Date.now();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-phase-two-verification-')));
  const repositoryDirectory = resolve(root, 'repository');
  const patchPath = resolve(root, 'agent.patch');
  let worktreeCreated = false;
  let protectedPathViolations: readonly string[] = [];
  const receipts: MatchedContinuationPhaseTwoVerificationCheckReceiptV1[] = [];
  try {
    await captureContinuationGit(input.checkpointRepository, [
      'worktree',
      'add',
      '--detach',
      repositoryDirectory,
      input.checkpointRevision,
    ]);
    worktreeCreated = true;
    await writeFile(patchPath, patch, {encoding: 'utf8', flag: 'wx', mode: 0o600});
    await captureContinuationGit(repositoryDirectory, ['apply', '--index', '--whitespace=nowarn', patchPath]);
    const changedPaths = (
      await captureContinuationGit(repositoryDirectory, ['diff', '--cached', '--name-only', '-z', '--'])
    )
      .split('\0')
      .filter(Boolean);
    protectedPathViolations = changedPaths.filter(path => input.plan.protectedPaths.includes(path));
    for (const [index, check] of input.plan.checks.entries()) {
      const startedAt = Date.now();
      const result = await runMatchedEvaluationContinuationFocusedCheckV1({
        commandTokens: check.commandTokens,
        repositoryDirectory,
        safeExecutablePath: input.safeExecutablePath,
        temporaryDirectory: resolve(root, `check-${index + 1}`),
      });
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(`Continuation phase-two verification command ${index} failed as infrastructure.`);
      }
      const failureIds = parseMatchedContinuationPytestFailureIdsV1(result.stdout, result.stderr);
      receipts.push(
        createMatchedContinuationPhaseTwoVerificationCheckReceiptV1({
          artifactHash: input.artifactHash,
          check,
          diagnosticHash: sha256Bytes(
            Buffer.from(
              `matched-continuation-phase-two-diagnostic-v1\0${JSON.stringify({
                exitCode: result.exitCode,
                stderr: result.stderr,
                stdout: result.stdout,
              })}`,
            ),
          ),
          durationMilliseconds: Math.max(0, Date.now() - startedAt),
          exitCode: result.exitCode,
          failureIds,
          planHash: input.plan.planHash,
        }),
      );
    }
  } finally {
    if (worktreeCreated) {
      await captureContinuationGit(input.checkpointRepository, ['worktree', 'remove', '--force', repositoryDirectory]);
    }
    await rm(root, {force: true, recursive: true});
  }
  return createMatchedContinuationPhaseTwoVerificationReceiptV1({
    artifactHash: input.artifactHash,
    checks: receipts,
    durationMilliseconds: Math.max(0, Date.now() - startedAt),
    plan: input.plan,
    protectedPathViolations,
  });
}

async function captureMatchedEvaluationContinuationAgentBriefV1(input: {
  readonly budgetTokens: number;
  readonly executable: string;
  readonly home: string;
  readonly project: string;
  readonly repositoryDirectory: string;
  readonly task: string;
  readonly threadnoteEnvironment: Readonly<Record<string, string>>;
}): Promise<{readonly parsed: Record<string, unknown>; readonly text: string}> {
  const client = new Client({name: 'matched-evaluation-checkpoint-finalizer', version: '1'});
  const transport = new StdioClientTransport({
    args: ['mcp-server'],
    command: input.executable,
    cwd: input.repositoryDirectory,
    env: {
      ...input.threadnoteEnvironment,
      CI: '1',
      HOME: input.home,
      LOGNAME: input.threadnoteEnvironment.THREADNOTE_USER ?? 'evaluation-user',
      SHELL: '/bin/sh',
      TERM: 'dumb',
      THREADNOTE_HOME: input.home,
      THREADNOTE_NO_SPINNER: '1',
      THREADNOTE_NO_UPDATE_CHECK: '1',
      USER: input.threadnoteEnvironment.THREADNOTE_USER ?? 'evaluation-user',
    },
    maxBufferSize: 2 * 1_024 * 1_024,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => undefined);
  await client.connect(transport, {timeout: 30_000});
  try {
    const result = await client.callTool(
      {
        arguments: {
          budgetTokens: input.budgetTokens,
          callerCwd: input.repositoryDirectory,
          detail: 'compact',
          mode: 'resume',
          project: input.project,
          responseFormat: 'agent',
          task: input.task,
        },
        name: 'context_brief',
      },
      undefined,
      {timeout: 120_000},
    );
    const resultRecord = object(result, 'continuation checkpoint agent Context Brief result');
    if (resultRecord.isError === true) {
      throw new Error('Continuation checkpoint agent Context Brief returned an error.');
    }
    const texts = array(resultRecord.content, 'continuation checkpoint agent Context Brief content').flatMap(
      (candidate, index) => {
        const content = object(candidate, `continuation checkpoint agent Context Brief content ${index}`);
        return content.type === 'text' && typeof content.text === 'string' ? [content.text] : [];
      },
    );
    if (texts.length !== 1) {
      throw new Error('Continuation checkpoint agent Context Brief must return exactly one text payload.');
    }
    try {
      return {parsed: object(JSON.parse(texts[0]) as unknown, 'continuation checkpoint agent brief'), text: texts[0]};
    } catch (cause) {
      throw new Error('Continuation checkpoint agent Context Brief returned invalid JSON.', {cause});
    }
  } finally {
    await client.close();
    await transport.close();
  }
}

function uniquePrefixedLine(value: string, prefix: string, label: string): string {
  const matches = value
    .split(/\r?\n/u)
    .filter(line => line.startsWith(prefix))
    .map(line => line.slice(prefix.length));
  if (matches.length !== 1 || matches[0].length === 0) throw new Error(`${label} is missing or ambiguous.`);
  return matches[0];
}

function parseLastJsonLine(value: string, label: string): Record<string, unknown> {
  const lines = value
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error(`${label} returned no JSON output.`);
  try {
    return object(JSON.parse(lines.at(-1)!) as unknown, label);
  } catch (cause) {
    throw new Error(`${label} returned invalid terminal JSON.`, {cause});
  }
}

function requiredRuntimeRepository(
  repositories: ReadonlyMap<string | null, ResolvedRuntimeRepository>,
  taskId: string,
  study: MatchedTokenEfficiencyStudyV1 | null,
): ResolvedRuntimeRepository {
  const clusterId = study?.taskContexts.find(context => context.taskId === taskId)?.clusterId ?? null;
  const repository = repositories.get(clusterId);
  if (repository === undefined) throw new Error(`No runtime repository is bound to task ${taskId}.`);
  return repository;
}

async function assertContinuationAutomaticHandoffV1(input: {
  readonly plan: MatchedEvaluationContinuationPilotPlan;
  readonly resolvedCompactArm: ResolvedRuntimeArm;
}): Promise<void> {
  if (input.resolvedCompactArm.toolExecutable === null) {
    throw new Error('Continuation pilot compact arm lacks Threadnote.');
  }
  const config = parseMatchedEvaluationCodexAdapterConfigV1(await readJson(input.resolvedCompactArm.adapterConfigFile));
  const prepared = config.contextHomes.find(home => home.taskId === input.plan.taskId);
  if (prepared === undefined) throw new Error('Continuation pilot compact arm lacks the task prepared home.');
  if (
    input.plan.version !== 1 &&
    (prepared.homeFixtureHash !== input.plan.checkpoint.preparedHome.fixtureHash ||
      matchedEvaluationContinuationPreparedHomeIdentityHashV2(prepared) !==
        input.plan.checkpoint.preparedHome.identitySha256)
  ) {
    throw new Error('Continuation pilot checkpoint prepared home differs from the sealed plan.');
  }
  if ((await matchedEvaluationPreparedHomeFixtureHashV1(prepared.homeDirectory)) !== prepared.homeFixtureHash) {
    throw new Error('Continuation pilot compact prepared home differs from its pinned fixture hash.');
  }
  const read = await captureCodeMemoryLinkProcessGroup({
    arguments: ['read', '--home', prepared.homeDirectory, input.plan.checkpoint.automaticHandoffUri],
    command: input.resolvedCompactArm.toolExecutable,
    cwd: process.cwd(),
    environment: {
      HOME: '/nonexistent',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: '/usr/bin:/bin',
      THREADNOTE_ACCOUNT: prepared.identity.account,
      THREADNOTE_USER: prepared.identity.user,
    },
    label: 'Continuation pilot automatic handoff preflight',
    maxOutputBytes: 1 * 1_024 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  if (
    sha256Bytes(Buffer.from(read.stdout)) !== input.plan.checkpoint.automaticHandoffReadSha256 ||
    !read.stdout.includes(input.plan.checkpoint.resumeEvidenceMarker) ||
    !read.stdout.includes(input.plan.checkpoint.handoff)
  ) {
    throw new Error('Continuation pilot automatic handoff differs from the sealed checkpoint.');
  }
}

export function matchedEvaluationContinuationPreparedHomeIdentityHashV2(
  prepared: Pick<
    ReturnType<typeof parseMatchedEvaluationCodexAdapterConfigV1>['contextHomes'][number],
    'identity' | 'project' | 'taskId'
  >,
): string {
  return sha256Bytes(
    Buffer.from(
      JSON.stringify({
        account: prepared.identity.account,
        project: prepared.project,
        taskId: prepared.taskId,
        user: prepared.identity.user,
      }),
    ),
  );
}

export async function resolveRuntimeArm(
  runtime: MatchedEvaluationRuntimeV1,
  arm: MatchedEvaluationArm,
  definition: MatchedEvaluationArmDefinitionV1,
  adapterArtifactHashOverride: string | null = null,
  adapterConfigOverride: MatchedEvaluationContinuationAdapterConfigOverrideV2 | null = null,
): Promise<ResolvedRuntimeArm | {readonly detail: string; readonly reason: MatchedEvaluationUnavailableReason}> {
  const config = runtime.arms.find(candidate => candidate.arm === arm);
  if (config === undefined) return {detail: `${arm} has no local runtime mapping`, reason: 'runtime-not-configured'};
  const [adapter, adapterConfigFile] = await Promise.all([
    optionalCanonicalRegularFile(config.adapterExecutable, true),
    optionalCanonicalRegularFile(adapterConfigOverride?.adapterConfigFile ?? config.adapterConfigFile, false),
  ]);
  if (adapter === null) return {detail: `${arm} adapter executable is missing`, reason: 'adapter-missing'};
  if (adapterConfigFile === null) {
    return {detail: `${arm} adapter configuration is missing`, reason: 'adapter-config-missing'};
  }
  const adapterArtifactHash = adapterArtifactHashOverride ?? definition.adapterArtifactHash;
  if ((await sha256File(adapter)) !== adapterArtifactHash) {
    throw new Error(`${arm} adapter executable differs from its pinned manifest identity.`);
  }
  const resolvedDefinition = {
    ...definition,
    adapterArtifactHash,
    adapterConfigurationHash: adapterConfigOverride?.adapterConfigurationHash ?? definition.adapterConfigurationHash,
  };
  if (
    (await sha256File(adapterConfigFile)) !==
    (adapterConfigOverride?.adapterConfigurationHash ?? definition.adapterConfigurationHash)
  ) {
    throw new Error(`${arm} adapter configuration differs from its pinned manifest identity.`);
  }
  if (definition.tool.artifactHash === null) {
    if (config.toolExecutable !== null || config.toolLockFile !== null) {
      throw new Error(`${arm} runtime unexpectedly configures a separate tool executable or lock.`);
    }
    return {
      adapterConfigFile,
      config: {...config, adapterConfigFile, adapterExecutable: adapter},
      definition: resolvedDefinition,
      toolExecutable: null,
    };
  }
  if (config.toolExecutable === null || config.toolLockFile === null) {
    return {detail: `${arm} tool executable or lock identity is not configured`, reason: 'tool-missing'};
  }
  const [tool, lock] = await Promise.all([
    optionalCanonicalRegularFile(config.toolExecutable, true),
    optionalCanonicalRegularFile(config.toolLockFile, false),
  ]);
  if (tool === null || lock === null) {
    return {detail: `${arm} pinned tool executable or lock identity is missing`, reason: 'tool-missing'};
  }
  const [toolHash, lockHash] = await Promise.all([sha256File(tool), sha256File(lock)]);
  if (toolHash !== definition.tool.artifactHash || lockHash !== definition.tool.lockIdentityHash) {
    throw new Error(`${arm} tool executable or lock differs from its pinned manifest identity.`);
  }
  return {
    adapterConfigFile,
    config: {...config, adapterExecutable: adapter, toolExecutable: tool, toolLockFile: lock},
    definition: resolvedDefinition,
    toolExecutable: tool,
  };
}

async function executeArm(
  runtime: MatchedEvaluationRuntimeV1,
  resolvedArm: ResolvedRuntimeArm,
  repository: ResolvedRuntimeRepository,
  request: MatchedEvaluationRunRequestV1,
  study: MatchedTokenEfficiencyStudyV1 | null,
  continuationTreatment: MatchedEvaluationContinuationTreatmentV1 | null = null,
  projectedTaskOverride: MatchedEvaluationProjectedAdapterTask | null = null,
) {
  const runDirectory = resolve(runtime.artifactDirectory, 'runs', request.schedule.runNonce);
  const transcriptDirectory = resolve(runtime.artifactDirectory, 'transcripts');
  const requestPath = resolve(runDirectory, 'request.json');
  const responsePath = resolve(runDirectory, 'response.json');
  const artifactPath = resolve(runDirectory, 'artifact.json');
  const transcriptPath = resolve(transcriptDirectory, `${request.schedule.runNonce}.jsonl`);
  const stagedDirectory = resolve(runDirectory, 'runtime');
  await rm(stagedDirectory, {force: true, recursive: true});
  await Promise.all([
    mkdir(runDirectory, {recursive: true, mode: 0o700}),
    mkdir(transcriptDirectory, {recursive: true, mode: 0o700}),
    mkdir(stagedDirectory, {recursive: true, mode: 0o700}),
  ]);
  const stagedArm = await stageResolvedRuntimeArmV1(resolvedArm, stagedDirectory);
  if (request.arm === 'reference-scope')
    await mkdir(resolve(runDirectory, 'reference-home'), {recursive: true, mode: 0o700});
  const projectedTask = projectedTaskOverride ?? projectMatchedEvaluationAdapterTaskV1(request, study);
  await atomicWrite(
    requestPath,
    `${JSON.stringify(
      {
        adapterArtifactHash: stagedArm.definition.adapterArtifactHash,
        adapterProtocol: stagedArm.definition.adapterProtocol,
        adapterConfigurationHash: stagedArm.definition.adapterConfigurationHash,
        arm: request.arm,
        environmentPolicyHash: stagedArm.definition.environmentPolicyHash,
        agentTask: projectedTask.agentTask,
        artifactPath,
        blindLabel: request.schedule.blindLabel,
        continuationTreatment,
        judgeTask: {
          negativeControls: request.task.negativeControls,
          rubric: request.task.rubric,
          sourceGold: request.task.sourceGold,
        },
        manifestHash: request.manifest.manifestHash,
        model: request.manifest.model,
        repository: repository.expected,
        preparedContext: projectedTask.preparedContext,
        runNonce: request.schedule.runNonce,
        runOrder: request.schedule.runOrder,
        tool: {
          artifactHash: stagedArm.definition.tool.artifactHash,
          detail:
            request.arm === 'threadnote-source'
              ? 'source'
              : request.arm === 'threadnote-compact'
                ? 'compact'
                : request.arm === 'threadnote-graph'
                  ? 'graph-only'
                  : null,
          executable: stagedArm.toolExecutable,
          lockIdentityHash: stagedArm.definition.tool.lockIdentityHash,
          name: stagedArm.definition.tool.name,
          version: stagedArm.definition.tool.version,
        },
        transcriptPath,
        verificationPlanHash: study?.verificationPlanHash ?? null,
        version: MATCHED_EVALUATION_RUNTIME_VERSION,
      },
      undefined,
      2,
    )}\n`,
  );
  await assertResolvedRuntimeArmArtifactsV1(stagedArm);
  let result;
  try {
    result = await captureCodeMemoryLinkProcessGroup({
      allowFailure: true,
      arguments: [...stagedArm.config.adapterArguments, '--request', requestPath, '--response', responsePath],
      command: stagedArm.config.adapterExecutable,
      cwd: repository.repositoryDirectory,
      environment: runtimeEnvironment(stagedArm, runDirectory),
      label: `Matched evaluation ${request.arm}`,
      maxOutputBytes: 1 * 1_024 * 1_024,
      timeoutMilliseconds: runtime.timeoutMilliseconds,
    });
  } finally {
    await assertResolvedRuntimeArmArtifactsV1(stagedArm);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${request.arm} adapter failed with exit code ${result.exitCode}: ${boundedDiagnostic(result)}`);
  }
  const observation = parseMatchedEvaluationObservationV1(await readJson(responsePath));
  if (study !== null) {
    if (projectedTaskOverride === null) {
      assertMatchedTokenEfficiencyObservationContextV1({
        arm: request.arm,
        metrics: observation.metrics,
        study,
        taskId: request.task.taskId,
      });
    } else {
      assertProjectedObservationContext(projectedTask, observation.metrics.context);
    }
  }
  const [artifactHash, transcriptHash] = await Promise.all([
    boundedRegularFileHash(artifactPath, MAXIMUM_JSON_BYTES, 'adapter artifact'),
    boundedRegularFileHash(transcriptPath, MAXIMUM_TRANSCRIPT_BYTES, 'local transcript'),
  ]);
  if (artifactHash !== observation.artifactHash || transcriptHash !== observation.transcriptHash) {
    throw new Error(`${request.arm} adapter observation does not bind its local artifact and transcript bytes.`);
  }
  return observation;
}

function assertProjectedObservationContext(
  projectedTask: MatchedEvaluationProjectedAdapterTask,
  observationContext: unknown,
): void {
  if (projectedTask.preparedContext === null) {
    if (observationContext !== null) throw new Error('Continuation files arm unexpectedly reported context.');
    return;
  }
  const expected = object(projectedTask.preparedContext, 'continuation projected context');
  const memoryAccess = matchingString(
    expected.memoryAccess,
    /^(?:disabled|linked)$/u,
    'continuation projected memory access',
  );
  const expectedEvidence = object(
    memoryAccess === 'disabled' ? expected.graphContext : expected.taskContext,
    'continuation projected evidence',
  );
  const actual = object(observationContext, 'continuation observation context');
  const wanted = {
    graphReady: true,
    graphSnapshotHash: expectedEvidence.graphSnapshotHash,
    linkReceiptsHash: memoryAccess === 'disabled' ? null : expectedEvidence.linkReceiptsHash,
    memoryAccess,
    studyHash: expected.studyHash,
    taskContextHash: memoryAccess === 'disabled' ? null : expectedEvidence.taskContextHash,
  } as const;
  for (const [key, value] of Object.entries(wanted)) {
    if (actual[key] !== value) throw new Error(`Continuation observation context mismatch: ${key}.`);
  }
}

export async function stageResolvedRuntimeArmV1(
  resolvedArm: ResolvedRuntimeArm,
  stagedDirectory: string,
): Promise<ResolvedRuntimeArm> {
  const [adapterExecutable, adapterConfigFile] = await Promise.all([
    stageMatchedEvaluationPinnedFileV1(
      resolvedArm.config.adapterExecutable,
      resolve(stagedDirectory, 'adapter'),
      resolvedArm.definition.adapterArtifactHash,
      true,
      `${resolvedArm.definition.arm} adapter executable`,
    ),
    stageMatchedEvaluationPinnedFileV1(
      resolvedArm.adapterConfigFile,
      resolve(stagedDirectory, 'adapter-config.json'),
      resolvedArm.definition.adapterConfigurationHash,
      false,
      `${resolvedArm.definition.arm} adapter configuration`,
    ),
  ]);
  if (resolvedArm.definition.tool.artifactHash === null) {
    return {
      adapterConfigFile,
      config: {...resolvedArm.config, adapterConfigFile, adapterExecutable},
      definition: resolvedArm.definition,
      toolExecutable: null,
    };
  }
  if (
    resolvedArm.config.toolExecutable === null ||
    resolvedArm.config.toolLockFile === null ||
    resolvedArm.definition.tool.lockIdentityHash === null
  ) {
    throw new Error(`${resolvedArm.definition.arm} lost its pinned tool configuration.`);
  }
  if (resolvedArm.definition.tool.name === 'threadnote' && resolvedArm.definition.tool.version === '5.0.7') {
    if (
      resolvedArm.definition.tool.lockIdentityHash !== PRODUCTION_RELEASE_ARCHIVE_HASH ||
      resolvedArm.definition.tool.artifactHash !== PRODUCTION_RELEASE_EXECUTABLE_HASH
    ) {
      throw new Error('Production release manifest identities do not match the pinned 5.0.7 release.');
    }
    const payload = await stageMatchedEvaluationProductionPayloadV1({
      archivePath: resolvedArm.config.toolLockFile,
      archiveHash: PRODUCTION_RELEASE_ARCHIVE_HASH,
      directory: resolve(stagedDirectory, 'subject-release'),
      executableHash: PRODUCTION_RELEASE_EXECUTABLE_HASH,
    });
    return {
      adapterConfigFile,
      config: {
        ...resolvedArm.config,
        adapterConfigFile,
        adapterExecutable,
        toolExecutable: payload.executable,
        toolLockFile: payload.stagedArchive,
      },
      definition: resolvedArm.definition,
      toolExecutable: payload.executable,
      toolPayload: {hash: payload.payloadHash, root: payload.root},
    };
  }
  const [toolExecutable, toolLockFile] = await Promise.all([
    stageMatchedEvaluationPinnedFileV1(
      resolvedArm.config.toolExecutable,
      resolve(stagedDirectory, 'tool'),
      resolvedArm.definition.tool.artifactHash,
      true,
      `${resolvedArm.definition.arm} tool executable`,
    ),
    stageMatchedEvaluationPinnedFileV1(
      resolvedArm.config.toolLockFile,
      resolve(stagedDirectory, 'tool.lock'),
      resolvedArm.definition.tool.lockIdentityHash,
      false,
      `${resolvedArm.definition.arm} tool lock`,
    ),
  ]);
  return {
    adapterConfigFile,
    config: {...resolvedArm.config, adapterConfigFile, adapterExecutable, toolExecutable, toolLockFile},
    definition: resolvedArm.definition,
    toolExecutable,
  };
}

export async function stageMatchedEvaluationProductionPayloadV1(input: {
  readonly archivePath: string;
  readonly archiveHash: string;
  readonly directory: string;
  readonly executableHash: string;
}): Promise<{
  readonly executable: string;
  readonly payloadHash: string;
  readonly root: string;
  readonly stagedArchive: string;
}> {
  if (
    input.archiveHash !== PRODUCTION_RELEASE_ARCHIVE_HASH ||
    input.executableHash !== PRODUCTION_RELEASE_EXECUTABLE_HASH
  ) {
    throw new Error('Production release identities are not the pinned 5.0.7 identities.');
  }
  if ((await sha256File(input.archivePath)) !== input.archiveHash)
    throw new Error('Production release archive differs from its pinned identity.');
  await mkdir(input.directory, {mode: 0o700});
  const canonicalDirectory = await realpath(input.directory);
  const stagedArchive = resolve(canonicalDirectory, '..', 'subject-release.tar.gz');
  await stageMatchedEvaluationPinnedFileV1(
    input.archivePath,
    stagedArchive,
    input.archiveHash,
    false,
    'production release archive',
  );
  const listing = await captureCodeMemoryLinkProcessGroup({
    arguments: ['-tzf', stagedArchive],
    command: '/usr/bin/tar',
    cwd: canonicalDirectory,
    environment: {HOME: '/nonexistent', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin', TMPDIR: '/tmp'},
    label: 'Matched evaluation production release archive inspection',
    maxOutputBytes: 4 * 1_024 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  for (const name of listing.stdout
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)) {
    if (name.startsWith('/') || name.split('/').includes('..') || name.includes('\\0')) {
      throw new Error('Production release archive contains an unsafe path.');
    }
  }
  await captureCodeMemoryLinkProcessGroup({
    arguments: ['-xzf', stagedArchive, '-C', canonicalDirectory],
    command: '/usr/bin/tar',
    cwd: input.directory,
    environment: {HOME: '/nonexistent', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin', TMPDIR: '/tmp'},
    label: 'Matched evaluation production release extraction',
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  const root = canonicalDirectory;
  const executable = resolve(root, 'threadnote');
  await assertPayloadTreeV1(root);
  if ((await sha256File(executable)) !== input.executableHash)
    throw new Error('Extracted production executable differs from its pinned identity.');
  return {executable, payloadHash: await hashMatchedEvaluationPayloadV1(root), root, stagedArchive};
}

async function assertPayloadTreeV1(root: string): Promise<void> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('Production payload root must be a real directory.');
  for (const entry of await readdir(root)) {
    const path = resolve(root, entry);
    const child = await lstat(path);
    if (child.isSymbolicLink()) throw new Error(`Production payload contains symbolic link: ${entry}`);
    if (child.isDirectory()) await assertPayloadTreeV1(path);
    else if (!child.isFile() || child.nlink !== 1)
      throw new Error(`Production payload contains unsupported file: ${entry}`);
  }
}

export async function hashMatchedEvaluationPayloadV1(root: string): Promise<string> {
  const files: Array<{readonly mode: number; readonly path: string; readonly relative: string}> = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const path = resolve(directory, entry);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`Production payload contains symbolic link: ${relative}`);
      if (metadata.isDirectory()) await visit(path, relative);
      else if (!metadata.isFile() || metadata.nlink !== 1)
        throw new Error(`Production payload contains unsupported file: ${relative}`);
      else files.push({mode: metadata.mode & 0o7777, path, relative});
    }
  };
  await visit(root, '');
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  const hash = createHash('sha256');
  for (const file of files)
    hash.update(`${file.relative}\0${file.mode.toString(8)}\0${sha256Bytes(await readFile(file.path))}\n`);
  return hash.digest('hex');
}

async function assertResolvedRuntimeArmArtifactsV1(resolvedArm: ResolvedRuntimeArm): Promise<void> {
  await Promise.all([
    assertMatchedEvaluationPinnedFileV1(
      resolvedArm.config.adapterExecutable,
      resolvedArm.definition.adapterArtifactHash,
      true,
      `${resolvedArm.definition.arm} adapter executable`,
    ),
    assertMatchedEvaluationPinnedFileV1(
      resolvedArm.adapterConfigFile,
      resolvedArm.definition.adapterConfigurationHash,
      false,
      `${resolvedArm.definition.arm} adapter configuration`,
    ),
  ]);
  if (resolvedArm.definition.tool.artifactHash === null) return;
  if (
    resolvedArm.config.toolExecutable === null ||
    resolvedArm.config.toolLockFile === null ||
    resolvedArm.definition.tool.lockIdentityHash === null
  ) {
    throw new Error(`${resolvedArm.definition.arm} lost its pinned tool configuration.`);
  }
  await Promise.all([
    assertMatchedEvaluationPinnedFileV1(
      resolvedArm.config.toolExecutable,
      resolvedArm.definition.tool.artifactHash,
      true,
      `${resolvedArm.definition.arm} tool executable`,
    ),
    assertMatchedEvaluationPinnedFileV1(
      resolvedArm.config.toolLockFile,
      resolvedArm.definition.tool.lockIdentityHash,
      false,
      `${resolvedArm.definition.arm} tool lock`,
    ),
  ]);
  if (resolvedArm.toolPayload !== undefined) {
    if ((await hashMatchedEvaluationPayloadV1(resolvedArm.toolPayload.root)) !== resolvedArm.toolPayload.hash) {
      throw new Error(`${resolvedArm.definition.arm} staged production payload changed.`);
    }
  }
}

function runtimeEnvironment(resolvedArm: ResolvedRuntimeArm, runDirectory: string): Readonly<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {
    HOME: '/nonexistent',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/bin:/bin',
    TMPDIR: '/tmp',
  };
  environment.MATCHED_EVALUATION_ADAPTER_CONFIG = resolvedArm.adapterConfigFile;
  environment.MATCHED_EVALUATION_ADAPTER_EXECUTABLE = resolvedArm.config.adapterExecutable;
  for (const key of resolvedArm.config.environmentKeys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (resolvedArm.definition.arm === 'reference-scope') {
    Object.assign(environment, matchedEvaluationReferenceEnvironmentPolicyV1(), {
      HOME: resolve(runDirectory, 'reference-home'),
    });
  }
  if (resolvedArm.toolExecutable !== null) environment.MATCHED_EVALUATION_TOOL = resolvedArm.toolExecutable;
  return environment;
}

function parseRuntimeArm(value: unknown, index: number): MatchedEvaluationRuntimeArmV1 {
  const arm = object(value, `runtime arm ${index}`);
  exactKeys(
    arm,
    [
      'adapterArguments',
      'adapterConfigFile',
      'adapterExecutable',
      'arm',
      'environmentKeys',
      'toolExecutable',
      'toolLockFile',
    ],
    `runtime arm ${index}`,
  );
  const environmentKeys = stringArray(arm.environmentKeys, 0, 32, 64, `runtime arm ${index} environment keys`);
  unique(environmentKeys, `runtime arm ${index} environment keys`);
  if (environmentKeys.some(key => !ENVIRONMENT_KEY.test(key) || BLOCKED_ENVIRONMENT_KEYS.has(key))) {
    invalid(`runtime arm ${index} contains a reserved or invalid environment key`);
  }
  return {
    adapterArguments: stringArray(arm.adapterArguments, 0, 64, 4_096, `runtime arm ${index} adapter arguments`),
    adapterConfigFile: absolutePath(arm.adapterConfigFile, `runtime arm ${index} adapter configuration`),
    adapterExecutable: absolutePath(arm.adapterExecutable, `runtime arm ${index} adapter executable`),
    arm: literal(arm.arm, MATCHED_EVALUATION_ARMS, `runtime arm ${index} id`),
    environmentKeys,
    toolExecutable:
      arm.toolExecutable === null ? null : absolutePath(arm.toolExecutable, `runtime arm ${index} tool executable`),
    toolLockFile:
      arm.toolLockFile === null ? null : absolutePath(arm.toolLockFile, `runtime arm ${index} tool lock file`),
  };
}

function parseRuntimeRepository(value: unknown, index: number): MatchedEvaluationRuntimeRepositoryV1 {
  const repository = object(value, `runtime repository ${index}`);
  exactKeys(repository, ['clusterId', 'repositoryDirectory', 'repositoryIdentityHash'], `runtime repository ${index}`);
  return {
    clusterId:
      repository.clusterId === null
        ? null
        : matchingString(repository.clusterId, CLUSTER_ID, `runtime repository ${index} cluster id`),
    repositoryDirectory: absolutePath(repository.repositoryDirectory, `runtime repository ${index} directory`),
    repositoryIdentityHash: matchingString(
      repository.repositoryIdentityHash,
      HASH,
      `runtime repository ${index} identity hash`,
    ),
  };
}

function parseArguments(args: readonly string[]): {
  readonly continuationFinalizeDirectory: string | null;
  readonly continuationPhaseOneDirectory: string | null;
  readonly continuationPhaseOneTaskPacketPath: string | null;
  readonly continuationPilotPlanPath: string | null;
  readonly continuationParentPilotDirectory: string | null;
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly runtimePath: string;
  readonly studyPath: string | null;
  readonly pilotTaskId: string | null;
  readonly pilotDirectory: string | null;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (
      ![
        '--continuation-finalize-directory',
        '--continuation-phase-one-directory',
        '--continuation-phase-one-packet',
        '--continuation-pilot-plan',
        '--continuation-parent-pilot-directory',
        '--corpus',
        '--manifest',
        '--runtime',
        '--study',
        '--pilot-task',
        '--pilot-directory',
      ].includes(option) ||
      values.has(option)
    ) {
      throw ScriptError.make({message: `Unknown or repeated matched evaluation option: ${option}`});
    }
    values.set(option, required(args[++index], option));
  }
  const pilotTaskId = values.get('--pilot-task') ?? null;
  const pilotDirectory = values.get('--pilot-directory') ?? null;
  const continuationFinalizeDirectory = values.get('--continuation-finalize-directory') ?? null;
  const continuationPhaseOneTaskPacket = values.get('--continuation-phase-one-packet') ?? null;
  const continuationPhaseOneDirectory = values.get('--continuation-phase-one-directory') ?? null;
  const continuationPilotPlan = values.get('--continuation-pilot-plan') ?? null;
  const continuationParentPilotDirectory = values.get('--continuation-parent-pilot-directory') ?? null;
  if (
    [
      pilotTaskId !== null,
      continuationPilotPlan !== null,
      continuationPhaseOneTaskPacket !== null,
      continuationFinalizeDirectory !== null,
    ].filter(Boolean).length > 1
  ) {
    throw ScriptError.make({message: 'Matched evaluation pilot selectors are mutually exclusive'});
  }
  if ((pilotTaskId !== null || continuationPilotPlan !== null) !== (pilotDirectory !== null)) {
    throw ScriptError.make({
      message: 'Pilot mode requires exactly one pilot selector together with --pilot-directory',
    });
  }
  if (continuationParentPilotDirectory !== null && continuationPilotPlan === null) {
    throw ScriptError.make({message: '--continuation-parent-pilot-directory requires --continuation-pilot-plan'});
  }
  if ((continuationPhaseOneTaskPacket !== null) !== (continuationPhaseOneDirectory !== null)) {
    throw ScriptError.make({
      message:
        'Continuation Phase 1 requires both --continuation-phase-one-packet and --continuation-phase-one-directory',
    });
  }
  if (
    (pilotTaskId !== null ||
      continuationPilotPlan !== null ||
      continuationPhaseOneTaskPacket !== null ||
      continuationFinalizeDirectory !== null) &&
    values.get('--study') === undefined
  )
    throw ScriptError.make({message: 'Pilot mode requires --study'});
  return {
    continuationFinalizeDirectory:
      continuationFinalizeDirectory === null
        ? null
        : absolutePath(continuationFinalizeDirectory, '--continuation-finalize-directory'),
    continuationPhaseOneDirectory:
      continuationPhaseOneDirectory === null
        ? null
        : absolutePath(continuationPhaseOneDirectory, '--continuation-phase-one-directory'),
    continuationPhaseOneTaskPacketPath:
      continuationPhaseOneTaskPacket === null
        ? null
        : absolutePath(continuationPhaseOneTaskPacket, '--continuation-phase-one-packet'),
    continuationPilotPlanPath:
      continuationPilotPlan === null ? null : absolutePath(continuationPilotPlan, '--continuation-pilot-plan'),
    continuationParentPilotDirectory:
      continuationParentPilotDirectory === null
        ? null
        : absolutePath(continuationParentPilotDirectory, '--continuation-parent-pilot-directory'),
    corpusPath: absolutePath(required(values.get('--corpus'), '--corpus'), '--corpus'),
    manifestPath: absolutePath(required(values.get('--manifest'), '--manifest'), '--manifest'),
    runtimePath: absolutePath(required(values.get('--runtime'), '--runtime'), '--runtime'),
    studyPath:
      values.get('--study') === undefined ? null : absolutePath(required(values.get('--study'), '--study'), '--study'),
    pilotTaskId,
    pilotDirectory: pilotDirectory === null ? null : absolutePath(pilotDirectory, '--pilot-directory'),
  };
}

async function assertLocalArtifactDirectory(path: string): Promise<void> {
  if (!path.split(sep).includes('.context')) {
    throw new Error('Runtime artifact directory must be inside a local .context directory.');
  }
  await mkdir(path, {recursive: true, mode: 0o700});
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error('Runtime artifact directory must use its canonical path.');
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${label} must use its canonical path.`);
  return canonical;
}

async function canonicalRegularFile(path: string, label: string): Promise<string> {
  const canonical = await optionalCanonicalRegularFile(path, false);
  if (canonical === null) throw new Error(`${label} is missing.`);
  return canonical;
}

async function optionalCanonicalRegularFile(path: string, executable: boolean): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${path} must be one regular non-linked file.`);
  }
  if (executable && (metadata.mode & 0o111) === 0) throw new Error(`${path} must be executable.`);
  const canonical = await realpath(path);
  const current = await stat(canonical);
  if (canonical !== path || current.dev !== metadata.dev || current.ino !== metadata.ino) {
    throw new Error(`${path} changed or is not canonical.`);
  }
  return canonical;
}

async function boundedRegularFileHash(path: string, maximumBytes: number, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximumBytes) {
    throw new Error(`${label} is not one bounded regular file.`);
  }
  return sha256Bytes(await readFile(path));
}

async function optionalBoundedRegularFileHash(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<string | null> {
  try {
    return await boundedRegularFileHash(path, maximumBytes, label);
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
}

async function readContinuationSupplementV1(
  parentPilotDirectory: string,
  plan: MatchedEvaluationContinuationPilotPlan,
  adapterArtifactSha256: string,
): Promise<MatchedEvaluationContinuationSupplementV1> {
  const canonicalParent = await canonicalDirectory(parentPilotDirectory, 'continuation supplement parent directory');
  const selectionPath = resolve(canonicalParent, 'continuation-pilot-selection.json');
  const reportPath = resolve(canonicalParent, 'continuation-pilot-report.json');
  const [selectionText, reportText] = await Promise.all([
    readRequiredText(selectionPath, MAXIMUM_JSON_BYTES),
    readRequiredText(reportPath, MAXIMUM_JSON_BYTES),
  ]);
  let parentSelection: unknown;
  let parentReport: unknown;
  try {
    parentSelection = JSON.parse(selectionText) as unknown;
    parentReport = JSON.parse(reportText) as unknown;
  } catch (cause) {
    throw new Error('Continuation supplement parent evidence is not valid JSON.', {cause});
  }
  return assertMatchedEvaluationContinuationSupplementV1({
    adapterArtifactSha256,
    parentReport,
    parentReportSha256: sha256Bytes(Buffer.from(reportText)),
    parentSelection,
    parentSelectionSha256: sha256Bytes(Buffer.from(selectionText)),
    plan,
  });
}

async function runtimeAdapterArtifactHashV1(
  runtime: MatchedEvaluationRuntimeV1,
  arm: MatchedEvaluationArm,
): Promise<string> {
  const config = runtime.arms.find(candidate => candidate.arm === arm);
  if (config === undefined) throw new Error(`Continuation supplement has no runtime mapping for ${arm}.`);
  const adapter = await optionalCanonicalRegularFile(config.adapterExecutable, true);
  if (adapter === null) throw new Error(`Continuation supplement ${arm} adapter executable is missing.`);
  return sha256File(adapter);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

async function readContinuationFailureAccounting(path: string): Promise<{
  readonly providerUsage: {
    readonly cachedInputTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningOutputTokens: number;
    readonly totalTokens: number;
  };
  readonly timing: {readonly agentTaskMilliseconds: number; readonly preparationMilliseconds: number};
} | null> {
  const text = await readOptionalTextOrNull(path, MAXIMUM_TRANSCRIPT_BYTES);
  if (text === null) return null;
  let input: unknown;
  try {
    input = JSON.parse(text.trim()) as unknown;
  } catch (cause) {
    throw new Error('Continuation pilot agent checkpoint is not valid JSON.', {cause});
  }
  const checkpoint = object(input, 'continuation pilot agent checkpoint');
  const usage = object(checkpoint.usage, 'continuation pilot agent checkpoint usage');
  const timing = object(checkpoint.timing, 'continuation pilot agent checkpoint timing');
  const providerUsage = {
    cachedInputTokens: boundedNonnegativeInteger(usage.cachedInputTokens, 10_000_000, 'checkpoint cached input tokens'),
    inputTokens: boundedNonnegativeInteger(usage.inputTokens, 10_000_000, 'checkpoint input tokens'),
    outputTokens: boundedNonnegativeInteger(usage.outputTokens, 10_000_000, 'checkpoint output tokens'),
    reasoningOutputTokens: boundedNonnegativeInteger(
      usage.reasoningOutputTokens,
      10_000_000,
      'checkpoint reasoning output tokens',
    ),
    totalTokens: boundedNonnegativeInteger(usage.totalTokens, 10_000_000, 'checkpoint total tokens'),
  };
  if (
    providerUsage.cachedInputTokens > providerUsage.inputTokens ||
    providerUsage.reasoningOutputTokens > providerUsage.outputTokens ||
    providerUsage.totalTokens !== providerUsage.inputTokens + providerUsage.outputTokens
  ) {
    throw new Error('Continuation pilot agent checkpoint token components are inconsistent.');
  }
  return {
    providerUsage,
    timing: {
      agentTaskMilliseconds: boundedNonnegativeInteger(
        timing.agentTaskMilliseconds,
        86_400_000,
        'checkpoint agent task milliseconds',
      ),
      preparationMilliseconds: boundedNonnegativeInteger(
        timing.preparationMilliseconds,
        86_400_000,
        'checkpoint preparation milliseconds',
      ),
    },
  };
}

async function readJson(path: string): Promise<unknown> {
  const text = await readRequiredText(path, MAXIMUM_JSON_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`${path} is not valid JSON.`, {cause});
  }
}

async function readRequiredText(path: string, maximumBytes: number): Promise<string> {
  const text = await readOptionalTextOrNull(path, maximumBytes);
  if (text === null) throw new Error(`${path} does not exist.`);
  return text;
}

async function readOptionalText(path: string, maximumBytes: number): Promise<string> {
  return (await readOptionalTextOrNull(path, maximumBytes)) ?? '';
}

async function readOptionalTextOrNull(path: string, maximumBytes: number): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximumBytes) {
    throw new Error(`${path} is not one bounded regular file.`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== metadata.size) throw new Error(`${path} changed while it was read.`);
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await mkdir(resolve(path, '..'), {recursive: true, mode: 0o700});
  try {
    await rm(temporary, {force: true});
    await writeFile(temporary, content, {encoding: 'utf8', flag: 'wx', mode: 0o600});
    await rename(temporary, path);
  } finally {
    await rm(temporary, {force: true});
  }
}

async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function boundedDiagnostic(result: {readonly stderr: string; readonly stdout: string}): string {
  const diagnostic = [result.stderr && `stderr: ${result.stderr}`, result.stdout && `stdout: ${result.stdout}`]
    .filter(Boolean)
    .join('\n');
  return diagnostic.slice(-2_048) || '(no output)';
}

function requiredResolvedArm(
  resolved: ReadonlyMap<MatchedEvaluationArm, ResolvedRuntimeArm>,
  arm: MatchedEvaluationArm,
): ResolvedRuntimeArm {
  const value = resolved.get(arm);
  if (value === undefined) throw new Error(`${arm} runtime was not resolved before execution.`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) {
    invalid(`${label} must be a normalized absolute path`);
  }
  return value;
}

function boundedPositiveInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} is outside its allowed range`);
  }
  return value;
}

function boundedNonnegativeInteger(value: unknown, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    invalid(`${label} is outside its allowed range`);
  }
  return value;
}

function boundedString(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function stringArray(
  value: unknown,
  minimum: number,
  maximum: number,
  maximumLength: number,
  label: string,
): readonly string[] {
  const values = array(value, label);
  if (values.length < minimum || values.length > maximum) invalid(`${label} has invalid bounds`);
  return values.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > maximumLength || entry.includes('\0')) {
      invalid(`${label} ${index} is invalid`);
    }
    return entry;
  });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

function matchingString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

function isMissing(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

function invalid(message: string): never {
  throw new Error(`Invalid matched evaluation runtime: ${message}.`);
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
