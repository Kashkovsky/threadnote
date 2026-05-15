#! /usr/bin/env node

import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {realpath} from 'node:fs/promises';
import {z} from 'zod';
import {DEFAULT_ACCOUNT, DEFAULT_AGENT_ID} from './constants.js';
import {
  errorMessage,
  exactRecallTerms,
  findExecutable,
  grepOutputHasMatches,
  runCommand,
  safeTimestamp,
  sha256,
  sleep,
} from './utils.js';

interface RuntimeConfig {
  readonly account: string;
  readonly agentId: string;
  readonly user: string;
}

type MemoryKind = 'durable' | 'handoff' | 'incident' | 'preference' | 'smoke';
type MemoryStatus = 'active' | 'archived' | 'superseded';

interface MemoryMetadata {
  readonly archivedFrom?: string;
  readonly kind: MemoryKind;
  readonly project?: string;
  readonly sourceAgentClient: string;
  readonly status: MemoryStatus;
  readonly supersedes?: string;
  readonly timestamp: string;
  readonly topic?: string;
}

type CheckedText =
  | {
      readonly ok: true;
      readonly value: string;
    }
  | {
      readonly error: CallToolResult;
      readonly ok: false;
    };

type CheckedOptionalText =
  | {
      readonly ok: true;
      readonly value: string | undefined;
    }
  | {
      readonly error: CallToolResult;
      readonly ok: false;
    };

async function main(): Promise<void> {
  const config = getRuntimeConfig();
  const server = new McpServer(
    {name: 'threadnote-local-adapter', version: '0.2.0'},
    {
      instructions: [
        '# Threadnote Local Adapter',
        '',
        'Stdio MCP adapter for Threadnote shared local context.',
        'Prefer `recall_context` to find candidate viking:// URIs, then `read_context` files or `list_context` directories.',
        'Always pass JSON arguments. Example: recall_context({"query":"current repo latest handoff"}).',
        'Older clients may use the compatibility aliases `search`, `read`, and `list`.',
        'For durable facts, store kind="durable"; for current work logs, store kind="handoff" with project/topic so Threadnote keeps one active memory updated.',
        'When updating the same active issue, pass project/topic or replaceUri to remember_context so duplicate handoffs do not accumulate.',
        'Do not store secrets, customer data, raw production logs, or credentials.',
      ].join('\n'),
    },
  );

  registerTools(server, config);
  await server.connect(new StdioServerTransport());
  process.stderr.write('Threadnote local MCP adapter running\n');
}

function getRuntimeConfig(): RuntimeConfig {
  return {
    account: process.env.THREADNOTE_ACCOUNT ?? DEFAULT_ACCOUNT,
    agentId: process.env.THREADNOTE_AGENT_ID ?? DEFAULT_AGENT_ID,
    user: process.env.THREADNOTE_USER ?? process.env.USER ?? 'unknown',
  };
}

