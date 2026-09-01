#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed calibration adapter owns explicit process and filesystem boundaries. */
import {lstat, mkdir, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {parseCodeMemoryLinkAgentAbManifestV1} from '../src/evaluation/code-memory-link-agent-ab.js';
import {parseCodeMemoryLinkAgentClientOutputV1} from '../src/evaluation/code-memory-link-agent-evidence.js';
import {
  codeMemoryLinkArmPacketHashV1,
  deriveCodeMemoryLinkCodexAppServerProjectionV1,
} from '../src/evaluation/code-memory-link-agent-protocol.js';
import {
  codeMemoryLinkCodexInvocationNonceDigestV1,
  codeMemoryLinkCodexRunBindingHashV1,
} from '../src/evaluation/code-memory-link-codex-evidence.js';
import {sha256HexSync} from '../src/crypto/sha256.js';
import {
  parseCodeMemoryLinkCodexClientConfigV1,
  projectCodeMemoryLinkCodexClientConfigV1,
} from './code-memory-link-codex-isolation.js';
import {parseCodeMemoryLinkCodexTerminalReceipt} from './code-memory-link-codex-terminal.js';
import {verifyCodeMemoryLinkEvaluatedSubject} from './code-memory-link-evaluated-subject.js';
import {CODE_MEMORY_LINK_CALIBRATION_KIND} from './prepare-code-memory-link-agent-ab.js';
import {parseCalibrationPlan, parseClientRegistry} from './run-code-memory-link-agent-matrix.js';
import {captureCodeMemoryLinkProcessGroup} from './code-memory-link-process-boundary.js';

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const CLIENT_ID = /^cli_[0-9a-f]{16,64}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const MAXIMUM_DIAGNOSTICS_BYTES = 1 * 1_024 * 1_024;

interface Options {
  readonly candidateCommit: string;
  readonly candidateExecutable: string;
  readonly candidateExecutableSha256: string;
  readonly diagnosticsPath: string;
  readonly preparedRoot: string;
}

interface CalibrationEnvironment {
  readonly arm: 'anchored' | 'no-memory' | 'task-only';
  readonly clientId: string;
  readonly planHash: string;
  readonly planPath: string;
  readonly root: string;
  readonly runOrder: number;
  readonly taskId: string;
}

interface CalibrationDiagnosticV1 {
  readonly arm: CalibrationEnvironment['arm'];
  readonly clientId: string;
  readonly diagnosticHash: string;
  readonly evidenceHash: string | null;
  readonly fileChangeStarted: boolean;
  readonly firstUsefulMemoryUse: boolean;
  readonly kind: typeof CODE_MEMORY_LINK_CALIBRATION_KIND;
  readonly planHash: string;
  readonly runOrder: number;
  readonly status: 'completed' | 'terminal';
  readonly taskId: string;
  readonly taskPassed: boolean | null;
  readonly terminalKind: string | null;
  readonly totalTaskUsage: {readonly steps: number; readonly tokens: number} | null;
  readonly version: 1;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const environment = parseEnvironment(process.env);
  const preparedRoot = await canonicalDirectory(options.preparedRoot, 'prepared root');
  const calibrationRoot = await canonicalDirectory(environment.root, 'calibration root');
  if (await existingDiagnostic(options.diagnosticsPath, environment)) return;
  const plan = parseCalibrationPlan(await readJson(environment.planPath));
  if (plan.planHash !== environment.planHash) throw new Error('Calibration environment differs from its plan.');
  const scheduled = plan.runs[environment.runOrder];
  if (
    scheduled === undefined ||
    scheduled.arm !== environment.arm ||
    scheduled.clientId !== environment.clientId ||
    scheduled.taskId !== environment.taskId
  ) {
    throw new Error('Calibration environment differs from the canonical schedule.');
  }
  const task = plan.tasks.find(candidate => candidate.packet.taskId === environment.taskId);
  if (!task) throw new Error('Calibration task is outside the plan roster.');
  const manifest = parseCodeMemoryLinkAgentAbManifestV1(await readJson(join(preparedRoot, 'manifest.json')));
  const registry = parseClientRegistry(await readJson(join(preparedRoot, 'clients.json')));
  const client = registry.clients.find(candidate => candidate.clientId === environment.clientId);
  const rostered = manifest.clients.find(candidate => candidate.clientId === environment.clientId);
  if (!client || !rostered || !plan.clients.includes(environment.clientId)) {
    throw new Error('Calibration client is outside the prepared roster.');
  }
  const subject = await verifyCodeMemoryLinkEvaluatedSubject({
    executable: options.candidateExecutable,
    executableSha256: options.candidateExecutableSha256,
    sourceCommit: options.candidateCommit,
  });
  if (
    subject.identity.sourceCommit !== manifest.candidate.commit ||
    subject.identity.executableSha256 !== manifest.candidate.buildIdentityHash
  ) {
    throw new Error('Calibration subject differs from the prepared candidate.');
  }
  const baseConfig = parseCodeMemoryLinkCodexClientConfigV1(await readJson(client.clientConfigurationPath));
  const config = parseCodeMemoryLinkCodexClientConfigV1({
    ...baseConfig,
    sealedSuite: {
      layoutArtifactId: plan.sealedSuite.layoutArtifactId,
      root: joinRoot(preparedRoot, plan.sealedSuite.rootSource),
    },
  });
  const configPath = join(calibrationRoot, `client-${environment.runOrder}.config.json`);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {encoding: 'utf8', flag: 'wx', mode: 0o600});
  try {
    const blind = blindArm(environment.arm);
    const runNonce = opaqueId('run', `${environment.planHash}:${environment.runOrder}:run`);
    const invocationNonce = opaqueId('inv', `${environment.planHash}:${environment.runOrder}:invocation`);
    const armPacketHash = codeMemoryLinkArmPacketHashV1({
      assignmentHash: environment.planHash,
      blindLabel: blind.label,
      fixtureHash: plan.fixture.fixtureHash,
      packetHash: task.packet.packetHash,
      policy: environment.arm,
      rubricHash: task.rubric.rubricHash,
      runNonce,
      taskId: environment.taskId,
      taskKind: task.packet.taskKind,
      version: 1,
    });
    const runBindingHash = codeMemoryLinkCodexRunBindingHashV1({
      armPacketHash,
      candidateExecutableSha256: subject.identity.executableSha256,
      clientExecutionHash: client.implementationDescriptorHash,
      invocationNonceDigest: codeMemoryLinkCodexInvocationNonceDigestV1(invocationNonce),
      manifestHash: environment.planHash,
      runNonce,
      suiteHash: plan.sealedSuite.suiteHash,
      taskId: environment.taskId,
    });
    const command = await captureCodeMemoryLinkProcessGroup({
      allowFailure: true,
      arguments: client.clientArguments,
      command: client.clientCommand,
      cwd: calibrationRoot,
      environment: {
        HOME: '/nonexistent',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        NO_COLOR: '1',
        PATH: dirname(client.clientCommand),
        TMPDIR: calibrationRoot,
        THREADNOTE_CODE_MEMORY_LINK_APPROVAL_COMMIT: manifest.harnessGovernanceCommit,
        THREADNOTE_CODE_MEMORY_LINK_ARM: environment.arm,
        THREADNOTE_CODE_MEMORY_LINK_ARM_POSITION: String(blind.position),
        THREADNOTE_CODE_MEMORY_LINK_ASSIGNMENT_HASH: environment.planHash,
        THREADNOTE_CODE_MEMORY_LINK_BLIND_LABEL: blind.label,
        THREADNOTE_CODE_MEMORY_LINK_BUDGET_STEPS: String(task.packet.budget.steps),
        THREADNOTE_CODE_MEMORY_LINK_BUDGET_TOKENS: String(task.packet.budget.tokens),
        THREADNOTE_CODE_MEMORY_LINK_CANDIDATE_COMMIT: subject.identity.sourceCommit,
        THREADNOTE_CODE_MEMORY_LINK_CLIENT_CONFIGURATION_PROJECTION_HASH: sha256HexSync(
          `${JSON.stringify(projectCodeMemoryLinkCodexClientConfigV1(config))}\n`,
        ),
        THREADNOTE_CODE_MEMORY_LINK_CLIENT_DESCRIPTOR_HASH: client.implementationDescriptorHash,
        THREADNOTE_CODE_MEMORY_LINK_CLIENT_ENVIRONMENT_POLICY_HASH: client.descriptor.environmentPolicyHash,
        THREADNOTE_CODE_MEMORY_LINK_CLIENT_EXECUTION_BUNDLE_HASH: client.descriptor.executionBundleHash,
        THREADNOTE_CODE_MEMORY_LINK_CLIENT_EXPECTED_PROJECTION_HASH: client.descriptor.expectedClientProjectionHash,
        THREADNOTE_CODE_MEMORY_LINK_CLIENT_ID: environment.clientId,
        THREADNOTE_CODE_MEMORY_LINK_EXECUTABLE: subject.executable,
        THREADNOTE_CODE_MEMORY_LINK_EXECUTABLE_SHA256: subject.identity.executableSha256,
        THREADNOTE_CODE_MEMORY_LINK_FIXTURE_HASH: plan.fixture.fixtureHash,
        THREADNOTE_CODE_MEMORY_LINK_INVOCATION_NONCE: invocationNonce,
        THREADNOTE_CODE_MEMORY_LINK_MANIFEST_HASH: environment.planHash,
        THREADNOTE_CODE_MEMORY_LINK_PACKET_HASH: task.packet.packetHash,
        THREADNOTE_CODE_MEMORY_LINK_RUBRIC_HASH: task.rubric.rubricHash,
        THREADNOTE_CODE_MEMORY_LINK_RUN_NONCE: runNonce,
        THREADNOTE_CODE_MEMORY_LINK_RUN_BINDING_HASH: runBindingHash,
        THREADNOTE_CODE_MEMORY_LINK_RUN_ORDER: String(environment.runOrder),
        THREADNOTE_CODE_MEMORY_LINK_SUITE_HASH: plan.sealedSuite.suiteHash,
        THREADNOTE_CODE_MEMORY_LINK_TASK_ID: environment.taskId,
        THREADNOTE_CODE_MEMORY_LINK_TASK_KIND: task.packet.taskKind,
        THREADNOTE_CODE_MEMORY_LINK_CLIENT_CONFIG: configPath,
      },
      label: 'Reviewed Code Memory Link calibration client',
      maxOutputBytes: 8 * 1_024 * 1_024,
      timeoutMilliseconds: baseConfig.limits.turnTimeoutMilliseconds,
    });
    const diagnostic =
      command.exitCode === 0
        ? completedDiagnostic(environment, command.stdout)
        : terminalDiagnostic(environment, command.stderr);
    await verifyCodeMemoryLinkEvaluatedSubject({
      executable: options.candidateExecutable,
      executableSha256: options.candidateExecutableSha256,
      sourceCommit: options.candidateCommit,
    });
    await appendDiagnostic(options.diagnosticsPath, diagnostic, environment.runOrder);
    process.stdout.write(
      `${JSON.stringify({
        arm: environment.arm,
        clientId: environment.clientId,
        diagnosticsHash: diagnostic.diagnosticHash,
        kind: CODE_MEMORY_LINK_CALIBRATION_KIND,
        planHash: environment.planHash,
        runOrder: environment.runOrder,
        taskId: environment.taskId,
        version: 1,
      })}\n`,
    );
  } finally {
    await rm(configPath, {force: true});
  }
}

