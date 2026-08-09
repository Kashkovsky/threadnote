import {readFileSync} from 'node:fs';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Clock, Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  applyBenchmarkOverlay,
  CODE_GRAPH_SQLITE_WRITER_PROFILES,
  codeGraphStructuralParityEvidence,
  codeGraphStructuralParityFailureMessage,
  codeGraphStructuralDigestSymbolLookupStatement,
  decodeBenchmarkSource,
  externalBenchmarkPlatformSupported,
  measureBenchmarkIndex,
  measureSampledBenchmarkIndex,
  parseCodeGraphBenchmarkArguments,
  restoreBenchmarkOverlay,
  sanitizedBenchmarkEnvironmentProvenance,
  semanticBenchmarkOverlay,
  sqliteStructuralGraphEvidence,
  validateSqliteWriterSettingsEvidence,
} from '../../scripts/benchmark-code-graph.js';
import type {CodeGraphBenchmarkSamplerArtifact} from '../../scripts/code-graph-benchmark-sampler.js';
import {codeGraphAnalysisLimitsForView} from '../../src/code_graph/analysis_render.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import type {RepositoryIdentity} from '../../src/code_graph/types.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

const CONTROL = JSON.stringify({
  expectedLanguage: 'typescript',
  expectedPath: 'src/index.ts',
  query: 'indexSymbol',
});

