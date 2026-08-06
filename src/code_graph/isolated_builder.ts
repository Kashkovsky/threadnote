import {Clock, Effect, Option, Path, Ref} from 'effect';
import {fromPromiseError} from '../effect/errors.js';
import {SystemInfo, type SystemInfoShape} from '../effect/system.js';

import {
  CODE_GRAPH_BUILD_HEARTBEAT_INTERVAL_MILLISECONDS,
  CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS,
  currentCodeGraphBuildStatus,
  type CodeGraphBuildStatus,
  type ObservedCodeGraphBuildStatus,
} from './build_status.js';
import {codeGraphLayout} from './layout.js';
import {resolveRepositoryIdentity} from './repository.js';
import type {CodeGraphProgress} from './types.js';

/** Match the child heartbeat cadence so MCP does not oversample process-liveness probes. */
export const BUILD_STATUS_POLL_MILLISECONDS = CODE_GRAPH_BUILD_HEARTBEAT_INTERVAL_MILLISECONDS;
/** Give up awaiting a wedged foreign builder after this much continuous stall. */
export const EXISTING_BUILDER_STALLED_TIMEOUT_MILLISECONDS = CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS * 4;
const STDERR_TAIL_LIMIT_BYTES = 4 * 1024;

export interface CodeGraphIsolatedBuilderSpawnPlan {
  readonly arguments: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly executable: string;
}

export interface CodeGraphIsolatedBuilderProcess {
  readonly exited: Promise<number>;
  readonly kill: () => void;
  readonly processId: number;
  readonly stderrTail?: () => string;
}

export type CodeGraphIsolatedBuilderSpawner = (
  plan: CodeGraphIsolatedBuilderSpawnPlan,
) => CodeGraphIsolatedBuilderProcess | Promise<CodeGraphIsolatedBuilderProcess>;

export interface CodeGraphIsolatedBuilderOptions {
  readonly cwd: string;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void>;
  readonly spawn?: CodeGraphIsolatedBuilderSpawner;
  readonly spawnPlan?: (
    system: SystemInfoShape,
    options: {readonly cwd: string; readonly threadnoteHome: string},
  ) => CodeGraphIsolatedBuilderSpawnPlan;
  readonly threadnoteHome: string;
}

export interface CodeGraphIsolatedBuilderResult {
  readonly edges: number;
  readonly symbols: number;
}

function executableBaseName(executablePath: string): string | undefined {
  return executablePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
}

/** True when this OS process hosts MCP stdio and must not run heavy graph builds in-process. */
export function isCodeGraphIsolatedBuilderHost(
  system: Pick<SystemInfoShape, 'executablePath' | 'processArguments'>,
): boolean {
  const executableName = executableBaseName(system.executablePath);
  if (executableName?.startsWith('threadnote-mcp-server') === true) return true;
  // Mirror src/standalone.ts: user args start at argv[2] for both scripts and compiled binaries.
  return system.processArguments.slice(2)[0] === 'mcp-server';
}

/**
 * Re-invoke the current Threadnote entrypoint as a CLI `graph index` child.
 * Uses `--no-vectors` so MCP watcher refresh matches in-process `ensureVectors: false`.
 * Never targets the MCP launcher; MCP stdio stays free for recall and other tools.
 * Interrupted MCP hosts detach and leave the child running so a later refresh can re-attach.
 */
export function codeGraphIsolatedBuilderSpawnPlan(
  system: SystemInfoShape,
  options: {readonly cwd: string; readonly threadnoteHome: string},
): CodeGraphIsolatedBuilderSpawnPlan {
  const script = developmentStandaloneScript(system);
  return {
    arguments: [
      ...Option.toArray(script),
      '--home',
      options.threadnoteHome,
      'graph',
      'index',
      '--no-vectors',
      '--cwd',
      options.cwd,
    ],
    environment: {
      ...system.environment(),
      THREADNOTE_HOME: options.threadnoteHome,
    },
    executable: system.executablePath,
  };
}

