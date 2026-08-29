#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed MCP proxy owns one bounded candidate child-process boundary. */

import {createHash} from 'node:crypto';
import {readFile, realpath, stat, unlink} from 'node:fs/promises';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {spawn} from 'node:child_process';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import {
  CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1,
  canonicalizeCodeMemoryLinkContextBriefResultV1,
  codeMemoryLinkContextBriefProxyDecisionHashV1,
  codeMemoryLinkContextBriefRawRequestHashV1,
  codeMemoryLinkContextBriefResponseReceiptHashV1,
  parseCodeMemoryLinkArmPacketV1,
  parseCodeMemoryLinkTaskPacketV1,
  projectCodeMemoryLinkContextBriefRequestV1,
  type CodeMemoryLinkContextBriefProxyReceiptV1,
  type CodeMemoryLinkArmPacketV1,
  type CodeMemoryLinkTaskPacketV1,
} from '../src/evaluation/code-memory-link-agent-protocol.js';
import {
  CODE_MEMORY_LINK_PROXY_CAPABILITY_ENV,
  CODE_MEMORY_LINK_PROXY_SERVER_NAME,
} from './code-memory-link-codex-isolation.js';

export const CODE_MEMORY_LINK_CONTEXT_PROXY_VERSION = 1 as const;
export const CODE_MEMORY_LINK_CONTEXT_PROXY_ARMS = ['anchored', 'task-only', 'no-memory'] as const;
export type CodeMemoryLinkContextProxyArm = (typeof CODE_MEMORY_LINK_CONTEXT_PROXY_ARMS)[number];

export interface CodeMemoryLinkContextProxyPacketV1 {
  readonly account: string;
  readonly agentId: string;
  readonly armPacket: CodeMemoryLinkArmPacketV1;
  readonly candidateExecutable: string;
  readonly candidateExecutableSha256: string;
  readonly callerCwd: string;
  readonly project: string;
  readonly runBindingHash: string;
  readonly safeExecutablePath: string;
  readonly taskPacket: CodeMemoryLinkTaskPacketV1;
  readonly threadnoteHome: string;
  readonly user: string;
  readonly version: typeof CODE_MEMORY_LINK_CONTEXT_PROXY_VERSION;
}

export interface CodeMemoryLinkContextBriefProxyRequestV1 {
  readonly budgetTokens?: number;
  readonly callerCwd: string;
  readonly codeRefs?: string | readonly string[];
  readonly mode?: 'brief' | 'locate' | 'explain' | 'trace' | 'impact';
  readonly project?: string;
  readonly task: string;
  readonly workset?: string;
}

export interface CodeMemoryLinkContextProxyCandidateResult {
  readonly content?: readonly {readonly text: string; readonly type: 'text'}[];
  readonly structuredContent: Record<string, unknown>;
  readonly text: string;
  readonly proxyReceipt?: CodeMemoryLinkContextBriefProxyReceiptV1;
}

export type CodeMemoryLinkContextProxyCandidateRunner = (
  packet: CodeMemoryLinkContextProxyPacketV1,
  request: Required<Pick<CodeMemoryLinkContextBriefProxyRequestV1, 'budgetTokens' | 'callerCwd' | 'task'>> & {
    readonly codeRefs: readonly string[];
    readonly mode: NonNullable<CodeMemoryLinkContextBriefProxyRequestV1['mode']>;
    readonly project: string;
  },
) => Promise<CodeMemoryLinkContextProxyCandidateResult>;

const HASH = /^[0-9a-f]{64}$/u;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CGS = /^cgs_[0-9a-f]{16,128}$/u;
const MODES = ['brief', 'locate', 'explain', 'trace', 'impact'] as const;

export const CODE_MEMORY_LINK_CONTEXT_BRIEF_INPUT_SCHEMA = z
  .object({
    budgetTokens: z.number().int().min(1).max(1_500).optional(),
    callerCwd: z.string().min(1).max(4_096),
    codeRefs: z.union([z.string().min(1).max(4_096), z.array(z.string().min(1).max(4_096)).max(8)]).optional(),
    mode: z.enum(MODES).optional(),
    project: z.string().min(1).max(128).optional(),
    task: z.string().min(1).max(8_192),
    workset: z.string().min(1).max(128).optional(),
  })
  .strict();

