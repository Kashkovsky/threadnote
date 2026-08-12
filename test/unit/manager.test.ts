import {TestError} from '../helpers/test-error.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {startManagerTestServer as startServer} from '../helpers/manager-test-server.js';
import {execFileSync} from '../helpers/node-child-process.js';
import {existsSync} from '../helpers/node-fs.js';
import {mkdir, mkdtemp, rm, stat, symlink, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {it as effectIt} from '@effect/vitest';
import {Console, Deferred, Effect, Fiber, Path} from 'effect';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  consolidationAgentScript,
  memoryTree,
  parseDoctorChecksFromOutput,
  readManagedMemory,
  resourcesTree,
  runManage,
} from '../../src/manager.js';
import {
  managerProjectOptions,
  pruneSelectedMemoryUris,
  selectableMemoryUris,
  type TreeNode,
} from '../../src/manager_ui.js';
import type {RuntimeConfig} from '../../src/types.js';
import * as lifecycle from '../../src/lifecycle.js';
import * as memory from '../../src/memory.js';
import * as seeding from '../../src/seeding.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import * as automaticCompaction from '../../src/code_graph/automatic_compaction.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {makeCodeGraphBuildReporter} from '../../src/code_graph/build_status.js';
import {recordVerifiedCodeGraphLocalAssociation} from '../../src/code_graph/local_provenance.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {
  withCodeGraphMaintenanceIntent,
  withCodeGraphTargetWorktreeLock,
} from '../../src/code_graph/maintenance_gate.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import type {CodeGraphWorkspace} from '../../src/code_graph/languages/types.js';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  type CodeGraphEdge,
  type CodeGraphInventoryFile,
  type CodeGraphSnapshot,
  type CodeGraphSymbol,
  type RepositoryIdentity,
} from '../../src/code_graph/types.js';
import {runEffect} from '../helpers/effect-runtime.js';

const MANAGER_GRAPH_SNAPSHOT_ID = `cgsn_${'1'.repeat(40)}`;
const MANAGER_GRAPH_REPLACEMENT_SNAPSHOT_ID = `cgsn_${'2'.repeat(40)}`;

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

vi.mock('../../src/code_graph/automatic_compaction.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/code_graph/automatic_compaction.js')>();
  return {...actual, compactCodeGraphStorageIsolated: vi.fn(actual.compactCodeGraphStorageIsolated)};
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

async function seedManagerGraph(config: RuntimeConfig, snapshotId = MANAGER_GRAPH_SNAPSHOT_ID): Promise<string> {
  const checkoutId = 'a'.repeat(64);
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId,
    displayName: 'acme/platform',
    gitCommonDirectory: join(config.agentContextHome, 'repository', '.git'),
    headCommit: '1'.repeat(40),
    objectFormat: 'sha1',
    remoteIdentity: 'github.com/acme/platform',
    repoRoot: join(config.agentContextHome, 'repository'),
    repositoryId: 'b'.repeat(64),
    worktreeId: 'c'.repeat(64),
  };
  const generatedSymbols = Array.from({length: 520}, (_, index) => {
    const suffix = index.toString().padStart(4, '0');
    return graphSymbol(
      `generated-${suffix}`,
      `generatedFunction${suffix}`,
      `packages/app/src/generated/${suffix}.ts`,
      '@acme/app',
      'function',
      'cgp_app',
    );
  });
  const files: readonly CodeGraphInventoryFile[] = [
    graphFile('packages/app/src/index.ts', 'app-index'),
    graphFile('packages/app/src/view.ts', 'app-view'),
    graphFile('packages/core/src/api.ts', 'core-api'),
    ...generatedSymbols.map(symbol => graphFile(symbol.path, symbol.id)),
  ];
  const symbols: readonly CodeGraphSymbol[] = [
    graphSymbol('app', 'App', 'packages/app/src/index.ts', '@acme/app', 'class', 'cgp_app'),
    graphSymbol('view', 'renderView', 'packages/app/src/view.ts', '@acme/app', 'function', 'cgp_app'),
    graphSymbol('api', 'createApi', 'packages/core/src/api.ts', '@acme/core', 'function', 'cgp_core'),
    ...generatedSymbols,
  ];
  const workspace: CodeGraphWorkspace = {
    diagnostics: [],
    fingerprint: 'manager-workspace',
    projects: [
      {
        buildSystem: 'node',
        dependencies: ['cgp_core'],
        dependencyDetails: [{evidence: 'package.json', provenance: 'declared', targetId: 'cgp_core'}],
        diagnostics: [],
        id: 'cgp_app',
        kind: 'package',
        languages: ['typescript'],
        name: '@acme/app',
        provenance: 'declared',
        resolutionDomain: 'typescript',
        root: 'packages/app',
        sourceRoots: ['packages/app/src'],
        workspaceId: 'cgw_root',
        workspaceRoots: ['.'],
      },
      {
        buildSystem: 'node',
        dependencies: [],
        dependencyDetails: [],
        diagnostics: [],
        id: 'cgp_core',
        kind: 'package',
        languages: ['typescript'],
        name: '@acme/core',
        provenance: 'declared',
        resolutionDomain: 'typescript',
        root: 'packages/core',
        sourceRoots: ['packages/core/src'],
        workspaceId: 'cgw_root',
        workspaceRoots: ['.'],
      },
    ],
    workspaces: [
      {
        buildSystem: 'node',
        diagnostics: [],
        id: 'cgw_root',
        name: 'platform',
        provenance: 'declared',
        root: '.',
      },
    ],
  };
  const edges: readonly CodeGraphEdge[] = [
    graphEdge('app-view', 'app', 'App', 'view', 'renderView', 'calls'),
    graphEdge('app-api', 'app', 'App', 'api', 'createApi', 'imports'),
    ...Array.from({length: 1_600}, (_, index) => {
      const source = generatedSymbols[index % generatedSymbols.length]!;
      const target = generatedSymbols[(index * 17 + 1) % generatedSymbols.length]!;
      return graphEdge(`generated-edge-${index}`, source.id, source.name, target.id, target.name, 'calls');
    }),
  ];
  const snapshot: CodeGraphSnapshot = {
    commit: identity.headCommit,
    completedAt: new Date().toISOString(),
    dirty: false,
    edgeCount: edges.length,
    extractorSet: CODE_GRAPH_EXTRACTOR_SET_VERSION,
    fileCount: files.length,
    id: snapshotId,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: symbols.length,
    worktreeId: identity.worktreeId,
  };
  await runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
      yield* store.initialize(layout.databasePath);
      yield* store.withSession(
        layout.databasePath,
        Effect.gen(function* () {
          yield* store.prepareActivation(layout.databasePath, files);
          yield* store.stageWorkspaceCatalog(layout.databasePath, workspace);
          yield* store.stageActivationFacts(layout.databasePath, symbols, edges);
          yield* store.activateStaged(layout.databasePath, identity, snapshot);
        }),
      );
      yield* store.promote(layout.databasePath, identity, snapshot.id);
    }),
  );
  return checkoutId;
}

