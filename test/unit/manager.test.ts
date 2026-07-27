import {mkdir, mkdtemp, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NodeHttpServer} from '@effect/platform-node';
import {Console, Effect, Fiber} from 'effect';
import {HttpServer} from 'effect/unstable/http';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  consolidationAgentScript,
  createManagerServer,
  memoryTree,
  parseDoctorChecksFromOutput,
  readManagedMemory,
  resourcesTree,
} from '../../src/manager.js';
import {pruneSelectedMemoryUris, selectableMemoryUris, type TreeNode} from '../../src/manager_ui.js';
import type {RuntimeConfig} from '../../src/types.js';
import * as lifecycle from '../../src/lifecycle.js';
import * as memory from '../../src/memory.js';
import * as seeding from '../../src/seeding.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {runEffect} from '../helpers/effect-runtime.js';

vi.mock('../../src/lifecycle.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/lifecycle.js')>();
  return {
    ...actual,
    runRepair: vi.fn((_config, options) => Console.log(options.dryRun ? 'repair dry run' : 'repair applied')),
  };
});

vi.mock('../../src/memory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/memory.js')>();
  return {
    ...actual,
    runArchive: vi.fn(() => Effect.void),
    runForget: vi.fn(() => Effect.void),
    runRecall: vi.fn((_config, options) => Console.log(`recall result: ${options.query}`)),
  };
});

vi.mock('../../src/seeding.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/seeding.js')>();
  return {
    ...actual,
    runSeed: vi.fn((_config: RuntimeConfig, options: {readonly dryRun?: boolean}) =>
      Console.log(options.dryRun ? 'seed dry run' : 'seed applied'),
    ),
    runSeedSkills: vi.fn((_config: RuntimeConfig, options: {readonly dryRun?: boolean}) =>
      Console.log(options.dryRun ? 'seed skills dry run' : 'seed skills applied'),
    ),
  };
});

async function makeRuntime(): Promise<RuntimeConfig> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-manager-'));
  const root = join(home, 'data', 'local', 'user', 'denys', 'memories');
  await mkdir(join(root, 'durable', 'projects', 'threadnote'), {recursive: true});
  await writeFile(
    join(root, 'durable', 'projects', 'threadnote', 'manager-ui.md'),
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      'project: threadnote',
      'topic: manager-ui',
      'source_agent_client: codex',
      'timestamp: 2026-06-05T00:00:00.000Z',
      '',
      'Manager UI feature notes.',
    ].join('\n'),
  );
  await writeFile(join(root, 'durable', 'projects', 'threadnote', '.abstract.md'), 'generated');
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: join(home, 'manifest.yaml'),
    user: 'denys',
  };
}

function fileNode(uri: string, name: string, isSystem = false): TreeNode {
  return {
    isDir: false,
    isShared: false,
    isSystem,
    name,
    relativePath: `durable/projects/threadnote/${name}`,
    uri,
  };
}

async function startServer(
  config: RuntimeConfig,
  token: string,
): Promise<{readonly close: () => Promise<void>; readonly url: string}> {
  let resolveAddress: ((value: string) => void) | undefined;
  let rejectAddress: ((reason: unknown) => void) | undefined;
  const address = new Promise<string>((resolve, reject) => {
    resolveAddress = resolve;
    rejectAddress = reject;
  });
  const fiber = Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        yield* server.serve(createManagerServer({config, jobs: new Map(), token}));
        const serverAddress = server.address;
        if (serverAddress._tag !== 'TcpAddress') {
          return yield* Effect.fail(new Error('manager test server did not bind to TCP'));
        }
        yield* Effect.sync(() => resolveAddress?.(`http://127.0.0.1:${serverAddress.port}`));
        return yield* Effect.never;
      }),
    ).pipe(
      Effect.provide(NodeHttpServer.layerTest),
      Effect.provide(ApplicationLayer),
      Effect.tapError(error => Effect.sync(() => rejectAddress?.(error))),
    ),
  );
  return {
    close: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined),
    url: await address,
  };
}

