import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {randomBytes, randomUUID} from 'node:crypto';
import {lstat, readFile, readdir, rm} from 'node:fs/promises';
import {join, relative, sep} from 'node:path';
import {Console, Effect, FiberSet, FileSystem, Result} from 'effect';
import {effectAiConfiguration, runEffectAiConsolidation} from './effect/ai-consolidator.js';
import {runCommandEffect} from './effect/command.js';
import {captureConsole, capturePromiseConsole, consoleOutput} from './effect/console.js';
import {fromPromiseError} from './effect/errors.js';
import type {ApplicationServices} from './effect/runtime.js';
import {uriSegment} from './manifest.js';
import {
  runArchive,
  runCompact,
  runCompactDiagnostics,
  runExportPack,
  runForget,
  runImportPack,
  runRead,
  runRecall,
  runRemember,
} from './memory.js';
import {parseMemoryDocument, type MemoryRecord} from './memory_hygiene.js';
import {
  ensureSharedDirectoryChain,
  isInSharedNamespace,
  parentUri,
  publishShareGitChange,
  readTeamsFile,
  removeMemoryUri,
  resolveTeam,
  runShareInit,
  runSharePublish,
  runShareRemove,
  runShareRename,
  runShareSetUrl,
  runShareSync,
  runShareUnpublish,
  sharedTeamNameForUri,
  vikingUriToWorktreeRelative,
  writeMemoryFile,
} from './share.js';
import {collectDoctorChecks, runRepair, runStart} from './lifecycle.js';
import {runSeed, runSeedSkills} from './seeding.js';
import {currentPackageVersion, fetchLatestVersion, updateRegistry} from './update.js';
import type {
  AgentClient,
  ConsolidationAgent,
  DoctorCheck,
  ManageOptions,
  MemoryKind,
  MemoryStatus,
  RuntimeConfig,
  ShareTeamConfig,
} from './types.js';
import {
  assertVikingUri,
  errorMessage,
  findExecutable,
  openVikingCliForMode,
  runCommand,
  safeTimestamp,
  sha256,
  shellQuote,
  toolRoot,
} from './utils.js';
import {openVikingLogPath, withIdentity} from './runtime.js';

interface ManagerTreeNode {
  readonly children?: readonly ManagerTreeNode[];
  readonly isDir: boolean;
  readonly isShared: boolean;
  readonly isSystem: boolean;
  readonly metadata?: MemoryRecord['metadata'];
  readonly modTime?: string;
  readonly name: string;
  readonly relativePath: string;
  readonly sharedTeam?: string;
  readonly size?: number;
  readonly uri: string;
}

interface ReadTreeOptions {
  readonly parseMemoryDocuments?: boolean;
  readonly rootName?: string;
}

interface ApiContext {
  readonly config: RuntimeConfig;
  readonly jobs: Map<string, ConsolidationJob>;
  readonly runEffect?: ManagerEffectPromise;
  readonly token: string;
}

type ManagerOperation<A> = Effect.Effect<A, unknown, ApplicationServices>;
type ManagerEffectPromise = <A>(effect: ManagerOperation<A>) => Promise<A>;

type ConsolidationStatus = 'completed' | 'failed' | 'running';

interface ConsolidationJob {
  readonly agent: ConsolidationAgent;
  readonly createdAt: string;
  readonly id: string;
  readonly sourceUris: readonly string[];
  readonly target: TargetMemoryInput;
  draft?: string;
  error?: string;
  status: ConsolidationStatus;
}

interface TargetMemoryInput {
  readonly kind?: MemoryKind;
  readonly project?: string;
  readonly sourceAgentClient?: string;
  readonly status?: MemoryStatus;
  readonly team?: string;
  readonly topic?: string;
}

interface BulkItemResult {
  readonly ok: boolean;
  readonly output?: string;
  readonly uri: string;
  readonly error?: string;
}

const STATIC_FILES: Readonly<
  Record<string, {readonly contentType: string; readonly path: string; readonly root?: 'docs' | 'manager'}>
> = {
  '/': {contentType: 'text/html; charset=utf-8', path: 'index.html'},
  '/index.html': {contentType: 'text/html; charset=utf-8', path: 'index.html'},
  '/app.css': {contentType: 'text/css; charset=utf-8', path: 'app.css'},
  '/app.js': {contentType: 'text/javascript; charset=utf-8', path: 'app.js'},
  '/threadnote-logo.svg': {contentType: 'image/svg+xml; charset=utf-8', path: 'threadnote-logo.svg', root: 'docs'},
  '/threadnote-logo-inverted.svg': {
    contentType: 'image/svg+xml; charset=utf-8',
    path: 'threadnote-logo-inverted.svg',
    root: 'docs',
  },
};

export function runManage(config: RuntimeConfig, options: ManageOptions) {
  return Effect.scoped(
    Effect.gen(function* () {
      const token = randomBytes(24).toString('base64url');
      const runEffect = yield* FiberSet.makeRuntimePromise<ApplicationServices>();
      const server = createManagerServer({config, jobs: new Map(), token}, runEffect);
      const port = options.uiPort ?? 0;
      yield* Effect.acquireRelease(
        fromPromiseError(async () => {
          await listen(server, port);
          return server;
        }),
        closeManagerServer,
      );
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const url = `http://127.0.0.1:${actualPort}/?token=${encodeURIComponent(token)}`;
      yield* Console.log(`Threadnote manager: ${url}`);
      yield* Console.log('Press Ctrl-C to stop the manager.');
      if (options.open !== false) {
        yield* runCommandEffect('open', [url], {allowFailure: true});
      }
      return yield* Effect.never;
    }),
  );
}

function closeManagerServer(server: Server): Effect.Effect<void> {
  return Effect.callback<void>(resume => {
    server.close(() => resume(Effect.void));
  });
}

