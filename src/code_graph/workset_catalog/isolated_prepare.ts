import {Effect, Option, Stream} from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import {SystemInfo, type SystemInfoShape} from '../../effect/system.js';
import {withCurrentAgentSessionEnvironment} from '../../telemetry/session.js';
import type {RuntimeConfig} from '../../types.js';
import {developmentStandaloneScript} from '../isolated_builder.js';
import type {
  CodeGraphWorksetPrepareBridgeReceiptV1,
  CodeGraphWorksetPrepareCoverageV1,
  CodeGraphWorksetPrepareIndexActivityV1,
  CodeGraphWorksetPrepareMemberV1,
  CodeGraphWorksetPrepareProgressV1,
  CodeGraphWorksetPrepareResultV1,
  PrepareCodeGraphWorksetOptionsV1,
} from './workset.js';

export const CODE_GRAPH_MANAGER_WORKSET_ORCHESTRATOR_ENV = 'THREADNOTE_MANAGER_WORKSET_ORCHESTRATOR';
const ISOLATED_WORKSET_STDOUT_BYTES_MAXIMUM = 8 * 1_048_576;
const ISOLATED_WORKSET_PROGRESS_LINE_BYTES_MAXIMUM = 64 * 1_024;
const ISOLATED_WORKSET_MEMBER_MAXIMUM = 4_096;
const ISOLATED_WORKSET_TEXT_MAXIMUM = 4_096;
const WORKSET_PROGRESS_PHASES = new Set([
  'bridging',
  'cataloging',
  'completed',
  'failed',
  'indexing',
  'projecting',
  'publishing',
  'starting',
  'waiting',
]);
const GRAPH_PROGRESS_PHASES = new Set([
  'activating',
  'embedding',
  'materializing',
  'reclaiming',
  'registering',
  'resolving',
  'scanning',
  'waiting',
]);

export class CodeGraphIsolatedWorksetPrepareError extends Error {
  override readonly name = 'CodeGraphIsolatedWorksetPrepareError';
}

export interface CodeGraphIsolatedWorksetPrepareSpawnPlan {
  readonly arguments: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly executable: string;
}

export function codeGraphIsolatedWorksetPrepareSpawnPlan(
  system: SystemInfoShape,
  options: {
    readonly concurrency?: number;
    readonly manifestPath: string;
    readonly threadnoteHome: string;
    readonly workset: string;
  },
): CodeGraphIsolatedWorksetPrepareSpawnPlan {
  return {
    arguments: [
      ...Option.toArray(developmentStandaloneScript(system)),
      '--home',
      options.threadnoteHome,
      '--manifest',
      options.manifestPath,
      'workset',
      'prepare',
      '--json',
      ...(options.concurrency === undefined ? [] : ['--concurrency', String(options.concurrency)]),
      options.workset,
    ],
    environment: {
      ...withCurrentAgentSessionEnvironment(system.environment(), 'graph-builder'),
      [CODE_GRAPH_MANAGER_WORKSET_ORCHESTRATOR_ENV]: '1',
      THREADNOTE_HOME: options.threadnoteHome,
      THREADNOTE_MANIFEST: options.manifestPath,
    },
    executable: system.executablePath,
  };
}

/** Run every workset preparation phase outside a long-lived Manager process. */
export const runIsolatedCodeGraphWorksetPrepare = Effect.fn('codeGraph.workset.prepareIsolated')(function* (
  input: {
    readonly manifestPath: string;
    readonly threadnoteHome: string;
    readonly workset: string;
  },
  options: PrepareCodeGraphWorksetOptionsV1 = {},
) {
  const system = yield* SystemInfo;
  const plan = codeGraphIsolatedWorksetPrepareSpawnPlan(system, {
    concurrency: options.concurrency,
    manifestPath: input.manifestPath,
    threadnoteHome: input.threadnoteHome,
    workset: input.workset,
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(plan.executable, [...plan.arguments], {
        env: {...plan.environment},
        forceKillAfter: 1_000,
        stdin: 'ignore',
      }).pipe(
        Effect.mapError(
          cause => new CodeGraphIsolatedWorksetPrepareError('Could not start isolated workset preparation.', {cause}),
        ),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          collectBoundedWorksetOutput(handle.stdout),
          consumeIsolatedWorksetProgress(handle.stderr, input.workset, options.onProgress),
          handle.exitCode.pipe(Effect.map(Number)),
        ] as const,
        {concurrency: 'unbounded'},
      );
      const result = decodeIsolatedWorksetPrepareResult(stdout);
      if (result === undefined || result.workset !== input.workset) {
        return yield* Effect.fail(
          new CodeGraphIsolatedWorksetPrepareError(
            `Isolated workset preparation exited with code ${exitCode} without a valid result.`,
          ),
        );
      }
      if (exitCode !== 0 && result.state !== 'failed') {
        return yield* Effect.fail(
          new CodeGraphIsolatedWorksetPrepareError(`Isolated workset preparation exited with code ${exitCode}.`),
        );
      }
      return result;
    }),
  );
});

