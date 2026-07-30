import {Console, Effect, FileSystem, Path} from 'effect';
import {startProgress} from '../cli_ui.js';
import {SystemInfo} from '../effect/system.js';
import type {RuntimeConfig} from '../types.js';
import {CodeGraphIndexer} from './indexer.js';
import {codeGraphLayout} from './layout.js';
import {purgeAllCodeGraphIndexes} from './maintenance.js';
import {CodeGraphQueryService, renderCodeGraphResult} from './query.js';
import {repositoryChangesSince, resolveRepositoryIdentity} from './repository.js';
import {CodeGraphStore, type CodeGraphEdgeCursor, type CodeGraphSymbolCursor} from './store.js';
import type {CodeGraphEdge, CodeGraphProgress, CodeGraphQueryOptions, CodeGraphSymbol} from './types.js';
import {CodeGraphWatcher} from './watcher.js';

interface CwdOption {
  readonly cwd?: string;
}

export interface CodeGraphExportInterlock {
  readonly afterOutputCheck?: () => Effect.Effect<void>;
}

export const runCodeGraphStatus = Effect.fn('codeGraph.command.status')(function* (
  config: RuntimeConfig,
  options: CwdOption & {readonly json?: boolean},
) {
  const query = yield* CodeGraphQueryService;
  const cwd = yield* commandCwd(options.cwd);
  const status = yield* query.status(config.agentContextHome, cwd);
  if (options.json) {
    yield* Console.log(JSON.stringify({type: 'code-graph-status', version: 1, ...status}));
    return;
  }
  yield* Console.log(`Repository: ${status.identity.displayName}`);
  yield* Console.log(`Database: ${status.databasePath}`);
  if (!status.readySnapshot) {
    yield* Console.log('Ready snapshot: none');
    return;
  }
  yield* Console.log(
    `Ready snapshot: ${status.readySnapshot.id} · ${status.readySnapshot.fileCount} files · ` +
      `${status.readySnapshot.symbolCount} symbols · ${status.readySnapshot.edgeCount} edges`,
  );
  yield* Console.log(
    `Source: ${status.readySnapshot.commit.slice(0, 12)}${status.readySnapshot.dirty ? ' + dirty overlay' : ''} · ${
      status.stale ? 'stale' : 'current'
    }`,
  );
});

export const runCodeGraphIndex = Effect.fn('codeGraph.command.index')(function* (
  config: RuntimeConfig,
  options: CwdOption & {readonly full?: boolean; readonly json?: boolean},
) {
  const indexer = yield* CodeGraphIndexer;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  if (options.json) {
    const summary = yield* indexer.index({
      cwd,
      force: options.full,
      onProgress: progress =>
        Console.log(
          JSON.stringify({
            type: 'code-graph-progress',
            version: 1,
            repository: {
              displayName: identity.displayName,
              repositoryId: identity.repositoryId,
            },
            ...progress,
          }),
        ),
      threadnoteHome: config.agentContextHome,
    });
    yield* Console.log(JSON.stringify({type: 'code-graph-index', version: 1, ...summary}));
    return;
  }
  yield* Console.log(`Indexing code graph: ${identity.displayName}`);
  yield* Effect.acquireUseRelease(
    startProgress('Scanning repository source from Git.'),
    progress =>
      indexer
        .index({
          cwd,
          force: options.full,
          onProgress: state => progress.update(progressMessage(state)).pipe(Effect.catch(() => Effect.void)),
          threadnoteHome: config.agentContextHome,
        })
        .pipe(
          Effect.tap(summary =>
            progress
              .update(
                `Ready · ${summary.snapshot.fileCount} files · ${summary.snapshot.symbolCount} symbols · ` +
                  `${summary.snapshot.edgeCount} edges`,
              )
              .pipe(Effect.catch(() => Effect.void)),
          ),
        ),
    progress => progress.stop().pipe(Effect.catch(() => Effect.void)),
  ).pipe(
    Effect.flatMap(summary =>
      Console.log(
        `Code graph ready for ${summary.identity.displayName}: ${summary.snapshot.fileCount} file(s), ` +
          `${summary.snapshot.symbolCount} symbol(s), ${summary.snapshot.edgeCount} relationship(s); ` +
          `${summary.reusedFiles} file(s) reused.`,
      ),
    ),
  );
});

