import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {delimiter, dirname, join} from '@threadnote/testing/node-path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {
  assertMatchedEvaluationMcpInventoryV1,
  extractMatchedEvaluationProviderUsageV1,
  matchedEvaluationCodexEnvironmentPolicyHashV1,
  matchedEvaluationPreparedHomeFixtureHashV1,
  matchedEvaluationVerifierEnvironmentHashV1,
  parseMatchedEvaluationCodexAdapterConfigV1,
  renderMatchedEvaluationCommandReviewRulesV1,
  runMatchedEvaluationCodexAdapter,
  runMatchedEvaluationDeterministicVerifierV1,
} from '../../../../scripts/matched-evaluation-codex-adapter.js';
import {
  createMatchedEvaluationVerificationCalibrationV1,
  createMatchedEvaluationVerificationPlanV1,
  matchedEvaluationVerificationIdV1,
} from '@threadnote/threadnote/evaluation/matched-verification';
import {captureCodeMemoryLinkProcessGroup} from '../../../../scripts/code-memory-link-process-boundary.js';
import {observeMatchedEvaluationRepositoryV1} from '../../../../scripts/matched-evaluation-runtime-integrity.js';

describe('matched evaluation Codex adapter', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {force: true, recursive: true})));
  });

  it('parses a pinned files-only adapter configuration and rejects treatment context in that arm', () => {
    const config = adapterConfig();

    expect(parseMatchedEvaluationCodexAdapterConfigV1(config)).toEqual(config);
    expect(() =>
      parseMatchedEvaluationCodexAdapterConfigV1({
        ...config,
        contextHomes: [
          {
            expectedContext: {
              graphContentHash: '8'.repeat(64),
              graphSnapshotHash: '9'.repeat(64),
              linkReceiptsHash: null,
              memoryAccess: 'disabled',
              taskContextHash: null,
            },
            homeDirectory: '/tmp/prepared-threadnote-home',
            homeFixtureHash: 'b'.repeat(64),
            identity: {account: 'local', user: 'evaluation-user'},
            project: 'threadnote',
            taskId: 'tsk_0123456789abcdef',
          },
        ],
      }),
    ).toThrow('only Threadnote arms may configure prepared context homes');
  });

  it('keeps the study hash out of immutable prepared-home configuration', () => {
    const expectedContext = {
      graphContentHash: '8'.repeat(64),
      graphSnapshotHash: '9'.repeat(64),
      linkReceiptsHash: 'a'.repeat(64),
      memoryAccess: 'linked' as const,
      taskContextHash: 'b'.repeat(64),
    };
    const config = {
      ...adapterConfig(),
      arm: 'threadnote-compact' as const,
      contextHomes: [
        {
          expectedContext,
          homeDirectory: '/tmp/prepared-threadnote-home',
          homeFixtureHash: 'c'.repeat(64),
          identity: {account: 'local', user: 'evaluation-user'},
          project: 'threadnote',
          taskId: 'tsk_0123456789abcdef',
        },
      ],
    };

    expect(parseMatchedEvaluationCodexAdapterConfigV1(config)).toEqual(config);
    expect(() =>
      parseMatchedEvaluationCodexAdapterConfigV1({
        ...config,
        contextHomes: [
          {
            ...config.contextHomes[0],
            expectedContext: {...expectedContext, studyHash: 'd'.repeat(64)},
          },
        ],
      }),
    ).toThrow('unsupported or missing fields');
  });

  it('accepts lossy one-server MCP inventory while rejecting rerouted or expanded metadata', () => {
    const inventory = (server: Record<string, unknown>) => ({data: [server], nextCursor: null});
    const base = {name: 'matched_evaluation_context', resourceTemplates: [], resources: []};

    for (const server of [{...base}, {...base, tools: {}}]) {
      expect(() => assertMatchedEvaluationMcpInventoryV1(inventory(server), base.name)).not.toThrow();
    }
    expect(() =>
      assertMatchedEvaluationMcpInventoryV1(
        inventory({...base, tools: {context_brief: {name: 'context_brief'}}}),
        base.name,
      ),
    ).not.toThrow();
    expect(() =>
      assertMatchedEvaluationMcpInventoryV1(
        inventory({...base, tools: {recall_context: {name: 'recall_context'}}}),
        base.name,
      ),
    ).toThrow('must expose only context_brief');
    expect(() =>
      assertMatchedEvaluationMcpInventoryV1(
        inventory({...base, tools: {context_brief: {name: 'recall_context'}}}),
        base.name,
      ),
    ).toThrow('rerouted tool name');
    expect(() =>
      assertMatchedEvaluationMcpInventoryV1(
        inventory({...base, resources: [{uri: 'threadnote://unexpected'}]}),
        base.name,
      ),
    ).toThrow('unexpected resources');
  });

  it('forces every admitted shell executable through pre-execution review', () => {
    const rules = renderMatchedEvaluationCommandReviewRulesV1();
    const lines = rules.trim().split('\n');

    expect(lines).toHaveLength(13);
    expect(new Set(lines).size).toBe(lines.length);
    for (const executable of [
      '/bin/zsh',
      'cat',
      'file',
      'head',
      'ls',
      'nl',
      'od',
      'pwd',
      'rg',
      'sed',
      'stat',
      'tail',
      'wc',
    ]) {
      expect(lines).toContain(`prefix_rule(pattern=[${JSON.stringify(executable)}], decision="prompt")`);
    }
    expect(rules).not.toContain('decision="allow"');
  });

  it('uses the last cumulative provider report and rejects inconsistent accounting', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 0, max: 1_000_000}),
        fc.integer({min: 0, max: 1_000_000}),
        fc.integer({min: 0, max: 1_000_000}),
        fc.integer({min: 0, max: 1_000_000}),
        (inputTokens, outputTokens, cachedSeed, reasoningSeed) => {
          const cachedInputTokens = Math.min(inputTokens, cachedSeed);
          const reasoningOutputTokens = Math.min(outputTokens, reasoningSeed);
          const expected = {
            cachedInputTokens,
            inputTokens,
            outputTokens,
            reasoningOutputTokens,
            totalTokens: inputTokens + outputTokens,
          };
          expect(
            extractMatchedEvaluationProviderUsageV1([
              usageEvent({
                cachedInputTokens: 0,
                inputTokens: 1,
                outputTokens: 1,
                reasoningOutputTokens: 0,
                totalTokens: 2,
              }),
              usageEvent(expected),
            ]),
          ).toEqual(expected);
        },
      ),
      {numRuns: 50},
    );

    expect(() =>
      extractMatchedEvaluationProviderUsageV1([
        usageEvent({cachedInputTokens: 1, inputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 6}),
      ]),
    ).toThrow('provider token components are inconsistent');
  });

  it('hashes prepared homes deterministically and binds file bytes and modes', async () => {
    const root = await temporaryRoot(roots);
    const first = join(root, 'first');
    const second = join(root, 'second');
    await Promise.all([
      mkdir(join(first, 'nested'), {recursive: true}),
      mkdir(join(second, 'nested'), {recursive: true}),
    ]);
    await writeFile(join(first, 'a.json'), '{}\n', {mode: 0o600});
    await writeFile(join(first, 'nested', 'b.txt'), 'context\n', {mode: 0o640});
    await writeFile(join(second, 'nested', 'b.txt'), 'context\n', {mode: 0o640});
    await writeFile(join(second, 'a.json'), '{}\n', {mode: 0o600});

    const baseline = await matchedEvaluationPreparedHomeFixtureHashV1(first);
    expect(await matchedEvaluationPreparedHomeFixtureHashV1(first)).toBe(baseline);
    expect(await matchedEvaluationPreparedHomeFixtureHashV1(second)).toBe(baseline);

    await writeFile(join(second, 'nested', 'b.txt'), 'changed\n', {mode: 0o640});
    expect(await matchedEvaluationPreparedHomeFixtureHashV1(second)).not.toBe(baseline);
    await writeFile(join(second, 'nested', 'b.txt'), 'context\n', {mode: 0o640});
    await chmod(join(second, 'nested', 'b.txt'), 0o600);
    expect(await matchedEvaluationPreparedHomeFixtureHashV1(second)).not.toBe(baseline);
    await chmod(join(second, 'nested', 'b.txt'), 0o640);
    await mkdir(join(second, 'empty'), {mode: 0o700});
    expect(await matchedEvaluationPreparedHomeFixtureHashV1(second)).not.toBe(baseline);
  });

  it('binds verifier-environment symlinks to their resolved file contents', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot(roots);
    const environment = join(root, 'environment');
    const target = join(root, 'interpreter');
    await mkdir(join(environment, 'bin'), {recursive: true});
    await writeFile(target, '#!/bin/sh\nexit 0\n');
    await chmod(target, 0o700);
    await symlink(target, join(environment, 'bin', 'python'));

    const baseline = await matchedEvaluationVerifierEnvironmentHashV1(environment);
    await writeFile(target, '#!/bin/sh\nexit 1\n');
    expect(await matchedEvaluationVerifierEnvironmentHashV1(environment)).not.toBe(baseline);
  });

  it('separates verifier task failures from invalid sandbox diagnostics', async () => {
    const root = await temporaryRoot(roots);
    const environmentDirectory = join(root, 'verifier-environment');
    const interpreter = join(environmentDirectory, 'bin', 'python');
    const runner = join(root, 'verify');
    const sandbox = join(root, 'sandbox');
    await mkdir(dirname(interpreter), {recursive: true});
    await writeFile(interpreter, '#!/bin/sh\nexec "$@"\n');
    await writeFile(
      runner,
      '#!/bin/sh\ncase "$2" in *pass*) printf "%s verifier passed\\n" "$1"; exit 0 ;; *fail*) printf "%s verifier failed: fixture\\n" "$1" >&2; exit 1 ;; *) printf "sandbox-exec: denied\\n" >&2; exit 1 ;; esac\n',
    );
    await writeFile(sandbox, '#!/bin/sh\nshift 2\nexec "$@"\n');
    await Promise.all([chmod(interpreter, 0o700), chmod(runner, 0o700), chmod(sandbox, 0o700)]);
    const taskId = 'tsk_0123456789abcdef';
    const selector = 'fixture';
    const plan = createMatchedEvaluationVerificationPlanV1({
      environmentDirectory,
      environmentHash: await matchedEvaluationVerifierEnvironmentHashV1(environmentDirectory),
      interpreter,
      interpreterHash: sha256HexSync(await readFile(interpreter)),
      runner,
      runnerHash: sha256HexSync(await readFile(runner)),
      sandbox: {
        executable: sandbox,
        executableHash: sha256HexSync(await readFile(sandbox)),
        policy: 'darwin-seatbelt-v1',
      },
      tasks: [
        {
          calibration: createMatchedEvaluationVerificationCalibrationV1({
            baseDiagnosticHash: '1'.repeat(64),
            baseExitCode: 1,
            baseRepositoryFixtureHash: '2'.repeat(64),
            baseRevision: '3'.repeat(40),
            fixDiagnosticHash: '4'.repeat(64),
            fixExitCode: 0,
            fixRepositoryFixtureHash: '5'.repeat(64),
            fixRevision: '6'.repeat(40),
          }),
          selector,
          taskId,
          verificationId: matchedEvaluationVerificationIdV1(taskId, selector),
        },
      ],
      timeoutMilliseconds: 10_000,
    });
    const passRepository = join(root, 'pass-repository');
    const failRepository = join(root, 'fail-repository');
    const deniedRepository = join(root, 'denied-repository');
    await Promise.all([mkdir(passRepository), mkdir(failRepository), mkdir(deniedRepository)]);

    await expect(
      runMatchedEvaluationDeterministicVerifierV1({
        artifactHash: '7'.repeat(64),
        plan,
        repositoryRoot: passRepository,
        root: join(root, 'pass-runtime'),
        taskId,
      }),
    ).resolves.toMatchObject({exitCode: 0, status: 'passed'});
    await expect(
      runMatchedEvaluationDeterministicVerifierV1({
        artifactHash: '8'.repeat(64),
        plan,
        repositoryRoot: failRepository,
        root: join(root, 'fail-runtime'),
        taskId,
      }),
    ).resolves.toMatchObject({exitCode: 1, status: 'task-failed'});
    await expect(
      runMatchedEvaluationDeterministicVerifierV1({
        artifactHash: '9'.repeat(64),
        plan,
        repositoryRoot: deniedRepository,
        root: join(root, 'denied-runtime'),
        taskId,
      }),
    ).rejects.toThrow('invalid diagnostic protocol');
  });

  it('runs a files-only agent and isolated judge through the pinned app-server protocol', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot(roots);
    const repository = join(root, 'repository');
    await mkdir(repository);
    await git(repository, ['init', '-q']);
    await git(repository, ['config', 'user.email', 'evaluation@example.invalid']);
    await git(repository, ['config', 'user.name', 'Evaluation Fixture']);
    await git(repository, ['remote', 'add', 'origin', 'https://github.com/example/adapter-fixture.git']);
    await writeFile(join(repository, 'service.ts'), 'export const value = 1;\n');
    await git(repository, ['add', 'service.ts']);
    await git(repository, ['commit', '-qm', 'fixture']);
    const observed = await observeMatchedEvaluationRepositoryV1(repository);
    const bunExecutable = await realpath(process.execPath);
    const gitExecutable = await realpath('/usr/bin/git');
    const selfExecutable = await realpath('/usr/bin/true');
    const fakeAppServer = join(process.cwd(), 'packages/testing/src/fake-matched-evaluation-app-server.ts');
    const authSourcePath = join(root, 'auth.json');
    await writeFile(authSourcePath, '{}\n', {mode: 0o600});
    await chmod(authSourcePath, 0o600);
    const config = {
      ...adapterConfig(),
      appServer: {
        argumentsAfterSubcommand: [],
        argumentsBeforeSubcommand: [fakeAppServer],
        executable: bunExecutable,
        executableSha256: sha256HexSync(await readFile(bunExecutable)),
        version: 'codex-cli matched-evaluation-test-v1',
      },
      authSourcePath,
      git: {executable: gitExecutable, executableSha256: sha256HexSync(await readFile(gitExecutable))},
      judgeModel: {...adapterConfig().judgeModel, reasoningEffort: 'medium'},
      safeBinaries: [],
      safeExecutablePath: [dirname(bunExecutable), dirname(gitExecutable)].join(delimiter),
      temporaryRoot: root,
    };
    const configPath = join(root, 'adapter-config.json');
    const configBytes = Buffer.from(`${JSON.stringify(config)}\n`);
    await writeFile(configPath, configBytes);
    const requestPath = join(root, 'request.json');
    const responsePath = join(root, 'response.json');
    const artifactPath = join(root, 'artifact.json');
    const transcriptPath = join(root, 'transcript.jsonl');
    await writeFile(
      requestPath,
      `${JSON.stringify({
        adapterArtifactHash: sha256HexSync(await readFile(selfExecutable)),
        adapterConfigurationHash: sha256HexSync(configBytes),
        adapterProtocol: 'matched-evaluation-adapter-v4',
        agentTask: {
          category: 'architecture-discovery',
          memoryFixtures: [],
          prompt: 'Inspect the service and report completion.',
          repositoryFixtureHash: observed.fixtureHash,
          taskId: 'tsk_0123456789abcdef',
          variant: 'implementation',
        },
        arm: 'files',
        artifactPath,
        blindLabel: 'A',
        environmentPolicyHash: config.environmentPolicyHash,
        judgeTask: {
          negativeControls: [],
          rubric: {completion: 'The task is complete.', criteria: ['The answer is correct.'], requiredEvidenceIds: []},
          sourceGold: [],
        },
        manifestHash: '6'.repeat(64),
        model: {model: config.model.id, parametersHash: config.model.parametersHash, provider: config.model.provider},
        preparedContext: null,
        repository: observed,
        runNonce: 'run_0123456789abcdef0123456789abcdef',
        runOrder: 0,
        tool: {
          artifactHash: null,
          detail: null,
          executable: null,
          lockIdentityHash: null,
          name: 'files-only',
          version: '1',
        },
        transcriptPath,
        verificationPlanHash: null,
        version: 4,
      })}\n`,
    );
    const originalCwd = process.cwd();
    try {
      process.chdir(repository);
      await runMatchedEvaluationCodexAdapter({configPath, requestPath, responsePath, selfExecutable});
    } finally {
      process.chdir(originalCwd);
    }

    const response = JSON.parse(await readFile(responsePath, 'utf8')) as {
      readonly artifactHash: string;
      readonly transcriptHash: string;
    };
    expect(response).toMatchObject({
      metrics: {
        completion: {completed: true},
        context: null,
        correctness: {judge: 'blinded-rubric-v1', judgeCompleted: true, scoreMilli: 1_000},
        usage: {providerTokens: {inputTokens: 100, outputTokens: 50, totalTokens: 150}},
        validity: {failureCount: 0, valid: true},
      },
      version: 3,
    });
    expect(sha256HexSync(await readFile(artifactPath))).toBe(response.artifactHash);
    expect(sha256HexSync(await readFile(transcriptPath))).toBe(response.transcriptHash);
    expect((await readdir(root)).filter(name => name.startsWith('matched-evaluation-codex-'))).toEqual([]);
  }, 30_000);
});

