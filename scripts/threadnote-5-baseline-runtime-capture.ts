import {captureCodeMemoryLinkProcessGroup} from './code-memory-link-process-boundary.js';
import {
  access,
  copyDirectory,
  hashBaselineFixtureTree,
  join,
  makeBaselineTemporaryDirectory,
  pinBaselineExecutableCopy,
  prepareBaselineNativeExecutionBoundary,
  realpath,
  removeBaselineTemporaryDirectory,
  withPinnedBaselineExecutableDescriptor,
  writeBaselinePrivateFile,
  type PinnedBaselineExecutable,
  type BaselineNativeExecutionBoundary,
} from './threadnote-5-baseline-filesystem-boundary.js';
import {
  parseThreadnote5BaselineCapturePlanV1,
  parseThreadnote5BaselineJudgeResponseV1,
  parseThreadnote5BaselineObserverResponseV1,
  threadnote5BaselineCapturePlanHash,
  threadnote5BaselineJudgeRequestHash,
  threadnote5BaselineObserverRequestHash,
  threadnote5BaselineObserverCitationsHash,
  THREADNOTE_5_BASELINE_JUDGE_PROTOCOL,
  THREADNOTE_5_BASELINE_OBSERVER_PROTOCOL,
  THREADNOTE_5_BASELINE_PRIVATE_REPLAY_SUITE,
  type Threadnote5BaselineCapturePlanV1,
  type Threadnote5BaselineCaptureTrialV1,
  type Threadnote5BaselineJudgeRequestV1,
  type Threadnote5BaselineObserverRequestV1,
  type Threadnote5BaselinePrivateReplayTrialV1,
  type Threadnote5BaselinePrivateReplayV1,
} from '../src/evaluation/threadnote-5-release-readiness-baseline-capture.js';
import {
  parseThreadnote5BaselineEvidenceV1,
  threadnote5BaselineEvidenceHash,
  threadnote5BaselineObservationHash,
  THREADNOTE_5_BASELINE_COMMIT,
  THREADNOTE_5_BASELINE_EVIDENCE_SUITE,
  THREADNOTE_5_BASELINE_VERSION,
  THREADNOTE_5_RELEASE_READINESS_VERSION,
  type Threadnote5BaselineEvidenceV1,
  type Threadnote5BaselineObservationV1,
  type Threadnote5RuntimeIdentityV1,
  type Threadnote5SourceV1,
} from '../src/evaluation/threadnote-5-release-readiness-contract.js';
import {canonicalJson} from '../src/code_graph/checkpoint/canonical_json.js';
import {sha256HexSync} from '../src/crypto/sha256.js';

export interface Threadnote5BaselineRuntimeCaptureTestHooks {
  readonly afterExecutableVerification?: (input: {
    readonly executablePath: string;
    readonly helperPath: string;
    readonly role: 'baseline' | 'judge' | 'observer';
  }) => Promise<void>;
  readonly beforeExecutableSpawn?: (input: {
    readonly executablePath: string;
    readonly role: 'baseline' | 'judge' | 'observer';
  }) => Promise<void>;
}

