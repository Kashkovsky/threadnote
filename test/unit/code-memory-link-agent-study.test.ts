import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  summarizeCodeMemoryLinkAgentStudyV1,
  type CodeMemoryLinkAgentStudyCellV1,
} from '../../src/evaluation/code-memory-link-agent-study.js';

const ARMS = ['anchored', 'task-only', 'no-memory'] as const;
const CLIENTS = ['client-a', 'client-b'] as const;
const HIDDEN_TASKS = Array.from({length: 12}, (_, index) => ({
  scenarioFamily: index < 5 ? ('hidden:lexical' as const) : ('hidden:anchored-only' as const),
  taskId: `hidden-${index}`,
}));
const CONTROL_TASKS = Array.from({length: 16}, (_, index) => ({
  scenarioFamily: `control:family-${index}` as const,
  taskId: `control-${index}`,
}));

describe('Code Memory Link retrieval-primary agent study', () => {
  it('counts missing and failed calls as assigned-trial zero, independently of useful action', () => {
    const cells = fullCells().map(cell => {
      if (cell.clientId !== 'client-a' || cell.taskId !== 'hidden-5') return cell;
      if (cell.arm === 'anchored') {
        return {...cell, goldCallBeforeAction: true, protocolAdhered: true, taskPassed: false, validCallGold: true};
      }
      if (cell.arm === 'task-only') {
        return {...cell, goldCallBeforeAction: false, protocolAdhered: false, validCallGold: false};
      }
      return cell;
    });
    const result = summarize(cells);

    expect(result.assessable).toBe(true);
    expect(result.contrast).toMatchObject({anchored: 1, blocks: 24, losses: 0, taskOnly: 0, wins: 1});
    expect(result.mechanism.anchored).toEqual({assignedGold: 1, assignedTrials: 24, validCallGold: 1, validCalls: 1});
    expect(result.mechanism['task-only']).toEqual({
      assignedGold: 0,
      assignedTrials: 24,
      validCallGold: 0,
      validCalls: 0,
    });
    expect(result.hiddenTaskPass.anchored.passed).toBe(0);
    expect(result.studyDecision).toBe('no-improvement');
  });

  it('requires three net wins and anchored-only improvement without conflating safety with retrieval', () => {
    const cells = fullCells().map(cell => {
      if (cell.arm === 'anchored' && cell.clientId === 'client-a' && ['hidden-5', 'hidden-6'].includes(cell.taskId)) {
        return {...cell, goldCallBeforeAction: true, protocolAdhered: true, validCallGold: true};
      }
      if (cell.arm === 'anchored' && cell.clientId === 'client-b' && cell.taskId === 'hidden-5') {
        return {...cell, goldCallBeforeAction: true, protocolAdhered: true, validCallGold: true};
      }
      return cell;
    });
    const result = summarize(cells);
    expect(result.contrast).toMatchObject({anchored: 3, taskOnly: 0, wins: 3, losses: 0});
    expect(result.contrast?.differencePercentagePoints).toBe(12.5);
    expect(result.studyDecision).toBe('improvement');

    const unsafe = summarize(
      cells.map((cell, index) => (index === 0 ? {...cell, acceptedStaleOrHarmful: true} : cell)),
    );
    expect(unsafe.studyDecision).toBe('improvement');
    expect(unsafe.harmfulAcceptanceCount).toBe(1);
  });

  it('reports best and worst bounds but no primary decision on an observed prefix', () => {
    const cells = fullCells()
      .slice(0, 1)
      .map(cell => ({...cell, goldCallBeforeAction: true}));
    const result = summarize(cells);
    expect(result.assessable).toBe(false);
    expect(result.studyDecision).toBe('not-assessable');
    expect(result.contrast).toBeNull();
    expect(result.contrastBounds).toEqual({minimumNetWins: -23, maximumNetWins: 24});
  });

  it('is invariant to evidence-cell order and preserves the paired win/loss identity', () => {
    const cells = fullCells().map((cell, index) => ({
      ...cell,
      goldCallBeforeAction: cell.taskKind === 'hidden-constraint' && cell.arm !== 'no-memory' && index % 7 === 0,
    }));
    const expected = summarize(cells);
    fc.assert(
      fc.property(fc.shuffledSubarray(cells, {minLength: cells.length, maxLength: cells.length}), shuffled => {
        const result = summarize(shuffled);
        expect(result).toEqual(expected);
        expect(result.contrast!.anchored - result.contrast!.taskOnly).toBe(
          result.contrast!.wins - result.contrast!.losses,
        );
      }),
      {numRuns: 20},
    );
  });
});

function fullCells(): CodeMemoryLinkAgentStudyCellV1[] {
  return CLIENTS.flatMap(clientId =>
    [
      ...HIDDEN_TASKS.map(task => ({...task, taskKind: 'hidden-constraint' as const})),
      ...CONTROL_TASKS.map(task => ({...task, taskKind: 'negative-control' as const})),
    ].flatMap(task =>
      ARMS.map(arm => ({
        acceptedStaleOrHarmful: false,
        arm,
        clientId,
        goldCallBeforeAction: false,
        protocolAdhered: false,
        scenarioFamily: task.scenarioFamily,
        taskId: task.taskId,
        taskKind: task.taskKind,
        taskPassed: false,
        usefulMemoryUse: false,
        validCallGold: false,
      })),
    ),
  );
}

function summarize(cells: readonly CodeMemoryLinkAgentStudyCellV1[]) {
  return summarizeCodeMemoryLinkAgentStudyV1({
    assignmentHash: 'assignment',
    candidate: {buildIdentityHash: 'build', commit: 'commit'},
    cells,
    hiddenBlocks: CLIENTS.flatMap(clientId => HIDDEN_TASKS.map(task => ({clientId, ...task}))),
    manifestHash: 'manifest',
    negativeBlocks: CLIENTS.flatMap(clientId => CONTROL_TASKS.map(task => ({clientId, taskId: task.taskId}))),
    scheduledCells: 168,
  });
}