export async function handleCodeMemoryLinkContextBriefRequest(
  packetInput: CodeMemoryLinkContextProxyPacketV1 | unknown,
  requestInput: CodeMemoryLinkContextBriefProxyRequestV1 | unknown,
  runCandidate: CodeMemoryLinkContextProxyCandidateRunner = runCodeMemoryLinkContextBriefCandidate,
): Promise<CodeMemoryLinkContextProxyCandidateResult> {
  const packet = parseCodeMemoryLinkContextProxyPacketV1(packetInput);
  const request = CODE_MEMORY_LINK_CONTEXT_BRIEF_INPUT_SCHEMA.parse(requestInput);
  const callerCwd = await realpath(request.callerCwd);
  if (callerCwd !== packet.callerCwd) throw new Error('context_brief callerCwd is outside the isolated fixture.');
  if (request.task !== packet.taskPacket.prompt)
    throw new Error('context_brief task does not match the sealed task packet.');
  if (request.workset !== undefined) throw new Error('context_brief Worksets are unavailable in this evaluation.');
  if (request.project !== undefined && request.project !== packet.project) {
    throw new Error('context_brief project does not match the sealed fixture.');
  }
  const maximumBudgetTokens = Math.min(1_250, packet.taskPacket.budget.tokens);
  if (request.budgetTokens !== undefined && request.budgetTokens !== maximumBudgetTokens) {
    throw new Error('context_brief request must use the exact preregistered token dose.');
  }
  const budgetTokens = maximumBudgetTokens;
  const requestedCodeRefs =
    request.codeRefs === undefined ? [] : typeof request.codeRefs === 'string' ? [request.codeRefs] : request.codeRefs;
  const codeRefs = requestedCodeRefs.map(reference => validatedCodeRef(reference, packet.callerCwd));
  const normalized = {
    budgetTokens,
    callerCwd: packet.callerCwd,
    codeRefs,
    mode: request.mode ?? 'brief',
    project: packet.project,
    task: packet.taskPacket.prompt,
  } as const;
  const decision = projectCodeMemoryLinkContextBriefRequestV1({
    armPacket: packet.armPacket,
    request: normalized,
    taskPacket: packet.taskPacket,
  });
  const result =
    decision.action === 'return-empty'
      ? canonicalEmptyContextBrief()
      : await runCandidate(packet, candidateRequest(decision.request));
  const canonical = canonicalizeCodeMemoryLinkContextBriefResultV1(result.structuredContent);
  return {
    ...result,
    proxyReceipt: {
      armPacketHash: packet.armPacket.armPacketHash,
      proxyDecisionHash: codeMemoryLinkContextBriefProxyDecisionHashV1(decision),
      rawRequestHash: codeMemoryLinkContextBriefRawRequestHashV1(normalized),
      responseHash: codeMemoryLinkContextBriefResponseReceiptHashV1(canonical.receipt),
      runBindingHash: packet.runBindingHash,
      version: 1,
    },
  };
}

export async function runCodeMemoryLinkContextBriefCandidate(
  packet: CodeMemoryLinkContextProxyPacketV1,
  request: Parameters<CodeMemoryLinkContextProxyCandidateRunner>[1],
): Promise<CodeMemoryLinkContextProxyCandidateResult> {
  await assertCandidateExecutable(packet);
  const args = [
    'context',
    'brief',
    '--json',
    '--task',
    request.task,
    '--cwd',
    request.callerCwd,
    '--project',
    request.project,
    '--mode',
    request.mode,
    '--budget-tokens',
    String(request.budgetTokens),
    ...request.codeRefs.flatMap(reference => ['--code-ref', reference]),
  ];
  const result = await captureCandidate(packet.candidateExecutable, args, {
    CI: '1',
    HOME: packet.threadnoteHome,
    NO_COLOR: '1',
    NO_UPDATE_NOTIFIER: '1',
    PATH: packet.safeExecutablePath,
    THREADNOTE_ACCOUNT: packet.account,
    THREADNOTE_AGENT_ID: packet.agentId,
    THREADNOTE_HOME: packet.threadnoteHome,
    THREADNOTE_NO_SPINNER: '1',
    THREADNOTE_NO_UPDATE_CHECK: '1',
    THREADNOTE_USER: packet.user,
  });
  let structuredContent: Record<string, unknown>;
  try {
    structuredContent = object(JSON.parse(result.stdout) as unknown, 'candidate Context Brief');
  } catch (cause) {
    throw new Error('Candidate Threadnote returned invalid Context Brief JSON.', {cause});
  }
  const canonical = canonicalizeCodeMemoryLinkContextBriefResultV1(structuredContent);
  if (canonical.receipt.responseClass === 'empty-v1') {
    throw new Error('Forwarded candidate unexpectedly returned the reserved no-memory response.');
  }
  return {
    content: canonical.content,
    structuredContent: canonical.structuredContent,
    text: canonical.content[0]!.text,
  };
}