describe('code graph external benchmark harness', () => {
  it('keeps whole-graph performance analysis on the persisted summary path', () => {
    const source = readFileSync('scripts/benchmark-code-graph.ts', 'utf8');
    expect(source).toContain("limits: codeGraphAnalysisLimitsForView('stats')");
    expect(source).toContain("result.coverage.topology.state !== 'not-requested'");
    expect(source).toContain('result.usage.edgeVisits !== 0');
    expect(codeGraphAnalysisLimitsForView('stats')).toEqual({
      communities: 0,
      communityMembers: 0,
      components: 0,
      confidenceFindings: 0,
      hubs: 0,
      memberships: 0,
      relationshipGroupMembers: 0,
      relationshipGroups: 0,
      surprisingLinks: 0,
    });
  });

  effectIt.effect('measures only index execution after setup and before cleanup', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      yield* TestClock.adjust(3_000);
      events.push('sampler-ready-and-overlay-applied');

      const measured = yield* measureBenchmarkIndex(() =>
        Effect.gen(function* () {
          events.push('index-started');
          yield* TestClock.adjust(125);
          events.push('index-finished');
          return 'summary';
        }),
      );

      yield* TestClock.adjust(5_000);
      events.push('overlay-restored-and-sampler-stopped');
      const afterCleanup = yield* Clock.currentTimeNanos;

      expect(measured.result).toBe('summary');
      expect(Number(measured.startedAt) / 1_000_000).toBe(3_000);
      expect(Number(measured.finishedAt - measured.startedAt) / 1_000_000).toBe(125);
      expect(Number(afterCleanup - measured.finishedAt) / 1_000_000).toBe(5_000);
      expect(measured.timeline.duration('start', 'finish')).toBe(125);
      expect(events).toEqual([
        'sampler-ready-and-overlay-applied',
        'index-started',
        'index-finished',
        'overlay-restored-and-sampler-stopped',
      ]);
    }),
  );

  effectIt.effect('samples only index work between overlay setup and restore', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const telemetry = {} as CodeGraphBenchmarkSamplerArtifact;
      const sampled = yield* Effect.acquireUseRelease(
        Effect.sync(() => events.push('overlay-applied')),
        () =>
          Effect.gen(function* () {
            const result = yield* measureSampledBenchmarkIndex(
              Effect.sync(() => {
                events.push('sampler-started');
                return {
                  mark: () => Effect.void,
                  stop: () =>
                    Effect.sync(() => {
                      events.push('sampler-stopped');
                      return telemetry;
                    }),
                };
              }),
              () =>
                Effect.gen(function* () {
                  events.push('index-started');
                  yield* TestClock.adjust(125);
                  events.push('index-finished');
                  return 'summary';
                }),
              Effect.sync(() => events.push('final-index-storage-sampled')),
            );
            events.push('post-index-control');
            return result;
          }),
        () => Effect.sync(() => events.push('overlay-restored')),
      );

      expect(sampled.measurement.result).toBe('summary');
      expect(sampled.telemetry).toBe(telemetry);
      expect(Number(sampled.measurement.finishedAt - sampled.measurement.startedAt) / 1_000_000).toBe(125);
      expect(events).toEqual([
        'overlay-applied',
        'sampler-started',
        'index-started',
        'index-finished',
        'final-index-storage-sampled',
        'sampler-stopped',
        'post-index-control',
        'overlay-restored',
      ]);
    }),
  );

  effectIt.effect('aborts the sampler before restoring an overlay when indexing fails', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const telemetry = {} as CodeGraphBenchmarkSamplerArtifact;
      const exit = yield* Effect.exit(
        Effect.acquireUseRelease(
          Effect.sync(() => events.push('overlay-applied')),
          () =>
            measureSampledBenchmarkIndex(
              Effect.sync(() => {
                events.push('sampler-started');
                return {
                  mark: () => Effect.void,
                  stop: state =>
                    Effect.sync(() => {
                      events.push(`sampler-stopped:${state}`);
                      return telemetry;
                    }),
                };
              }),
              () => Effect.fail(new Error('index failed')),
              Effect.sync(() => events.push('final-index-storage-sampled')),
            ),
          () => Effect.sync(() => events.push('overlay-restored')),
        ),
      );

      expect(exit._tag).toBe('Failure');
      expect(events).toEqual(['overlay-applied', 'sampler-started', 'sampler-stopped:aborted', 'overlay-restored']);
    }),
  );

  it('wires all three index phases through the phase-pure sampler boundary', () => {
    const source = readFileSync('scripts/benchmark-code-graph.ts', 'utf8');
    const cold = sourceSlice(source, 'const coldStoragePeak', 'const changedPath');
    const incremental = sourceSlice(source, 'const incrementalStoragePeak', 'const sameOverlayReferenceHome');
    const sameOverlay = sourceSlice(source, 'const sameOverlayReferenceStoragePeak', 'const coldStatusStarted');

    expectInOrder(cold, [
      "runCheckpoint?.mark('cold-index')",
      'measureSampledBenchmarkIndex(',
      'const coldExternalTelemetry',
      'const coldExternalQueryControls',
    ]);
    expectInOrder(incremental, [
      'applyBenchmarkOverlay(',
      'measureSampledBenchmarkIndex(',
      'restoreBenchmarkOverlay(',
      'const incrementalExternalTelemetry',
      'const incrementalExternalQueryControls',
    ]);
    expectInOrder(sameOverlay, [
      'process.env.SQLITE_TMPDIR = sameOverlaySqliteTemporaryRoot',
      'applyBenchmarkOverlay(',
      'measureSampledBenchmarkIndex(',
      'const controls',
      'restoreBenchmarkOverlay(',
      'const sameOverlayReferenceTelemetry',
    ]);
    expect(source).not.toContain('const coldStarted = yield* Clock.currentTimeNanos');
    expect(source).not.toContain('const incrementalStarted = yield* Clock.currentTimeNanos');
    expect(source).not.toContain('const sameOverlayReferenceStarted = yield* Clock.currentTimeNanos');
  });

  it('retains privacy-safe structural parity evidence before a failed external run exits', () => {
    const source = readFileSync('scripts/benchmark-code-graph.ts', 'utf8');
    const parity = sourceSlice(
      source,
      'const structuralGraphParityEvidence = codeGraphStructuralParityEvidence(',
      'const coldLanguageCounts',
    );

    expectInOrder(parity, [
      'if (!structuralGraphParityEvidence.parity)',
      '.structural-parity.json',
      'JSON.stringify(structuralGraphParityEvidence',
      'codeGraphStructuralParityFailureMessage(structuralGraphParityEvidence)',
    ]);
  });

  it('accepts explicit retained homes and a validation-only preflight', () => {
    const parsed = parseCodeGraphBenchmarkArguments([
      '--repository',
      '/tmp/public-repository',
      '--incremental-path',
      'src/index.ts',
      '--control',
      CONTROL,
      '--output',
      '/tmp/evidence.json',
      '--home',
      '/tmp/primary-home',
      '--reference-home',
      '/tmp/reference-home',
      '--retain-homes',
      '--minimum-free-gib',
      '140',
      '--preflight',
    ]);

    expect(parsed).toMatchObject({
      homePath: '/tmp/primary-home',
      minimumFreeGiB: 140,
      preflight: true,
      referenceHomePath: '/tmp/reference-home',
      retainHomes: true,
    });
  });

  it('selects explicit SQLite writer candidates without exposing production environment knobs', () => {
    for (const profile of Object.keys(CODE_GRAPH_SQLITE_WRITER_PROFILES)) {
      expect(parseCodeGraphBenchmarkArguments(['--sqlite-writer-profile', profile]).sqliteWriterProfile).toBe(profile);
    }
    expect(() => parseCodeGraphBenchmarkArguments(['--sqlite-writer-profile', 'unknown'])).toThrow(
      'Unknown SQLite writer benchmark profile',
    );
    expect(() =>
      parseCodeGraphBenchmarkArguments(['--sqlite-writer-profile', 'cache-256m', '--fail-on-budget']),
    ).toThrow('cannot use production budgets');
    expect(
      parseCodeGraphBenchmarkArguments(['--materialization-transaction-batches', '1'])
        .materializationTransactionBatchLimit,
    ).toBe(1);
    expect(
      parseCodeGraphBenchmarkArguments(['--materialization-transaction-batches', '4'])
        .materializationTransactionBatchLimit,
    ).toBe(4);
    expect(() => parseCodeGraphBenchmarkArguments(['--materialization-transaction-batches', '2'])).toThrow(
      'must be 1 or 4',
    );
  });

  it('requires effective PRAGMA readback and FULL-after-NORMAL publication ordering', () => {
    const connection = (benchmarkPhase: 'cold' | 'one-file-reindex' | 'same-overlay-reference') => ({
      benchmarkPhase,
      cacheSizePragma: -64 * 1_024,
      journalMode: 'wal',
      mmapSizeBytes: 0,
      phase: 'connection' as const,
      synchronous: 2,
      walAutoCheckpointPages: 1_000,
    });
    const evidence = [
      connection('cold'),
      {...connection('cold'), phase: 'building' as const, synchronous: 1},
      {...connection('cold'), phase: 'publication' as const},
      connection('one-file-reindex'),
      connection('same-overlay-reference'),
      {...connection('same-overlay-reference'), phase: 'building' as const, synchronous: 1},
      {...connection('same-overlay-reference'), phase: 'publication' as const},
    ];

    expect(() => validateSqliteWriterSettingsEvidence('building-normal-full-publication', evidence)).not.toThrow();
    expect(() =>
      validateSqliteWriterSettingsEvidence(
        'building-normal-full-publication',
        evidence.filter(settings => settings.phase !== 'publication'),
      ),
    ).toThrow('did not restore FULL after NORMAL');
    expect(() =>
      validateSqliteWriterSettingsEvidence('current', [
        ...evidence.filter(settings => settings.phase === 'connection').slice(0, 2),
        {...connection('same-overlay-reference'), walAutoCheckpointPages: 8_192},
      ]),
    ).toThrow('did not apply its WAL checkpoint cadence');
  });

  it('rejects retention without two explicit fresh home paths', () => {
    expect(() =>
      parseCodeGraphBenchmarkArguments([
        '--repository',
        '/tmp/public-repository',
        '--incremental-path',
        'src/index.ts',
        '--control',
        CONTROL,
        '--output',
        '/tmp/evidence.json',
        '--retain-homes',
      ]),
    ).toThrow('--retain-homes requires explicit --home and --reference-home paths');
  });

  it.each([
    ['source.ts', "import 'threadnote-benchmark-overlay';"],
    ['source.cjs', "require('threadnote-benchmark-overlay');"],
    ['Source.java', 'import threadnote.benchmark.Overlay;'],
    ['source.kt', 'import threadnote.benchmark.overlay'],
    ['source.swift', 'import ThreadnoteBenchmarkOverlay'],
    ['source.go', 'import _ "threadnote/benchmark/overlay"'],
    ['source.rs', 'use threadnote_benchmark_overlay as _;'],
    ['source.cpp', '#include <threadnote_benchmark_overlay.h>'],
    ['source.py', '__import__("threadnote_benchmark_overlay")'],
    ['BUILD.bazel', 'load("@threadnote_benchmark_overlay//:defs.bzl", "threadnote_benchmark_overlay")'],
    ['MODULE.bazel', 'load("@threadnote_benchmark_overlay//:defs.bzl", "threadnote_benchmark_overlay")'],
    ['rules.bzl', 'load("@threadnote_benchmark_overlay//:defs.bzl", "threadnote_benchmark_overlay")'],
  ])('adds a structural dependency to %s without declaring a benchmark symbol', (path, dependency) => {
    const overlaid = semanticBenchmarkOverlay(path, 'original');
    expect(overlaid).toContain(dependency);
    expect(overlaid).not.toContain('threadnoteBenchmarkOverlaySymbol');
    expect(overlaid).toContain('original');
  });

  it('preserves CRLF and inserts Java imports after the package declaration', () => {
    const overlaid = semanticBenchmarkOverlay('Source.java', 'package example;\r\n\r\nfinal class Source {}\r\n');
    expect(overlaid).toBe('package example;\r\nimport threadnote.benchmark.Overlay;\r\n\r\nfinal class Source {}\r\n');
    expect(overlaid.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('rejects unsupported benchmark platforms before external evidence work starts', () => {
    expect(externalBenchmarkPlatformSupported('darwin')).toBe(true);
    expect(externalBenchmarkPlatformSupported('linux')).toBe(true);
    expect(externalBenchmarkPlatformSupported('win32')).toBe(false);
    expect(externalBenchmarkPlatformSupported('freebsd')).toBe(false);
  });

  it('redacts path-valued and semantic runner metadata while normalizing bounded controls', () => {
    const provenance = sanitizedBenchmarkEnvironmentProvenance({
      SQLITE_TMPDIR: '/private/customer/repository/sqlite-temp',
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'denyskashkovskyi-macbook',
      THREADNOTE_BENCHMARK_RUNNER_ID: 'denyskashkovskyi-macbook',
      THREADNOTE_CODE_GRAPH_PARSER_IDLE_TIMEOUT_MS: '99999999',
      THREADNOTE_CODE_GRAPH_PARSER_TIMEOUT_MS: '2500',
      THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '99',
    });

    expect(provenance).toMatchObject({
      SQLITE_TMPDIR: 'configured-path-redacted',
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'other',
      THREADNOTE_CODE_GRAPH_PARSER_IDLE_TIMEOUT_MS: '3600000',
      THREADNOTE_CODE_GRAPH_PARSER_TIMEOUT_MS: '2500',
      THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '8',
    });
    expect(provenance.THREADNOTE_BENCHMARK_RUNNER_ID).toMatch(/^runner-[0-9a-f]{16}$/);
    expect(JSON.stringify(provenance)).not.toContain('denyskashkovskyi');
    expect(JSON.stringify(provenance)).not.toContain('/Users/private');
    expect(JSON.stringify(provenance)).not.toContain('/private/customer');
  });

  it('projects only coarse hosted runner classes and always pseudonymizes explicit runner ids', () => {
    expect(
      sanitizedBenchmarkEnvironmentProvenance({
        THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-ubuntu-24.04-X64',
        THREADNOTE_BENCHMARK_RUNNER_ID: 'safe-looking-hostname',
      }),
    ).toMatchObject({
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-linux-x64',
      THREADNOTE_BENCHMARK_RUNNER_ID: expect.stringMatching(/^runner-[0-9a-f]{16}$/),
    });
  });

  it('applies and restores the overlay byte-for-byte while preserving concurrent edits', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-benchmark-overlay-test-'});
          const file = path.join(root, 'source.ts');
          const original = new TextEncoder().encode('\uFEFFexport const source = 1;\r\n');
          const overlay = new TextEncoder().encode(
            semanticBenchmarkOverlay('source.ts', decodeBenchmarkSource(original)),
          );
          const concurrent = new TextEncoder().encode('export const userEdit = true;\n');

          yield* fs.writeFile(file, original);
          yield* applyBenchmarkOverlay(fs, file, original, overlay);
          const applied = yield* fs.readFile(file);
          yield* restoreBenchmarkOverlay(fs, file, overlay, original);
          const restored = yield* fs.readFile(file);

          yield* fs.writeFile(file, concurrent);
          const applyConflict = yield* Effect.exit(applyBenchmarkOverlay(fs, file, original, overlay));
          const afterApplyConflict = yield* fs.readFile(file);

          yield* fs.writeFile(file, original);
          yield* applyBenchmarkOverlay(fs, file, original, overlay);
          yield* fs.writeFile(file, concurrent);
          const restoreConflict = yield* Effect.exit(restoreBenchmarkOverlay(fs, file, overlay, original));
          const afterRestoreConflict = yield* fs.readFile(file);

          return {
            afterApplyConflict,
            afterRestoreConflict,
            applied,
            applyConflict: applyConflict._tag,
            restored,
            restoreConflict: restoreConflict._tag,
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect([...result.applied]).toEqual([
      ...new TextEncoder().encode("\uFEFFimport 'threadnote-benchmark-overlay';\r\nexport const source = 1;\r\n"),
    ]);
    expect([...result.restored]).toEqual([...new TextEncoder().encode('\uFEFFexport const source = 1;\r\n')]);
    expect(result.applyConflict).toBe('Failure');
    expect(result.restoreConflict).toBe('Failure');
    expect([...result.afterApplyConflict]).toEqual([...new TextEncoder().encode('export const userEdit = true;\n')]);
    expect([...result.afterRestoreConflict]).toEqual([...new TextEncoder().encode('export const userEdit = true;\n')]);
  });

  it('rejects non-UTF-8 overlay sources without lossy replacement', () => {
    expect(() => decodeBenchmarkSource(Uint8Array.from([0xc3, 0x28]))).toThrow('valid UTF-8');
  });

  it('rejects non-source incremental overlays', () => {
    expect(() => semanticBenchmarkOverlay('fixtures/data.json', '{}')).toThrow(
      'incremental benchmark path must use a supported source language',
    );
  });

  it('retains changed-file symbol lookups while invalidating changed-file aliases', () => {
    const rows = structuralDigestLookupRows({
      base: [
        lookupRow('alias-changed', 'alias-changed', 'alias', 'src/index.ts'),
        lookupRow('alias-null', 'alias-null', 'alias'),
        lookupRow('alias-unchanged', 'alias-unchanged', 'alias', 'src/other.ts'),
        lookupRow('deleted-symbol', 'deleted-symbol', 'symbol', 'src/index.ts'),
        lookupRow('overridden', 'overridden', 'symbol', 'src/index.ts'),
        lookupRow('symbol-changed', 'symbol-changed', 'symbol', 'src/index.ts'),
      ],
      changedPaths: ['src/index.ts'],
      current: [lookupRow('overridden', 'overridden', 'alias', 'src/current.ts')],
      deletedSymbolIds: ['deleted-symbol'],
    });

    expect(rows).toEqual([
      lookupRow('alias-null', 'alias-null', 'alias'),
      lookupRow('alias-unchanged', 'alias-unchanged', 'alias', 'src/other.ts'),
      lookupRow('overridden', 'overridden', 'alias', 'src/current.ts'),
      lookupRow('symbol-changed', 'symbol-changed', 'symbol', 'src/index.ts'),
    ]);
  });

  it('matches the persisted-delta lookup model for randomized changed paths and overrides', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(lookupRowArbitrary, {selector: row => `${row.lookup_key}\0${row.symbol_id}`}),
        fc.uniqueArray(lookupRowArbitrary, {selector: row => `${row.lookup_key}\0${row.symbol_id}`}),
        fc.uniqueArray(fc.constantFrom(...LOOKUP_PATHS)),
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/)),
        (base, current, changedPaths, deletedSymbolIds) => {
          const actual = structuralDigestLookupRows({base, changedPaths, current, deletedSymbolIds});
          const currentKeys = new Set(current.map(row => `${row.lookup_key}\0${row.symbol_id}`));
          const deleted = new Set(deletedSymbolIds);
          const changed = new Set(changedPaths);
          const expected = [
            ...current,
            ...base.filter(
              row =>
                !currentKeys.has(`${row.lookup_key}\0${row.symbol_id}`) &&
                !deleted.has(row.symbol_id) &&
                (row.provenance === 'symbol' || row.evidence_path === undefined || !changed.has(row.evidence_path)),
            ),
          ].sort(compareLookupRows);
          expect(actual).toEqual(expected);
        },
      ),
      {numRuns: 100},
    );
  });

  effectIt.effect('holds a real snapshot lease and one WAL read snapshot across promotion and cleanup', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-structural-digest-interlock-'});
          const databasePath = path.join(root, 'graph-v3.sqlite');
          const identity: RepositoryIdentity = {
            caseMode: 'sensitive',
            checkoutId: 'c'.repeat(64),
            displayName: 'structural-digest-fixture',
            gitCommonDirectory: root,
            headCommit: '1'.repeat(40),
            objectFormat: 'sha1',
            repoRoot: root,
            repositoryId: 'r'.repeat(64),
            worktreeId: 'w'.repeat(64),
          };
          const baseSnapshotId = `cgsn_${'0'.repeat(40)}`;
          const firstSnapshotId = `cgsn_${'1'.repeat(40)}`;
          const replacementSnapshotId = `cgsn_${'2'.repeat(40)}`;
          const privatePath = 'src/private-customer-secret.ts';

          yield* store.initialize(databasePath);
          seedStructuralDigestInterlockDatabase(
            databasePath,
            identity,
            baseSnapshotId,
            firstSnapshotId,
            replacementSnapshotId,
            privatePath,
          );
          yield* store.promote(databasePath, identity, firstSnapshotId);
          const before = yield* sqliteStructuralGraphEvidence(databasePath, firstSnapshotId);
          const replacementWriter = new Database(databasePath, {strict: true});
          try {
            replacementWriter
              .query("UPDATE snapshots SET state = 'ready' WHERE id = ? AND state = 'building'")
              .run(replacementSnapshotId);
          } finally {
            replacementWriter.close(false);
          }
          let during = {
            activeSnapshotId: '',
            baseFileRows: 0,
            baseState: '',
            firstState: '',
            leaseRows: 0,
          };
          let leaseRenewals = 0;
          let comparisonLease: string | undefined;
          const pinned = yield* sqliteStructuralGraphEvidence(databasePath, firstSnapshotId, {
            onReadTransactionStarted: Effect.gen(function* () {
              yield* store.promote(databasePath, identity, replacementSnapshotId);
              yield* store.pruneRetiredSnapshots(databasePath);
              // Lease release now retires a superseded view automatically. Hold
              // a second reader lease so this test can intentionally compare
              // the post-write digest after the pinned read transaction ends.
              comparisonLease = yield* store.acquireSnapshotLease(databasePath, firstSnapshotId, 60_000);
              const writer = new Database(databasePath, {strict: true});
              try {
                writer.run('PRAGMA busy_timeout = 5000');
                writer.query('UPDATE snapshots SET commit_id = ? WHERE id = ?').run('3'.repeat(40), firstSnapshotId);
                during = structuralDigestInterlockState(writer, baseSnapshotId, firstSnapshotId, identity.worktreeId);
              } finally {
                writer.close(false);
              }
              yield* Effect.sleep(125);
            }),
            onSnapshotLeaseRenewed: Effect.sync(() => {
              leaseRenewals += 1;
            }),
            snapshotLeaseRenewalMilliseconds: 100,
          });
          const after = yield* sqliteStructuralGraphEvidence(databasePath, firstSnapshotId);
          if (comparisonLease === undefined) return yield* Effect.die(new Error('Comparison lease was not acquired.'));
          yield* store.releaseSnapshotLease(databasePath, comparisonLease);
          const mismatch = codeGraphStructuralParityEvidence(before, after);
          const failureMessage = codeGraphStructuralParityFailureMessage(mismatch);
          yield* store.pruneRetiredSnapshots(databasePath);
          const finalDatabase = new Database(databasePath, {readonly: true, strict: true});
          try {
            const protectedSnapshotRows = Number(
              (
                finalDatabase
                  .query('SELECT COUNT(*) AS count FROM snapshots WHERE id IN (?, ?)')
                  .get(baseSnapshotId, firstSnapshotId) as {readonly count: number}
              ).count,
            );
            const leaseRows = Number(
              (finalDatabase.query('SELECT COUNT(*) AS count FROM snapshot_leases').get() as {readonly count: number})
                .count,
            );
            return {
              after,
              before,
              during,
              failureMessage,
              leaseRows,
              mismatch,
              leaseRenewals,
              pinned,
              privacySafeEvidence: JSON.stringify(mismatch),
              privatePath,
              protectedSnapshotRows,
            };
          } finally {
            finalDatabase.close(false);
          }
        }),
      ).pipe(Effect.provide(ApplicationLayer));

      expect(result.pinned).toEqual(result.before);
      expect(result.before.streams.find(stream => stream.name === 'symbol-terms')?.rowCount).toBe(1);
      expect(result.after.digest).not.toBe(result.before.digest);
      expect(result.during).toEqual({
        activeSnapshotId: `cgsn_${'2'.repeat(40)}`,
        baseFileRows: 1,
        baseState: 'ready',
        firstState: 'ready',
        leaseRows: 2,
      });
      expect(result.mismatch.mismatchedStreams.map(stream => stream.name)).toEqual(['snapshot']);
      expect(result.leaseRenewals).toBeGreaterThanOrEqual(1);
      expect(result.failureMessage).toMatch(
        /^Structural graph digest parity failed: snapshot incremental\(count=1,sha256=[0-9a-f]{64}\) same-overlay-full\(count=1,sha256=[0-9a-f]{64}\)\.$/,
      );
      expect(result.privacySafeEvidence).not.toContain(result.privatePath);
      expect(result.privacySafeEvidence).not.toContain('3'.repeat(40));
      expect(result.failureMessage).not.toContain(result.privatePath);
      expect(result.protectedSnapshotRows).toBe(1);
      expect(result.leaseRows).toBe(0);
    }).pipe(TestClock.withLive),
  );
});

