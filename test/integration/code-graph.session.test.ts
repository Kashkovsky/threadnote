import {TestError} from '../helpers/test-error.js';
import {Database} from 'bun:sqlite';
import {execFileSync} from '../helpers/node-child-process.js';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from '../helpers/node-fs.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {Context, Effect, Layer} from 'effect';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {CodeGraphLanguagePackRegistry} from '../../src/code_graph/languages/registry.js';
import {repairCodeGraphIndexes} from '../../src/code_graph/maintenance.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {CODE_GRAPH_SCHEMA_VERSION} from '../../src/code_graph/types.js';
import {runEffect} from '../helpers/effect-runtime.js';

const sqliteSessions = vi.hoisted(() => ({
  active: 0,
  closed: [] as string[],
  maximumActive: 0,
  opened: [] as string[],
}));

// Every direct store connection is owned by one SqliteClient layer scope. Wrap
// that scope so the test observes the same acquire/release lifetime that owns
// the driver's Database.close finalizer without adding production test hooks.
vi.mock('@effect/sql-sqlite-bun/SqliteClient', async importOriginal => {
  const actual = await importOriginal<typeof import('@effect/sql-sqlite-bun/SqliteClient')>();
  const effect = await import('effect/Effect');
  const layer = await import('effect/Layer');
  return {
    ...actual,
    layer: (config: Parameters<typeof actual.layer>[0]) =>
      layer.merge(
        actual.layer(config),
        layer.effectDiscard(
          effect.acquireRelease(
            effect.sync(() => {
              sqliteSessions.active += 1;
              sqliteSessions.maximumActive = Math.max(sqliteSessions.maximumActive, sqliteSessions.active);
              sqliteSessions.opened.push(config.filename);
              return config.filename;
            }),
            filename =>
              effect.sync(() => {
                sqliteSessions.active -= 1;
                sqliteSessions.closed.push(filename);
              }),
          ),
        ),
      ),
  };
});

let repositoryRoot = '';
let baseCommit = '';

beforeAll(() => {
  repositoryRoot = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-session-'));
  mkdirSync(join(repositoryRoot, 'src'), {recursive: true});
  writeFileSync(join(repositoryRoot, 'package.json'), '{"name":"session-fixture"}\n');
  for (let index = 0; index < 260; index += 1) {
    const suffix = String(index).padStart(3, '0');
    writeFileSync(
      join(repositoryRoot, 'src', `symbol-${suffix}.ts`),
      `export function sessionSymbol${suffix}(): number { return ${index}; }\n`,
    );
  }
  git(['init', '-q']);
  git(['config', 'user.email', 'threadnote@example.test']);
  git(['config', 'user.name', 'Threadnote Test']);
  writeFileSync(join(repositoryRoot, '.gitignore'), '/.threadnote-*/\n');
  git(['add', '.']);
  git(['commit', '-qm', 'large base']);
  baseCommit = git(['rev-parse', 'HEAD']).trim();
  writeFileSync(
    join(repositoryRoot, 'src', 'current-only.ts'),
    'export function currentOnlySymbol(): string { return "current"; }\n',
  );
  git(['add', '.']);
  git(['commit', '-qm', 'current commit']);
});

beforeEach(() => {
  expect(sqliteSessions.active).toBe(0);
  sqliteSessions.closed.length = 0;
  sqliteSessions.maximumActive = 0;
  sqliteSessions.opened.length = 0;
});

afterAll(() => {
  rmSync(repositoryRoot, {force: true, recursive: true});
});

