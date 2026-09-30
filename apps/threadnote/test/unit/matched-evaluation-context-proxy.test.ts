import {chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {
  handleMatchedEvaluationContextRequest,
  handleMatchedEvaluationFollowupRequest,
  hashMatchedEvaluationContextContent,
  hashMatchedEvaluationContextRequest,
  matchedEvaluationContextTools,
  renderMatchedEvaluationRuntimeManifestV1,
  type MatchedEvaluationContextProxyPacketV1,
} from '../../../../scripts/matched-evaluation-context-proxy.js';

describe('matched evaluation context proxy', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {force: true, recursive: true})));
  });

  it('uses a sealed run-local manifest bound to the isolated repository', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots);

    const result = await handleMatchedEvaluationContextRequest(fixture.packet, {
      callerCwd: fixture.repository,
      project: fixture.packet.project,
    });

    expect(JSON.parse(result.content[0].text)).toEqual(preparedEvidence);
    expect(result.structuredContent).toBeUndefined();
    expect(result.meta).toMatchObject({
      matchedEvaluation: {
        graphReady: true,
        runNonce: fixture.packet.runNonce,
        runtimeManifestSha256: fixture.packet.runtimeManifestSha256,
        contentResponseSha256: sha256HexSync(Buffer.from(result.content[0].text)),
        frozenPromptSha256: sha256HexSync(Buffer.from(fixture.packet.prompt)),
        version: 3,
      },
    });
  });

  it('hashes arbitrary response text deterministically', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 256}), value => {
        expect(hashMatchedEvaluationContextContent(value)).toBe(sha256HexSync(value));
        expect(hashMatchedEvaluationContextContent(value)).toHaveLength(64);
      }),
      {numRuns: 50},
    );
  });

  it('uses the packet prompt verbatim and rejects caller task injection', async () => {
    if (process.platform === 'win32') return;
    const prompt = '## Escaped `prompt`\n\nline \\  \u00a0\n';
    const fixture = await contextFixture(roots, prompt);
    const result = await handleMatchedEvaluationContextRequest(fixture.packet, {
      callerCwd: fixture.repository,
    });

    expect(JSON.parse(result.content[0].text)).toEqual(preparedEvidence);
    expect(await fixture.seenTask()).toBe(prompt);
    await expect(
      handleMatchedEvaluationContextRequest(fixture.packet, {
        callerCwd: fixture.repository,
        task: 'injected task',
      }),
    ).rejects.toThrow('Expected no excess property');
  });

  it('preserves the v3 contract across the real MCP stdio transport', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots, 'Markdown **prompt** with trailing spaces  \n');
    const packetPath = join(fixture.root, 'packet.json');
    await writeFile(packetPath, JSON.stringify(fixture.packet));
    const transport = new StdioClientTransport({
      args: [join(process.cwd(), 'scripts/matched-evaluation-context-proxy.ts')],
      command: process.execPath,
      cwd: process.cwd(),
      env: {...process.env, MATCHED_EVALUATION_CONTEXT_PACKET: packetPath},
      stderr: 'pipe',
    });
    const client = new Client({name: 'matched-context-proxy-test', version: '1'});
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual(
        [...matchedEvaluationContextTools(fixture.packet.detail)].sort(),
      );
      const tool = listed.tools.find(candidate => candidate.name === 'context_brief');
      expect(tool).toBeDefined();
      expect(JSON.stringify(tool?.inputSchema)).not.toContain('task');

      const early = await client.callTool({
        name: 'inspect_code_graph',
        arguments: {callerCwd: fixture.repository, operation: 'query', query: 'fixture'},
      });
      expect(early.isError).toBe(true);

      const result = await client.callTool({
        name: 'context_brief',
        arguments: {callerCwd: fixture.repository, project: fixture.packet.project},
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toHaveLength(1);
      const content = result.content as readonly {readonly text: string; readonly type: string}[];
      expect(content[0]).toMatchObject({type: 'text'});
      expect('structuredContent' in result).toBe(false);
      expect(result._meta).toMatchObject({
        matchedEvaluation: {
          version: 3,
          runNonce: fixture.packet.runNonce,
          runtimeManifestSha256: fixture.packet.runtimeManifestSha256,
          contentResponseSha256: sha256HexSync(Buffer.from(content[0].text)),
          frozenPromptSha256: sha256HexSync(Buffer.from(fixture.packet.prompt)),
        },
      });

      const injected = await client.callTool({
        name: 'context_brief',
        arguments: {callerCwd: fixture.repository, task: 'injected task'},
      });
      expect(injected.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('preserves native memory text when structured content is only metadata and authenticates follow-up errors', async () => {
    const fixture = await contextFixture(roots, 'memory prompt', 'compact', 'linked');
    const args = {uri: 'threadnote://memory/tn_prepared'};
    const result = await handleMatchedEvaluationFollowupRequest(fixture.packet, 'read_context', args, async () => ({
      content: [{type: 'text' as const, text: 'The actual memory evidence.'}],
      structuredContent: {type: 'threadnote-read', contentBytes: 27, contentChannel: 'text'},
    }));
    expect(result.content).toEqual([{type: 'text', text: 'The actual memory evidence.'}]);
    expect(result.structuredContent).toBeUndefined();
    const failed = await handleMatchedEvaluationFollowupRequest(fixture.packet, 'read_context', args, async () => {
      throw new Error('bounded backend failure');
    });
    expect(failed.isError).toBe(true);
    expect(failed.meta).toMatchObject({
      matchedEvaluation: {
        toolName: 'read_context',
        success: false,
        requestSha256: hashMatchedEvaluationContextRequest('read_context', args),
        contentResponseSha256: hashMatchedEvaluationContextContent(failed.content[0].text),
      },
    });
    expect(matchedEvaluationContextTools('compact')).toEqual([
      ...matchedEvaluationContextTools('graph-only'),
      'recall_context',
      'read_context',
    ]);
    expect(matchedEvaluationContextTools('source')).toEqual(['context_brief']);
  });

  it('rejects tampered, rebound, and escaped runtime manifests', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots);
    const request = {callerCwd: fixture.repository};

    await writeFile(fixture.manifest, '{}\n');
    await expect(handleMatchedEvaluationContextRequest(fixture.packet, request)).rejects.toThrow(
      'differs from the sealed artifact',
    );

    const rebound = renderMatchedEvaluationRuntimeManifestV1(
      fixture.packet.project,
      join(fixture.root, 'different-repository'),
      fixture.packet.runNonce,
    );
    await writeFile(fixture.manifest, rebound);
    await expect(
      handleMatchedEvaluationContextRequest(
        {...fixture.packet, runtimeManifestSha256: sha256HexSync(Buffer.from(rebound))},
        request,
      ),
    ).rejects.toThrow('does not bind the isolated repository and run');

    const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-matched-context-outside-')));
    roots.push(outsideRoot);
    const escapedManifest = join(outsideRoot, 'manifest.yaml');
    const expected = renderMatchedEvaluationRuntimeManifestV1(
      fixture.packet.project,
      fixture.repository,
      fixture.packet.runNonce,
    );
    await writeFile(escapedManifest, expected, {mode: 0o600});
    await expect(
      handleMatchedEvaluationContextRequest(
        {
          ...fixture.packet,
          runtimeManifestPath: escapedManifest,
          runtimeManifestSha256: sha256HexSync(Buffer.from(expected)),
        },
        request,
      ),
    ).rejects.toThrow('escaped its isolated private root');
  });

  it('exposes only graph follow-ups for graph-only treatment and binds scope', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots, 'graph prompt', 'graph-only');
    const invoke = async (_packet: unknown, name: string, args: Record<string, unknown>) => ({
      content: [{type: 'text' as const, text: JSON.stringify({name, args})}],
    });
    const result = await handleMatchedEvaluationFollowupRequest(
      fixture.packet,
      'inspect_code_graph',
      {callerCwd: fixture.repository, project: fixture.packet.project, operation: 'query', query: 'fixture'},
      invoke,
    );
    expect(result.isError).not.toBe(true);
    await expect(
      handleMatchedEvaluationFollowupRequest(
        fixture.packet,
        'recall_context',
        {callerCwd: fixture.repository, project: fixture.packet.project, query: 'memory'},
        invoke,
      ),
    ).rejects.toThrow('Tool is not allowed');
    await expect(
      handleMatchedEvaluationFollowupRequest(
        fixture.packet,
        'inspect_code_graph',
        {callerCwd: fixture.repository, project: 'other', operation: 'query', query: 'fixture'},
        invoke,
      ),
    ).rejects.toThrow('project');
    await expect(
      handleMatchedEvaluationFollowupRequest(
        fixture.packet,
        'inspect_code_graph',
        {callerCwd: fixture.root, project: fixture.packet.project, operation: 'query', query: 'fixture'},
        invoke,
      ),
    ).rejects.toThrow('escaped');
    await expect(
      handleMatchedEvaluationFollowupRequest(
        fixture.packet,
        'inspect_code_graph',
        {
          callerCwd: fixture.repository,
          project: fixture.packet.project,
          operation: 'query',
          query: 'fixture',
          workset: 'escape',
        },
        invoke,
      ),
    ).rejects.toThrow('excess property');
  });

  it('allows compact linked-memory follow-ups and rejects escaped memory reads', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots, 'compact prompt', 'compact', 'linked');
    const invoke = async () => ({content: [{type: 'text' as const, text: 'linked result'}]});
    const result = await handleMatchedEvaluationFollowupRequest(
      fixture.packet,
      'read_context',
      {uri: 'threadnote://memory/tn_fixture'},
      invoke,
    );
    expect(result.isError).not.toBe(true);
    await expect(
      handleMatchedEvaluationFollowupRequest(
        fixture.packet,
        'read_context',
        {uri: 'threadnote://memory/../escape'},
        invoke,
      ),
    ).rejects.toThrow('outside the isolated');
    await expect(
      handleMatchedEvaluationFollowupRequest(
        fixture.packet,
        'read_context',
        {uri: `threadnote://user/${fixture.packet.threadnoteUser}/memories/../../escape`},
        invoke,
      ),
    ).rejects.toThrow('outside the isolated');
  });

  it('canonicalizes follow-up request hash independently of object key order', () => {
    fc.assert(
      fc.property(fc.string({minLength: 1, maxLength: 32}), fc.string({minLength: 1, maxLength: 32}), (a, b) => {
        const left = {callerCwd: a, project: b, operation: 'stats'};
        const right = {operation: 'stats', project: b, callerCwd: a};
        expect(hashMatchedEvaluationContextRequest('inspect_code_graph', left)).toBe(
          hashMatchedEvaluationContextRequest('inspect_code_graph', right),
        );
      }),
      {numRuns: 50},
    );
  });
});

