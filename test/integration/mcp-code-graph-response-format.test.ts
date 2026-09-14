import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {describe, expect, it} from 'vitest';
import {Effect} from 'effect';
import {
  indexPreparedCodeGraphWorksetFixture,
  publishIndexedCodeGraphWorksetCatalog,
} from '../../scripts/support/code-graph-workset-harness.js';
import {
  prepareCodeGraphWorksetFixture,
  removePreparedCodeGraphWorksetFixture,
} from '../../scripts/support/code-graph-workset-fixture.js';
import {execFileSync} from '../helpers/node-child-process.js';
import {cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from '../helpers/node-fs.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {codeGraphEvaluationFixtureHash, parseCodeGraphEvaluationFixtureV1} from '../../src/evaluation/code-graph.js';
import {measureAgentToolResponse} from '../../src/evaluation/agent-response.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('MCP code graph response format', () => {
  it('preserves the complete projected graph across the default and opt-in text format', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-graph-format-'));
    const repository = join(root, 'repository');
    const home = join(root, 'home');
    const fixture = parseCodeGraphEvaluationFixtureV1(
      await Bun.file(join(process.cwd(), 'test/evaluation/fixtures/code-graph-v1/fixture.json')).json(),
    );
    const baseline = (await Bun.file(
      join(process.cwd(), 'test/evaluation/baselines/graph-response-single-channel-v1/baseline.json'),
    ).json()) as {fixtureHash: string; totals: {dualBytes: number; textBytes: number}};
    let client: Client | undefined;
    try {
      cpSync(join(process.cwd(), 'test/evaluation/fixtures/code-graph-v1', fixture.repositoryRoot), repository, {
        recursive: true,
      });
      mkdirSync(home);
      writeFileSync(join(home, 'seed-manifest.yaml'), 'version: 1\nprojects: []\n');
      execFileSync('git', ['init', '-q'], {cwd: repository});
      execFileSync('git', ['add', '.'], {cwd: repository});
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Threadnote Evaluation',
          '-c',
          'user.email=evaluation@threadnote.local',
          'commit',
          '-qm',
          'fixture',
        ],
        {cwd: repository},
      );
      await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: repository, threadnoteHome: home});
        }),
      );

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), 'src/standalone.ts'), 'mcp-server'],
        cwd: process.cwd(),
        stderr: 'pipe',
        env: {
          ...process.env,
          THREADNOTE_HOME: home,
          THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
          THREADNOTE_ACCOUNT: 'local',
          THREADNOTE_USER: 'tester',
          THREADNOTE_TELEMETRY: '0',
          THREADNOTE_MCP_TOOLSET: 'core',
        },
      });
      client = new Client({name: 'graph-format-evaluation', version: '1'});
      await client.connect(transport);
      const tool = (await client.listTools()).tools.find(candidate => candidate.name === 'inspect_code_graph');
      expect(JSON.stringify(tool?.inputSchema)).toContain('responseFormat');

      let dualBytes = 0;
      let textBytes = 0;
      for (const query of fixture.queries) {
        const args = {
          callerCwd: repository,
          operation: query.operation,
          ...(query.query === undefined ? {} : {query: query.query}),
          ...(query.from === undefined ? {} : {from: query.from}),
          ...(query.to === undefined ? {} : {to: query.to}),
        };
        const dual = await client.callTool({name: 'inspect_code_graph', arguments: args});
        const text = await client.callTool({
          name: 'inspect_code_graph',
          arguments: {...args, responseFormat: 'text'},
        });
        expect(dual.isError).not.toBe(true);
        expect(text.isError).not.toBe(true);
        expect(dual.structuredContent).toBeDefined();
        expect(text.structuredContent).toBeUndefined();
        if (!Array.isArray(text.content)) throw new Error('Graph response content was not an array');
        expect(text.content).toHaveLength(1);
        const dualText = firstText(dual.content);
        const textOnly = firstText(text.content);
        const parsed = JSON.parse(textOnly);
        expect(parsed).toEqual(dual.structuredContent);
        expect(parsed.trust).toEqual((dual.structuredContent as {trust: unknown}).trust);
        expect(parsed.snapshot).toEqual((dual.structuredContent as {snapshot: unknown}).snapshot);
        dualBytes += measureAgentToolResponse({
          text: dualText,
          structuredContent: dual.structuredContent,
        }).totalBytes;
        textBytes += measureAgentToolResponse({text: textOnly}).totalBytes;
      }
      expect(codeGraphEvaluationFixtureHash(fixture)).toBe(baseline.fixtureHash);
      expect({dualBytes, textBytes}).toEqual(baseline.totals);
      expect(textBytes).toBeLessThan(dualBytes * 0.9);
    } finally {
      await client?.close();
      rmSync(root, {recursive: true, force: true});
    }
  }, 120_000);

  it('preserves named Workset query and topology projections through the same opt-in channel', async () => {
    const fixture = await prepareCodeGraphWorksetFixture({size: 1});
    let client: Client | undefined;
    try {
      await runEffect(
        Effect.gen(function* () {
          yield* indexPreparedCodeGraphWorksetFixture(fixture);
          yield* publishIndexedCodeGraphWorksetCatalog(fixture, [fixture.identity.worksetName]);
        }),
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), 'src/standalone.ts'), 'mcp-server'],
        cwd: process.cwd(),
        stderr: 'pipe',
        env: {
          ...process.env,
          THREADNOTE_HOME: fixture.home,
          THREADNOTE_MANIFEST: fixture.manifestPath,
          THREADNOTE_ACCOUNT: 'local',
          THREADNOTE_USER: 'tester',
          THREADNOTE_TELEMETRY: '0',
          THREADNOTE_MCP_TOOLSET: 'core',
        },
      });
      client = new Client({name: 'graph-format-workset-evaluation', version: '1'});
      await client.connect(transport);
      const callerCwd = fixture.repositories[0].path;
      const workset = fixture.identity.worksetName;
      const query = fixture.plan.queries.find(
        candidate => candidate.sizes.includes(1) && candidate.operation === 'query',
      );
      if (query === undefined) throw new Error('Workset fixture had no size-1 query');
      for (const args of [
        {budgetTokens: 500, callerCwd, operation: 'query', query: query.query, workset},
        {callerCwd, operation: 'topology', workset},
      ]) {
        const dual = await client.callTool({name: 'inspect_code_graph', arguments: args});
        const text = await client.callTool({
          name: 'inspect_code_graph',
          arguments: {...args, responseFormat: 'text'},
        });
        expect(dual.isError).not.toBe(true);
        expect(text.isError).not.toBe(true);
        expect(text.structuredContent).toBeUndefined();
        const parsed = JSON.parse(firstText(text.content));
        expect(withoutWorksetCursor(parsed)).toEqual(withoutWorksetCursor(dual.structuredContent));
        if (args.operation === 'query') {
          const textCursor = (parsed as {continuation?: {cursor?: string}}).continuation?.cursor;
          const dualCursor = (dual.structuredContent as {continuation?: {cursor?: string}}).continuation?.cursor;
          expect(textCursor).toMatch(/^cgwc_/);
          expect(dualCursor).toMatch(/^cgwc_/);
          if (textCursor === undefined || dualCursor === undefined) throw new Error('Missing Workset continuation');
          const dualContinued = await client.callTool({
            name: 'inspect_code_graph',
            arguments: {callerCwd, cursor: dualCursor, operation: 'query', workset},
          });
          const textContinued = await client.callTool({
            name: 'inspect_code_graph',
            arguments: {callerCwd, cursor: textCursor, operation: 'query', responseFormat: 'text', workset},
          });
          expect(dualContinued.isError).not.toBe(true);
          expect(textContinued.isError).not.toBe(true);
          expect(textContinued.structuredContent).toBeUndefined();
          expect(withoutWorksetCursor(JSON.parse(firstText(textContinued.content)))).toEqual(
            withoutWorksetCursor(dualContinued.structuredContent),
          );
        }
      }
    } finally {
      await client?.close();
      await removePreparedCodeGraphWorksetFixture(fixture);
    }
  }, 120_000);
});

function firstText(content: unknown): string {
  if (!Array.isArray(content)) throw new Error('Graph response content was not an array');
  const first: unknown = content[0];
  if (typeof first !== 'object' || first === null || !('type' in first) || first.type !== 'text') {
    throw new Error('Graph response did not contain text');
  }
  if (!('text' in first) || typeof first.text !== 'string') throw new Error('Graph response text was invalid');
  return first.text;
}

function withoutWorksetCursor(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item) => (key === 'cursor' && typeof item === 'string' ? '<cursor>' : item)),
  );
}
