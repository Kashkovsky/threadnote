import {it as effectIt} from '@effect/vitest';
import {execFileSync} from '../helpers/node-child-process.js';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '../helpers/node-fs.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {Effect, Exit, Layer, Tracer} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import type {SystemInfoShape} from '../../src/effect/system.js';
import {anonymousTelemetryTestLayer} from '../../src/effect/telemetry.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('code graph terminal telemetry wiring', () => {
  effectIt.effect('emits a terminal lifecycle surface for a short detached commit build', () => {
    const capture = capturingTracer();
    const layer = Layer.mergeAll(
      ApplicationLayer,
      anonymousTelemetryTestLayer({system: telemetrySystemInfoStub(), tracer: capture.tracer}),
    );

    return Effect.acquireUseRelease(
      Effect.sync(createRepositoryFixture),
      fixture =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const lease = yield* indexer.ensureCommit({
            commit: fixture.commit,
            cwd: fixture.root,
            threadnoteHome: fixture.home,
          });

          expect(lease.snapshot.commit).toBe(fixture.commit);
          const lifecycle = capture.spans
            .map(span => Object.fromEntries(span.attributes))
            .filter(attributes => attributes['threadnote.event'] === 'lifecycle');
          expect(lifecycle).toHaveLength(1);
          expect(lifecycle[0]).toMatchObject({
            'threadnote.component': 'cli',
            'threadnote.duration_ms': expect.any(Number),
            'threadnote.event': 'lifecycle',
            'threadnote.graph.build_kind': 'clean',
            'threadnote.graph.changed_files_bucket': '0',
            'threadnote.graph.deleted_files_bucket': '0',
            'threadnote.graph.efficiency_class': 'expected-full',
            'threadnote.graph.materialization_mode': 'full',
            'threadnote.graph.resolution_closure': 'full',
            'threadnote.operation': 'graph-build',
            'threadnote.outcome': 'success',
          });
          expect(JSON.stringify(lifecycle)).not.toContain(fixture.root);
        }),
      fixture => Effect.sync(() => rmSync(fixture.root, {force: true, recursive: true})),
    ).pipe(TestClock.withLive, provideTestLayer(layer));
  });

  effectIt.effect('reports the effective two-file delta for a dirty full fallback exactly once', () => {
    const capture = capturingTracer();
    const layer = Layer.mergeAll(
      ApplicationLayer,
      anonymousTelemetryTestLayer({system: telemetrySystemInfoStub(), tracer: capture.tracer}),
    );

    return Effect.acquireUseRelease(
      Effect.sync(createRepositoryFixture),
      fixture =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: fixture.root, threadnoteHome: fixture.home});
          yield* Effect.sync(() => {
            writeFileSync(
              join(fixture.root, 'src', 'value.ts'),
              'export function renamedValue(): number { return 1; }\n',
            );
            writeFileSync(
              join(fixture.root, 'src', 'other.ts'),
              'export const other = 2;\nfunction localCallback(): number { return other; }\nlocalCallback();\n',
            );
          });
          const summary = yield* indexer.index({cwd: fixture.root, threadnoteHome: fixture.home});

          expect(summary.materialization).toMatchObject({
            fallbackReason: 'resolution-surface-changed',
            mode: 'full',
          });
          const lifecycle = capture.spans
            .map(span => Object.fromEntries(span.attributes))
            .filter(attributes => attributes['threadnote.event'] === 'lifecycle');
          expect(lifecycle).toHaveLength(2);
          expect(lifecycle[1]).toMatchObject({
            'threadnote.graph.build_kind': 'dirty',
            'threadnote.graph.changed_fact_bytes_bucket': expect.not.stringMatching(/^0$/u),
            'threadnote.graph.changed_files_bucket': '2^1',
            'threadnote.graph.deleted_files_bucket': '0',
            'threadnote.graph.extracted_files_bucket': '2^1',
            'threadnote.graph.fallback_reason': 'resolution-surface-changed',
            'threadnote.graph.materialization_mode': 'full',
            'threadnote.graph.resolution_closure': 'full',
            'threadnote.operation': 'graph-build',
            'threadnote.outcome': 'success',
          });
          expect(JSON.stringify(lifecycle[1])).not.toContain(fixture.root);
        }),
      fixture => Effect.sync(() => rmSync(fixture.root, {force: true, recursive: true})),
    ).pipe(TestClock.withLive, provideTestLayer(layer));
  });

  effectIt.effect('retains changed-fact bytes when a dirty full fallback is satisfied from cache', () => {
    const capture = capturingTracer();
    const layer = Layer.mergeAll(
      ApplicationLayer,
      anonymousTelemetryTestLayer({system: telemetrySystemInfoStub(), tracer: capture.tracer}),
    );

    return Effect.acquireUseRelease(
      Effect.sync(createRepositoryFixture),
      fixture =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const dirtyContent = 'export function renamedValue(): number { return 1; }\n';
          yield* indexer.index({cwd: fixture.root, threadnoteHome: fixture.home});
          yield* Effect.sync(() => writeFileSync(join(fixture.root, 'src', 'value.ts'), dirtyContent));
          const firstDirty = yield* indexer.index({cwd: fixture.root, threadnoteHome: fixture.home});
          expect(firstDirty.materialization).toMatchObject({
            fallbackReason: 'resolution-surface-changed',
            mode: 'full',
          });

          yield* Effect.sync(() => {
            git(fixture.root, ['checkout', '--', 'src/value.ts']);
            git(fixture.root, ['commit', '--allow-empty', '-qm', 'new clean graph identity']);
          });
          yield* indexer.index({cwd: fixture.root, threadnoteHome: fixture.home});
          yield* Effect.sync(() => writeFileSync(join(fixture.root, 'src', 'value.ts'), dirtyContent));
          const cachedDirty = yield* indexer.index({cwd: fixture.root, threadnoteHome: fixture.home});

          expect(cachedDirty.materialization).toMatchObject({
            fallbackReason: 'resolution-surface-changed',
            mode: 'full',
          });
          expect(cachedDirty.reusedFiles).toBe(cachedDirty.materialization?.totalFiles);
          const lifecycle = capture.spans
            .map(span => Object.fromEntries(span.attributes))
            .filter(attributes => attributes['threadnote.event'] === 'lifecycle');
          expect(lifecycle).toHaveLength(4);
          expect(lifecycle.at(-1)).toMatchObject({
            'threadnote.graph.cached_fact_replay_bytes_bucket': expect.not.stringMatching(/^0$/u),
            'threadnote.graph.changed_fact_bytes_bucket': expect.not.stringMatching(/^0$/u),
            'threadnote.graph.changed_files_bucket': '2^0',
            'threadnote.graph.extracted_files_bucket': '0',
            'threadnote.graph.fallback_reason': 'resolution-surface-changed',
            'threadnote.graph.materialization_mode': 'full',
            'threadnote.outcome': 'success',
          });
          expect(JSON.stringify(lifecycle.at(-1))).not.toContain(fixture.root);
        }),
      fixture => Effect.sync(() => rmSync(fixture.root, {force: true, recursive: true})),
    ).pipe(TestClock.withLive, provideTestLayer(layer));
  });

  effectIt.effect('shares one terminal claim across an automatic worktree-change retry', () => {
    const capture = capturingTracer();
    const layer = Layer.mergeAll(
      ApplicationLayer,
      anonymousTelemetryTestLayer({system: telemetrySystemInfoStub(), tracer: capture.tracer}),
    );

    return Effect.acquireUseRelease(
      Effect.sync(createRepositoryFixture),
      fixture =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          let changedDuringFirstAttempt = false;
          const summary = yield* indexer.index({
            cwd: fixture.root,
            onProgress: progress =>
              progress.phase !== 'materializing' || changedDuringFirstAttempt
                ? Effect.void
                : Effect.sync(() => {
                    changedDuringFirstAttempt = true;
                    writeFileSync(join(fixture.root, 'src', 'other.ts'), 'export const other = 3;\n');
                  }),
            threadnoteHome: fixture.home,
          });

          expect(changedDuringFirstAttempt).toBe(true);
          expect(summary.snapshot.state).toBe('ready');
          const lifecycle = capture.spans
            .map(span => Object.fromEntries(span.attributes))
            .filter(attributes => attributes['threadnote.event'] === 'lifecycle');
          expect(lifecycle).toHaveLength(1);
          expect(lifecycle[0]).toMatchObject({
            'threadnote.event': 'lifecycle',
            'threadnote.operation': 'graph-build',
            'threadnote.outcome': 'success',
          });
        }),
      fixture => Effect.sync(() => rmSync(fixture.root, {force: true, recursive: true})),
    ).pipe(TestClock.withLive, provideTestLayer(layer));
  });
});