export const runCodeGraphInspect = Effect.fn('codeGraph.command.inspect')(function* (
  config: RuntimeConfig,
  options: CwdOption &
    Omit<CodeGraphQueryOptions, 'cwd'> & {
      readonly baseCommit?: string;
      readonly json?: boolean;
      readonly seedQueries?: readonly string[];
    },
) {
  const service = yield* CodeGraphQueryService;
  const cwd = yield* commandCwd(options.cwd);
  const status = yield* service.status(config.agentContextHome, cwd);
  const inspect = (onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void>) =>
    service.inspect({
      ...options,
      cwd,
      onProgress,
      refresh: true,
      threadnoteHome: config.agentContextHome,
    });
  const result = options.json
    ? yield* inspect(progress => Console.log(JSON.stringify({type: 'code-graph-progress', version: 1, ...progress})))
    : status.stale
      ? yield* Effect.acquireUseRelease(
          startProgress('Scanning repository source from Git.'),
          progress => inspect(state => progress.update(progressMessage(state)).pipe(Effect.catch(() => Effect.void))),
          progress => progress.stop().pipe(Effect.catch(() => Effect.void)),
        )
      : yield* inspect();
  yield* Console.log(options.json ? JSON.stringify(result) : renderCodeGraphResult(result).trimEnd());
});

export const runCodeGraphImpact = Effect.fn('codeGraph.command.impact')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly base?: string;
    readonly depth?: number;
    readonly edgeLimit?: number;
    readonly json?: boolean;
    readonly nodeLimit?: number;
    readonly query?: string;
  },
) {
  const cwd = yield* commandCwd(options.cwd);
  const changes = options.query?.trim() ? undefined : yield* repositoryChangesSince(cwd, options.base ?? 'HEAD~1');
  const input = options.query?.trim() || changes!.paths.join(' ');
  yield* runCodeGraphInspect(config, {
    ...options,
    baseCommit: changes?.baseCommit,
    cwd,
    operation: 'impact',
    query: input,
    seedQueries: changes?.paths,
  });
});

export const runCodeGraphPurge = Effect.fn('codeGraph.command.purge')(function* (
  config: RuntimeConfig,
  options: CwdOption & {readonly all?: boolean; readonly dryRun?: boolean},
) {
  const path = yield* Path.Path;
  if (options.all) {
    const root = path.join(config.agentContextHome, 'indexes', 'code-graph');
    if (options.dryRun) {
      yield* Console.log(`Would remove derived code graph indexes: ${root}`);
      return;
    }
    const removed = yield* purgeAllCodeGraphIndexes(config.agentContextHome);
    yield* Console.log(`Removed derived code graph indexes: ${removed}`);
    return;
  }
  const service = yield* CodeGraphQueryService;
  const cwd = yield* commandCwd(options.cwd);
  if (options.dryRun) {
    const status = yield* service.status(config.agentContextHome, cwd);
    yield* Console.log(`Would remove derived code graph indexes: ${path.dirname(status.databasePath)}`);
    return;
  }
  const repositoryRoot = yield* service.purge(config.agentContextHome, cwd);
  yield* Console.log(`Removed derived code graph indexes: ${repositoryRoot}`);
});

