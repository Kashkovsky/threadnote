import {
  evaluateCodeMemoryLinkAgentAb,
  parseCodeMemoryLinkAgentAbAssignmentV1,
  parseCodeMemoryLinkAgentAbManifestV1,
  parseCodeMemoryLinkAgentAbTrialV1,
  type CodeMemoryLinkAgentAbArm,
  type CodeMemoryLinkAgentAbScenarioFamily,
} from './code-memory-link-agent-ab.js';
import {deriveCodeMemoryLinkCodexAppServerProjectionV1} from './code-memory-link-agent-protocol.js';
import {parseCodeMemoryLinkAgentEvidenceReceiptV1} from './code-memory-link-agent-evidence.js';

/** A retrieval-primary analysis of the frozen agent study, separate from the action-primary release gate. */
export interface CodeMemoryLinkAgentStudyCellV1 {
  readonly acceptedStaleOrHarmful: boolean;
  readonly arm: CodeMemoryLinkAgentAbArm;
  readonly clientId: string;
  readonly goldCallBeforeAction: boolean;
  readonly protocolAdhered: boolean;
  readonly scenarioFamily: CodeMemoryLinkAgentAbScenarioFamily;
  readonly taskId: string;
  readonly taskKind: 'hidden-constraint' | 'negative-control';
  readonly taskPassed: boolean;
  readonly usefulMemoryUse: boolean;
  readonly validCallGold: boolean;
}

export interface CodeMemoryLinkAgentStudyContrastV1 {
  readonly anchored: number;
  readonly blocks: number;
  readonly differencePercentagePoints: number;
  readonly losses: number;
  readonly taskOnly: number;
  readonly ties: number;
  readonly wins: number;
}

export interface CodeMemoryLinkAgentStudyResultV1 {
  readonly assessable: boolean;
  readonly assignmentHash: string;
  readonly candidate: {readonly buildIdentityHash: string; readonly commit: string};
  readonly completedCells: number;
  readonly contrast: CodeMemoryLinkAgentStudyContrastV1 | null;
  readonly contrastBounds: {readonly minimumNetWins: number; readonly maximumNetWins: number};
  readonly byClient: Readonly<Record<string, CodeMemoryLinkAgentStudyContrastV1 | null>>;
  readonly byFamily: Readonly<Record<string, CodeMemoryLinkAgentStudyContrastV1 | null>>;
  readonly harmfulAcceptanceCount: number;
  readonly hiddenTaskPass: Readonly<
    Record<CodeMemoryLinkAgentAbArm, {readonly passed: number; readonly total: number}>
  >;
  readonly manifestHash: string;
  readonly mechanism: Readonly<
    Record<
      CodeMemoryLinkAgentAbArm,
      {
        readonly assignedGold: number;
        readonly assignedTrials: number;
        readonly validCallGold: number;
        readonly validCalls: number;
      }
    >
  >;
  readonly negativeControlRegressions: number | null;
  readonly pairedHiddenBlocks: number;
  readonly scheduledCells: number;
  readonly studyDecision: 'improvement' | 'no-improvement' | 'not-assessable';
  readonly usefulMemoryUse: Readonly<
    Record<CodeMemoryLinkAgentAbArm, {readonly observed: number; readonly total: number}>
  >;
}