function completedDiagnostic(environment: CalibrationEnvironment, stdout: string): CalibrationDiagnosticV1 {
  const output = parseCodeMemoryLinkAgentClientOutputV1(JSON.parse(stdout) as unknown);
  const projection = deriveCodeMemoryLinkCodexAppServerProjectionV1({
    evidence: output.rawEvidence.appServer,
    rubric: output.rawEvidence.rubric,
  });
  return sealDiagnostic({
    environment,
    evidenceHash: output.rawEvidence.evidenceHash,
    fileChangeStarted: output.rawEvidence.appServer.qualifyingActionItemId !== null,
    firstUsefulMemoryUse: projection.firstUsefulMemoryUse !== null,
    status: 'completed',
    taskPassed: projection.taskPassed,
    terminalKind: null,
    totalTaskUsage: projection.totalTaskUsage,
  });
}

function terminalDiagnostic(environment: CalibrationEnvironment, stderr: string): CalibrationDiagnosticV1 {
  const terminal = parseCodeMemoryLinkCodexTerminalReceipt(stderr);
  return sealDiagnostic({
    environment,
    evidenceHash: null,
    fileChangeStarted: false,
    firstUsefulMemoryUse: false,
    status: 'terminal',
    taskPassed: null,
    terminalKind: terminal?.kind ?? 'process-exit',
    totalTaskUsage: null,
  });
}