type ManagerRequestEffect = Effect.Effect<void, never, ApplicationServices>;

export function createManagerServer(context: ApiContext, runEffect: ManagerEffectPromise): Server {
  const requestContext: ApiContext = {...context, runEffect};
  return createServer((request, response) => {
    void runEffect(handleRequestEffect(requestContext, request, response)).catch(error => {
      if (!response.headersSent) {
        writeJson(response, 500, {error: errorMessage(error)});
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export async function memoryTree(config: RuntimeConfig): Promise<ManagerTreeNode> {
  const root = localMemoriesRoot(config);
  return readTree(config, root, `viking://user/${uriSegment(config.user)}/memories`, '');
}

export async function resourcesTree(config: RuntimeConfig): Promise<ManagerTreeNode> {
  const root = localResourcesRoot(config);
  try {
    return await readTree(config, root, 'viking://resources', '', {
      parseMemoryDocuments: false,
      rootName: 'resources',
    });
  } catch (err) {
    if (isMissingPathError(err)) {
      return {
        children: [],
        isDir: true,
        isShared: false,
        isSystem: false,
        name: 'resources',
        relativePath: '',
        uri: 'viking://resources',
      };
    }
    throw err;
  }
}

export async function readManagedMemory(
  config: RuntimeConfig,
  uri: string,
): Promise<{
  readonly content: string;
  readonly node: ManagerTreeNode;
  readonly record?: MemoryRecord;
}> {
  assertVikingUri(uri);
  const path = localPathForMemoryUri(config, uri);
  if (!path) {
    throw new Error(`Manager can only read current-user memory URIs: ${uri}`);
  }
  const pathStat = await lstat(path);
  if (!pathStat.isFile()) {
    throw new Error(`Manager can only read regular memory files: ${uri}`);
  }
  const content = await readFile(path, 'utf8');
  const relativePath = relative(localMemoriesRoot(config), path).split(sep).join('/');
  const record = parseMemoryDocument(uri, content);
  return {
    content,
    node: {
      isDir: false,
      isShared: isInSharedNamespace(config, uri),
      isSystem: isSystemMemoryName(path.split(sep).at(-1) ?? ''),
      metadata: record?.metadata,
      modTime: pathStat.mtime.toISOString(),
      name: path.split(sep).at(-1) ?? uri,
      relativePath,
      sharedTeam: sharedTeamNameForUri(config, uri),
      size: pathStat.size,
      uri,
    },
    record,
  };
}

export async function readContextUri(
  config: RuntimeConfig,
  uri: string,
  runEffect?: ManagerEffectPromise,
): Promise<{
  readonly content: string;
  readonly localMemory?: Awaited<ReturnType<typeof readManagedMemory>>;
  readonly output: string;
}> {
  assertVikingUri(uri);
  try {
    const localMemory = await readManagedMemory(config, uri);
    return {content: localMemory.content, localMemory, output: localMemory.content};
  } catch {
    const result = await runCaptured(() => runRead(config, uri, {}), runEffect);
    return {content: result.output, output: result.output};
  }
}

export async function detectConsolidationAgents(): Promise<
  readonly {
    readonly available: boolean;
    readonly command?: string;
    readonly id: ConsolidationAgent;
    readonly label: string;
  }[]
> {
  const effectAi = effectAiConfiguration();
  const [codex, claude, cursor, copilot] = await Promise.all([
    findExecutable(['codex']),
    findExecutable(['claude']),
    findExecutable(['cursor-agent']),
    findExecutable(['copilot']),
  ]);
  return [
    {available: codex !== undefined, command: codex, id: 'codex', label: 'Codex'},
    {available: claude !== undefined, command: claude, id: 'claude', label: 'Claude'},
    {available: cursor !== undefined, command: cursor, id: 'cursor', label: 'Cursor'},
    {available: copilot !== undefined, command: copilot, id: 'copilot', label: 'Copilot'},
    {
      available: effectAi !== undefined,
      command: effectAi?.model,
      id: 'effect-ai',
      label: 'Effect AI (OpenAI-compatible)',
    },
  ];
}

function handleRequestEffect(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
): ManagerRequestEffect {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  let requestEffect: Effect.Effect<void, unknown, ApplicationServices>;
  if (request.method === 'GET' && url.pathname === '/api/state') {
    requestEffect = Effect.gen(function* () {
      if (!isAuthorized(context, request)) {
        writeJson(response, 401, {error: 'Unauthorized'});
        return;
      }
      const [agents, version] = yield* fromPromiseError(() =>
        Promise.all([detectConsolidationAgents(), currentPackageVersion()]),
      );
      const latest = yield* Effect.try({
        try: updateRegistry,
        catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
      }).pipe(Effect.flatMap(fetchLatestVersion), Effect.match({onFailure: Result.fail, onSuccess: Result.succeed}));
      writeJson(response, 200, {
        agents,
        config: publicConfig(context.config),
        latestVersion: Result.isSuccess(latest) ? latest.success : undefined,
        openVikingLogPath: openVikingLogPath(context.config),
        version,
      });
    });
  } else if (request.method === 'POST' && url.pathname === '/api/consolidations') {
    requestEffect = Effect.gen(function* () {
      if (!isAuthorized(context, request)) {
        writeJson(response, 401, {error: 'Unauthorized'});
        return;
      }
      const body = yield* fromPromiseError(() => readJsonBody(request));
      const job = yield* createConsolidation(context, body);
      writeJson(response, 200, {job});
    });
  } else {
    requestEffect = fromPromiseError(() => handleRequestLegacy(context, request, response));
  }

  return requestEffect.pipe(
    Effect.catch(error =>
      Effect.sync(() => {
        writeJson(response, 500, {error: errorMessage(error)});
      }),
    ),
  );
}

async function handleRequestLegacy(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && STATIC_FILES[url.pathname]) {
    await serveStatic(context, url, response);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/favicon.ico') {
    response.writeHead(204, {'cache-control': 'no-store'});
    response.end();
    return;
  }
  if (!isAuthorized(context, request)) {
    writeJson(response, 401, {error: 'Unauthorized'});
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/tree') {
    const [tree, resourceTree] = await Promise.all([memoryTree(context.config), resourcesTree(context.config)]);
    writeJson(response, 200, {resourcesTree: resourceTree, tree});
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/memory') {
    writeJson(response, 200, await readManagedMemory(context.config, requiredQuery(url, 'uri')));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/read') {
    writeJson(response, 200, await readContextUri(context.config, requiredQuery(url, 'uri'), context.runEffect));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/shares') {
    writeJson(response, 200, {shares: await shareSummaries(context.config)});
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/doctor') {
    writeJson(response, 200, {
      checks: await collectManagerDoctorChecks(context.config),
      shares: await shareSummaries(context.config),
    });
    return;
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/consolidations/')) {
    const id = url.pathname.split('/').at(-1) ?? '';
    const job = context.jobs.get(id);
    writeJson(response, job ? 200 : 404, job ? {job} : {error: 'Consolidation job not found'});
    return;
  }
  if (request.method !== 'POST') {
    writeJson(response, 404, {error: 'Not found'});
    return;
  }

  const body = await readJsonBody(request);
  switch (url.pathname) {
    case '/api/memory/archive':
      requireConfirm(body);
      writeJson(
        response,
        200,
        await runCaptured(() => runArchive(context.config, requireString(body.uri, 'uri'), body), context.runEffect),
      );
      return;
    case '/api/memory/forget':
      requireConfirm(body);
      writeJson(
        response,
        200,
        await runCaptured(() => runForget(context.config, requireString(body.uri, 'uri'), {}), context.runEffect),
      );
      return;
    case '/api/memory/save':
      writeJson(response, 200, await saveMemory(context.config, body, context.runEffect));
      return;
    case '/api/memory/move':
      requireConfirm(body);
      writeJson(
        response,
        200,
        await moveMemory(context.config, requireString(body.uri, 'uri'), targetFromBody(body), context.runEffect),
      );
      return;
    case '/api/memory/publish':
      requireConfirm(body);
      writeJson(
        response,
        200,
        await runCaptured(() =>
          runSharePublish(context.config, requireString(body.uri, 'uri'), {
            redact: body.redact === true,
            team: optionalString(body.team),
          }),
        ),
      );
      return;
    case '/api/memory/unpublish':
      requireConfirm(body);
      writeJson(
        response,
        200,
        await runCaptured(() =>
          runShareUnpublish(context.config, requireString(body.uri, 'uri'), {team: optionalString(body.team)}),
        ),
      );
      return;
    case '/api/folder/remove':
      requireConfirm(body);
      writeJson(
        response,
        200,
        await runCaptured(() => removeManagedFolder(context.config, requireString(body.uri, 'uri'), context.runEffect)),
      );
      return;
    case '/api/bulk':
      requireConfirm(body);
      writeJson(response, 200, await runBulk(context.config, body, context.runEffect));
      return;
    case '/api/compact':
      if (body.apply === true) {
        requireConfirm(body);
      }
      writeJson(
        response,
        200,
        await runCaptured(
          () =>
            Effect.gen(function* () {
              yield* fromPromiseError(() => runCompactDiagnostics(context.config, body));
              yield* runCompact(context.config, body);
            }),
          context.runEffect,
        ),
      );
      return;
    case '/api/recall':
      writeJson(
        response,
        200,
        await runCaptured(
          () =>
            runRecall(context.config, {
              query: requireString(body.query, 'query'),
              nodeLimit: optionalString(body.nodeLimit),
              project: optionalString(body.project),
            }),
          context.runEffect,
        ),
      );
      return;
    case '/api/read':
      writeJson(response, 200, await readContextUri(context.config, requireString(body.uri, 'uri'), context.runEffect));
      return;
    case '/api/shares/init':
      requireConfirm(body);
      writeJson(
        response,
        200,
        await runCaptured(() =>
          runShareInit(context.config, requireString(body.remoteUrl, 'remoteUrl'), {team: optionalString(body.team)}),
        ),
      );
      return;
    case '/api/shares/rename':
      requireConfirm(body);
      writeJson(
        response,
        200,
        await runCaptured(() =>
          runShareRename(context.config, {team: requireString(body.team, 'team'), to: requireString(body.to, 'to')}),
        ),
      );
      return;
    case '/api/shares/set-url':
      requireConfirm(body);
      writeJson(
        response,
        200,
        await runCaptured(() =>
          runShareSetUrl(context.config, requireString(body.remoteUrl, 'remoteUrl'), {team: optionalString(body.team)}),
        ),
      );
      return;
    case '/api/shares/remove':
      requireConfirm(body);
      writeJson(
        response,
        200,
        await runCaptured(() =>
          runShareRemove(context.config, {
            keepFiles: body.keepFiles === true,
            preserveLocal: body.preserveLocal === true,
            team: optionalString(body.team),
          }),
        ),
      );
      return;
    case '/api/shares/sync':
      writeJson(
        response,
        200,
        await runCaptured(() => runShareSync(context.config, {team: optionalString(body.team)})),
      );
      return;
    case '/api/doctor/start':
      writeJson(response, 200, await runCaptured(() => runStart(context.config, {}), context.runEffect));
      return;
    case '/api/doctor/repair-dry-run':
      writeJson(response, 200, await runCaptured(() => runRepair(context.config, {dryRun: true}), context.runEffect));
      return;
    case '/api/doctor/repair':
      requireConfirm(body);
      writeJson(response, 200, await runCaptured(() => runRepair(context.config, {dryRun: false}), context.runEffect));
      return;
    case '/api/import-pack':
      requireConfirm(body);
      writeJson(
        response,
        200,
        await runCaptured(
          () => runImportPack(context.config, {path: requireString(body.path, 'path')}),
          context.runEffect,
        ),
      );
      return;
    case '/api/export-pack':
      writeJson(
        response,
        200,
        await runCaptured(
          () => runExportPack(context.config, {path: optionalString(body.path), uri: optionalString(body.uri)}),
          context.runEffect,
        ),
      );
      return;
    case '/api/seed':
      requireConfirm(body);
      writeJson(
        response,
        200,
        await runCaptured(
          () =>
            body.skills === true
              ? runSeedSkills(context.config, {dryRun: body.dryRun === true})
              : runSeed(context.config, {dryRun: body.dryRun === true}),
          context.runEffect,
        ),
      );
      return;
    default:
      if (url.pathname.startsWith('/api/consolidations/') && url.pathname.endsWith('/apply')) {
        requireConfirm(body);
        const id = url.pathname.split('/').at(-2) ?? '';
        writeJson(response, 200, await applyConsolidation(context.config, context.jobs, id, body, context.runEffect));
        return;
      }
      writeJson(response, 404, {error: 'Not found'});
  }
}

async function serveStatic(context: ApiContext, url: URL, response: ServerResponse): Promise<void> {
  const file = STATIC_FILES[url.pathname] ?? STATIC_FILES['/'];
  const content = await readFile(join(toolRoot(), file.root ?? 'manager', file.path));
  const headers: Record<string, string> = {'content-type': file.contentType};
  if (file.root !== 'docs') {
    headers['cache-control'] = 'no-store';
  }
  response.writeHead(200, headers);
  response.end(content);
}

async function readTree(
  config: RuntimeConfig,
  path: string,
  uri: string,
  relativePath: string,
  options: ReadTreeOptions = {},
): Promise<ManagerTreeNode> {
  const pathStat = await lstat(path);
  const name = relativePath ? (relativePath.split('/').at(-1) ?? relativePath) : (options.rootName ?? 'memories');
  const isDir = pathStat.isDirectory();
  if (!isDir) {
    if (!pathStat.isFile()) {
      throw new Error(`Manager can only read regular files or directories: ${uri}`);
    }
    const record =
      options.parseMemoryDocuments === false
        ? undefined
        : parseMemoryDocument(uri, await readFile(path, 'utf8').catch(() => ''));
    return {
      isDir: false,
      isShared: isInSharedNamespace(config, uri),
      isSystem: isSystemMemoryName(name),
      metadata: record?.metadata,
      modTime: pathStat.mtime.toISOString(),
      name,
      relativePath,
      sharedTeam: sharedTeamNameForUri(config, uri),
      size: pathStat.size,
      uri,
    };
  }
  const entries = await readdir(path, {withFileTypes: true});
  const children = await Promise.all(
    entries
      .filter(entry => entry.isDirectory() || entry.isFile())
      .sort(
        (left, right) =>
          Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name),
      )
      .map(entry => {
        const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        return readTree(config, join(path, entry.name), `${uri}/${entry.name}`, childRelative, options);
      }),
  );
  return {
    children,
    isDir: true,
    isShared: isInSharedNamespace(config, uri),
    isSystem: isSystemMemoryName(name),
    modTime: pathStat.mtime.toISOString(),
    name,
    relativePath,
    sharedTeam: sharedTeamNameForUri(config, uri),
    size: pathStat.size,
    uri,
  };
}

async function saveMemory(
  config: RuntimeConfig,
  body: Record<string, unknown>,
  runEffect: ManagerEffectPromise | undefined,
): Promise<{readonly output: string}> {
  const text = requireString(body.text, 'text');
  const replaceUri = optionalString(body.replaceUri);
  if (replaceUri && isRawMemoryDocument(text)) {
    return runCaptured(() => writeRawMemory(config, replaceUri, text));
  }
  return runCaptured(
    () =>
      runRemember(config, {
        kind: memoryKind(body.kind) ?? 'durable',
        project: optionalString(body.project),
        replace: replaceUri,
        sourceAgentClient: optionalString(body.sourceAgentClient) ?? 'manager',
        status: memoryStatus(body.status) ?? 'active',
        text,
        topic: optionalString(body.topic),
      }),
    runEffect,
  );
}

async function writeRawMemory(config: RuntimeConfig, uri: string, content: string): Promise<void> {
  assertVikingUri(uri);
  const ov = await openVikingCliForMode(false);
  if (isInSharedNamespace(config, uri)) {
    const teamName = sharedTeamNameForUri(config, uri);
    if (!teamName) {
      throw new Error(`${uri} is not in a configured shared namespace.`);
    }
    const team = await resolveTeam(config, teamName);
    await ensureSharedDirectoryChain(config, ov, uri, false);
    await writeMemoryFile(config, ov, uri, content, 'replace', false);
    const relativePath = vikingUriToWorktreeRelative(config, uri, team.name);
    await publishShareGitChange(team.config.worktree, relativePath, `share: update ${relativePath}`);
    return;
  }
  await ensurePersonalDirectoryChain(config, ov, parentUri(uri));
  await writeMemoryFile(config, ov, uri, content, 'replace', false);
}

async function moveMemory(
  config: RuntimeConfig,
  sourceUri: string,
  target: TargetMemoryInput,
  runEffect: ManagerEffectPromise | undefined,
): Promise<{readonly output: string; readonly targetUri: string}> {
  assertVikingUri(sourceUri);
  const source = await readManagedMemory(config, sourceUri);
  const sourceRecord = source.record;
  const text = sourceRecord?.body ?? source.content;
  const metadata = {
    kind: target.kind ?? sourceRecord?.metadata.kind ?? 'durable',
    project: target.project ?? sourceRecord?.metadata.project ?? 'general',
    sourceAgentClient: target.sourceAgentClient ?? 'manager',
    status: target.status ?? sourceRecord?.metadata.status ?? 'active',
    topic: target.topic ?? sourceRecord?.metadata.topic ?? 'current',
  };
  const personalTargetUri = memoryUriFor(config, metadata);
  if (target.team) {
    const targetTeam = target.team;
    if (isInSharedNamespace(config, sourceUri)) {
      const team = sharedTeamNameForUri(config, sourceUri);
      if (team !== targetTeam) {
        throw new Error(
          'Cross-team shared moves are not supported in V1. Copy/unpublish, then publish to the target team.',
        );
      }
      const sharedTargetUri = sharedMemoryUriFor(config, targetTeam, metadata);
      const output = await runCaptured(() =>
        moveSharedWithinTeam(config, sourceUri, sharedTargetUri, source.content, targetTeam),
      );
      return {...output, targetUri: sharedTargetUri};
    }
    const saved = await runCaptured(
      () =>
        runRemember(config, {
          kind: metadata.kind,
          project: metadata.project,
          replace: sourceUri,
          sourceAgentClient: metadata.sourceAgentClient,
          status: metadata.status,
          text,
          topic: metadata.topic,
        }),
      runEffect,
    );
    const published = await runCaptured(() => runSharePublish(config, personalTargetUri, {team: targetTeam}));
    return {
      output: [saved.output, published.output].filter(Boolean).join('\n'),
      targetUri: sharedMemoryUriFor(config, targetTeam, metadata),
    };
  }
  if (isInSharedNamespace(config, sourceUri)) {
    const saved = await runCaptured(
      () =>
        runRemember(config, {
          kind: metadata.kind,
          project: metadata.project,
          sourceAgentClient: metadata.sourceAgentClient,
          status: metadata.status,
          text,
          topic: metadata.topic,
        }),
      runEffect,
    );
    const removed = await runCaptured(() => removeSharedSource(config, sourceUri));
    return {output: [saved.output, removed.output].filter(Boolean).join('\n'), targetUri: personalTargetUri};
  }
  const output = await runCaptured(
    () =>
      runRemember(config, {
        kind: metadata.kind,
        project: metadata.project,
        replace: sourceUri,
        sourceAgentClient: metadata.sourceAgentClient,
        status: metadata.status,
        text,
        topic: metadata.topic,
      }),
    runEffect,
  );
  return {...output, targetUri: personalTargetUri};
}

async function moveSharedWithinTeam(
  config: RuntimeConfig,
  sourceUri: string,
  targetUri: string,
  content: string,
  teamName: string,
): Promise<void> {
  const team = await resolveTeam(config, teamName);
  const ov = await openVikingCliForMode(false);
  await ensureSharedDirectoryChain(config, ov, targetUri, false);
  await writeMemoryFile(config, ov, targetUri, content, 'create', false);
  await publishShareGitChange(
    team.config.worktree,
    vikingUriToWorktreeRelative(config, targetUri, team.name),
    `share: move ${vikingUriToWorktreeRelative(config, sourceUri, team.name)} to ${vikingUriToWorktreeRelative(config, targetUri, team.name)}`,
  );
  await publishShareGitChange(
    team.config.worktree,
    vikingUriToWorktreeRelative(config, sourceUri, team.name),
    `share: remove ${vikingUriToWorktreeRelative(config, sourceUri, team.name)}`,
    {
      verb: 'rm',
    },
  );
  await removeMemoryUri(config, ov, sourceUri, false);
}

async function removeSharedSource(config: RuntimeConfig, sourceUri: string): Promise<void> {
  const teamName = sharedTeamNameForUri(config, sourceUri);
  if (!teamName) {
    throw new Error(`${sourceUri} is not a shared memory.`);
  }
  const team = await resolveTeam(config, teamName);
  const ov = await openVikingCliForMode(false);
  await publishShareGitChange(
    team.config.worktree,
    vikingUriToWorktreeRelative(config, sourceUri, team.name),
    `share: remove ${vikingUriToWorktreeRelative(config, sourceUri, team.name)}`,
    {
      verb: 'rm',
    },
  );
  await removeMemoryUri(config, ov, sourceUri, false);
}

async function removeManagedFolder(
  config: RuntimeConfig,
  uri: string,
  runEffect: ManagerEffectPromise | undefined,
): Promise<void> {
  assertVikingUri(uri);
  const rootUri = `viking://user/${uriSegment(config.user)}/memories`;
  if (uri === rootUri) {
    throw new Error('Refusing to remove the root memories folder.');
  }
  if (isInSharedNamespace(config, uri)) {
    throw new Error('Shared folders are managed from Sharing. Remove the share or unpublish selected memories.');
  }
  const path = localPathForMemoryUri(config, uri);
  if (!path) {
    throw new Error(`Manager can only remove current-user memory folders: ${uri}`);
  }
  const pathStat = await lstat(path);
  if (!pathStat.isDirectory()) {
    throw new Error(`Not a folder: ${uri}`);
  }
  const relativePath = relative(localMemoriesRoot(config), path);
  if (!relativePath || relativePath.startsWith('..') || relativePath.split(sep).includes('..')) {
    throw new Error('Refusing to remove a folder outside the memories tree.');
  }
  const fileUris = await fileUrisUnderFolder(config, path);
  for (const fileUri of fileUris) {
    if (!runEffect) throw new Error('Manager Effect runtime is unavailable.');
    await runEffect(runForget(config, fileUri, {}));
  }
  await rm(path, {force: true, recursive: true});
  consoleOutput.log(`Removed folder: ${uri}`);
  consoleOutput.log(`Forgot ${fileUris.length} file${fileUris.length === 1 ? '' : 's'}.`);
}

async function fileUrisUnderFolder(config: RuntimeConfig, folderPath: string): Promise<readonly string[]> {
  const entries = await readdir(folderPath, {withFileTypes: true});
  const uris: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(folderPath, entry.name);
    if (entry.isDirectory()) {
      uris.push(...(await fileUrisUnderFolder(config, path)));
    } else if (entry.isFile()) {
      uris.push(localPathToMemoryUri(config, path));
    }
  }
  return uris;
}

async function runBulk(
  config: RuntimeConfig,
  body: Record<string, unknown>,
  runEffect: ManagerEffectPromise | undefined,
): Promise<{readonly results: readonly BulkItemResult[]}> {
  const action = requireString(body.action, 'action');
  const uris = requireStringArray(body.uris, 'uris');
  const results: BulkItemResult[] = [];
  for (const uri of uris) {
    try {
      let output: string;
      if (action === 'archive') {
        output = (await runCaptured(() => runArchive(config, uri, {}), runEffect)).output;
      } else if (action === 'forget') {
        output = (await runCaptured(() => runForget(config, uri, {}), runEffect)).output;
      } else if (action === 'publish') {
        output = (await runCaptured(() => runSharePublish(config, uri, {team: optionalString(body.team)}))).output;
      } else {
        throw new Error(`Unsupported bulk action: ${action}`);
      }
      results.push({ok: true, output, uri});
    } catch (err: unknown) {
      results.push({error: errorMessage(err), ok: false, uri});
    }
  }
  return {results};
}

function createConsolidation(context: ApiContext, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const input = yield* Effect.try({
      try: () => ({
        agent: consolidationAgent(requireString(body.agent, 'agent')),
        sourceUris: requireStringArray(body.uris, 'uris'),
        target: targetFromBody(body),
      }),
      catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    const job: ConsolidationJob = {
      agent: input.agent,
      createdAt: new Date().toISOString(),
      id: randomUUID(),
      sourceUris: input.sourceUris,
      status: 'running',
      target: input.target,
    };
    context.jobs.set(job.id, job);
    yield* Effect.gen(function* () {
      const sources = yield* fromPromiseError(() =>
        Promise.all(input.sourceUris.map(uri => readManagedMemory(context.config, uri))),
      );
      job.draft = yield* runConsolidationAgent(input.agent, sources);
      job.status = 'completed';
    }).pipe(
      Effect.catch(error =>
        Effect.sync(() => {
          job.error = errorMessage(error);
          job.status = 'failed';
        }),
      ),
    );
    return job;
  });
}

async function applyConsolidation(
  config: RuntimeConfig,
  jobs: Map<string, ConsolidationJob>,
  id: string,
  body: Record<string, unknown>,
  runEffect: ManagerEffectPromise | undefined,
): Promise<{readonly output: string}> {
  const job = jobs.get(id);
  if (!job) {
    throw new Error('Consolidation job not found.');
  }
  if (job.status !== 'completed' || !job.draft) {
    throw new Error('Consolidation job is not completed.');
  }
  const draft = optionalString(body.draft) ?? job.draft;
  const target = targetFromBody({...job.target, ...body});
  const saved = await runCaptured(
    () =>
      runRemember(config, {
        kind: target.kind ?? 'durable',
        project: target.project,
        sourceAgentClient: target.sourceAgentClient ?? 'manager',
        status: target.status ?? 'active',
        text: draft,
        topic: target.topic,
      }),
    runEffect,
  );
  const cleanup = cleanupMode(body.cleanup);
  const cleanupOutputs: string[] = [];
  if (cleanup !== 'keep') {
    for (const uri of job.sourceUris) {
      if (isInSharedNamespace(config, uri) && body.cleanupShared !== true) {
        cleanupOutputs.push(`Skipped shared source cleanup: ${uri}`);
        continue;
      }
      const action = cleanup === 'forget' ? () => runForget(config, uri, {}) : () => runArchive(config, uri, {});
      cleanupOutputs.push((await runCaptured(action, runEffect)).output);
    }
  }
  return {output: [saved.output, ...cleanupOutputs].filter(Boolean).join('\n')};
}

function runConsolidationAgent(
  agent: ConsolidationAgent,
  sources: readonly {readonly content: string; readonly node: ManagerTreeNode}[],
) {
  const prompt = consolidationPrompt(sources);
  if (agent === 'effect-ai') {
    const config = effectAiConfiguration();
    if (!config) {
      return Effect.fail(
        new Error(
          'Effect AI is not configured. Set THREADNOTE_EFFECT_AI=1 and THREADNOTE_EFFECT_AI_MODEL; add API URL/key variables when required.',
        ),
      );
    }
    return runEffectAiConsolidation(prompt, config);
  }
  if (agent !== 'codex' && agent !== 'claude') {
    return Effect.fail(new Error(`${agent} does not expose a supported non-interactive consolidation mode.`));
  }
  return Effect.gen(function* () {
    const executable = yield* fromPromiseError(() => findExecutable([agent]));
    if (!executable) {
      return yield* Effect.fail(new Error(`${agent} executable was not found.`));
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stagingDir = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-consolidate-'});
        const promptPath = join(stagingDir, 'prompt.txt');
        yield* fs.writeFileString(promptPath, prompt, {mode: 0o600});
        const script = consolidationAgentScript(agent, executable);
        const result = yield* runCommandEffect('sh', ['-lc', script, 'threadnote-consolidate', promptPath], {
          allowFailure: true,
          maxOutputBytes: 1024 * 1024,
          timeoutMs: 10 * 60 * 1000,
        });
        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            new Error(result.stderr.trim() || result.stdout.trim() || `${agent} exited with ${result.exitCode}`),
          );
        }
        const draft = result.stdout.trim();
        if (!draft) {
          return yield* Effect.fail(new Error(`${agent} returned an empty consolidation draft.`));
        }
        return draft;
      }),
    );
  });
}

