import {createHash} from '../helpers/node-crypto.js';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {dirname, join} from '../helpers/node-path.js';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {createCodeMemoryLinkAgentSuiteCorpusV1} from '../../src/evaluation/code-memory-link-agent-suite.js';
import {
  CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1,
  canonicalizeCodeMemoryLinkContextBriefResultV1,
  parseCodeMemoryLinkSealedSuiteV1,
} from '../../src/evaluation/code-memory-link-agent-protocol.js';
import {
  codeMemoryLinkClientArgumentVectorHash,
  codeMemoryLinkClientImplementationDescriptorHash,
  codeMemoryLinkClientPathDigest,
} from '../../src/evaluation/code-memory-link-client-descriptor.js';
import {
  assembleCalibrationPlanV1,
  type CodeMemoryLinkPreparedClientV1,
  type CodeMemoryLinkPreparedTaskV1,
} from '../../scripts/prepare-code-memory-link-agent-ab.js';
import {
  assertCodeMemoryLinkCalibrationPrefixV1,
  calibrationResultDigest,
  codeMemoryLinkReleaseLedgerPathsV1,
  createCalibrationResult,
  materializeCodeMemoryLinkCalibrationSandboxV1,
  parseCalibrationPlan,
  parseCodeMemoryLinkCalibrationResultsJsonl,
  releaseInvocationArguments,
  resolveCodeMemoryLinkAgentTrialRunner,
} from '../../scripts/run-code-memory-link-agent-matrix.js';

