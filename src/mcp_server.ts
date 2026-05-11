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
        'When updating the same active issue, pass replaceUri to remember_context so the superseded memory is forgotten after the replacement is stored.',
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
      return runOpenVikingTool(config, ['rm', checkedUri.value]);
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
      },
    },
    async ({nodeLimit, query, uri}) => {
      const checkedQuery = requiredText(query, name, 'query', {query: 'unity-ui-ccc latest handoff'});
      if (!checkedQuery.ok) {
        return checkedQuery.error;
      }
      const checkedUri = optionalVikingUri(uri, name);
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runRecallTool(config, [
        'search',
        checkedQuery.value,
        ...(checkedUri.value ? ['--uri', checkedUri.value] : []),
        ...(nodeLimit ? ['--node-limit', String(nodeLimit)] : []),
      ]);
    },
  );
}

async function runRecallTool(config: RuntimeConfig, args: readonly string[]): Promise<CallToolResult> {
  const semanticResult = await runOpenVikingTool(config, args);
  if (semanticResult.isError === true) {
    return semanticResult;
  }
  const query = args[1];
  const exactMatches = typeof query === 'string' ? await exactMemoryMatchesText(config, query) : undefined;
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

async function exactMemoryMatchesText(config: RuntimeConfig, query: string): Promise<string | undefined> {
  const terms = exactRecallTerms(query);
  if (terms.length === 0) {
    return undefined;
  }
  const ov = await requiredOpenVikingCli();
  const scopes = [
    `viking://user/${uriSegment(config.user)}/memories`,
    `viking://agent/${uriSegment(config.agentId)}/memories`,
  ];
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
        replaceUri: z
          .string()
          .optional()
          .describe('Optional viking:// memory URI to forget after the new memory is safely stored'),
        text: z.string().optional().describe('Required memory text to store'),
        sourceAgentClient: z.string().optional().describe('Originating client, for example cursor, codex, or claude'),
      },
    },
    async ({replaceUri, sourceAgentClient, text}) => {
      const checkedText = requiredText(text, name, 'text', {text: 'Durable engineering note...'});
      if (!checkedText.ok) {
        return checkedText.error;
      }
      const checkedReplaceUri = optionalVikingUri(replaceUri, name);
      if (!checkedReplaceUri.ok) {
        return checkedReplaceUri.error;
      }
      const header = [
        'MEMORY',
        `source_agent_client: ${sourceAgentClient ?? 'mcp'}`,
        `timestamp: ${new Date().toISOString()}`,
      ];
      if (checkedReplaceUri.value) {
        header.push(`supersedes: ${checkedReplaceUri.value}`);
      }
      return writeDurableMemory(config, [...header, '', checkedText.value].join('\n'), checkedReplaceUri.value);
    },
  );
}

async function writeDurableMemory(
  config: RuntimeConfig,
  memory: string,
  replaceUri: string | undefined,
): Promise<CallToolResult> {
  try {
    const ov = await requiredOpenVikingCli();
    const directoryUri = durableMemoryDirectoryUri(config);
    const stat = await runCommand(ov, withIdentity(config, ['stat', directoryUri]), {allowFailure: true});
    if (stat.exitCode !== 0) {
      await runCommand(
        ov,
        withIdentity(config, [
          'mkdir',
          directoryUri,
          '--description',
          'Threadnote durable handoffs, memories, and cross-agent notes.',
        ]),
      );
    }

    const memoryUri = durableMemoryUri(config, memory);
    const result = await runOpenVikingWriteWithRetry(
      ov,
      config,
      memoryUri,
      withIdentity(config, ['write', memoryUri, '--content', memory, '--mode', 'create', '--wait', '--timeout', '120']),
    );
    const messages = [`Stored durable memory: ${memoryUri}`];
    if (replaceUri) {
      await runCommand(ov, withIdentity(config, ['rm', replaceUri]));
      messages.push(`Forgot replaced memory: ${replaceUri}`);
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

function isResourceBusy(stderr: string, stdout: string): boolean {
  return `${stderr}\n${stdout}`.includes('resource is busy');
}

function durableMemoryUri(config: RuntimeConfig, memory: string): string {
  return `${durableMemoryDirectoryUri(config)}/threadnote-${safeTimestamp()}-${sha256(memory).slice(0, 12)}.md`;
}

function durableMemoryDirectoryUri(config: RuntimeConfig): string {
  return `viking://user/${uriSegment(config.user)}/memories/events`;
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
