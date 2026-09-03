import {Effect, Predicate, Schema, Stdio, Stream} from 'effect';
import {CommandExecutor, CommandTimedOut, type CommandExecutionError} from '../effect/command.js';
import {SystemInfo, type SystemInfoShape} from '../effect/system.js';
import {CODE_GRAPH_IMPACT_QUERY_WORKER_ARGUMENT} from '../worker_protocol.js';
import {CodeGraphQueryService, type CodeGraphInspectOptions} from './query.js';
import type {CodeGraphQueryResult} from './types.js';

const CODE_GRAPH_IMPACT_QUERY_PROTOCOL = 1 as const;
const CODE_GRAPH_IMPACT_QUERY_INPUT_BYTES_MAXIMUM = 256 * 1_024;
const CODE_GRAPH_IMPACT_QUERY_OUTPUT_BYTES_MAXIMUM = 2 * 1_024 * 1_024;
const CODE_GRAPH_IMPACT_QUERY_TEXT_BYTES_MAXIMUM = 64 * 1_024;
const CODE_GRAPH_IMPACT_QUERY_SEED_LIMIT = 200;
const CODE_GRAPH_IMPACT_QUERY_CHANGED_PATHS_SELECTOR = 'changed paths';
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
export const CODE_GRAPH_IMPACT_QUERY_TIMEOUT_MILLISECONDS = 20_000;

interface CodeGraphImpactQueryRequest {
  readonly baseCommit?: string;
  readonly cwd: string;
  readonly depth?: number;
  readonly edgeLimit: number;
  readonly includeHeuristic?: boolean;
  readonly includeModelAssociations?: boolean;
  readonly nodeLimit: number;
  readonly protocol: typeof CODE_GRAPH_IMPACT_QUERY_PROTOCOL;
  readonly query: string;
  /** Original count retained when the transport bounds changed-path content. */
  readonly seedQueryCount?: number;
  readonly seedQueries?: readonly string[];
  readonly threadnoteHome: string;
}

type CodeGraphImpactQueryResponse =
  | {
      readonly ok: true;
      readonly protocol: typeof CODE_GRAPH_IMPACT_QUERY_PROTOCOL;
      readonly result: CodeGraphQueryResult;
    }
  | {readonly ok: false; readonly protocol: typeof CODE_GRAPH_IMPACT_QUERY_PROTOCOL};

export interface IsolatedCodeGraphImpactQueryInput {
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
 * Execute correctness-sensitive impact reads outside the MCP event loop.
 * Bun SQLite calls are synchronous, so an in-process busy or cold query can
 * otherwise prevent the MCP timeout fiber from running before its client does.
 */
export const inspectCodeGraphImpactIsolated = Effect.fn('codeGraph.impactQueryIsolated')(function* (
  input: IsolatedCodeGraphImpactQueryInput,
  options: {readonly timeoutMilliseconds?: number} = {},
) {
  const command = yield* CommandExecutor;
  const system = yield* SystemInfo;
  const timeoutMilliseconds = boundedTimeout(options.timeoutMilliseconds);
  const request = yield* Effect.try({
    try: () => encodeImpactQueryRequest(input),
    catch: cause =>
      Schema.is(IsolatedCodeGraphImpactQueryError)(cause)
        ? cause
        : IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph impact query request is invalid.'}),
  });
  const invocation = impactQueryWorkerInvocation(system);
  const timeout = IsolatedCodeGraphImpactQueryTimedOut.make({message: 'Isolated code graph impact query timed out.'});
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
          : IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph impact query failed.'}),
      ),
      Effect.timeoutOrElse({duration: timeoutMilliseconds, orElse: () => Effect.fail(timeout)}),
    );
  const result = yield* execute;
  const response = decodeImpactQueryResponse(result.stdout);
  if (response === undefined || !response.ok) {
    return yield* IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph impact query failed.'});
  }
  return response.result;
});