function registerTools(server: McpServer, config: RuntimeConfig): void {
  registerSearchTool(
    server,
    config,
    'recall_context',
    'Search Threadnote context. Required: pass JSON arguments with a non-empty query, for example {"query":"unity-ui-ccc latest handoff"}.',
  );
  registerSearchTool(
    server,
    config,
    'search',
    'Compatibility alias for recall_context. Required: pass JSON arguments with a non-empty query.',
  );

  registerReadTool(
    server,
    config,
    'read_context',
    'Read a viking:// file URI returned by recall_context or list_context.',
  );
  registerReadTool(server, config, 'read', 'Compatibility alias for read_context.');

  registerListTool(server, config, 'list_context', 'List a viking:// directory returned by recall_context.');
  registerListTool(server, config, 'list', 'Compatibility alias for list_context.');

  registerStoreTool(
    server,
    config,
    'remember_context',
    'Store a durable Threadnote memory. Required: pass JSON arguments with text.',
  );
  registerStoreTool(server, config, 'store', 'Compatibility alias for remember_context.');

  registerArchiveTool(
    server,
    config,
    'archive_context',
    'Archive a memory so it remains readable as provenance but is no longer current working context.',
  );
  registerArchiveTool(server, config, 'archive', 'Compatibility alias for archive_context.');

  server.registerTool(
    'forget',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: 'Remove a viking:// URI from OpenViking.',
      inputSchema: {
        uri: z.string().optional().describe('Required viking:// URI to remove'),
      },
    },
    async ({uri}) => {
      const checkedUri = requiredVikingUri(uri, 'forget', 'viking://agent/threadnote/memories/example.md');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      try {
        const ov = await requiredOpenVikingCli();
        const removed = await removeVikingResourceWithRetry(ov, config, checkedUri.value);
        return {
          content: [
            {
              type: 'text',
              text: removed
                ? `Removed: ${checkedUri.value}`
                : `Resource is still being processed; retry later: ${checkedUri.value}`,
            },
          ],
          isError: !removed,
        };
      } catch (err: unknown) {
        return {content: [{type: 'text', text: errorMessage(err)}], isError: true};
      }
    },
  );

  server.registerTool(
    'add_resource',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Add a local file or directory to OpenViking as a resource.',
      inputSchema: {
        sourcePath: z.string().optional().describe('Required local source file or directory'),
        to: z.string().optional().describe('Required destination viking:// URI'),
        wait: z.boolean().optional().describe('Wait for processing to finish'),
      },
    },
    async ({sourcePath, to, wait}) => {
      const checkedSourcePath = requiredText(sourcePath, 'add_resource', 'sourcePath', {
        sourcePath: '/path/to/README.md',
        to: 'viking://resource/my-repo/README.md',
      });
      if (!checkedSourcePath.ok) {
        return checkedSourcePath.error;
      }
      const checkedTo = requiredVikingUri(to, 'add_resource', 'viking://resource/my-repo/README.md');
      if (!checkedTo.ok) {
        return checkedTo.error;
      }
      return runOpenVikingTool(config, [
        'add-resource',
        checkedSourcePath.value,
        '--to',
        checkedTo.value,
        ...(wait === false ? [] : ['--wait']),
      ]);
    },
  );

  server.registerTool(
    'grep',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Run exact text search in OpenViking.',
      inputSchema: {
        pattern: z.string().optional().describe('Required text or regex pattern'),
        uri: z.string().optional().describe('Optional viking:// subtree'),
      },
    },
    async ({pattern, uri}) => {
      const checkedPattern = requiredText(pattern, 'grep', 'pattern', {pattern: 'unity-ui-ccc'});
      if (!checkedPattern.ok) {
        return checkedPattern.error;
      }
      const checkedUri = optionalVikingUri(uri, 'grep');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingTool(config, [
        'grep',
        checkedPattern.value,
        ...(checkedUri.value ? ['--uri', checkedUri.value] : []),
      ]);
    },
  );

  server.registerTool(
    'glob',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Run glob file search in OpenViking.',
      inputSchema: {
        pattern: z.string().optional().describe('Required glob pattern'),
        uri: z.string().optional().describe('Optional viking:// subtree'),
      },
    },
    async ({pattern, uri}) => {
      const checkedPattern = requiredText(pattern, 'glob', 'pattern', {pattern: '**/AGENTS.md'});
      if (!checkedPattern.ok) {
        return checkedPattern.error;
      }
      const checkedUri = optionalVikingUri(uri, 'glob');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingTool(config, [
        'glob',
        checkedPattern.value,
        ...(checkedUri.value ? ['--uri', checkedUri.value] : []),
      ]);
    },
  );

  server.registerTool(
    'health',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Check OpenViking server health through the CLI.',
      inputSchema: {},
    },
    async () => runOpenVikingTool(config, ['health']),
  );
}

function registerSearchTool(server: McpServer, config: RuntimeConfig, name: string, description: string): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description,
      inputSchema: {
        query: z.string().optional().describe('Required search query, for example "unity-ui-ccc latest handoff"'),
        uri: z.string().optional().describe('Optional viking:// subtree to search'),
        nodeLimit: z.number().int().positive().max(100).optional().describe('Maximum result count'),
        includeArchived: z.boolean().optional().describe('Include archived memories in exact durable-memory matches'),
      },
    },
    async ({includeArchived, nodeLimit, query, uri}) => {
      const checkedQuery = requiredText(query, name, 'query', {query: 'unity-ui-ccc latest handoff'});
      if (!checkedQuery.ok) {
        return checkedQuery.error;
      }
      const checkedUri = optionalVikingUri(uri, name);
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runRecallTool(
        config,
        [
          'search',
          checkedQuery.value,
          ...(checkedUri.value ? ['--uri', checkedUri.value] : []),
          ...(nodeLimit ? ['--node-limit', String(nodeLimit)] : []),
        ],
        includeArchived === true,
      );
    },
  );
}

