import {mkdir, mkdtemp, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

vi.mock('../../src/lifecycle.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/lifecycle.js')>();
  return {
    ...actual,
    runRepair: vi.fn(async (_config, options) => {
      console.log(options.dryRun ? 'repair dry run' : 'repair applied');
    }),
  };
});

vi.mock('../../src/memory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/memory.js')>();
  return {
    ...actual,
    runArchive: vi.fn(),
    runForget: vi.fn(),
  };
});

vi.mock('../../src/seeding.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/seeding.js')>();
  return {
    ...actual,
    runSeed: vi.fn(async (_config: RuntimeConfig, options: {readonly dryRun?: boolean}) => {
      console.log(options.dryRun ? 'seed dry run' : 'seed applied');
    }),
    runSeedSkills: vi.fn(async (_config: RuntimeConfig, options: {readonly dryRun?: boolean}) => {
      console.log(options.dryRun ? 'seed skills dry run' : 'seed skills applied');
    }),
  };
});

async function makeRuntime(): Promise<RuntimeConfig> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-manager-'));
  const root = join(home, 'data', 'viking', 'local', 'user', 'denys', 'memories');
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
    host: '127.0.0.1',
    manifestPath: join(home, 'manifest.yaml'),
    openVikingVersion: '0.0.0',
    port: 1933,
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
  const server = createManagerServer({config, jobs: new Map(), token});
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== 'object' || !address) {
    throw new Error('server did not bind');
  }
  return {
    close: () => new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
    url: `http://127.0.0.1:${address.port}`,
  };
}

describe('manager catalog', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
    vi.mocked(memory.runArchive).mockReset();
    vi.mocked(memory.runForget).mockReset();
  });

  it('maps local memory files into viking URIs with parsed metadata', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);

    const tree = await memoryTree(config);
    const project = tree.children?.find(child => child.name === 'durable')?.children?.[0]?.children?.[0];
    const leaf = project?.children?.find(child => child.name === 'manager-ui.md');

    expect(leaf?.uri).toBe('viking://user/denys/memories/durable/projects/threadnote/manager-ui.md');
    expect(leaf?.metadata?.project).toBe('threadnote');
    expect(leaf?.metadata?.topic).toBe('manager-ui');
  });

  it('maps seeded resources into a read-only resources tree', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const root = join(config.agentContextHome, 'data', 'viking', config.account, 'resources');
    await mkdir(join(root, 'agent-skills', 'codex-global'), {recursive: true});
    await writeFile(join(root, 'agent-skills', 'codex-global', 'threadnote-abc123.md'), 'Skill body');

    const tree = await resourcesTree(config);
    const skill = tree.children
      ?.find(child => child.name === 'agent-skills')
      ?.children?.find(child => child.name === 'codex-global')
      ?.children?.find(child => child.name === 'threadnote-abc123.md');

    expect(tree.name).toBe('resources');
    expect(tree.uri).toBe('viking://resources');
    expect(skill?.uri).toBe('viking://resources/agent-skills/codex-global/threadnote-abc123.md');
    expect(skill?.metadata).toBeUndefined();
  });

  it('reads a memory document and returns content plus metadata', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);

    const result = await readManagedMemory(
      config,
      'viking://user/denys/memories/durable/projects/threadnote/manager-ui.md',
    );

    expect(result.content).toContain('Manager UI feature notes.');
    expect(result.record?.metadata.kind).toBe('durable');
    expect(result.node.isSystem).toBe(false);
  });

  it('skips symlinked memory entries and rejects direct symlink reads', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const root = join(config.agentContextHome, 'data', 'viking', 'local', 'user', 'denys', 'memories');
    const secretPath = join(config.agentContextHome, 'local-secret.txt');
    const linkPath = join(root, 'durable', 'projects', 'threadnote', 'leak.md');
    await writeFile(secretPath, 'do not expose through manager\n', 'utf8');
    await symlink(secretPath, linkPath);

    const tree = await memoryTree(config);
    const project = tree.children?.find(child => child.name === 'durable')?.children?.[0]?.children?.[0];

    expect(project?.children?.map(child => child.name)).not.toContain('leak.md');
    await expect(
      readManagedMemory(config, 'viking://user/denys/memories/durable/projects/threadnote/leak.md'),
    ).rejects.toThrow(/regular memory files/);
  });
});

