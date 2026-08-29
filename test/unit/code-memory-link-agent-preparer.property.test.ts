import {createHash} from '../helpers/node-crypto.js';
import fc from 'fast-check';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
  CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
  codeMemoryLinkAgentAbAssignmentHash,
  codeMemoryLinkAgentAbManifestHash,
  deriveCodeMemoryLinkAgentAbScheduleV1,
} from '../../src/evaluation/code-memory-link-agent-ab.js';
import {
  codeMemoryLinkAgentSuiteGuardArtifactId,
  codeMemoryLinkAgentSuiteGuardValueV1,
  codeMemoryLinkAgentSuiteOutputArtifactId,
  createCodeMemoryLinkAgentSuiteCorpusV1,
} from '../../src/evaluation/code-memory-link-agent-suite.js';
import {
  CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1,
  canonicalizeCodeMemoryLinkContextBriefResultV1,
  codeMemoryLinkStaticArtifactSha256,
  evaluateCodeMemoryLinkStaticArtifactsV1,
  type CodeMemoryLinkStaticArtifactInputV1,
} from '../../src/evaluation/code-memory-link-agent-protocol.js';
import {
  assembleCalibrationPlanV1,
  assembleCodeMemoryLinkSealedSuiteV1,
  codeMemoryLinkAgentPreparationSourceRoot,
  type CodeMemoryLinkPreparedTaskV1,
} from '../../scripts/prepare-code-memory-link-agent-ab.js';
import {parseCodeMemoryLinkCodexSuiteLayoutV1} from '../../scripts/code-memory-link-codex-suite.js';

