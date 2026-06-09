import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {describe, expect, it} from 'vitest';

interface TextContent {
  readonly text: string;
  readonly type: 'text';
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, {encoding: 'utf8', mode: 0o700});
  await chmod(path, 0o700);
}

async function makeFakeBin(root: string): Promise<string> {
  const bin = join(root, 'bin');
  await mkdir(bin, {recursive: true});
  await writeExecutable(
    join(bin, 'ov'),
    `#! /usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');
`,
  );
  return bin;
}

async function makeNativeMcpServer(): Promise<{close: () => Promise<void>; url: string}> {
  const server = createServer(async (req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const body = bodyText ? JSON.parse(bodyText) : undefined;
      const response = nativeMcpResponse(body);
      if (response === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(response));
    } catch (err: unknown) {
      res.writeHead(500).end(err instanceof Error ? err.message : String(err));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    close: async () => {
      await closeServer(server);
    },
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}

function nativeMcpResponse(body: unknown): unknown {
  const request = body as {id?: string | number; method?: string; params?: Record<string, unknown>};
  if (request.method === 'initialize') {
    return {
      id: request.id,
      jsonrpc: '2.0',
      result: {
        capabilities: {tools: {}},
        protocolVersion: '2025-06-18',
        serverInfo: {name: 'fake-openviking', version: '0.0.0'},
      },
    };
  }
  if (request.method === 'notifications/initialized') {
    return undefined;
  }
  if (request.method === 'tools/call') {
    const params = request.params as {arguments?: Record<string, unknown>; name?: string};
    return {
      id: request.id,
      jsonrpc: '2.0',
      result: {
        content: [{type: 'text', text: `${params.name}:${JSON.stringify(params.arguments ?? {})}`}],
      },
    };
  }
  return {
    id: request.id,
    jsonrpc: '2.0',
    error: {code: -32601, message: `Unsupported method: ${request.method}`},
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()));
  });
}

async function withMcpClient<T>(
  fn: (client: Client) => Promise<T>,
  options: {readonly nativeMcpUrl?: string} = {},
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-mcp-ov-parity-'));
  const home = join(root, 'home');
  await mkdir(home, {recursive: true});
  const fakeBin = await makeFakeBin(root);
  const nativeMcp = options.nativeMcpUrl === undefined ? await makeNativeMcpServer() : undefined;
  const repoRoot = process.cwd();
  const transport = new StdioClientTransport({
    args: [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(repoRoot, 'src', 'mcp_server.ts')],
    command: process.execPath,
    cwd: repoRoot,
    env: {
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_AGENT_ID: 'threadnote',
      THREADNOTE_HOME: home,
      THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
      THREADNOTE_OPENVIKING_MCP_URL: options.nativeMcpUrl ?? nativeMcp?.url ?? '',
      THREADNOTE_USER: 'denyskashkovskyi',
    },
    stderr: 'pipe',
  });
  const client = new Client({name: 'threadnote-test', version: '0.0.0'});
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
    await nativeMcp?.close().catch(() => undefined);
    await rm(root, {force: true, recursive: true});
  }
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({arguments: args, name}, undefined, {timeout: 5000});
  expect(Array.isArray(result.content)).toBe(true);
  const text = (result.content as TextContent[]).map(item => item.text).join('\n');
  expect(result.isError, text).not.toBe(true);
  return text;
}

function firstArgs(text: string): readonly string[] {
  const [line] = text.trim().split('\n');
  return JSON.parse(line ?? '[]') as string[];
}