async function runRecallTool(
  config: RuntimeConfig,
  args: readonly string[],
  includeArchived: boolean,
): Promise<CallToolResult> {
  const semanticResult = await runOpenVikingTool(config, args);
  if (semanticResult.isError === true) {
    return semanticResult;
  }
  const query = args[1];
  const exactMatches =
    typeof query === 'string' ? await exactMemoryMatchesText(config, query, includeArchived) : undefined;
  if (!exactMatches) {
    return semanticResult;
  }
  const [firstContent] = semanticResult.content;
  if (firstContent?.type !== 'text') {
    return semanticResult;
  }
  return {
    ...semanticResult,
    content: [{type: 'text', text: `${firstContent.text}\n\nExact durable memory matches:\n${exactMatches}`}],
  };
}

async function exactMemoryMatchesText(
  config: RuntimeConfig,
  query: string,
  includeArchived: boolean,
): Promise<string | undefined> {
  const terms = exactRecallTerms(query);
  if (terms.length === 0) {
    return undefined;
  }
  const ov = await requiredOpenVikingCli();
  const scopes = exactMemoryScopes(config, includeArchived);
  const outputs: string[] = [];
  for (const term of terms) {
    for (const scope of scopes) {
      const result = await runCommand(ov, withIdentity(config, ['grep', term, '--uri', scope, '--node-limit', '5']), {
        allowFailure: true,
      });
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
      if (result.exitCode === 0 && grepOutputHasMatches(output)) {
        outputs.push(output);
      }
    }
  }
  return outputs.length > 0 ? outputs.join('\n\n') : undefined;
}

function registerReadTool(server: McpServer, config: RuntimeConfig, name: string, description: string): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: `${description} Required: pass JSON arguments with uri.`,
      inputSchema: {
        uri: z.string().optional().describe('Required viking:// file URI'),
      },
    },
    async ({uri}) => {
      const checkedUri = requiredVikingUri(uri, name, 'viking://agent/threadnote/memories/.abstract.md');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingTool(config, ['read', checkedUri.value]);
    },
  );
}

function registerListTool(server: McpServer, config: RuntimeConfig, name: string, description: string): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description,
      inputSchema: {
        uri: z.string().optional().describe('Optional viking:// directory URI; defaults to viking://'),
        all: z.boolean().optional().describe('Show hidden files like .abstract.md and .overview.md'),
        recursive: z.boolean().optional().describe('List recursively'),
        simple: z.boolean().optional().describe('Only return paths'),
        nodeLimit: z.number().int().positive().max(1000).optional().describe('Maximum node count'),
      },
    },
    async ({all, nodeLimit, recursive, simple, uri}) => {
      const checkedUri = optionalVikingUri(uri, name);
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingTool(config, [
        'ls',
        checkedUri.value ?? 'viking://',
        ...(all === true ? ['--all'] : []),
        ...(recursive === true ? ['--recursive'] : []),
        ...(simple === true ? ['--simple'] : []),
        ...(nodeLimit ? ['--node-limit', String(nodeLimit)] : []),
      ]);
    },
  );
}

function registerStoreTool(server: McpServer, config: RuntimeConfig, name: string, description: string): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: `${description} Never store secrets, credentials, customer data, or raw logs.`,
      inputSchema: {
        kind: z
          .enum(['durable', 'handoff', 'incident', 'preference', 'smoke'])
          .optional()
          .describe('Memory lifecycle kind; durable facts and handoffs are most common'),
        project: z.string().optional().describe('Project/repo namespace, for example threadnote or mobile-native'),
        replaceUri: z
          .string()
          .optional()
          .describe('Optional viking:// memory URI to forget after the new memory is safely stored'),
        text: z.string().optional().describe('Required memory text to store'),
        sourceAgentClient: z
          .string()
          .optional()
          .describe('Originating client, for example cursor, copilot, codex, or claude'),
        status: z.enum(['active', 'archived', 'superseded']).optional().describe('Memory lifecycle status'),
        topic: z.string().optional().describe('Stable topic; active project/topic memories update one file'),
      },
    },
    async ({kind, project, replaceUri, sourceAgentClient, status, text, topic}) => {
      const checkedText = requiredText(text, name, 'text', {text: 'Durable engineering note...'});
      if (!checkedText.ok) {
        return checkedText.error;
      }
      const checkedReplaceUri = optionalVikingUri(replaceUri, name);
      if (!checkedReplaceUri.ok) {
        return checkedReplaceUri.error;
      }
      const metadata: MemoryMetadata = {
        kind: kind ?? 'durable',
        project: normalizeOptionalMetadata(project),
        sourceAgentClient: sourceAgentClient ?? 'mcp',
        status: status ?? 'active',
        supersedes: checkedReplaceUri.value,
        timestamp: new Date().toISOString(),
        topic: normalizeOptionalMetadata(topic),
      };
      return writeDurableMemory(
        config,
        formatMemoryDocument('MEMORY', metadata, checkedText.value),
        metadata,
        checkedReplaceUri.value,
      );
    },
  );
}