/** Capture exact 4.7.8 through separately reviewed observer and judge executables. */
export async function captureThreadnote5BaselineEvidenceV1(
  input: {
    readonly executablePath: string;
    readonly expectedExecutableSha256: string;
    readonly expectedJudgeExecutableSha256: string;
    readonly expectedObserverExecutableSha256: string;
    readonly expectedPlanSha256: string;
    readonly judgeExecutablePath: string;
    readonly observerExecutablePath: string;
    readonly plan: unknown;
  },
  hooks: Threadnote5BaselineRuntimeCaptureTestHooks = {},
): Promise<{
  readonly evidence: Threadnote5BaselineEvidenceV1;
  readonly privateReplay: Threadnote5BaselinePrivateReplayV1;
}> {
  const plan = parseThreadnote5BaselineCapturePlanV1(input.plan);
  const capturePlanSha256 = threadnote5BaselineCapturePlanHash(plan);
  if (capturePlanSha256 !== exactHash(input.expectedPlanSha256, 'capture-plan hash')) {
    throw new Error('Baseline capture plan does not match the independently supplied expected hash.');
  }
  const executableSha256 = exactHash(input.expectedExecutableSha256, 'executable hash');
  const judgeExecutableSha256 = exactHash(input.expectedJudgeExecutableSha256, 'judge executable hash');
  const observerExecutableSha256 = exactHash(input.expectedObserverExecutableSha256, 'observer executable hash');
  if (observerExecutableSha256 !== plan.observer.executableSha256) {
    throw new Error('Baseline observer executable does not match the independently reviewed capture plan.');
  }
  if (judgeExecutableSha256 !== plan.judge.executableSha256) {
    throw new Error('Baseline judge executable does not match the independently reviewed capture plan.');
  }
  if (new Set([executableSha256, observerExecutableSha256, judgeExecutableSha256]).size !== 3) {
    throw new Error('Threadnote 4.7.8, observer, and judge must have distinct executable bytes.');
  }
  await assertBaselineNetworkSandboxSupported();
  const root = await makeBaselineTemporaryDirectory('threadnote-4.7.8-capture-');
  try {
    const descriptorExecHelper = await prepareThreadnote5DescriptorExecHelperV1(root);
    const executable = await pinBaselineExecutableCopy(
      await realpath(input.executablePath),
      join(root, 'threadnote-4.7.8'),
      executableSha256,
    );
    const observerExecutable = await pinBaselineExecutableCopy(
      await realpath(input.observerExecutablePath),
      join(root, 'baseline-observer'),
      observerExecutableSha256,
    );
    const judgeExecutable = await pinBaselineExecutableCopy(
      await realpath(input.judgeExecutablePath),
      join(root, 'baseline-judge'),
      judgeExecutableSha256,
    );
    const source = {
      commit: THREADNOTE_5_BASELINE_COMMIT,
      executableSha256,
      id: 'threadnote-4.7.x',
      version: THREADNOTE_5_BASELINE_VERSION,
    } as const;
    const observations: Threadnote5BaselineObservationV1[] = [];
    const replayTrials: Threadnote5BaselinePrivateReplayTrialV1[] = [];
    for (const trial of plan.trials) {
      const captured = await captureTrial({
        capturePlanSha256,
        descriptorExecHelper,
        executable,
        hooks,
        judgeExecutable,
        observerExecutable,
        plan,
        source,
        trial,
      });
      observations.push(captured.observation);
      replayTrials.push(captured.privateReplay);
    }
    const projection = {
      observations,
      source,
      suite: THREADNOTE_5_BASELINE_EVIDENCE_SUITE,
      version: THREADNOTE_5_RELEASE_READINESS_VERSION,
    } as const;
    const evidence = parseThreadnote5BaselineEvidenceV1({
      ...projection,
      evidenceHash: threadnote5BaselineEvidenceHash(projection),
    });
    return {
      evidence,
      privateReplay: {
        capturePlan: plan,
        capturePlanSha256,
        suite: THREADNOTE_5_BASELINE_PRIVATE_REPLAY_SUITE,
        trials: replayTrials,
        version: 1,
      },
    };
  } finally {
    await removeBaselineTemporaryDirectory(root);
  }
}

