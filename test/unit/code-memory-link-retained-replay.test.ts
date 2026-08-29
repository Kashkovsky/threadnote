import {describe, expect, it} from 'vitest';
import {assertRetainedBundleBindings} from '../../scripts/verify-code-memory-link-release.js';
import {
  assembleCodeMemoryLinkSealedSuiteV1,
  codeMemoryLinkAgentPreparedMemoryDirectory,
  type CodeMemoryLinkPreparedTaskV1,
} from '../../scripts/prepare-code-memory-link-agent-ab.js';
import {
  parseCodeMemoryLinkCodexJudgeCommandV1,
  parseCodeMemoryLinkCodexSuiteLayoutV1,
} from '../../scripts/code-memory-link-codex-suite.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {createCodeMemoryLinkAgentSuiteCorpusV1} from '../../src/evaluation/code-memory-link-agent-suite.js';
import {
  CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1,
  canonicalizeCodeMemoryLinkContextBriefResultV1,
} from '../../src/evaluation/code-memory-link-agent-protocol.js';
import {
  codeMemoryLinkClientImplementationDescriptorHash,
  codeMemoryLinkClientProjectionHash,
  parseCodeMemoryLinkClientImplementationDescriptorV1,
} from '../../src/evaluation/code-memory-link-client-descriptor.js';
import {createCodeMemoryLinkRetainedResultV1} from '../../src/evaluation/code-memory-link-retained-result.js';

describe('Code Memory Link retained release replay', () => {
  it('replays sealed layout, client identity, judge, and per-arm response bindings', () => {
    const fixture = replayFixture();
    expect(() => assertRetainedBundleBindings(fixture.input)).not.toThrow();

    const responseTamper = replayFixture();
    responseTamper.evidence[0]!.rawEvidence.appServer.checkpoints[0]!.proxyReceipt.responseHash = 'f'.repeat(64);
    expect(() => assertRetainedBundleBindings(responseTamper.input)).toThrow(/response.*preregistration/u);

    const projectionTamper = replayFixture();
    projectionTamper.evidence[0]!.rawEvidence.clientProtocol.configurationProjectionHash = 'e'.repeat(64);
    expect(() => assertRetainedBundleBindings(projectionTamper.input)).toThrow(/client protocol/u);

    const judgeTamper = replayFixture();
    judgeTamper.evidence[0]!.rawEvidence.judge.programSha256 = 'd'.repeat(64);
    expect(() => assertRetainedBundleBindings(judgeTamper.input)).toThrow(/judge execution/u);
  });
});

function replayFixture() {
  const corpus = createCodeMemoryLinkAgentSuiteCorpusV1();
  const definition = corpus.releaseTasks[0]!;
  const sealed = assembleCodeMemoryLinkSealedSuiteV1({
    corpusHash: corpus.corpusHash,
    judgeProgram: 'export const judge = true;\n',
    tasks: corpus.releaseTasks.map(preparedTask),
  });
  const layout = parseCodeMemoryLinkCodexSuiteLayoutV1(sealed.adapter);
  const commandMapping = layout.judge.files.find(file => file.artifactId === layout.judge.commandArtifactId)!;
  const command = parseCodeMemoryLinkCodexJudgeCommandV1(JSON.parse(sealed.files.get(commandMapping.source)!));
  const commandDescriptor = sealed.suite.judge.artifacts.find(
    artifact => artifact.artifactId === layout.judge.commandArtifactId,
  )!;
  const programDescriptor = sealed.suite.judge.artifacts.find(
    artifact => artifact.artifactId === command.programArtifactId,
  )!;
  const clientFixtures = ['gpt-5.6-luna', 'gpt-5.6-terra'].map((model, index) => clientFixture(model, index));
  const manifest = {
    adjudicationArtifactHash: sealed.suite.judge.judgeHash,
    clients: clientFixtures.map(client => client.manifest),
    suiteHash: sealed.suite.suiteHash,
    tasks: sealed.manifestTasks,
  };
  const responseHash = sealed.manifestTasks[0]!.expectedResponseHashes.anchored;
  const evidence = clientFixtures.map(client => ({
    rawEvidence: {
      appServer: {
        checkpoints: [
          {
            itemType: 'mcpToolCall',
            method: 'item/completed',
            proxyReceipt: {responseHash},
            succeeded: true,
          },
        ],
      },
      bindings: {arm: 'anchored', clientId: client.manifest.clientId, taskId: definition.taskId},
      clientProtocol: {
        configurationProjectionHash: client.manifest.configurationProjectionHash,
        environmentPolicyHash: client.manifest.environmentPolicyHash,
        executionBundleHash: client.manifest.executionBundleHash,
        expectedClient: client.manifest.expectedClient,
        expectedClientProjectionHash: client.descriptor.expectedClientProjectionHash,
        proxyTool: client.proxyTool,
      },
      judge: {
        commandArtifactId: commandDescriptor.artifactId,
        commandSha256: commandDescriptor.sha256,
        programArtifactId: programDescriptor.artifactId,
        programSha256: programDescriptor.sha256,
      },
    },
  }));
  const candidate = {buildIdentityHash: '1'.repeat(64), commit: '2'.repeat(40), dirty: false};
  const agentAb = {
    assignmentHash: '3'.repeat(64),
    candidate,
    evidence: {
      distinctClients: 2,
      eligibleExternalTrials: 2,
      excludedMockTrials: 0,
      externalEvidenceHash: '4'.repeat(64),
      hiddenTasks: 1,
      manifestApprovalCommit: '5'.repeat(40),
      negativeControlTasks: 0,
      pairedBlocks: 1,
      retainedEvidenceReceipts: 2,
    },
    fixtureHash: sealed.fixture.fixtureHash,
    gate: {qualityFailures: []},
    manifestHash: '6'.repeat(64),
    metrics: {},
    suiteHash: sealed.suite.suiteHash,
    version: 1,
  };
  const dogfood = {
    artifactHash: '7'.repeat(64),
    candidate,
    gate: {qualityFailures: []},
    harnessCommit: '5'.repeat(40),
    observations: [],
    version: 1,
  };
  const retained = {
    artifacts: {
      assignment: '{}\n',
      attempts: '{}\n',
      dogfood: '{}\n',
      evidence: '{}\n',
      manifest: '{}\n',
      result: `${JSON.stringify(
        createCodeMemoryLinkRetainedResultV1({agentAb: agentAb as never, dogfood: dogfood as never}),
        undefined,
        2,
      )}\n`,
      sealedLayout: sealed.files.get('adapter.json')!,
      sealedSuite: sealed.files.get('suite.json')!,
      trials: '{}\n',
    },
    clients: clientFixtures.map(client => ({
      clientId: client.manifest.clientId,
      configProjection: client.configProjection,
      descriptor: `${JSON.stringify(client.descriptor)}\n`,
    })),
    sealedFiles: [...sealed.files]
      .filter(([path]) => path !== 'adapter.json' && path !== 'suite.json')
      .map(([path, content]) => ({content, path})),
  };
  const input = {
    agentAb: agentAb as never,
    dogfood: dogfood as never,
    evidence: evidence as never,
    manifest: manifest as never,
    retained: retained as never,
  };
  return {evidence, input};
}

