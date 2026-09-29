#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed MCP proxy owns one bounded pinned Threadnote child process. */

import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile, realpath, stat, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Schema} from 'effect';
import {EffectSchemaSdkTools} from '@threadnote/threadnote/mcp/effect_schema_sdk_tools';

export const MATCHED_EVALUATION_CONTEXT_PACKET_ENV = 'MATCHED_EVALUATION_CONTEXT_PACKET' as const;
export const MATCHED_EVALUATION_CONTEXT_SERVER_NAME = 'matched_evaluation_context' as const;
export const MATCHED_EVALUATION_CONTEXT_PROXY_VERSION = 1 as const;

export interface MatchedEvaluationContextProxyPacketV1 {
  readonly budgetTokens: number;
  readonly detail: 'compact' | 'graph-only' | 'source';
  readonly expectedContext: {
    readonly graphContentHash: string;
    readonly graphSnapshotHash: string;
    readonly linkReceiptsHash: string | null;
    readonly memoryAccess: 'disabled' | 'linked';
    readonly studyHash: string;
    readonly taskContextHash: string | null;
  };
  readonly project: string;
  readonly prompt: string;
  readonly repositoryRoot: string;
  readonly runNonce: string;
  readonly runtimeManifestPath: string;
  readonly runtimeManifestSha256: string;
  readonly threadnoteAccount: string;
  readonly threadnoteExecutable: string;
  readonly threadnoteExecutableSha256: string;
  readonly threadnoteHome: string;
  readonly threadnoteUser: string;
  readonly version: typeof MATCHED_EVALUATION_CONTEXT_PROXY_VERSION;
}

export interface MatchedEvaluationContextProxyRequestV1 {
  readonly budgetTokens?: number;
  readonly callerCwd: string;
  readonly codeRefs?: string | readonly string[];
  readonly mode?: 'brief' | 'explain' | 'impact' | 'locate' | 'trace';
  readonly project?: string;
  readonly task: string;
}

const HASH = /^[0-9a-f]{64}$/u;
const RUN_NONCE = /^run_[0-9a-f]{32}$/u;
const CGS = /^cgs_[0-9a-f]{16,128}$/u;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MODES = ['brief', 'locate', 'explain', 'trace', 'impact'] as const;
const NonEmptyText = Schema.String.check(Schema.isMinLength(1));
const PathOrId = NonEmptyText.check(Schema.isMaxLength(4_096));

export const MATCHED_EVALUATION_CONTEXT_INPUT_SCHEMA = Schema.Struct({
  budgetTokens: Schema.optionalKey(Schema.Int.check(Schema.isBetween({minimum: 800, maximum: 1_500}))),
  callerCwd: PathOrId,
  codeRefs: Schema.optionalKey(Schema.Union([PathOrId, Schema.Array(PathOrId).check(Schema.isMaxLength(8))])),
  mode: Schema.optionalKey(Schema.Literals(MODES)),
  project: Schema.optionalKey(NonEmptyText.check(Schema.isMaxLength(128))),
  task: NonEmptyText.check(Schema.isMaxLength(4_096)),
});