async function captureTrial(input: {
  readonly capturePlanSha256: string;
  readonly descriptorExecHelper: BaselineNativeExecutionBoundary;
  readonly executable: PinnedBaselineExecutable;
  readonly hooks: Threadnote5BaselineRuntimeCaptureTestHooks;
  readonly judgeExecutable: PinnedBaselineExecutable;
  readonly observerExecutable: PinnedBaselineExecutable;
  readonly plan: Threadnote5BaselineCapturePlanV1;
  readonly source: Threadnote5SourceV1;
  readonly trial: Threadnote5BaselineCaptureTrialV1;
}): Promise<{
  readonly observation: Threadnote5BaselineObservationV1;
  readonly privateReplay: Threadnote5BaselinePrivateReplayTrialV1;
}> {
  const homeFixture = await realpath(input.trial.homeFixturePath);
  const repositoryFixture = await realpath(input.trial.repositoryFixturePath);
  await assertFixtureHash(homeFixture, input.trial.homeFixtureSha256, 'home');
  await assertFixtureHash(repositoryFixture, input.trial.repositoryFixtureSha256, 'repository');
  const root = await makeBaselineTemporaryDirectory(`threadnote-4.7.8-${input.trial.trialId}-`);
  try {
    const home = join(root, 'threadnote-home');
    const homeSnapshot = join(root, 'home-fixture-snapshot');
    const repository = join(root, 'repository');
    const userHome = join(root, 'user-home');
    await copyThreadnote5BaselineHomeFixturesV1({
      expectedSha256: input.trial.homeFixtureSha256,
      home,
      snapshot: homeSnapshot,
      source: homeFixture,
      userHome,
    });
    await copyDirectory(repositoryFixture, repository);
    await assertFixtureHash(repository, input.trial.repositoryFixtureSha256, 'copied repository');
    const environment = isolatedEnvironment({home, repository, root, userHome});
    const preRuntime = await readRuntimeIdentity(
      input.executable,
      input.descriptorExecHelper,
      repository,
      environment,
      input.source,
      input.hooks,
    );
    const contextBriefStarted = performance.now();
    const result = await runWithoutNetwork(
      input.executable,
      input.descriptorExecHelper,
      [
        'context',
        'brief',
        '--json',
        '--task',
        input.trial.task,
        '--cwd',
        repository,
        '--budget-tokens',
        String(input.trial.budgetTokens),
      ],
      environment,
      repository,
      `Threadnote 4.7.8 baseline trial ${input.trial.trialId}`,
      8 * 1_024 * 1_024,
      120_000,
      input.hooks,
    );
    const contextBriefMilliseconds = Math.ceil(Math.max(0, performance.now() - contextBriefStarted));
    const contextBrief = parseContextBrief(result.stdout);
    const returnedMemoryUris = memoryUris(contextBrief);
    if (!input.trial.requiredMemoryUris.every(uri => returnedMemoryUris.includes(uri))) {
      throw new Error(`Baseline trial ${input.trial.trialId} did not emit every required native memory citation.`);
    }
    const requestProjection = {
      capturePlanSha256: input.capturePlanSha256,
      contextBrief,
      contextBriefOutputSha256: sha256HexSync(result.stdout),
      homeFixtureSha256: input.trial.homeFixtureSha256,
      protocol: THREADNOTE_5_BASELINE_OBSERVER_PROTOCOL,
      repositoryFixtureSha256: input.trial.repositoryFixtureSha256,
      source: {
        commit: input.source.commit,
        executableSha256: input.source.executableSha256,
        version: input.source.version,
      },
      task: input.trial.task,
      trialId: input.trial.trialId,
      version: 1,
    } as const;
    const requestSha256 = threadnote5BaselineObserverRequestHash(requestProjection);
    const request: Threadnote5BaselineObserverRequestV1 = {...requestProjection, requestSha256};
    const requestPath = join(root, 'observer-request.json');
    await writeBaselinePrivateFile(requestPath, `${canonicalJson(request)}\n`);
    const observerResult = await captureThreadnote5PinnedExecutableV1({
      arguments: ['--request', requestPath],
      cwd: repository,
      environment,
      executable: input.observerExecutable,
      helper: input.descriptorExecHelper,
      hooks: input.hooks,
      label: `Threadnote 4.7.8 external observer trial ${input.trial.trialId}`,
      maxOutputBytes: 2 * 1_024 * 1_024,
      networkIsolated: false,
      role: 'observer',
      timeoutMilliseconds: 600_000,
    });
    const observerResponse = parseThreadnote5BaselineObserverResponseV1(parseObserverResponse(observerResult.stdout), {
      allowedMemoryUris: input.trial.allowedMemoryUris,
      identity: input.plan.observer,
      requestSha256,
      requiredMemoryUris: input.trial.requiredMemoryUris,
      returnedMemoryUris,
      trialId: input.trial.trialId,
    });
    const firstCitedPlanSha256 = sha256HexSync(observerResponse.firstCitedPlan);
    const citedMemoryUrisSha256 = threadnote5BaselineObserverCitationsHash(observerResponse.citedMemoryUris);
    const judgeRequestProjection = {
      capturePlanSha256: input.capturePlanSha256,
      citedMemoryUris: observerResponse.citedMemoryUris,
      citedMemoryUrisSha256,
      contextBriefOutput: result.stdout,
      contextBriefOutputSha256: request.contextBriefOutputSha256,
      firstCitedPlan: observerResponse.firstCitedPlan,
      firstCitedPlanSha256,
      observerRequest: request,
      observerRequestSha256: requestSha256,
      protocol: THREADNOTE_5_BASELINE_JUDGE_PROTOCOL,
      trialId: input.trial.trialId,
      version: 1,
    } as const;
    const judgeRequestSha256 = threadnote5BaselineJudgeRequestHash(judgeRequestProjection);
    const judgeRequest: Threadnote5BaselineJudgeRequestV1 = {
      ...judgeRequestProjection,
      requestSha256: judgeRequestSha256,
    };
    const judgeRequestPath = join(root, 'judge-request.json');
    await writeBaselinePrivateFile(judgeRequestPath, `${canonicalJson(judgeRequest)}\n`);
    const judgeResult = await captureThreadnote5PinnedExecutableV1({
      arguments: ['--request', judgeRequestPath],
      cwd: repository,
      environment,
      executable: input.judgeExecutable,
      helper: input.descriptorExecHelper,
      hooks: input.hooks,
      label: `Threadnote 4.7.8 independent judge trial ${input.trial.trialId}`,
      maxOutputBytes: 1 * 1_024 * 1_024,
      networkIsolated: false,
      role: 'judge',
      timeoutMilliseconds: 600_000,
    });
    const judgeResponse = parseThreadnote5BaselineJudgeResponseV1(parseJudgeResponse(judgeResult.stdout), {
      firstCitedPlanSha256,
      identity: input.plan.judge,
      requestSha256: judgeRequestSha256,
      trialId: input.trial.trialId,
    });
    const postRuntime = await readRuntimeIdentity(
      input.executable,
      input.descriptorExecHelper,
      repository,
      environment,
      input.source,
      input.hooks,
    );
    await assertFixtureHash(homeFixture, input.trial.homeFixtureSha256, 'source home');
    await assertFixtureHash(repositoryFixture, input.trial.repositoryFixtureSha256, 'source repository');
    const projection = {
      capturePlanSha256: input.capturePlanSha256,
      contextBriefOutputSha256: request.contextBriefOutputSha256,
      estimatedTokensToFirstCitedCorrectPlan: observerResponse.measurementReceipt.estimatedTokensToFirstCitedPlan,
      firstCitedPlanIndependentlyJudgedCorrect: true,
      firstCitedPlanSha256,
      provenance: {
        judgeExecutableSha256: input.judgeExecutable.sha256,
        judgeId: input.plan.judge.id,
        judgeProtocol: THREADNOTE_5_BASELINE_JUDGE_PROTOCOL,
        judgeRequestSha256,
        judgeResponseSha256: sha256HexSync(judgeResult.stdout),
        judgmentReceiptSha256: judgeResponse.receiptSha256,
        measurementReceiptSha256: observerResponse.measurementReceipt.receiptSha256,
        observerExecutableSha256: input.observerExecutable.sha256,
        observerId: input.plan.observer.id,
        observerProtocol: THREADNOTE_5_BASELINE_OBSERVER_PROTOCOL,
        observerRequestSha256: requestSha256,
        observerResponseSha256: sha256HexSync(observerResult.stdout),
        version: 1,
      },
      postRuntime,
      preRuntime,
      timeToFirstCitedCorrectPlanMilliseconds:
        contextBriefMilliseconds +
        observerResponse.measurementReceipt.timeFromObserverRequestToFirstCitedPlanMilliseconds,
      trialId: input.trial.trialId,
      wrongMemoryEligible: input.trial.wrongMemoryEligible,
      wrongMemoryObserved:
        input.trial.wrongMemoryEligible && returnedMemoryUris.some(uri => !input.trial.allowedMemoryUris.includes(uri)),
    } as const;
    return {
      observation: {...projection, observationHash: threadnote5BaselineObservationHash(projection)},
      privateReplay: {
        judgeRequest,
        judgeResponse,
        judgeResponseOutput: judgeResult.stdout,
        observerRequest: request,
        observerResponse,
        observerResponseOutput: observerResult.stdout,
        trialId: input.trial.trialId,
      },
    };
  } finally {
    await removeBaselineTemporaryDirectory(root);
  }
}