describe('Threadnote MCP OpenViking parity tools', () => {
  it('registers raw OpenViking MCP parity helpers', async () => {
    await withMcpClient(async client => {
      const tools = await client.listTools();
      const names = tools.tools.map(tool => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'ov_search',
          'ov_read',
          'ov_list',
          'ov_store',
          'ov_remember',
          'ov_add_resource',
          'ov_list_watches',
          'ov_cancel_watch',
          'ov_grep',
          'ov_glob',
          'ov_forget',
          'ov_code_outline',
          'ov_code_search',
          'ov_code_expand',
          'ov_health',
        ]),
      );
    });
  });

  it('forwards documented native parameters through the OpenViking CLI', async () => {
    await withMcpClient(async client => {
      expect(
        firstArgs(
          await callText(client, 'ov_search', {
            limit: 4,
            min_score: 0.25,
            query: 'release notes',
            target_uri: 'viking://resources/repos/threadnote',
          }),
        ),
      ).toEqual(
        expect.arrayContaining([
          'search',
          'release notes',
          '--uri',
          'viking://resources/repos/threadnote',
          '--node-limit',
          '4',
          '--threshold',
          '0.25',
        ]),
      );

      const readOutput = await callText(client, 'ov_read', {
        uris: ['viking://resources/repos/threadnote/README.md', 'viking://resources/repos/threadnote/docs/share.md'],
      });
      expect(
        readOutput
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as string[]),
      ).toEqual([
        expect.arrayContaining(['read', 'viking://resources/repos/threadnote/README.md']),
        expect.arrayContaining(['read', 'viking://resources/repos/threadnote/docs/share.md']),
      ]);

      expect(
        firstArgs(
          await callText(client, 'add_resource', {
            description: 'Threadnote docs',
            path: 'https://github.com/Kashkovsky/threadnote.git',
            to: 'viking://resources/repos/threadnote',
            wait: false,
            watch_interval: 30,
          }),
        ),
      ).toEqual(
        expect.arrayContaining([
          'add-resource',
          'https://github.com/Kashkovsky/threadnote.git',
          '--to',
          'viking://resources/repos/threadnote',
          '--reason',
          'Threadnote docs',
          '--watch-interval',
          '30',
        ]),
      );

      expect(
        firstArgs(
          await callText(client, 'grep', {
            case_insensitive: true,
            node_limit: 7,
            pattern: 'native mcp',
            uri: 'viking://resources/repos/threadnote',
          }),
        ),
      ).toEqual(
        expect.arrayContaining([
          'grep',
          'native mcp',
          '--uri',
          'viking://resources/repos/threadnote',
          '--ignore-case',
          '--node-limit',
          '7',
        ]),
      );

      expect(
        firstArgs(
          await callText(client, 'forget', {
            recursive: true,
            uri: 'viking://resources/repos/threadnote/tmp',
          }),
        ),
      ).toEqual(expect.arrayContaining(['rm', 'viking://resources/repos/threadnote/tmp', '--recursive']));
    });
  });

  it('maps native watch and code tools', async () => {
    await withMcpClient(async client => {
      expect(
        await callText(client, 'ov_code_outline', {
          uri: 'viking://resources/repos/threadnote/src/mcp_server.ts',
        }),
      ).toContain('code_outline:{"uri":"viking://resources/repos/threadnote/src/mcp_server.ts"}');

      expect(
        await callText(client, 'ov_code_search', {
          query: 'registerTool',
          uri: 'viking://resources/repos/threadnote/src',
        }),
      ).toContain('code_search:{"query":"registerTool","uri":"viking://resources/repos/threadnote/src"}');

      expect(
        await callText(client, 'ov_code_expand', {
          symbol: 'registerTools',
          uri: 'viking://resources/repos/threadnote/src/mcp_server.ts',
        }),
      ).toContain(
        'code_expand:{"symbol":"registerTools","uri":"viking://resources/repos/threadnote/src/mcp_server.ts"}',
      );

      expect(firstArgs(await callText(client, 'ov_list_watches', {active_only: true}))).toEqual(
        expect.arrayContaining(['task', 'watch', 'ls', '--active-only']),
      );
      expect(
        firstArgs(
          await callText(client, 'ov_cancel_watch', {
            to_uri: 'viking://resources/repos/threadnote',
          }),
        ),
      ).toEqual(expect.arrayContaining(['task', 'watch', 'rm', 'viking://resources/repos/threadnote']));
    });
  });

  it('returns a tool error when the native MCP URL is invalid', async () => {
    await withMcpClient(
      async client => {
        const result = await client.callTool(
          {
            arguments: {uri: 'viking://resources/repos/threadnote/src/mcp_server.ts'},
            name: 'ov_code_outline',
          },
          undefined,
          {timeout: 5000},
        );
        expect(result.isError).toBe(true);
        const text = (result.content as TextContent[]).map(item => item.text).join('\n');
        expect(text).toContain('OpenViking native MCP tool "code_outline" failed at not-a-url');
      },
      {nativeMcpUrl: 'not-a-url'},
    );
  });
});
