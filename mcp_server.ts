#! /usr/bin/env node

import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {z} from 'zod';

const DEFAULT_ACCOUNT = 'local';
const DEFAULT_AGENT_ID = 'threadnote';

interface RuntimeConfig {
  readonly account: string;
  readonly agentId: string;
  readonly user: string;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function main(): Promise<void> {
  const config = getRuntimeConfig();
  const server = new McpServer(
    {name: 'threadnote-local-adapter', version: '0.1.0'},
    {
      instructions: [
        '# Threadnote Local Adapter',
        '',
        'Stdio MCP adapter for Threadnote shared local context.',
        'Use `search` to find candidate viking:// URIs, then `read` files or `list` directories.',
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
  server.registerTool(
    'search',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Search OpenViking context and return candidate viking:// URIs with abstracts.',
      inputSchema: {
        query: z.string().min(1).describe('Search query'),
        uri: z.string().optional().describe('Optional viking:// subtree to search'),
        nodeLimit: z.number().int().positive().max(100).optional().describe('Maximum result count'),
      },
    },
    async ({nodeLimit, query, uri}) =>
      runOpenVikingTool(config, [
        'search',
        query,
        ...(uri ? ['--uri', uri] : []),
        ...(nodeLimit ? ['--node-limit', String(nodeLimit)] : []),
      ]),
  );

  server.registerTool(
    'read',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Read a viking:// file URI returned by search or list.',
      inputSchema: {
        uri: z.string().startsWith('viking://').describe('viking:// file URI'),
      },
    },
    async ({uri}) => runOpenVikingTool(config, ['read', uri]),
  );

  server.registerTool(
    'list',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'List a viking:// directory. Use this when search returns a directory or overview node.',
      inputSchema: {
        uri: z.string().startsWith('viking://').optional().describe('viking:// directory URI'),
        all: z.boolean().optional().describe('Show hidden files like .abstract.md and .overview.md'),
        recursive: z.boolean().optional().describe('List recursively'),
        simple: z.boolean().optional().describe('Only return paths'),
        nodeLimit: z.number().int().positive().max(1000).optional().describe('Maximum node count'),
      },
    },
    async ({all, nodeLimit, recursive, simple, uri}) =>
      runOpenVikingTool(config, [
        'ls',
        uri ?? 'viking://',
        ...(all === true ? ['--all'] : []),
        ...(recursive === true ? ['--recursive'] : []),
        ...(simple === true ? ['--simple'] : []),
        ...(nodeLimit ? ['--node-limit', String(nodeLimit)] : []),
      ]),
  );

  server.registerTool(
    'store',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description:
        'Store a durable memory in OpenViking. Never store secrets, credentials, customer data, or raw logs.',
      inputSchema: {
        text: z.string().min(1).describe('Memory text to store'),
        sourceAgentClient: z.string().optional().describe('Originating client, for example codex or claude'),
      },
    },
    async ({sourceAgentClient, text}) =>
      runOpenVikingTool(config, [
        'add-memory',
        [
          'MEMORY',
          `source_agent_client: ${sourceAgentClient ?? 'mcp'}`,
          `timestamp: ${new Date().toISOString()}`,
          '',
          text.trim(),
        ].join('\n'),
      ]),
  );

  server.registerTool(
    'forget',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: 'Remove a viking:// URI from OpenViking.',
      inputSchema: {
        uri: z.string().startsWith('viking://').describe('viking:// URI to remove'),
      },
    },
    async ({uri}) => runOpenVikingTool(config, ['rm', uri]),
  );

  server.registerTool(
    'add_resource',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Add a local file or directory to OpenViking as a resource.',
      inputSchema: {
        sourcePath: z.string().min(1).describe('Local source file or directory'),
        to: z.string().startsWith('viking://').describe('Destination viking:// URI'),
        wait: z.boolean().optional().describe('Wait for processing to finish'),
      },
    },
    async ({sourcePath, to, wait}) =>
      runOpenVikingTool(config, ['add-resource', sourcePath, '--to', to, ...(wait === false ? [] : ['--wait'])]),
  );

  server.registerTool(
    'grep',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Run exact text search in OpenViking.',
      inputSchema: {
        pattern: z.string().min(1).describe('Text or regex pattern'),
        uri: z.string().startsWith('viking://').optional().describe('Optional viking:// subtree'),
      },
    },
    async ({pattern, uri}) => runOpenVikingTool(config, ['grep', pattern, ...(uri ? ['--uri', uri] : [])]),
  );

  server.registerTool(
    'glob',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Run glob file search in OpenViking.',
      inputSchema: {
        pattern: z.string().min(1).describe('Glob pattern'),
        uri: z.string().startsWith('viking://').optional().describe('Optional viking:// subtree'),
      },
    },
    async ({pattern, uri}) => runOpenVikingTool(config, ['glob', pattern, ...(uri ? ['--uri', uri] : [])]),
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

async function findExecutable(commands: readonly string[]): Promise<string | undefined> {
  for (const command of commands) {
    const result = await runCommand('which', [command], {allowFailure: true});
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }
  return undefined;
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

async function runCommand(
  executable: string,
  args: readonly string[],
  options: {readonly allowFailure?: boolean} = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args);
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout.on('data', chunk => {
      stdoutChunks.push(String(chunk));
    });
    child.stderr.on('data', chunk => {
      stderrChunks.push(String(chunk));
    });
    child.on('error', err => {
      if (options.allowFailure === true) {
        resolvePromise({exitCode: 127, stderr: errorMessage(err), stdout: ''});
      } else {
        rejectPromise(err);
      }
    });
    child.on('close', code => {
      const result = {
        exitCode: code ?? 1,
        stderr: stderrChunks.join(''),
        stdout: stdoutChunks.join(''),
      };
      if (result.exitCode !== 0 && options.allowFailure !== true) {
        rejectPromise(new Error(`${executable} ${args.join(' ')} failed: ${result.stderr || result.stdout}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch(err => {
  process.stderr.write(`${errorMessage(err)}\n`);
  process.exit(1);
});
