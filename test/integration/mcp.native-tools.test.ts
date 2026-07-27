import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {describe, expect, it} from 'vitest';

interface TextContent {
  readonly text: string;
  readonly type: 'text';
}

const CORE_TOOL_NAMES = [
  'recall_context',
  'read_context',
  'list_context',
  'remember_context',
  'review_session_context',
  'apply_memory_candidates',
  'threadnote_guide',
  'share_publish',
];

const ADVANCED_TOOL_NAMES = [
  'search',
  'read',
  'list',
  'store',
  'archive',
  'archive_context',
  'compact_context',
  'recall_feedback',
  'forget',
  'add_resource',
  'grep',
  'glob',
  'health',
  'share_conflicts',
  'share_conflict_show',
  'share_conflict_resolve',
  'share_skill',
  'share_bundle',
  'list_shared_skills',
  'install_shared_skill',
];

async function withMcpClient<T>(
  fn: (client: Client, fixture: {readonly home: string; readonly root: string}) => Promise<T>,
  options: {readonly toolset?: 'core' | 'full' | null} = {},
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-mcp-native-'));
  const home = join(root, 'home');
  await mkdir(home, {recursive: true});
  const repoRoot = process.cwd();
  const environment = {
    ...process.env,
    THREADNOTE_ACCOUNT: 'local',
    THREADNOTE_AGENT_ID: 'threadnote',
    THREADNOTE_HOME: home,
    THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
    THREADNOTE_USER: 'test-user',
  } as Record<string, string>;
  if (options.toolset === null) {
    delete environment.THREADNOTE_MCP_TOOLSET;
  } else {
    environment.THREADNOTE_MCP_TOOLSET = options.toolset ?? 'full';
  }
  const transport = new StdioClientTransport({
    args: [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(repoRoot, 'src', 'mcp_server.ts')],
    command: process.execPath,
    cwd: repoRoot,
    env: environment,
    stderr: 'pipe',
  });
  const client = new Client({name: 'threadnote-test', version: '0.0.0'});
  try {
    await client.connect(transport);
    return await fn(client, {home, root});
  } finally {
    await client.close().catch(() => undefined);
    await rm(root, {force: true, recursive: true});
  }
}