function adapterConfig() {
  return {
    appServer: {
      argumentsAfterSubcommand: [],
      argumentsBeforeSubcommand: [],
      executable: '/usr/bin/codex',
      executableSha256: '1'.repeat(64),
      version: 'codex-cli 1.0.0',
    },
    arm: 'files' as const,
    authSourcePath: '/tmp/auth.json',
    contextBudgetTokens: 1_200,
    contextHomes: [],
    environmentPolicyHash: matchedEvaluationCodexEnvironmentPolicyHashV1(),
    git: {executable: '/usr/bin/git', executableSha256: '3'.repeat(64)},
    judgeModel: {id: 'judge-model', parametersHash: '4'.repeat(64), provider: 'openai', reasoningEffort: 'low'},
    model: {id: 'agent-model', parametersHash: '5'.repeat(64), provider: 'openai', reasoningEffort: 'medium'},
    pricingMicrosPerMillionTokens: {cachedInput: 100_000, input: 1_000_000, output: 2_000_000},
    safeBinaries: [{path: '/usr/bin/git', sha256: '3'.repeat(64)}],
    safeExecutablePath: '/usr/bin:/bin',
    taskBudget: {steps: 100, tokens: 100_000},
    temporaryRoot: '/tmp',
    verificationPlan: null,
    version: 2 as const,
  };
}

function usageEvent(total: {
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}): Record<string, unknown> {
  return {method: 'thread/tokenUsage/updated', params: {tokenUsage: {total}}};
}

async function temporaryRoot(roots: string[]): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-matched-adapter-')));
  roots.push(root);
  return root;
}

async function git(cwd: string, arguments_: readonly string[]): Promise<void> {
  await captureCodeMemoryLinkProcessGroup({
    arguments: ['-C', cwd, ...arguments_],
    command: 'git',
    cwd,
    environment: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    },
    label: 'Matched evaluation adapter Git fixture',
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 10_000,
  });
}