function sealDiagnostic(input: {
  readonly environment: CalibrationEnvironment;
  readonly evidenceHash: string | null;
  readonly fileChangeStarted: boolean;
  readonly firstUsefulMemoryUse: boolean;
  readonly status: 'completed' | 'terminal';
  readonly taskPassed: boolean | null;
  readonly terminalKind: string | null;
  readonly totalTaskUsage: {readonly steps: number; readonly tokens: number} | null;
}): CalibrationDiagnosticV1 {
  const withoutHash = {
    arm: input.environment.arm,
    clientId: input.environment.clientId,
    evidenceHash: input.evidenceHash,
    fileChangeStarted: input.fileChangeStarted,
    firstUsefulMemoryUse: input.firstUsefulMemoryUse,
    kind: CODE_MEMORY_LINK_CALIBRATION_KIND,
    planHash: input.environment.planHash,
    runOrder: input.environment.runOrder,
    status: input.status,
    taskId: input.environment.taskId,
    taskPassed: input.taskPassed,
    terminalKind: input.terminalKind,
    totalTaskUsage: input.totalTaskUsage,
    version: 1 as const,
  };
  return {...withoutHash, diagnosticHash: diagnosticHash(withoutHash)};
}

async function existingDiagnostic(path: string, environment: CalibrationEnvironment): Promise<boolean> {
  const diagnostics = await readDiagnostics(path);
  if (diagnostics.length <= environment.runOrder) return false;
  if (diagnostics.length !== environment.runOrder + 1)
    throw new Error('Calibration diagnostics are ahead of schedule.');
  const existing = diagnostics[environment.runOrder]!;
  if (
    existing.arm !== environment.arm ||
    existing.clientId !== environment.clientId ||
    existing.planHash !== environment.planHash ||
    existing.runOrder !== environment.runOrder ||
    existing.taskId !== environment.taskId
  ) {
    throw new Error('Calibration diagnostic recovery differs from the scheduled run.');
  }
  process.stdout.write(
    `${JSON.stringify({
      arm: environment.arm,
      clientId: environment.clientId,
      diagnosticsHash: existing.diagnosticHash,
      kind: CODE_MEMORY_LINK_CALIBRATION_KIND,
      planHash: environment.planHash,
      runOrder: environment.runOrder,
      taskId: environment.taskId,
      version: 1,
    })}\n`,
  );
  return true;
}

