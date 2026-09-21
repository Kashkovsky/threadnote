import {Cause, Clock, Effect, Exit, Predicate, Schema, Stdio, Stream} from 'effect';
import {CommandExecutor, CommandTimedOut, type CommandExecutionError} from '../../effect/command.js';
import {SystemInfo, type SystemInfoShape} from '../../effect/system.js';
import {CODE_GRAPH_IMPACT_QUERY_WORKER_ARGUMENT} from '../../worker_protocol.js';
import {CodeGraphQueryService, type CodeGraphInspectOptions} from '../query.js';
import type {
  CodeGraphQueryTelemetryObservation,
  CodeGraphQueryTelemetryObserver,
  CodeGraphQueryTelemetryPhase,
  CodeGraphQueryTelemetryStage,
  CodeGraphQueryTelemetryStageDisposition,
} from '../query/contract.js';
import {resolveRepositoryIdentity} from '../repository.js';
import type {CodeGraphQueryResult} from '../types.js';

const CODE_GRAPH_IMPACT_QUERY_PROTOCOL = 1 as const;
const CODE_GRAPH_IMPACT_QUERY_INPUT_BYTES_MAXIMUM = 256 * 1_024;
const CODE_GRAPH_IMPACT_QUERY_OUTPUT_BYTES_MAXIMUM = 2 * 1_024 * 1_024;
const CODE_GRAPH_IMPACT_QUERY_TEXT_BYTES_MAXIMUM = 64 * 1_024;
const CODE_GRAPH_IMPACT_QUERY_SEED_LIMIT = 200;
const CODE_GRAPH_IMPACT_QUERY_CHANGED_PATHS_SELECTOR = 'changed paths';
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const CODE_GRAPH_SNAPSHOT_ID_PATTERN = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/u;
export const CODE_GRAPH_IMPACT_QUERY_TIMEOUT_MILLISECONDS = 20_000;
export const CODE_GRAPH_ISOLATED_QUERY_TIMEOUT_MILLISECONDS = 50_000;

type CodeGraphIsolatedQueryOperation = CodeGraphQueryResult['operation'];

interface CodeGraphImpactQueryRequest {
  readonly project?: string;
  readonly manifestPath?: string;
  readonly baseCommit?: string;
  readonly borrowedSnapshotId?: string;
  readonly cwd: string;
  readonly depth?: number;
  readonly direction?: 'both' | 'incoming' | 'outgoing';
  readonly edgeLimit: number;
  readonly from?: string;
  readonly includeHeuristic?: boolean;
  readonly includeModelAssociations?: boolean;
  readonly nodeId?: string;
  readonly nodeLimit: number;
  readonly operation: CodeGraphIsolatedQueryOperation;
  readonly packageName?: string;
  readonly protocol: typeof CODE_GRAPH_IMPACT_QUERY_PROTOCOL;
  readonly query: string;
  /** Original count retained when the transport bounds changed-path content. */
  readonly seedQueryCount?: number;
  readonly seedQueries?: readonly string[];
  readonly symbol?: string;
  readonly threadnoteHome: string;
  readonly to?: string;
}

type CodeGraphImpactQueryResponse =
  | {
      readonly ok: true;
      readonly protocol: typeof CODE_GRAPH_IMPACT_QUERY_PROTOCOL;
      readonly result: CodeGraphQueryResult;
      readonly telemetry: readonly CodeGraphQueryTelemetryObservation[];
    }
  | {
      readonly ok: false;
      readonly protocol: typeof CODE_GRAPH_IMPACT_QUERY_PROTOCOL;
      readonly telemetry: readonly CodeGraphQueryTelemetryObservation[];
    };

export interface IsolatedCodeGraphImpactQueryInput {
  readonly project?: string;
  readonly manifestPath?: string;
  readonly baseCommit?: string;
  readonly cwd: string;
  readonly depth?: number;
  readonly edgeLimit: number;
  readonly includeHeuristic?: boolean;
  readonly includeModelAssociations?: boolean;
  readonly nodeLimit: number;
  readonly query: string;
  readonly seedQueries?: readonly string[];
  readonly threadnoteHome: string;
}

