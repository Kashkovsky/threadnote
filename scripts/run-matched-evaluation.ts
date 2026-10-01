#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This evaluation runner owns pinned local executable, artifact, and process-group boundaries. */

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {createHash} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve, sep} from 'node:path';
import {Effect} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  matchedEvaluationReferenceEnvironmentPolicyV1,
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
  assertMatchedTokenEfficiencyObservationContextV1,
  assertMatchedTokenEfficiencyStudyMatchesV1,
  evaluateMatchedTokenEfficiencyV1,
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
  plan: MatchedEvaluationContinuationPilotPlanV2,
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

interface ResolvedRuntimeArm {
  readonly config: MatchedEvaluationRuntimeArmV1;
  readonly adapterConfigFile: string;
  readonly definition: MatchedEvaluationArmDefinitionV1;
  readonly toolExecutable: string | null;
  readonly toolPayload?: {readonly root: string; readonly hash: string};
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

export type MatchedEvaluationContinuationPilotPlan =
  MatchedEvaluationContinuationPilotPlanV1 | MatchedEvaluationContinuationPilotPlanV2;

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
  if (version !== 1 && version !== 2) invalid('continuation pilot plan version is invalid');
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
      ...(version === 2
        ? [
            'phaseOneExecution',
            'phaseOnePatchSha256',
            'phaseOnePrompt',
            'phaseOnePromptSha256',
            'preparedContext',
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
  if (sha256Bytes(Buffer.from(sourcePrompt)) !== sourcePromptSha256) {
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
  return {
    ...common,
    checkpoint: {
      ...common.checkpoint,
      phaseOnePatchSha256: matchingString(
        checkpoint.phaseOnePatchSha256,
        HASH,
        'continuation pilot phase-one patch hash',
      ),
      phaseOneExecution: parseContinuationPhaseOneExecutionV2(checkpoint.phaseOneExecution),
      phaseOnePrompt,
      phaseOnePromptSha256,
      preparedContext: parseContinuationPreparedContextV2(checkpoint.preparedContext),
      preparedHome: parseContinuationPreparedHomeV2(checkpoint.preparedHome),
    },
    phaseTwoPrompt,
    phaseTwoPromptSha256,
    sourceTask: parsedSourceTask,
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

function parseContinuationPreparedHomeV2(
  value: unknown,
): MatchedEvaluationContinuationPilotPlanV2['checkpoint']['preparedHome'] {
  const home = object(value, 'continuation pilot prepared home');
  exactKeys(home, ['fixtureHash', 'identitySha256'], 'continuation pilot prepared home');
  return {
    fixtureHash: matchingString(home.fixtureHash, HASH, 'continuation pilot prepared home fixture hash'),
    identitySha256: matchingString(home.identitySha256, HASH, 'continuation pilot prepared home identity hash'),
  };
}

/** Bind the v2 phase-one claims to immutable sibling evidence before any phase-two attempt starts. */
export async function assertMatchedEvaluationContinuationPhaseOneEvidenceV2(input: {
  readonly plan: MatchedEvaluationContinuationPilotPlanV2;
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
    agentResult.completed !== true ||
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
  if (
    safety.blockedActions !== 0 ||
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
    ...(plan.version === 2
      ? {
          phaseOneExecution: plan.checkpoint.phaseOneExecution,
          phaseOnePatchSha256: plan.checkpoint.phaseOnePatchSha256,
          phaseOnePromptSha256: plan.checkpoint.phaseOnePromptSha256,
          preparedContext: plan.checkpoint.preparedContext,
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
  const planFileHash = sha256Bytes(Buffer.from(planText));
  const phaseOneEvidence =
    plan.version === 2
      ? await assertMatchedEvaluationContinuationPhaseOneEvidenceV2({plan, planPath: options.planPath})
      : null;
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
  const task = corpus.tasks.find(candidate => candidate.taskId === plan.taskId);
  if (task === undefined) throw new Error(`Continuation pilot task ${plan.taskId} is not in the corpus.`);
  if (plan.version === 1 && sha256Bytes(Buffer.from(task.prompt)) !== plan.baseTaskPromptSha256) {
    throw new Error('Continuation pilot task prompt differs from the sealed plan.');
  }
  if (
    plan.version === 2 &&
    (task.prompt !== plan.sourceTask.prompt ||
      sha256Bytes(Buffer.from(task.prompt)) !== plan.sourceTask.promptSha256 ||
      task.repositoryFixtureHash !== plan.sourceTask.repositoryFixtureHash)
  ) {
    throw new Error('Continuation pilot source task differs from the frozen corpus.');
  }
  if (plan.version === 1 && task.repositoryFixtureHash !== plan.checkpoint.repositoryFixtureHash) {
    throw new Error('Continuation pilot checkpoint differs from the frozen repository fixture.');
  }
  const repositoryStudy =
    plan.version === 1 ? study : continuationCheckpointStudyV2(study, plan.sourceTask, plan.checkpoint);
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
  await assertContinuationAutomaticHandoffV1({
    adapterArtifactHashOverride: supplement?.adapterArtifactSha256 ?? null,
    manifest,
    plan,
    runtime,
  });
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
    ...(plan.version === 2
      ? {
          planVersion: plan.version,
          phaseTwoPromptSha256: plan.phaseTwoPromptSha256,
          sourceTask: {
            promptSha256: plan.sourceTask.promptSha256,
            repositoryFixtureHash: plan.sourceTask.repositoryFixtureHash,
            repositoryRevision: plan.sourceTask.repositoryRevision,
            taskId: plan.sourceTask.taskId,
          },
        }
      : {}),
    rows: selected.map(({arm, row, variant}) => ({...row, arm, variant})),
    ...(supplement === null ? {} : {supplementaryTo: supplement}),
    taskId: plan.taskId,
    version: 1,
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
  if (plan.version === 2) {
    await assertMatchedEvaluationContinuationCheckpointV2({
      baseFixtureHash: plan.sourceTask.repositoryFixtureHash,
      baseRevision: plan.sourceTask.repositoryRevision,
      checkpoint: checkpointRepository.expected,
      agentPatch: phaseOneEvidence!.agentPatch,
      patchSha256: plan.checkpoint.phaseOnePatchSha256,
      repositoryDirectory: checkpointRepository.repositoryDirectory,
    });
  }
  const requiredArms = [...new Set(selected.map(attempt => attempt.arm))];
  const preflight = await Promise.all(
    requiredArms.map(async arm => {
      const definition = manifest.arms.find(candidate => candidate.arm === arm);
      if (definition === undefined) throw new Error(`Continuation pilot arm ${arm} is not defined.`);
      const resolution = await resolveRuntimeArm(
        pilotRuntime,
        arm,
        definition,
        supplement?.adapterArtifactSha256 ?? null,
      );
      if ('reason' in resolution)
        throw new Error(`Continuation pilot runtime unavailable for ${arm}: ${resolution.detail}`);
      return [arm, resolution] as const;
    }),
  );
  const resolved = new Map(preflight);
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
    const projectedTaskOverride =
      plan.version === 2 ? projectMatchedEvaluationContinuationAdapterTaskV2(request, study, plan) : null;
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
      attempts.push({
        arm,
        artifactSha256,
        checkpointPath,
        metrics: observation.metrics,
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
    `${JSON.stringify({artifactDirectory: pilotDirectory, attemptCount: attempts.length, comparativeClaimsEligible: false, completed: allCompleted, finished: true, version: 1})}\n`,
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
  sourceTask: MatchedEvaluationContinuationPilotPlanV2['sourceTask'],
  checkpoint: MatchedEvaluationContinuationPilotPlanV2['checkpoint'],
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
  if (sha256Bytes(Buffer.from(patch)) !== input.patchSha256) {
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
  readonly adapterArtifactHashOverride?: string | null;
  readonly manifest: MatchedEvaluationManifestV1;
  readonly plan: MatchedEvaluationContinuationPilotPlan;
  readonly runtime: MatchedEvaluationRuntimeV1;
}): Promise<void> {
  const definition = input.manifest.arms.find(candidate => candidate.arm === 'threadnote-compact');
  if (definition === undefined) throw new Error('Continuation pilot lacks a compact arm definition.');
  const resolved = await resolveRuntimeArm(
    input.runtime,
    'threadnote-compact',
    definition,
    input.adapterArtifactHashOverride ?? null,
  );
  if ('reason' in resolved) {
    throw new Error(`Continuation pilot runtime unavailable for threadnote-compact: ${resolved.detail}`);
  }
  if (resolved.toolExecutable === null) throw new Error('Continuation pilot compact arm lacks Threadnote.');
  const config = parseMatchedEvaluationCodexAdapterConfigV1(await readJson(resolved.adapterConfigFile));
  const prepared = config.contextHomes.find(home => home.taskId === input.plan.taskId);
  if (prepared === undefined) throw new Error('Continuation pilot compact arm lacks the task prepared home.');
  if (
    input.plan.version === 2 &&
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
    command: resolved.toolExecutable,
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

async function resolveRuntimeArm(
  runtime: MatchedEvaluationRuntimeV1,
  arm: MatchedEvaluationArm,
  definition: MatchedEvaluationArmDefinitionV1,
  adapterArtifactHashOverride: string | null = null,
): Promise<ResolvedRuntimeArm | {readonly detail: string; readonly reason: MatchedEvaluationUnavailableReason}> {
  const config = runtime.arms.find(candidate => candidate.arm === arm);
  if (config === undefined) return {detail: `${arm} has no local runtime mapping`, reason: 'runtime-not-configured'};
  const [adapter, adapterConfigFile] = await Promise.all([
    optionalCanonicalRegularFile(config.adapterExecutable, true),
    optionalCanonicalRegularFile(config.adapterConfigFile, false),
  ]);
  if (adapter === null) return {detail: `${arm} adapter executable is missing`, reason: 'adapter-missing'};
  if (adapterConfigFile === null) {
    return {detail: `${arm} adapter configuration is missing`, reason: 'adapter-config-missing'};
  }
  const adapterArtifactHash = adapterArtifactHashOverride ?? definition.adapterArtifactHash;
  if ((await sha256File(adapter)) !== adapterArtifactHash) {
    throw new Error(`${arm} adapter executable differs from its pinned manifest identity.`);
  }
  const resolvedDefinition = adapterArtifactHashOverride === null ? definition : {...definition, adapterArtifactHash};
  if ((await sha256File(adapterConfigFile)) !== definition.adapterConfigurationHash) {
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

async function stageResolvedRuntimeArmV1(
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
  const continuationPilotPlan = values.get('--continuation-pilot-plan') ?? null;
  const continuationParentPilotDirectory = values.get('--continuation-parent-pilot-directory') ?? null;
  if (pilotTaskId !== null && continuationPilotPlan !== null) {
    throw ScriptError.make({message: '--pilot-task and --continuation-pilot-plan are mutually exclusive'});
  }
  if ((pilotTaskId !== null || continuationPilotPlan !== null) !== (pilotDirectory !== null)) {
    throw ScriptError.make({
      message: 'Pilot mode requires exactly one pilot selector together with --pilot-directory',
    });
  }
  if (continuationParentPilotDirectory !== null && continuationPilotPlan === null) {
    throw ScriptError.make({message: '--continuation-parent-pilot-directory requires --continuation-pilot-plan'});
  }
  if ((pilotTaskId !== null || continuationPilotPlan !== null) && values.get('--study') === undefined)
    throw ScriptError.make({message: 'Pilot mode requires --study'});
  return {
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