async function appendDiagnostic(path: string, diagnostic: CalibrationDiagnosticV1, expected: number): Promise<void> {
  const existing = await readDiagnostics(path);
  if (existing.length !== expected) throw new Error('Calibration diagnostics changed concurrently.');
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  await writeFile(path, `${JSON.stringify(diagnostic)}\n`, {
    encoding: 'utf8',
    flag: expected === 0 ? 'wx' : 'a',
    mode: 0o600,
  });
}

async function readDiagnostics(path: string): Promise<readonly CalibrationDiagnosticV1[]> {
  let text: string;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAXIMUM_DIAGNOSTICS_BYTES) {
      throw new Error('Calibration diagnostics must be one bounded regular file.');
    }
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (isMissing(cause)) return [];
    throw cause;
  }
  return text
    .split(/\r?\n/u)
    .flatMap(line => (line.length === 0 ? [] : [parseDiagnostic(JSON.parse(line) as unknown)]));
}

function parseDiagnostic(value: unknown): CalibrationDiagnosticV1 {
  const diagnostic = record(value, 'calibration diagnostic');
  const expected = [
    'arm',
    'clientId',
    'diagnosticHash',
    'evidenceHash',
    'fileChangeStarted',
    'firstUsefulMemoryUse',
    'kind',
    'planHash',
    'runOrder',
    'status',
    'taskId',
    'taskPassed',
    'terminalKind',
    'totalTaskUsage',
    'version',
  ].sort();
  if (JSON.stringify(Object.keys(diagnostic).sort()) !== JSON.stringify(expected)) {
    throw new Error('Calibration diagnostic has unsupported fields.');
  }
  if (
    diagnostic.version !== 1 ||
    diagnostic.kind !== CODE_MEMORY_LINK_CALIBRATION_KIND ||
    (diagnostic.arm !== 'anchored' && diagnostic.arm !== 'task-only' && diagnostic.arm !== 'no-memory') ||
    (diagnostic.status !== 'completed' && diagnostic.status !== 'terminal') ||
    typeof diagnostic.fileChangeStarted !== 'boolean' ||
    typeof diagnostic.firstUsefulMemoryUse !== 'boolean' ||
    (diagnostic.taskPassed !== null && typeof diagnostic.taskPassed !== 'boolean') ||
    (diagnostic.terminalKind !== null && typeof diagnostic.terminalKind !== 'string')
  ) {
    throw new Error('Calibration diagnostic is invalid.');
  }
  const parsed = {
    arm: diagnostic.arm,
    clientId: matching(diagnostic.clientId, CLIENT_ID, 'diagnostic client'),
    evidenceHash:
      diagnostic.evidenceHash === null ? null : matching(diagnostic.evidenceHash, HASH, 'diagnostic evidence hash'),
    fileChangeStarted: diagnostic.fileChangeStarted,
    firstUsefulMemoryUse: diagnostic.firstUsefulMemoryUse,
    kind: CODE_MEMORY_LINK_CALIBRATION_KIND,
    planHash: matching(diagnostic.planHash, HASH, 'diagnostic plan hash'),
    runOrder: integer(diagnostic.runOrder, 'diagnostic run order'),
    status: diagnostic.status,
    taskId: matching(diagnostic.taskId, TASK_ID, 'diagnostic task'),
    taskPassed: diagnostic.taskPassed,
    terminalKind: diagnostic.terminalKind,
    totalTaskUsage: parseUsage(diagnostic.totalTaskUsage),
    version: 1 as const,
  };
  const hash = matching(diagnostic.diagnosticHash, HASH, 'diagnostic hash');
  if (hash !== diagnosticHash(parsed)) throw new Error('Calibration diagnostic hash is invalid.');
  return {...parsed, diagnosticHash: hash};
}