export function parseCodeMemoryLinkContextProxyPacketV1(value: unknown): CodeMemoryLinkContextProxyPacketV1 {
  const packet = object(value, 'proxy packet');
  exactKeys(packet, [
    'account',
    'agentId',
    'armPacket',
    'candidateExecutable',
    'candidateExecutableSha256',
    'callerCwd',
    'project',
    'runBindingHash',
    'safeExecutablePath',
    'taskPacket',
    'threadnoteHome',
    'user',
    'version',
  ]);
  if (packet.version !== CODE_MEMORY_LINK_CONTEXT_PROXY_VERSION) invalid('version must be 1');
  const armPacket = parseCodeMemoryLinkArmPacketV1(packet.armPacket);
  const taskPacket = parseCodeMemoryLinkTaskPacketV1(packet.taskPacket);
  projectCodeMemoryLinkContextBriefRequestV1({armPacket, request: {task: taskPacket.prompt}, taskPacket});
  return {
    account: portable(packet.account, 'account'),
    agentId: portable(packet.agentId, 'agentId'),
    armPacket,
    candidateExecutable: absolutePath(packet.candidateExecutable, 'candidateExecutable'),
    candidateExecutableSha256: matchingText(packet.candidateExecutableSha256, HASH, 'candidate executable hash'),
    callerCwd: absolutePath(packet.callerCwd, 'callerCwd'),
    project: portable(packet.project, 'project'),
    runBindingHash: matchingText(packet.runBindingHash, HASH, 'run binding hash'),
    safeExecutablePath: nonEmptyText(packet.safeExecutablePath, 'safeExecutablePath', 16_384),
    taskPacket,
    threadnoteHome: absolutePath(packet.threadnoteHome, 'threadnoteHome'),
    user: portable(packet.user, 'user'),
    version: CODE_MEMORY_LINK_CONTEXT_PROXY_VERSION,
  };
}

export function canonicalEmptyContextBrief(): CodeMemoryLinkContextProxyCandidateResult {
  const canonical = canonicalizeCodeMemoryLinkContextBriefResultV1(
    CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1.structuredContent,
  );
  return {
    content: canonical.content,
    structuredContent: canonical.structuredContent,
    text: 'Context Brief: no relevant context available.',
  };
}

async function main(): Promise<void> {
  const packetPath = process.env[CODE_MEMORY_LINK_PROXY_CAPABILITY_ENV];
  if (!packetPath || !isAbsolute(packetPath)) throw new Error('Missing proxy capability packet.');
  const packet = parseCodeMemoryLinkContextProxyPacketV1(JSON.parse(await readFile(packetPath, 'utf8')) as unknown);
  await unlink(packetPath);
  const server = new McpServer(
    {name: CODE_MEMORY_LINK_PROXY_SERVER_NAME, version: String(CODE_MEMORY_LINK_CONTEXT_PROXY_VERSION)},
    {capabilities: {tools: {listChanged: false}}},
  );
  server.registerTool(
    'context_brief',
    {
      annotations: {destructiveHint: false, idempotentHint: true, readOnlyHint: true},
      description:
        'Compile bounded ready graph evidence, decisions, and handoffs for the current repository. Optional codeRefs may identify up to eight local files or cgs_ symbols.',
      inputSchema: CODE_MEMORY_LINK_CONTEXT_BRIEF_INPUT_SCHEMA,
    },
    async request => {
      const result = await handleCodeMemoryLinkContextBriefRequest(packet, request);
      return {
        content: [...(result.content ?? [{text: result.text, type: 'text' as const}])],
        _meta: {codeMemoryLink: result.proxyReceipt},
        structuredContent: result.structuredContent,
      };
    },
  );
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, {maxBufferSize: 256 * 1024}));
}