export async function handleMatchedEvaluationContextRequest(
  packetInput: MatchedEvaluationContextProxyPacketV1 | unknown,
  requestInput: MatchedEvaluationContextProxyRequestV1 | unknown,
): Promise<{
  readonly content: readonly [{readonly text: string; readonly type: 'text'}];
  readonly meta: Readonly<Record<string, unknown>>;
  readonly structuredContent: Record<string, unknown>;
}> {
  const packet = parseMatchedEvaluationContextProxyPacketV1(packetInput);
  const request = Schema.decodeUnknownSync(MATCHED_EVALUATION_CONTEXT_INPUT_SCHEMA, {
    onExcessProperty: 'error',
  })(requestInput);
  const callerCwd = await realpath(request.callerCwd);
  if (callerCwd !== packet.repositoryRoot) throw new Error('Context request escaped the isolated repository.');
  const preparedHome = await realpath(packet.threadnoteHome);
  if (!isContained(dirname(packet.repositoryRoot), preparedHome) || isContained(packet.repositoryRoot, preparedHome)) {
    throw new Error('Prepared Threadnote home escaped its isolated private root.');
  }
  if (request.task !== packet.prompt) throw new Error('Context request task differs from the sealed task prompt.');
  if (request.project !== undefined && request.project !== packet.project) {
    throw new Error('Context request project differs from the prepared project.');
  }
  if (request.budgetTokens !== undefined && request.budgetTokens !== packet.budgetTokens) {
    throw new Error('Context request budget differs from the preregistered dose.');
  }
  const requestedRefs =
    request.codeRefs === undefined ? [] : typeof request.codeRefs === 'string' ? [request.codeRefs] : request.codeRefs;
  const codeRefs = requestedRefs.map(reference => validatedCodeRef(reference, packet.repositoryRoot));
  await Promise.all([
    assertPinnedExecutable(packet.threadnoteExecutable, packet.threadnoteExecutableSha256),
    assertRuntimeManifest(packet, preparedHome),
  ]);
  const structuredContent = await runThreadnoteContextBrief(packet, {
    codeRefs,
    mode: request.mode ?? 'brief',
  });
  const answer =
    typeof structuredContent.answer === 'string' && structuredContent.answer.length > 0
      ? structuredContent.answer
      : JSON.stringify(structuredContent);
  return {
    content: [{text: answer, type: 'text'}],
    meta: {
      matchedEvaluation: {
        ...packet.expectedContext,
        graphReady: true,
        runNonce: packet.runNonce,
        runtimeManifestSha256: packet.runtimeManifestSha256,
        version: MATCHED_EVALUATION_CONTEXT_PROXY_VERSION,
      },
    },
    structuredContent,
  };
}

export function parseMatchedEvaluationContextProxyPacketV1(
  value: MatchedEvaluationContextProxyPacketV1 | unknown,
): MatchedEvaluationContextProxyPacketV1 {
  const packet = object(value, 'context proxy packet');
  exactKeys(packet, [
    'budgetTokens',
    'detail',
    'expectedContext',
    'project',
    'prompt',
    'repositoryRoot',
    'runNonce',
    'runtimeManifestPath',
    'runtimeManifestSha256',
    'threadnoteAccount',
    'threadnoteExecutable',
    'threadnoteExecutableSha256',
    'threadnoteHome',
    'threadnoteUser',
    'version',
  ]);
  if (packet.version !== MATCHED_EVALUATION_CONTEXT_PROXY_VERSION) invalid('packet version must be 1');
  const expected = object(packet.expectedContext, 'expected context');
  exactKeys(expected, [
    'graphContentHash',
    'graphSnapshotHash',
    'linkReceiptsHash',
    'memoryAccess',
    'studyHash',
    'taskContextHash',
  ]);
  const memoryAccess = literal(expected.memoryAccess, ['disabled', 'linked'] as const, 'memory access');
  const linkReceiptsHash = nullableHash(expected.linkReceiptsHash, 'link receipts hash');
  const taskContextHash = nullableHash(expected.taskContextHash, 'task context hash');
  if (
    (memoryAccess === 'disabled' && (linkReceiptsHash !== null || taskContextHash !== null)) ||
    (memoryAccess === 'linked' && (linkReceiptsHash === null || taskContextHash === null))
  ) {
    invalid('memory access and prepared receipt fields disagree');
  }
  return {
    budgetTokens: integer(packet.budgetTokens, 800, 1_500, 'context budget'),
    detail: literal(packet.detail, ['compact', 'graph-only', 'source'] as const, 'context detail'),
    expectedContext: {
      graphContentHash: matching(expected.graphContentHash, HASH, 'graph content hash'),
      graphSnapshotHash: matching(expected.graphSnapshotHash, HASH, 'graph snapshot hash'),
      linkReceiptsHash,
      memoryAccess,
      studyHash: matching(expected.studyHash, HASH, 'study hash'),
      taskContextHash,
    },
    project: matching(packet.project, PROJECT, 'project'),
    prompt: boundedText(packet.prompt, 1, 4_096, 'prompt'),
    repositoryRoot: absolutePath(packet.repositoryRoot, 'repository root'),
    runNonce: matching(packet.runNonce, RUN_NONCE, 'run nonce'),
    runtimeManifestPath: absolutePath(packet.runtimeManifestPath, 'runtime manifest'),
    runtimeManifestSha256: matching(packet.runtimeManifestSha256, HASH, 'runtime manifest hash'),
    threadnoteAccount: matching(packet.threadnoteAccount, PROJECT, 'Threadnote account'),
    threadnoteExecutable: absolutePath(packet.threadnoteExecutable, 'Threadnote executable'),
    threadnoteExecutableSha256: matching(packet.threadnoteExecutableSha256, HASH, 'Threadnote executable hash'),
    threadnoteHome: absolutePath(packet.threadnoteHome, 'Threadnote home'),
    threadnoteUser: matching(packet.threadnoteUser, PROJECT, 'Threadnote user'),
    version: MATCHED_EVALUATION_CONTEXT_PROXY_VERSION,
  };
}