describe('manager catalog', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
    vi.mocked(memory.runArchive).mockReset();
    vi.mocked(memory.runForget).mockReset();
    vi.mocked(memory.runRecall)
      .mockReset()
      .mockImplementation((_config, options) => Console.log(`recall result: ${options.query}`));
  });

  it('maps local memory files into Threadnote URIs with parsed metadata', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);

    const tree = await runEffect(memoryTree(config));
    const project = tree.children?.find(child => child.name === 'durable')?.children?.[0]?.children?.[0];
    const leaf = project?.children?.find(child => child.name === 'manager-ui.md');

    expect(leaf?.uri).toBe('threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md');
    expect(leaf?.metadata?.project).toBe('threadnote');
    expect(leaf?.metadata?.topic).toBe('manager-ui');
  });

  it('maps seeded resources into a read-only resources tree', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const root = join(config.agentContextHome, 'data', config.account, 'resources');
    await mkdir(join(root, 'agent-skills', 'codex-global'), {recursive: true});
    await writeFile(join(root, 'agent-skills', 'codex-global', 'threadnote-abc123.md'), 'Skill body');

    const tree = await runEffect(resourcesTree(config));
    const skill = tree.children
      ?.find(child => child.name === 'agent-skills')
      ?.children?.find(child => child.name === 'codex-global')
      ?.children?.find(child => child.name === 'threadnote-abc123.md');

    expect(tree.name).toBe('resources');
    expect(tree.uri).toBe('threadnote://resources');
    expect(skill?.uri).toBe('threadnote://resources/agent-skills/codex-global/threadnote-abc123.md');
    expect(skill?.metadata).toBeUndefined();
  });

  it('reads a memory document and returns content plus metadata', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);

    const result = await runEffect(
      readManagedMemory(config, 'threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md'),
    );

    expect(result.content).toContain('Manager UI feature notes.');
    expect(result.record?.metadata.kind).toBe('durable');
    expect(result.node.isSystem).toBe(false);
  });

  it('skips symlinked memory entries and rejects direct symlink reads', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const root = join(config.agentContextHome, 'data', 'local', 'user', 'denys', 'memories');
    const secretPath = join(config.agentContextHome, 'local-secret.txt');
    const linkPath = join(root, 'durable', 'projects', 'threadnote', 'leak.md');
    await writeFile(secretPath, 'do not expose through manager\n', 'utf8');
    await symlink(secretPath, linkPath);

    const tree = await runEffect(memoryTree(config));
    const project = tree.children?.find(child => child.name === 'durable')?.children?.[0]?.children?.[0];

    expect(project?.children?.map(child => child.name)).not.toContain('leak.md');
    await expect(
      runEffect(readManagedMemory(config, 'threadnote://user/denys/memories/durable/projects/threadnote/leak.md')),
    ).rejects.toThrow(/regular memory files/);
  });
});

describe('manager UI selection helpers', () => {
  function selectionTree(): TreeNode {
    return {
      children: [
        fileNode('threadnote://user/denys/memories/durable/projects/threadnote/first.md', 'first.md'),
        fileNode('threadnote://user/denys/memories/durable/projects/threadnote/second.md', 'second.md'),
        fileNode('threadnote://user/denys/memories/durable/projects/threadnote/.abstract.md', '.abstract.md', true),
      ],
      isDir: true,
      isShared: false,
      isSystem: false,
      name: 'threadnote',
      relativePath: 'durable/projects/threadnote',
      uri: 'threadnote://user/denys/memories/durable/projects/threadnote',
    };
  }

  it('limits folder selection to visible filtered memory files', () => {
    const tree = selectionTree();

    expect(selectableMemoryUris(tree, {filter: 'first', showSystem: false})).toEqual([
      'threadnote://user/denys/memories/durable/projects/threadnote/first.md',
    ]);
    expect(selectableMemoryUris(tree, {filter: '', showSystem: false})).toEqual([
      'threadnote://user/denys/memories/durable/projects/threadnote/first.md',
      'threadnote://user/denys/memories/durable/projects/threadnote/second.md',
    ]);
  });

  it('prunes hidden selected memories before bulk actions', () => {
    const tree = selectionTree();
    const selected = new Set([
      'threadnote://user/denys/memories/durable/projects/threadnote/first.md',
      'threadnote://user/denys/memories/durable/projects/threadnote/second.md',
      'threadnote://user/denys/memories/durable/projects/threadnote/.abstract.md',
    ]);

    expect([...pruneSelectedMemoryUris(selected, tree, {filter: 'first', showSystem: false})]).toEqual([
      'threadnote://user/denys/memories/durable/projects/threadnote/first.md',
    ]);

    const visibleOnly = new Set(['threadnote://user/denys/memories/durable/projects/threadnote/first.md']);
    expect(pruneSelectedMemoryUris(visibleOnly, tree, {filter: 'first', showSystem: false})).toBe(visibleOnly);
  });
});