export interface IsolatedCodeGraphQueryInput {
  readonly project?: string;
  readonly manifestPath?: string;
  readonly baseCommit?: string;
  readonly borrowedSnapshotId?: string;
  readonly cwd: string;
  readonly depth?: number;
  readonly direction?: 'both' | 'incoming' | 'outgoing';
  readonly edgeLimit: number;
  readonly from?: string;
  readonly includeHeuristic?: boolean;
  readonly includeModelAssociations?: boolean;
  readonly nodeId?: string;
  readonly nodeLimit: number;
  readonly operation: CodeGraphIsolatedQueryOperation;
  readonly packageName?: string;
  readonly query?: string;
  readonly seedQueries?: readonly string[];
  readonly symbol?: string;
  readonly threadnoteHome: string;
  readonly to?: string;
}

export class IsolatedCodeGraphImpactQueryError extends Schema.TaggedError<IsolatedCodeGraphImpactQueryError>()(
  'IsolatedCodeGraphImpactQueryError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export class IsolatedCodeGraphImpactQueryTimedOut extends Schema.TaggedError<IsolatedCodeGraphImpactQueryTimedOut>()(
  'IsolatedCodeGraphImpactQueryTimedOut',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

/**
 * Execute graph reads outside the MCP event loop. Bun SQLite calls are
 * synchronous, so an in-process busy or cold query can stall the MCP control plane.
 */
export const inspectCodeGraphIsolated = Effect.fn('codeGraph.queryIsolated')(function* (
  input: IsolatedCodeGraphQueryInput,
  options: {
    readonly onTelemetryObservation?: (observation: CodeGraphQueryTelemetryObservation) => Effect.Effect<void>;
    readonly timeoutMilliseconds?: number;
  } = {},
) {
  const command = yield* CommandExecutor;
  const system = yield* SystemInfo;
  const timeoutMilliseconds = boundedTimeout(
    options.timeoutMilliseconds,
    CODE_GRAPH_ISOLATED_QUERY_TIMEOUT_MILLISECONDS,
  );
  const request = yield* Effect.try({
    try: () => encodeImpactQueryRequest(input),
    catch: cause =>
      Schema.is(IsolatedCodeGraphImpactQueryError)(cause)
        ? cause
        : IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph query request is invalid.'}),
  });
  const invocation = impactQueryWorkerInvocation(system);
  const timeout = IsolatedCodeGraphImpactQueryTimedOut.make({message: 'Isolated code graph query timed out.'});
  const execute = command
    .execute(invocation.executable, invocation.arguments, {
      env: impactQueryWorkerEnvironment(system.environment(), input.threadnoteHome),
      input: request,
      maxOutputBytes: CODE_GRAPH_IMPACT_QUERY_OUTPUT_BYTES_MAXIMUM,
      timeoutMs: timeoutMilliseconds,
    })
    .pipe(
      Effect.mapError((error: CommandExecutionError) =>
        Schema.is(CommandTimedOut)(error)
          ? timeout
          : IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph query failed.'}),
      ),
      Effect.timeoutOrElse({duration: timeoutMilliseconds, orElse: () => Effect.fail(timeout)}),
    );
  const result = yield* execute;
  const response = decodeImpactQueryResponse(result.stdout);
  if (response === undefined) {
    return yield* IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph query failed.'});
  }
  yield* replayCodeGraphIsolatedQueryTelemetry(response.telemetry, options.onTelemetryObservation);
  if (!response.ok || response.result.operation !== input.operation) {
    return yield* IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph query failed.'});
  }
  return response.result;
});

export const inspectCodeGraphImpactIsolated = Effect.fn('codeGraph.impactQueryIsolated')(
  (input: IsolatedCodeGraphImpactQueryInput, options: {readonly timeoutMilliseconds?: number} = {}) =>
    inspectCodeGraphIsolated(
      {...input, operation: 'impact'},
      {
        timeoutMilliseconds:
          options.timeoutMilliseconds === undefined
            ? CODE_GRAPH_IMPACT_QUERY_TIMEOUT_MILLISECONDS
            : Math.min(options.timeoutMilliseconds, CODE_GRAPH_IMPACT_QUERY_TIMEOUT_MILLISECONDS),
      },
    ),
);

/** Internal standalone worker. Input and output are bounded one-document JSON over stdio. */
export const codeGraphImpactQueryWorkerProgram = (threadnoteHome: string) =>
  Effect.gen(function* () {
    const request = yield* readImpactQueryWorkerRequest;
    const query = yield* CodeGraphQueryService;
    const telemetry: CodeGraphQueryTelemetryObservation[] = [];
    const response =
      request === undefined || request.threadnoteHome !== threadnoteHome
        ? ({ok: false, protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL, telemetry} as const)
        : yield* Effect.gen(function* () {
            const options = impactQueryWorkerInspectOptions(request, threadnoteHome);
            const statusObservation = request.borrowedSnapshotId
              ? {
                  borrowedSnapshotId: request.borrowedSnapshotId,
                  identity: yield* resolveRepositoryIdentity(request.cwd),
                }
              : undefined;
            return yield* query.inspect({
              ...options,
              ...(statusObservation === undefined ? {} : {statusObservation}),
              telemetry: codeGraphIsolatedQueryTelemetryRecorder(telemetry),
            });
          }).pipe(
            Effect.match({
              onFailure: () => ({ok: false, protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL, telemetry}) as const,
              onSuccess: result =>
                ({
                  ok: true,
                  protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL,
                  result,
                  telemetry,
                }) as const satisfies CodeGraphImpactQueryResponse,
            }),
          );
    yield* writeImpactQueryWorkerResponse(response);
  }).pipe(Effect.ignore);

/** @internal Keep the bounded read worker incapable of starting base-commit indexing. */
export function impactQueryWorkerInspectOptions(
  request: CodeGraphImpactQueryRequest,
  threadnoteHome: string,
): CodeGraphInspectOptions {
  return {
    project: request.project,
    manifestPath: request.manifestPath,
    ...(request.baseCommit === undefined ? {} : {baseCommit: request.baseCommit}),
    ...(request.operation === 'impact' ? {baseCommitPolicy: 'ready-only' as const} : {}),
    cwd: request.cwd,
    depth: request.depth,
    direction: request.direction,
    edgeLimit: request.edgeLimit,
    from: request.from,
    includeHeuristic: request.includeHeuristic,
    includeModelAssociations: request.includeModelAssociations,
    nodeId: request.nodeId,
    nodeLimit: request.nodeLimit,
    operation: request.operation,
    packageName: request.packageName,
    query: request.query,
    refresh: false,
    requestMaintenance: false,
    seedQueryCount: request.seedQueryCount,
    seedQueries: request.seedQueries,
    strictFreshness: request.operation === 'impact' || request.operation === 'path',
    symbol: request.symbol,
    threadnoteHome,
    to: request.to,
  };
}

function encodeImpactQueryRequest(input: IsolatedCodeGraphQueryInput): Uint8Array {
  const seedQueries = input.seedQueries?.slice(0, CODE_GRAPH_IMPACT_QUERY_SEED_LIMIT);
  const request = {
    ...(input.project === undefined ? {} : {project: input.project}),
    ...(input.manifestPath === undefined ? {} : {manifestPath: input.manifestPath}),
    ...(input.baseCommit === undefined ? {} : {baseCommit: input.baseCommit}),
    ...(input.borrowedSnapshotId === undefined ? {} : {borrowedSnapshotId: input.borrowedSnapshotId}),
    cwd: input.cwd,
    ...(input.depth === undefined ? {} : {depth: input.depth}),
    ...(input.direction === undefined ? {} : {direction: input.direction}),
    edgeLimit: input.edgeLimit,
    ...(input.from === undefined ? {} : {from: input.from}),
    ...(input.includeHeuristic === undefined ? {} : {includeHeuristic: input.includeHeuristic}),
    ...(input.includeModelAssociations === undefined ? {} : {includeModelAssociations: input.includeModelAssociations}),
    ...(input.nodeId === undefined ? {} : {nodeId: input.nodeId}),
    nodeLimit: input.nodeLimit,
    operation: input.operation,
    ...(input.packageName === undefined ? {} : {packageName: input.packageName}),
    protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL,
    query:
      input.operation === 'impact' ? impactQueryTransportSelector(input.query, input.seedQueries) : (input.query ?? ''),
    ...(input.seedQueries === undefined ? {} : {seedQueries, seedQueryCount: input.seedQueries.length}),
    ...(input.symbol === undefined ? {} : {symbol: input.symbol}),
    threadnoteHome: input.threadnoteHome,
    ...(input.to === undefined ? {} : {to: input.to}),
  } satisfies CodeGraphImpactQueryRequest;
  if (!validImpactQueryRequest(request)) {
    throw IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph query request is invalid.'});
  }
  const bytes = new TextEncoder().encode(`${JSON.stringify(request)}\n`);
  if (bytes.byteLength > CODE_GRAPH_IMPACT_QUERY_INPUT_BYTES_MAXIMUM) {
    throw IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph impact query request is too large.'});
  }
  return bytes;
}

const readImpactQueryWorkerRequest = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const encoder = new TextEncoder();
  const state = yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.runFoldEffect(
      () => ({chunks: [] as string[], size: 0}),
      (current, chunk) => {
        const size = current.size + encoder.encode(chunk).byteLength;
        if (size > CODE_GRAPH_IMPACT_QUERY_INPUT_BYTES_MAXIMUM) {
          return Effect.fail(
            IsolatedCodeGraphImpactQueryError.make({message: 'Impact query worker input is too large.'}),
          );
        }
        current.chunks.push(chunk);
        return Effect.succeed({chunks: current.chunks, size});
      },
    ),
  );
  return decodeImpactQueryRequest(state.chunks.join(''));
});