export function evaluateCodeMemoryLinkAgentStudyV1(input: {
  readonly assignment: unknown;
  readonly attempts: readonly unknown[];
  readonly evidence: readonly unknown[];
  readonly manifest: unknown;
  readonly trials: readonly unknown[];
}): CodeMemoryLinkAgentStudyResultV1 {
  const assignment = parseCodeMemoryLinkAgentAbAssignmentV1(input.assignment);
  const manifest = parseCodeMemoryLinkAgentAbManifestV1(input.manifest);
  const trials = input.trials.map(parseCodeMemoryLinkAgentAbTrialV1);
  const receipts = input.evidence.map(parseCodeMemoryLinkAgentEvidenceReceiptV1);
  const releaseEvaluation = evaluateCodeMemoryLinkAgentAb({...input, assignment, manifest, trials, evidence: receipts});
  if (trials.some(trial => trial.evidenceKind !== 'external-agent')) {
    throw new Error('Code Memory Link study requires external-agent trials only.');
  }
  if (!releaseEvaluation.evidence.approvedManifest) {
    throw new Error('Code Memory Link study manifest must be approved before governed trials.');
  }
  const allowedInsufficiency = 'external evidence hash is not in the code-reviewed release allowlist';
  const otherInsufficiencies = releaseEvaluation.gate.insufficiencies.filter(item => item !== allowedInsufficiency);
  if (otherInsufficiencies.length > 0) {
    throw new Error(`Code Memory Link study evidence is not replayable: ${otherInsufficiencies.join('; ')}`);
  }
  const taskById = new Map(manifest.tasks.map(task => [task.taskId, task]));
  const cells: CodeMemoryLinkAgentStudyCellV1[] = trials.map((trial, index) => {
    const raw = receipts[index].rawEvidence;
    const projection = deriveCodeMemoryLinkCodexAppServerProjectionV1({evidence: raw.appServer, rubric: raw.rubric});
    const task = taskById.get(trial.taskId);
    if (!task) throw new Error('Validated study trial has no manifest task.');
    const call = projection.contextBriefProtocolAdhered ? projection.contextBriefCalls[0] : undefined;
    return {
      acceptedStaleOrHarmful: trial.acceptedStaleOrHarmful,
      arm: assignment.labels[trial.blindLabel],
      clientId: trial.clientId,
      goldCallBeforeAction:
        trial.taskKind === 'hidden-constraint' &&
        assignment.labels[trial.blindLabel] !== 'no-memory' &&
        !!call?.goldCitationMatched &&
        call.beforeQualifyingAction,
      protocolAdhered: projection.contextBriefProtocolAdhered,
      scenarioFamily: task.scenarioFamily,
      taskId: trial.taskId,
      taskKind: trial.taskKind,
      taskPassed: trial.taskPassed,
      usefulMemoryUse: trial.firstUsefulMemoryUse !== null,
      validCallGold: trial.taskKind === 'hidden-constraint' && !!call?.goldCitationMatched,
    };
  });
  return summarizeCodeMemoryLinkAgentStudyV1({
    assignmentHash: assignment.assignmentHash,
    candidate: manifest.candidate,
    cells,
    manifestHash: manifest.manifestHash,
    scheduledCells: manifest.schedule.length,
    hiddenBlocks: manifest.clients.flatMap(client =>
      manifest.tasks
        .filter(task => task.taskKind === 'hidden-constraint')
        .map(task => ({clientId: client.clientId, scenarioFamily: task.scenarioFamily, taskId: task.taskId})),
    ),
    negativeBlocks: manifest.clients.flatMap(client =>
      manifest.tasks
        .filter(task => task.taskKind === 'negative-control')
        .map(task => ({clientId: client.clientId, taskId: task.taskId})),
    ),
  });
}