describe('manager UI selection helpers', () => {
  function selectionTree(): TreeNode {
    return {
      children: [
        fileNode('viking://user/denys/memories/durable/projects/threadnote/first.md', 'first.md'),
        fileNode('viking://user/denys/memories/durable/projects/threadnote/second.md', 'second.md'),
        fileNode('viking://user/denys/memories/durable/projects/threadnote/.abstract.md', '.abstract.md', true),
      ],
      isDir: true,
      isShared: false,
      isSystem: false,
      name: 'threadnote',
      relativePath: 'durable/projects/threadnote',
      uri: 'viking://user/denys/memories/durable/projects/threadnote',
    };
  }

  it('limits folder selection to visible filtered memory files', () => {
    const tree = selectionTree();

    expect(selectableMemoryUris(tree, {filter: 'first', showSystem: false})).toEqual([
      'viking://user/denys/memories/durable/projects/threadnote/first.md',
    ]);
    expect(selectableMemoryUris(tree, {filter: '', showSystem: false})).toEqual([
      'viking://user/denys/memories/durable/projects/threadnote/first.md',
      'viking://user/denys/memories/durable/projects/threadnote/second.md',
    ]);
  });

  it('prunes hidden selected memories before bulk actions', () => {
    const tree = selectionTree();
    const selected = new Set([
      'viking://user/denys/memories/durable/projects/threadnote/first.md',
      'viking://user/denys/memories/durable/projects/threadnote/second.md',
      'viking://user/denys/memories/durable/projects/threadnote/.abstract.md',
    ]);

    expect([...pruneSelectedMemoryUris(selected, tree, {filter: 'first', showSystem: false})]).toEqual([
      'viking://user/denys/memories/durable/projects/threadnote/first.md',
    ]);

    const visibleOnly = new Set(['viking://user/denys/memories/durable/projects/threadnote/first.md']);
    expect(pruneSelectedMemoryUris(visibleOnly, tree, {filter: 'first', showSystem: false})).toBe(visibleOnly);
  });
});

describe('manager http API', () => {
  const homes: string[] = [];

  beforeEach(() => {
    vi.mocked(lifecycle.runRepair).mockClear();
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
      expect(body.tree?.uri).toBe('viking://user/denys/memories');
      expect(body.resourcesTree?.uri).toBe('viking://resources');
    } finally {
      await server.close();
    }
  });

  it('returns per-item bulk results without hiding failures', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    vi.mocked(memory.runArchive).mockImplementation(async (_config, uri) => {
      if (uri.endsWith('bad.md')) {
        throw new Error('archive failed');
      }
    });
    const server = await startServer(config, 'secret');
    try {
      const response = await fetch(`${server.url}/api/bulk`, {
        body: JSON.stringify({
          action: 'archive',
          confirm: true,
          uris: [
            'viking://user/denys/memories/durable/projects/threadnote/good.md',
            'viking://user/denys/memories/durable/projects/threadnote/bad.md',
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
        body: JSON.stringify({uri: 'viking://user/denys/memories/durable/projects/threadnote/manager-ui.md'}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = (await response.json()) as {
        readonly content: string;
        readonly localMemory?: {readonly node: {readonly uri: string}};
      };

      expect(response.status).toBe(200);
      expect(body.content).toContain('Manager UI feature notes.');
      expect(body.localMemory?.node.uri).toBe('viking://user/denys/memories/durable/projects/threadnote/manager-ui.md');
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
      'viking',
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
          uri: 'viking://user/denys/memories/durable/projects/threadnote',
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = (await response.json()) as {readonly output: string};

      expect(response.status).toBe(200);
      expect(body.output).toContain('Removed folder: viking://user/denys/memories/durable/projects/threadnote');
      expect(body.output).toContain('Forgot 2 files.');
      expect(
        vi
          .mocked(memory.runForget)
          .mock.calls.map(call => call[1])
          .sort(),
      ).toEqual([
        'viking://user/denys/memories/durable/projects/threadnote/.abstract.md',
        'viking://user/denys/memories/durable/projects/threadnote/manager-ui.md',
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