async function assertCandidateExecutable(packet: CodeMemoryLinkContextProxyPacketV1): Promise<void> {
  await assertExactFile(
    packet.candidateExecutable,
    packet.candidateExecutableSha256,
    'candidate Threadnote executable',
  );
}

async function assertExactFile(path: string, expectedSha256: string, label: string): Promise<void> {
  const canonical = await realpath(path);
  if (canonical !== path || !(await stat(canonical)).isFile()) {
    throw new Error(`${label} is not one canonical regular file.`);
  }
  const digest = createHash('sha256')
    .update(await readFile(canonical))
    .digest('hex');
  if (digest !== expectedSha256) throw new Error(`${label} hash changed.`);
}

async function captureCandidate(
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<{readonly stdout: string}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {env: {...environment}, stdio: ['ignore', 'pipe', 'pipe']});
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', value => {
      const chunk = Buffer.from(value);
      stdoutBytes += chunk.length;
      if (stdoutBytes > 256 * 1024) child.kill('SIGKILL');
      else stdout.push(chunk);
    });
    child.stderr.on('data', value => {
      const chunk = Buffer.from(value);
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error('Candidate Threadnote Context Brief invocation failed.'));
      else resolvePromise({stdout: Buffer.concat(stdout).toString('utf8')});
    });
  });
}

function validatedCodeRef(value: string, callerCwd: string): string {
  const reference = value.trim();
  if (CGS.test(reference)) return reference;
  const normalizedReference = reference.replaceAll('\\', '/');
  if (!normalizedReference || normalizedReference.includes('\0') || isAbsolute(normalizedReference))
    throw new Error('codeRefs must be repo-relative or cgs_.');
  const resolved = resolve(callerCwd, normalizedReference);
  const relativeToFixture = relative(callerCwd, resolved);
  if (relativeToFixture === '..' || relativeToFixture.startsWith(`..${sep}`) || isAbsolute(relativeToFixture)) {
    throw new Error('codeRef escaped the fixture repo.');
  }
  return normalizedReference;
}

function candidateRequest(
  value: Readonly<Record<string, unknown>>,
): Parameters<CodeMemoryLinkContextProxyCandidateRunner>[1] {
  const codeRefs = value.codeRefs;
  if (codeRefs !== undefined && (!Array.isArray(codeRefs) || codeRefs.some(entry => typeof entry !== 'string'))) {
    throw new Error('Projected Context Brief codeRefs are invalid.');
  }
  return {
    budgetTokens: integer(value.budgetTokens, 'projected budgetTokens', 1, 1_500),
    callerCwd: nonEmptyText(value.callerCwd, 'projected callerCwd', 4_096),
    codeRefs: (codeRefs ?? []) as readonly string[],
    mode: oneOf(value.mode, MODES, 'projected mode'),
    project: portable(value.project, 'projected project'),
    task: nonEmptyText(value.task, 'projected task', 8_192),
  };
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) {
    invalid(`${label} must be a normalized absolute path`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid('object has unsupported or missing fields');
  }
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${label} is out of range`);
  }
  return value as number;
}

function matchingText(value: unknown, pattern: RegExp, label: string): string {
  const parsed = nonEmptyText(value, label, 16_384);
  if (!pattern.test(parsed)) invalid(`${label} is invalid`);
  return parsed;
}

function nonEmptyText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > maximum) {
    invalid(`${label} must be bounded non-empty text`);
  }
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(`${label} is invalid`);
  return value as T;
}

function portable(value: unknown, label: string): string {
  return matchingText(value, PORTABLE, label);
}

function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link context proxy input: ${message}.`);
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(
      `Code Memory Link context proxy failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