/** Internal standalone worker. Input and output are bounded one-document JSON over stdio. */
export const codeGraphImpactQueryWorkerProgram = (threadnoteHome: string) =>
  Effect.gen(function* () {
    const request = yield* readImpactQueryWorkerRequest;
    const query = yield* CodeGraphQueryService;
    const response =
      request === undefined || request.threadnoteHome !== threadnoteHome
        ? ({ok: false, protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL} as const)
        : yield* query.inspect(impactQueryWorkerInspectOptions(request, threadnoteHome)).pipe(
            Effect.match({
              onFailure: () => ({ok: false, protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL}) as const,
              onSuccess: result =>
                ({
                  ok: true,
                  protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL,
                  result,
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
    ...(request.baseCommit === undefined ? {} : {baseCommit: request.baseCommit}),
    baseCommitPolicy: 'ready-only',
    cwd: request.cwd,
    depth: request.depth,
    edgeLimit: request.edgeLimit,
    includeHeuristic: request.includeHeuristic,
    includeModelAssociations: request.includeModelAssociations,
    nodeLimit: request.nodeLimit,
    operation: 'impact',
    query: request.query,
    refresh: false,
    requestMaintenance: false,
    seedQueryCount: request.seedQueryCount,
    seedQueries: request.seedQueries,
    strictFreshness: true,
    threadnoteHome,
  };
}

function encodeImpactQueryRequest(input: IsolatedCodeGraphImpactQueryInput): Uint8Array {
  const seedQueries = input.seedQueries?.slice(0, CODE_GRAPH_IMPACT_QUERY_SEED_LIMIT);
  const request = {
    ...(input.baseCommit === undefined ? {} : {baseCommit: input.baseCommit}),
    cwd: input.cwd,
    ...(input.depth === undefined ? {} : {depth: input.depth}),
    edgeLimit: input.edgeLimit,
    ...(input.includeHeuristic === undefined ? {} : {includeHeuristic: input.includeHeuristic}),
    ...(input.includeModelAssociations === undefined ? {} : {includeModelAssociations: input.includeModelAssociations}),
    nodeLimit: input.nodeLimit,
    protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL,
    query: impactQueryTransportSelector(input.query, input.seedQueries),
    ...(input.seedQueries === undefined ? {} : {seedQueries, seedQueryCount: input.seedQueries.length}),
    threadnoteHome: input.threadnoteHome,
  } satisfies CodeGraphImpactQueryRequest;
  if (!validImpactQueryRequest(request)) {
    throw IsolatedCodeGraphImpactQueryError.make({message: 'Isolated code graph impact query request is invalid.'});
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
    !validProtocolText(record.cwd) ||
    !validProtocolText(record.threadnoteHome) ||
    !validProtocolText(record.query, true) ||
    !boundedInteger(record.nodeLimit, 1, 200) ||
    !boundedInteger(record.edgeLimit, 1, 500) ||
    (record.depth !== undefined && !boundedInteger(record.depth, 0, 8)) ||
    (record.includeHeuristic !== undefined && typeof record.includeHeuristic !== 'boolean') ||
    (record.includeModelAssociations !== undefined && typeof record.includeModelAssociations !== 'boolean') ||
    (record.seedQueryCount !== undefined && !boundedInteger(record.seedQueryCount, 0, Number.MAX_SAFE_INTEGER)) ||
    (record.baseCommit !== undefined &&
      (typeof record.baseCommit !== 'string' || !GIT_OBJECT_ID_PATTERN.test(record.baseCommit)))
  ) {
    return false;
  }
  const seeds = record.seedQueries;
  if (seeds === undefined) return record.query !== '' && record.seedQueryCount === undefined;
  if (!Array.isArray(seeds) || seeds.length > CODE_GRAPH_IMPACT_QUERY_SEED_LIMIT) return false;
  const seedQueryCount = record.seedQueryCount ?? seeds.length;
  return (
    seedQueryCount >= seeds.length &&
    seeds.every(value => validProtocolText(value)) &&
    (record.query !== '' || seedQueryCount > 0)
  );
}

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

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return CODE_GRAPH_IMPACT_QUERY_TIMEOUT_MILLISECONDS;
  return Math.max(1, Math.min(CODE_GRAPH_IMPACT_QUERY_TIMEOUT_MILLISECONDS, Math.floor(value)));
}

function decodeImpactQueryResponse(content: string): CodeGraphImpactQueryResponse | undefined {
  try {
    const parsed: unknown = JSON.parse(content.trim());
    if (!Predicate.isObject(parsed)) return undefined;
    const record = parsed;
    if (record.protocol !== CODE_GRAPH_IMPACT_QUERY_PROTOCOL || typeof record.ok !== 'boolean') return undefined;
    if (!record.ok) return {ok: false, protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL};
    if (!validImpactQueryResult(record.result)) return undefined;
    return {ok: true, protocol: CODE_GRAPH_IMPACT_QUERY_PROTOCOL, result: record.result};
  } catch {
    return undefined;
  }
}

function validImpactQueryResult(value: unknown): value is CodeGraphQueryResult {
  if (!Predicate.isObject(value)) return false;
  const record = value;
  const repository = Predicate.isObject(record.repository) ? record.repository : undefined;
  const snapshot = Predicate.isObject(record.snapshot) ? record.snapshot : undefined;
  const trust = Predicate.isObject(record.trust) ? record.trust : undefined;
  return (
    record.version === 1 &&
    record.operation === 'impact' &&
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
      : Bun.fileURLToPath(new URL('../standalone.ts', import.meta.url));
  return {
    arguments: [standaloneScript, CODE_GRAPH_IMPACT_QUERY_WORKER_ARGUMENT],
    executable: system.executablePath,
  };
}