const writeImpactQueryWorkerResponse = Effect.fn('codeGraph.impactQueryWorker.write')(function* (
  response: CodeGraphImpactQueryResponse,
) {
  const stdio = yield* Stdio.Stdio;
  const bytes = new TextEncoder().encode(`${JSON.stringify(response)}\n`);
  if (bytes.byteLength > CODE_GRAPH_IMPACT_QUERY_OUTPUT_BYTES_MAXIMUM) {
    return yield* IsolatedCodeGraphImpactQueryError.make({message: 'Impact query worker output is too large.'});
  }
  yield* Stream.run(Stream.make(bytes), stdio.stdout({endOnDone: false}));
});

/** @internal Protocol decoder retained for bounded property coverage. */
export function decodeImpactQueryRequest(content: string): CodeGraphImpactQueryRequest | undefined {
  if (new TextEncoder().encode(content).byteLength > CODE_GRAPH_IMPACT_QUERY_INPUT_BYTES_MAXIMUM) return undefined;
  try {
    const parsed: unknown = JSON.parse(content.trim());
    return validImpactQueryRequest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validImpactQueryRequest(value: unknown): value is CodeGraphImpactQueryRequest {
  if (!Predicate.isObject(value)) return false;
  const record = value;
  if (
    record.protocol !== CODE_GRAPH_IMPACT_QUERY_PROTOCOL ||
    !isCodeGraphIsolatedQueryOperation(record.operation) ||
    !validProtocolText(record.cwd) ||
    !validProtocolText(record.threadnoteHome) ||
    !validProtocolText(record.query, true) ||
    (record.project !== undefined && !validProtocolText(record.project)) ||
    (record.manifestPath !== undefined && !validProtocolText(record.manifestPath)) ||
    (record.borrowedSnapshotId !== undefined && !validSnapshotId(record.borrowedSnapshotId)) ||
    !boundedInteger(record.nodeLimit, 1, 200) ||
    !boundedInteger(record.edgeLimit, 1, 500) ||
    (record.depth !== undefined && !boundedInteger(record.depth, 0, 8)) ||
    (record.direction !== undefined && !['both', 'incoming', 'outgoing'].includes(String(record.direction))) ||
    (record.from !== undefined && !validProtocolText(record.from)) ||
    (record.includeHeuristic !== undefined && typeof record.includeHeuristic !== 'boolean') ||
    (record.includeModelAssociations !== undefined && typeof record.includeModelAssociations !== 'boolean') ||
    (record.nodeId !== undefined && !validProtocolText(record.nodeId)) ||
    (record.packageName !== undefined && !validProtocolText(record.packageName)) ||
    (record.seedQueryCount !== undefined && !boundedInteger(record.seedQueryCount, 0, Number.MAX_SAFE_INTEGER)) ||
    (record.symbol !== undefined && !validProtocolText(record.symbol)) ||
    (record.to !== undefined && !validProtocolText(record.to)) ||
    (record.baseCommit !== undefined &&
      (typeof record.baseCommit !== 'string' || !GIT_OBJECT_ID_PATTERN.test(record.baseCommit)))
  ) {
    return false;
  }
  const seeds = record.seedQueries;
  if (seeds === undefined && record.seedQueryCount !== undefined) return false;
  if (seeds !== undefined) {
    if (record.operation !== 'impact' || !Array.isArray(seeds) || seeds.length > CODE_GRAPH_IMPACT_QUERY_SEED_LIMIT) {
      return false;
    }
    const seedQueryCount = record.seedQueryCount ?? seeds.length;
    if (
      seedQueryCount < seeds.length ||
      !seeds.every(value => validProtocolText(value)) ||
      (record.query === '' && seedQueryCount === 0)
    ) {
      return false;
    }
  }
  return validOperationSelectors({
    from: record.from,
    nodeId: record.nodeId,
    operation: record.operation,
    query: record.query,
    seedQueryCount: record.seedQueryCount,
    symbol: record.symbol,
    to: record.to,
  });
}

function validOperationSelectors(
  request: Pick<
    CodeGraphImpactQueryRequest,
    'from' | 'nodeId' | 'operation' | 'query' | 'seedQueryCount' | 'symbol' | 'to'
  >,
): boolean {
  switch (request.operation) {
    case 'query':
      return request.query !== '';
    case 'node':
    case 'neighbors':
      return request.nodeId !== undefined;
    case 'path':
      return request.from !== undefined && request.to !== undefined;
    case 'explain':
      return request.symbol !== undefined || request.query !== '';
    case 'impact':
      return request.query !== '' || (request.seedQueryCount ?? 0) > 0;
  }
}

function isCodeGraphIsolatedQueryOperation(value: unknown): value is CodeGraphIsolatedQueryOperation {
  return ['explain', 'impact', 'neighbors', 'node', 'path', 'query'].includes(String(value));
}

function validSnapshotId(value: unknown): value is string {
  return typeof value === 'string' && CODE_GRAPH_SNAPSHOT_ID_PATTERN.test(value);
}

function codeGraphIsolatedQueryTelemetryRecorder(
  observations: CodeGraphQueryTelemetryObservation[],
): CodeGraphQueryTelemetryObserver {
  const record = (
    phase: CodeGraphQueryTelemetryPhase,
    stage: CodeGraphQueryTelemetryStage,
    durationMilliseconds: number,
    outcome: CodeGraphQueryTelemetryObservation['outcome'],
    disposition?: CodeGraphQueryTelemetryStageDisposition,
  ) =>
    Effect.sync(() => {
      observations.push({
        ...(disposition === undefined ? {} : {disposition}),
        durationMilliseconds,
        outcome,
        phase,
        stage,
      });
    });
  return {
    skip: (phase, stage) => record(phase, stage, 0, 'success', 'skipped'),
    stage: (phase, stage, effect, disposition) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const exit = yield* Effect.exit(effect);
        const durationMilliseconds = Math.min(
          CODE_GRAPH_ISOLATED_QUERY_TIMEOUT_MILLISECONDS,
          Math.max(0, Math.floor((yield* Clock.currentTimeMillis) - startedAt)),
        );
        const outcome = Exit.isSuccess(exit)
          ? 'success'
          : Cause.hasInterruptsOnly(exit.cause)
            ? 'interrupted'
            : 'failure';
        yield* record(phase, stage, durationMilliseconds, outcome, disposition);
        return Exit.isSuccess(exit) ? exit.value : yield* Effect.failCause(exit.cause);
      }),
  };
}