export function consolidationAgentScript(agent: AgentClient, executable: string): string {
  if (agent === 'codex') {
    return `${shellQuote(executable)} exec --sandbox read-only --skip-git-repo-check - < "$1"`;
  }
  if (agent === 'claude') {
    return `${shellQuote(executable)} --print --permission-mode default < "$1"`;
  }
  throw new Error(`${agent} does not expose a supported non-interactive consolidation mode.`);
}

function consolidationPrompt(sources: readonly {readonly content: string; readonly node: ManagerTreeNode}[]): string {
  return [
    'Consolidate these Threadnote memories into one concise memory.',
    'Return only the replacement memory body in Markdown. Do not include frontmatter.',
    'Preserve important facts, current status, decisions, blockers, and source viking:// URIs.',
    '',
    ...sources.flatMap(source => [`--- SOURCE ${source.node.uri} ---`, source.content.trim(), '']),
  ].join('\n');
}

async function shareSummaries(config: RuntimeConfig): Promise<
  readonly (ShareTeamConfig & {
    readonly ahead?: number;
    readonly behind?: number;
    readonly default: boolean;
    readonly dirty?: boolean;
    readonly status?: string;
    readonly warning?: string;
  })[]
> {
  const teamsFile = await readTeamsFile(config);
  const git = await findExecutable(['git']);
  const entries = await Promise.all(
    Object.values(teamsFile.teams).map(async team => {
      if (!git) {
        return {...team, default: teamsFile.defaultTeam === team.name, warning: 'git not found'};
      }
      const status = await runCommand(git, ['-C', team.worktree, 'status', '--short', '--branch'], {
        allowFailure: true,
      });
      const ahead = await gitCount(git, team.worktree, '@{u}..HEAD');
      const behind = await gitCount(git, team.worktree, 'HEAD..@{u}');
      return {
        ...team,
        ahead,
        behind,
        default: teamsFile.defaultTeam === team.name,
        dirty: status.stdout.split('\n').some(line => line.trim().length > 0 && !line.startsWith('##')),
        status: status.stdout.trim(),
        warning: status.exitCode === 0 ? undefined : status.stderr.trim() || status.stdout.trim(),
      };
    }),
  );
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

async function collectManagerDoctorChecks(config: RuntimeConfig): Promise<readonly DoctorCheck[]> {
  const threadnote = await findExecutable(['threadnote']);
  if (!threadnote) {
    return collectDoctorChecks(config, {});
  }
  const result = await runCommand(
    threadnote,
    [
      '--home',
      config.agentContextHome,
      '--manifest',
      config.manifestPath,
      '--host',
      config.host,
      '--port',
      String(config.port),
      'doctor',
    ],
    {allowFailure: true, maxOutputBytes: 1024 * 1024},
  );
  const checks = parseDoctorChecksFromOutput([result.stdout, result.stderr].filter(Boolean).join('\n'));
  return checks.length > 0 ? checks : collectDoctorChecks(config, {});
}

export function parseDoctorChecksFromOutput(output: string): readonly DoctorCheck[] {
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  return output
    .split(/\r?\n/)
    .map(line => line.replace(ansiEscape, '').trim())
    .map(line => /^(OK|WARN|FAIL)\s+([^:]+):\s*(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({
      detail: match[3] ?? '',
      name: match[2] ?? '',
      status: doctorStatus(match[1] ?? ''),
    }));
}

async function gitCount(git: string, worktree: string, range: string): Promise<number | undefined> {
  const result = await runCommand(git, ['-C', worktree, 'rev-list', '--count', range], {allowFailure: true});
  if (result.exitCode !== 0) {
    return undefined;
  }
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

function doctorStatus(value: string): DoctorCheck['status'] {
  if (value === 'OK') {
    return 'ok';
  }
  if (value === 'FAIL') {
    return 'fail';
  }
  return 'warn';
}

async function runCaptured(
  action: () => Promise<void> | ManagerOperation<void>,
  runEffect?: ManagerEffectPromise,
): Promise<{readonly output: string}> {
  const captured = await capturePromiseConsole(async () => {
    const operation = action();
    if (!Effect.isEffect(operation)) {
      await operation;
      return undefined;
    }
    if (!runEffect) throw new Error('Manager Effect runtime is unavailable.');
    return runEffect(captureConsole(operation));
  });
  return {
    output: [captured.output, captured.value?.output].filter(Boolean).join('\n'),
  };
}

function memoryUriFor(
  config: RuntimeConfig,
  metadata: {
    readonly kind: MemoryKind;
    readonly project: string;
    readonly status: MemoryStatus;
    readonly topic: string;
  },
): string {
  const project = uriSegment(metadata.project);
  const filename =
    metadata.status === 'active' && metadata.kind !== 'smoke'
      ? `${uriSegment(metadata.topic)}.md`
      : `threadnote-${safeTimestamp()}-${sha256(JSON.stringify(metadata)).slice(0, 12)}.md`;
  return `${memoryDirectoryUri(config, metadata.kind, metadata.status, project)}/${filename}`;
}

function sharedMemoryUriFor(
  config: RuntimeConfig,
  team: string,
  metadata: {
    readonly kind: MemoryKind;
    readonly project: string;
    readonly topic: string;
  },
): string {
  if (metadata.kind !== 'durable') {
    throw new Error('Only durable memories can be moved into shared team memory.');
  }
  return `viking://user/${uriSegment(config.user)}/memories/shared/${uriSegment(team)}/durable/projects/${uriSegment(metadata.project)}/${uriSegment(metadata.topic)}.md`;
}

function memoryDirectoryUri(
  config: RuntimeConfig,
  kind: MemoryKind,
  status: MemoryStatus,
  projectSegment: string,
): string {
  const base = `viking://user/${uriSegment(config.user)}/memories`;
  switch (kind) {
    case 'preference':
      return status === 'active' ? `${base}/preferences` : `${base}/preferences/${uriSegment(status)}`;
    case 'handoff':
      return `${base}/handoffs/${uriSegment(status)}/${projectSegment}`;
    case 'incident':
      return `${base}/incidents/${uriSegment(status)}/${projectSegment}`;
    case 'smoke':
      return `${base}/smoke/${uriSegment(status)}`;
    case 'durable':
      return status === 'active'
        ? `${base}/durable/projects/${projectSegment}`
        : `${base}/durable/${uriSegment(status)}/${projectSegment}`;
  }
}

function localMemoriesRoot(config: RuntimeConfig): string {
  return join(config.agentContextHome, 'data', 'viking', config.account, 'user', uriSegment(config.user), 'memories');
}

function localResourcesRoot(config: RuntimeConfig): string {
  return join(config.agentContextHome, 'data', 'viking', config.account, 'resources');
}

function localPathForMemoryUri(config: RuntimeConfig, uri: string): string | undefined {
  const prefix = `viking://user/${uriSegment(config.user)}/memories`;
  if (uri !== prefix && !uri.startsWith(`${prefix}/`)) {
    return undefined;
  }
  const relativePath = uri === prefix ? '' : uri.slice(prefix.length + 1);
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..')) {
    return undefined;
  }
  return join(localMemoriesRoot(config), ...segments);
}

function isMissingPathError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function localPathToMemoryUri(config: RuntimeConfig, path: string): string {
  const relativePath = relative(localMemoriesRoot(config), path);
  if (!relativePath || relativePath.startsWith('..') || relativePath.split(sep).includes('..')) {
    throw new Error(`Path is outside the memories tree: ${path}`);
  }
  return `viking://user/${uriSegment(config.user)}/memories/${relativePath.split(sep).join('/')}`;
}

async function ensurePersonalDirectoryChain(config: RuntimeConfig, ov: string, directoryUri: string): Promise<void> {
  const prefix = 'viking://';
  const parts = directoryUri.startsWith(prefix) ? directoryUri.slice(prefix.length).split('/').filter(Boolean) : [];
  const startIndex = parts[0] === 'user' && parts.length > 2 ? 3 : 1;
  for (let index = startIndex; index <= parts.length; index += 1) {
    const uri = `${prefix}${parts.slice(0, index).join('/')}`;
    const statResult = await runCommand(ov, withIdentity(config, ['stat', uri]), {allowFailure: true});
    if (statResult.exitCode !== 0) {
      await runCommand(
        ov,
        withIdentity(config, ['mkdir', uri, '--description', 'Threadnote lifecycle-aware local memories.']),
      );
    }
  }
}

function publicConfig(config: RuntimeConfig): Record<string, unknown> {
  return {
    account: config.account,
    agentContextHome: config.agentContextHome,
    agentId: config.agentId,
    host: config.host,
    manifestPath: config.manifestPath,
    port: config.port,
    user: config.user,
  };
}

function isAuthorized(context: ApiContext, request: IncomingMessage): boolean {
  const auth = request.headers.authorization;
  return auth === `Bearer ${context.token}` || request.headers['x-threadnote-token'] === context.token;
}

function isSystemMemoryName(name: string): boolean {
  return name === '.abstract.md' || name === '.overview.md' || name === '.git' || name === '.gitignore';
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object body.');
  }
  return parsed as Record<string, unknown>;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  response.end(`${JSON.stringify(body)}\n`);
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new Error(`Missing query parameter: ${name}`);
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Provide ${name}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function requireStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string')) {
    throw new Error(`Provide ${name} as a non-empty string array.`);
  }
  return value;
}