type BaselineFixtureCopy = (source: string, destination: string) => Promise<void>;

export async function copyThreadnote5BaselineHomeFixturesV1(
  input: {
    readonly expectedSha256: string;
    readonly home: string;
    readonly snapshot: string;
    readonly source: string;
    readonly userHome: string;
  },
  copyFixture: BaselineFixtureCopy = copyDirectory,
): Promise<void> {
  await copyFixture(input.source, input.snapshot);
  await assertFixtureHash(input.snapshot, input.expectedSha256, 'private home snapshot');
  await copyFixture(input.snapshot, input.home);
  await copyFixture(input.snapshot, input.userHome);
  await assertFixtureHash(input.home, input.expectedSha256, 'copied threadnote home');
  await assertFixtureHash(input.userHome, input.expectedSha256, 'copied process home');
  await assertFixtureHash(input.snapshot, input.expectedSha256, 'private home snapshot');
}

async function readRuntimeIdentity(
  executable: PinnedBaselineExecutable,
  helper: BaselineNativeExecutionBoundary,
  cwd: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  source: Threadnote5SourceV1,
  hooks: Threadnote5BaselineRuntimeCaptureTestHooks,
): Promise<Threadnote5RuntimeIdentityV1> {
  const version = await runWithoutNetwork(
    executable,
    helper,
    ['--version'],
    environment,
    cwd,
    'Threadnote 4.7.8 runtime identity',
    4_096,
    10_000,
    hooks,
  );
  if (version.stdout.trim() !== `threadnote v${THREADNOTE_5_BASELINE_VERSION}`) {
    throw new Error('Baseline executable did not report exact Threadnote 4.7.8 identity.');
  }
  return {executableSha256: source.executableSha256, sourceCommit: source.commit};
}