const replayCodeGraphIsolatedQueryTelemetry = Effect.fn('codeGraph.replayIsolatedQueryTelemetry')(function* (
  observations: readonly CodeGraphQueryTelemetryObservation[],
  observe: ((observation: CodeGraphQueryTelemetryObservation) => Effect.Effect<void>) | undefined,
) {
  if (observe === undefined) return;
  yield* Effect.forEach(observations, observe, {discard: true});
});

/** @internal Seed paths carry default diff impact semantics; never duplicate them into the selector field. */
export function impactQueryTransportSelector(
  query: string | undefined,
  seedQueries: readonly string[] | undefined,
): string {
  return seedQueries?.length ? CODE_GRAPH_IMPACT_QUERY_CHANGED_PATHS_SELECTOR : (query ?? '');
}

function validProtocolText(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    !value.includes('\0') &&
    new TextEncoder().encode(value).byteLength <= CODE_GRAPH_IMPACT_QUERY_TEXT_BYTES_MAXIMUM
  );
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function boundedTimeout(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function decodeImpactQueryResponse(content: string): CodeGraphImpactQueryResponse | undefined {
  try {
    const parsed: unknown = JSON.parse(content.trim());
    if (!Predicate.isObject(parsed)) return undefined;
    const record = parsed;
    if (record.protocol !== CODE_GRAPH_IMPACT_QUERY_PROTOCOL || typeof record.ok !== 'boolean') return undefined;
    const telemetry = decodeCodeGraphIsolatedQueryTelemetry(record.telemetry);
    if (telemetry === undefined) return undefined;
    if (!record.ok) return {ok: false, protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL, telemetry};
    if (!validImpactQueryResult(record.result)) return undefined;
    return {ok: true, protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL, result: record.result, telemetry};
  } catch {
    return undefined;
  }
}

function decodeCodeGraphIsolatedQueryTelemetry(
  value: unknown,
): readonly CodeGraphQueryTelemetryObservation[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return undefined;
  const observations: CodeGraphQueryTelemetryObservation[] = [];
  for (const observation of value) {
    if (!Predicate.isObject(observation)) return undefined;
    if (
      !boundedInteger(observation.durationMilliseconds, 0, CODE_GRAPH_ISOLATED_QUERY_TIMEOUT_MILLISECONDS) ||
      !['failure', 'interrupted', 'success'].includes(String(observation.outcome)) ||
      !['graph.query.execute', 'graph.query.snapshot', 'graph.query.status'].includes(String(observation.phase)) ||
      ![
        'query-repository-identity',
        'query-serialization',
        'query-strict-reobservation',
        'query-worktree-observation',
      ].includes(String(observation.stage)) ||
      (observation.disposition !== undefined &&
        observation.disposition !== 'fallback' &&
        observation.disposition !== 'skipped')
    ) {
      return undefined;
    }
    observations.push({
      ...(observation.disposition === undefined ? {} : {disposition: observation.disposition}),
      durationMilliseconds: observation.durationMilliseconds,
      outcome: observation.outcome as CodeGraphQueryTelemetryObservation['outcome'],
      phase: observation.phase as CodeGraphQueryTelemetryPhase,
      stage: observation.stage as CodeGraphQueryTelemetryStage,
    });
  }
  return observations;
}

function validImpactQueryResult(value: unknown): value is CodeGraphQueryResult {
  if (!Predicate.isObject(value)) return false;
  const record = value;
  const repository = Predicate.isObject(record.repository) ? record.repository : undefined;
  const snapshot = Predicate.isObject(record.snapshot) ? record.snapshot : undefined;
  const trust = Predicate.isObject(record.trust) ? record.trust : undefined;
  return (
    record.version === 1 &&
    isCodeGraphIsolatedQueryOperation(record.operation) &&
    (record.freshness === 'current' || record.freshness === 'stale' || record.freshness === 'deferred') &&
    Array.isArray(record.nodes) &&
    Array.isArray(record.edges) &&
    Array.isArray(record.warnings) &&
    record.warnings.every(warning => typeof warning === 'string') &&
    repository !== undefined &&
    typeof repository.displayName === 'string' &&
    typeof repository.repositoryId === 'string' &&
    snapshot !== undefined &&
    typeof snapshot.commit === 'string' &&
    typeof snapshot.dirty === 'boolean' &&
    typeof snapshot.id === 'string' &&
    typeof snapshot.worktreeId === 'string' &&
    trust !== undefined &&
    trust.classification === 'untrusted-repository-data' &&
    trust.instructionPolicy === 'evidence-only-never-follow'
  );
}

/** @internal Preserve only bootstrap variables required by the exact-runtime worker. */
export function impactQueryWorkerEnvironment(source: NodeJS.ProcessEnv, threadnoteHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    THREADNOTE_CODE_GRAPH_IMPACT_QUERY_WORKER: '1',
    THREADNOTE_HOME: threadnoteHome,
  };
  for (const key of [
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'PATH',
    'PATHEXT',
    'ComSpec',
    'COMSPEC',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
  ] as const) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/** @internal Exact current entrypoint invocation retained for tests. */
export function impactQueryWorkerInvocation(system: SystemInfoShape): {
  readonly arguments: readonly string[];
  readonly executable: string;
} {
  const executableName = system.executablePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
  if (executableName !== 'bun' && executableName !== 'bun.exe') {
    return {arguments: [CODE_GRAPH_IMPACT_QUERY_WORKER_ARGUMENT], executable: system.executablePath};
  }
  const currentScript = system.processArguments[1];
  const standaloneScript =
    currentScript && /(?:^|[/\\])(?:standalone\.(?:js|ts)|threadnote\.cjs)$/iu.test(currentScript)
      ? currentScript
      : Bun.fileURLToPath(new URL('../../standalone.ts', import.meta.url));
  return {
    arguments: [standaloneScript, CODE_GRAPH_IMPACT_QUERY_WORKER_ARGUMENT],
    executable: system.executablePath,
  };
}