const preparedEvidence = {
  answer: 'prepared context',
  graph: {cards: [{path: 'service.ts', summary: 'implementation contract'}]},
  durableDecisions: [{summary: 'linked memory contract'}],
  coverage: {gaps: []},
};

async function contextFixture(
  roots: string[],
  prompt = 'Inspect the isolated repository.',
  detail: 'compact' | 'graph-only' | 'source' = 'graph-only',
  memoryAccess: 'disabled' | 'linked' = 'disabled',
): Promise<{
  readonly manifest: string;
  readonly packet: MatchedEvaluationContextProxyPacketV1;
  readonly repository: string;
  readonly root: string;
  readonly seenTask: () => Promise<string>;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-matched-context-')));
  roots.push(root);
  const repository = join(root, 'repository');
  const threadnoteHome = join(root, 'threadnote-home');
  const privateRoot = join(root, 'agent', 'private');
  await Promise.all([
    mkdir(repository, {recursive: true}),
    mkdir(threadnoteHome, {recursive: true}),
    mkdir(privateRoot, {recursive: true}),
  ]);
  const project = 'matched-evaluation-fixture';
  const runNonce = 'run_0123456789abcdef0123456789abcdef';
  const manifest = join(privateRoot, 'manifest.json');
  const manifestText = renderMatchedEvaluationRuntimeManifestV1(project, repository, runNonce);
  const manifestBytes = Buffer.from(manifestText);
  const executable = join(root, 'threadnote');
  const seenTaskPath = join(root, 'seen-task');
  await writeFile(
    executable,
    `#!/bin/sh
manifest=''
task=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--manifest' ]; then
    shift
    manifest="$1"
  fi
  if [ "$1" = '--task' ]; then
    shift
    task="$1"
  fi
  shift
done
[ -n "$manifest" ] && [ -f "$manifest" ] || exit 17
grep -F ${shellQuote(JSON.stringify(project))} "$manifest" >/dev/null || exit 18
grep -F ${shellQuote(JSON.stringify(repository))} "$manifest" >/dev/null || exit 19
grep -F ${shellQuote(JSON.stringify(runNonce))} "$manifest" >/dev/null || exit 20
[ "$THREADNOTE_ACCOUNT" = 'local' ] || exit 21
[ "$THREADNOTE_USER" = 'evaluation-user' ] || exit 22
printf '%s' "$task" > ${shellQuote(seenTaskPath)}
printf '%s\\n' ${shellQuote(JSON.stringify(preparedEvidence))}
`,
    {mode: 0o700},
  );
  await chmod(executable, 0o700);
  await writeFile(manifest, manifestBytes, {mode: 0o600});
  return {
    manifest,
    packet: {
      budgetTokens: 1_500,
      detail,
      expectedContext: {
        graphContentHash: '1'.repeat(64),
        graphSnapshotHash: '2'.repeat(64),
        linkReceiptsHash: memoryAccess === 'linked' ? '4'.repeat(64) : null,
        memoryAccess,
        studyHash: '3'.repeat(64),
        taskContextHash: memoryAccess === 'linked' ? '5'.repeat(64) : null,
      },
      project,
      prompt,
      repositoryRoot: repository,
      runNonce,
      runtimeManifestPath: manifest,
      runtimeManifestSha256: sha256HexSync(manifestBytes),
      threadnoteAccount: 'local',
      threadnoteExecutable: executable,
      threadnoteExecutableSha256: sha256HexSync(await readFile(executable)),
      threadnoteHome,
      threadnoteUser: 'evaluation-user',
      version: 3,
    },
    repository,
    root,
    seenTask: () => readFile(seenTaskPath, 'utf8'),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