describe('manager http API', () => {
  const homes: string[] = [];

  beforeEach(() => {
    vi.mocked(lifecycle.runRepair)
      .mockReset()
      .mockImplementation((_config, options) => Console.log(options.dryRun ? 'repair dry run' : 'repair applied'));
    vi.mocked(memory.runArchive).mockReset();
    vi.mocked(memory.runForget).mockReset();
    vi.mocked(seeding.runSeed).mockClear();
    vi.mocked(seeding.runSeedSkills).mockClear();
  });

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('requires the session token for API requests', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const rejected = await fetch(`${server.url}/api/tree`);
      expect(rejected.status).toBe(401);

      const accepted = await fetch(`${server.url}/api/tree`, {headers: {authorization: 'Bearer secret'}});
      const body = (await accepted.json()) as {readonly resourcesTree?: TreeNode; readonly tree?: TreeNode};
      expect(accepted.status).toBe(200);
      expect(body.tree?.uri).toBe('threadnote://user/denys/memories');
      expect(body.resourcesTree?.uri).toBe('threadnote://resources');
    } finally {
      await server.close();
    }
  });

  it('returns per-item bulk results without hiding failures', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    vi.mocked(memory.runArchive).mockImplementation((_config, uri) => {
      if (uri.endsWith('bad.md')) {
        return Effect.fail(new Error('archive failed'));
      }
      return Effect.succeed(undefined);
    });
    const server = await startServer(config, 'secret');
    try {
      const response = await fetch(`${server.url}/api/bulk`, {
        body: JSON.stringify({
          action: 'archive',
          confirm: true,
          uris: [
            'threadnote://user/denys/memories/durable/projects/threadnote/good.md',
            'threadnote://user/denys/memories/durable/projects/threadnote/bad.md',
          ],
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = (await response.json()) as {
        readonly results: readonly {readonly ok: boolean; readonly error?: string}[];
      };
      expect(response.status).toBe(200);
      expect(body.results.map(item => item.ok)).toEqual([true, false]);
      expect(body.results[1]?.error).toContain('archive failed');
    } finally {
      await server.close();
    }
  });

  it('reads a memory URI through the generic read endpoint', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const response = await fetch(`${server.url}/api/read`, {
        body: JSON.stringify({uri: 'threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md'}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = (await response.json()) as {
        readonly content: string;
        readonly localMemory?: {readonly node: {readonly uri: string}};
      };

      expect(response.status).toBe(200);
      expect(body.content).toContain('Manager UI feature notes.');
      expect(body.localMemory?.node.uri).toBe(
        'threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md',
      );
    } finally {
      await server.close();
    }
  });

  it('runs recall through the scoped manager Effect runtime', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const response = await fetch(`${server.url}/api/recall`, {
        body: JSON.stringify({query: 'manager context'}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = (await response.json()) as {readonly output: string};

      expect(response.status).toBe(200);
      expect(body.output).toBe('recall result: manager context');
      expect(vi.mocked(memory.runRecall)).toHaveBeenCalledWith(config, {
        nodeLimit: undefined,
        project: undefined,
        query: 'manager context',
      });
    } finally {
      await server.close();
    }
  });

  it('adds scope diagnostics to compact output', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const response = await fetch(`${server.url}/api/compact`, {
        body: JSON.stringify({project: 'threadnote', topic: 'manager-ui'}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = (await response.json()) as {readonly output: string};

      expect(response.status).toBe(200);
      expect(body.output).toContain('Scope summary:');
      expect(body.output).toContain('- active records matching topic: 1');
      expect(body.output).toContain('Dry-run memory hygiene plan for project threadnote, topic manager-ui');
      expect(body.output).toContain('Records scanned: 1');
    } finally {
      await server.close();
    }
  });

  it('removes a personal project folder recursively', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const projectPath = join(
      config.agentContextHome,
      'data',
      config.account,
      'user',
      config.user,
      'memories',
      'durable',
      'projects',
      'threadnote',
    );
    const server = await startServer(config, 'secret');
    try {
      const response = await fetch(`${server.url}/api/folder/remove`, {
        body: JSON.stringify({
          confirm: true,
          uri: 'threadnote://user/denys/memories/durable/projects/threadnote',
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = (await response.json()) as {readonly output: string};

      expect(response.status).toBe(200);
      expect(body.output).toContain('Removed folder: threadnote://user/denys/memories/durable/projects/threadnote');
      expect(body.output).toContain('Forgot 2 files.');
      expect(
        vi
          .mocked(memory.runForget)
          .mock.calls.map(call => call[1])
          .sort(),
      ).toEqual([
        'threadnote://user/denys/memories/durable/projects/threadnote/.abstract.md',
        'threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md',
      ]);
      await expect(stat(projectPath)).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await server.close();
    }
  });

  it('requires confirmation for non-dry-run repair and returns repair output', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const rejected = await fetch(`${server.url}/api/doctor/repair`, {
        body: JSON.stringify({}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(rejected.status).toBe(500);
      expect(vi.mocked(lifecycle.runRepair)).not.toHaveBeenCalled();

      const accepted = await fetch(`${server.url}/api/doctor/repair`, {
        body: JSON.stringify({confirm: true}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = (await accepted.json()) as {readonly output: string};

      expect(accepted.status).toBe(200);
      expect(body.output).toBe('repair applied');
      expect(vi.mocked(lifecycle.runRepair)).toHaveBeenCalledWith(config, {dryRun: false});
    } finally {
      await server.close();
    }
  });

  it('keeps captured output isolated across concurrent requests', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    vi.mocked(lifecycle.runRepair).mockImplementation((_config, options) =>
      Effect.gen(function* () {
        const label = options.dryRun ? 'dry run' : 'applied';
        yield* Console.log(`${label} start`);
        yield* Effect.sleep('10 millis');
        yield* Console.log(`${label} end`);
      }),
    );
    const server = await startServer(config, 'secret');
    try {
      const request = (path: string, body: object) =>
        fetch(`${server.url}${path}`, {
          body: JSON.stringify(body),
          headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
          method: 'POST',
        }).then(response => response.json() as Promise<{readonly output: string}>);
      const [dryRun, applied] = await Promise.all([
        request('/api/doctor/repair-dry-run', {}),
        request('/api/doctor/repair', {confirm: true}),
      ]);

      expect(dryRun.output).toBe('dry run start\ndry run end');
      expect(applied.output).toBe('applied start\napplied end');
    } finally {
      await server.close();
    }
  });

  it('runs seed and seed-skills in write mode by default', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const seedResponse = await fetch(`${server.url}/api/seed`, {
        body: JSON.stringify({confirm: true}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const seedBody = (await seedResponse.json()) as {readonly output: string};
      expect(seedResponse.status).toBe(200);
      expect(seedBody.output).toBe('seed applied');
      expect(vi.mocked(seeding.runSeed)).toHaveBeenCalledWith(config, {dryRun: false});

      const skillsResponse = await fetch(`${server.url}/api/seed`, {
        body: JSON.stringify({confirm: true, skills: true}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const skillsBody = (await skillsResponse.json()) as {readonly output: string};
      expect(skillsResponse.status).toBe(200);
      expect(skillsBody.output).toBe('seed skills applied');
      expect(vi.mocked(seeding.runSeedSkills)).toHaveBeenCalledWith(config, {dryRun: false});
    } finally {
      await server.close();
    }
  });
});

describe('manager doctor output parsing', () => {
  it('parses plain and colored CLI doctor rows', () => {
    const checks = parseDoctorChecksFromOutput(
      [
        'OK  mode: read-only checks',
        '\u001b[33mWARN\u001b[0m threadnote shim: /tmp/threadnote points elsewhere',
        'FAIL manifest: missing manifest',
        '',
        'Summary: 1 failure(s), 1 warning(s)',
      ].join('\n'),
    );

    expect(checks).toEqual([
      {detail: 'read-only checks', name: 'mode', status: 'ok'},
      {detail: '/tmp/threadnote points elsewhere', name: 'threadnote shim', status: 'warn'},
      {detail: 'missing manifest', name: 'manifest', status: 'fail'},
    ]);
  });
});

describe('manager consolidation agents', () => {
  it('uses the current codex exec CLI flags', () => {
    const script = consolidationAgentScript('codex', '/Applications/Codex CLI/codex');

    expect(script).toBe('\'/Applications/Codex CLI/codex\' exec --sandbox read-only --skip-git-repo-check - < "$1"');
    expect(script).not.toContain('--ask-for-approval');
  });

  it('uses claude print mode for Claude consolidation', () => {
    expect(consolidationAgentScript('claude', '/usr/local/bin/claude')).toBe(
      '/usr/local/bin/claude --print --permission-mode default < "$1"',
    );
  });
});