/** Reconstruct MCP-facing progress from the child's privacy-safe build-status sidecar. */
export function codeGraphProgressFromBuildStatus(
  status: Pick<
    CodeGraphBuildStatus,
    'activation' | 'counters' | 'materialization' | 'phase' | 'resolution' | 'subphase' | 'timings'
  >,
): CodeGraphProgress {
  const counters = status.counters;
  switch (status.phase) {
    case 'registering':
      return {phase: 'registering'};
    case 'waiting':
      return {
        phase: 'waiting',
        ...(status.subphase === 'database-writer' ||
        status.subphase === 'repository-lock' ||
        status.subphase === 'request-lock' ||
        status.subphase === 'snapshot-build'
          ? {reason: status.subphase}
          : {}),
      };
    case 'reclaiming':
      return {
        completed: counters.completed ?? 0,
        pagesCompleted: counters.pagesCompleted ?? 0,
        phase: 'reclaiming',
        rowsDeleted: counters.rowsDeleted ?? 0,
        total: counters.total ?? 0,
        unit: 'snapshots',
      };
    case 'scanning':
      return {
        accepted: counters.accepted ?? 0,
        completed: counters.completed ?? 0,
        excluded: counters.excluded ?? 0,
        phase: 'scanning',
        skipped: counters.skipped ?? 0,
        ...(status.timings ? {timings: status.timings} : {}),
        total: counters.total ?? 0,
        unit: 'files',
      };
    case 'materializing': {
      // Strip persisted-only `startedAt`; keep the progress-facing activity fields.
      const activity = status.materialization?.activity;
      return {
        ...(activity
          ? {
              activity: {
                batchCompleted: activity.batchCompleted,
                batchTotal: activity.batchTotal,
                sourceBytes: activity.sourceBytes,
                stage: activity.stage,
              },
            }
          : {}),
        completed: counters.completed ?? 0,
        ...(status.materialization?.metrics ? {metrics: status.materialization.metrics} : {}),
        phase: 'materializing',
        reused: counters.reused ?? 0,
        total: counters.total ?? 0,
        unit: 'files',
      };
    }
    case 'resolving':
      if (status.subphase === 'complete') {
        return {
          edges: counters.edges ?? 0,
          phase: 'resolving',
          resolved: counters.resolved ?? 0,
          subphase: 'complete',
          symbols: counters.symbols ?? 0,
        };
      }
      return {
        ...(status.resolution?.activity ? {activity: omitStartedAt(status.resolution.activity)} : {}),
        phase: 'resolving',
        subphase: 'references',
      };
    case 'activating':
      return {
        ...(status.activation?.activity ? {activity: omitStartedAt(status.activation.activity)} : {}),
        phase: 'activating',
        // Sidecar has no snapshot id until completion; placeholder is not a durable identity.
        snapshotId: 'building',
        ...(status.subphase === 'complete' ||
        status.subphase === 'promoting' ||
        status.subphase === 'summarizing-analysis' ||
        status.subphase === 'validating-input' ||
        status.subphase === 'writing-and-checkpointing'
          ? {subphase: status.subphase}
          : {}),
      };
    case 'embedding':
      return {
        completed: counters.completed ?? 0,
        embedded: counters.embedded ?? 0,
        phase: 'embedding',
        reused: counters.reused ?? 0,
        total: counters.total ?? 0,
        unit: 'symbols',
      };
    default: {
      const _exhaustive: never = status.phase;
      throw new Error(`Unsupported code graph progress phase: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Run `graph index --no-vectors` in a child CLI process and mirror its build-status sidecar.
 * On interruption the child is detached (not killed) so a later MCP refresh can re-attach.
 */
export const runIsolatedCodeGraphIndex = Effect.fn('codeGraph.isolatedBuilder.run')(function* (
  options: CodeGraphIsolatedBuilderOptions,
) {
  const system = yield* SystemInfo;
  const path = yield* Path.Path;
  const identity = yield* resolveRepositoryIdentity(options.cwd);
  const layout = codeGraphLayout(path, options.threadnoteHome, identity.checkoutId, identity.worktreeId);
  const plan = (options.spawnPlan ?? codeGraphIsolatedBuilderSpawnPlan)(system, {
    cwd: identity.repoRoot,
    threadnoteHome: options.threadnoteHome,
  });
  yield* assertIsolatedBuilderPlanEffect(plan);

  const readStatus = currentCodeGraphBuildStatus(layout, identity.worktreeId);
  const existing = yield* readStatus;
  if (shouldAwaitExistingBuilder(existing, system.processId)) {
    return yield* awaitExistingBuilder(readStatus, options.onProgress);
  }

  const priorBuildId = existing?.buildId;
  const spawn = options.spawn ?? spawnIsolatedBuilderProcess;
  // Detach on interruption: do not kill multi-hour builds when the MCP host goes idle or reconnects.
  const child = yield* fromPromiseError(() => Promise.resolve(spawn(plan)));

  const exitCode = yield* Effect.raceFirst(
    fromPromiseError(() => child.exited),
    mirrorBuildStatusProgress(readStatus, child.processId, priorBuildId, options.onProgress),
  );

  if (exitCode !== 0) {
    const failed = yield* statusOwnedBy(readStatus, child.processId, priorBuildId);
    return yield* Effect.fail(
      new Error(isolatedBuilderFailureMessage(exitCode, failed?.error?.summary, child.stderrTail?.())),
    );
  }

  const completed = yield* statusOwnedBy(readStatus, child.processId, priorBuildId);
  return yield* isolatedBuilderResultFromCompletedStatus(completed);
});

/** @internal Pure exit/result contract for unit tests. */
export function isolatedBuilderFailureMessage(
  exitCode: number,
  errorSummary: string | undefined,
  stderrTail: string | undefined,
): string {
  if (errorSummary) return errorSummary;
  const stderr = stderrTail?.trim();
  if (stderr) return `isolated graph index exited with code ${exitCode}: ${stderr.slice(0, 500)}`;
  return `isolated graph index exited with code ${exitCode}`;
}

/** @internal Pure success contract for unit tests. */
export function isolatedBuilderResultFromCompletedStatus(
  status: Pick<ObservedCodeGraphBuildStatus, 'result'> | undefined,
): Effect.Effect<CodeGraphIsolatedBuilderResult, Error> {
  if (status?.result) {
    return Effect.succeed({
      edges: status.result.edges,
      symbols: status.result.symbols,
    });
  }
  return Effect.fail(new Error('isolated graph index finished without writing a build result'));
}

function omitStartedAt<T extends {readonly startedAt: string}>(value: T): Omit<T, 'startedAt'> {
  const {startedAt: _startedAt, ...rest} = value;
  return rest;
}

export function shouldAwaitExistingBuilder(
  status: ObservedCodeGraphBuildStatus | undefined,
  currentProcessId: number,
): boolean {
  if (!status) return false;
  if (status.observation.liveness !== 'active' && status.observation.liveness !== 'stalled') return false;
  return status.owner.processId !== currentProcessId;
}

export function statusBelongsToChild(
  status: ObservedCodeGraphBuildStatus,
  childProcessId: number,
  priorBuildId: string | undefined,
): boolean {
  if (status.owner.processId === childProcessId) return true;
  if (priorBuildId && status.buildId === priorBuildId) return false;
  return false;
}

/** @internal Exported for unit tests. */
export function assertIsolatedBuilderPlan(plan: CodeGraphIsolatedBuilderSpawnPlan): void {
  const executableName = executableBaseName(plan.executable);
  if (executableName?.startsWith('threadnote-mcp-server') === true) {
    throw new Error('Isolated graph builder must not spawn the MCP launcher executable.');
  }
  const graphAt = plan.arguments.indexOf('graph');
  if (graphAt < 0 || plan.arguments[graphAt + 1] !== 'index') {
    throw new Error('Isolated graph builder spawn plan must invoke `graph index`.');
  }
  if (plan.arguments.slice(0, graphAt).includes('mcp-server')) {
    throw new Error('Isolated graph builder must not spawn an MCP server child.');
  }
}

function assertIsolatedBuilderPlanEffect(plan: CodeGraphIsolatedBuilderSpawnPlan) {
  return Effect.try({
    try: () => assertIsolatedBuilderPlan(plan),
    catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

function spawnIsolatedBuilderProcess(plan: CodeGraphIsolatedBuilderSpawnPlan): CodeGraphIsolatedBuilderProcess {
  // stdout must stay ignored: the parent's stdout is the MCP JSON-RPC transport.
  const child = Bun.spawn({
    cmd: [plan.executable, ...plan.arguments],
    env: {...plan.environment},
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'ignore',
  });
  const stderrChunks: Uint8Array[] = [];
  let stderrBytes = 0;
  const reader = (async () => {
    try {
      for await (const chunk of child.stderr as AsyncIterable<Uint8Array>) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.byteLength;
        while (stderrBytes > STDERR_TAIL_LIMIT_BYTES && stderrChunks.length > 1) {
          const dropped = stderrChunks.shift();
          if (dropped) stderrBytes -= dropped.byteLength;
        }
      }
    } catch {
      // Child may close stderr before the reader settles.
    }
  })();
  void reader;
  return {
    exited: child.exited,
    kill: () => {
      try {
        child.kill();
      } catch {
        // Native teardown can close the process before kill settles.
      }
    },
    processId: child.pid,
    stderrTail: () => {
      if (stderrChunks.length === 0) return '';
      const merged = new Uint8Array(stderrBytes);
      let offset = 0;
      for (const chunk of stderrChunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(merged);
    },
  };
}

function statusOwnedBy<E, R>(
  readStatus: Effect.Effect<ObservedCodeGraphBuildStatus | undefined, E, R>,
  childProcessId: number,
  priorBuildId: string | undefined,
) {
  return readStatus.pipe(
    Effect.map(status => (status && statusBelongsToChild(status, childProcessId, priorBuildId) ? status : undefined)),
  );
}

function awaitExistingBuilder<E, R>(
  readStatus: Effect.Effect<ObservedCodeGraphBuildStatus | undefined, E, R>,
  onProgress: CodeGraphIsolatedBuilderOptions['onProgress'],
) {
  return Effect.gen(function* () {
    const stalledStartedAt = yield* Ref.make<number | undefined>(undefined);
    for (;;) {
      const status = yield* readStatus;
      if (!status) {
        return yield* Effect.fail(new Error('Existing code graph builder status disappeared before completion.'));
      }
      if (status.observation.liveness === 'completed' && status.result) {
        return {
          edges: status.result.edges,
          symbols: status.result.symbols,
        } satisfies CodeGraphIsolatedBuilderResult;
      }
      if (status.observation.liveness === 'completed') {
        return yield* Effect.fail(new Error('Existing code graph builder completed without writing a build result.'));
      }
      if (status.observation.liveness !== 'active' && status.observation.liveness !== 'stalled') {
        return yield* Effect.fail(
          new Error(status.error?.summary ?? 'Existing code graph builder stopped before completion.'),
        );
      }
      if (status.observation.liveness === 'stalled') {
        const now = yield* Clock.currentTimeMillis;
        const started = yield* Ref.modify(stalledStartedAt, current => {
          const next = current ?? now;
          return [next, next] as const;
        });
        if (now - started >= EXISTING_BUILDER_STALLED_TIMEOUT_MILLISECONDS) {
          return yield* Effect.fail(
            new Error('Existing code graph builder stalled without progress; retry the refresh.'),
          );
        }
      } else {
        yield* Ref.set(stalledStartedAt, undefined);
      }
      yield* emitProgress(onProgress, codeGraphProgressFromBuildStatus(status));
      yield* Effect.sleep(BUILD_STATUS_POLL_MILLISECONDS);
    }
  });
}

function mirrorBuildStatusProgress<E, R>(
  readStatus: Effect.Effect<ObservedCodeGraphBuildStatus | undefined, E, R>,
  childProcessId: number,
  priorBuildId: string | undefined,
  onProgress: CodeGraphIsolatedBuilderOptions['onProgress'],
) {
  // Never succeed or fail: only the child's exit should settle the race. Progress errors must not kill the build.
  return Effect.forever(
    Effect.gen(function* () {
      const status = yield* statusOwnedBy(readStatus, childProcessId, priorBuildId).pipe(
        Effect.catch(() => Effect.succeed(undefined as ObservedCodeGraphBuildStatus | undefined)),
      );
      if (status) {
        yield* emitProgress(onProgress, codeGraphProgressFromBuildStatus(status));
      } else {
        yield* emitProgress(onProgress, {phase: 'registering'});
      }
      yield* Effect.sleep(BUILD_STATUS_POLL_MILLISECONDS);
    }).pipe(Effect.catchCause(() => Effect.void)),
  );
}

function emitProgress(onProgress: CodeGraphIsolatedBuilderOptions['onProgress'], progress: CodeGraphProgress) {
  return (onProgress?.(progress) ?? Effect.void).pipe(Effect.catch(() => Effect.void));
}

function developmentStandaloneScript(system: SystemInfoShape): Option.Option<string> {
  const executableName = executableBaseName(system.executablePath);
  if (executableName !== 'bun' && executableName !== 'bun.exe') return Option.none();
  const candidate = system.processArguments[1];
  if (candidate && /(?:^|[/\\])(?:standalone\.(?:js|ts)|threadnote\.cjs)$/i.test(candidate)) {
    return Option.some(candidate);
  }
  return Option.some(Bun.fileURLToPath(new URL('../standalone.ts', import.meta.url)));
}