export function renderMatchedEvaluationRuntimeManifestV1(
  projectInput: string,
  repositoryRootInput: string,
  runNonceInput: string,
): string {
  const project = matching(projectInput, PROJECT, 'project');
  const repositoryRoot = absolutePath(repositoryRootInput, 'repository root');
  const runNonce = matching(runNonceInput, RUN_NONCE, 'run nonce');
  return `${JSON.stringify({
    matchedEvaluationRun: runNonce,
    projects: [
      {
        name: project,
        path: repositoryRoot,
        seed: [],
        uri: `threadnote://resources/repos/${project}`,
      },
    ],
    version: 1,
  })}\n`;
}

async function runThreadnoteContextBrief(
  packet: MatchedEvaluationContextProxyPacketV1,
  request: {readonly codeRefs: readonly string[]; readonly mode: (typeof MODES)[number]},
): Promise<Record<string, unknown>> {
  const arguments_ = [
    'context',
    'brief',
    '--json',
    '--manifest',
    packet.runtimeManifestPath,
    '--cwd',
    packet.repositoryRoot,
    '--project',
    packet.project,
    '--task',
    packet.prompt,
    '--mode',
    request.mode,
    '--detail',
    packet.detail === 'source' ? 'source' : 'compact',
    '--budget-tokens',
    String(packet.budgetTokens),
    ...request.codeRefs.flatMap(reference => ['--code-ref', reference]),
  ];
  const result = await capture(packet.threadnoteExecutable, arguments_, {
    CI: '1',
    HOME: packet.threadnoteHome,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    PATH: '/usr/bin:/bin',
    THREADNOTE_ACCOUNT: packet.threadnoteAccount,
    THREADNOTE_HOME: packet.threadnoteHome,
    THREADNOTE_NO_SPINNER: '1',
    THREADNOTE_NO_UPDATE_CHECK: '1',
    THREADNOTE_USER: packet.threadnoteUser,
  });
  try {
    return object(JSON.parse(result) as unknown, 'Threadnote Context Brief');
  } catch (cause) {
    throw new Error('Threadnote returned invalid Context Brief JSON.', {cause});
  }
}

async function assertRuntimeManifest(
  packet: MatchedEvaluationContextProxyPacketV1,
  preparedHome: string,
): Promise<void> {
  const canonical = await realpath(packet.runtimeManifestPath);
  const metadata = await stat(canonical);
  const isolatedRoot = dirname(packet.repositoryRoot);
  if (
    canonical !== packet.runtimeManifestPath ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error('Runtime manifest is not one canonical owner-only file.');
  }
  if (
    !isContained(isolatedRoot, canonical) ||
    isContained(packet.repositoryRoot, canonical) ||
    isContained(preparedHome, canonical)
  ) {
    throw new Error('Runtime manifest escaped its isolated private root.');
  }
  const bytes = await readFile(canonical);
  if (createHash('sha256').update(bytes).digest('hex') !== packet.runtimeManifestSha256) {
    throw new Error('Runtime manifest differs from the sealed artifact.');
  }
  const expected = renderMatchedEvaluationRuntimeManifestV1(packet.project, packet.repositoryRoot, packet.runNonce);
  if (!bytes.equals(Buffer.from(expected))) {
    throw new Error('Runtime manifest does not bind the isolated repository and run.');
  }
}

async function capture(
  executable: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...arguments_], {env: {...environment}, stdio: ['ignore', 'pipe', 'pipe']});
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', value => {
      const chunk = Buffer.from(value);
      stdoutBytes += chunk.length;
      if (stdoutBytes > 2 * 1_024 * 1_024) child.kill('SIGKILL');
      else stdout.push(chunk);
    });
    child.stderr.on('data', value => {
      const chunk = Buffer.from(value);
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1_024) stderr.push(chunk);
    });
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Threadnote Context Brief failed: ${Buffer.concat(stderr).toString('utf8')}`));
      else resolvePromise(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

async function assertPinnedExecutable(path: string, expectedHash: string): Promise<void> {
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (canonical !== path || !metadata.isFile()) throw new Error('Threadnote executable is not one canonical file.');
  const digest = createHash('sha256')
    .update(await readFile(canonical))
    .digest('hex');
  if (digest !== expectedHash) throw new Error('Threadnote executable differs from the pinned artifact.');
}

function validatedCodeRef(value: string, root: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  if (CGS.test(normalized)) return normalized;
  if (!normalized || normalized.includes('\0') || isAbsolute(normalized)) invalid('code reference is invalid');
  const absolute = resolve(root, normalized);
  const fromRoot = relative(root, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    invalid('code reference escaped the repository');
  }
  return normalized;
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
}

export async function runMatchedEvaluationContextProxy(): Promise<void> {
  const packetPath = process.env[MATCHED_EVALUATION_CONTEXT_PACKET_ENV];
  if (!packetPath || !isAbsolute(packetPath)) throw new Error('Missing matched evaluation context packet.');
  const packet = parseMatchedEvaluationContextProxyPacketV1(JSON.parse(await readFile(packetPath, 'utf8')) as unknown);
  await unlink(packetPath);
  const server = new McpServer(
    {name: MATCHED_EVALUATION_CONTEXT_SERVER_NAME, version: String(MATCHED_EVALUATION_CONTEXT_PROXY_VERSION)},
    {capabilities: {tools: {listChanged: false}}},
  );
  const tools = new EffectSchemaSdkTools();
  tools.register(
    'context_brief',
    {
      annotations: {destructiveHint: false, idempotentHint: true, readOnlyHint: true},
      description: 'Read the preregistered Threadnote graph and linked-memory context for this evaluation task.',
      inputSchema: MATCHED_EVALUATION_CONTEXT_INPUT_SCHEMA,
    },
    async request => {
      const result = await handleMatchedEvaluationContextRequest(packet, request);
      return {content: [...result.content], _meta: result.meta, structuredContent: result.structuredContent};
    },
  );
  tools.install(server);
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, {maxBufferSize: 2 * 1_024 * 1_024}));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid('object has unsupported or missing fields');
  }
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : matching(value, HASH, label);
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) {
    invalid(`${label} must be a normalized absolute path`);
  }
  return value;
}

function boundedText(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid matched evaluation context proxy: ${message}.`);
}

if (import.meta.main) await runMatchedEvaluationContextProxy();