function registerArchiveTool(server: McpServer, config: RuntimeConfig, name: string, description: string): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: `${description} The archive is written before the original URI is removed.`,
      inputSchema: {
        kind: z.enum(['durable', 'handoff', 'incident', 'preference', 'smoke']).optional(),
        project: z.string().optional().describe('Project/repo namespace for the archived copy'),
        topic: z.string().optional().describe('Topic for the archived copy'),
        uri: z.string().optional().describe('Required viking:// memory URI to archive'),
      },
    },
    async ({kind, project, topic, uri}) => {
      const checkedUri = requiredVikingUri(uri, name, 'viking://user/example/memories/handoffs/active/repo/topic.md');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      try {
        const ov = await requiredOpenVikingCli();
        const readResult = await runCommand(ov, withIdentity(config, ['read', checkedUri.value]));
        const original = readResult.stdout.trim();
        if (!original) {
          return {
            content: [{type: 'text', text: `Could not read ${checkedUri.value} before archiving.`}],
            isError: true,
          };
        }
        const metadata: MemoryMetadata = {
          archivedFrom: checkedUri.value,
          kind: kind ?? 'handoff',
          project: normalizeOptionalMetadata(project),
          sourceAgentClient: 'mcp',
          status: 'archived',
          timestamp: new Date().toISOString(),
          topic: normalizeOptionalMetadata(topic),
        };
        const archiveResult = await writeDurableMemory(
          config,
          formatMemoryDocument('MEMORY', metadata, ['Archived original Threadnote memory.', '', original].join('\n')),
          metadata,
          undefined,
        );
        if (archiveResult.isError === true) {
          return archiveResult;
        }
        const removedOriginal = await removeVikingResourceWithRetry(ov, config, checkedUri.value);
        const [content] = archiveResult.content;
        const text = content?.type === 'text' ? content.text : 'Archived memory stored.';
        return {
          content: [
            {
              type: 'text',
              text: removedOriginal
                ? `${text}\nArchived original memory: ${checkedUri.value}`
                : `${text}\nArchive stored, but original memory is still processing. Retry later with forget: ${checkedUri.value}`,
            },
          ],
        };
      } catch (err: unknown) {
        return {content: [{type: 'text', text: errorMessage(err)}], isError: true};
      }
    },
  );
}

async function writeDurableMemory(
  config: RuntimeConfig,
  memory: string,
  metadata: MemoryMetadata,
  replaceUri: string | undefined,
): Promise<CallToolResult> {
  try {
    const ov = await requiredOpenVikingCli();
    const directoryUri = memoryDirectoryUri(config, metadata);
    await ensureMemoryDirectory(ov, config, directoryUri);

    const memoryUri = memoryUriFor(config, memory, metadata);
    const writeMode = await memoryWriteMode(ov, config, memoryUri, metadata);
    const result = await runOpenVikingWriteWithRetry(
      ov,
      config,
      memoryUri,
      withIdentity(config, [
        'write',
        memoryUri,
        '--content',
        memory,
        '--mode',
        writeMode,
        '--wait',
        '--timeout',
        '120',
      ]),
    );
    const messages = [`Stored memory: ${memoryUri}`];
    if (replaceUri && replaceUri !== memoryUri) {
      const removedReplacedMemory = await removeVikingResourceWithRetry(ov, config, replaceUri);
      messages.push(
        removedReplacedMemory
          ? `Forgot replaced memory: ${replaceUri}`
          : `Replacement stored, but superseded memory is still processing. Retry later with forget: ${replaceUri}`,
      );
    } else if (replaceUri === memoryUri) {
      messages.push(`Updated existing memory in place: ${memoryUri}`);
    }
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    return {content: [{type: 'text', text: [...messages, text].filter(Boolean).join('\n')}]};
  } catch (err: unknown) {
    return {content: [{type: 'text', text: errorMessage(err)}], isError: true};
  }
}