export function summarizeCodeMemoryLinkAgentStudyV1(input: {
  readonly assignmentHash: string;
  readonly candidate: {readonly buildIdentityHash: string; readonly commit: string};
  readonly cells: readonly CodeMemoryLinkAgentStudyCellV1[];
  readonly hiddenBlocks: readonly {
    readonly clientId: string;
    readonly scenarioFamily: CodeMemoryLinkAgentAbScenarioFamily;
    readonly taskId: string;
  }[];
  readonly manifestHash: string;
  readonly negativeBlocks: readonly {readonly clientId: string; readonly taskId: string}[];
  readonly scheduledCells: number;
}): CodeMemoryLinkAgentStudyResultV1 {
  const byKey = new Map(input.cells.map(cell => [cellKey(cell.clientId, cell.taskId, cell.arm), cell]));
  if (byKey.size !== input.cells.length) throw new Error('Code Memory Link study cells must be unique.');
  const hidden = input.cells.filter(cell => cell.taskKind === 'hidden-constraint');
  const arms = ['anchored', 'task-only', 'no-memory'] as const;
  const mechanism = Object.fromEntries(
    arms.map(arm => {
      const assigned = hidden.filter(cell => cell.arm === arm);
      return [
        arm,
        {
          assignedGold: assigned.filter(cell => cell.goldCallBeforeAction).length,
          assignedTrials: assigned.length,
          validCallGold: assigned.filter(cell => cell.protocolAdhered && cell.validCallGold).length,
          validCalls: assigned.filter(cell => cell.protocolAdhered).length,
        },
      ];
    }),
  ) as CodeMemoryLinkAgentStudyResultV1['mechanism'];
  const hiddenTaskPass = Object.fromEntries(
    arms.map(arm => {
      const assigned = hidden.filter(cell => cell.arm === arm);
      return [arm, {passed: assigned.filter(cell => cell.taskPassed).length, total: assigned.length}];
    }),
  ) as CodeMemoryLinkAgentStudyResultV1['hiddenTaskPass'];
  const usefulMemoryUse = Object.fromEntries(
    arms.map(arm => {
      const assigned = hidden.filter(cell => cell.arm === arm);
      return [arm, {observed: assigned.filter(cell => cell.usefulMemoryUse).length, total: assigned.length}];
    }),
  ) as CodeMemoryLinkAgentStudyResultV1['usefulMemoryUse'];
  const contrast = (blocks: typeof input.hiddenBlocks): CodeMemoryLinkAgentStudyContrastV1 | null => {
    const pairs = blocks.map(block => ({
      anchored: byKey.get(cellKey(block.clientId, block.taskId, 'anchored')),
      taskOnly: byKey.get(cellKey(block.clientId, block.taskId, 'task-only')),
    }));
    if (pairs.some(pair => !pair.anchored || !pair.taskOnly)) return null;
    const wins = pairs.filter(
      pair => pair.anchored!.goldCallBeforeAction && !pair.taskOnly!.goldCallBeforeAction,
    ).length;
    const losses = pairs.filter(
      pair => !pair.anchored!.goldCallBeforeAction && pair.taskOnly!.goldCallBeforeAction,
    ).length;
    return {
      anchored: pairs.filter(pair => pair.anchored!.goldCallBeforeAction).length,
      blocks: pairs.length,
      differencePercentagePoints: pairs.length === 0 ? 0 : (100 * (wins - losses)) / pairs.length,
      losses,
      taskOnly: pairs.filter(pair => pair.taskOnly!.goldCallBeforeAction).length,
      ties: pairs.length - wins - losses,
      wins,
    };
  };
  const overall = contrast(input.hiddenBlocks);
  const clients = [...new Set(input.hiddenBlocks.map(block => block.clientId))].sort();
  const families = [...new Set(input.hiddenBlocks.map(block => block.scenarioFamily))].sort();
  const byClient = Object.fromEntries(
    clients.map(clientId => [clientId, contrast(input.hiddenBlocks.filter(block => block.clientId === clientId))]),
  );
  const byFamily = Object.fromEntries(
    families.map(family => [family, contrast(input.hiddenBlocks.filter(block => block.scenarioFamily === family))]),
  );
  let minimumNetWins = 0;
  let maximumNetWins = 0;
  for (const block of input.hiddenBlocks) {
    const anchored = byKey.get(cellKey(block.clientId, block.taskId, 'anchored'));
    const taskOnly = byKey.get(cellKey(block.clientId, block.taskId, 'task-only'));
    minimumNetWins += (anchored?.goldCallBeforeAction ? 1 : 0) - (taskOnly?.goldCallBeforeAction === false ? 0 : 1);
    maximumNetWins += (anchored?.goldCallBeforeAction === false ? 0 : 1) - (taskOnly?.goldCallBeforeAction ? 1 : 0);
  }
  const complete = input.cells.length === input.scheduledCells && overall !== null;
  const negativeControlRegressions = complete
    ? input.negativeBlocks.reduce((count, block) => {
        const noMemory = byKey.get(cellKey(block.clientId, block.taskId, 'no-memory'));
        const anchored = byKey.get(cellKey(block.clientId, block.taskId, 'anchored'));
        const taskOnly = byKey.get(cellKey(block.clientId, block.taskId, 'task-only'));
        if (!noMemory || !anchored || !taskOnly) throw new Error('Complete study has a missing negative-control arm.');
        return count + (noMemory.taskPassed && (!anchored.taskPassed || !taskOnly.taskPassed) ? 1 : 0);
      }, 0)
    : null;
  const harmfulAcceptanceCount = input.cells.filter(cell => cell.acceptedStaleOrHarmful).length;
  const familyNonregression = Object.values(byFamily).every(item => item !== null && item.wins >= item.losses);
  const clientNonregression = Object.values(byClient).every(item => item !== null && item.wins >= item.losses);
  const anchoredOnlyImprovement =
    (byFamily['hidden:anchored-only']?.wins ?? 0) > (byFamily['hidden:anchored-only']?.losses ?? 0);
  const improvement =
    complete &&
    overall.wins - overall.losses >= 3 &&
    anchoredOnlyImprovement &&
    familyNonregression &&
    clientNonregression;
  return {
    assessable: complete,
    assignmentHash: input.assignmentHash,
    candidate: input.candidate,
    completedCells: input.cells.length,
    contrast: overall,
    contrastBounds: {minimumNetWins, maximumNetWins},
    byClient,
    byFamily,
    harmfulAcceptanceCount,
    hiddenTaskPass,
    manifestHash: input.manifestHash,
    mechanism,
    negativeControlRegressions,
    pairedHiddenBlocks: input.hiddenBlocks.length,
    scheduledCells: input.scheduledCells,
    studyDecision: !complete ? 'not-assessable' : improvement ? 'improvement' : 'no-improvement',
    usefulMemoryUse,
  };
}

function cellKey(clientId: string, taskId: string, arm: CodeMemoryLinkAgentAbArm): string {
  return `${clientId}\0${taskId}\0${arm}`;
}
