import {TestError} from '../helpers/test-error.js';
import {createHash} from '../helpers/node-crypto.js';
import {existsSync} from '../helpers/node-fs.js';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from '../helpers/node-fs-promises.js';
import {execFileSync} from '../helpers/node-child-process.js';
import {tmpdir} from '../helpers/node-os.js';
import {basename, join} from '../helpers/node-path.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {describe, expect, it} from 'vitest';
import {renderSessionStartRecallQueue} from '../../src/hooks.js';
import {
  createMemoryCodeCitation,
  MAX_MEMORY_CODE_CITATIONS,
  MEMORY_SCHEMA_VERSION,
} from '../../src/memory/code_citation.js';
import {
  formatMemoryDocument,
  MAX_MEMORY_RELATIONS,
  MEMORY_RELATION_TYPES,
  parseMemoryDocument,
} from '../../src/memory/document.js';
import {memoryIdentityAlias} from '../../src/memory/identity_alias.js';
import {isDeferredCodeAnchorIntentFilename} from '../../src/memory/deferred_code_anchor.js';
import {recallIndexDatabaseFilename} from '../../src/recall/index.js';
import {
  parseContextBriefAgentViewText,
  parseContextBriefV1,
  projectContextBriefAgentView,
} from '../../src/context_brief/projector.js';

interface TextContent {
  readonly text: string;
  readonly type: 'text';
}

interface ThreadnoteProgress {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly message?: string;
  readonly progress: number;
  readonly total?: number;
}

interface ReadPageStructuredContent {
  readonly budgetTokens: number;
  readonly canonicalUri?: string;
  readonly complete: boolean;
  readonly content: string;
  readonly cursor?: string;
  readonly estimatedTokens: number;
  readonly resource: number;
  readonly resourceCount: number;
  readonly requestedUri?: string;
  readonly type: 'threadnote-read-page';
}

const MCP_RESOURCE_READ_MAX_BYTES = 4_500;

async function listDeferredCodeAnchorIntentRelativePaths(root: string): Promise<readonly string[]> {
  const names = await readdir(root, {recursive: true});
  return names.filter(name => isDeferredCodeAnchorIntentFilename(basename(name))).sort();
}

const RECALL_PROGRESS_PHASES = [
  'recall.shared-sync',
  'recall.obsidian-sync',
  'recall.workspace-context',
  'recall.semantic-retrieval',
  'recall.lexical-ranking',
] as const;

const CORE_TOOL_NAMES = [
  'recall_context',
  'inspect_code_graph',
  'analyze_code_graph',
  'context_brief',
  'read_context',
  'list_context',
  'remember_context',
  'review_session_context',
  'apply_memory_candidates',
  'obsidian_publish',
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
  'finalize_code_refs',
];

interface McpFixture {
  readonly home: string;
  readonly root: string;
}

interface McpClientOptions {
  readonly environment?: Readonly<Record<string, string>>;
  readonly maxBufferSize?: number;
  readonly toolset?: 'core' | 'full' | null;
}

async function withMcpClient<T>(
  fn: (client: Client, fixture: McpFixture) => Promise<T>,
  options: McpClientOptions = {},
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-mcp-native-'));
  const home = join(root, 'home');
  await mkdir(home, {recursive: true});
  const fixture = {home, root};
  try {
    return await withMcpClientForFixture(fixture, fn, options);
  } finally {
    await rm(root, {force: true, recursive: true});
  }
}