export const runCodeGraphExport = Effect.fn('codeGraph.command.export')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly format: 'html' | 'json';
    readonly interlock?: CodeGraphExportInterlock;
    readonly output: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const identity = yield* resolveRepositoryIdentity(yield* commandCwd(options.cwd));
  const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
  const store = yield* CodeGraphStore;
  const snapshot = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
  if (!snapshot) {
    return yield* Effect.fail(
      new Error('No ready native code graph snapshot exists. Run `threadnote graph index` before exporting.'),
    );
  }
  const output = path.resolve(options.output);
  if (yield* fs.exists(output)) return yield* Effect.fail(new Error(`Export output already exists: ${output}`));
  yield* options.interlock?.afterOutputCheck?.() ?? Effect.void;
  yield* fs.makeDirectory(path.dirname(output), {recursive: true});
  const lease = yield* store.acquireSnapshotLease(layout.databasePath, snapshot.id, 30 * 60_000);
  let ownsOutput = false;
  yield* store.withSession(
    layout.databasePath,
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(output, {flag: 'wx', mode: 0o600});
        ownsOutput = true;
        const encoder = new TextEncoder();
        const write = (content: string) => file.writeAll(encoder.encode(content));
        const metadata = {
          repository: {displayName: identity.displayName, repositoryId: identity.repositoryId},
          snapshot,
          version: 1,
          warning: 'This explicit export contains source identifiers and repository-relative paths.',
        };
        let exportedSymbols = 0;
        let exportedEdges = 0;
        let symbolCursor: CodeGraphSymbolCursor | undefined;
        let edgeCursor: CodeGraphEdgeCursor | undefined;
        if (options.format === 'json') {
          yield* write(`${JSON.stringify(metadata).slice(0, -1)},"symbols":[`);
          while (exportedSymbols < snapshot.symbolCount) {
            const symbols = yield* store.loadSymbolPage(
              layout.databasePath,
              snapshot.id,
              symbolCursor,
              CODE_GRAPH_EXPORT_PAGE_SIZE,
            );
            if (symbols.length === 0) break;
            for (const symbol of symbols) {
              yield* write(`${exportedSymbols === 0 ? '' : ','}${JSON.stringify(symbol)}`);
              exportedSymbols += 1;
            }
            const last = symbols.at(-1)!;
            symbolCursor = {id: last.id, path: last.path, qualifiedName: last.qualifiedName};
          }
          yield* write('],"edges":[');
          while (exportedEdges < snapshot.edgeCount) {
            const edges = yield* store.loadEdgePage(
              layout.databasePath,
              snapshot.id,
              edgeCursor,
              CODE_GRAPH_EXPORT_PAGE_SIZE,
            );
            if (edges.length === 0) break;
            for (const edge of edges) {
              yield* write(`${exportedEdges === 0 ? '' : ','}${JSON.stringify(edge)}`);
              exportedEdges += 1;
            }
            const last = edges.at(-1)!;
            edgeCursor = {
              id: last.id,
              relation: last.relation,
              sourceName: last.sourceName,
              targetName: last.targetName,
            };
          }
          yield* write(']}\n');
        } else {
          yield* write(renderGraphHtmlStart(metadata, snapshot.symbolCount));
          while (exportedSymbols < snapshot.symbolCount) {
            const symbols = yield* store.loadSymbolPage(
              layout.databasePath,
              snapshot.id,
              symbolCursor,
              CODE_GRAPH_EXPORT_PAGE_SIZE,
            );
            if (symbols.length === 0) break;
            for (const symbol of symbols) {
              yield* write(renderGraphHtmlSymbol(symbol));
              exportedSymbols += 1;
            }
            const last = symbols.at(-1)!;
            symbolCursor = {id: last.id, path: last.path, qualifiedName: last.qualifiedName};
          }
          yield* write(`</tbody></table><h2>Relationships (${snapshot.edgeCount})</h2><ul>`);
          while (exportedEdges < snapshot.edgeCount) {
            const edges = yield* store.loadEdgePage(
              layout.databasePath,
              snapshot.id,
              edgeCursor,
              CODE_GRAPH_EXPORT_PAGE_SIZE,
            );
            if (edges.length === 0) break;
            for (const edge of edges) {
              yield* write(renderGraphHtmlEdge(edge));
              exportedEdges += 1;
            }
            const last = edges.at(-1)!;
            edgeCursor = {
              id: last.id,
              relation: last.relation,
              sourceName: last.sourceName,
              targetName: last.targetName,
            };
          }
          yield* write('</ul></html>\n');
        }
        if (exportedSymbols !== snapshot.symbolCount || exportedEdges !== snapshot.edgeCount) {
          return yield* Effect.fail(
            new Error(
              `Snapshot changed during export: expected ${snapshot.symbolCount}/${snapshot.edgeCount}, ` +
                `read ${exportedSymbols}/${exportedEdges}.`,
            ),
          );
        }
        yield* file.sync;
      }),
    ).pipe(
      Effect.onError(() =>
        ownsOutput ? fs.remove(output, {force: true}).pipe(Effect.catch(() => Effect.void)) : Effect.void,
      ),
      Effect.ensuring(store.releaseSnapshotLease(layout.databasePath, lease).pipe(Effect.catch(() => Effect.void))),
    ),
  );
  yield* Console.log(`Exported ${snapshot.symbolCount} symbol(s) and ${snapshot.edgeCount} edge(s): ${output}`);
});