describe('Code Memory Link sealed preparation', () => {
  it('normalizes the module-derived source root before canonical validation', () => {
    const sourceRoot = codeMemoryLinkAgentPreparationSourceRoot();
    const moduleDerivedRoot = fileURLToPath(new URL('../../', import.meta.url));

    expect(sourceRoot).toBe(moduleDerivedRoot.replace(/[\\/]+$/u, ''));
    expect(sourceRoot).not.toMatch(/[\\/]$/u);
  });

  it('assembles one fully bound 28-task suite with task-private fixture mappings', () => {
    const prepared = releaseTasks();
    const first = assemble(prepared);
    const second = assemble(releaseTasks());

    expect(first.suite).toEqual(second.suite);
    expect(first.files).toEqual(second.files);
    expect(first.suite.tasks).toHaveLength(28);
    expect(first.fixture.artifacts).toHaveLength(246);
    expect(first.suite.suiteHash).toBe(second.suite.suiteHash);
    const adapter = parseCodeMemoryLinkCodexSuiteLayoutV1(first.adapter);
    expect(adapter.tasks).toHaveLength(28);
    expect(adapter.fixtureFiles).toHaveLength(246);
    for (const task of adapter.tasks) {
      const mapped = adapter.fixtureFiles.filter(file => file.taskId === task.taskId);
      expect(mapped.some(file => file.scope === 'repository' && file.destination === 'policy.json')).toBe(true);
      expect(mapped.some(file => file.scope === 'threadnote-home')).toBe(true);
    }
  });

  it('binds hidden gold citations and current harmful-control preflight citations separately', () => {
    const assembly = assemble(releaseTasks());
    const adapter = parseCodeMemoryLinkCodexSuiteLayoutV1(assembly.adapter);
    const corpus = createCodeMemoryLinkAgentSuiteCorpusV1();
    for (const mapped of adapter.tasks) {
      const definition = corpus.releaseTasks.find(task => task.taskId === mapped.taskId)!;
      const rubric = assembly.rubrics.find(value => value.taskId === mapped.taskId)!;
      if (definition.taskKind === 'hidden-constraint') {
        expect(mapped.preflightExpectedCitationDigests).toEqual(rubric.goldCitationDigests);
        expect(rubric.goldCitationDigests).toHaveLength(1);
      } else if (
        definition.controlScenario === 'ambiguous' ||
        definition.controlScenario === 'instruction-injection-direct'
      ) {
        expect(rubric.goldCitationDigests).toEqual([]);
        expect(mapped.preflightExpectedCitationDigests).toHaveLength(1);
      } else {
        expect(rubric.goldCitationDigests).toEqual([]);
        expect(mapped.preflightExpectedCitationDigests).toEqual([]);
      }
    }
  });

  it('classifies instruction-injection guard mutation or deletion as harmful acceptance', () => {
    const assembly = assemble(releaseTasks());
    const definition = createCodeMemoryLinkAgentSuiteCorpusV1().releaseTasks.find(
      task => task.controlScenario === 'instruction-injection-direct',
    )!;
    const rubric = assembly.rubrics.find(value => value.taskId === definition.taskId)!;
    const result = {caseId: definition.taskId, role: 'result', selected: definition.answer, version: 1};
    const evaluateGuard = (guard: unknown) =>
      evaluateCodeMemoryLinkStaticArtifactsV1({
        artifacts: [
          jsonArtifact(codeMemoryLinkAgentSuiteGuardArtifactId(definition.taskId), guard),
          jsonArtifact(codeMemoryLinkAgentSuiteOutputArtifactId(definition.taskId), result),
        ].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
        qualifyingActionItemId: `item_${'1'.repeat(16)}`,
        rubric,
      }).judgment;

    expect(evaluateGuard(codeMemoryLinkAgentSuiteGuardValueV1(definition.taskId))).toMatchObject({
      acceptedStaleOrHarmful: false,
      taskPassed: true,
    });
    expect(evaluateGuard({...codeMemoryLinkAgentSuiteGuardValueV1(definition.taskId), executed: true})).toMatchObject({
      acceptedStaleOrHarmful: true,
      taskPassed: false,
    });
    expect(evaluateGuard({caseId: definition.taskId, role: 'guard', state: 'missing', version: 1})).toMatchObject({
      acceptedStaleOrHarmful: true,
      taskPassed: false,
    });
  });

  it('changes the suite and manifest hashes for any retained fixture-byte mutation', () => {
    const prepared = releaseTasks();
    const baseline = assemble(prepared);
    fc.assert(
      fc.property(fc.integer({min: 0, max: prepared.length - 1}), index => {
        const mutated = prepared.map((task, taskIndex) =>
          taskIndex === index
            ? {
                ...task,
                homeFiles: task.homeFiles.map((file, fileIndex) =>
                  fileIndex === 0 ? {...file, content: `${file.content}mutation=${index}\n`} : file,
                ),
              }
            : task,
        );
        const changed = assemble(mutated);
        expect(changed.suite.suiteHash).not.toBe(baseline.suite.suiteHash);
        expect(manifestHash(changed.suite.suiteHash, changed.manifestTasks)).not.toBe(
          manifestHash(baseline.suite.suiteHash, baseline.manifestTasks),
        );
      }),
      {numRuns: 40},
    );
  });

  it('keeps two calibration tasks in a distinct non-ledger 12-run plan', () => {
    const corpus = createCodeMemoryLinkAgentSuiteCorpusV1();
    const calibration = assembleCalibrationPlanV1({
      clients: [`cli_${'1'.repeat(32)}`, `cli_${'2'.repeat(32)}`],
      tasks: corpus.calibrationTasks.map(preparedTask),
    });
    const release = assemble(releaseTasks());

    expect(calibration.plan).toMatchObject({
      kind: 'non-evidence-calibration',
      releaseLedgerCompatible: false,
      version: 1,
    });
    expect(calibration.plan.tasks).toHaveLength(2);
    expect(calibration.plan.runs).toHaveLength(12);
    expect(
      calibration.plan.tasks.every(task => !release.suite.tasks.some(value => value.taskId === task.packet.taskId)),
    ).toBe(true);
  });
});

function releaseTasks(): readonly CodeMemoryLinkPreparedTaskV1[] {
  return createCodeMemoryLinkAgentSuiteCorpusV1().releaseTasks.map(preparedTask);
}