describe('code graph SQLite session lifetime', () => {
  it('decodes, postprocesses, and attributes each cached file only once while staging', async () => {
    const decoded = new Map<string, number>();
    const postprocessed = new Map<string, number>();
    const indexed = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const languagePacks = yield* CodeGraphLanguagePackRegistry;
        const countedStore = CodeGraphStore.of({
          ...store,
          loadCachedFacts: (databasePath, files, extractorSet, options) => {
            if (options?.decode !== false) {
              for (const file of files) decoded.set(file.path, (decoded.get(file.path) ?? 0) + 1);
            }
            return store.loadCachedFacts(databasePath, files, extractorSet, options);
          },
        });
        const countedLanguagePacks = CodeGraphLanguagePackRegistry.of({
          ...languagePacks,
          postprocessFile: (file, facts) => {
            postprocessed.set(file.path, (postprocessed.get(file.path) ?? 0) + 1);
            return languagePacks.postprocessFile(file, facts);
          },
        });
        const indexerLayer = Layer.fresh(CodeGraphIndexer.layer).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(CodeGraphStore, countedStore),
              Layer.succeed(CodeGraphLanguagePackRegistry, countedLanguagePacks),
            ),
          ),
        );
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const indexerContext = yield* Layer.build(indexerLayer);
            const indexer = Context.get(indexerContext, CodeGraphIndexer);
            return yield* indexer.index({
              cwd: repositoryRoot,
              force: true,
              threadnoteHome: join(repositoryRoot, '.threadnote-single-pass-home'),
            });
          }),
        );
      }),
    );

    expect(indexed.snapshot.fileCount).toBeGreaterThan(128);
    expect(decoded.size).toBe(indexed.snapshot.fileCount);
    expect(postprocessed.size).toBe(indexed.snapshot.fileCount);
    expect([...decoded.values()]).toEqual(Array.from({length: indexed.snapshot.fileCount}, () => 1));
    expect([...postprocessed.values()]).toEqual(Array.from({length: indexed.snapshot.fileCount}, () => 1));
  }, 60_000);

  it('uses one client for every store call across a multi-batch index', async () => {
    const activeClientsByActivity: number[] = [];
    const indexed = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({
          cwd: repositoryRoot,
          onProgress: progress =>
            Effect.sync(() => {
              if (progress.phase !== 'materializing' || progress.activity === undefined) return;
              activeClientsByActivity.push(sqliteSessions.active);
            }),
          threadnoteHome: join(repositoryRoot, '.threadnote-index-home'),
        });
      }),
    );

    expect(indexed.snapshot.fileCount).toBeGreaterThan(128);
    expect(activeClientsByActivity.length).toBeGreaterThan(1);
    expect(activeClientsByActivity.every(active => active === 1)).toBe(true);
    expectClosedSessions(2);
  }, 60_000);

  it('uses one client while materializing and leasing a multi-batch committed base', async () => {
    const lease = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.ensureCommit({
          commit: baseCommit,
          cwd: repositoryRoot,
          threadnoteHome: join(repositoryRoot, '.threadnote-commit-home'),
        });
      }),
    );

    expect(lease.snapshot.commit).toBe(baseCommit);
    expect(lease.snapshot.fileCount).toBeGreaterThan(128);
    expectClosedSessions(2);
  }, 60_000);

  it('closes the shared client when a multi-batch index fails after inventory caching', async () => {
    let materializingObserved = false;
    await expect(
      runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer.index({
            cwd: repositoryRoot,
            onProgress: progress => {
              if (progress.phase !== 'materializing') return Effect.void;
              materializingObserved = true;
              return Effect.fail(new TestError('fixture materialization failure'));
            },
            threadnoteHome: join(repositoryRoot, '.threadnote-failure-home'),
          });
        }),
      ),
    ).rejects.toThrow('fixture materialization failure');

    expect(materializingObserved).toBe(true);
    expectClosedSessions(1);
  }, 60_000);

  it('closes the shared client when committed-base materialization fails', async () => {
    let materializingObserved = false;
    await expect(
      runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer.ensureCommit({
            commit: baseCommit,
            cwd: repositoryRoot,
            onProgress: progress => {
              if (progress.phase !== 'materializing') return Effect.void;
              materializingObserved = true;
              return Effect.fail(new TestError('fixture committed-base failure'));
            },
            threadnoteHome: join(repositoryRoot, '.threadnote-commit-failure-home'),
          });
        }),
      ),
    ).rejects.toThrow('fixture committed-base failure');

    expect(materializingObserved).toBe(true);
    expectClosedSessions(1);
  }, 60_000);

  it('closes the maintenance SQLite client before discarding an incompatible store', async () => {
    const home = join(repositoryRoot, '.threadnote-maintenance-close-home');
    const indexed = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: repositoryRoot, threadnoteHome: home});
      }),
    );
    expect(sqliteSessions.active).toBe(0);
    sqliteSessions.closed.length = 0;
    sqliteSessions.maximumActive = 0;
    sqliteSessions.opened.length = 0;

    const databasePath = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      indexed.identity.checkoutId,
      `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
    );
    const incompatible = new Database(databasePath, {strict: true});
    incompatible.query("UPDATE schema_metadata SET value = '999' WHERE key = 'schema_version'").run();
    incompatible.close(false);
    let activeAtDiscard = -1;

    const repaired = await runEffect(
      repairCodeGraphIndexes(home, false, progress =>
        Effect.sync(() => {
          if (progress.phase === 'discarding') activeAtDiscard = sqliteSessions.active;
        }),
      ),
    );

    expect(repaired.discarded).toBe(1);
    expect(activeAtDiscard).toBe(0);
    expect(sqliteSessions.active).toBe(0);
    expect(existsSync(databasePath)).toBe(false);
  }, 60_000);
});

function expectClosedSessions(expected: number): void {
  // Index completion may open one additional zero-wait Store routine session
  // after the indexing session closes. Whether a fixture has cleanup work is
  // platform/state dependent, but a store-call-per-connection regression would
  // still exceed this bounded allowance.
  expect(sqliteSessions.opened.length, JSON.stringify(sqliteSessions.opened)).toBeGreaterThanOrEqual(expected);
  expect(sqliteSessions.opened.length, JSON.stringify(sqliteSessions.opened)).toBeLessThanOrEqual(expected + 1);
  expect(sqliteSessions.closed).toEqual(sqliteSessions.opened);
  expect(sqliteSessions.maximumActive).toBeLessThanOrEqual(1);
  expect(sqliteSessions.active).toBe(0);
  expect(sqliteSessions.opened.every(filename => /graph-v\d+\.sqlite$/.test(filename))).toBe(true);
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, {cwd: repositoryRoot, encoding: 'utf8'});
}