function clientFixture(model: string, index: number) {
  const clientId = `cli_${String(index + 1).repeat(16)}`;
  const expectedClient = {
    appServerVersion: '0.144.5' as const,
    model,
    modelProvider: 'openai',
    reasoningEffort: 'medium',
  };
  const proxyTool = {server: 'context_brief_gate', tool: 'context_brief'};
  const configProjection = `${JSON.stringify({model, version: 1})}\n`;
  const configurationProjectionHash = sha256HexSync(configProjection);
  const environmentPolicyHash = String(index + 3).repeat(64);
  const executionBundleHash = String(index + 5).repeat(64);
  const descriptor = parseCodeMemoryLinkClientImplementationDescriptorV1({
    argumentVectorHash: String(index + 7).repeat(64),
    artifactBindings: [
      {pathDigest: '1'.repeat(63) + index, role: 'client-bundle', sha256: executionBundleHash},
      {pathDigest: '2'.repeat(63) + index, role: 'client-entrypoint', sha256: String(index + 6).repeat(64)},
      {pathDigest: '3'.repeat(63) + index, role: 'proxy-bundle', sha256: String(index + 7).repeat(64)},
    ],
    binaryBindings: [
      {pathDigest: '4'.repeat(63) + index, role: 'client-runtime', sha256: '8'.repeat(64)},
      {pathDigest: '5'.repeat(63) + index, role: 'codex-app-server', sha256: '9'.repeat(64)},
      {pathDigest: '6'.repeat(63) + index, role: 'git', sha256: 'a'.repeat(64)},
    ],
    configurationHash: 'b'.repeat(64),
    configurationProjectionHash,
    dependenciesLockHash: 'c'.repeat(64),
    entrypointHash: String(index + 6).repeat(64),
    environmentPolicyHash,
    executionBundleHash,
    expectedClientProjectionHash: codeMemoryLinkClientProjectionHash('expected-client', {
      ...expectedClient,
      proxyTool,
    }),
    version: 2,
  });
  return {
    configProjection,
    descriptor,
    manifest: {
      clientId,
      configurationProjectionHash,
      environmentPolicyHash,
      executionBundleHash,
      expectedClient,
      implementationDescriptorHash: codeMemoryLinkClientImplementationDescriptorHash(descriptor),
    },
    proxyTool,
  };
}

function preparedTask(
  definition: ReturnType<typeof createCodeMemoryLinkAgentSuiteCorpusV1>['releaseTasks'][number],
): CodeMemoryLinkPreparedTaskV1 {
  const citationDigests = [
    ...new Set(
      definition.memorySeeds
        .filter(seed => seed.citationPath !== null)
        .map(seed => sha256HexSync(`${definition.taskId}:citation:${seed.citationPath}`)),
    ),
  ].sort();
  const response = (version: 2 | 3) =>
    canonicalizeCodeMemoryLinkContextBriefResultV1({
      activeHandoffs: [],
      durableDecisions: [],
      type: 'context-brief',
      version,
    }).receipt;
  return {
    citationDigests,
    definition,
    homeFiles: definition.memorySeeds.map((seed, index) => ({
      content:
        definition.controlScenario === 'malformed-citation'
          ? `task=${definition.taskId}_${index}\ncode_citation: {not-canonical-json\n`
          : `task=${definition.taskId}_${index}\n`,
      destination: `${codeMemoryLinkAgentPreparedMemoryDirectory(seed.status)}/${definition.taskId}-${index}.md`,
    })),
    preflightExpectedCitationDigests:
      definition.taskKind === 'hidden-constraint' ||
      definition.controlScenario === 'ambiguous' ||
      definition.controlScenario === 'instruction-injection-direct'
        ? citationDigests
        : [],
    preflightExpectedResponses: {
      anchored: response(3),
      noMemory: canonicalizeCodeMemoryLinkContextBriefResultV1(
        CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1.structuredContent,
      ).receipt,
      taskOnly: response(2),
    },
    preflightExpectedSelectedMemories: [],
  };
}