export const runCodeGraphWatch = Effect.fn('codeGraph.command.watch')(function* (
  config: RuntimeConfig,
  options: CwdOption,
) {
  const cwd = yield* commandCwd(options.cwd);
  const watcher = yield* CodeGraphWatcher;
  yield* Console.log(`Watching code graph inputs in ${cwd}. Press Ctrl-C to stop.`);
  yield* watcher.watch({
    cwd,
    key: cwd,
    onRefreshed: (symbols, edges) => Console.log(`Code graph refreshed: ${symbols} symbol(s), ${edges} edge(s).`),
    threadnoteHome: config.agentContextHome,
  });
});

function commandCwd(value: string | undefined) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    return path.resolve(value?.trim() || system.currentDirectory());
  });
}

function progressMessage(progress: CodeGraphProgress): string {
  switch (progress.phase) {
    case 'registering':
      return 'Registering repository index';
    case 'waiting':
      return 'Waiting for another code graph build to finish';
    case 'scanning':
      return `Scanning · ${progress.accepted} accepted / ${progress.visited} visited · ${progress.skipped} skipped`;
    case 'parsing':
      return `Parsing · ${progress.completed}/${progress.total} · ${progress.reused} reused`;
    case 'resolving':
      return `Resolving · ${progress.symbols} symbols · ${progress.edges} relationships`;
    case 'embedding':
      return (
        `Embedding · ${Math.min(progress.total, progress.embedded + progress.reused)}/${progress.total} complete · ` +
        `${progress.reused} reused`
      );
    case 'activating':
      return `Activating · ${progress.snapshotId}`;
  }
}

function renderGraphHtmlStart(
  graph: {
    readonly repository: {readonly displayName: string};
    readonly snapshot: {readonly commit: string; readonly id: string};
  },
  symbolCount: number,
): string {
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8">' +
    `<title>Threadnote code graph — ${escapeHtml(graph.repository.displayName)}</title>` +
    '<style>body{font:14px system-ui;margin:2rem;max-width:1200px}table{border-collapse:collapse;width:100%}' +
    'td,th{border:1px solid #ddd;padding:.4rem;text-align:left}code{font-family:ui-monospace,monospace}</style>' +
    `<h1>${escapeHtml(graph.repository.displayName)}</h1>` +
    `<p>Snapshot <code>${escapeHtml(graph.snapshot.id)}</code>, commit <code>${escapeHtml(graph.snapshot.commit)}</code>.</p>` +
    '<p><strong>Privacy:</strong> this explicit export contains source identifiers and relative paths.</p>' +
    `<h2>Symbols (${symbolCount})</h2><table><thead><tr><th>Kind</th><th>Name</th><th>Location</th></tr></thead><tbody>`
  );
}

function renderGraphHtmlSymbol(symbol: CodeGraphSymbol): string {
  return (
    `<tr><td>${escapeHtml(symbol.kind)}</td><td>${escapeHtml(symbol.qualifiedName)}</td>` +
    `<td>${escapeHtml(symbol.path)}:${symbol.span.line}</td></tr>`
  );
}

function renderGraphHtmlEdge(edge: CodeGraphEdge): string {
  return (
    `<li><code>${escapeHtml(edge.sourceName)}</code> —${escapeHtml(edge.relation)} ` +
    `[${escapeHtml(edge.provenance)}]→ <code>${escapeHtml(edge.targetName)}</code></li>`
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const CODE_GRAPH_EXPORT_PAGE_SIZE = 500;