describe('Code Memory Link sequential matrix', () => {
  it('accepts only the canonical complete calibration schedule regardless of the chosen swapped positions', () => {
    const plan = calibrationPlan();
    expect(parseCalibrationPlan(plan)).toEqual(plan);

    fc.assert(
      fc.property(
        fc.integer({min: 0, max: plan.runs.length - 1}),
        fc.integer({min: 0, max: plan.runs.length - 2}),
        (left, compressedRight) => {
          const right = compressedRight >= left ? compressedRight + 1 : compressedRight;
          const runs = [...plan.runs];
          [runs[left], runs[right]] = [runs[right]!, runs[left]!];
          expect(() => parseCalibrationPlan({...plan, runs})).toThrow('canonical non-outcome-dependent order');
        },
      ),
      {numRuns: 60},
    );
  });

  it('chains only the exact frozen calibration prefix and cannot parse as a release suite', () => {
    const plan = parseCalibrationPlan(calibrationPlan());
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[0-9a-f]{64}$/u), {minLength: 0, maxLength: 12}), diagnostics => {
        const bounded = diagnostics.slice(0, plan.runs.length);
        const results = bounded.reduce<ReturnType<typeof createCalibrationResult>[]>(
          (prior, diagnosticsHash, index) => {
            const previousResultDigest = index === 0 ? null : calibrationResultDigest(prior[index - 1]!);
            const run = plan.runs[index]!;
            prior.push(
              createCalibrationResult(
                plan,
                run,
                {
                  arm: run.arm,
                  clientId: run.clientId,
                  diagnosticsHash,
                  kind: 'non-evidence-calibration',
                  planHash: plan.planHash,
                  runOrder: run.runOrder,
                  taskId: run.taskId,
                  version: 1,
                },
                previousResultDigest,
              ),
            );
            return prior;
          },
          [],
        );
        const parsed = parseCodeMemoryLinkCalibrationResultsJsonl(
          results.length === 0 ? '' : `${results.map(result => JSON.stringify(result)).join('\n')}\n`,
        );
        expect(parsed).toEqual(results);
        expect(() => assertCodeMemoryLinkCalibrationPrefixV1(plan, parsed)).not.toThrow();
      }),
      {numRuns: 50},
    );
    expect(() => parseCodeMemoryLinkSealedSuiteV1(plan)).toThrow();
  });

  it('passes the canonical evidence sibling to the exact trial runner exactly once', () => {
    const root = '/tmp/code-memory-link-prepared';
    const trials = '/tmp/code-memory-link-results/trials.jsonl';
    const evidence = `${trials}.evidence.jsonl`;
    const arguments_ = releaseInvocationArguments({
      client: preparedClient(),
      options: {
        approvalCommit: '7'.repeat(40),
        attemptsPath: `${trials}.attempts.jsonl`,
        candidateCommit: '8'.repeat(40),
        evidencePath: evidence,
        mode: 'release',
        pacingMilliseconds: 0,
        root,
        timeoutMilliseconds: 1_000,
        trialsPath: trials,
      },
      root,
      runnerScript: '/src/trial.ts',
    });
    const evidenceIndex = arguments_.indexOf('--evidence');
    expect(evidenceIndex).toBeGreaterThan(0);
    expect(arguments_[evidenceIndex + 1]).toBe(evidence);
    expect(arguments_.filter(argument => argument === '--evidence')).toHaveLength(1);
  });

  it('resolves the matrix trial runner through the same canonical file check used by release execution', async () => {
    await expect(resolveCodeMemoryLinkAgentTrialRunner()).resolves.toBe(
      await realpath(join(process.cwd(), 'scripts/run-code-memory-link-agent-trial.ts')),
    );
  });

  it('derives the pending commit beside canonical outside-root release ledgers', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9-]{0,24}$/u), name => {
        const trialsPath = `/private/results/${name}.jsonl`;
        expect(
          codeMemoryLinkReleaseLedgerPathsV1({
            attemptsPath: `${trialsPath}.attempts.jsonl`,
            evidencePath: `${trialsPath}.evidence.jsonl`,
            preparedRoot: '/private/prepared',
            trialsPath,
          }),
        ).toEqual({
          attemptsPath: `${trialsPath}.attempts.jsonl`,
          evidencePath: `${trialsPath}.evidence.jsonl`,
          pendingPath: `${trialsPath}.pending.json`,
          trialsPath,
        });
      }),
      {numRuns: 60},
    );
    expect(() =>
      codeMemoryLinkReleaseLedgerPathsV1({
        attemptsPath: '/private/prepared/trials.jsonl.attempts.jsonl',
        evidencePath: '/private/prepared/trials.jsonl.evidence.jsonl',
        preparedRoot: '/private/prepared',
        trialsPath: '/private/prepared/trials.jsonl',
      }),
    ).toThrow('outside');
  });

  it('materializes calibration into a workspace with no release suite or rubric bytes', async () => {
    const corpus = createCodeMemoryLinkAgentSuiteCorpusV1();
    const assembly = assembleCalibrationPlanV1({
      clients: [`cli_${'1'.repeat(32)}`, `cli_${'2'.repeat(32)}`],
      tasks: corpus.calibrationTasks.map(preparedTask),
    });
    const preparedRoot = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-calibration-prepared-')));
    let sandbox: string | null = null;
    try {
      for (const [relativePath, content] of assembly.files) {
        const destination = join(preparedRoot, relativePath);
        await mkdir(dirname(destination), {recursive: true});
        await writeFile(destination, content);
      }
      await writeFile(join(preparedRoot, 'calibration/plan.json'), `${JSON.stringify(assembly.plan, null, 2)}\n`);
      await writeFile(join(preparedRoot, 'suite.json'), 'release-private-rubric-sentinel\n');

      sandbox = await materializeCodeMemoryLinkCalibrationSandboxV1(preparedRoot, assembly.plan);
      await expect(readFile(join(sandbox, 'suite.json'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
      expect(await readFile(join(sandbox, 'calibration/plan.json'), 'utf8')).not.toContain(
        'release-private-rubric-sentinel',
      );
      const firstFixture = assembly.plan.fixtureFiles[0]!;
      expect(await readFile(join(sandbox, firstFixture.source), 'utf8')).toBe(
        await readFile(join(preparedRoot, firstFixture.source), 'utf8'),
      );
    } finally {
      await Promise.all([
        rm(preparedRoot, {force: true, recursive: true}),
        ...(sandbox === null ? [] : [rm(sandbox, {force: true, recursive: true})]),
      ]);
    }
  });
});

function calibrationPlan() {
  const corpus = createCodeMemoryLinkAgentSuiteCorpusV1();
  return assembleCalibrationPlanV1({
    clients: [`cli_${'1'.repeat(32)}`, `cli_${'2'.repeat(32)}`],
    tasks: corpus.calibrationTasks.map(preparedTask),
  }).plan;
}

function preparedTask(
  definition: ReturnType<typeof createCodeMemoryLinkAgentSuiteCorpusV1>['calibrationTasks'][number],
): CodeMemoryLinkPreparedTaskV1 {
  const citationDigests = definition.memorySeeds
    .filter(seed => seed.citationPath !== null)
    .map((_, index) => digest(`${definition.taskId}:citation:${index}`))
    .sort();
  return {
    citationDigests,
    definition,
    homeFiles: definition.memorySeeds.map((_, index) => ({
      content: `task=${definition.taskId}_${index}\n`,
      destination: `data/local/user/code-memory-link/memories/durable/projects/code-memory-link-gate/${definition.taskId}-${index}.md`,
    })),
    preflightExpectedCitationDigests: citationDigests,
    preflightExpectedResponses: expectedResponses(),
    preflightExpectedSelectedMemories: [],
  };
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

function preparedClient(): CodeMemoryLinkPreparedClientV1 {
  const clientArguments = ['/reviewed/client.bundle.js'];
  const clientArtifactBindings = [
    {path: '/reviewed/client.bundle.js', role: 'client-bundle'},
    {path: '/reviewed/client.ts', role: 'client-entrypoint'},
    {path: '/reviewed/proxy.bundle.js', role: 'proxy-bundle'},
  ];
  const clientBinaryBindings = [
    {path: '/bin/bun', role: 'client-runtime'},
    {path: '/bin/codex', role: 'codex-app-server'},
    {path: '/bin/git', role: 'git'},
  ];
  const artifactBindings = clientArtifactBindings.map((binding, index) => ({
    pathDigest: codeMemoryLinkClientPathDigest(binding.path),
    role: binding.role,
    sha256: (index + 1).toString(16).repeat(64),
  }));
  const binaryBindings = clientBinaryBindings.map((binding, index) => ({
    pathDigest: codeMemoryLinkClientPathDigest(binding.path),
    role: binding.role,
    sha256: (index + 4).toString(16).repeat(64),
  }));
  const descriptor = {
    argumentVectorHash: codeMemoryLinkClientArgumentVectorHash(clientArguments),
    artifactBindings,
    binaryBindings,
    configurationHash: '7'.repeat(64),
    configurationProjectionHash: '8'.repeat(64),
    dependenciesLockHash: '9'.repeat(64),
    entrypointHash: artifactBindings[1]!.sha256,
    environmentPolicyHash: 'a'.repeat(64),
    executionBundleHash: artifactBindings[0]!.sha256,
    expectedClientProjectionHash: 'b'.repeat(64),
    version: 2 as const,
  };
  return {
    clientArguments,
    clientArtifactBindings,
    clientBinaryBindings,
    clientCommand: '/bin/bun',
    clientConfigurationProjectionPath: '/tmp/client.config-projection.json',
    clientConfigurationPath: '/tmp/client.config.json',
    clientDependenciesLockPath: '/tmp/client.lock',
    clientDescriptorPath: '/tmp/client.descriptor.json',
    clientId: `cli_${'1'.repeat(32)}`,
    descriptor,
    implementationDescriptorHash: codeMemoryLinkClientImplementationDescriptorHash(descriptor),
    model: 'gpt-5.6-luna',
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