export function prepareManagerCodeGraphWorksetIsolated(
  config: RuntimeConfig,
  workset: string,
  options: PrepareCodeGraphWorksetOptionsV1,
) {
  return runIsolatedCodeGraphWorksetPrepare(
    {manifestPath: config.manifestPath, threadnoteHome: config.agentContextHome, workset},
    options,
  );
}

function collectBoundedWorksetOutput(stream: Stream.Stream<Uint8Array, unknown>) {
  const encoder = new TextEncoder();
  return stream.pipe(
    Stream.decodeText,
    Stream.runFoldEffect(
      () => ({chunks: [] as string[], size: 0}),
      (state, chunk) => {
        const size = state.size + encoder.encode(chunk).byteLength;
        if (size > ISOLATED_WORKSET_STDOUT_BYTES_MAXIMUM) {
          return Effect.fail(new CodeGraphIsolatedWorksetPrepareError('Isolated workset result was too large.'));
        }
        state.chunks.push(chunk);
        return Effect.succeed({chunks: state.chunks, size});
      },
    ),
    Effect.map(state => state.chunks.join('')),
  );
}

function consumeIsolatedWorksetProgress(
  stream: Stream.Stream<Uint8Array, unknown>,
  expectedWorkset: string,
  onProgress: PrepareCodeGraphWorksetOptionsV1['onProgress'],
) {
  return stream.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach(line => {
      const progress = decodeIsolatedWorksetPrepareProgress(line);
      if (progress === undefined || progress.workset !== expectedWorkset) return Effect.void;
      return (onProgress?.(progress) ?? Effect.void).pipe(Effect.catch(() => Effect.void));
    }),
  );
}

export function decodeIsolatedWorksetPrepareProgress(content: string): CodeGraphWorksetPrepareProgressV1 | undefined {
  if (new TextEncoder().encode(content).byteLength > ISOLATED_WORKSET_PROGRESS_LINE_BYTES_MAXIMUM) return undefined;
  const value = jsonRecord(content);
  if (
    value === undefined ||
    value.type !== 'code-graph-workset-progress' ||
    value.version !== 1 ||
    !boundedText(value.workset) ||
    !boundedText(value.message) ||
    !WORKSET_PROGRESS_PHASES.has(String(value.phase)) ||
    !nonnegativeInteger(value.completed) ||
    !nonnegativeInteger(value.elapsedMilliseconds) ||
    !nonnegativeInteger(value.total)
  ) {
    return undefined;
  }
  const activity = decodeIndexActivity(value.activity);
  if (value.activity !== undefined && activity === undefined) return undefined;
  if (value.attempt !== undefined && !nonnegativeInteger(value.attempt)) return undefined;
  if (value.maxAttempts !== undefined && !nonnegativeInteger(value.maxAttempts)) return undefined;
  if (value.project !== undefined && !boundedText(value.project)) return undefined;
  return {
    ...(activity === undefined ? {} : {activity}),
    ...(value.attempt === undefined ? {} : {attempt: value.attempt}),
    completed: value.completed,
    elapsedMilliseconds: value.elapsedMilliseconds,
    ...(value.maxAttempts === undefined ? {} : {maxAttempts: value.maxAttempts}),
    message: value.message,
    phase: value.phase as CodeGraphWorksetPrepareProgressV1['phase'],
    ...(value.project === undefined ? {} : {project: value.project}),
    total: value.total,
    type: 'code-graph-workset-progress',
    version: 1,
    workset: value.workset,
  };
}

export function decodeIsolatedWorksetPrepareResult(content: string): CodeGraphWorksetPrepareResultV1 | undefined {
  const value = jsonRecord(content);
  if (
    value === undefined ||
    value.type !== 'code-graph-workset-prepare' ||
    value.version !== 1 ||
    (value.state !== 'failed' && value.state !== 'ready') ||
    !boundedText(value.workset) ||
    !digest(value.manifestDigest) ||
    !Array.isArray(value.members) ||
    value.members.length > ISOLATED_WORKSET_MEMBER_MAXIMUM
  ) {
    return undefined;
  }
  const coverage = decodeCoverage(value.coverage);
  const members = value.members.map(decodeMember);
  if (coverage === undefined || members.some(member => member === undefined)) return undefined;
  const published = decodePublished(value.published);
  const bridges = decodeBridges(value.bridges);
  if (value.published !== undefined && published === undefined) return undefined;
  if (value.bridges !== undefined && bridges === undefined) return undefined;
  return {
    ...(bridges === undefined ? {} : {bridges}),
    coverage,
    manifestDigest: value.manifestDigest,
    members: members as readonly CodeGraphWorksetPrepareMemberV1[],
    ...(published === undefined ? {} : {published}),
    state: value.state,
    type: 'code-graph-workset-prepare',
    version: 1,
    workset: value.workset,
  };
}