function parseUsage(value: unknown): {readonly steps: number; readonly tokens: number} | null {
  if (value === null) return null;
  const usage = record(value, 'calibration usage');
  if (JSON.stringify(Object.keys(usage).sort()) !== JSON.stringify(['steps', 'tokens'])) {
    throw new Error('Calibration usage has unsupported fields.');
  }
  return {steps: integer(usage.steps, 'calibration steps'), tokens: integer(usage.tokens, 'calibration tokens')};
}

function parseEnvironment(environment: NodeJS.ProcessEnv): CalibrationEnvironment {
  const value = (name: string): string => {
    const observed = environment[name];
    if (!observed || observed.trim() !== observed) throw new Error(`Missing calibration environment ${name}.`);
    return observed;
  };
  const arm = value('THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_ARM');
  if (arm !== 'anchored' && arm !== 'task-only' && arm !== 'no-memory') throw new Error('Calibration arm is invalid.');
  return {
    arm,
    clientId: matching(value('THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_CLIENT_ID'), CLIENT_ID, 'calibration client'),
    planHash: matching(value('THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_PLAN_HASH'), HASH, 'calibration plan hash'),
    planPath: absolute(value('THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_PLAN'), 'calibration plan'),
    root: absolute(value('THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_ROOT'), 'calibration root'),
    runOrder: integer(value('THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_RUN_ORDER'), 'calibration run order'),
    taskId: matching(value('THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_TASK_ID'), TASK_ID, 'calibration task'),
  };
}

function parseArguments(arguments_: readonly string[]): Options {
  const values = new Map<string, string>();
  const supported = new Set([
    '--candidate-commit',
    '--candidate-executable',
    '--candidate-executable-sha256',
    '--diagnostics',
    '--prepared-root',
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index]!;
    if (!supported.has(option) || values.has(option)) throw new Error(`Unsupported calibration option ${option}.`);
    const value = arguments_[++index];
    if (!value) throw new Error(`${option} requires a value.`);
    values.set(option, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} requires a value.`);
    return value;
  };
  return {
    candidateCommit: matching(required('--candidate-commit'), COMMIT, 'candidate commit'),
    candidateExecutable: absolute(required('--candidate-executable'), 'candidate executable'),
    candidateExecutableSha256: matching(required('--candidate-executable-sha256'), HASH, 'candidate executable hash'),
    diagnosticsPath: absolute(required('--diagnostics'), 'diagnostics path'),
    preparedRoot: absolute(required('--prepared-root'), 'prepared root'),
  };
}

function blindArm(arm: CalibrationEnvironment['arm']): {readonly label: 'X' | 'Y' | 'Z'; readonly position: 1 | 2 | 3} {
  if (arm === 'anchored') return {label: 'X', position: 1};
  if (arm === 'task-only') return {label: 'Y', position: 2};
  return {label: 'Z', position: 3};
}

function opaqueId(prefix: 'inv' | 'run', input: string): string {
  return `${prefix}_${sha256HexSync(input).slice(0, 32)}`;
}

function diagnosticHash(value: unknown): string {
  return sha256HexSync(`threadnote-code-memory-link-calibration-diagnostic-v1\0${JSON.stringify(value)}`);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  if (canonical !== path || !(await stat(canonical)).isDirectory()) throw new Error(`${label} must be canonical.`);
  return canonical;
}

function joinRoot(root: string, relative: string): string {
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}/`)) throw new Error('Calibration path escapes its root.');
  return path;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function integer(value: unknown, label: string): number {
  const parsed = typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 0) throw new Error(`${label} is invalid.`);
  return Number(parsed);
}

function absolute(value: string, label: string): string {
  if (!value.startsWith('/') || resolve(value) !== value || value.includes('\0')) {
    throw new Error(`${label} must be normalized and absolute.`);
  }
  return value;
}

function isMissing(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