function requireConfirm(body: Record<string, unknown>): void {
  if (body.confirm !== true) {
    throw new Error('Set confirm=true for this action.');
  }
}

function targetFromBody(body: Record<string, unknown>): TargetMemoryInput {
  return {
    kind: memoryKind(body.kind),
    project: optionalString(body.project),
    sourceAgentClient: optionalString(body.sourceAgentClient),
    status: memoryStatus(body.status),
    team: optionalString(body.team),
    topic: optionalString(body.topic),
  };
}

function memoryKind(value: unknown): MemoryKind | undefined {
  return value === 'durable' ||
    value === 'handoff' ||
    value === 'incident' ||
    value === 'preference' ||
    value === 'smoke'
    ? value
    : undefined;
}

function memoryStatus(value: unknown): MemoryStatus | undefined {
  return value === 'active' || value === 'archived' || value === 'superseded' ? value : undefined;
}

function isRawMemoryDocument(text: string): boolean {
  return text.startsWith('MEMORY\n') || text.startsWith('HANDOFF\n');
}

function consolidationAgent(value: string): ConsolidationAgent {
  if (value === 'codex' || value === 'claude' || value === 'cursor' || value === 'copilot' || value === 'effect-ai') {
    return value;
  }
  throw new Error(`Unsupported consolidation agent: ${value}`);
}

function cleanupMode(value: unknown): 'archive' | 'forget' | 'keep' {
  if (value === 'forget' || value === 'keep') {
    return value;
  }
  return 'archive';
}