const LOOKUP_PATHS = ['src/a.ts', 'src/b.ts', 'src/c.ts'] as const;

interface StructuralLookupRow {
  readonly evidence_edge_id?: string;
  readonly evidence_path?: string;
  readonly exported: number;
  readonly lookup_key: string;
  readonly provenance: 'alias' | 'symbol';
  readonly resolution_domain: string;
  readonly symbol_id: string;
}

const lookupRowArbitrary = fc.record({
  evidence_edge_id: fc.option(fc.stringMatching(/^[a-z]{1,6}$/), {nil: undefined}),
  evidence_path: fc.option(fc.constantFrom(...LOOKUP_PATHS), {nil: undefined}),
  exported: fc.integer({max: 1, min: 0}),
  lookup_key: fc.stringMatching(/^[a-z]{1,6}$/),
  provenance: fc.constantFrom('alias' as const, 'symbol' as const),
  resolution_domain: fc.constantFrom('global', 'typescript'),
  symbol_id: fc.stringMatching(/^[a-z]{1,6}$/),
}) satisfies fc.Arbitrary<StructuralLookupRow>;

function lookupRow(
  lookupKey: string,
  symbolId: string,
  provenance: StructuralLookupRow['provenance'],
  evidencePath?: string,
): StructuralLookupRow {
  return {
    ...(evidencePath === undefined ? {} : {evidence_path: evidencePath}),
    exported: 1,
    lookup_key: lookupKey,
    provenance,
    resolution_domain: 'typescript',
    symbol_id: symbolId,
  };
}