async function runWithoutNetwork(
  executable: PinnedBaselineExecutable,
  helper: BaselineNativeExecutionBoundary,
  arguments_: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  cwd: string,
  label: string,
  maxOutputBytes: number,
  timeoutMilliseconds: number,
  hooks: Threadnote5BaselineRuntimeCaptureTestHooks,
) {
  return await captureThreadnote5PinnedExecutableV1({
    arguments: arguments_,
    cwd,
    environment,
    executable,
    helper,
    hooks,
    label,
    maxOutputBytes,
    networkIsolated: true,
    role: 'baseline',
    timeoutMilliseconds,
  });
}

export async function prepareThreadnote5DescriptorExecHelperV1(root: string): Promise<BaselineNativeExecutionBoundary> {
  return await prepareBaselineNativeExecutionBoundary(root);
}

export async function captureThreadnote5PinnedExecutableV1(input: {
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly executable: PinnedBaselineExecutable;
  readonly helper: BaselineNativeExecutionBoundary;
  readonly hooks?: Threadnote5BaselineRuntimeCaptureTestHooks;
  readonly label: string;
  readonly maxOutputBytes: number;
  readonly networkIsolated: boolean;
  readonly role: 'baseline' | 'judge' | 'observer';
  readonly timeoutMilliseconds: number;
}) {
  return await withPinnedBaselineExecutableDescriptor(input.executable, async (descriptor, verifyExecutable) => {
    await input.hooks?.beforeExecutableSpawn?.({
      executablePath: input.executable.path,
      role: input.role,
    });
    const helperArguments = [
      '-I',
      '-S',
      '-c',
      input.helper.source,
      input.executable.sha256,
      input.executable.path,
      ...input.arguments,
    ];
    const invocation = input.networkIsolated
      ? threadnote5BaselineNetworkSandboxInvocation(process.platform, input.helper.interpreter, helperArguments)
      : {arguments: helperArguments, command: input.helper.interpreter};
    await access(invocation.command);
    await verifyExecutable();
    await input.hooks?.afterExecutableVerification?.({
      executablePath: input.executable.path,
      helperPath: input.helper.path,
      role: input.role,
    });
    return await captureCodeMemoryLinkProcessGroup({
      arguments: invocation.arguments,
      command: invocation.command,
      cwd: input.cwd,
      environment: input.environment,
      inheritedFileDescriptors: [descriptor],
      label: input.label,
      maxOutputBytes: input.maxOutputBytes,
      timeoutMilliseconds: input.timeoutMilliseconds,
    });
  });
}

export function threadnote5BaselineNetworkSandboxInvocation(
  platform: NodeJS.Platform,
  executable: string,
  arguments_: readonly string[],
): {readonly arguments: readonly string[]; readonly command: string} {
  if (platform === 'darwin') {
    return {
      arguments: ['-p', '(version 1)(allow default)(deny network*)', executable, ...arguments_],
      command: '/usr/bin/sandbox-exec',
    };
  }
  if (platform === 'linux') {
    return {
      arguments: ['--user', '--map-root-user', '--net', '--', executable, ...arguments_],
      command: '/usr/bin/unshare',
    };
  }
  throw new Error(`Baseline capture network isolation is unsupported on ${platform}.`);
}