async function promoteManagerGraphReplacement(config: RuntimeConfig): Promise<string> {
  const checkoutId = 'a'.repeat(64);
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId,
    displayName: 'acme/platform',
    gitCommonDirectory: join(config.agentContextHome, 'repository', '.git'),
    headCommit: '2'.repeat(40),
    objectFormat: 'sha1',
    remoteIdentity: 'github.com/acme/platform',
    repoRoot: join(config.agentContextHome, 'repository'),
    repositoryId: 'b'.repeat(64),
    worktreeId: 'c'.repeat(64),
  };
  const symbol = graphSymbol('replacement', 'Replacement', 'src/replacement.ts', '@acme/new', 'class', 'cgp_new');
  const file = graphFile(symbol.path, symbol.id);
  const snapshot: CodeGraphSnapshot = {
    commit: identity.headCommit,
    completedAt: new Date().toISOString(),
    dirty: false,
    edgeCount: 0,
    extractorSet: CODE_GRAPH_EXTRACTOR_SET_VERSION,
    fileCount: 1,
    id: MANAGER_GRAPH_REPLACEMENT_SNAPSHOT_ID,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 1,
    worktreeId: identity.worktreeId,
  };
  await runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
      yield* store.activate(layout.databasePath, identity, snapshot, [file], [symbol], []);
      yield* store.promote(layout.databasePath, identity, snapshot.id);
    }),
  );
  return snapshot.id;
}

function graphFile(path: string, hash: string): CodeGraphInventoryFile {
  return {
    blobId: hash,
    contentHash: hash.padEnd(64, '0'),
    language: 'typescript',
    mode: '100644',
    path,
    size: 100,
    source: 'commit',
  };
}

function graphSymbol(
  id: string,
  name: string,
  path: string,
  packageName: string,
  kind: string,
  resolutionScopeId: string,
): CodeGraphSymbol {
  return {
    contentHash: id.padEnd(64, '0'),
    documentation: `Documentation for ${name}.`,
    exported: true,
    id,
    kind,
    language: 'typescript',
    name,
    packageName,
    path,
    qualifiedName: name,
    resolutionDomain: 'typescript',
    resolutionScopeId,
    signature: `export ${kind} ${name}`,
    span: {column: 3, endColumn: 12, endLine: 9, line: 7},
  };
}

function graphEdge(
  id: string,
  sourceId: string,
  sourceName: string,
  targetId: string,
  targetName: string,
  relation: CodeGraphEdge['relation'],
): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: 'packages/app/src/index.ts',
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id,
    provenance: 'resolved',
    relation,
    sourceId,
    sourceName,
    targetId,
    targetName,
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

async function fetchManagerGraphActionWhenAvailable(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, init);
    if (response.status !== 409) return response;
    const body = (await response.clone().json()) as {readonly code?: string; readonly retryAfterMilliseconds?: number};
    if (body.code !== 'graph-view-busy' || attempt === 2) return response;
    await new Promise(resolve => setTimeout(resolve, body.retryAfterMilliseconds ?? 1_000));
  }
  throw new TestError('Manager graph action retry budget was exhausted.');
}

function initializeGitRepository(root: string): void {
  execFileSync('git', ['init', '-q', root], {stdio: 'pipe'});
  execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ],
    {stdio: 'pipe'},
  );
}

function differentGraphIdentity(value: string): string {
  return `${value.startsWith('f') ? 'e' : 'f'}${value.slice(1)}`;
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

  it('refuses to start while native graph repair or maintenance is active', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    await expect(
      runEffect(withCodeGraphMaintenanceIntent(config.agentContextHome, runManage(config, {open: false, uiPort: 0}))),
    ).rejects.toThrow('Native code graph repair or maintenance is in progress');
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

  it('collects distinct project selector options from nested memory metadata', () => {
    const first = fileNode('threadnote://user/denys/memories/durable/projects/threadnote/first.md', 'first.md');
    const second = fileNode('threadnote://user/denys/memories/handoffs/other/second.md', 'second.md');
    const tree: TreeNode = {
      ...selectionTree(),
      children: [
        {
          ...first,
          metadata: {
            kind: 'durable',
            project: 'Threadnote',
            sourceAgentClient: 'codex',
            status: 'active',
            timestamp: '2026-08-05T00:00:00.000Z',
          },
        },
        {
          ...second,
          metadata: {
            kind: 'handoff',
            project: 'threadnote',
            sourceAgentClient: 'codex',
            status: 'active',
            timestamp: '2026-08-05T00:00:00.000Z',
          },
        },
      ],
    };

    expect(managerProjectOptions(tree)).toEqual(['Threadnote']);
  });
});

