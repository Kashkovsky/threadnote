import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Effect} from 'effect';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
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
  it('uses one client for every store call across a multi-batch index', async () => {
    const indexed = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({
          cwd: repositoryRoot,
          threadnoteHome: join(repositoryRoot, '.threadnote-index-home'),
        });
      }),
    );

    expect(indexed.snapshot.fileCount).toBeGreaterThan(128);
    expectSingleClosedSession();
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
    expectSingleClosedSession();
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
              return Effect.fail(new Error('fixture materialization failure'));
            },
            threadnoteHome: join(repositoryRoot, '.threadnote-failure-home'),
          });
        }),
      ),
    ).rejects.toThrow('fixture materialization failure');

    expect(materializingObserved).toBe(true);
    expectSingleClosedSession();
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
              return Effect.fail(new Error('fixture committed-base failure'));
            },
            threadnoteHome: join(repositoryRoot, '.threadnote-commit-failure-home'),
          });
        }),
      ),
    ).rejects.toThrow('fixture committed-base failure');

    expect(materializingObserved).toBe(true);
    expectSingleClosedSession();
  }, 60_000);
});

function expectSingleClosedSession(): void {
  expect(sqliteSessions.opened, JSON.stringify(sqliteSessions.opened)).toHaveLength(1);
  expect(sqliteSessions.closed).toEqual(sqliteSessions.opened);
  expect(sqliteSessions.maximumActive).toBe(1);
  expect(sqliteSessions.active).toBe(0);
  expect(sqliteSessions.opened[0]).toMatch(/graph-v\d+\.sqlite$/);
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, {cwd: repositoryRoot, encoding: 'utf8'});
}