function structuralDigestLookupRows(input: {
  readonly base: readonly StructuralLookupRow[];
  readonly changedPaths: readonly string[];
  readonly current: readonly StructuralLookupRow[];
  readonly deletedSymbolIds: readonly string[];
}): readonly StructuralLookupRow[] {
  const database = new Database(':memory:', {strict: true});
  try {
    database.run(`CREATE TABLE snapshot_symbol_lookup (
      snapshot_id TEXT NOT NULL,
      lookup_key TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      evidence_edge_id TEXT,
      evidence_path TEXT,
      PRIMARY KEY (snapshot_id, lookup_key, symbol_id)
    ) WITHOUT ROWID`);
    database.run(`CREATE TABLE snapshot_symbol_deletions (
      snapshot_id TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, symbol_id)
    ) WITHOUT ROWID`);
    database.run(`CREATE TABLE snapshot_files (
      snapshot_id TEXT NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID`);
    const insertLookup = database.query(`INSERT INTO snapshot_symbol_lookup (
      snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
      provenance, evidence_edge_id, evidence_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [snapshotId, rows] of [
      ['base', input.base],
      ['current', input.current],
    ] as const) {
      for (const row of rows) {
        insertLookup.run(
          snapshotId,
          row.lookup_key,
          row.symbol_id,
          row.resolution_domain,
          row.exported,
          row.provenance,
          row.evidence_edge_id ?? null,
          row.evidence_path ?? null,
        );
      }
    }
    const insertChanged = database.query('INSERT INTO snapshot_files (snapshot_id, path) VALUES (?, ?)');
    for (const changedPath of input.changedPaths) insertChanged.run('current', changedPath);
    const insertDeleted = database.query(
      'INSERT INTO snapshot_symbol_deletions (snapshot_id, symbol_id) VALUES (?, ?)',
    );
    for (const symbolId of new Set(input.deletedSymbolIds)) insertDeleted.run('current', symbolId);
    const statement = codeGraphStructuralDigestSymbolLookupStatement('current', 'base');
    return (database.query(statement.text).all(...statement.parameters) as StructuralLookupRow[]).map(row => ({
      ...(row.evidence_edge_id === null ? {} : {evidence_edge_id: row.evidence_edge_id}),
      ...(row.evidence_path === null ? {} : {evidence_path: row.evidence_path}),
      exported: Number(row.exported),
      lookup_key: row.lookup_key,
      provenance: row.provenance,
      resolution_domain: row.resolution_domain,
      symbol_id: row.symbol_id,
    }));
  } finally {
    database.close(false);
  }
}

function compareLookupRows(left: StructuralLookupRow, right: StructuralLookupRow): number {
  return left.lookup_key.localeCompare(right.lookup_key) || left.symbol_id.localeCompare(right.symbol_id);
}

function sourceSlice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function expectInOrder(source: string, markers: readonly string[]): void {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    expect(next, `missing or out-of-order benchmark marker: ${marker}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

function seedStructuralDigestInterlockDatabase(
  databasePath: string,
  identity: RepositoryIdentity,
  baseSnapshotId: string,
  firstSnapshotId: string,
  replacementSnapshotId: string,
  privatePath: string,
): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const now = new Date().toISOString();
    database.run('PRAGMA foreign_keys = ON');
    database
      .query(
        `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(identity.repositoryId, identity.displayName, identity.objectFormat, now, now);
    const insertSnapshot = database.query(
      `INSERT INTO snapshots (
        id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set, dirty, state,
        file_count, symbol_count, edge_count, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 'ready', ?, 0, 0, ?, ?)`,
    );
    insertSnapshot.run(
      baseSnapshotId,
      identity.repositoryId,
      identity.worktreeId,
      identity.headCommit,
      null,
      'benchmark-digest-test',
      1,
      now,
      now,
    );
    insertSnapshot.run(
      firstSnapshotId,
      identity.repositoryId,
      identity.worktreeId,
      identity.headCommit,
      baseSnapshotId,
      'benchmark-digest-test',
      1,
      now,
      now,
    );
    insertSnapshot.run(
      replacementSnapshotId,
      identity.repositoryId,
      identity.worktreeId,
      identity.headCommit,
      null,
      'benchmark-digest-test',
      0,
      now,
      now,
    );
    database.query("UPDATE snapshots SET state = 'building' WHERE id = ?").run(replacementSnapshotId);
    const minimum = database
      .query(
        "SELECT CAST(value AS INTEGER) AS generation FROM schema_metadata WHERE key = 'minimum_extractor_generation'",
      )
      .get() as {readonly generation: number};
    const insertGeneration = database.query(
      'INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)',
    );
    insertGeneration.run(baseSnapshotId, minimum.generation);
    insertGeneration.run(firstSnapshotId, minimum.generation);
    insertGeneration.run(replacementSnapshotId, minimum.generation);
    database
      .query(
        `INSERT INTO snapshot_files (
          snapshot_id, path, content_hash, language, mode, size, source
        ) VALUES (?, ?, ?, 'typescript', '100644', 32, 'commit')`,
      )
      .run(baseSnapshotId, privatePath, 'f'.repeat(64));
    database.query('INSERT INTO lexical_compact_snapshots (snapshot_id) VALUES (?)').run(baseSnapshotId);
    const lexicalSnapshot = database
      .query('SELECT snapshot_key FROM lexical_compact_snapshots WHERE snapshot_id = ?')
      .get(baseSnapshotId) as {readonly snapshot_key: number};
    database
      .query('INSERT INTO lexical_compact_terms (snapshot_key, term) VALUES (?, ?)')
      .run(lexicalSnapshot.snapshot_key, 'private');
    database
      .query('INSERT INTO lexical_compact_symbols (snapshot_key, symbol_id) VALUES (?, ?)')
      .run(lexicalSnapshot.snapshot_key, 'private-symbol');
    const lexicalTerm = database
      .query('SELECT term_key FROM lexical_compact_terms WHERE snapshot_key = ?')
      .get(lexicalSnapshot.snapshot_key) as {readonly term_key: number};
    const lexicalSymbol = database
      .query('SELECT symbol_key FROM lexical_compact_symbols WHERE snapshot_key = ?')
      .get(lexicalSnapshot.snapshot_key) as {readonly symbol_key: number};
    database
      .query(
        `INSERT INTO lexical_compact_postings (snapshot_key, term_key, symbol_key, weight)
         VALUES (?, ?, ?, ?)`,
      )
      .run(lexicalSnapshot.snapshot_key, lexicalTerm.term_key, lexicalSymbol.symbol_key, 3);
    database
      .query(
        `INSERT INTO lexical_storage_formats (
          snapshot_id, format_version, posting_count, symbol_count, term_count, created_at
        ) VALUES (?, 1, 1, 1, 1, ?)`,
      )
      .run(baseSnapshotId, now);
  } finally {
    database.close(false);
  }
}

function structuralDigestInterlockState(
  database: Database,
  baseSnapshotId: string,
  firstSnapshotId: string,
  worktreeId: string,
): {
  readonly activeSnapshotId: string;
  readonly baseFileRows: number;
  readonly baseState: string;
  readonly firstState: string;
  readonly leaseRows: number;
} {
  const state = database
    .query(
      `SELECT
        (SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?) AS active_snapshot_id,
        (SELECT COUNT(*) FROM snapshot_files WHERE snapshot_id = ?) AS base_file_rows,
        (SELECT state FROM snapshots WHERE id = ?) AS base_state,
        (SELECT state FROM snapshots WHERE id = ?) AS first_state,
        (SELECT COUNT(*) FROM snapshot_leases WHERE snapshot_id = ?) AS lease_rows`,
    )
    .get(worktreeId, baseSnapshotId, baseSnapshotId, firstSnapshotId, firstSnapshotId) as {
    readonly active_snapshot_id: string;
    readonly base_file_rows: number;
    readonly base_state: string;
    readonly first_state: string;
    readonly lease_rows: number;
  };
  return {
    activeSnapshotId: state.active_snapshot_id,
    baseFileRows: Number(state.base_file_rows),
    baseState: state.base_state,
    firstState: state.first_state,
    leaseRows: Number(state.lease_rows),
  };
}