function decodeIndexActivity(value: unknown): CodeGraphWorksetPrepareIndexActivityV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !GRAPH_PROGRESS_PHASES.has(String(value.phase))) return undefined;
  for (const key of ['completed', 'total'] as const) {
    if (value[key] !== undefined && !nonnegativeInteger(value[key])) return undefined;
  }
  if (value.reason !== undefined && !boundedText(value.reason)) return undefined;
  if (value.subphase !== undefined && !boundedText(value.subphase)) return undefined;
  if (value.unit !== undefined && value.unit !== 'files' && value.unit !== 'snapshots' && value.unit !== 'symbols') {
    return undefined;
  }
  return {
    ...(value.completed === undefined ? {} : {completed: value.completed as number}),
    phase: value.phase as CodeGraphWorksetPrepareIndexActivityV1['phase'],
    ...(value.reason === undefined ? {} : {reason: value.reason as CodeGraphWorksetPrepareIndexActivityV1['reason']}),
    ...(value.subphase === undefined ? {} : {subphase: value.subphase}),
    ...(value.total === undefined ? {} : {total: value.total as number}),
    ...(value.unit === undefined ? {} : {unit: value.unit as CodeGraphWorksetPrepareIndexActivityV1['unit']}),
  };
}

function decodeCoverage(value: unknown): CodeGraphWorksetPrepareCoverageV1 | undefined {
  if (!isRecord(value) || typeof value.complete !== 'boolean') return undefined;
  for (const key of ['excluded', 'failed', 'missing', 'ready', 'requested'] as const) {
    if (!nonnegativeInteger(value[key])) return undefined;
  }
  return {
    complete: value.complete,
    excluded: value.excluded as number,
    failed: value.failed as number,
    missing: value.missing as number,
    ready: value.ready as number,
    requested: value.requested as number,
  };
}

function decodeMember(value: unknown): CodeGraphWorksetPrepareMemberV1 | undefined {
  if (!isRecord(value) || !boundedText(value.project)) return undefined;
  switch (value.state) {
    case 'ready':
      return digest(value.projectionDigest) &&
        digest(value.repositoryId) &&
        boundedText(value.snapshotId) &&
        nonnegativeInteger(value.symbolCount)
        ? {
            project: value.project,
            projectionDigest: value.projectionDigest,
            repositoryId: value.repositoryId,
            snapshotId: value.snapshotId,
            state: 'ready',
            symbolCount: value.symbolCount,
          }
        : undefined;
    case 'excluded':
      return value.reason === 'unknown-project'
        ? {project: value.project, reason: 'unknown-project', state: 'excluded'}
        : undefined;
    case 'missing':
      return value.reason === 'missing-path'
        ? {project: value.project, reason: 'missing-path', state: 'missing'}
        : undefined;
    case 'failed': {
      if ((value.reason !== 'index-failed' && value.reason !== 'projection-failed') || !isRecord(value.detail)) {
        return undefined;
      }
      const detail = value.detail;
      if (
        !boundedText(detail.code) ||
        !boundedText(detail.errorType) ||
        typeof detail.retryable !== 'boolean' ||
        !boundedText(detail.summary)
      ) {
        return undefined;
      }
      return {
        detail: {
          code: detail.code as Extract<CodeGraphWorksetPrepareMemberV1, {state: 'failed'}>['detail']['code'],
          errorType: detail.errorType,
          retryable: detail.retryable,
          summary: detail.summary,
        },
        project: value.project,
        reason: value.reason,
        state: 'failed',
      };
    }
    default:
      return undefined;
  }
}

function decodePublished(value: unknown): CodeGraphWorksetPrepareResultV1['published'] | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !digest(value.digest) ||
    !boundedText(value.id) ||
    !digest(value.manifestDigest) ||
    !nonnegativeInteger(value.memberCount) ||
    value.state !== 'ready' ||
    !boundedText(value.worksetName)
  ) {
    return undefined;
  }
  return {
    digest: value.digest,
    id: value.id,
    manifestDigest: value.manifestDigest,
    memberCount: value.memberCount,
    state: 'ready',
    worksetName: value.worksetName,
  };
}

function decodeBridges(value: unknown): CodeGraphWorksetPrepareBridgeReceiptV1 | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !nonnegativeInteger(value.bridgeCount) ||
    !digest(value.digest) ||
    !nonnegativeInteger(value.monikerCount) ||
    !nonnegativeInteger(value.rejectionCount) ||
    !nonnegativeInteger(value.resolverVersion) ||
    (value.state !== 'ready' && value.state !== 'unavailable') ||
    !boundedTextArray(value.unavailableRepositories) ||
    !boundedTextArray(value.warnings)
  ) {
    return undefined;
  }
  return {
    bridgeCount: value.bridgeCount,
    digest: value.digest,
    monikerCount: value.monikerCount,
    rejectionCount: value.rejectionCount,
    resolverVersion: value.resolverVersion,
    state: value.state,
    unavailableRepositories: value.unavailableRepositories,
    warnings: value.warnings,
  };
}

function jsonRecord(content: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(content.trim());
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ISOLATED_WORKSET_TEXT_MAXIMUM;
}

function boundedTextArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= ISOLATED_WORKSET_MEMBER_MAXIMUM && value.every(boundedText);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
