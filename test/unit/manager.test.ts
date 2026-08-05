import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BunHttpServer} from '@effect/platform-bun';
import {Console, Effect, Fiber, Path} from 'effect';
import {HttpServer} from 'effect/unstable/http';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  consolidationAgentScript,
  createManagerServer,
  memoryTree,
  parseDoctorChecksFromOutput,
  readManagedMemory,
  resourcesTree,
  runManage,
} from '../../src/manager.js';
import {pruneSelectedMemoryUris, selectableMemoryUris, type TreeNode} from '../../src/manager_ui.js';
import type {RuntimeConfig} from '../../src/types.js';
import * as lifecycle from '../../src/lifecycle.js';
import * as memory from '../../src/memory.js';
import * as seeding from '../../src/seeding.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {makeCodeGraphBuildReporter} from '../../src/code_graph/build_status.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {withCodeGraphMaintenanceIntent} from '../../src/code_graph/maintenance_gate.js';
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

async function seedManagerGraph(config: RuntimeConfig): Promise<string> {
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
    id: 'manager-graph-snapshot',
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
      yield* store.promote(layout.databasePath, identity, snapshot.id, new Set([identity.worktreeId]));
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
    id: 'manager-graph-snapshot-replacement',
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
      yield* store.promote(layout.databasePath, identity, snapshot.id, new Set([identity.worktreeId]));
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
      Effect.provide(BunHttpServer.layerTest),
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
        readonly queuedWorktreeIds: readonly string[];
      };
      expect(statusResponse.status).toBe(200);
      expect(status.builds).toEqual([expect.objectContaining({state: 'queued'})]);
      expect(status.queuedWorktreeIds).toEqual([seeded.worktreeId]);
      expect(existsSync(seeded.databasePath)).toBe(false);

      const catalogResponse = await fetch(`${server.url}/api/graphs`, {headers});
      const catalog = (await catalogResponse.json()) as {
        readonly builds: readonly {readonly state: string}[];
        readonly repositories: readonly unknown[];
      };
      expect(catalog).toMatchObject({builds: [expect.objectContaining({state: 'queued'})], repositories: []});
      expect(existsSync(seeded.databasePath)).toBe(false);
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
        worktreeId: 'c'.repeat(64),
      });
      expect(catalog.repositories[0]?.views[0]?.projects).toEqual(
        expect.arrayContaining([expect.objectContaining({id: 'cgp_app'}), expect.objectContaining({id: 'cgp_core'})]),
      );

      const catalogPageResponse = await fetch(
        `${server.url}/api/graphs/page?repository=${repositoryId}&snapshot=manager-graph-snapshot&offset=0&workspaceOffset=0&query=core`,
        {headers},
      );
      const catalogPage = (await catalogPageResponse.json()) as {
        readonly query: string;
        readonly repository: {
          readonly projects: readonly {readonly id: string}[];
          readonly snapshot: {readonly id: string};
        };
      };
      expect(catalogPageResponse.status).toBe(200);
      expect(catalogPage.query).toBe('core');
      expect(catalogPage.repository.snapshot.id).toBe('manager-graph-snapshot');
      expect(catalogPage.repository.projects.map(project => project.id)).toEqual(['cgp_core']);

      const viewsPageResponse = await fetch(`${server.url}/api/graphs/views?repository=${repositoryId}&offset=0`, {
        headers,
      });
      const viewsPage = (await viewsPageResponse.json()) as {
        readonly hasMore: boolean;
        readonly repositories: readonly {readonly views: readonly {readonly id: string}[]}[];
      };
      expect(viewsPageResponse.status).toBe(200);
      expect(viewsPage.hasMore).toBe(false);
      expect(viewsPage.repositories[0]?.views[0]?.id).toBe(`${repositoryId}.${'c'.repeat(64)}`);

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
        `${server.url}/api/graph/query?repository=${repositoryId}&snapshot=manager-graph-snapshot&query=${encodeURIComponent('App')}&nodeLimit=999999&edgeLimit=999999`,
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
      expect(query.repository.snapshot.id).toBe('manager-graph-snapshot');
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
          readonly views: readonly unknown[];
        }[];
        readonly mode: {readonly analyze: boolean; readonly deep: boolean};
        readonly summary: {readonly databaseCount: number; readonly readySnapshotCount: number};
        readonly type: string;
      };
      expect(diagnosticsResponse.status).toBe(200);
      expect(diagnostics).toMatchObject({
        mode: {analyze: true, deep: false},
        summary: {databaseCount: 1, readySnapshotCount: 1},
        type: 'code-graph-diagnostics',
      });
      expect(diagnostics.databases[0]).toMatchObject({health: {integrity: 'ok'}});

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
        body: JSON.stringify({action: 'index', checkoutId: 'a'.repeat(64), cwd: '.', worktreeId: 'c'.repeat(64)}),
        headers,
        method: 'POST',
      });
      expect(relativeTarget.status).toBe(500);
      expect(await relativeTarget.json()).toMatchObject({error: 'Supply cwd as an absolute local worktree path.'});

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

  it('returns a busy response for graph APIs when maintenance starts after Manager', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const response = await runEffect(
        withCodeGraphMaintenanceIntent(
          config.agentContextHome,
          Effect.promise(() =>
            fetch(`${server.url}/api/graphs/diagnostics`, {headers: {authorization: 'Bearer secret'}}),
          ),
        ),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('Native code graph repair or maintenance is in progress'),
      });
    } finally {
      await server.close();
    }
  });

  it('pins graph, node detail, and analysis reads to the catalog snapshot across promotion', async () => {
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
      expect(originalSnapshotId).toBe('manager-graph-snapshot');
      const replacementSnapshotId = await promoteManagerGraphReplacement(config);

      const pinnedGraphResponse = await fetch(
        `${server.url}/api/graph?repository=${checkoutId}&snapshot=${originalSnapshotId}&project=cgp_app`,
        {headers},
      );
      const pinnedGraph = (await pinnedGraphResponse.json()) as {
        readonly nodes: readonly {readonly id: string}[];
        readonly repository: {readonly snapshot: {readonly id: string}};
      };
      expect(pinnedGraphResponse.status).toBe(200);
      expect(pinnedGraph.repository.snapshot.id).toBe(originalSnapshotId);
      expect(pinnedGraph.nodes).toEqual(expect.arrayContaining([expect.objectContaining({id: 'app'})]));

      const pinnedNodeResponse = await fetch(
        `${server.url}/api/graph/node?repository=${checkoutId}&snapshot=${originalSnapshotId}&node=app`,
        {headers},
      );
      const pinnedNode = (await pinnedNodeResponse.json()) as {readonly snapshotId: string};
      expect(pinnedNodeResponse.status).toBe(200);
      expect(pinnedNode.snapshotId).toBe(originalSnapshotId);

      const pinnedAnalysisResponse = await fetch(
        `${server.url}/api/graph/analysis?repository=${checkoutId}&snapshot=${originalSnapshotId}`,
        {headers},
      );
      const pinnedAnalysis = (await pinnedAnalysisResponse.json()) as {
        readonly statistics: {readonly analyzedNodeCount: number};
      };
      expect(pinnedAnalysisResponse.status).toBe(200);
      expect(pinnedAnalysis.statistics.analyzedNodeCount).toBe(523);

      const pinnedQueryResponse = await fetch(
        `${server.url}/api/graph/query?repository=${checkoutId}&snapshot=${originalSnapshotId}&query=App`,
        {headers},
      );
      const pinnedQuery = (await pinnedQueryResponse.json()) as {
        readonly nodes: readonly {readonly id: string}[];
        readonly repository: {readonly snapshot: {readonly id: string}};
      };
      expect(pinnedQueryResponse.status).toBe(200);
      expect(pinnedQuery.repository.snapshot.id).toBe(originalSnapshotId);
      expect(pinnedQuery.nodes).toEqual(expect.arrayContaining([expect.objectContaining({id: 'app'})]));

      const pinnedCatalogPageResponse = await fetch(
        `${server.url}/api/graphs/page?repository=${checkoutId}&snapshot=${originalSnapshotId}&query=app`,
        {headers},
      );
      const pinnedCatalogPage = (await pinnedCatalogPageResponse.json()) as {
        readonly repository: {
          readonly projects: readonly {readonly id: string}[];
          readonly snapshot: {readonly id: string};
        };
      };
      expect(pinnedCatalogPageResponse.status).toBe(200);
      expect(pinnedCatalogPage.repository.snapshot.id).toBe(originalSnapshotId);
      expect(pinnedCatalogPage.repository.projects).toEqual(
        expect.arrayContaining([expect.objectContaining({id: 'cgp_app'})]),
      );

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