async function assertBaselineNetworkSandboxSupported(): Promise<void> {
  const executable = await availableTrueExecutable();
  const invocation = threadnote5BaselineNetworkSandboxInvocation(process.platform, executable, []);
  await access(invocation.command).catch(cause => {
    throw new Error(`Baseline capture network isolation is unavailable on ${process.platform}.`, {cause});
  });
  const probe = await captureCodeMemoryLinkProcessGroup({
    allowFailure: true,
    arguments: invocation.arguments,
    command: invocation.command,
    cwd: process.cwd(),
    environment: {PATH: '/usr/bin:/bin'},
    label: 'Baseline capture network-isolation capability probe',
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 10_000,
  });
  if (probe.exitCode !== 0) {
    const reason = Array.from(probe.stderr.trim())
      .map(character => {
        const code = character.codePointAt(0)!;
        return code < 32 || code === 127 ? ' ' : character;
      })
      .join('')
      .slice(0, 512);
    const mechanism =
      process.platform === 'linux'
        ? 'unprivileged user and network namespaces (--user --map-root-user --net) are disabled or unavailable'
        : 'sandbox-exec could not enforce a deny-network profile';
    throw new Error(
      `Baseline capture network isolation is unsupported on this ${process.platform} host: ${mechanism}${reason ? ` (${reason})` : ''}.`,
    );
  }
}

async function availableTrueExecutable(): Promise<string> {
  for (const path of ['/usr/bin/true', '/bin/true']) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return path;
  }
  throw new Error('Baseline capture network-isolation probe could not find the operating-system true executable.');
}

function isolatedEnvironment(input: {
  readonly home: string;
  readonly repository: string;
  readonly root: string;
  readonly userHome: string;
}): Readonly<NodeJS.ProcessEnv> {
  return {
    ALL_PROXY: '',
    CI: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: input.userHome,
    HTTPS_PROXY: '',
    HTTP_PROXY: '',
    NO_PROXY: '*',
    PATH: '/usr/bin:/bin',
    THREADNOTE_CALLER_CWD: input.repository,
    THREADNOTE_HOME: input.home,
    THREADNOTE_USER: 'baseline-capture',
    TMPDIR: input.root,
    USER: 'baseline-capture',
  };
}

async function assertFixtureHash(path: string, expected: string, label: string): Promise<void> {
  if ((await hashBaselineFixtureTree(path)) !== exactHash(expected, `${label} fixture hash`)) {
    throw new Error(`Baseline ${label} fixture does not match its reviewed content hash.`);
  }
}

function parseContextBrief(stdout: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new Error('Threadnote 4.7.8 did not emit a native JSON Context Brief.', {cause});
  }
  const brief = record(value, 'Threadnote 4.7.8 Context Brief');
  if (
    brief.type !== 'context-brief' ||
    !Array.isArray(brief.durableDecisions) ||
    !Array.isArray(brief.activeHandoffs)
  ) {
    throw new Error('Threadnote 4.7.8 Context Brief is missing source-native evidence lanes.');
  }
  return brief;
}

function parseObserverResponse(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new Error('Baseline observer did not emit one valid JSON response.', {cause});
  }
}

function parseJudgeResponse(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new Error('Baseline judge did not emit one valid JSON response.', {cause});
  }
}

function memoryUris(brief: Readonly<Record<string, unknown>>): readonly string[] {
  const values = [...(brief.durableDecisions as unknown[]), ...(brief.activeHandoffs as unknown[])];
  const uris = values.map(value => {
    const uri = record(value, 'Context Brief memory').uri;
    if (typeof uri !== 'string' || uri.length === 0 || new TextEncoder().encode(uri).byteLength > 4_096) {
      throw new Error('Threadnote 4.7.8 Context Brief memory URI is invalid.');
    }
    return uri;
  });
  if (new Set(uris).size !== uris.length) throw new Error('Threadnote 4.7.8 emitted duplicate memory citations.');
  return uris;
}

function exactHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`Baseline capture ${label} is invalid.`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