async function withMcpClientForFixture<T>(
  fixture: McpFixture,
  fn: (client: Client, fixture: McpFixture) => Promise<T>,
  options: McpClientOptions = {},
): Promise<T> {
  const client = await connectMcpClient(fixture, options);
  try {
    return await fn(client, fixture);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function connectMcpClient(fixture: McpFixture, options: McpClientOptions = {}): Promise<Client> {
  const repoRoot = process.cwd();
  const environment = {
    ...process.env,
    ...options.environment,
    THREADNOTE_ACCOUNT: 'local',
    THREADNOTE_AGENT_ID: 'threadnote',
    THREADNOTE_HOME: fixture.home,
    THREADNOTE_MANIFEST: join(fixture.home, 'seed-manifest.yaml'),
    THREADNOTE_USER: 'test-user',
  } as Record<string, string>;
  if (options.toolset === null) {
    delete environment.THREADNOTE_MCP_TOOLSET;
  } else {
    environment.THREADNOTE_MCP_TOOLSET = options.toolset ?? 'full';
  }
  const transport = new StdioClientTransport({
    args: [join(repoRoot, 'src', 'standalone.ts'), 'mcp-server'],
    command: process.execPath,
    cwd: repoRoot,
    env: environment,
    maxBufferSize: options.maxBufferSize,
    stderr: 'pipe',
  });
  const client = new Client({name: 'threadnote-test', version: '0.0.0'});
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function callCodeGraphUntilReady(client: Client, arguments_: Readonly<Record<string, unknown>>) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const result = await client.callTool({arguments: arguments_, name: 'inspect_code_graph'}, undefined, {
      timeout: 30_000,
    });
    const structured = result.structuredContent as
      {readonly retryAfterMilliseconds?: unknown; readonly state?: unknown} | undefined;
    if (!isRetryableCodeGraphState(structured?.state)) return result;
    if (Date.now() >= deadline) {
      throw new TestError(`Code graph remained ${String(structured?.state)} for 90 seconds.`);
    }
    const requestedDelay =
      typeof structured?.retryAfterMilliseconds === 'number' ? structured.retryAfterMilliseconds : 250;
    await new Promise(resolve => setTimeout(resolve, Math.max(50, Math.min(1_000, requestedDelay))));
  }
}

function isRetryableCodeGraphState(state: unknown): boolean {
  return state === 'indexing' || state === 'timed-out' || state === 'timed_out';
}

function canonicalMemoryContent(topic: string, body: string): string {
  return [
    'MEMORY',
    'kind: durable',
    'status: active',
    'project: threadnote',
    `topic: ${topic}`,
    'source_agent_client: integration-test',
    'timestamp: 2026-08-01T00:00:00.000Z',
    '',
    body,
  ].join('\n');
}

function largeReadBody(label: string, lineCount: number): string {
  return Array.from(
    {length: lineCount},
    (_, index) => `${label} ${index.toString().padStart(5, '0')} ${'payload '.repeat(8)}payload`,
  ).join('\n');
}

async function writeCanonicalMemory(home: string, filename: string, content: string): Promise<void> {
  const directory = join(home, 'data', 'local', 'user', 'test-user', 'memories', 'durable', 'projects', 'threadnote');
  await mkdir(directory, {recursive: true});
  await writeFile(join(directory, filename), content, 'utf8');
}

function recallProgressPhases(updates: readonly ThreadnoteProgress[]): string[] {
  return updates.map(update => {
    const metadata = update._meta?.['threadnote.io/progress'] as
      {readonly phase?: unknown; readonly version?: unknown} | undefined;
    expect(metadata?.version).toBe(1);
    expect(metadata).not.toHaveProperty('retryAfterMilliseconds');
    expect(typeof metadata?.phase).toBe('string');
    return metadata?.phase as string;
  });
}

function collapseConsecutive<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

function expectOrderedRecallProgress(updates: readonly ThreadnoteProgress[]): string[] {
  expect(updates.length).toBeGreaterThanOrEqual(RECALL_PROGRESS_PHASES.length);
  expect(updates.map(update => update.progress)).toEqual(Array.from({length: updates.length}, (_, index) => index + 1));
  const phases = recallProgressPhases(updates);
  expect(collapseConsecutive(phases)).toEqual(RECALL_PROGRESS_PHASES);
  return phases;
}

function expectRequestLocalRecallProgress(updates: readonly ThreadnoteProgress[]): void {
  expect(updates.length).toBeGreaterThan(0);
  expect(updates.map(update => update.progress)).toEqual(Array.from({length: updates.length}, (_, index) => index + 1));
  const phases = collapseConsecutive(recallProgressPhases(updates));
  expect(phases).toEqual(RECALL_PROGRESS_PHASES.slice(0, phases.length));
}

describe('Threadnote MCP toolsets', () => {
  it('keeps the core server instructions compact and self-contained', async () => {
    await withMcpClient(
      async client => {
        const instructions = client.getInstructions() ?? '';
        expect(Buffer.byteLength(instructions)).toBeLessThanOrEqual(640);
        expect(instructions).toContain('callerCwd');
        expect(instructions).toContain('threadnote://');
        expect(instructions).toContain('durable');
        expect(instructions).toContain('handoff');
        expect(instructions).toContain('`project` excludes others');
        expect(instructions).toContain('omit it for global recall');
        expect(instructions).toContain('Nested cwd prefers its package');
        expect(instructions).toContain('repo-wide/sibling evidence remains eligible');
        expect(instructions).toContain('user-approved candidates');
        expect(instructions).toContain('Do not store');
        expect(instructions).toContain('Results are unread `threadnote://` pointers, not evidence');
        expect(instructions).toContain('read them via `read_context`');
        expect(instructions).toContain('`inspect_code_graph` before broad search');
        expect(instructions).toContain('`analyze_code_graph` for architecture');
        expect(instructions).toContain('exact search remains useful');
        expect(instructions).toContain('Retry indexing when advised');
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
        expect(Buffer.byteLength(JSON.stringify(tools.tools))).toBeLessThanOrEqual(15_000);
        expect(tools.tools.find(tool => tool.name === 'recall_context')?.description).toContain(
          'unread threadnote:// pointers, not evidence',
        );
        const readContext = tools.tools.find(tool => tool.name === 'read_context');
        expect(readContext?.description).toContain('no more than 1500 estimated tokens');
        expect(readContext?.description).toContain('pass cursor without uri, uris, mode, or section');
      },
      {toolset: null},
    );
  });

  it('advertises bounded Threadnote resource discovery without enumerating private memories', async () => {
    await withMcpClient(
      async client => {
        expect(client.getServerCapabilities()?.resources).toEqual({listChanged: true, subscribe: false});
        await expect(client.listResources()).resolves.toEqual({resources: []});

        const templates = await client.listResourceTemplates();
        expect(templates.resourceTemplates).toEqual([
          expect.objectContaining({
            mimeType: 'text/plain; charset=utf-8',
            name: 'Threadnote canonical resource',
            uriTemplate: 'threadnote://{+resourcePath}',
          }),
        ]);
        expect(templates.resourceTemplates[0]?._meta).toEqual({
          'threadnote.io/max-resource-bytes': MCP_RESOURCE_READ_MAX_BYTES,
        });
      },
      {toolset: 'core'},
    );
  });

  it('reads one canonical Threadnote URI through the standard MCP resource protocol', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/protocol-resource.md';
        const content = canonicalMemoryContent('protocol-resource', 'Protocol resource body.');
        await writeCanonicalMemory(fixture.home, 'protocol-resource.md', content);

        await expect(client.readResource({uri})).resolves.toEqual({
          contents: [{mimeType: 'text/plain; charset=utf-8', text: content, uri}],
        });
      },
      {toolset: 'core'},
    );
  });

  it('rejects invalid, missing, and oversized protocol resources with bounded privacy-safe errors', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const missingUri =
          'threadnote://user/test-user/memories/durable/projects/threadnote/missing-protocol-resource.md';
        const crossUserUri =
          'threadnote://user/other-user/memories/durable/projects/threadnote/private-protocol-resource.md';
        const crossAccountUri = 'threadnote://resources/private-protocol-resource.txt';
        const invalidUtf8Uri = 'threadnote://resources/invalid-utf8-protocol-resource.txt';
        const oversizedUri =
          'threadnote://user/test-user/memories/durable/projects/threadnote/oversized-protocol-resource.md';
        await writeCanonicalMemory(
          fixture.home,
          'oversized-protocol-resource.md',
          canonicalMemoryContent(
            'oversized-protocol-resource',
            `LOCAL_RESOURCE_PRIVATE_SENTINEL\n${'x'.repeat(1_000_000)}`,
          ),
        );
        const foreignAccountResources = join(fixture.home, 'data', 'other-account', 'resources');
        await mkdir(foreignAccountResources, {recursive: true});
        await writeFile(
          join(foreignAccountResources, 'private-protocol-resource.txt'),
          'foreign account secret',
          'utf8',
        );
        const activeAccountResources = join(fixture.home, 'data', 'local', 'resources');
        await mkdir(activeAccountResources, {recursive: true});
        await writeFile(join(activeAccountResources, 'invalid-utf8-protocol-resource.txt'), Uint8Array.of(0xc3, 0x28));

        const invalidError = await client.readResource({uri: 'file:///tmp/private-memory.md'}).then(
          () => undefined,
          error => error as Error & {readonly code?: number; readonly data?: unknown},
        );
        expect(invalidError).toMatchObject({
          code: -32602,
          message: expect.stringContaining('canonical threadnote:// URI'),
        });
        expect(invalidError?.message).not.toContain('/tmp/private-memory.md');
        expect(invalidError?.data).toBeUndefined();
        await expect(client.readResource({uri: `${missingUri}/`})).rejects.toMatchObject({
          code: -32602,
          message: expect.stringContaining('canonical threadnote:// URI'),
        });
        await expect(
          client.readResource({uri: missingUri.replace('threadnote://', 'viking://')}),
        ).rejects.toMatchObject({
          code: -32602,
          message: expect.stringContaining('canonical threadnote:// URI'),
        });
        const missingError = await client.readResource({uri: missingUri}).then(
          () => undefined,
          error => error as Error & {readonly code?: number; readonly data?: unknown},
        );
        expect(missingError).toMatchObject({
          code: -32002,
          message: expect.stringContaining('Threadnote resource was not found.'),
        });
        expect(missingError?.data).toMatchObject({
          code: 'memory-resource-not-found',
          nextAction: {
            arguments: {query: 'missing-protocol-resource'},
            tool: 'recall_context',
          },
          recoveryAction: 'recall-canonical-uri',
          requestedUri: missingUri,
          retryable: false,
          type: 'threadnote-memory-read-recovery',
          version: 1,
        });
        const crossUserError = await client.readResource({uri: crossUserUri}).then(
          () => undefined,
          error => error as Error & {readonly code?: number; readonly data?: unknown},
        );
        expect(crossUserError).toMatchObject({
          code: -32602,
          message: expect.stringContaining('not readable in the active account'),
        });
        expect(crossUserError?.message).not.toContain('other-user');
        expect(crossUserError?.data).toBeUndefined();
        const crossAccountError = await client.readResource({uri: crossAccountUri}).then(
          () => undefined,
          error => error as Error & {readonly code?: number; readonly data?: unknown},
        );
        expect(crossAccountError).toMatchObject({
          code: -32002,
          message: expect.stringContaining('Threadnote resource was not found.'),
        });
        expect(crossAccountError?.message).not.toContain('other-account');
        expect(crossAccountError?.message).not.toContain(fixture.root);
        expect(crossAccountError?.data).toBeUndefined();
        const invalidUtf8Error = await client.readResource({uri: invalidUtf8Uri}).then(
          () => undefined,
          error => error as Error & {readonly code?: number; readonly data?: unknown},
        );
        expect(invalidUtf8Error).toMatchObject({
          code: -32603,
          message: expect.stringContaining('Threadnote resource could not be read safely.'),
        });
        expect(invalidUtf8Error?.message).not.toContain('invalid-utf8-protocol-resource');
        expect(invalidUtf8Error?.message).not.toContain(fixture.root);
        expect(invalidUtf8Error?.data).toBeUndefined();
        const oversizedError = await client.readResource({uri: oversizedUri}).then(
          () => undefined,
          error => error as Error & {readonly code?: number; readonly data?: unknown},
        );
        expect(oversizedError).toMatchObject({
          code: -32602,
          message: expect.stringContaining(
            `Threadnote resource exceeds the ${MCP_RESOURCE_READ_MAX_BYTES}-byte resources/read limit; use read_context pagination.`,
          ),
        });
        expect(oversizedError?.message).not.toContain('LOCAL_RESOURCE_PRIVATE_SENTINEL');
      },
      {toolset: 'core'},
    );
  });

  it('emits and enforces Effect Schema inputs over stdio', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const tools = await client.listTools();
        const recall = tools.tools.find(tool => tool.name === 'recall_context');
        expect(recall?.inputSchema).toMatchObject({
          additionalProperties: false,
          properties: {
            budgetTokens: {maximum: 1_500, minimum: 700, type: 'integer'},
            callerCwd: {type: 'string'},
            explain: {type: 'boolean'},
            nodeLimit: {maximum: 100, minimum: 1, type: 'integer'},
            project: {type: 'string'},
            query: {type: 'string'},
            threshold: {maximum: 1, minimum: 0, type: 'number'},
          },
          type: 'object',
        });
        expect(JSON.stringify(recall?.inputSchema)).not.toContain('null');
        const read = tools.tools.find(tool => tool.name === 'read_context');
        expect(read?.inputSchema.properties).not.toHaveProperty('full');
        for (const name of ['remember_context', 'review_session_context']) {
          const codeReferenceTool = tools.tools.find(tool => tool.name === name);
          expect(codeReferenceTool?.inputSchema).toMatchObject({
            properties: {
              codeRefs: {
                anyOf: [
                  {type: 'string'},
                  {
                    items: {type: 'string'},
                    maxItems: MAX_MEMORY_CODE_CITATIONS,
                    type: 'array',
                  },
                ],
                description: expect.stringContaining(`max ${MAX_MEMORY_CODE_CITATIONS}`),
              },
            },
          });
          expect(JSON.stringify(codeReferenceTool?.inputSchema)).toContain('Graph-indexed repository-relative path');
        }
        expect(tools.tools.find(tool => tool.name === 'remember_context')?.inputSchema).toMatchObject({
          properties: {
            citationPolicy: {enum: ['require-current', 'defer'], type: 'string'},
            relations: {
              items: {
                additionalProperties: false,
                properties: {
                  type: {enum: MEMORY_RELATION_TYPES, type: 'string'},
                  uri: {type: 'string'},
                },
                required: ['type', 'uri'],
                type: 'object',
              },
              maxItems: MAX_MEMORY_RELATIONS,
              type: 'array',
            },
          },
        });

        const validationError = await callErrorText(client, 'recall_context', {
          nodeLimit: 0,
          query: 'threadnote',
        });
        expect(validationError).toContain('greater than or equal to 1');
        const tooManyCodeRefs = await callErrorText(client, 'remember_context', {
          callerCwd: fixture.root,
          codeRefs: Array.from({length: MAX_MEMORY_CODE_CITATIONS + 1}, (_, index) => `src/${index}.ts`),
          text: 'This memory must not be stored.',
        });
        expect(tooManyCodeRefs).toContain(`at most ${MAX_MEMORY_CODE_CITATIONS}`);
        const tooManyRelations = await callErrorText(client, 'remember_context', {
          relations: Array.from({length: MAX_MEMORY_RELATIONS + 1}, (_, index) => ({
            type: 'related_to',
            uri: `threadnote://memory/tn_${index}`,
          })),
          text: 'This memory must not be stored.',
        });
        expect(tooManyRelations).toContain(`at most ${MAX_MEMORY_RELATIONS}`);
        const inactiveDeferred = await callErrorText(client, 'remember_context', {
          callerCwd: fixture.root,
          citationPolicy: 'defer',
          codeRefs: ['src/types.ts'],
          status: 'archived',
          text: 'Inactive memories cannot own pending anchors.',
        });
        expect(inactiveDeferred).toContain('citationPolicy=defer requires status=active');
      },
      {toolset: 'core'},
    );
  });

  it('returns a budgeted unread queue and gates full ranking explanations behind explain', async () => {
    await withMcpClient(
      async (client, fixture) => {
        await writeCanonicalMemory(
          fixture.home,
          'structured-recall.md',
          canonicalMemoryContent('structured-recall', 'Structured recall ranking anchor qz-structured-7788.'),
        );
        const result = await client.callTool(
          {
            arguments: {project: 'threadnote', query: 'qz-structured-7788', threshold: 0},
            name: 'recall_context',
          },
          undefined,
          {timeout: 5000},
        );

        expect(result.structuredContent).toMatchObject({
          confidence: {
            level: expect.stringMatching(/^(?:high|medium|low|no_answer)$/),
          },
          nextAction: {tool: 'read_context', uris: expect.any(Array)},
          output: {budgetTokens: 1_500, explain: false, returnedResults: expect.any(Number)},
          rankerVersion: 'hybrid-v8',
          results: expect.any(Array),
        });
        const compact = result.structuredContent as {
          readonly nextAction: {readonly uris: readonly string[]};
          readonly results: readonly Record<string, unknown>[];
        };
        expect(compact.results.length).toBeGreaterThan(0);
        expect(compact.results[0]).toMatchObject({readState: 'unread', reason: expect.any(String)});
        expect(compact.results[0]).not.toHaveProperty('reasons');
        expect(compact.results[0]).not.toHaveProperty('signals');
        expect(compact.nextAction.uris[0]).toBe(compact.results[0]?.uri);
        const compactText = (result.content as TextContent[]).map(item => item.text).join('\n');
        expect(
          Buffer.byteLength(JSON.stringify(result.structuredContent)) + Buffer.byteLength(compactText),
        ).toBeLessThanOrEqual(1_500 * 3);
        expect(result.structuredContent).not.toHaveProperty('codeGraph');

        const explained = await client.callTool(
          {
            arguments: {explain: true, project: 'threadnote', query: 'qz-structured-7788', threshold: 0},
            name: 'recall_context',
          },
          undefined,
          {timeout: 5000},
        );
        const explainedResults = (explained.structuredContent as {readonly results: readonly Record<string, unknown>[]})
          .results;
        expect(explainedResults[0]).toMatchObject({reasons: expect.any(Array), signals: expect.any(Object)});

        const tooSmall = await callErrorText(client, 'recall_context', {
          budgetTokens: 699,
          project: 'threadnote',
          query: 'qz-structured-7788',
          threshold: 0,
        });
        expect(tooSmall).toContain('greater than or equal to 700');
      },
      {toolset: 'core'},
    );
  });

  it('returns a typed identity-conflict warning in the default compact recall result', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const memory = (topic: string, body: string) =>
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            'project: threadnote',
            `topic: ${topic}`,
            'source_agent_client: integration-test',
            'timestamp: 2026-08-01T00:00:00.000Z',
            'memory_id: tn_mcp_identity_conflict',
            '',
            body,
          ].join('\n');
        await writeCanonicalMemory(
          fixture.home,
          'identity-conflict-target.md',
          memory('identity-conflict-target', 'Identity conflict anchor qz-identity-7788.'),
        );
        const sharedPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'shared',
          'platform',
          'durable',
          'projects',
          'threadnote',
          'identity-conflict-alias.md',
        );
        await mkdir(join(sharedPath, '..'), {recursive: true});
        await writeFile(sharedPath, memory('identity-conflict-alias', 'A divergent body.'), 'utf8');

        const result = await client.callTool(
          {
            arguments: {project: 'threadnote', query: 'qz-identity-7788', threshold: 0},
            name: 'recall_context',
          },
          undefined,
          {timeout: 5_000},
        );

        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as {
          readonly output?: {readonly explain?: boolean};
          readonly results?: readonly {
            readonly rankWarnings?: unknown;
            readonly warnings?: readonly {readonly code?: unknown; readonly message?: unknown}[];
          }[];
        };
        expect(structured.output?.explain).toBe(false);
        expect(structured.results?.[0]?.warnings).toEqual([
          expect.objectContaining({
            code: 'memory_identity_conflict',
            message: expect.stringContaining('divergent bodies'),
          }),
        ]);
        expect(structured.results?.[0]).not.toHaveProperty('rankWarnings');
      },
      {toolset: 'core'},
    );
  });

  it('honors THREADNOTE_RECALL_THRESHOLD as the topical relevanceScore floor', async () => {
    await withMcpClient(
      async (client, fixture) => {
        await writeCanonicalMemory(
          fixture.home,
          'environment-threshold.md',
          canonicalMemoryContent('environment-threshold', 'Environment threshold anchor qz-environment-8811.'),
        );

        const configured = await client.callTool(
          {
            arguments: {project: 'threadnote', query: 'qz-environment-8811'},
            name: 'recall_context',
          },
          undefined,
          {timeout: 5_000},
        );
        expect((configured.structuredContent as {readonly results?: readonly unknown[]} | undefined)?.results).toEqual(
          [],
        );

        const broadened = await client.callTool(
          {
            arguments: {project: 'threadnote', query: 'qz-environment-8811', threshold: 0},
            name: 'recall_context',
          },
          undefined,
          {timeout: 5_000},
        );
        expect(
          (broadened.structuredContent as {readonly results?: readonly unknown[]} | undefined)?.results?.length,
        ).toBeGreaterThan(0);
      },
      {environment: {THREADNOTE_RECALL_THRESHOLD: '1'}, toolset: 'core'},
    );
  });

  it('keeps progress opt-in and leaves unrelated tool handlers unchanged', async () => {
    await withMcpClient(
      async client => {
        const progressUpdates: ThreadnoteProgress[] = [];
        const result = await client.callTool({arguments: {}, name: 'list_context'}, undefined, {
          onprogress: update => progressUpdates.push(update),
          resetTimeoutOnProgress: true,
          timeout: 5000,
        });

        expect(result.isError).not.toBe(true);
        expect(progressUpdates).toEqual([]);
      },
      {toolset: 'core'},
    );
  });

  it('records one-time recall pre-sync and read-only retrieval phases without private inputs', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const privateQuery = 'private-phase-timing-query-7788';
        const progressUpdates: ThreadnoteProgress[] = [];
        await writeFile(
          join(fixture.home, 'layout.json'),
          `${JSON.stringify({createdBy: 'threadnote', version: 2})}\n`,
          'utf8',
        );
        await writeCanonicalMemory(
          fixture.home,
          'phase-timing.md',
          canonicalMemoryContent('phase-timing', `Lexical anchor ${privateQuery}.`),
        );

        const result = await client.callTool(
          {arguments: {project: 'threadnote', query: privateQuery}, name: 'recall_context'},
          undefined,
          {
            onprogress: update => progressUpdates.push(update),
            resetTimeoutOnProgress: true,
            timeout: 5000,
          },
        );
        expect(result.isError).not.toBe(true);

        expectOrderedRecallProgress(progressUpdates);
        expect(JSON.stringify(progressUpdates)).not.toContain(privateQuery);

        const productionLog = await readFile(join(fixture.home, 'logs', 'threadnote.log'), 'utf8');
        const entries = productionLog
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as Record<string, unknown>);
        const finished = entries
          .filter(entry => entry.event === 'invocation.finished' && entry.operation === 'recall_context')
          .at(-1);
        const phaseTimings = finished?.phaseTimings as
          readonly {readonly outcome: string; readonly phase: string}[] | undefined;

        expect(phaseTimings?.filter(timing => timing.phase === 'recall.shared-sync')).toHaveLength(1);
        expect(phaseTimings?.filter(timing => timing.phase === 'recall.obsidian-sync')).toHaveLength(1);
        expect(phaseTimings?.filter(timing => timing.phase === 'recall.semantic-retrieval')).toHaveLength(1);
        expect(phaseTimings?.filter(timing => timing.phase === 'recall.lexical-ranking').length).toBeGreaterThanOrEqual(
          1,
        );
        expect(phaseTimings?.find(timing => timing.phase === 'recall.semantic-retrieval')?.outcome).toBe('unavailable');
        expect(productionLog).not.toContain(privateQuery);
      },
      {toolset: 'core'},
    );
  });

  it('returns a typed degraded warning when exact and ranked lexical recovery both fail', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const lexicalRoot = join(fixture.home, 'indexes', 'lexical');
        await mkdir(lexicalRoot, {recursive: true});
        await writeFile(join(lexicalRoot, recallIndexDatabaseFilename(false)), 'not a sqlite database', 'utf8');
        await writeFile(join(lexicalRoot, 'generations'), 'blocks index recovery', 'utf8');

        const result = await client.callTool(
          {
            arguments: {project: 'threadnote', query: 'degraded lexical exact anchor 7788'},
            name: 'recall_context',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as {
          readonly results?: readonly unknown[];
          readonly warnings?: readonly {
            readonly code?: unknown;
            readonly message?: unknown;
            readonly remediation?: unknown;
          }[];
        };
        expect(structured.results).toEqual([]);
        expect(structured.warnings).toEqual([
          expect.objectContaining({
            code: 'lexical_index_unavailable',
            message: expect.stringContaining('could not be read or recovered'),
            remediation: expect.stringContaining('threadnote doctor --dry-run'),
          }),
        ]);
        const text = (result.content as TextContent[]).map(item => item.text).join('\n');
        expect(text).toContain('Recall index warning:');
        expect(text).toContain('Recall returned 0/0 unread pointer(s)');

        const hookQueue = renderSessionStartRecallQueue('threadnote', text);
        expect(hookQueue).toContain('recall ran in degraded mode');
        expect(hookQueue).toContain('Do not treat this empty queue as proof that no memory exists.');
        expect(hookQueue).not.toContain('there is no recalled memory to treat as context');
      },
      {toolset: 'core'},
    );
  });

  it('keeps eight concurrent recall progress streams request-local under load', async () => {
    await withMcpClient(
      async client => {
        const calls = await Promise.all(
          Array.from({length: 8}, async (_, index) => {
            const privateQuery = `private-concurrent-progress-${index}-7788`;
            const progressUpdates: ThreadnoteProgress[] = [];
            const result = await client.callTool(
              {arguments: {project: 'threadnote', query: privateQuery}, name: 'recall_context'},
              undefined,
              {
                onprogress: update => progressUpdates.push(update),
                resetTimeoutOnProgress: true,
                timeout: 10_000,
              },
            );
            return {privateQuery, progressUpdates, result};
          }),
        );

        for (const {privateQuery, progressUpdates, result} of calls) {
          expect(result.isError).not.toBe(true);
          expectRequestLocalRecallProgress(progressUpdates);
          expect(JSON.stringify(progressUpdates)).not.toContain(privateQuery);
        }
      },
      {toolset: 'core'},
    );
  });

  it('repeats real stdio heartbeats until response or cancellation without reordering phases', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const privateQuery = 'private-short-heartbeat-query-7788';
        await Promise.all(
          Array.from({length: 128}, (_, index) =>
            writeCanonicalMemory(
              fixture.home,
              `short-heartbeat-${index.toString().padStart(3, '0')}.md`,
              canonicalMemoryContent(
                `short-heartbeat-${index}`,
                `${privateQuery} bounded lexical corpus entry ${index}.`,
              ),
            ),
          ),
        );

        const protocolErrors: Error[] = [];
        const originalOnError = client.onerror;
        client.onerror = error => protocolErrors.push(error);
        try {
          const completedUpdates: ThreadnoteProgress[] = [];
          const completed = await client.callTool(
            {arguments: {project: 'threadnote', query: privateQuery}, name: 'recall_context'},
            undefined,
            {
              maxTotalTimeout: 10_000,
              onprogress: update => completedUpdates.push(update),
              resetTimeoutOnProgress: true,
              timeout: 5_000,
            },
          );
          expect(completed.isError).not.toBe(true);
          const completedPhases = expectOrderedRecallProgress(completedUpdates);
          expect(completedPhases.some((phase, index) => index > 0 && phase === completedPhases[index - 1])).toBe(true);
          expect(JSON.stringify(completedUpdates)).not.toContain(privateQuery);
          await new Promise(resolve => setTimeout(resolve, 150));
          expect(protocolErrors).toEqual([]);

          const controller = new AbortController();
          const cancelledUpdates: ThreadnoteProgress[] = [];
          const cancelled = client.callTool(
            {arguments: {project: 'threadnote', query: privateQuery}, name: 'recall_context'},
            undefined,
            {
              maxTotalTimeout: 10_000,
              onprogress: update => {
                cancelledUpdates.push(update);
                if (!controller.signal.aborted) controller.abort();
              },
              resetTimeoutOnProgress: true,
              signal: controller.signal,
              timeout: 5_000,
            },
          );

          await expect(cancelled).rejects.toMatchObject({
            code: -32_001,
            message: expect.stringContaining('AbortError'),
          });
          expect(controller.signal.aborted).toBe(true);
          expect(recallProgressPhases(cancelledUpdates)).toEqual(['recall.shared-sync']);
          await new Promise(resolve => setTimeout(resolve, 400));
          expect(protocolErrors).toEqual([]);

          const followUp = await client.callTool({arguments: {}, name: 'list_context'}, undefined, {timeout: 5_000});
          expect(followUp.isError).not.toBe(true);
        } finally {
          client.onerror = originalOnError;
        }
      },
      {
        environment: {
          NODE_ENV: 'test',
          THREADNOTE_TEST_MCP_PROGRESS_HEARTBEAT_MILLISECONDS: '100',
          THREADNOTE_TEST_MCP_PROGRESS_SHARED_SYNC_DELAY_MILLISECONDS: '300',
        },
        toolset: 'core',
      },
    );
  });

  it('bounds read_context and reconstructs exact Unicode content for content- and structured-first clients', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/bounded-read.md';
        const content = canonicalMemoryContent('bounded-read', `${'Unicode evidence 🙂漢字\n'.repeat(1_000)}terminal`);
        await writeCanonicalMemory(fixture.home, 'bounded-read.md', content);

        const budgetTokens = 256;
        const reconstructed: string[] = [];
        let cursor: string | undefined;
        let previousCursor: string | undefined;
        for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
          const result = await client.callTool(
            {
              arguments: cursor === undefined ? {budgetTokens, uri} : {budgetTokens, cursor},
              name: 'read_context',
            },
            undefined,
            {timeout: 30_000},
          );
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          const output = Array.isArray(result.content) ? result.content : [];
          const structured = result.structuredContent as ReadPageStructuredContent;
          const pageText = structured.content;
          expect((output[0] as TextContent | undefined)?.text).toBe(pageText);
          const responseBytes =
            output.reduce(
              (total, item) => total + (item.type === 'text' ? Buffer.byteLength(item.text, 'utf8') : 0),
              0,
            ) + Buffer.byteLength(JSON.stringify(structured), 'utf8');
          expect(responseBytes).toBeLessThanOrEqual(budgetTokens * 3);
          expect(structured.estimatedTokens).toBe(Math.ceil(responseBytes / 3));
          expect(structured.type).toBe('threadnote-read-page');
          expect(result._meta).not.toHaveProperty('threadnote.io/canonical-read');
          reconstructed.push(pageText);
          if (structured.complete) {
            expect(structured.cursor).toBeUndefined();
            break;
          }
          expect(structured.cursor).toMatch(/^tnrc_[0-9a-f]{32}$/u);
          expect(structured.cursor).not.toContain('threadnote');
          previousCursor = cursor;
          cursor = structured.cursor;
          if (pageNumber === 999) throw new TestError('Bounded read did not terminate.');
        }
        expect(reconstructed.join('')).toBe(content);

        if (previousCursor) {
          const replay = await client.callTool({arguments: {cursor: previousCursor}, name: 'read_context'});
          expect(replay.isError).toBe(true);
          const replayContent = Array.isArray(replay.content) ? replay.content : [];
          expect((replayContent[0] as TextContent | undefined)?.text).toContain('already consumed');
        }
      },
      {toolset: 'core'},
    );
  }, 40_000);

  it('resolves a relocated memory with requested and canonical URIs in both MCP result channels', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const requestedUri = 'threadnote://user/test-user/memories/durable/projects/threadnote/relocated-request.md';
        const canonicalUri = 'threadnote://user/test-user/memories/durable/projects/threadnote/relocated-canonical.md';
        const memoryId = 'tn_mcp_relocated';
        const content = canonicalMemoryContent('relocated-canonical', 'Canonical relocated evidence.').replace(
          'source_agent_client:',
          `memory_id: ${memoryId}\nsource_agent_client:`,
        );
        await writeCanonicalMemory(fixture.home, 'relocated-canonical.md', content);
        const receiptRoot = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'private',
          'memory-relocations',
          'v1',
        );
        await mkdir(receiptRoot, {recursive: true, mode: 0o700});
        const receiptPath = join(receiptRoot, `${createHash('sha256').update(requestedUri).digest('hex')}.json`);
        await writeFile(
          receiptPath,
          `${JSON.stringify(
            {
              fromUri: requestedUri,
              memoryId,
              toUri: canonicalUri,
              type: 'threadnote-memory-relocation',
              version: 1,
              visibility: 'private-local',
            },
            undefined,
            2,
          )}\n`,
          {mode: 0o600},
        );

        const result = await client.callTool(
          {arguments: {budgetTokens: 1_500, uri: requestedUri}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const output = Array.isArray(result.content) ? result.content : [];
        const structured = result.structuredContent as ReadPageStructuredContent;
        expect((output[0] as TextContent | undefined)?.text).toBe(content);
        expect((output[1] as TextContent | undefined)?.text).toContain(`requested ${requestedUri}`);
        expect((output[1] as TextContent | undefined)?.text).toContain(`canonical ${canonicalUri}`);
        expect(structured).toMatchObject({
          canonicalUri,
          complete: true,
          content,
          requestedUri,
          type: 'threadnote-read-page',
        });
        const responseBytes =
          output.reduce((total, item) => total + (item.type === 'text' ? Buffer.byteLength(item.text, 'utf8') : 0), 0) +
          Buffer.byteLength(JSON.stringify(structured), 'utf8');
        expect(responseBytes).toBeLessThanOrEqual(1_500 * 3);
        expect(structured.estimatedTokens).toBe(Math.ceil(responseBytes / 3));
        expect(result._meta).not.toHaveProperty('threadnote.io/canonical-read');
        await expect(client.readResource({uri: requestedUri})).resolves.toEqual({
          contents: [{mimeType: 'text/plain; charset=utf-8', text: content, uri: canonicalUri}],
        });
        const recalled = await client.callTool(
          {arguments: {project: 'threadnote', query: 'Canonical relocated evidence'}, name: 'recall_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(recalled.isError, JSON.stringify(recalled)).not.toBe(true);
        const identityAlias = `threadnote://memory/${memoryId}`;
        const aliasRead = await client.callTool(
          {arguments: {budgetTokens: 1_500, uri: identityAlias}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(aliasRead.isError, JSON.stringify(aliasRead)).not.toBe(true);
        expect(aliasRead.structuredContent).toMatchObject({content, requestedUri: identityAlias});
        expect(aliasRead.structuredContent).not.toHaveProperty('canonicalUri');
        await expect(client.readResource({uri: identityAlias})).resolves.toEqual({
          contents: [{mimeType: 'text/plain; charset=utf-8', text: content, uri: identityAlias}],
        });
      },
      {toolset: 'core'},
    );
  });

  it('reads stable identity aliases through tools and resources without leaking a canonical URI', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const memoryId = 'tn_mcp_identity_alias';
        const alias = `threadnote://memory/${memoryId}`;
        const canonicalUri = 'threadnote://user/test-user/memories/durable/projects/threadnote/identity-alias.md';
        const content = canonicalMemoryContent('identity-alias', 'Identity alias anchor qz-alias-4411.').replace(
          'source_agent_client:',
          `memory_id: ${memoryId}\nsource_agent_client:`,
        );
        await writeCanonicalMemory(fixture.home, 'identity-alias.md', content);
        const recalled = await client.callTool(
          {arguments: {project: 'threadnote', query: 'qz-alias-4411'}, name: 'recall_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(recalled.isError, JSON.stringify(recalled)).not.toBe(true);

        const result = await client.callTool(
          {arguments: {budgetTokens: 128, uri: alias}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const output = Array.isArray(result.content) ? result.content : [];
        const structured = result.structuredContent as ReadPageStructuredContent;
        expect((output[0] as TextContent | undefined)?.text).toBe(structured.content);
        expect(structured.requestedUri).toBe(alias);
        expect(structured.canonicalUri).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain(canonicalUri);
        const responseBytes =
          output.reduce((total, item) => total + (item.type === 'text' ? Buffer.byteLength(item.text, 'utf8') : 0), 0) +
          Buffer.byteLength(JSON.stringify(structured), 'utf8');
        expect(responseBytes).toBeLessThanOrEqual(128 * 3);

        await expect(client.readResource({uri: alias})).resolves.toEqual({
          contents: [{mimeType: 'text/plain; charset=utf-8', text: content, uri: alias}],
        });

        const missingAlias = 'threadnote://memory/tn_mcp_identity_missing';
        const missing = await client.callTool(
          {arguments: {budgetTokens: 128, uri: missingAlias}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(missing.isError).toBe(true);
        const missingOutput = Array.isArray(missing.content) ? missing.content : [];
        expect((missingOutput[0] as TextContent | undefined)?.text).toBe(JSON.stringify(missing.structuredContent));
        expect(missing.structuredContent).toMatchObject({
          alias: missingAlias,
          reason: 'not-found',
          type: 'threadnote-memory-identity-error',
          version: 1,
        });
        expect(JSON.stringify(missing)).not.toContain(canonicalUri);
        await expect(client.readResource({uri: missingAlias})).rejects.toThrow(/does not resolve/u);
      },
      {toolset: 'core'},
    );
  }, 40_000);

  it('gives content- and structured-first clients recovery for a legacy moved pointer without a receipt', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const requestedUri =
          'threadnote://user/test-user/memories/durable/projects/my-product/legacy-published-pointer.md';
        const canonicalUri =
          'threadnote://user/test-user/memories/shared/default/durable/projects/my-product/legacy-published-pointer.md';
        const content = canonicalMemoryContent(
          'Legacy Published Pointer',
          'Legacy published pointer recovery anchor qz-legacy-published-7788.',
        ).replace('project: threadnote', 'project: My Product');
        const sharedPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'shared',
          'default',
          'durable',
          'projects',
          'my-product',
          'legacy-published-pointer.md',
        );
        await mkdir(join(sharedPath, '..'), {recursive: true});
        await writeFile(sharedPath, content, 'utf8');
        const result = await client.callTool(
          {arguments: {budgetTokens: 800, uri: requestedUri}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );

        expect(result.isError).toBe(true);
        const output = Array.isArray(result.content) ? result.content : [];
        const recovery = {
          code: 'memory-resource-not-found',
          nextAction: {
            arguments: {query: 'legacy-published-pointer'},
            tool: 'recall_context',
          },
          recoveryAction: 'recall-canonical-uri',
          requestedUri,
          retryable: false,
          summary:
            'The memory may have moved or been published before relocation receipts were available. Recall by its stable topic, then read the canonical URI returned.',
          type: 'threadnote-memory-read-recovery',
          version: 1,
        };
        expect(JSON.parse((output[0] as TextContent | undefined)?.text ?? '')).toEqual(recovery);
        expect(result.structuredContent).toEqual(recovery);

        const recalled = await client.callTool(
          {arguments: recovery.nextAction.arguments, name: recovery.nextAction.tool},
          undefined,
          {timeout: 5_000},
        );
        expect(recalled.isError).not.toBe(true);
        const recalledUris = (
          recalled.structuredContent as {readonly results?: readonly {readonly uri?: unknown}[]}
        ).results?.map(entry => entry.uri);
        expect(recalledUris).toContain(canonicalUri);

        const canonical = await client.callTool(
          {arguments: {budgetTokens: 800, uri: canonicalUri}, name: 'read_context'},
          undefined,
          {timeout: 5_000},
        );
        expect(canonical.isError).not.toBe(true);
        expect((canonical.structuredContent as ReadPageStructuredContent).content).toBe(content);
      },
      {toolset: 'core'},
    );
  });

  it('keeps the old URI readable after remember_context relocates a personal memory', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const requestedUri = 'threadnote://user/test-user/memories/durable/projects/threadnote/mcp-replace-old.md';
        const canonicalUri = 'threadnote://user/test-user/memories/durable/projects/threadnote/mcp-replace-new.md';
        const original = canonicalMemoryContent('mcp-replace-old', 'Original replacement body.').replace(
          'source_agent_client:',
          'memory_id: tn_mcp_replace\nsource_agent_client:',
        );
        await writeCanonicalMemory(fixture.home, 'mcp-replace-old.md', original);

        const replaced = await client.callTool(
          {
            arguments: {
              kind: 'durable',
              project: 'threadnote',
              replaceUri: requestedUri,
              sourceAgentClient: 'integration-test',
              status: 'active',
              text: 'Replacement evidence.',
              topic: 'mcp-replace-new',
            },
            name: 'remember_context',
          },
          undefined,
          {timeout: 30_000},
        );
        expect(replaced.isError, JSON.stringify(replaced)).not.toBe(true);
        expect(replaced.structuredContent).toMatchObject({memoryUri: canonicalUri, replacementCleanupPending: false});

        const read = await client.callTool(
          {arguments: {budgetTokens: 1_500, uri: requestedUri}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(read.isError, JSON.stringify(read)).not.toBe(true);
        const output = Array.isArray(read.content) ? read.content : [];
        const structured = read.structuredContent as ReadPageStructuredContent;
        expect((output[0] as TextContent | undefined)?.text).toContain('Replacement evidence.');
        expect((output[1] as TextContent | undefined)?.text).toContain(`canonical ${canonicalUri}`);
        expect(structured).toMatchObject({canonicalUri, requestedUri});
      },
      {toolset: 'core'},
    );
  });

  it('normalizes remember_context relations to stable identities and rejects duplicate or self links', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const targetUri = 'threadnote://user/test-user/memories/durable/projects/threadnote/relation-target.md';
        const target = canonicalMemoryContent('relation-target', 'Relation target evidence.').replace(
          'source_agent_client:',
          'memory_id: tn_relation_target\nsource_agent_client:',
        );
        await writeCanonicalMemory(fixture.home, 'relation-target.md', target);

        const stored = await client.callTool(
          {
            arguments: {
              project: 'threadnote',
              relations: [{type: 'depends_on', uri: targetUri}],
              text: 'Relation source evidence.',
              topic: 'relation-source',
            },
            name: 'remember_context',
          },
          undefined,
          {timeout: 30_000},
        );
        expect(stored.isError, JSON.stringify(stored)).not.toBe(true);
        const storedUri = (stored.structuredContent as {readonly memoryUri?: string}).memoryUri;
        expect(storedUri).toBe('threadnote://user/test-user/memories/durable/projects/threadnote/relation-source.md');

        const read = await client.callTool(
          {arguments: {budgetTokens: 1_500, uri: storedUri}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );
        const readContent = Array.isArray(read.content) ? read.content : [];
        expect((readContent[0] as TextContent | undefined)?.text).toContain(
          `relation: depends_on ${memoryIdentityAlias('tn_relation_target')}`,
        );

        const failedClear = await client.callTool({
          arguments: {
            citationPolicy: 'defer',
            project: 'threadnote',
            replaceUri: storedUri,
            text: 'A failed replacement must not claim that it cleared edges.',
            topic: 'relation-source',
          },
          name: 'remember_context',
        });
        expect(failedClear.isError).toBe(true);
        expect(
          (failedClear.structuredContent as {readonly clearedMemoryRelations?: unknown} | undefined)
            ?.clearedMemoryRelations,
        ).toBeUndefined();

        const cleared = await client.callTool({
          arguments: {
            project: 'threadnote',
            replaceUri: storedUri,
            text: 'Relation source without replacement edges.',
            topic: 'relation-source',
          },
          name: 'remember_context',
        });
        expect(cleared.isError, JSON.stringify(cleared)).not.toBe(true);
        expect(cleared.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({text: expect.stringContaining('Cleared 1 prior memory relation(s)')}),
          ]),
        );
        expect(cleared.structuredContent).toMatchObject({clearedMemoryRelations: 1});
        const clearedRead = await callText(client, 'read_context', {budgetTokens: 1_500, uri: storedUri});
        expect(clearedRead).not.toContain('relation:');

        const duplicate = await callErrorText(client, 'remember_context', {
          project: 'threadnote',
          relations: [
            {type: 'depends_on', uri: targetUri},
            {type: 'depends_on', uri: memoryIdentityAlias('tn_relation_target')},
          ],
          text: 'Duplicate relation source.',
          topic: 'duplicate-relation-source',
        });
        expect(duplicate).toContain('Duplicate memory relations');

        const self = await callErrorText(client, 'remember_context', {
          project: 'threadnote',
          relations: [{type: 'related_to', uri: memoryIdentityAlias('tn_relation_target')}],
          replaceUri: targetUri,
          text: 'Attempted self relation.',
          topic: 'relation-target',
        });
        expect(self).toContain('cannot relate to itself');
      },
      {toolset: 'core'},
    );
  });

  it('continues read_context in a separate MCP process and atomically consumes a raced cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-mcp-cross-process-read-'));
    const fixture = {home: join(root, 'home'), root};
    await mkdir(fixture.home, {recursive: true});
    try {
      const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/cross-process-read.md';
      const content = canonicalMemoryContent(
        'cross-process-read',
        `${'cross-process evidence 🙂漢字\n'.repeat(3_000)}terminal`,
      );
      await writeCanonicalMemory(fixture.home, 'cross-process-read.md', content);

      let initialCursor: string | undefined;
      let initialText = '';
      await withMcpClientForFixture(
        fixture,
        async client => {
          const first = await client.callTool({arguments: {budgetTokens: 128, uri}, name: 'read_context'}, undefined, {
            timeout: 30_000,
          });
          expect(first.isError, JSON.stringify(first)).not.toBe(true);
          const structured = first.structuredContent as ReadPageStructuredContent | undefined;
          initialCursor = structured?.cursor;
          initialText = structured?.content ?? '';
          expect(initialCursor).toMatch(/^tnrc_[0-9a-f]{32}$/u);
        },
        {toolset: 'core'},
      );
      if (!initialCursor) throw new TestError('First MCP process did not issue a continuation cursor.');

      let raceCursor: string | undefined;
      await withMcpClientForFixture(
        fixture,
        async client => {
          const continued = await client.callTool(
            {arguments: {budgetTokens: 128, cursor: initialCursor}, name: 'read_context'},
            undefined,
            {timeout: 30_000},
          );
          expect(continued.isError, JSON.stringify(continued)).not.toBe(true);
          const structured = continued.structuredContent as ReadPageStructuredContent | undefined;
          expect(structured?.content).not.toBe(initialText);
          raceCursor = structured?.cursor;
          expect(raceCursor).toMatch(/^tnrc_[0-9a-f]{32}$/u);
        },
        {toolset: 'core'},
      );
      if (!raceCursor) throw new TestError('Second MCP process did not issue a continuation cursor.');

      const [left, right] = await Promise.all([
        connectMcpClient(fixture, {toolset: 'core'}),
        connectMcpClient(fixture, {toolset: 'core'}),
      ]);
      try {
        const results = await Promise.all(
          [left, right].map(client =>
            client.callTool({arguments: {budgetTokens: 128, cursor: raceCursor}, name: 'read_context'}, undefined, {
              timeout: 30_000,
            }),
          ),
        );
        const successful = results.filter(result => result.isError !== true);
        const rejected = results.filter(result => result.isError === true);
        expect(successful).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const rejectionContent = Array.isArray(rejected[0]?.content) ? rejected[0].content : [];
        expect((rejectionContent[0] as TextContent | undefined)?.text).toContain('already consumed');
      } finally {
        await Promise.all([left.close().catch(() => undefined), right.close().catch(() => undefined)]);
      }
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 60_000);

  it('advances read_context across repeated pages of one resource and then later resources', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const names = ['multi-one', 'multi-two', 'multi-three'] as const;
        const uris = names.map(name => `threadnote://user/test-user/memories/durable/projects/threadnote/${name}.md`);
        const contents = [
          canonicalMemoryContent(names[0], `${'0123456789'.repeat(260)}first terminal`),
          canonicalMemoryContent(names[1], 'second resource'),
          canonicalMemoryContent(names[2], 'third resource'),
        ];
        for (const [index, name] of names.entries()) {
          await writeCanonicalMemory(fixture.home, `${name}.md`, contents[index]!);
        }

        const resources: number[] = [];
        const pages: string[] = [];
        let cursor: string | undefined;
        for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
          const result = await client.callTool({
            arguments: cursor === undefined ? {budgetTokens: 1_500, uris} : {budgetTokens: 1_500, cursor},
            name: 'read_context',
          });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          const output = Array.isArray(result.content) ? result.content : [];
          const structured = result.structuredContent as ReadPageStructuredContent;
          expect((output[0] as TextContent | undefined)?.text).toBe(structured.content);
          resources.push(structured.resource);
          pages.push(structured.content);
          if (structured.complete) break;
          cursor = structured.cursor;
          if (pageNumber === 9) throw new TestError('Multi-resource read did not terminate.');
        }

        expect(resources).toEqual([1, 1, 2, 3]);
        expect(pages[0]).not.toBe(pages[1]);
        expect(pages.join('')).toBe(contents.join(''));
      },
      {toolset: 'core'},
    );
  });

  it('invalidates a read_context cursor when canonical content changes between pages', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/stale-bounded-read.md';
        const original = canonicalMemoryContent('stale-bounded-read', 'original evidence\n'.repeat(1_000));
        await writeCanonicalMemory(fixture.home, 'stale-bounded-read.md', original);
        const first = await client.callTool({arguments: {budgetTokens: 128, uri}, name: 'read_context'});
        const cursor = (first.structuredContent as ReadPageStructuredContent | undefined)?.cursor;
        expect(cursor).toMatch(/^tnrc_/u);

        await writeCanonicalMemory(
          fixture.home,
          'stale-bounded-read.md',
          canonicalMemoryContent('stale-bounded-read', 'changed evidence\n'.repeat(1_000)),
        );
        const continued = await client.callTool({arguments: {cursor}, name: 'read_context'});
        expect(continued.isError).toBe(true);
        const continuedContent = Array.isArray(continued.content) ? continued.content : [];
        expect((continuedContent[0] as TextContent | undefined)?.text).toContain('source changed');
      },
      {toolset: 'core'},
    );
  });

  it('keeps compatibility-alias continuations on the read tool that issued the cursor', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/alias-bounded-read.md';
        await writeCanonicalMemory(
          fixture.home,
          'alias-bounded-read.md',
          canonicalMemoryContent('alias-bounded-read', 'alias evidence\n'.repeat(1_000)),
        );
        const first = await client.callTool({arguments: {budgetTokens: 128, uri}, name: 'read'});
        const cursor = (first.structuredContent as ReadPageStructuredContent | undefined)?.cursor;
        expect(cursor).toMatch(/^tnrc_/u);
        const firstContent = Array.isArray(first.content) ? first.content : [];
        expect((firstContent[1] as TextContent | undefined)?.text).toContain('Continue with read cursor');

        const wrongTool = await client.callTool({arguments: {budgetTokens: 128, cursor}, name: 'read_context'});
        expect(wrongTool.isError).toBe(true);
        const continued = await client.callTool({arguments: {budgetTokens: 128, cursor}, name: 'read'});
        expect(continued.isError, JSON.stringify(continued)).not.toBe(true);
      },
      {toolset: 'full'},
    );
  });

  it('keeps a large canonical read bounded while healthy auto-sync contention is quietly deferred', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/sync-contention-read.md';
        const content = canonicalMemoryContent(
          'sync-contention-read',
          largeReadBody('Large-sync-contention-read', 12_000),
        );
        await writeCanonicalMemory(fixture.home, 'sync-contention-read.md', content);

        const ready = join(fixture.root, 'share-lock-owner.ready');
        const release = join(fixture.root, 'share-lock-owner.release');
        const helper = join(import.meta.dirname, '../helpers/share-lock-receipt-owner.ts');
        const owner = Bun.spawn({
          cmd: [
            process.execPath,
            helper,
            fixture.home,
            ready,
            release,
            join(fixture.root, 'unused-remote.git'),
            join(fixture.root, 'unused-worktree'),
          ],
          stderr: 'pipe',
          stdout: 'pipe',
        });
        let ownerExitCode: number | undefined;
        try {
          const readyDeadline = Date.now() + 10_000;
          while (!(await Bun.file(ready).exists())) {
            if (owner.exitCode !== null) {
              throw new TestError(`Share lock owner exited early: ${await new Response(owner.stderr).text()}`);
            }
            if (Date.now() >= readyDeadline)
              throw new TestError('Timed out waiting for the shared repository lock owner.');
            await Bun.sleep(10);
          }

          const result = await client.callTool({arguments: {budgetTokens: 256, uri}, name: 'read_context'}, undefined, {
            timeout: 30_000,
          });
          const output = Array.isArray(result.content) ? result.content : [];
          const primary = output[0] as TextContent | undefined;
          const structured = result.structuredContent as ReadPageStructuredContent;

          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          expect(primary?.type).toBe('text');
          expect(content.startsWith(primary?.text ?? '')).toBe(true);
          expect(structured.complete).toBe(false);
          expect(structured.cursor).toMatch(/^tnrc_/u);
          expect(
            output.reduce(
              (total, item) => total + (item.type === 'text' ? Buffer.byteLength(item.text, 'utf8') : 0),
              0,
            ) + Buffer.byteLength(JSON.stringify(structured), 'utf8'),
          ).toBeLessThanOrEqual(256 * 3);
        } finally {
          await writeFile(release, 'release\n', 'utf8');
          const exited = await Promise.race([owner.exited, Bun.sleep(5_000).then(() => undefined)]);
          if (exited === undefined) owner.kill(9);
          ownerExitCode = await owner.exited;
        }
        if (ownerExitCode !== 0) {
          throw new TestError(
            `Share lock owner exited with ${ownerExitCode}: ${await new Response(owner.stderr).text()}`,
          );
        }
      },
      {toolset: 'core'},
    );
  }, 40_000);

  it('persists nested package scope and uses it to rank otherwise similar monorepo memories', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const workspace = join(fixture.root, 'monorepo');
        const searchCwd = join(workspace, 'apps', 'search', 'src');
        const billingCwd = join(workspace, 'apps', 'billing', 'src');
        await mkdir(searchCwd, {recursive: true});
        await mkdir(billingCwd, {recursive: true});
        await writeFile(join(workspace, 'package.json'), '{"name":"@acme/monorepo","private":true}\n', 'utf8');
        await writeFile(join(workspace, 'apps', 'search', 'package.json'), '{"name":"@acme/search"}\n', 'utf8');
        await writeFile(join(workspace, 'apps', 'billing', 'package.json'), '{"name":"@acme/billing"}\n', 'utf8');
        execFileSync('git', ['init', '-q'], {cwd: workspace});

        for (const [callerCwd, topic] of [
          [searchCwd, 'search-implementation'],
          [billingCwd, 'billing-implementation'],
        ] as const) {
          await callText(client, 'remember_context', {
            callerCwd,
            kind: 'durable',
            project: 'monorepo',
            sourceAgentClient: 'codex',
            status: 'active',
            text: 'Implementation note for the current package.',
            topic,
          });
        }

        const stored = await callText(client, 'read_context', {
          uri: 'threadnote://user/test-user/memories/durable/projects/monorepo/search-implementation.md',
        });
        expect(stored).toContain('workspace_scope: apps/search');

        await callText(client, 'remember_context', {
          callerCwd: billingCwd,
          kind: 'durable',
          project: 'monorepo',
          replaceUri: 'threadnote://user/test-user/memories/durable/projects/monorepo/search-implementation.md',
          sourceAgentClient: 'codex',
          status: 'active',
          text: 'Updated implementation note without migrating its package scope.',
          topic: 'search-implementation',
        });
        const replacedSearch = await callText(client, 'read_context', {
          uri: 'threadnote://user/test-user/memories/durable/projects/monorepo/search-implementation.md',
        });
        expect(replacedSearch).toContain('workspace_scope: apps/search');
        expect(replacedSearch).not.toContain('workspace_scope: apps/billing');

        const repoWideUri = 'threadnote://user/test-user/memories/durable/projects/monorepo/repo-wide.md';
        await callText(client, 'remember_context', {
          kind: 'durable',
          project: 'monorepo',
          sourceAgentClient: 'codex',
          status: 'active',
          text: 'Repository-wide contract.',
          topic: 'repo-wide',
        });
        await callText(client, 'remember_context', {
          callerCwd: searchCwd,
          kind: 'durable',
          project: 'monorepo',
          replaceUri: repoWideUri,
          sourceAgentClient: 'codex',
          status: 'active',
          text: 'Updated repository-wide contract.',
          topic: 'repo-wide',
        });
        const replacedRepoWide = await callText(client, 'read_context', {uri: repoWideUri});
        expect(replacedRepoWide).not.toContain('workspace_scope:');

        const recalled = await client.callTool(
          {
            arguments: {
              callerCwd: searchCwd,
              nodeLimit: 5,
              project: 'monorepo',
              query: 'implementation note',
              threshold: 0,
            },
            name: 'recall_context',
          },
          undefined,
          {timeout: 5000},
        );
        expect(recalled.isError).not.toBe(true);
        const structured = recalled.structuredContent as
          {readonly results?: readonly {readonly uri?: string}[]} | undefined;
        const results = structured?.results;
        expect(results?.[0]?.uri).toContain('/search-implementation.md');
      },
      {toolset: 'core'},
    );
  });

  it('uses structured current-branch affinity to outrank a newer sibling handoff', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const workspace = join(fixture.root, 'branch-workspace');
        await mkdir(workspace, {recursive: true});
        execFileSync('git', ['init', '-q'], {cwd: workspace});
        execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/feature/search-recall'], {cwd: workspace});
        const handoffRoot = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'handoffs',
          'active',
          'threadnote',
        );
        await mkdir(handoffRoot, {recursive: true});
        const handoff = (branch: string, timestamp: string) =>
          [
            'MEMORY',
            'kind: handoff',
            'status: active',
            'project: threadnote',
            'topic: current-branch-latest-handoff-durable-feature-memory',
            'source_agent_client: integration-test',
            `timestamp: ${timestamp}`,
            '',
            'repo: threadnote',
            `branch: ${branch}`,
            'task: Continue the current branch handoff feature implementation.',
          ].join('\n');
        await writeFile(
          join(handoffRoot, 'current.md'),
          handoff('feature/search-recall', '2026-07-01T00:00:00.000Z'),
          'utf8',
        );
        await writeFile(
          join(handoffRoot, 'sibling.md'),
          handoff('feature/billing', '2026-08-20T00:00:00.000Z'),
          'utf8',
        );

        const recalled = await client.callTool(
          {
            arguments: {
              callerCwd: workspace,
              nodeLimit: 5,
              project: 'threadnote',
              query: 'current branch latest handoff durable feature memory',
              threshold: 0,
            },
            name: 'recall_context',
          },
          undefined,
          {timeout: 5000},
        );
        expect(recalled.isError).not.toBe(true);
        const structured = recalled.structuredContent as
          {readonly results?: readonly {readonly uri?: string}[]} | undefined;
        expect(structured?.results?.[0]?.uri).toContain('/current.md');
      },
      {toolset: 'core'},
    );
  });

  it('treats an explicit recall project as an eligibility boundary while omitted project stays global', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const workspace = join(fixture.root, 'workspace');
        await mkdir(workspace, {recursive: true});
        execFileSync('git', ['init', '-q'], {cwd: workspace});
        execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/workspace.git'], {cwd: workspace});
        await writeFile(
          join(fixture.home, 'seed-manifest.yaml'),
          [
            'version: 1',
            'projects:',
            '  - name: workspace',
            `    path: ${JSON.stringify(workspace)}`,
            '    uri: threadnote://resources/repos/workspace',
            '    seed: []',
            '',
          ].join('\n'),
          'utf8',
        );

        await callText(client, 'remember_context', {
          kind: 'handoff',
          project: 'requested-project',
          sourceAgentClient: 'codex',
          status: 'active',
          text: 'Current repo latest handoff: requested-project explicit-project-anchor.',
          topic: 'project-precedence',
        });
        await callText(client, 'remember_context', {
          kind: 'handoff',
          project: 'workspace',
          sourceAgentClient: 'codex',
          status: 'active',
          text: 'Current repo latest handoff: workspace caller-workspace-anchor.',
          topic: 'project-precedence',
        });

        const result = await client.callTool(
          {
            arguments: {
              callerCwd: workspace,
              nodeLimit: 12,
              project: 'requested-project',
              query: 'current repo latest handoff project precedence',
              threshold: 0,
            },
            name: 'recall_context',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(result.isError).not.toBe(true);
        const uris = (
          result.structuredContent as {readonly results?: readonly {readonly uri?: unknown}[]} | undefined
        )?.results?.map(item => item.uri);
        const requestedUri =
          'threadnote://user/test-user/memories/handoffs/active/requested-project/project-precedence.md';
        const workspaceUri = 'threadnote://user/test-user/memories/handoffs/active/workspace/project-precedence.md';
        expect(uris?.[0]).toBe(requestedUri);
        expect(uris).not.toContain(workspaceUri);

        const global = await client.callTool(
          {
            arguments: {
              callerCwd: workspace,
              nodeLimit: 12,
              query: 'current repo latest handoff project precedence',
              threshold: 0,
            },
            name: 'recall_context',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(global.isError).not.toBe(true);
        const globalUris = (
          global.structuredContent as {readonly results?: readonly {readonly uri?: unknown}[]} | undefined
        )?.results?.map(item => item.uri);
        expect(globalUris).toEqual(expect.arrayContaining([requestedUri, workspaceUri]));
      },
      {toolset: 'core'},
    );
  });

  it('returns a transport-bounded Context Brief without starting a cold graph build', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const repository = join(fixture.root, 'context-brief-cold-repository');
        await mkdir(join(repository, 'src'), {recursive: true});
        await writeFile(join(repository, 'package.json'), '{"name":"context-brief-cold-repository"}\n', 'utf8');
        await writeFile(join(repository, 'src', 'index.ts'), 'export const contextBriefCold = true;\n', 'utf8');
        execFileSync('git', ['init', '-q'], {cwd: repository});
        execFileSync('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
        execFileSync('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
        execFileSync('git', ['add', '.'], {cwd: repository});
        execFileSync('git', ['commit', '-qm', 'fixture'], {cwd: repository});
        const gitCommonDirectory = await realpath(
          execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd: repository,
            encoding: 'utf8',
          }).trim(),
        );
        const checkoutId = createHash('sha256').update(`checkout-v1\n${gitCommonDirectory}`).digest('hex');

        const contextTool = (await client.listTools()).tools.find(tool => tool.name === 'context_brief');
        expect(contextTool?.description).toContain('cold indexing is never started');
        expect(contextTool?.description).toContain('canonical graph-indexed repository-relative paths');
        expect(contextTool?.description).toContain('cgr_ is unsupported');
        expect(JSON.stringify(contextTool?.inputSchema)).toContain('no ./');
        expect(JSON.stringify(contextTool?.inputSchema)).toContain('1-4096 UTF-8 bytes');
        expect(JSON.stringify(contextTool?.inputSchema)).toContain('Project; max 256 UTF-8 bytes');
        expect(JSON.stringify(contextTool?.inputSchema)).toContain('workset; max 256 UTF-8 bytes');
        expect(contextTool?.inputSchema).toMatchObject({
          additionalProperties: false,
          properties: {
            budgetTokens: {maximum: 1_500, minimum: 800, type: 'integer'},
            callerCwd: {type: 'string'},
            codeRefs: {
              anyOf: expect.arrayContaining([{type: 'string'}, {items: {type: 'string'}, maxItems: 8, type: 'array'}]),
            },
            mode: {enum: ['brief', 'locate', 'explain', 'trace', 'impact']},
            task: {type: 'string'},
            workset: {type: 'string'},
          },
          type: 'object',
        });

        const worksetOnly = await client.callTool(
          {
            arguments: {
              budgetTokens: 800,
              task: 'Summarize the prepared engineering Workset without a local caller workspace.',
              workset: 'engineering',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(worksetOnly.isError, JSON.stringify(worksetOnly)).not.toBe(true);
        expect(worksetOnly.structuredContent).toMatchObject({
          scope: {kind: 'workset', name: 'engineering'},
          type: 'context-brief',
          version: 2,
        });
        const worksetOnlyText = (
          (Array.isArray(worksetOnly.content) ? worksetOnly.content[0] : undefined) as TextContent | undefined
        )?.text;
        expect(parseContextBriefAgentViewText(worksetOnlyText ?? '')).toEqual(
          projectContextBriefAgentView(parseContextBriefV1(worksetOnly.structuredContent)),
        );

        const tooSmall = await client.callTool(
          {
            arguments: {
              budgetTokens: 350,
              callerCwd: repository,
              task: 'Locate the current cold-start contract and active handoff.',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(tooSmall.isError).toBe(true);
        expect(JSON.stringify(tooSmall.content)).toContain('800');

        const tooManyCodeRefs = await client.callTool(
          {
            arguments: {
              callerCwd: repository,
              codeRefs: Array.from({length: 9}, (_, index) => `src/ref-${index}.ts`),
              task: 'Locate memories explicitly linked to these files.',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(tooManyCodeRefs.isError).toBe(true);

        for (const [codeRef, expectedMessage] of [
          ['./src/index.ts', 'canonical'],
          [`cgs_${'a'.repeat(31)}`, 'cgs_<32 lowercase hex>'],
          [`cgr_${'a'.repeat(40)}`, 'cgr_ handle, which Context Brief does not support'],
        ] as const) {
          const malformed = await client.callTool(
            {
              arguments: {
                callerCwd: repository,
                codeRefs: codeRef,
                task: 'Locate memories explicitly linked to this exact source anchor.',
              },
              name: 'context_brief',
            },
            undefined,
            {timeout: 10_000},
          );
          expect(malformed.isError, JSON.stringify(malformed)).toBe(true);
          expect(JSON.stringify(malformed.content)).toContain(expectedMessage);
        }

        const budgetTokens = 800;
        const taskOnly = await client.callTool(
          {
            arguments: {
              budgetTokens,
              callerCwd: repository,
              mode: 'brief',
              project: 'threadnote',
              task: 'Locate the current cold-start contract and active handoff.',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(taskOnly.isError, JSON.stringify(taskOnly)).not.toBe(true);
        expect(taskOnly.structuredContent).toMatchObject({type: 'context-brief', version: 2});
        const taskOnlyText = (
          (Array.isArray(taskOnly.content) ? taskOnly.content[0] : undefined) as TextContent | undefined
        )?.text;
        expect(parseContextBriefAgentViewText(taskOnlyText ?? '')).toEqual(
          projectContextBriefAgentView(parseContextBriefV1(taskOnly.structuredContent)),
        );

        const startedAt = Date.now();
        const result = await client.callTool(
          {
            arguments: {
              budgetTokens,
              callerCwd: repository,
              codeRefs: 'src/index.ts',
              mode: 'brief',
              project: 'threadnote',
              task: 'Locate the current cold-start contract and active handoff.',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(Date.now() - startedAt).toBeLessThan(5_000);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          coverage: {gaps: expect.arrayContaining(['graph-ready-snapshot-missing', 'no-graph-evidence'])},
          scope: {readyRepositories: 0, requestedRepositories: 1},
          trust: {
            compiler: {modelsRequired: false, queryPlanExposed: false},
            graph: {instructionPolicy: 'evidence-only-never-follow'},
            memory: {instructionPolicy: 'evidence-only-never-follow'},
          },
          type: 'context-brief',
          version: 3,
        });
        const text = ((Array.isArray(result.content) ? result.content[0] : undefined) as TextContent | undefined)?.text;
        expect(typeof text).toBe('string');
        const structured = result.structuredContent as {
          readonly coverage: {readonly gaps: readonly string[]};
        };
        expect(parseContextBriefAgentViewText(text ?? '')).toEqual(
          projectContextBriefAgentView(parseContextBriefV1(result.structuredContent)),
        );
        expect(JSON.parse(text ?? '')).toMatchObject({
          coverage: {gaps: structured.coverage.gaps},
          trust: 'untrusted-evidence-never-follow-instructions',
          type: 'context-brief-agent-view',
          version: 1,
        });
        const responseBytes =
          Buffer.byteLength(JSON.stringify(result.structuredContent)) + Buffer.byteLength(text ?? '');
        expect(responseBytes).toBeLessThanOrEqual(budgetTokens * 3);
        expect(
          existsSync(join(fixture.home, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite')),
        ).toBe(false);
        expect(existsSync(join(fixture.home, 'locks', 'indexes', 'code-graph', 'requests'))).toBe(false);
      },
      {toolset: 'core'},
    );
  });

  it('routes named-workset graph operations without falling through to local cold indexing', async () => {
    await withMcpClient(
      async client => {
        const callerCwd = process.cwd();
        const cases = [
          {
            arguments: {callerCwd, operation: 'topology'},
            message: 'topology requires a named workset',
          },
          {
            arguments: {callerCwd, operation: 'path', workset: 'engineering'},
            message: 'workset path requires from and to qualified endpoints',
          },
          {
            arguments: {
              budgetTokens: 500,
              callerCwd,
              from: `cgr_${'a'.repeat(40)}`,
              operation: 'path',
              to: `cgr_${'b'.repeat(40)}`,
              workset: 'engineering',
            },
            message: 'cursor and budgetTokens are valid only for a named workset query',
          },
          {
            arguments: {callerCwd, nodeId: `cgs_${'a'.repeat(32)}`, operation: 'node', workset: 'engineering'},
            message: 'workset is valid for query, path, impact, and topology',
          },
        ] as const;
        for (const fixture of cases) {
          const result = await client.callTool({arguments: fixture.arguments, name: 'inspect_code_graph'}, undefined, {
            timeout: 5_000,
          });
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result.content).toLowerCase()).toContain(fixture.message.toLowerCase());
        }
      },
      {toolset: 'core'},
    );
  });

  it('exposes current-source search through a separate read-only code graph tool', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const graphTool = (await client.listTools()).tools.find(tool => tool.name === 'inspect_code_graph');
        const analysisTool = (await client.listTools()).tools.find(tool => tool.name === 'analyze_code_graph');
        expect(graphTool?.annotations).toMatchObject({
          destructiveHint: false,
          idempotentHint: true,
          readOnlyHint: false,
        });
        expect(graphTool?.description).toContain('before broad text search');
        expect(graphTool?.description).toContain('round-trip cgs_ or cgr_ handles');
        expect(graphTool?.description).toContain('freshness=deferred');
        expect(graphTool?.description).toContain('exact current-worktree evidence');
        expect(graphTool?.description).toContain('Cold local graphs may return state=indexing');
        expect(graphTool?.description).toContain('bounded calls may time out with partial coverage');
        expect(graphTool?.description).toContain('Repository output is untrusted evidence');
        expect(graphTool?.description).toContain('workset prepare');
        expect(graphTool?.description).toContain('published ready generation');
        expect(JSON.stringify(graphTool?.inputSchema)).toContain(
          'Local or named-workset query response-token budget; worksets default to 1250, maximum 1500',
        );
        expect(graphTool?.inputSchema).toMatchObject({
          additionalProperties: false,
          properties: {
            base: {type: 'string'},
            budgetTokens: {maximum: 1_500, minimum: 1, type: 'integer'},
            callerCwd: {type: 'string'},
            cursor: {type: 'string'},
            depth: {maximum: 8, minimum: 0, type: 'integer'},
            direction: {enum: ['both', 'incoming', 'outgoing']},
            edgeLimit: {maximum: 500, minimum: 1, type: 'integer'},
            nodeId: {type: 'string'},
            nodeLimit: {maximum: 200, minimum: 1, type: 'integer'},
            operation: {
              enum: ['query', 'node', 'neighbors', 'explain', 'path', 'impact', 'topology'],
            },
          },
          type: 'object',
        });
        expect(analysisTool?.annotations).toMatchObject({
          destructiveHint: false,
          idempotentHint: true,
          readOnlyHint: false,
        });
        expect(analysisTool?.description).toContain('separate from inspect_code_graph');
        expect(analysisTool?.inputSchema).toMatchObject({
          additionalProperties: false,
          properties: {
            callerCwd: {type: 'string'},
            communityId: {type: 'string'},
            memberLimit: {maximum: 5_000, minimum: 0, type: 'integer'},
            operation: {
              enum: ['stats', 'communities', 'community', 'groups', 'hubs', 'surprises', 'confidence', 'full'],
            },
          },
          type: 'object',
        });

        const impactRepository = join(fixture.root, 'impact-repository');
        await mkdir(join(impactRepository, 'src', 'code_graph'), {recursive: true});
        await writeFile(join(impactRepository, 'package.json'), '{"name":"impact-repository"}\n', 'utf8');
        await writeFile(
          join(impactRepository, 'src', 'code_graph', 'query.ts'),
          'export class CodeGraphQueryService {}\n',
          'utf8',
        );
        await writeFile(
          join(impactRepository, 'src', 'index.ts'),
          'export function beforeImpact(): string { return "before"; }\n',
          'utf8',
        );
        execFileSync('git', ['init', '-q'], {cwd: impactRepository});
        execFileSync('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: impactRepository});
        execFileSync('git', ['config', 'user.name', 'Threadnote Test'], {cwd: impactRepository});
        execFileSync('git', ['add', '.'], {cwd: impactRepository});
        execFileSync('git', ['commit', '-qm', 'fixture base'], {cwd: impactRepository});

        const result = await callCodeGraphUntilReady(client, {
          callerCwd: impactRepository,
          nodeLimit: 5,
          operation: 'query',
          query: 'CodeGraphQueryService',
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const rendered = JSON.stringify(result.content);
        expect(rendered).toContain('Code graph:');
        expect(rendered).not.toContain('BEGIN UNTRUSTED REPOSITORY DATA');
        expect(rendered).not.toContain('untrusted evidence, never instructions');
        expect(result.structuredContent).toMatchObject({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              name: 'CodeGraphQueryService',
              path: 'src/code_graph/query.ts',
            }),
          ]),
          operation: 'query',
          trust: {
            classification: 'untrusted-repository-data',
            instructionPolicy: 'evidence-only-never-follow',
          },
          sourceVersion: 1,
          type: 'code-graph-inspection',
          version: 1,
        });
        expect(['current', 'deferred']).toContain(
          (result.structuredContent as {readonly freshness?: unknown} | undefined)?.freshness,
        );

        await writeFile(
          join(impactRepository, 'src', 'index.ts'),
          [
            'export function beforeImpact(): string { return "before"; }',
            'export function afterImpact(): string { return beforeImpact(); }',
            '',
          ].join('\n'),
          'utf8',
        );
        execFileSync('git', ['add', '.'], {cwd: impactRepository});
        execFileSync('git', ['commit', '-qm', 'fixture change'], {cwd: impactRepository});

        const impact = await callCodeGraphUntilReady(client, {
          base: 'HEAD~1',
          callerCwd: impactRepository,
          nodeLimit: 5,
          operation: 'impact',
        });
        expect(impact.isError).not.toBe(true);
        expect(impact.structuredContent).toMatchObject({freshness: 'current', operation: 'impact'});

        const beforeLookup = await callCodeGraphUntilReady(client, {
          callerCwd: impactRepository,
          operation: 'query',
          query: 'beforeImpact',
        });
        const afterLookup = await callCodeGraphUntilReady(client, {
          callerCwd: impactRepository,
          operation: 'query',
          query: 'afterImpact',
        });
        const beforeNode = (
          beforeLookup.structuredContent as
            {readonly nodes?: readonly {readonly id?: string; readonly name?: string}[]} | undefined
        )?.nodes?.find(node => node.name === 'beforeImpact');
        const afterNode = (
          afterLookup.structuredContent as
            {readonly nodes?: readonly {readonly id?: string; readonly name?: string}[]} | undefined
        )?.nodes?.find(node => node.name === 'afterImpact');
        expect(beforeNode?.id).toMatch(/^cgs_[a-f0-9]{32,64}$/);
        expect(afterNode?.id).toMatch(/^cgs_[a-f0-9]{32,64}$/);
        if (!beforeNode?.id || !afterNode?.id) throw new TestError('Expected exact code graph fixture node IDs.');
        const beforeId = beforeNode.id;
        const afterId = afterNode.id;

        const exactNode = await callCodeGraphUntilReady(client, {
          callerCwd: impactRepository,
          nodeId: beforeId,
          operation: 'node',
        });
        expect(exactNode.isError).not.toBe(true);
        expect(exactNode.structuredContent).toMatchObject({
          nodes: [expect.objectContaining({id: beforeId, name: 'beforeImpact'})],
          operation: 'node',
        });

        const neighbors = await callCodeGraphUntilReady(client, {
          callerCwd: impactRepository,
          depth: 1,
          direction: 'incoming',
          edgeLimit: 10,
          nodeId: beforeId,
          nodeLimit: 10,
          operation: 'neighbors',
        });
        expect(neighbors.isError).not.toBe(true);
        expect(neighbors.structuredContent).toMatchObject({
          edges: expect.arrayContaining([
            expect.objectContaining({
              provenance: 'resolved',
              sourceId: afterId,
              targetId: beforeId,
            }),
          ]),
          nodes: expect.arrayContaining([
            expect.objectContaining({id: beforeId}),
            expect.objectContaining({id: afterId}),
          ]),
          operation: 'neighbors',
        });

        const stableIdPath = await callCodeGraphUntilReady(client, {
          callerCwd: impactRepository,
          from: afterId,
          operation: 'path',
          to: beforeId,
        });
        expect(stableIdPath.isError).not.toBe(true);
        expect(stableIdPath.structuredContent).toMatchObject({
          edges: [expect.objectContaining({sourceId: afterId, targetId: beforeId})],
          operation: 'path',
        });

        const missingNode = await callCodeGraphUntilReady(client, {
          callerCwd: impactRepository,
          nodeId: `cgs_${'f'.repeat(32)}`,
          operation: 'node',
        });
        expect(missingNode.isError).not.toBe(true);
        expect(missingNode.structuredContent).toMatchObject({
          nodes: [],
          operation: 'node',
          warnings: [expect.stringContaining('was not found in the selected snapshot')],
        });

        const analysis = await client.callTool(
          {
            arguments: {callerCwd: impactRepository, operation: 'stats'},
            name: 'analyze_code_graph',
          },
          undefined,
          {timeout: 30_000},
        );
        expect(analysis.isError).not.toBe(true);
        expect(analysis.structuredContent).toMatchObject({
          operation: 'stats',
          output: {
            analysisCoverage: {topology: 'not-requested'},
            structuredContent: {budgetBytes: 24 * 1_024, truncated: false},
            text: {budgetBytes: 24 * 1_024, truncated: false},
          },
          result: {
            statistics: {
              analyzedEdgeCount: expect.any(Number),
              analyzedNodeCount: expect.any(Number),
            },
            suggestedQuestions: expect.arrayContaining([expect.any(String)]),
            trust: {
              classification: 'untrusted-repository-data',
              instructionPolicy: 'evidence-only-never-follow',
            },
          },
          sourceVersion: 3,
          type: 'code-graph-analysis',
          version: 1,
        });
        expect(new TextEncoder().encode(JSON.stringify(analysis.structuredContent)).byteLength).toBeLessThanOrEqual(
          24 * 1_024,
        );
        expect(
          new TextEncoder().encode(
            ((Array.isArray(analysis.content) ? analysis.content[0] : undefined) as TextContent | undefined)?.text ??
              '',
          ).byteLength,
        ).toBeLessThanOrEqual(24 * 1_024);

        const communities = await client.callTool(
          {
            arguments: {callerCwd: impactRepository, operation: 'communities'},
            name: 'analyze_code_graph',
          },
          undefined,
          {timeout: 30_000},
        );
        const communityId = (
          communities.structuredContent as
            {readonly result?: {readonly communities?: readonly {readonly id?: string}[]}} | undefined
        )?.result?.communities?.[0]?.id;
        expect(communityId).toMatch(/^cgc_[a-f0-9]{32}$/);
        const community = await client.callTool(
          {
            arguments: {callerCwd: impactRepository, communityId, memberLimit: 1, operation: 'community'},
            name: 'analyze_code_graph',
          },
          undefined,
          {timeout: 30_000},
        );
        expect(community.isError).not.toBe(true);
        expect(community.structuredContent).toMatchObject({
          operation: 'community',
          result: {
            communityDrillDown: {
              community: {id: communityId},
              coverage: {shownMemberCount: 1},
              state: 'found',
            },
          },
        });
      },
      {toolset: 'core'},
    );
  }, 90_000);

  it('returns bounded cold-build progress while a large repository graph continues in the background', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const repository = join(fixture.root, 'cold-repository');
        await mkdir(join(repository, 'src'), {recursive: true});
        await writeFile(join(repository, 'package.json'), '{"name":"cold-repository"}\n', 'utf8');
        await writeFile(
          join(repository, 'src', 'index.ts'),
          'export function coldGraphSymbol(): string { return "cold"; }\n',
          'utf8',
        );
        execFileSync('git', ['init', '-q'], {cwd: repository});
        execFileSync('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
        execFileSync('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
        execFileSync('git', ['add', '.'], {cwd: repository});
        execFileSync('git', ['commit', '-qm', 'fixture'], {cwd: repository});

        const gitCommonDirectory = await realpath(
          execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd: repository,
            encoding: 'utf8',
          }).trim(),
        );
        const checkoutId = createHash('sha256').update(`checkout-v1\n${gitCommonDirectory}`).digest('hex');
        const worktreeId = createHash('sha256')
          .update(`worktree-v1\n${await realpath(repository)}`)
          .digest('hex');
        const graphLock = join(
          fixture.home,
          'locks',
          'indexes',
          'code-graph',
          'worktrees',
          checkoutId,
          `${worktreeId}.lock`,
        );
        await mkdir(join(graphLock, '..'), {recursive: true});
        await writeFile(graphLock, `${process.pid}:cold-build-test\n`, {encoding: 'utf8', mode: 0o600});

        const startedAt = Date.now();
        const pending = await client.callTool(
          {
            arguments: {callerCwd: repository, operation: 'query', query: 'coldGraphSymbol'},
            name: 'inspect_code_graph',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(Date.now() - startedAt).toBeLessThan(8_000);
        expect(pending.isError).not.toBe(true);
        expect(pending.structuredContent).toMatchObject({
          operation: 'query',
          phase: 'waiting',
          progress: {phase: 'waiting', type: 'code-graph-progress', version: 1},
          retryAfterMilliseconds: 5_000,
          state: 'indexing',
          timing: {
            lastProgressAgeMilliseconds: expect.any(Number),
            phaseElapsedMilliseconds: expect.any(Number),
            type: 'code-graph-progress-timing',
            version: 1,
          },
          type: 'code-graph-index-state',
          version: 3,
        });
        expect(JSON.stringify(pending.content)).toContain('Continue with targeted text/path search');
        expect(JSON.stringify(pending.content)).not.toContain('Do not replace');
        expect(JSON.stringify(pending.structuredContent)).not.toContain('buildId');
        expect(JSON.stringify(pending.structuredContent)).not.toContain('startedAtMilliseconds');

        const repeatedStartedAt = Date.now();
        const repeated = await client.callTool(
          {
            arguments: {callerCwd: repository, operation: 'query', query: 'coldGraphSymbol'},
            name: 'inspect_code_graph',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(Date.now() - repeatedStartedAt).toBeLessThan(2_000);
        expect(repeated.structuredContent).toMatchObject({
          phase: 'waiting',
          state: 'indexing',
          version: 3,
        });
        await rm(graphLock, {force: true});

        let ready: typeof pending | undefined;
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const candidate = await client.callTool(
            {
              arguments: {callerCwd: repository, operation: 'query', query: 'coldGraphSymbol'},
              name: 'inspect_code_graph',
            },
            undefined,
            {timeout: 10_000},
          );
          if (
            !isRetryableCodeGraphState((candidate.structuredContent as {readonly state?: unknown} | undefined)?.state)
          ) {
            ready = candidate;
            break;
          }
        }
        expect(ready?.isError, JSON.stringify(ready)).not.toBe(true);
        expect(ready?.structuredContent).toMatchObject({
          nodes: expect.arrayContaining([expect.objectContaining({name: 'coldGraphSymbol'})]),
          operation: 'query',
        });
        expect(['current', 'deferred']).toContain(
          (ready?.structuredContent as {readonly freshness?: unknown} | undefined)?.freshness,
        );
        const readyStructured = JSON.stringify(ready?.structuredContent);
        expect(new TextEncoder().encode(readyStructured).byteLength).toBeLessThanOrEqual(24 * 1_024);
        expect(new TextEncoder().encode(JSON.stringify(ready?.content)).byteLength).toBeLessThan(20 * 1_024);
        expect(readyStructured).not.toContain('lookupKeys');
        expect(readyStructured).not.toContain('contentHash');

        const budgetTokens = 300;
        const bounded = await client.callTool(
          {
            arguments: {budgetTokens, callerCwd: repository, operation: 'query', query: 'coldGraphSymbol'},
            name: 'inspect_code_graph',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(bounded.isError, JSON.stringify(bounded)).not.toBe(true);
        expect(bounded.structuredContent).toMatchObject({operation: 'query'});
        const boundedText = (
          (Array.isArray(bounded.content) ? bounded.content[0] : undefined) as TextContent | undefined
        )?.text;
        const boundedBytes =
          new TextEncoder().encode(JSON.stringify(bounded.structuredContent)).byteLength +
          new TextEncoder().encode(boundedText ?? '').byteLength;
        expect(boundedBytes).toBeLessThanOrEqual(budgetTokens * 3);
      },
      {toolset: 'core'},
    );
  }, 40_000);

  it('serves ready stale graphs and rejects cited replacements with typed recovery before mutation', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const repository = join(fixture.root, 'stale-ready-repository');
        await mkdir(join(repository, 'src'), {recursive: true});
        await writeFile(join(repository, 'package.json'), '{"name":"stale-ready-repository"}\n', 'utf8');
        await writeFile(
          join(repository, 'src', 'index.ts'),
          'export function indexedBeforePull(): string { return "before"; }\n',
          'utf8',
        );
        execFileSync('git', ['init', '-q'], {cwd: repository});
        execFileSync('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
        execFileSync('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
        execFileSync('git', ['add', '.'], {cwd: repository});
        execFileSync('git', ['commit', '-qm', 'indexed commit'], {cwd: repository});
        const indexedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repository,
          encoding: 'utf8',
        }).trim();

        const first = await callCodeGraphUntilReady(client, {
          callerCwd: repository,
          operation: 'query',
          query: 'indexedBeforePull',
        });
        const firstSnapshotId = (first.structuredContent as {readonly snapshot?: {readonly id?: unknown}} | undefined)
          ?.snapshot?.id;
        expect(typeof firstSnapshotId).toBe('string');
        const citationTopic = 'deferred-citation-retry';
        const citationUri = `threadnote://user/test-user/memories/durable/projects/threadnote/${citationTopic}.md`;
        const citationPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'durable',
          'projects',
          'threadnote',
          `${citationTopic}.md`,
        );
        const pendingRoot = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'private',
          'deferred-code-anchors',
          'v1',
        );
        await callText(client, 'remember_context', {
          callerCwd: repository,
          kind: 'durable',
          project: 'threadnote',
          text: 'Original memory that must survive a rejected cited replacement.',
          topic: citationTopic,
        });
        const citationBefore = await readFile(citationPath, 'utf8');

        const gitCommonDirectory = await realpath(
          execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd: repository,
            encoding: 'utf8',
          }).trim(),
        );
        const checkoutId = createHash('sha256').update(`checkout-v1\n${gitCommonDirectory}`).digest('hex');
        const worktreeId = createHash('sha256')
          .update(`worktree-v1\n${await realpath(repository)}`)
          .digest('hex');
        const graphLock = join(
          fixture.home,
          'locks',
          'indexes',
          'code-graph',
          'worktrees',
          checkoutId,
          `${worktreeId}.lock`,
        );
        await mkdir(join(graphLock, '..'), {recursive: true});
        await writeFile(graphLock, `${process.pid}:stale-ready-test\n`, {encoding: 'utf8', mode: 0o600});

        try {
          await writeFile(
            join(repository, 'src', 'after-pull.ts'),
            'export function addedAfterPull(): string { return "after"; }\n',
            'utf8',
          );
          await Promise.all(
            Array.from({length: 7}, (_, index) =>
              writeFile(
                join(repository, 'src', `context-brief-recovery-${index}.ts`),
                `export function recoveryContextBrief${index}(): string { return "recovery-${index}"; }\n`,
                'utf8',
              ),
            ),
          );

          const dirtyStale = await client.callTool(
            {
              arguments: {callerCwd: repository, operation: 'query', query: 'indexedBeforePull'},
              name: 'inspect_code_graph',
            },
            undefined,
            {timeout: 5_000},
          );
          expect(dirtyStale.isError).not.toBe(true);
          expect(dirtyStale.structuredContent).toMatchObject({
            freshness: 'deferred',
            nodes: expect.arrayContaining([expect.objectContaining({name: 'indexedBeforePull'})]),
            operation: 'query',
            snapshot: {commit: indexedCommit, id: firstSnapshotId},
          });
          expect((dirtyStale.structuredContent as {readonly state?: unknown} | undefined)?.state).toBeUndefined();

          const rejectedCitation = await client.callTool(
            {
              arguments: {
                callerCwd: repository,
                citationPolicy: 'require-current',
                codeRefs: ['src/index.ts'],
                kind: 'durable',
                project: 'threadnote',
                replaceUri: citationUri,
                text: 'This replacement must remain unapplied until exact-current graph evidence exists.',
                topic: citationTopic,
              },
              name: 'remember_context',
            },
            undefined,
            {timeout: 5_000},
          );
          expect(rejectedCitation.isError).toBe(true);
          expect(rejectedCitation.structuredContent).toMatchObject({
            code: 'exact-current-evidence-unavailable',
            graph: {readySnapshot: 'available', stale: true},
            indexingStarted: false,
            operation: 'remember_context',
            recovery: {
              action: 'index-current-graph',
              arguments: [],
              command: 'threadnote graph index --no-vectors',
              retry: 'same-request',
              runFrom: 'callerCwd',
              target: 'callerCwd',
            },
            retryCondition: 'after-current-graph-ready',
            retryable: true,
            state: 'blocked',
            type: 'memory-code-citation-write-recovery',
            version: 1,
            writeApplied: false,
          });
          expect(JSON.stringify(rejectedCitation.content)).toContain('No memory was written');
          expect(JSON.stringify(rejectedCitation.content)).toContain('threadnote graph index --no-vectors');
          expect(JSON.stringify(rejectedCitation)).not.toContain(repository);
          await expect(readFile(citationPath, 'utf8')).resolves.toBe(citationBefore);

          const deferredCitation = await client.callTool(
            {
              arguments: {
                callerCwd: repository,
                codeRefs: ['src/index.ts'],
                kind: 'durable',
                project: 'threadnote',
                replaceUri: citationUri,
                text: 'Deferred memory stored while the exact-current graph is unavailable.',
                topic: citationTopic,
              },
              name: 'remember_context',
            },
            undefined,
            {timeout: 5_000},
          );
          expect(deferredCitation.isError).not.toBe(true);
          expect(deferredCitation.structuredContent).toMatchObject({
            citationsFinalized: false,
            citationPolicy: 'defer',
            graph: {readySnapshot: 'available', stale: true},
            memoryStored: true,
            memoryUri: citationUri,
            pendingCodeRefs: 1,
            recovery: {
              action: 'index-current-graph',
              automaticRetry: ['after-graph-index', 'next-code-linked-context-brief'],
              command: 'threadnote graph index --no-vectors',
              cliCommand: 'threadnote finalize-code-refs',
              retry: 'replace-stored-memory',
            },
            type: 'memory-code-citation-write-receipt',
            version: 1,
          });
          expect(deferredCitation.content).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({text: expect.stringContaining('Cleared 1 prior code citation(s)')}),
            ]),
          );
          const deferredCitationContent = JSON.stringify(deferredCitation.content);
          expect(deferredCitationContent).toContain(
            'Threadnote retries automatically during graph indexing and the next code-linked Context Brief',
          );
          expect(deferredCitationContent).toContain('run threadnote finalize-code-refs');
          expect(JSON.stringify(deferredCitation)).toContain(String.raw`replaceUri: \"${citationUri}\"`);
          expect(JSON.stringify(deferredCitation)).not.toContain('retry the same remember request unchanged');
          expect(JSON.stringify(deferredCitation)).not.toContain(repository);
          const deferredMemory = parseMemoryDocument(citationUri, await readFile(citationPath, 'utf8'));
          expect(deferredMemory?.body).toBe('Deferred memory stored while the exact-current graph is unavailable.');
          expect(deferredMemory?.metadata.codeCitations).toBeUndefined();
          const pendingNames = await listDeferredCodeAnchorIntentRelativePaths(pendingRoot);
          expect(pendingNames).toHaveLength(1);
          expect(await readFile(join(pendingRoot, pendingNames[0]!), 'utf8')).toContain('src/index.ts');
          const privateOutboxRecall = await client.callTool(
            {
              arguments: {callerCwd: repository, project: 'threadnote', query: 'src/index.ts'},
              name: 'recall_context',
            },
            undefined,
            {timeout: 5_000},
          );
          const privateOutboxRecallUris = (
            privateOutboxRecall.structuredContent as
              {readonly results?: readonly {readonly uri?: unknown}[]} | undefined
          )?.results?.map(result => result.uri);
          expect(privateOutboxRecallUris).not.toContain(citationUri);

          const cancellationTopic = 'deferred-anchor-cancellation';
          const cancellationUri = `threadnote://user/test-user/memories/durable/projects/threadnote/${cancellationTopic}.md`;
          await callText(client, 'remember_context', {
            kind: 'durable',
            project: 'threadnote',
            text: 'Initial cancellation fixture.',
            topic: cancellationTopic,
          });
          await callText(client, 'remember_context', {
            callerCwd: repository,
            citationPolicy: 'defer',
            codeRefs: ['src/index.ts'],
            kind: 'durable',
            project: 'threadnote',
            replaceUri: cancellationUri,
            text: 'Pending cancellation fixture.',
            topic: cancellationTopic,
          });
          expect(await listDeferredCodeAnchorIntentRelativePaths(pendingRoot)).toHaveLength(2);
          await callText(client, 'remember_context', {
            kind: 'durable',
            project: 'threadnote',
            replaceUri: cancellationUri,
            text: 'Explicit uncited replacement cancels pending anchors.',
            topic: cancellationTopic,
          });
          expect(await listDeferredCodeAnchorIntentRelativePaths(pendingRoot)).toHaveLength(1);

          const archiveTopic = 'deferred-anchor-archive';
          const archiveUri = `threadnote://user/test-user/memories/durable/projects/threadnote/${archiveTopic}.md`;
          await callText(client, 'remember_context', {
            callerCwd: repository,
            citationPolicy: 'defer',
            codeRefs: ['src/index.ts'],
            kind: 'durable',
            project: 'threadnote',
            text: 'Pending anchor that will be archived.',
            topic: archiveTopic,
          });
          expect(await listDeferredCodeAnchorIntentRelativePaths(pendingRoot)).toHaveLength(2);
          await callText(client, 'archive_context', {uri: archiveUri});
          expect(await listDeferredCodeAnchorIntentRelativePaths(pendingRoot)).toHaveLength(1);

          const forgetTopic = 'deferred-anchor-forget';
          const forgetUri = `threadnote://user/test-user/memories/durable/projects/threadnote/${forgetTopic}.md`;
          await callText(client, 'remember_context', {
            callerCwd: repository,
            citationPolicy: 'defer',
            codeRefs: ['src/index.ts'],
            kind: 'durable',
            project: 'threadnote',
            text: 'Pending anchor that will be forgotten.',
            topic: forgetTopic,
          });
          expect(await listDeferredCodeAnchorIntentRelativePaths(pendingRoot)).toHaveLength(2);
          await callText(client, 'forget', {uri: forgetUri});
          expect(await listDeferredCodeAnchorIntentRelativePaths(pendingRoot)).toHaveLength(1);

          execFileSync('git', ['add', '.'], {cwd: repository});
          execFileSync('git', ['commit', '-qm', 'clean pulled commit'], {cwd: repository});

          const stale = await client.callTool(
            {
              arguments: {callerCwd: repository, operation: 'query', query: 'indexedBeforePull'},
              name: 'inspect_code_graph',
            },
            undefined,
            {timeout: 5_000},
          );
          expect(stale.isError).not.toBe(true);
          expect(stale.structuredContent).toMatchObject({
            freshness: 'stale',
            nodes: expect.arrayContaining([expect.objectContaining({name: 'indexedBeforePull'})]),
            operation: 'query',
            snapshot: {commit: indexedCommit, id: firstSnapshotId},
          });
          expect((stale.structuredContent as {readonly state?: unknown} | undefined)?.state).toBeUndefined();
        } finally {
          await rm(graphLock, {force: true});
        }

        execFileSync(
          process.execPath,
          [join(process.cwd(), 'src', 'standalone.ts'), 'graph', 'index', '--no-vectors'],
          {
            cwd: repository,
            env: {
              ...process.env,
              THREADNOTE_ACCOUNT: 'local',
              THREADNOTE_AGENT_ID: 'threadnote',
              THREADNOTE_HOME: fixture.home,
              THREADNOTE_MANIFEST: join(fixture.home, 'seed-manifest.yaml'),
              THREADNOTE_USER: 'test-user',
            },
            stdio: 'pipe',
          },
        );
        await callCodeGraphUntilReady(client, {
          callerCwd: repository,
          operation: 'query',
          query: 'addedAfterPull',
        });
        expect(await listDeferredCodeAnchorIntentRelativePaths(pendingRoot)).toEqual([]);
        const finalizedMemory = parseMemoryDocument(citationUri, await readFile(citationPath, 'utf8'));
        expect(finalizedMemory?.body).toBe('Deferred memory stored while the exact-current graph is unavailable.');
        expect(finalizedMemory?.metadata.codeCitations).toMatchObject([{path: 'src/index.ts'}]);
        const finalizedCitation = finalizedMemory?.metadata.codeCitations?.[0];
        if (!finalizedCitation) throw new TestError('Automatic finalization did not attach the expected citation.');
        const automaticBacklink = await client.callTool(
          {
            arguments: {
              callerCwd: repository,
              codeRefs: ['src/index.ts'],
              project: 'threadnote',
              task: 'Recover the automatically finalized deferred memory backlink.',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(automaticBacklink.isError).not.toBe(true);
        const automaticBrief = parseContextBriefV1(automaticBacklink.structuredContent);
        const automaticMemoryMatches = automaticBrief.durableDecisions.filter(memory =>
          memory.codeRelations?.some(relation => relation.citationId === finalizedCitation.id),
        );
        expect(automaticMemoryMatches).toHaveLength(1);
        expect(automaticMemoryMatches[0]).toMatchObject({
          codeRelations: [
            {
              anchorOrdinal: 0,
              citationId: finalizedCitation.id,
              kind: 'file',
              status: 'exact',
            },
          ],
          selectionBasis: 'code-citation',
          uri: expect.stringMatching(/^threadnote:\/\/memory\/tn_[a-z0-9_-]+$/u),
        });
        const boundedRecovery = await client.callTool(
          {
            arguments: {
              budgetTokens: 1_500,
              callerCwd: repository,
              codeRefs: [
                'src/index.ts',
                ...Array.from({length: 7}, (_, index) => `src/context-brief-recovery-${index}.ts`),
              ],
              mode: 'locate',
              project: 'threadnote',
              task: 'Locate every recoveryContextBrief implementation and its attached memory contract.',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(boundedRecovery.isError, JSON.stringify(boundedRecovery)).not.toBe(true);
        const boundedRecoveryBrief = parseContextBriefV1(boundedRecovery.structuredContent);
        expect(boundedRecoveryBrief.version).toBe(3);
        expect(boundedRecoveryBrief.coverage.memory.codeAnchors).toMatchObject({
          complete: true,
          requested: 8,
          resolved: 8,
        });
        expect(boundedRecoveryBrief.output.truncated).toBe(true);
        expect(boundedRecoveryBrief.coverage.omissions.graphCards).toBeGreaterThan(0);
        expect(boundedRecoveryBrief.graph.continuation?.state).toBe('rerun-required');
        const structuredRecovery = boundedRecoveryBrief.recommendedFollowUps[0];
        expect(structuredRecovery).toMatchObject({
          operation: 'inspect-node',
          rank: 0,
          ref: expect.stringMatching(/^cgs_/u),
        });
        const boundedRecoveryText = (
          (Array.isArray(boundedRecovery.content) ? boundedRecovery.content[0] : undefined) as TextContent | undefined
        )?.text;
        const contentRecovery = parseContextBriefAgentViewText(boundedRecoveryText ?? '');
        expect(contentRecovery.recommendedFollowUps?.[0]).toEqual(structuredRecovery);
        expect(contentRecovery.graph?.continuation).toEqual(boundedRecoveryBrief.graph.continuation);
        expect(
          Buffer.byteLength(JSON.stringify(boundedRecovery.structuredContent)) +
            Buffer.byteLength(boundedRecoveryText ?? ''),
        ).toBeLessThanOrEqual(1_500 * 3);
        const idempotent = await client.callTool(
          {arguments: {uri: citationUri}, name: 'finalize_code_refs'},
          undefined,
          {timeout: 5_000},
        );
        expect(idempotent.structuredContent).toMatchObject({
          conflictCount: 0,
          failedCount: 0,
          finalizedCount: 0,
          pendingCount: 0,
          scannedCount: 0,
        });
      },
      {toolset: 'full'},
    );
  }, 40_000);

  it('serves a divergent-HEAD new worktree from stale shared evidence while its builder is blocked', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const repository = join(fixture.root, 'divergent-worktree-repository');
        await mkdir(join(repository, 'src'), {recursive: true});
        await writeFile(join(repository, 'package.json'), '{"name":"divergent-worktree-repository"}\n', 'utf8');
        await writeFile(
          join(repository, 'src', 'index.ts'),
          'export function sharedBeforeDivergence(): string { return "shared"; }\n',
          'utf8',
        );
        execFileSync('git', ['init', '-q'], {cwd: repository});
        execFileSync('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
        execFileSync('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
        execFileSync('git', ['add', '.'], {cwd: repository});
        execFileSync('git', ['commit', '-qm', 'shared graph base'], {cwd: repository});

        const first = await callCodeGraphUntilReady(client, {
          callerCwd: repository,
          operation: 'query',
          query: 'sharedBeforeDivergence',
        });
        const firstSnapshot = (
          first.structuredContent as
            {readonly snapshot?: {readonly commit?: unknown; readonly id?: unknown}} | undefined
        )?.snapshot;
        expect(typeof firstSnapshot?.id).toBe('string');
        expect(typeof firstSnapshot?.commit).toBe('string');

        const branch = 'divergent-linked';
        const worktree = join(fixture.root, 'divergent-linked-worktree');
        execFileSync('git', ['branch', branch], {cwd: repository});
        execFileSync('git', ['worktree', 'add', worktree, branch], {cwd: repository});
        await writeFile(
          join(worktree, 'src', 'divergent.ts'),
          'export function divergentHeadOnly(): string { return "divergent"; }\n',
          'utf8',
        );
        execFileSync('git', ['add', '.'], {cwd: worktree});
        execFileSync('git', ['commit', '-qm', 'divergent graph head'], {cwd: worktree});

        const gitCommonDirectory = await realpath(
          execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd: worktree,
            encoding: 'utf8',
          }).trim(),
        );
        const checkoutId = createHash('sha256').update(`checkout-v1\n${gitCommonDirectory}`).digest('hex');
        const worktreeId = createHash('sha256')
          .update(`worktree-v1\n${await realpath(worktree)}`)
          .digest('hex');
        const graphLock = join(
          fixture.home,
          'locks',
          'indexes',
          'code-graph',
          'worktrees',
          checkoutId,
          `${worktreeId}.lock`,
        );
        await mkdir(join(graphLock, '..'), {recursive: true});
        await writeFile(graphLock, `${process.pid}:divergent-worktree-test\n`, {encoding: 'utf8', mode: 0o600});

        try {
          const startedAt = Date.now();
          const borrowed = await client.callTool(
            {
              arguments: {callerCwd: worktree, operation: 'query', query: 'sharedBeforeDivergence'},
              name: 'inspect_code_graph',
            },
            undefined,
            {timeout: 5_000},
          );
          expect(Date.now() - startedAt).toBeLessThan(5_000);
          expect(borrowed.isError).not.toBe(true);
          expect(borrowed.structuredContent).toMatchObject({
            freshness: 'stale',
            nodes: expect.arrayContaining([expect.objectContaining({name: 'sharedBeforeDivergence'})]),
            operation: 'query',
            snapshot: {commit: firstSnapshot?.commit, id: firstSnapshot?.id},
          });
          expect((borrowed.structuredContent as {readonly state?: unknown} | undefined)?.state).toBeUndefined();
          expect(JSON.stringify(borrowed.structuredContent)).not.toContain('divergentHeadOnly');
        } finally {
          await rm(graphLock, {force: true});
        }
      },
      {environment: {THREADNOTE_CODE_GRAPH_PREWARM: '0'}, toolset: 'core'},
    );
  }, 40_000);

  it('keeps graphs immediately available across new TypeScript, Python, and Rust worktrees and edits', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const repositories = [
          {
            after: 'typescriptAfterEdit',
            before: 'typescriptBeforeEdit',
            files: {
              'package.json': '{"name":"typescript-readiness"}\n',
              'src/index.ts': 'export function typescriptBeforeEdit(): string { return "before"; }\n',
            },
            name: 'typescript',
            sourcePath: 'src/index.ts',
          },
          {
            after: 'python_after_edit',
            before: 'python_before_edit',
            files: {
              'pyproject.toml': '[project]\nname = "python-readiness"\nversion = "0.0.0"\n',
              'src/readiness.py': 'def python_before_edit():\n    return "before"\n',
            },
            name: 'python',
            sourcePath: 'src/readiness.py',
          },
          {
            after: 'rust_after_edit',
            before: 'rust_before_edit',
            files: {
              'Cargo.toml': '[package]\nname = "rust-readiness"\nversion = "0.0.0"\nedition = "2021"\n',
              'src/lib.rs': 'pub fn rust_before_edit() -> &\'static str { "before" }\n',
            },
            name: 'rust',
            sourcePath: 'src/lib.rs',
          },
        ] as const;

        for (const repositoryFixture of repositories) {
          const repository = join(fixture.root, `${repositoryFixture.name}-repository`);
          for (const [relativePath, content] of Object.entries(repositoryFixture.files)) {
            const path = join(repository, relativePath);
            await mkdir(join(path, '..'), {recursive: true});
            await writeFile(path, content, 'utf8');
          }
          execFileSync('git', ['init', '-q'], {cwd: repository});
          execFileSync('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
          execFileSync('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
          execFileSync('git', ['add', '.'], {cwd: repository});
          execFileSync('git', ['commit', '-qm', 'fixture'], {cwd: repository});

          const first = await callCodeGraphUntilReady(client, {
            callerCwd: repository,
            operation: 'query',
            query: repositoryFixture.before,
          });
          const firstStructured = first.structuredContent as
            | {
                readonly freshness?: unknown;
                readonly nodes?: readonly {readonly name?: unknown}[];
                readonly snapshot?: {readonly id?: unknown; readonly worktreeId?: unknown};
              }
            | undefined;
          expect(firstStructured).toMatchObject({
            nodes: expect.arrayContaining([expect.objectContaining({name: repositoryFixture.before})]),
          });
          expect(['current', 'deferred']).toContain(firstStructured?.freshness);
          expect(typeof firstStructured?.snapshot?.id).toBe('string');

          const branch = `${repositoryFixture.name}-linked`;
          const worktree = join(fixture.root, `${repositoryFixture.name}-worktree`);
          execFileSync('git', ['branch', branch], {cwd: repository});
          execFileSync('git', ['worktree', 'add', worktree, branch], {cwd: repository});

          const attachedStartedAt = Date.now();
          const attached = await client.callTool(
            {
              arguments: {callerCwd: worktree, operation: 'query', query: repositoryFixture.before},
              name: 'inspect_code_graph',
            },
            undefined,
            {timeout: 10_000},
          );
          expect(Date.now() - attachedStartedAt).toBeLessThan(5_000);
          expect(attached.isError).not.toBe(true);
          expect(attached.structuredContent).toMatchObject({
            freshness: 'current',
            nodes: expect.arrayContaining([expect.objectContaining({name: repositoryFixture.before})]),
            snapshot: {id: firstStructured?.snapshot?.id},
          });
          expect((attached.structuredContent as {readonly state?: unknown} | undefined)?.state).toBeUndefined();

          const source = join(worktree, repositoryFixture.sourcePath);
          await writeFile(
            source,
            (await readFile(source, 'utf8')).replace(repositoryFixture.before, repositoryFixture.after),
            'utf8',
          );
          const editedStartedAt = Date.now();
          const edited = await client.callTool(
            {
              arguments: {callerCwd: worktree, operation: 'query', query: repositoryFixture.before},
              name: 'inspect_code_graph',
            },
            undefined,
            {timeout: 10_000},
          );
          const editedStructured = edited.structuredContent as
            {readonly freshness?: unknown; readonly state?: unknown} | undefined;
          expect(Date.now() - editedStartedAt).toBeLessThan(5_000);
          expect(edited.isError).not.toBe(true);
          expect(editedStructured?.state).toBeUndefined();
          expect(editedStructured?.freshness).toBe('deferred');

          const refresh = await callCodeGraphUntilReady(client, {
            base: 'HEAD',
            callerCwd: worktree,
            operation: 'impact',
          });
          expect(refresh.structuredContent).toMatchObject({freshness: 'current', operation: 'impact'});

          const refreshed = await callCodeGraphUntilReady(client, {
            callerCwd: worktree,
            operation: 'query',
            query: repositoryFixture.after,
          });
          expect(refreshed.structuredContent).toMatchObject({
            freshness: 'deferred',
            nodes: expect.arrayContaining([expect.objectContaining({name: repositoryFixture.after})]),
          });
          expect(
            (refreshed.structuredContent as {readonly snapshot?: {readonly id?: unknown}} | undefined)?.snapshot?.id,
          ).not.toBe(firstStructured?.snapshot?.id);
        }
      },
      {environment: {THREADNOTE_CODE_GRAPH_PREWARM: '0'}, toolset: 'core'},
    );
  }, 120_000);

  it('keeps ordinary watched reads deferred until an explicit current inspection', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const repository = join(fixture.root, 'watched-repository');
        await mkdir(join(repository, 'src'), {recursive: true});
        await writeFile(join(repository, 'package.json'), '{"name":"watched-repository"}\n', 'utf8');
        await writeFile(
          join(repository, 'src', 'index.ts'),
          'export function beforeSessionWatch(): string { return "before"; }\n',
          'utf8',
        );
        execFileSync('git', ['init', '-q'], {cwd: repository});
        execFileSync('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
        execFileSync('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
        execFileSync('git', ['add', '.'], {cwd: repository});
        execFileSync('git', ['commit', '-qm', 'fixture'], {cwd: repository});

        const first = await callCodeGraphUntilReady(client, {
          callerCwd: repository,
          operation: 'query',
          query: 'beforeSessionWatch',
        });
        expect(first.structuredContent).toMatchObject({
          nodes: expect.arrayContaining([expect.objectContaining({name: 'beforeSessionWatch'})]),
        });
        expect(['current', 'deferred']).toContain(
          (first.structuredContent as {readonly freshness?: unknown} | undefined)?.freshness,
        );
        const firstSnapshotId = (first.structuredContent as {readonly snapshot?: {readonly id?: unknown}} | undefined)
          ?.snapshot?.id;
        expect(typeof firstSnapshotId).toBe('string');
        const hot = await client.callTool(
          {
            arguments: {callerCwd: repository, operation: 'query', query: 'beforeSessionWatch'},
            name: 'inspect_code_graph',
          },
          undefined,
          {timeout: 5_000},
        );
        expect(hot.structuredContent).toMatchObject({freshness: 'deferred', snapshot: {id: firstSnapshotId}});

        await writeFile(
          join(repository, 'src', 'index.ts'),
          'export function afterSessionWatch(): string { return "after"; }\n',
          'utf8',
        );
        await new Promise(resolve => setTimeout(resolve, 500));
        const deferred = await client.callTool(
          {
            arguments: {callerCwd: repository, operation: 'query', query: 'afterSessionWatch'},
            name: 'inspect_code_graph',
          },
          undefined,
          {timeout: 5_000},
        );
        expect(deferred.structuredContent).toMatchObject({
          freshness: 'deferred',
          snapshot: {id: firstSnapshotId},
        });

        const refresh = await callCodeGraphUntilReady(client, {
          base: 'HEAD',
          callerCwd: repository,
          operation: 'impact',
        });
        expect(refresh.structuredContent).toMatchObject({freshness: 'current', operation: 'impact'});

        const refreshed = await callCodeGraphUntilReady(client, {
          callerCwd: repository,
          operation: 'query',
          query: 'afterSessionWatch',
        });
        expect(refreshed.structuredContent).toMatchObject({
          freshness: 'deferred',
          nodes: expect.arrayContaining([expect.objectContaining({name: 'afterSessionWatch'})]),
        });
        expect(
          (refreshed.structuredContent as {readonly snapshot?: {readonly id?: unknown}} | undefined)?.snapshot?.id,
        ).not.toBe(firstSnapshotId);

        const removed = await client.callTool(
          {
            arguments: {callerCwd: repository, operation: 'query', query: 'beforeSessionWatch'},
            name: 'inspect_code_graph',
          },
          undefined,
          {timeout: 5_000},
        );
        const removedNodes = (
          removed.structuredContent as {readonly nodes?: readonly {readonly name?: unknown}[]} | undefined
        )?.nodes;
        expect(removedNodes?.some(node => node.name === 'beforeSessionWatch')).toBe(false);
      },
      {toolset: 'core'},
    );
  }, 60_000);

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

        const approvedUri = 'threadnote://user/test-user/memories/durable/projects/threadnote/approved-candidates.md';
        const unreviewedUri =
          'threadnote://user/test-user/memories/durable/projects/threadnote/approved-candidates-shadow.md';
        await callText(client, 'remember_context', {
          kind: 'durable',
          project: 'threadnote',
          sourceAgentClient: 'codex',
          status: 'active',
          text: 'Unreviewed speculation about approved candidates. '.repeat(8),
          topic: 'approved-candidates-shadow',
        });

        const approvedRecall = await client.callTool({
          arguments: {
            nodeLimit: 12,
            project: 'threadnote',
            query: 'canonical approved candidates guidance',
            threshold: 0,
          },
          name: 'recall_context',
        });
        const approvedUris = (
          approvedRecall.structuredContent as {readonly results?: readonly {readonly uri?: unknown}[]} | undefined
        )?.results?.map(result => result.uri);
        expect(approvedUris).toContain(approvedUri);
        expect(approvedUris).not.toContain(unreviewedUri);

        const ordinaryRecall = await client.callTool({
          arguments: {
            nodeLimit: 12,
            project: 'threadnote',
            query: 'approved candidates',
            threshold: 0,
          },
          name: 'recall_context',
        });
        const ordinaryUris = (
          ordinaryRecall.structuredContent as {readonly results?: readonly {readonly uri?: unknown}[]} | undefined
        )?.results?.map(result => result.uri);
        expect(ordinaryUris).toContain(unreviewedUri);
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

  it('preserves v4 citations and rejects malformed or future schemas through archive_context', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const activeDirectory = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'handoffs',
          'active',
          'threadnote',
        );
        const archivedDirectory = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'handoffs',
          'archived',
          'threadnote',
        );
        await mkdir(activeDirectory, {recursive: true});
        const citation = createMemoryCodeCitation({
          extractorSet: 'native-code-graph-13',
          fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
          path: 'src/mcp_server_recall.ts',
          repositoryId: 'b'.repeat(64),
          repositoryIdentityKind: 'remote',
          sourceCommit: 'c'.repeat(40),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
          target: {kind: 'file'},
          version: 1,
        });
        const validTopic = 'public-archive-citation';
        const validUri = `threadnote://user/test-user/memories/handoffs/active/threadnote/${validTopic}.md`;
        const validPath = join(activeDirectory, `${validTopic}.md`);
        const validContent = formatMemoryDocument(
          'HANDOFF',
          {
            codeCitations: [citation],
            createdAt: '2026-08-25T20:00:00.000Z',
            evidence: ['threadnote://memory/tn_public_archive_evidence'],
            kind: 'handoff',
            memoryId: 'tn_public_archive_source',
            project: 'threadnote',
            references: ['threadnote://memory/tn_public_archive_reference'],
            relations: [{type: 'references', uri: 'threadnote://memory/tn_public_archive_target'}],
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'codex',
            sourceCommit: citation.sourceCommit,
            sourceObservedAt: '2026-08-26T20:00:00.000Z',
            status: 'active',
            supersedes: 'threadnote://memory/tn_public_archive_history',
            timestamp: '2026-08-26T20:00:00.000Z',
            topic: validTopic,
          },
          'Public MCP archive must retain precise source evidence.',
        );
        await writeFile(validPath, validContent, 'utf8');

        await expect(
          callText(client, 'archive_context', {
            kind: 'handoff',
            project: 'threadnote',
            topic: validTopic,
            uri: validUri,
          }),
        ).resolves.toContain(`Archived original memory: ${validUri}`);
        expect(existsSync(validPath)).toBe(false);
        const archivedFiles = await readdir(archivedDirectory);
        expect(archivedFiles).toHaveLength(1);
        const archivedPath = join(archivedDirectory, archivedFiles[0]!);
        const archivedContent = await readFile(archivedPath, 'utf8');
        const archived = parseMemoryDocument(
          `threadnote://user/test-user/memories/handoffs/archived/threadnote/${archivedFiles[0]}`,
          archivedContent,
        );
        expect(archived?.metadata).toMatchObject({
          archivedFrom: validUri,
          codeCitations: [citation],
          createdAt: '2026-08-25T20:00:00.000Z',
          evidence: ['threadnote://memory/tn_public_archive_evidence'],
          memoryId: 'tn_public_archive_source',
          references: ['threadnote://memory/tn_public_archive_reference'],
          relations: [{type: 'references', uri: 'threadnote://memory/tn_public_archive_target'}],
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceCommit: citation.sourceCommit,
          sourceObservedAt: '2026-08-26T20:00:00.000Z',
          status: 'archived',
          supersedes: 'threadnote://memory/tn_public_archive_history',
          visibility: 'personal',
        });
        expect(archived?.metadata.citationErrors).toBeUndefined();
        expect(archived?.body).toBe(
          ['Archived original Threadnote memory.', '', 'Public MCP archive must retain precise source evidence.'].join(
            '\n',
          ),
        );
        expect(archived?.body).not.toContain(citation.id);
        expect(archived?.body).not.toContain(citation.fileContentHash.value);

        const blocked = [
          {
            message: 'newer than supported',
            topic: 'public-archive-future',
            versionLine: `schema_version: ${MEMORY_SCHEMA_VERSION + 1}`,
          },
          {
            message: 'newer than supported',
            topic: 'public-archive-indented-future',
            versionLine: `  schema_version: ${MEMORY_SCHEMA_VERSION + 1}`,
          },
          {
            message: 'newer than supported',
            newline: '\r',
            topic: 'public-archive-cr-future',
            versionLine: `schema_version: ${MEMORY_SCHEMA_VERSION + 1}`,
          },
          {
            extraLine: '  code_citation: {not-json}',
            message: 'malformed code citation metadata (invalid-json)',
            topic: 'public-archive-malformed',
            versionLine: `schema_version: ${MEMORY_SCHEMA_VERSION}`,
          },
        ];
        for (const candidate of blocked) {
          const uri = `threadnote://user/test-user/memories/handoffs/active/threadnote/${candidate.topic}.md`;
          const path = join(activeDirectory, `${candidate.topic}.md`);
          const content = [
            'HANDOFF',
            'kind: handoff',
            'status: active',
            'project: threadnote',
            `topic: ${candidate.topic}`,
            candidate.versionLine,
            ...(candidate.extraLine ? [candidate.extraLine] : []),
            '',
            'Blocked archive content must remain untouched.',
          ].join(candidate.newline ?? '\n');
          await writeFile(path, content, 'utf8');

          await expect(
            callErrorText(client, 'archive_context', {
              kind: 'handoff',
              project: 'threadnote',
              topic: candidate.topic,
              uri,
            }),
          ).resolves.toContain(candidate.message);
          await expect(readFile(path, 'utf8')).resolves.toBe(content);
        }
        await expect(readdir(archivedDirectory)).resolves.toEqual(archivedFiles);
      },
      {toolset: 'full'},
    );
  });

  it('requires remember_context replaceUri for same-topic schema rewrites and citation clearing', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const directory = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'durable',
          'projects',
          'threadnote',
        );
        await mkdir(directory, {recursive: true});
        const futureTopic = 'remember-implicit-future';
        const futurePath = join(directory, `${futureTopic}.md`);
        const future = [
          'MEMORY',
          'kind: durable',
          'status: active',
          'project: threadnote',
          `topic: ${futureTopic}`,
          `schema_version: ${MEMORY_SCHEMA_VERSION + 1}`,
          'future_writer_field: preserve-me',
          '',
          'Future-owned content must remain unchanged.',
        ].join('\n');
        await writeFile(futurePath, future, 'utf8');

        await expect(
          callErrorText(client, 'remember_context', {
            project: 'threadnote',
            text: 'Implicit future overwrite.',
            topic: futureTopic,
          }),
        ).resolves.toContain('newer than supported');
        await expect(readFile(futurePath, 'utf8')).resolves.toBe(future);

        const citationTopic = 'remember-implicit-citation-clear';
        const citationUri = `threadnote://user/test-user/memories/durable/projects/threadnote/${citationTopic}.md`;
        const citationPath = join(directory, `${citationTopic}.md`);
        const citation = createMemoryCodeCitation({
          extractorSet: 'native-code-graph-13',
          fileContentHash: {algorithm: 'sha256', value: '1'.repeat(64)},
          path: 'src/mcp_server_memory.ts',
          repositoryId: '2'.repeat(64),
          repositoryIdentityKind: 'remote',
          sourceCommit: '3'.repeat(40),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${'4'.repeat(40)}`,
          target: {kind: 'file'},
          version: 1,
        });
        const cited = formatMemoryDocument(
          'MEMORY',
          {
            codeCitations: [citation],
            kind: 'durable',
            project: 'threadnote',
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'codex',
            status: 'active',
            timestamp: '2026-08-26T20:00:00.000Z',
            topic: citationTopic,
          },
          'Citation-bearing MCP memory.',
        );
        await writeFile(citationPath, cited, 'utf8');

        await expect(
          callErrorText(client, 'remember_context', {
            project: 'threadnote',
            text: 'Implicit citation clear.',
            topic: citationTopic,
          }),
        ).resolves.toContain(`replaceUri: "${citationUri}"`);
        await expect(readFile(citationPath, 'utf8')).resolves.toBe(cited);

        const replaced = await callText(client, 'remember_context', {
          project: 'threadnote',
          replaceUri: citationUri,
          text: 'Explicit citation clear.',
          topic: citationTopic,
        });
        expect(replaced).toContain('Cleared 1 prior code citation(s)');
        const updated = parseMemoryDocument(citationUri, await readFile(citationPath, 'utf8'));
        expect(updated?.body).toBe('Explicit citation clear.');
        expect(updated?.metadata.codeCitations).toBeUndefined();
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
        expect(tools.tools.find(tool => tool.name === 'finalize_code_refs')?.inputSchema).toMatchObject({
          properties: {
            limit: {maximum: 100, minimum: 1, type: 'integer'},
            uri: expect.any(Object),
          },
        });
      },
      {toolset: 'full'},
    );
  });

  it('refreshes shared audit provenance and leaves shared bytes unchanged while applying personal hygiene', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const topic = 'shared-compact-topic';
        const personalPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'handoffs',
          'active',
          'threadnote',
          `${topic}.md`,
        );
        await mkdir(join(personalPath, '..'), {recursive: true});
        await writeFile(
          personalPath,
          [
            'HANDOFF',
            'kind: handoff',
            'status: active',
            'project: threadnote',
            `topic: ${topic}`,
            'source_agent_client: integration-test',
            'timestamp: 2026-07-01T00:00:00.000Z',
            '',
            'Old personal working notes.',
          ].join('\n'),
          'utf8',
        );
        const sharedPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'shared',
          'platform',
          'durable',
          'projects',
          'threadnote',
          `${topic}.md`,
        );
        const sharedContent = canonicalMemoryContent(topic, 'Reviewed shared notes.');
        await mkdir(join(sharedPath, '..'), {recursive: true});
        await writeFile(sharedPath, sharedContent, 'utf8');

        const output = await callText(client, 'compact_context', {
          apply: true,
          project: 'threadnote',
          topic,
        });

        expect(output).toContain('Records scanned: 2');
        expect(output).toContain('same project/topic spans multiple memory scopes');
        expect(output).toContain('threadnote://user/test-user/memories/shared/platform/');
        expect(output).toContain('Shared audit source:');
        expect(output).toContain('bounded auto-sync attempted before scanning local canonical mirrors');
        expect(output).toContain('Archived original memory:');
        expect(output).toContain('Forget exact duplicates (0):\n- none');
        expect(await readFile(sharedPath, 'utf8')).toBe(sharedContent);
        expect(existsSync(personalPath)).toBe(false);
      },
      {toolset: 'full'},
    );
  });

  it('applies an exact-duplicate survivor update and retirement through compact_context', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const topic = 'atomic-duplicate';
        const content = canonicalMemoryContent(topic, 'One exact duplicate contract.');
        const memoryDirectory = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'durable',
          'projects',
          'threadnote',
        );
        const survivorPath = join(memoryDirectory, `${topic}.md`);
        const duplicatePath = join(memoryDirectory, 'threadnote-copy.md');
        await mkdir(memoryDirectory, {recursive: true});
        await writeFile(survivorPath, content, 'utf8');
        await writeFile(duplicatePath, content, 'utf8');

        const output = await callText(client, 'compact_context', {
          apply: true,
          project: 'threadnote',
          topic,
        });

        expect(output).toContain('Updated kept memory:');
        expect(output).toContain('Forgot exact duplicate:');
        expect(existsSync(duplicatePath)).toBe(false);
        const survivor = await readFile(survivorPath, 'utf8');
        expect(survivor).toContain(
          'threadnote://user/test-user/memories/durable/projects/threadnote/atomic-duplicate.md',
        );
        expect(survivor).toContain(
          'threadnote://user/test-user/memories/durable/projects/threadnote/threadnote-copy.md',
        );
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

  it('rejects generic imports into managed memory namespaces', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const source = join(fixture.root, 'attempted-memory-import.md');
        await writeFile(source, 'unlocked replacement attempt', 'utf8');
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/import-race.md';

        const error = await callErrorText(client, 'add_resource', {path: source, to: uri});

        expect(error).toContain('cannot write Threadnote memory namespaces');
        expect(error).toContain('remember_context');
        await expect(
          readFile(
            join(
              fixture.root,
              'data',
              'local',
              'user',
              'test-user',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'import-race.md',
            ),
            'utf8',
          ),
        ).rejects.toThrow();
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