describe('Threadnote MCP toolsets', () => {
  it('keeps the core server instructions compact and self-contained', async () => {
    await withMcpClient(
      async client => {
        const instructions = client.getInstructions() ?? '';
        expect(Buffer.byteLength(instructions)).toBeLessThanOrEqual(512);
        expect(instructions).toContain('callerCwd');
        expect(instructions).toContain('threadnote://');
        expect(instructions).toContain('durable');
        expect(instructions).toContain('handoff');
        expect(instructions).toContain('directly');
        expect(instructions).toContain('additional candidates');
        expect(instructions).toContain('Do not store');
        const reviewTool = (await client.listTools()).tools.find(tool => tool.name === 'review_session_context');
        expect(reviewTool?.description).toContain('After routine durable and handoff writes');
        expect(reviewTool?.description).toContain('additional reviewable');
      },
      {toolset: 'core'},
    );
  });

  it('advertises only the core tools by default', async () => {
    await withMcpClient(
      async client => {
        const tools = await client.listTools();
        expect(tools.tools.map(tool => tool.name)).toEqual(CORE_TOOL_NAMES);
        expect(Buffer.byteLength(JSON.stringify(tools.tools))).toBeLessThanOrEqual(12_000);
      },
      {toolset: null},
    );
  });

  it('emits and enforces Effect Schema inputs over stdio', async () => {
    await withMcpClient(
      async client => {
        const tools = await client.listTools();
        const recall = tools.tools.find(tool => tool.name === 'recall_context');
        expect(recall?.inputSchema).toMatchObject({
          additionalProperties: false,
          properties: {
            callerCwd: {type: 'string'},
            nodeLimit: {maximum: 100, minimum: 1, type: 'integer'},
            query: {type: 'string'},
            threshold: {maximum: 1, minimum: 0, type: 'number'},
          },
          type: 'object',
        });
        expect(JSON.stringify(recall?.inputSchema)).not.toContain('null');

        const validationError = await callErrorText(client, 'recall_context', {
          nodeLimit: 0,
          query: 'threadnote',
        });
        expect(validationError).toContain('greater than or equal to 1');
      },
      {toolset: 'core'},
    );
  });

  it('returns hybrid recall confidence and ranking explanations as structured content', async () => {
    await withMcpClient(
      async client => {
        const result = await client.callTool(
          {arguments: {query: 'threadnote recall ranking'}, name: 'recall_context'},
          undefined,
          {timeout: 5000},
        );

        expect(result.structuredContent).toMatchObject({
          confidence: {
            level: expect.stringMatching(/^(?:high|medium|low|no_answer)$/),
          },
          rankerVersion: 'hybrid-v2',
          results: expect.any(Array),
        });
      },
      {toolset: 'core'},
    );
  });

  it('reviews task-closeout candidates and records a deferred decision without writing memory', async () => {
    await withMcpClient(
      async client => {
        const review = await callText(client, 'review_session_context', {
          decisions: ['Keep candidate review inside the agent session.'],
          evidence: ['docs/recall-and-memory-formation-plan.md'],
          outcome: 'Added task-closeout candidate review.',
          project: 'threadnote',
          sourceAgentClient: 'codex',
          sourceSessionId: 'session-test',
          task: 'Implement candidate memory workflow',
          topic: 'candidate-memory',
        });
        const reviewId = /Review (review-[a-f0-9]+)/.exec(review)?.[1];
        const candidateId = /candidate: (review-[a-f0-9]+-1)/.exec(review)?.[1];
        expect(review).toContain('Do not write these additional candidates until the user decides');
        expect(reviewId).toBeDefined();
        expect(candidateId).toBeDefined();

        const deferred = await callText(client, 'apply_memory_candidates', {
          action: 'defer',
          candidateId,
          reviewId,
          revision: 1,
        });

        expect(deferred).toContain(`Deferred candidate ${candidateId}`);
      },
      {toolset: 'core'},
    );
  });

  it('writes an approved candidate only with explicit approval and the current revision', async () => {
    await withMcpClient(
      async client => {
        const review = await callText(client, 'review_session_context', {
          decisions: ['Use a stable candidate review identifier.'],
          evidence: ['test/integration/mcp.native-tools.test.ts'],
          outcome: 'Implemented candidate audit records.',
          project: 'threadnote',
          sourceAgentClient: 'codex',
          task: 'Implement approved memory candidates',
          topic: 'approved-candidates',
        });
        const reviewId = /Review (review-[a-f0-9]+)/.exec(review)?.[1];
        const candidateId = /candidate: (review-[a-f0-9]+-1)/.exec(review)?.[1];

        await expect(
          callErrorText(client, 'apply_memory_candidates', {
            action: 'approve',
            candidateId,
            reviewId,
            revision: 1,
          }),
        ).resolves.toContain('approved=true');

        const applied = await callText(client, 'apply_memory_candidates', {
          action: 'approve',
          approved: true,
          candidateId,
          reviewId,
          revision: 1,
        });

        expect(applied).toContain(
          'Stored memory: threadnote://user/test-user/memories/durable/projects/threadnote/approved-candidates.md',
        );
      },
      {toolset: 'core'},
    );
  });

  it('records an applying-state content mismatch as a recoverable conflict', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const topic = 'candidate-recovery-conflict';
        const reviewText = await callText(client, 'review_session_context', {
          decisions: ['Persist the exact approved candidate payload hash.'],
          evidence: ['test/integration/mcp.native-tools.test.ts'],
          outcome: 'Prepared deterministic applying-state recovery.',
          project: 'threadnote',
          sourceAgentClient: 'codex',
          task: 'Recover interrupted candidate approval',
          topic,
        });
        const reviewId = /Review (review-[a-f0-9]+)/.exec(reviewText)?.[1];
        const candidateId = /candidate: (review-[a-f0-9]+-1)/.exec(reviewText)?.[1];
        expect(reviewId).toBeDefined();
        expect(candidateId).toBeDefined();
        const reviewPath = join(fixture.home, 'threadnote', 'candidates', 'v1', 'reviews', `${reviewId}.json`);
        const review = JSON.parse(await readFile(reviewPath, 'utf8')) as {
          candidates: Array<Record<string, unknown>>;
        };
        const destinationUri = `threadnote://user/test-user/memories/durable/projects/threadnote/${topic}.md`;
        review.candidates[0] = {
          ...review.candidates[0],
          applyApprovedAt: '2026-07-23T10:00:00.000Z',
          applyContentHash: '0'.repeat(64),
          applyOperation: 'create',
          applyStage: 'prepared',
          applyTargetUri: destinationUri,
          state: 'applying',
        };
        await writeFile(reviewPath, `${JSON.stringify(review, undefined, 2)}\n`, 'utf8');
        const destinationPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'durable',
          'projects',
          'threadnote',
          `${topic}.md`,
        );
        await mkdir(join(destinationPath, '..'), {recursive: true});
        await writeFile(
          destinationPath,
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            'project: threadnote',
            `topic: ${topic}`,
            'source_agent_client: codex',
            `candidate_id: ${candidateId}`,
            'timestamp: 2026-07-23T10:00:00.000Z',
            '',
            'Different content than the approved payload.',
          ].join('\n'),
          'utf8',
        );

        await expect(
          callErrorText(client, 'apply_memory_candidates', {
            action: 'approve',
            approved: true,
            candidateId,
            reviewId,
            revision: 1,
          }),
        ).resolves.toContain('mismatched content');
        const conflicted = JSON.parse(await readFile(reviewPath, 'utf8')) as {
          candidates: Array<{state?: string}>;
        };
        expect(conflicted.candidates[0]?.state).toBe('conflict');
      },
      {toolset: 'core'},
    );
  });

  it('allows a reviewed shared-memory conflict to create a personal candidate', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const topic = 'shared-candidate-personal-copy';
        const sharedPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'shared',
          'team',
          'durable',
          'projects',
          'threadnote',
          `${topic}.md`,
        );
        await mkdir(join(sharedPath, '..'), {recursive: true});
        await writeFile(
          sharedPath,
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            'project: threadnote',
            `topic: ${topic}`,
            'source_agent_client: teammate',
            'timestamp: 2026-07-22T00:00:00.000Z',
            '',
            'Use the old shared candidate policy.',
          ].join('\n'),
          'utf8',
        );
        const review = await callText(client, 'review_session_context', {
          decisions: ['Use the new reviewed candidate policy.'],
          evidence: ['test/integration/mcp.native-tools.test.ts'],
          outcome: 'Reviewed a changed shared memory.',
          project: 'threadnote',
          sourceAgentClient: 'codex',
          task: 'Create a personal candidate from shared conflict',
          topic,
        });
        const reviewId = /Review (review-[a-f0-9]+)/.exec(review)?.[1];
        const candidateId = /candidate: (review-[a-f0-9]+-1)/.exec(review)?.[1];
        expect(review).toContain('[replace]');
        expect(review).toContain('/memories/shared/team/');

        const applied = await callText(client, 'apply_memory_candidates', {
          action: 'approve',
          approved: true,
          candidateId,
          operation: 'create',
          reviewId,
          revision: 1,
        });

        expect(applied).toContain(
          `Stored memory: threadnote://user/test-user/memories/durable/projects/threadnote/${topic}.md`,
        );
      },
      {toolset: 'core'},
    );
  });

  it('requires evidence before proposing durable candidates', async () => {
    await withMcpClient(
      async client => {
        await expect(
          callErrorText(client, 'review_session_context', {
            decisions: ['This unsupported claim must not become durable memory.'],
            outcome: 'Attempted an unsupported closeout.',
            project: 'threadnote',
            sourceAgentClient: 'codex',
            task: 'Check evidence enforcement',
            topic: 'evidence-enforcement',
          }),
        ).resolves.toContain('requires at least one evidence pointer');
      },
      {toolset: 'core'},
    );
  });

  it('advertises the complete toolset when requested', async () => {
    await withMcpClient(
      async client => {
        const tools = await client.listTools();
        const names = tools.tools.map(tool => tool.name);
        expect(names).toHaveLength(CORE_TOOL_NAMES.length + ADVANCED_TOOL_NAMES.length);
        expect(names).toEqual(expect.arrayContaining([...CORE_TOOL_NAMES, ...ADVANCED_TOOL_NAMES]));
      },
      {toolset: 'full'},
    );
  });

  it('imports distinct portable filenames without collisions', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const importRoot = join(fixture.root, 'imports');
        await mkdir(importRoot, {recursive: true});
        await writeFile(join(importRoot, 'a b.txt'), 'alpha-42 immediate recall anchor', 'utf8');
        await writeFile(join(importRoot, 'a+b.txt'), 'beta-99 distinct portable filename', 'utf8');

        await client.callTool({arguments: {query: 'alpha-42'}, name: 'recall_context'}, undefined, {timeout: 5000});
        const imported = await client.callTool(
          {
            arguments: {path: importRoot, to: 'threadnote://resources/import-collision-test'},
            name: 'add_resource',
          },
          undefined,
          {timeout: 5000},
        );
        expect(imported.isError).not.toBe(true);
        expect(imported.structuredContent).toMatchObject({
          imported: expect.arrayContaining([
            'threadnote://resources/import-collision-test/a%20b.txt',
            'threadnote://resources/import-collision-test/a%2Bb.txt',
          ]),
        });

        await callText(client, 'recall_context', {
          pinnedUri: 'threadnote://resources/import-collision-test',
          query: 'alpha-42',
        });
      },
      {toolset: 'full'},
    );
  });
});

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({arguments: args, name}, undefined, {timeout: 5000});
  expect(Array.isArray(result.content)).toBe(true);
  const text = (result.content as TextContent[]).map(item => item.text).join('\n');
  expect(result.isError, text).not.toBe(true);
  return text;
}

async function callErrorText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({arguments: args, name}, undefined, {timeout: 5000});
  expect(Array.isArray(result.content)).toBe(true);
  const text = (result.content as TextContent[]).map(item => item.text).join('\n');
  expect(result.isError, text).toBe(true);
  return text;
}