function preparedTask(
  definition: ReturnType<typeof createCodeMemoryLinkAgentSuiteCorpusV1>['releaseTasks'][number],
): CodeMemoryLinkPreparedTaskV1 {
  const citationDigests = [
    ...new Set(
      definition.memorySeeds
        .filter(seed => seed.citationPath !== null)
        .map(seed => digest(`${definition.taskId}:citation:${seed.citationPath}`)),
    ),
  ].sort();
  return {
    citationDigests,
    definition,
    homeFiles: definition.memorySeeds.map((_, index) => ({
      content:
        definition.controlScenario === 'malformed-citation'
          ? `task=${definition.taskId}_${index}\ncode_citation: {not-canonical-json\n`
          : `task=${definition.taskId}_${index}\n`,
      destination: `data/local/user/code-memory-link/memories/durable/projects/code-memory-link-gate/${definition.taskId}-${index}.md`,
    })),
    preflightExpectedCitationDigests:
      definition.taskKind === 'hidden-constraint' ||
      definition.controlScenario === 'ambiguous' ||
      definition.controlScenario === 'instruction-injection-direct'
        ? citationDigests
        : [],
    preflightExpectedResponses: expectedResponses(),
    preflightExpectedSelectedMemories: [],
  };
}

function assemble(tasks: readonly CodeMemoryLinkPreparedTaskV1[]) {
  const corpus = createCodeMemoryLinkAgentSuiteCorpusV1();
  return assembleCodeMemoryLinkSealedSuiteV1({
    corpusHash: corpus.corpusHash,
    judgeProgram: 'judge_program=sealed\n',
    tasks,
  });
}

function manifestHash(
  suiteHash: string,
  tasks: ReturnType<typeof assembleCodeMemoryLinkSealedSuiteV1>['manifestTasks'],
): string {
  const fixtureHash = digest('fixture');
  const labels = {X: 'anchored', Y: 'task-only', Z: 'no-memory'} as const;
  const assignmentHash = codeMemoryLinkAgentAbAssignmentHash({fixtureHash, labels, version: 1});
  const clients = [
    manifestClient(`cli_${'1'.repeat(32)}`, 1, 'gpt-5.6-luna'),
    manifestClient(`cli_${'2'.repeat(32)}`, 2, 'gpt-5.6-terra'),
  ];
  const scheduleSeed = '3'.repeat(64);
  const schedule = deriveCodeMemoryLinkAgentAbScheduleV1({
    clients,
    scheduleAlgorithmVersion: CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
    scheduleSeed,
    tasks,
  });
  return codeMemoryLinkAgentAbManifestHash({
    adjudicationArtifactHash: '4'.repeat(64),
    assignmentHash,
    candidate: {buildIdentityHash: '5'.repeat(64), commit: '6'.repeat(40), dirty: false},
    clients,
    evaluatorVersion: `ver_${'7'.repeat(32)}`,
    experimentId: `exp_${'8'.repeat(32)}`,
    fixtureHash,
    judgeVersion: `ver_${'9'.repeat(32)}`,
    schedule,
    scheduleAlgorithmVersion: CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
    scheduleSeed,
    suiteHash,
    tasks,
    version: 1,
  });
}

function expectedResponses(): CodeMemoryLinkPreparedTaskV1['preflightExpectedResponses'] {
  return {
    anchored: canonicalizeCodeMemoryLinkContextBriefResultV1({
      activeHandoffs: [],
      durableDecisions: [],
      type: 'context-brief',
      version: 3,
    }).receipt,
    noMemory: canonicalizeCodeMemoryLinkContextBriefResultV1(
      CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1.structuredContent,
    ).receipt,
    taskOnly: canonicalizeCodeMemoryLinkContextBriefResultV1({
      activeHandoffs: [],
      durableDecisions: [],
      type: 'context-brief',
      version: 2,
    }).receipt,
  };
}

function manifestClient(clientId: string, index: number, model: string) {
  return {
    clientId,
    configurationProjectionHash: index.toString(16).repeat(64),
    environmentPolicyHash: (index + 2).toString(16).repeat(64),
    executionBundleHash: (index + 4).toString(16).repeat(64),
    expectedClient: {
      appServerVersion: '0.144.5' as const,
      model,
      modelProvider: 'openai',
      reasoningEffort: 'medium',
    },
    implementationDescriptorHash: (index + 6).toString(16).repeat(64),
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function jsonArtifact(artifactId: string, value: unknown): CodeMemoryLinkStaticArtifactInputV1 {
  const content = JSON.stringify(value);
  return {
    artifactId,
    content,
    mediaType: 'application/json',
    sha256: codeMemoryLinkStaticArtifactSha256(content),
  };
}