describe('manager http API', () => {
  const homes: string[] = [];

  beforeEach(() => {
    vi.mocked(automaticCompaction.compactCodeGraphStorageIsolated).mockClear();
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

  it('requires the session token for process inventory and termination without signaling', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    const kill = vi.spyOn(process, 'kill');
    try {
      const inventory = await fetch(`${server.url}/api/processes`);
      const termination = await fetch(`${server.url}/api/processes/terminate`, {
        body: JSON.stringify({
          confirm: true,
          processId: 123_456,
          processRef: `tnp_${'a'.repeat(64)}`,
        }),
        headers: {'content-type': 'application/json'},
        method: 'POST',
      });
      expect(inventory.status).toBe(401);
      expect(termination.status).toBe(401);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
      await server.close();
    }
  });

  it('keeps authenticated process inventory available during graph maintenance', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const response = await runEffect(
        withCodeGraphMaintenanceIntent(
          config.agentContextHome,
          Effect.promise(() => fetch(`${server.url}/api/processes`, {headers: {authorization: 'Bearer secret'}})),
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({processes: expect.any(Array), schemaVersion: 1});
    } finally {
      await server.close();
    }
  });

  it('serves active graph jobs without requiring a graph database read', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const seeded = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity: RepositoryIdentity = {
          caseMode: 'sensitive',
          checkoutId: 'f'.repeat(64),
          displayName: 'acme/large-monorepo',
          gitCommonDirectory: join(config.agentContextHome, 'large-repository', '.git'),
          headCommit: '1'.repeat(40),
          objectFormat: 'sha1',
          remoteIdentity: 'github.com/acme/large-monorepo',
          repoRoot: join(config.agentContextHome, 'large-repository'),
          repositoryId: 'd'.repeat(64),
          worktreeId: 'e'.repeat(64),
        };
        const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({phase: 'waiting'});
        return {databasePath: layout.databasePath, worktreeId: identity.worktreeId};
      }),
    );
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret'};
      const statusResponse = await fetch(`${server.url}/api/graphs/status`, {headers});
      const status = (await statusResponse.json()) as {
        readonly builds: readonly {readonly state: string}[];
        readonly catalogRevision?: string;
        readonly queuedWorktreeIds: readonly string[];
      };
      expect(statusResponse.status).toBe(200);
      expect(status.builds).toEqual([expect.objectContaining({state: 'queued'})]);
      expect(status.queuedWorktreeIds).toEqual([seeded.worktreeId]);
      expect(status.catalogRevision).toBeUndefined();
      expect(existsSync(seeded.databasePath)).toBe(false);

      const catalogResponse = await fetch(`${server.url}/api/graphs`, {headers});
      const catalog = (await catalogResponse.json()) as {
        readonly builds: readonly {readonly state: string}[];
        readonly catalogRevision: string;
        readonly repositories: readonly unknown[];
      };
      expect(catalog).toMatchObject({builds: [expect.objectContaining({state: 'queued'})], repositories: []});
      expect(catalog.catalogRevision).toMatch(/^[0-9a-f]{64}$/u);
      expect(existsSync(seeded.databasePath)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('invalidates an open Manager catalog when another process removes a view', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const checkoutId = await seedManagerGraph(config);
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret'};
      const initialResponse = await fetch(`${server.url}/api/graphs`, {headers});
      const initial = (await initialResponse.json()) as {
        readonly catalogRevision: string;
        readonly repositories: readonly {readonly views: readonly unknown[]}[];
      };
      expect(initialResponse.status).toBe(200);
      expect(initial.repositories[0]?.views).toHaveLength(1);

      const removal = await runEffect(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const layout = codeGraphLayout(path, config.agentContextHome, checkoutId, 'c'.repeat(64));
          return yield* store.removeView(layout.databasePath, 'c'.repeat(64), MANAGER_GRAPH_SNAPSHOT_ID);
        }),
      );
      expect(removal.state).toBe('removed');

      const statusResponse = await fetch(`${server.url}/api/graphs/status`, {headers});
      const status = (await statusResponse.json()) as {readonly catalogRevision?: string};
      expect(statusResponse.status).toBe(200);
      expect(status.catalogRevision).toMatch(/^[0-9a-f]{64}$/u);
      expect(status.catalogRevision).not.toBe(initial.catalogRevision);

      const refreshedResponse = await fetch(`${server.url}/api/graphs`, {headers});
      const refreshed = (await refreshedResponse.json()) as {
        readonly catalogRevision: string;
        readonly repositories: readonly unknown[];
      };
      expect(refreshedResponse.status).toBe(200);
      expect(refreshed.catalogRevision).toBe(status.catalogRevision);
      expect(refreshed.repositories).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('serves bounded repository and project graph visualizations', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repositoryId = await seedManagerGraph(config);
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret'};
      const catalogResponse = await fetch(`${server.url}/api/graphs`, {headers});
      const catalog = (await catalogResponse.json()) as {
        readonly repositories: readonly {
          readonly defaultViewId: string;
          readonly displayName: string;
          readonly id: string;
          readonly views: readonly {
            readonly id: string;
            readonly localAssociation: {readonly available: boolean; readonly state: string};
            readonly projects: readonly {readonly id: string; readonly symbolCount: number}[];
          }[];
        }[];
      };
      expect(catalogResponse.status).toBe(200);
      expect(catalog.repositories).toHaveLength(1);
      expect(catalog.repositories[0]).toMatchObject({
        defaultViewId: `${repositoryId}.${'c'.repeat(64)}`,
        displayName: 'acme/platform',
        id: 'b'.repeat(64),
      });
      expect(catalog.repositories[0]?.views[0]).toMatchObject({
        checkoutId: repositoryId,
        localAssociation: {available: false, state: 'legacy-unknown'},
        worktreeId: 'c'.repeat(64),
      });
      expect(catalog.repositories[0]?.views[0]?.projects).toEqual(
        expect.arrayContaining([expect.objectContaining({id: 'cgp_app'}), expect.objectContaining({id: 'cgp_core'})]),
      );

      const catalogPageResponse = await fetch(
        `${server.url}/api/graphs/page?repository=${repositoryId}&snapshot=${MANAGER_GRAPH_SNAPSHOT_ID}&offset=0&workspaceOffset=0&query=core`,
        {headers},
      );
      const catalogPage = (await catalogPageResponse.json()) as {
        readonly query: string;
        readonly repository: {
          readonly localAssociation: {readonly available: boolean; readonly state: string};
          readonly projects: readonly {readonly id: string}[];
          readonly snapshot: {readonly id: string};
        };
      };
      expect(catalogPageResponse.status).toBe(200);
      expect(catalogPage.query).toBe('core');
      expect(catalogPage.repository.localAssociation).toEqual({available: false, state: 'legacy-unknown'});
      expect(catalogPage.repository.snapshot.id).toBe(MANAGER_GRAPH_SNAPSHOT_ID);
      expect(catalogPage.repository.projects.map(project => project.id)).toEqual(['cgp_core']);

      const viewsPageResponse = await fetch(`${server.url}/api/graphs/views?repository=${repositoryId}&offset=0`, {
        headers,
      });
      const viewsPage = (await viewsPageResponse.json()) as {
        readonly hasMore: boolean;
        readonly repositories: readonly {
          readonly views: readonly {
            readonly id: string;
            readonly localAssociation: {readonly available: boolean; readonly state: string};
          }[];
        }[];
      };
      expect(viewsPageResponse.status).toBe(200);
      expect(viewsPage.hasMore).toBe(false);
      expect(viewsPage.repositories[0]?.views[0]?.id).toBe(`${repositoryId}.${'c'.repeat(64)}`);
      expect(viewsPage.repositories[0]?.views[0]?.localAssociation).toEqual({
        available: false,
        state: 'legacy-unknown',
      });

      const unpinnedCatalogPage = await fetch(`${server.url}/api/graphs/page?repository=${repositoryId}`, {headers});
      expect(unpinnedCatalogPage.status).toBe(500);

      const overviewResponse = await fetch(`${server.url}/api/graph?repository=${repositoryId}&project=all`, {headers});
      const overview = (await overviewResponse.json()) as {
        readonly edges: readonly {readonly count: number; readonly relation: string}[];
        readonly mode: string;
        readonly nodes: readonly {readonly id: string; readonly type: string}[];
      };
      expect(overviewResponse.status).toBe(200);
      expect(overview.mode).toBe('overview');
      expect(overview.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({id: 'cgp_app', type: 'project'}),
          expect.objectContaining({id: 'cgp_core', type: 'project'}),
        ]),
      );
      expect(overview.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({count: 1, relation: 'depends_on'}),
          expect.objectContaining({count: 1, relation: 'imports'}),
        ]),
      );

      const detailStartedAt = performance.now();
      const detailResponse = await fetch(
        `${server.url}/api/graph?repository=${repositoryId}&project=${encodeURIComponent('cgp_app')}`,
        {headers},
      );
      const detailElapsedMilliseconds = performance.now() - detailStartedAt;
      const detailText = await detailResponse.text();
      const detail = JSON.parse(detailText) as {
        readonly edges: readonly {readonly relation: string; readonly sourceId: string; readonly targetId: string}[];
        readonly mode: string;
        readonly nodes: readonly {readonly degree: number; readonly id: string; readonly type: string}[];
        readonly paging: {readonly edgeLimit: number; readonly hasMore: boolean; readonly nodeLimit: number};
      };
      expect(detailResponse.status).toBe(200);
      expect(detail.mode).toBe('detail');
      expect(detail.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({degree: 2, id: 'app', type: 'symbol'}),
          expect.objectContaining({degree: 1, id: 'view', type: 'symbol'}),
          expect.objectContaining({degree: 1, id: 'api', type: 'symbol'}),
        ]),
      );
      expect(detail.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({relation: 'calls'}),
          expect.objectContaining({relation: 'imports'}),
        ]),
      );
      expect(detail.nodes.length).toBeLessThanOrEqual(240);
      expect(detail.edges.length).toBeLessThanOrEqual(640);
      const detailNodeIds = new Set(detail.nodes.map(node => node.id));
      expect(detail.edges.every(edge => detailNodeIds.has(edge.sourceId) && detailNodeIds.has(edge.targetId))).toBe(
        true,
      );
      expect(detail.paging).toEqual({edgeLimit: 640, hasMore: true, nodeLimit: 240});
      expect(new TextEncoder().encode(detailText).byteLength).toBeLessThan(500_000);
      expect(detailElapsedMilliseconds).toBeLessThan(1_500);

      const expandedStartedAt = performance.now();
      const expandedResponse = await fetch(
        `${server.url}/api/graph?repository=${repositoryId}&project=${encodeURIComponent('cgp_app')}&nodeLimit=999999&edgeLimit=999999`,
        {headers},
      );
      const expandedElapsedMilliseconds = performance.now() - expandedStartedAt;
      const expandedText = await expandedResponse.text();
      const expanded = JSON.parse(expandedText) as {
        readonly edges: readonly unknown[];
        readonly nodes: readonly unknown[];
        readonly paging: {readonly edgeLimit: number; readonly nodeLimit: number};
      };
      expect(expandedResponse.status).toBe(200);
      expect(expanded.paging).toMatchObject({edgeLimit: 1_500, nodeLimit: 500});
      expect(expanded.nodes.length).toBeLessThanOrEqual(500);
      expect(expanded.edges.length).toBeLessThanOrEqual(1_500);
      expect(new TextEncoder().encode(expandedText).byteLength).toBeLessThan(1_250_000);
      expect(expandedElapsedMilliseconds).toBeLessThan(2_000);

      const queryStartedAt = performance.now();
      const queryResponse = await fetch(
        `${server.url}/api/graph/query?repository=${repositoryId}&snapshot=${MANAGER_GRAPH_SNAPSHOT_ID}&query=${encodeURIComponent('App')}&nodeLimit=999999&edgeLimit=999999`,
        {headers},
      );
      const queryElapsedMilliseconds = performance.now() - queryStartedAt;
      const queryText = await queryResponse.text();
      const query = JSON.parse(queryText) as {
        readonly edges: readonly {readonly sourceId: string; readonly targetId: string}[];
        readonly nodes: readonly {readonly id: string; readonly score?: number}[];
        readonly paging: {readonly edgeLimit: number; readonly nodeLimit: number};
        readonly query: {readonly matchedNodes: number; readonly state: string; readonly text: string};
        readonly repository: {readonly snapshot: {readonly id: string}};
      };
      expect(queryResponse.status).toBe(200);
      expect(query.query).toMatchObject({matchedNodes: query.nodes.length, state: 'ready', text: 'App'});
      expect(query.repository.snapshot.id).toBe(MANAGER_GRAPH_SNAPSHOT_ID);
      expect(query.nodes).toEqual(expect.arrayContaining([expect.objectContaining({id: 'app'})]));
      expect(query.nodes.some(node => typeof node.score === 'number')).toBe(true);
      const queryNodeIds = new Set(query.nodes.map(node => node.id));
      expect(query.edges.every(edge => queryNodeIds.has(edge.sourceId) && queryNodeIds.has(edge.targetId))).toBe(true);
      expect(query.paging).toMatchObject({edgeLimit: 500, nodeLimit: 200});
      expect(new TextEncoder().encode(queryText).byteLength).toBeLessThan(500_000);
      expect(queryElapsedMilliseconds).toBeLessThan(2_500);

      const unpinnedQueryResponse = await fetch(
        `${server.url}/api/graph/query?repository=${repositoryId}&query=${encodeURIComponent('App')}`,
        {headers},
      );
      expect(unpinnedQueryResponse.status).toBe(500);

      const nodeResponse = await fetch(
        `${server.url}/api/graph/node?repository=${repositoryId}&node=${encodeURIComponent('app')}`,
        {headers},
      );
      const node = (await nodeResponse.json()) as {
        readonly node: {
          readonly documentation?: string;
          readonly path: string;
          readonly span: {readonly column: number; readonly line: number};
        };
        readonly relationships: readonly {
          readonly direction: string;
          readonly evidencePath: string;
          readonly provenance: string;
          readonly related: {readonly id?: string; readonly label: string};
          readonly relation: string;
        }[];
        readonly stats: {
          readonly incoming: number;
          readonly outgoing: number;
          readonly relations: readonly {readonly count: number; readonly relation: string}[];
          readonly sampledEdges: number;
          readonly summaryTruncated: boolean;
          readonly truncated: boolean;
        };
      };
      expect(nodeResponse.status).toBe(200);
      expect(node.node).toMatchObject({
        documentation: 'Documentation for App.',
        path: 'packages/app/src/index.ts',
        span: {column: 3, line: 7},
      });
      expect(node.stats).toMatchObject({
        incoming: 0,
        outgoing: 2,
        sampledEdges: 2,
        summaryTruncated: false,
        truncated: false,
      });
      expect(node.stats.relations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({count: 1, relation: 'calls'}),
          expect.objectContaining({count: 1, relation: 'imports'}),
        ]),
      );
      expect(node.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'outgoing',
            evidencePath: 'packages/app/src/index.ts',
            provenance: 'resolved',
            related: expect.objectContaining({id: 'view', label: 'renderView'}),
            relation: 'calls',
          }),
        ]),
      );

      const analysisResponse = await fetch(`${server.url}/api/graph/analysis?repository=${repositoryId}`, {headers});
      const analysis = (await analysisResponse.json()) as {
        readonly statistics: {
          readonly analyzedEdgeCount: number;
          readonly analyzedNodeCount: number;
        };
        readonly trust: {readonly classification: string};
      };
      expect(analysisResponse.status).toBe(200);
      expect(analysis.statistics).toMatchObject({analyzedEdgeCount: 1_602, analyzedNodeCount: 523});
      expect(analysis.trust.classification).toBe('untrusted-repository-data');
    } finally {
      await server.close();
    }
  });

  it('serves home-wide graph diagnostics and safety-gated lifecycle actions', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    await seedManagerGraph(config);
    const orphanedCheckoutId = 'd'.repeat(64);
    const orphanedRoot = join(config.agentContextHome, 'indexes', 'code-graph', 'repositories', orphanedCheckoutId);
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret', 'content-type': 'application/json'};
      const diagnosticsResponse = await fetch(`${server.url}/api/graphs/diagnostics?analyze=true`, {headers});
      const diagnostics = (await diagnosticsResponse.json()) as {
        readonly databases: readonly {
          readonly health: {readonly integrity: string};
          readonly views: readonly {readonly localAssociation: {readonly available: boolean; readonly state: string}}[];
        }[];
        readonly mode: {readonly analyze: boolean; readonly deep: boolean};
        readonly summary: {readonly databaseCount: number; readonly readySnapshotCount: number};
        readonly type: string;
        readonly version: number;
      };
      expect(diagnosticsResponse.status).toBe(200);
      expect(diagnostics).toMatchObject({
        mode: {analyze: true, deep: false},
        summary: {databaseCount: 1, readySnapshotCount: 1},
        type: 'code-graph-diagnostics',
        version: 2,
      });
      expect(diagnostics.databases[0]).toMatchObject({health: {integrity: 'ok'}});
      expect(diagnostics.databases[0]?.views[0]?.localAssociation).toEqual({
        available: false,
        state: 'legacy-unknown',
      });

      const repairPreview = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'repair', dryRun: true}),
        headers,
        method: 'POST',
      });
      const repairOutput = (await repairPreview.json()) as {readonly output: string};
      expect(repairPreview.status).toBe(200);
      expect(repairOutput.output).toContain('Would repair 1 native code graph database(s)');

      const purgePreview = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'purge-all', dryRun: true}),
        headers,
        method: 'POST',
      });
      expect(purgePreview.status).toBe(200);
      expect(await purgePreview.json()).toMatchObject({output: expect.stringContaining('Would remove derived')});

      const refusedPurge = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'purge-all'}),
        headers,
        method: 'POST',
      });
      expect(refusedPurge.status).toBe(500);
      expect(await refusedPurge.json()).toMatchObject({error: 'Set confirm=true for this action.'});

      const relativeTarget = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'index',
          checkoutId: 'a'.repeat(64),
          cwd: '.',
          repositoryId: 'b'.repeat(64),
          worktreeId: 'c'.repeat(64),
        }),
        headers,
        method: 'POST',
      });
      expect(relativeTarget.status).toBe(500);
      expect(await relativeTarget.json()).toMatchObject({error: 'Supply cwd as an absolute local worktree path.'});

      const missingRepositoryIdentity = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'index',
          checkoutId: 'a'.repeat(64),
          cwd: config.agentContextHome,
          worktreeId: 'c'.repeat(64),
        }),
        headers,
        method: 'POST',
      });
      expect(missingRepositoryIdentity.status).toBe(500);
      expect(await missingRepositoryIdentity.json()).toMatchObject({error: 'Provide repositoryId.'});

      await mkdir(orphanedRoot, {recursive: true});
      await writeFile(join(orphanedRoot, 'graph-v3.sqlite'), 'incompatible disposable graph\n');
      const targetedPreview = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'purge', checkoutId: orphanedCheckoutId, dryRun: true}),
        headers,
        method: 'POST',
      });
      expect(targetedPreview.status).toBe(200);
      expect(await targetedPreview.json()).toMatchObject({
        output: `Would remove derived code graph index for checkout ${orphanedCheckoutId.slice(0, 12)}.`,
      });
      expect(existsSync(orphanedRoot)).toBe(true);

      const refusedTargetedPurge = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'purge', checkoutId: orphanedCheckoutId}),
        headers,
        method: 'POST',
      });
      expect(refusedTargetedPurge.status).toBe(500);
      expect(await refusedTargetedPurge.json()).toMatchObject({error: 'Set confirm=true for this action.'});

      const targetedPurge = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'purge', checkoutId: orphanedCheckoutId, confirm: true}),
        headers,
        method: 'POST',
      });
      expect(targetedPurge.status).toBe(200);
      expect(await targetedPurge.json()).toMatchObject({
        output: `Removed derived code graph index for checkout ${orphanedCheckoutId.slice(0, 12)}.`,
      });
      expect(existsSync(orphanedRoot)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('applies a verified isolated graph compaction through the authenticated Manager route', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const root = join(config.agentContextHome, 'manager-compaction-worktree');
    initializeGitRepository(root);
    const identity = await runEffect(resolveRepositoryIdentity(root));
    vi.mocked(automaticCompaction.compactCodeGraphStorageIsolated).mockReturnValueOnce(
      Effect.succeed({action: 'compacted', checkoutId: identity.checkoutId, reclaimedBytes: 1_048_576}),
    );
    const server = await startServer(config, 'secret');
    try {
      const response = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'compact',
          checkoutId: identity.checkoutId,
          confirm: true,
          cwd: root,
          force: true,
          repositoryId: identity.repositoryId,
          worktreeId: identity.worktreeId,
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        output: 'Compacted the selected graph in an isolated process and reclaimed 1,048,576 bytes.',
      });
      expect(automaticCompaction.compactCodeGraphStorageIsolated).toHaveBeenCalledWith(
        config.agentContextHome,
        identity.checkoutId,
        {force: true, operation: 'compact'},
      );
    } finally {
      await server.close();
    }
  });

  it('previews and applies an exact authenticated graph view removal with an approval digest', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const snapshotId = `cgsn_${'d'.repeat(40)}-direct`;
    const checkoutId = await seedManagerGraph(config, snapshotId);
    const worktreeId = 'c'.repeat(64);
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret', 'content-type': 'application/json'};
      const target = {action: 'remove-view', checkoutId, expectedSnapshotId: snapshotId, worktreeId};
      const unauthorized = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({...target, dryRun: true}),
        headers: {'content-type': 'application/json'},
        method: 'POST',
      });
      expect(unauthorized.status).toBe(401);

      const catalog = await fetch(`${server.url}/api/graphs`, {headers});
      expect(catalog.status).toBe(200);
      const preview = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({...target, dryRun: true}),
        headers,
        method: 'POST',
      });
      const prepared = (await preview.json()) as {
        readonly approvalDigest: string;
        readonly output: string;
        readonly result: {
          readonly applied: boolean;
          readonly state: string;
          readonly type: string;
          readonly version: number;
        };
      };
      expect(preview.status).toBe(200);
      expect(prepared).toMatchObject({
        approvalDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        output: expect.stringContaining('Would remove native code graph view'),
        result: {applied: false, state: 'ready', type: 'code-graph-view-removal', version: 1},
      });
      expect(JSON.stringify(prepared)).not.toContain(config.agentContextHome);

      const refused = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({...target, confirm: true}),
        headers,
        method: 'POST',
      });
      expect(refused.status).toBe(500);
      expect(await refused.json()).toEqual({
        error: 'Preview this exact graph view removal and provide its approval digest before applying.',
      });

      const applied = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({...target, approvalDigest: prepared.approvalDigest, confirm: true}),
        headers,
        method: 'POST',
      });
      const result = (await applied.json()) as {
        readonly approvalDigest: string;
        readonly output: string;
        readonly result: {readonly applied: boolean; readonly state: string};
      };
      expect(applied.status).toBe(200);
      expect(result).toMatchObject({
        approvalDigest: prepared.approvalDigest,
        output: expect.stringContaining('Removed native code graph view'),
        result: {applied: true, state: 'removed'},
      });
      expect(JSON.stringify(result)).not.toContain(config.agentContextHome);
      const databasePath = join(
        config.agentContextHome,
        'indexes',
        'code-graph',
        'repositories',
        checkoutId,
        'graph-v3.sqlite',
      );
      const database = new (await import('bun:sqlite')).Database(databasePath, {readonly: true});
      expect(database.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
      database.close();

      const retried = await fetchManagerGraphActionWhenAvailable(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({...target, approvalDigest: prepared.approvalDigest, confirm: true}),
        headers,
        method: 'POST',
      });
      expect(retried.status).toBe(200);
      expect(await retried.json()).toMatchObject({result: {applied: true, state: 'already-removed'}});

      const stalePreview = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({...target, dryRun: true, expectedSnapshotId: `cgsn_${'e'.repeat(40)}-direct`}),
        headers,
        method: 'POST',
      });
      expect(stalePreview.status).toBe(200);
      const stale = await stalePreview.json();
      expect(stale).toMatchObject({result: {observedState: 'removed', state: 'stale-target'}});
      expect(JSON.stringify(stale)).not.toContain(config.agentContextHome);
    } finally {
      await server.close();
    }
  });

  effectIt.effect('maps a busy graph view target to a fixed path-free retry response', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* Effect.promise(makeRuntime);
        homes.push(config.agentContextHome);
        const snapshotId = `cgsn_${'f'.repeat(40)}-direct`;
        const checkoutId = yield* Effect.promise(() => seedManagerGraph(config, snapshotId));
        const worktreeId = 'c'.repeat(64);
        const server = yield* Effect.promise(() => startServer(config, 'secret'));
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* withCodeGraphTargetWorktreeLock(
          config.agentContextHome,
          checkoutId,
          worktreeId,
          Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(provideTestLayer(ApplicationLayer), Effect.forkScoped);
        yield* Effect.gen(function* () {
          const headers = {authorization: 'Bearer secret', 'content-type': 'application/json'};
          const target = {action: 'remove-view', checkoutId, expectedSnapshotId: snapshotId, worktreeId};
          const preview = yield* Effect.promise(() =>
            fetch(`${server.url}/api/graphs/action`, {
              body: JSON.stringify({...target, dryRun: true}),
              headers,
              method: 'POST',
            }),
          );
          const prepared = (yield* Effect.promise(() => preview.json())) as {readonly approvalDigest: string};
          yield* Deferred.await(acquired);
          const response = yield* Effect.promise(() =>
            fetch(`${server.url}/api/graphs/action`, {
              body: JSON.stringify({...target, approvalDigest: prepared.approvalDigest, confirm: true}),
              headers,
              method: 'POST',
            }),
          );
          expect(response.status).toBe(409);
          const busy = yield* Effect.promise(() => response.json());
          expect(busy).toEqual({
            code: 'graph-view-busy',
            error: 'The selected graph view is busy. Retry after the active graph operation completes.',
            retryAfterMilliseconds: 1_000,
          });
          expect(JSON.stringify(busy)).not.toContain(config.agentContextHome);
        }).pipe(
          Effect.ensuring(
            Deferred.succeed(release, undefined).pipe(
              Effect.andThen(Fiber.await(owner)),
              Effect.andThen(Effect.promise(() => server.close())),
            ),
          ),
        );
      }),
    ),
  );

  it('rejects mismatched Manager graph identities before a targeted action starts', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const root = join(config.agentContextHome, 'manager-action-worktree');
    initializeGitRepository(root);
    const identity = await runEffect(resolveRepositoryIdentity(root));
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret', 'content-type': 'application/json'};
      const expected = {
        checkoutId: identity.checkoutId,
        repositoryId: identity.repositoryId,
        worktreeId: identity.worktreeId,
      };
      for (const component of ['checkoutId', 'repositoryId', 'worktreeId'] as const) {
        const response = await fetch(`${server.url}/api/graphs/action`, {
          body: JSON.stringify({
            ...expected,
            [component]: differentGraphIdentity(expected[component]),
            action: 'index',
            cwd: root,
          }),
          headers,
          method: 'POST',
        });
        expect(response.status, component).toBe(500);
        expect(await response.json(), component).toEqual({
          error: 'The supplied worktree path does not match the selected graph identity.',
        });
      }

      execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://example.com/changed.git'], {
        stdio: 'pipe',
      });
      const changedOrigin = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({...expected, action: 'compact', cwd: root, dryRun: true}),
        headers,
        method: 'POST',
      });
      expect(changedOrigin.status).toBe(500);
      expect(await changedOrigin.json()).toEqual({
        error: 'The supplied worktree path does not match the selected graph identity.',
      });
    } finally {
      await server.close();
    }
  });

  it('live-revalidates fresh persisted and Manager graph target fallbacks after origin drift', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const root = join(config.agentContextHome, 'manager-fallback-worktree');
    initializeGitRepository(root);
    const identity = await runEffect(resolveRepositoryIdentity(root));
    await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
        yield* recordVerifiedCodeGraphLocalAssociation(config.agentContextHome, identity);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({phase: 'waiting'});
      }),
    );
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://example.com/changed.git'], {
      stdio: 'pipe',
    });

    const server = await startServer(config, 'secret');
    try {
      const response = await fetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'compact',
          checkoutId: identity.checkoutId,
          dryRun: true,
          repositoryId: identity.repositoryId,
          worktreeId: identity.worktreeId,
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'The selected graph has no current local worktree target. Supply cwd and refresh graph diagnostics.',
      });
    } finally {
      await server.close();
    }
  });

  it('returns a busy response for graph APIs when maintenance starts after Manager', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const [response, statusResponse] = await runEffect(
        withCodeGraphMaintenanceIntent(
          config.agentContextHome,
          Effect.all(
            [
              Effect.promise(() =>
                fetch(`${server.url}/api/graphs/diagnostics`, {headers: {authorization: 'Bearer secret'}}),
              ),
              Effect.promise(() =>
                fetch(`${server.url}/api/graphs/status`, {headers: {authorization: 'Bearer secret'}}),
              ),
            ] as const,
            {concurrency: 'unbounded'},
          ),
        ),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('Native code graph repair or maintenance is in progress'),
      });
      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toMatchObject({
        builds: [],
        maintenance: {operation: 'graph-maintenance', phase: 'working'},
      });
    } finally {
      await server.close();
    }
  });

  it('rejects stale graph reads after promotion and serves the refreshed current view', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const checkoutId = await seedManagerGraph(config);
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret'};
      const catalog = (await (await fetch(`${server.url}/api/graphs`, {headers})).json()) as {
        readonly repositories: readonly {
          readonly defaultViewId: string;
          readonly views: readonly {readonly id: string; readonly snapshot: {readonly id: string}}[];
        }[];
      };
      const view = catalog.repositories[0]!.views[0]!;
      const originalSnapshotId = view.snapshot.id;
      expect(originalSnapshotId).toBe(MANAGER_GRAPH_SNAPSHOT_ID);
      const replacementSnapshotId = await promoteManagerGraphReplacement(config);
      const staleUrls = [
        `${server.url}/api/graph?repository=${checkoutId}&snapshot=${originalSnapshotId}&project=cgp_app`,
        `${server.url}/api/graph/node?repository=${checkoutId}&snapshot=${originalSnapshotId}&node=app`,
        `${server.url}/api/graph/analysis?repository=${checkoutId}&snapshot=${originalSnapshotId}`,
        `${server.url}/api/graph/query?repository=${checkoutId}&snapshot=${originalSnapshotId}&query=App`,
        `${server.url}/api/graphs/page?repository=${checkoutId}&snapshot=${originalSnapshotId}&query=app`,
      ];
      for (const url of staleUrls) {
        const stale = await fetch(url, {headers});
        expect(stale.status, url).toBe(409);
        expect(await stale.json(), url).toEqual({
          code: 'graph-view-stale',
          error: 'The selected graph view changed or was removed. Refresh the graph catalog.',
          retryAfterMilliseconds: 0,
        });
      }

      const currentGraph = (await (
        await fetch(`${server.url}/api/graph?repository=${checkoutId}&project=all`, {headers})
      ).json()) as {readonly repository: {readonly snapshot: {readonly id: string}}};
      expect(currentGraph.repository.snapshot.id).toBe(replacementSnapshotId);
    } finally {
      await server.close();
    }
  });

  it('returns per-item bulk results without hiding failures', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    vi.mocked(memory.runArchive).mockImplementation((_config, uri) => {
      if (uri.endsWith('bad.md')) {
        return Effect.fail(new TestError('archive failed'));
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