function createRepositoryFixture(): {commit: string; home: string; root: string} {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-graph-telemetry-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(join(root, '.gitignore'), '/.threadnote-test-home/\n');
  writeFileSync(join(root, 'package.json'), '{"name":"graph-telemetry-fixture"}\n');
  writeFileSync(join(root, 'src', 'value.ts'), 'export function value(): number { return 1; }\n');
  writeFileSync(join(root, 'src', 'other.ts'), 'export const other = 2;\n');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'threadnote@example.test']);
  git(root, ['config', 'user.name', 'Threadnote Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return {
    commit: git(root, ['rev-parse', 'HEAD']).trim(),
    home: join(root, '.threadnote-test-home'),
    root,
  };
}

function git(cwd: string, arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, {cwd, encoding: 'utf8'});
}

function capturingTracer(): {readonly spans: readonly Tracer.NativeSpan[]; readonly tracer: Tracer.Tracer} {
  const spans: Tracer.NativeSpan[] = [];
  return {
    spans,
    tracer: Tracer.make({
      span(options) {
        return new (class extends Tracer.NativeSpan {
          override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
            super.end(endTime, exit);
            spans.push(this);
          }
        })(options);
      },
    }),
  };
}

function telemetrySystemInfoStub(): SystemInfoShape {
  return {
    architecture: 'arm64',
    availableDiskBytes: () => Effect.succeed(undefined),
    currentDirectory: () => '/',
    environment: () => ({}),
    executablePath: '/opt/threadnote/bin/threadnote',
    hardwareInfo: Effect.succeed({
      cpuModel: 'test',
      effectiveMemoryBytes: 1,
      memoryBytes: 1,
      operatingSystem: 'test',
    }),
    homeDirectory: '/home/test',
    isProcessRunning: () => false,
    memoryUsage: () => ({external: 0, heapUsed: 0, rss: 0}),
    pathDelimiter: ':',
    platform: 'darwin',
    processArguments: ['/opt/threadnote/bin/threadnote'],
    processId: 1,
    processStartIdentity: () => Effect.succeed(undefined),
    readLine: () => () => undefined,
    runtimeVersion: 'test',
    setEnvironmentVariable: () => undefined,
    setExitCode: () => undefined,
    signalProcess: () => undefined,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    tempDirectory: '/tmp',
    userName: 'test',
  };
}