async function runOpenVikingWriteWithRetry(
  ov: string,
  config: RuntimeConfig,
  memoryUri: string,
  args: readonly string[],
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await runCommand(ov, args, {allowFailure: true});
    if (result.exitCode === 0) {
      return result;
    }
    if (await vikingResourceExists(ov, config, memoryUri)) {
      await runCommand(ov, withIdentity(config, ['wait', '--timeout', '120']), {allowFailure: true});
      return {exitCode: 0, stdout: 'OpenViking accepted the memory and indexing wait completed.', stderr: ''};
    }
    if (!isResourceBusy(result.stderr, result.stdout) || attempt === 3) {
      throw new Error(`${ov} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    await sleep(1000 * (attempt + 1));
  }
  throw new Error(`${ov} ${args.join(' ')} failed.`);
}

async function vikingResourceExists(ov: string, config: RuntimeConfig, uri: string): Promise<boolean> {
  const stat = await runCommand(ov, withIdentity(config, ['stat', uri]), {allowFailure: true});
  return stat.exitCode === 0;
}

async function removeVikingResourceWithRetry(ov: string, config: RuntimeConfig, uri: string): Promise<boolean> {
  const args = withIdentity(config, ['rm', uri]);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await runCommand(ov, args, {allowFailure: true});
    if (result.exitCode === 0) {
      return true;
    }
    if (isResourceBusy(result.stderr, result.stdout) && attempt === 3) {
      return false;
    }
    if (!isResourceBusy(result.stderr, result.stdout)) {
      throw new Error(`${ov} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    await sleep(1000 * (attempt + 1));
  }
  return false;
}

function isResourceBusy(stderr: string, stdout: string): boolean {
  const output = `${stderr}\n${stdout}`.toLowerCase();
  return output.includes('resource is busy') || output.includes('resource is being processed');
}

async function ensureMemoryDirectory(ov: string, config: RuntimeConfig, directoryUri: string): Promise<void> {
  for (const uri of vikingDirectoryChain(directoryUri)) {
    const statResult = await runCommand(ov, withIdentity(config, ['stat', uri]), {allowFailure: true});
    if (statResult.exitCode === 0) {
      continue;
    }
    await runCommand(
      ov,
      withIdentity(config, ['mkdir', uri, '--description', 'Threadnote lifecycle-aware local memories.']),
    );
  }
}

function memoryUriFor(config: RuntimeConfig, memory: string, metadata: MemoryMetadata): string {
  const filename = shouldUseStableMemoryUri(metadata)
    ? `${uriSegment(metadata.topic ?? 'current')}.md`
    : `threadnote-${safeTimestamp()}-${sha256(memory).slice(0, 12)}.md`;
  return `${memoryDirectoryUri(config, metadata)}/${filename}`;
}

function memoryDirectoryUri(config: RuntimeConfig, metadata: MemoryMetadata): string {
  const baseUri = `viking://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(metadata.project ?? 'general');
  switch (metadata.kind) {
    case 'preference':
      return metadata.status === 'active'
        ? `${baseUri}/preferences`
        : `${baseUri}/preferences/${uriSegment(metadata.status)}`;
    case 'handoff':
      return `${baseUri}/handoffs/${uriSegment(metadata.status)}/${projectSegment}`;
    case 'incident':
      return `${baseUri}/incidents/${uriSegment(metadata.status)}/${projectSegment}`;
    case 'smoke':
      return `${baseUri}/smoke/${uriSegment(metadata.status)}`;
    case 'durable':
      return metadata.status === 'active'
        ? `${baseUri}/durable/projects/${projectSegment}`
        : `${baseUri}/durable/${uriSegment(metadata.status)}/${projectSegment}`;
  }
}

function shouldUseStableMemoryUri(metadata: MemoryMetadata): boolean {
  return metadata.status === 'active' && metadata.topic !== undefined && metadata.kind !== 'smoke';
}

async function memoryWriteMode(
  ov: string,
  config: RuntimeConfig,
  memoryUri: string,
  metadata: MemoryMetadata,
): Promise<'create' | 'replace'> {
  if (!shouldUseStableMemoryUri(metadata)) {
    return 'create';
  }
  return (await vikingResourceExists(ov, config, memoryUri)) ? 'replace' : 'create';
}

function vikingDirectoryChain(directoryUri: string): readonly string[] {
  const prefix = 'viking://';
  if (!directoryUri.startsWith(prefix)) {
    return [directoryUri];
  }
  const parts = directoryUri.slice(prefix.length).split('/').filter(Boolean);
  const startIndex = parts[0] === 'user' && parts.length > 2 ? 3 : 1;
  const chain: string[] = [];
  for (let index = startIndex; index <= parts.length; index += 1) {
    chain.push(`${prefix}${parts.slice(0, index).join('/')}`);
  }
  return chain;
}

function exactMemoryScopes(config: RuntimeConfig, includeArchived: boolean): readonly string[] {
  const userBase = `viking://user/${uriSegment(config.user)}/memories`;
  const scopes = [
    `${userBase}/preferences`,
    `${userBase}/durable/projects`,
    `${userBase}/handoffs/active`,
    `${userBase}/incidents/active`,
    `${userBase}/events`,
    `viking://agent/${uriSegment(config.agentId)}/memories`,
  ];
  return includeArchived
    ? [...scopes, `${userBase}/durable/archived`, `${userBase}/handoffs/archived`, `${userBase}/incidents/archived`]
    : scopes;
}

function formatMemoryDocument(title: 'MEMORY', metadata: MemoryMetadata, body: string): string {
  const header = [
    title,
    `kind: ${metadata.kind}`,
    `status: ${metadata.status}`,
    metadata.project ? `project: ${metadata.project}` : undefined,
    metadata.topic ? `topic: ${metadata.topic}` : undefined,
    `source_agent_client: ${metadata.sourceAgentClient}`,
    `timestamp: ${metadata.timestamp}`,
    metadata.supersedes ? `supersedes: ${metadata.supersedes}` : undefined,
    metadata.archivedFrom ? `archived_from: ${metadata.archivedFrom}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return [...header, '', body.trim()].join('\n');
}

function normalizeOptionalMetadata(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function uriSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'unknown';
}

function requiredText(
  value: string | undefined,
  toolName: string,
  fieldName: string,
  example: Record<string, string>,
): CheckedText {
  const normalized = value?.trim();
  if (normalized) {
    return {ok: true, value: normalized};
  }
  return {
    error: argumentError(
      [
        `Threadnote MCP tool "${toolName}" needs a non-empty "${fieldName}" argument.`,
        'Pass JSON arguments to the tool call.',
        `Example: ${toolName}(${JSON.stringify(example)})`,
      ].join('\n'),
    ),
    ok: false,
  };
}

function requiredVikingUri(value: string | undefined, toolName: string, exampleUri: string): CheckedText {
  const checked = requiredText(value, toolName, 'uri', {uri: exampleUri});
  if (!checked.ok) {
    return checked;
  }
  if (checked.value.startsWith('viking://')) {
    return checked;
  }
  return {
    error: argumentError(`Threadnote MCP tool "${toolName}" needs a viking:// URI. Received: ${checked.value}`),
    ok: false,
  };
}

function optionalVikingUri(value: string | undefined, toolName: string): CheckedOptionalText {
  const normalized = value?.trim();
  if (!normalized) {
    return {ok: true, value: undefined};
  }
  if (normalized.startsWith('viking://')) {
    return {ok: true, value: normalized};
  }
  return {
    error: argumentError(
      `Threadnote MCP tool "${toolName}" optional "uri" must start with viking://. Received: ${normalized}`,
    ),
    ok: false,
  };
}

function argumentError(text: string): CallToolResult {
  return {content: [{type: 'text', text}], isError: true};
}

async function runOpenVikingTool(config: RuntimeConfig, args: readonly string[]): Promise<CallToolResult> {
  try {
    const ov = await requiredOpenVikingCli();
    const result = await runCommand(ov, withIdentity(config, args));
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    return {content: [{type: 'text', text: text || 'OK'}]};
  } catch (err: unknown) {
    return {content: [{type: 'text', text: errorMessage(err)}], isError: true};
  }
}

function withIdentity(config: RuntimeConfig, args: readonly string[]): readonly string[] {
  return [...args, '--account', config.account, '--user', config.user, '--agent-id', config.agentId];
}

async function requiredOpenVikingCli(): Promise<string> {
  const command =
    process.env.THREADNOTE_OV ??
    (await findExecutable(['ov', 'openviking'])) ??
    (await firstExistingPath([join(homedir(), '.local', 'bin', 'ov'), join(homedir(), '.local', 'bin', 'openviking')]));
  if (!command) {
    throw new Error('Neither ov nor openviking was found. Run threadnote install first.');
  }
  return command;
}

async function firstExistingPath(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path);
      return await realpath(path);
    } catch (_err: unknown) {
      continue;
    }
  }
  return undefined;
}

main().catch(err => {
  process.stderr.write(`${errorMessage(err)}\n`);
  process.exit(1);
});
