import * as BunStdio from '@effect/platform-bun/BunStdio';
import {Cause, Context, Effect, Layer, Logger, Option, Schema, Sink, Stdio} from 'effect';
import {McpProtocol, McpSchema, McpServer} from 'effect/unstable/ai';
import * as HttpRouter from 'effect/unstable/http/HttpRouter';
import * as HttpEffect from 'effect/unstable/http/HttpEffect';
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse';
import {RpcMessage, RpcSerialization, RpcServer} from 'effect/unstable/rpc';
import {applicationError, fromPromise} from '../errors.js';
import type {ApplicationServices} from '../runtime.js';
import {omitProductionLogPhaseRecorder, withProductionLogging} from '../production_log.js';
import {
  attachAnonymousTelemetryError,
  copyAnonymousTelemetryMetadata,
  readAnonymousTelemetryReportedOutcome,
} from '../../telemetry/diagnostic.js';
import {isMemoryReadRecoveryV1, type MemoryReadRecoveryV1} from '../../memory/read_recovery.js';
import {omitAnonymousTelemetryRecorder, withAnonymousTelemetry} from '../telemetry.js';

// Windows antivirus and filesystem scheduling can make an otherwise healthy
// append exceed 50 ms. Keep MCP diagnostics best-effort and bounded without
// routinely dropping the completion record that explains a returned error.
const MCP_PRODUCTION_LOG_WRITE_TIMEOUT_MILLISECONDS = 500;
const EFFECT_RPC_CAUSE_MARKER = new TextEncoder().encode('"_tag":"Cause"');
const MCP_RESOURCE_ERROR_BRAND_KEY = 'threadnote.io/resource-read-error';
const MCP_RESOURCE_MEMORY_RECOVERY_KEY = 'threadnote.io/memory-read-recovery';
export const MCP_RESOURCE_ERROR_DATA = Object.freeze({[MCP_RESOURCE_ERROR_BRAND_KEY]: 1});
export const MCP_RESOURCE_NOT_FOUND_ERROR_DATA = Object.freeze({[MCP_RESOURCE_ERROR_BRAND_KEY]: 2});
export const MCP_PROGRESS_HEARTBEAT_MILLISECONDS = 10_000;
export const MCP_PROGRESS_MESSAGE_MAX_BYTES = 160;
export const MCP_PROGRESS_METADATA_KEY = 'threadnote.io/progress';
const MCP_PROGRESS_TEST_HEARTBEAT_ENV = 'THREADNOTE_TEST_MCP_PROGRESS_HEARTBEAT_MILLISECONDS';
const MCP_PROGRESS_PHASE_MAX_CHARACTERS = 64;
const MCP_PROGRESS_INTERVAL_MAX_MILLISECONDS = 300_000;
const MCP_PROGRESS_ENCODER = new TextEncoder();
const MCP_PROGRESS_DECODER = new TextDecoder();
const MCP_PROGRESS_BRIDGED_SERVERS = new WeakSet<object>();
const MCP_PROTOCOLS = [
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
] as const;
const MCP_PROGRESS_GENERATION_METADATA_KEY = 'threadnote.io/private/progress-generation';
const MCP_INVALID_BATCH_METHOD = 'invalid/json-rpc-batch';
const MCP_HTTP_CANCELLATION_UNSUPPORTED_MESSAGE =
  'Streamable HTTP cancellation is not supported until requests can be interrupted across POSTs.';

export function mcpResourceNotFoundRecoveryErrorData(
  recovery: MemoryReadRecoveryV1,
): Readonly<Record<string, unknown>> {
  if (!isMemoryReadRecoveryV1(recovery)) throw new TypeError('Invalid memory-read recovery payload.');
  return Object.freeze({
    [MCP_RESOURCE_ERROR_BRAND_KEY]: 2,
    [MCP_RESOURCE_MEMORY_RECOVERY_KEY]: recovery,
  });
}

export function mcpProgressHeartbeatMilliseconds(environment: NodeJS.ProcessEnv): number {
  if (environment.NODE_ENV !== 'test') return MCP_PROGRESS_HEARTBEAT_MILLISECONDS;
  const configured = Number(environment[MCP_PROGRESS_TEST_HEARTBEAT_ENV]);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : MCP_PROGRESS_HEARTBEAT_MILLISECONDS;
}

export function mcpRequestIdKey(value: string | number): string {
  return `${typeof value === 'number' ? 'number' : 'string'}:${String(value)}`;
}

function mcpProgressTokenKey(progressToken: McpSchema.ProgressToken): string {
  return mcpRequestIdKey(progressToken);
}

function callProgressToken(request: RpcMessage.RequestEncoded): McpSchema.ProgressToken | undefined {
  if (request.tag !== 'tools/call' || typeof request.payload !== 'object' || request.payload === null) return undefined;
  const metadata = '_meta' in request.payload ? request.payload._meta : undefined;
  if (typeof metadata !== 'object' || metadata === null || !('progressToken' in metadata)) return undefined;
  const progressToken = metadata.progressToken;
  return typeof progressToken === 'number' || typeof progressToken === 'string' ? progressToken : undefined;
}

interface ToolAnnotations {
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
  readonly readOnlyHint?: boolean;
  readonly title?: string;
}

type ToolFields = {
  readonly [key: PropertyKey]: Schema.ConstraintCodec<unknown, unknown, never, never>;
};

interface ToolDefinition<Fields extends ToolFields> {
  readonly annotations?: ToolAnnotations;
  readonly description?: string;
  readonly inputSchema: Fields;
}

interface ToolResult {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly content: readonly unknown[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

export interface McpProgressUpdate {
  readonly message: string;
  readonly phase: string;
}

export interface McpProgressNotificationPayload {
  readonly _meta: Readonly<{
    readonly [MCP_PROGRESS_METADATA_KEY]: Readonly<{
      readonly phase: string;
      readonly version: 1;
    }>;
  }>;
  readonly message: string;
  readonly progress: number;
  readonly progressToken: McpSchema.ProgressToken;
}

export interface McpToolProgress {
  readonly enabled: boolean;
  readonly report: (update: McpProgressUpdate) => Effect.Effect<void, never>;
}

export interface McpRequestContext {
  readonly correlationId?: string;
  readonly deadlineEpochMilliseconds?: number;
  readonly identity?: unknown;
  readonly policy?: unknown;
  readonly transport: 'http' | 'stdio';
}

export interface McpHttpRequestContext {
  readonly correlationId: string;
  readonly deadlineEpochMilliseconds?: number;
  readonly identity?: unknown;
  readonly policy?: unknown;
}

// Resolve authentication and policy from the live HTTP request. Implementations
// must return only bounded, already-validated values: credentials and raw token
// claims must never enter tool arguments or McpToolCallContext. Failing with an
// HTTP response rejects the complete endpoint request before MCP dispatch.
export type McpHttpRequestContextResolver = (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<McpHttpRequestContext, HttpServerResponse.HttpServerResponse>;

export interface McpHttpTransportOptions {
  readonly allowedOrigins?: ReadonlyArray<string>;
  readonly path: HttpRouter.PathInput;
  readonly resolveRequestContext: McpHttpRequestContextResolver;
}

export interface McpToolCallContext {
  readonly progress: McpToolProgress;
  readonly requestContext: McpRequestContext;
}

interface RegisteredTool {
  readonly definition: ToolDefinition<ToolFields>;
  readonly handle: (args: Record<string, unknown>, context: McpToolCallContext) => ToolHandlerResult;
  readonly name: string;
}

type ToolHandlerResult = ToolResult | Effect.Effect<ToolResult, unknown, ApplicationServices> | PromiseLike<ToolResult>;

/** @internal Adapt the SDK result class without dropping private telemetry metadata. */
export function mcpCallToolResultWithTelemetryMetadata(result: ToolResult): McpSchema.CallToolResult {
  // Effect 4 validates structuredContent as Schema.Json when the result class is
  // constructed. Threadnote tool projections use idiomatic optional object
  // properties, whose undefined values are omitted by the JSON wire format.
  // Apply that exact wire normalization before validation so the stricter SDK
  // constructor observes the payload clients would actually receive.
  const normalized =
    result.structuredContent === undefined
      ? result
      : {...result, structuredContent: JSON.parse(JSON.stringify(result.structuredContent)) as unknown};
  return copyAnonymousTelemetryMetadata(new McpSchema.CallToolResult(normalized as McpSchema.CallToolResult), result);
}

interface ResourceTemplateDefinition {
  readonly description?: string;
  readonly meta?: Readonly<Record<string, boolean | number | string>>;
  readonly mimeType?: string;
  readonly name: string;
  readonly routerPath: string;
  readonly uriTemplate: string;
}

interface RegisteredResourceTemplate {
  readonly definition: ResourceTemplateDefinition;
  readonly handle: ResourceTemplateHandler;
}

type ResourceTemplateHandler = (
  uri: string,
  context: McpRequestContext,
) => Effect.Effect<
  typeof McpSchema.ReadResourceResult.Type,
  McpSchema.InternalError | McpSchema.InvalidParams,
  ApplicationServices
>;

const DISABLED_MCP_TOOL_PROGRESS: McpToolProgress = Object.freeze({
  enabled: false,
  report: () => Effect.void,
});

const CurrentMcpToolProgress = Context.Reference<McpToolProgress>('threadnote/CurrentMcpToolProgress', {
  defaultValue: () => DISABLED_MCP_TOOL_PROGRESS,
});

const CurrentMcpRequestContext = Context.Reference<McpRequestContext>('threadnote/CurrentMcpRequestContext', {
  defaultValue: () => Object.freeze({transport: 'stdio'}),
});

interface McpProgressRequestAssociation {
  readonly generation: string;
  readonly progressToken: McpSchema.ProgressToken;
  readonly progressTokenKey: string;
}

const CurrentMcpProgressRequestAssociation = Context.Reference<McpProgressRequestAssociation | undefined>(
  'threadnote/CurrentMcpProgressRequestAssociation',
  {defaultValue: () => undefined},
);

export function mcpProgressNotificationForCurrentRequest(
  notification: McpProgressNotificationPayload,
): Effect.Effect<McpProgressNotificationPayload> {
  return Effect.map(CurrentMcpProgressRequestAssociation, association =>
    association === undefined || association.progressTokenKey !== mcpProgressTokenKey(notification.progressToken)
      ? notification
      : {
          ...notification,
          _meta: {...notification._meta, [MCP_PROGRESS_GENERATION_METADATA_KEY]: association.generation},
        },
  );
}

export interface McpRegistrationLayerOptions {
  readonly prepareServer?: (server: EffectMcpServer) => void;
  readonly productionLogHome?: string;
}

export class EffectMcpServerRegistry {
  readonly #resourceTemplates: RegisteredResourceTemplate[] = [];
  readonly #tools: RegisteredTool[] = [];

  registerTool<const Fields extends ToolFields>(
    name: string,
    definition: ToolDefinition<Fields>,
    handle: (args: Schema.Struct.Type<Fields>, context: McpToolCallContext) => ToolHandlerResult,
  ): void {
    this.#tools.push({
      definition,
      handle: (args, context) => handle(args as Schema.Struct.Type<Fields>, context),
      name,
    });
  }

  registerResourceTemplate(definition: ResourceTemplateDefinition, handle: ResourceTemplateHandler): void {
    this.#resourceTemplates.push({definition, handle});
  }

  registrationLayer(
    options: McpRegistrationLayerOptions = {},
  ): Layer.Layer<never, never, McpServer.McpServer | ApplicationServices> {
    const resourceTemplates = [...this.#resourceTemplates];
    const registrations = [...this.#tools];
    const productionLogHome = options.productionLogHome;
    return Layer.effectDiscard(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        options.prepareServer?.(server);
        const applicationServices = omitAnonymousTelemetryRecorder(
          omitProductionLogPhaseRecorder(yield* Effect.context<ApplicationServices>()),
        );
        for (const registration of resourceTemplates) {
          yield* server.addResourceTemplate({
            annotations: Context.empty(),
            completions: {},
            handle: uri =>
              Effect.flatMap(CurrentMcpRequestContext, requestContext =>
                withAnonymousTelemetry(
                  {component: 'mcp', operation: 'resource-read'},
                  registration.handle(uri, requestContext),
                ).pipe(Effect.provideContext(applicationServices)),
              ).pipe(Effect.catchCause(mcpResourceFailureResult)),
            routerPath: registration.definition.routerPath,
            template: new McpSchema.ResourceTemplate({
              _meta: registration.definition.meta,
              description: registration.definition.description,
              mimeType: registration.definition.mimeType,
              name: registration.definition.name,
              uriTemplate: registration.definition.uriTemplate,
            }),
          });
        }
        for (const registration of registrations) {
          const input = Schema.Struct(registration.definition.inputSchema);
          const inputSchema =
            Object.keys(registration.definition.inputSchema).length === 0
              ? {additionalProperties: false, properties: {}, type: 'object'}
              : flattenJsonSchemaConstraints(Schema.toJsonSchemaDocument(input).schema);
          yield* server.addTool({
            annotations: Context.empty(),
            tool: new McpSchema.Tool({
              annotations: registration.definition.annotations,
              description: registration.definition.description,
              inputSchema,
              name: registration.name,
            }),
            handle: payload =>
              Effect.flatMap(CurrentMcpProgressRequestAssociation, association =>
                Effect.flatMap(McpSchema.McpServerClient, client =>
                  Effect.flatMap(CurrentMcpToolProgress, inheritedProgress => {
                    // RC.112's live protocol handlers dispatch through the
                    // internal tool core instead of public server.callTool.
                    // Rehydrate Threadnote progress at this surviving Effect
                    // context boundary; HTTP has no transport association and
                    // therefore keeps the inherited disabled implementation.
                    const progress =
                      association === undefined
                        ? inheritedProgress
                        : makeMcpToolProgress(
                            admitMcpProgressToken(
                              association.progressToken,
                              client.clientId,
                              server.initializedClients,
                            ),
                            notification =>
                              mcpProgressNotificationForCurrentRequest(notification).pipe(
                                Effect.flatMap(outgoingNotification =>
                                  mcpProgressCanRouteToClient(server.initializedClients, client.clientId)
                                    ? server.notifications['notifications/progress'](outgoingNotification)
                                    : Effect.void,
                                ),
                              ),
                          );
                    return Effect.flatMap(CurrentMcpRequestContext, requestContext => {
                      const handling = Schema.decodeUnknownEffect(input, {errors: 'all'})(payload).pipe(
                        Effect.flatMap(parsed =>
                          toolHandlerEffect(
                            () => registration.handle(parsed, {progress, requestContext}),
                            applicationServices,
                          ).pipe(
                            Effect.matchCauseEffect({
                              onFailure: mcpToolFailureResult,
                              onSuccess: result => Effect.succeed(mcpCallToolResultWithTelemetryMetadata(result)),
                            }),
                          ),
                        ),
                        Effect.catchCause(mcpToolFailureResult),
                      );
                      const loggedHandling =
                        productionLogHome === undefined
                          ? handling
                          : withProductionLogging(
                              productionLogHome,
                              {
                                component: 'mcp',
                                operation: registration.name,
                                reportedFailure: result => result.isError === true,
                                reportedFailureType: 'McpToolError',
                                writeTimeoutMilliseconds: MCP_PRODUCTION_LOG_WRITE_TIMEOUT_MILLISECONDS,
                              },
                              handling,
                            );
                      return withAnonymousTelemetry(
                        {
                          component: 'mcp',
                          operation: registration.name,
                          reportedFailure: result => result.isError === true,
                          reportedFailureType: 'McpToolError',
                          reportedOutcome: readAnonymousTelemetryReportedOutcome,
                        },
                        loggedHandling,
                      ).pipe(Effect.provideContext(applicationServices));
                    });
                  }),
                ),
              ),
          });
        }
      }),
    );
  }
}

export class EffectMcpServerAdapter extends EffectMcpServerRegistry {
  constructor(
    readonly name: string,
    readonly version: string,
    readonly instructions: string,
    readonly productionLogHome?: string,
  ) {
    super();
  }

  runStdio(): Effect.Effect<never, never, ApplicationServices> {
    return Layer.launch(
      this.registrationLayer({
        prepareServer: installCallToolProgressBridge,
        productionLogHome: this.productionLogHome,
      }).pipe(
        Layer.provide(mcpStdioLayer({name: this.name, version: this.version})),
        Layer.provide(stdioWithInstructionsLayer(this.instructions)),
        Layer.provide(Layer.succeed(Logger.LogToStderr)(true)),
      ),
    );
  }

  run(): Effect.Effect<never, never, ApplicationServices> {
    return this.runStdio();
  }

  httpLayer(options: McpHttpTransportOptions): Layer.Layer<never, never, ApplicationServices | HttpRouter.HttpRouter> {
    const requestContextMiddleware = mcpHttpRequestContextMiddleware(options.resolveRequestContext, this.instructions);
    // Do not install the stdio compatibility bridge here. It intentionally
    // enforces one lifetime client, while Streamable HTTP must preserve SDK
    // client/session isolation for concurrent principals.
    const serverLayer = McpServer.layerHttp({
      allowedOrigins: options.allowedOrigins,
      name: this.name,
      path: options.path,
      protocols: MCP_PROTOCOLS,
      version: this.version,
    }).pipe(Layer.orDie, Layer.provide(requestContextMiddleware.layer));
    return this.registrationLayer({productionLogHome: this.productionLogHome}).pipe(Layer.provide(serverLayer));
  }
}

function mcpHttpRequestContextMiddleware(resolveRequestContext: McpHttpRequestContextResolver, instructions: string) {
  return HttpRouter.middleware(httpEffect =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, request =>
      Effect.matchEffect(
        Effect.suspend(() => resolveRequestContext(request)),
        {
          onFailure: response => Effect.succeed(response),
          onSuccess: requestContext =>
            Effect.flatMap(inspectMcpHttpRequest(request), inspection =>
              inspection.rejection === undefined
                ? httpEffect.pipe(
                    HttpEffect.withPreResponseHandler((_request, response) =>
                      Effect.succeed(repairMcpHttpResponse(response, inspection.initialize ? instructions : undefined)),
                    ),
                    Effect.provideService(
                      CurrentMcpRequestContext,
                      Object.freeze({...requestContext, transport: 'http'}),
                    ),
                  )
                : Effect.succeed(inspection.rejection),
            ),
        },
      ),
    ),
  );
}

interface McpHttpRequestInspection {
  readonly initialize: boolean;
  readonly rejection?: HttpServerResponse.HttpServerResponse;
}

function inspectMcpHttpRequest(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<McpHttpRequestInspection, never> {
  if (request.method !== 'POST') return Effect.succeed({initialize: false});
  return Effect.match(request.json, {
    onFailure: () => ({initialize: false}),
    onSuccess: body =>
      isMcpCancelledNotification(body)
        ? {
            initialize: false,
            rejection: HttpServerResponse.jsonUnsafe(
              {
                error: {code: -32_600, message: MCP_HTTP_CANCELLATION_UNSUPPORTED_MESSAGE},
                id: null,
                jsonrpc: '2.0',
              },
              {status: 400},
            ),
          }
        : {initialize: isMcpJsonRpcMethod(body, 'initialize')},
  });
}

function isMcpCancelledNotification(value: unknown): boolean {
  return isMcpJsonRpcMethod(value, 'notifications/cancelled');
}

function isMcpJsonRpcMethod(value: unknown, method: string): boolean {
  if (Array.isArray(value)) return value.some(item => isMcpJsonRpcMethod(item, method));
  return typeof value === 'object' && value !== null && 'method' in value && value.method === method;
}

function repairMcpHttpResponse(
  response: HttpServerResponse.HttpServerResponse,
  instructions: string | undefined,
): HttpServerResponse.HttpServerResponse {
  if (response.status !== 200 || response.body._tag !== 'Uint8Array' || response.body.contentLength === 0) {
    return response;
  }
  if (instructions === undefined && !couldContainEffectRpcCause(response.body.body)) return response;
  const repaired = repairMcpJsonRpcEnvelope(new TextDecoder().decode(response.body.body), instructions);
  return repaired === undefined
    ? response
    : HttpServerResponse.uint8Array(new TextEncoder().encode(JSON.stringify(repaired)), {
        contentType: response.body.contentType,
        cookies: response.cookies,
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
}

const MCP_CANCELLED_REQUEST_TOMBSTONE_LIMIT = 256;

interface McpCancellationTombstone {
  readonly progressTokenKey?: string;
}

interface McpActiveRequest {
  readonly externalId: string | number;
  readonly externalIdKey: string;
  readonly internalId: string;
  progressToken?: McpSchema.ProgressToken;
  progressTokenKey?: string;
}

interface McpProtocolClientState {
  readonly activeByExternalId: Map<string, McpActiveRequest>;
  readonly activeByInternalId: Map<string, McpActiveRequest>;
  readonly cancellationTombstones: Map<string, McpCancellationTombstone>;
  nextRequestGeneration: number;
  nextNotificationGeneration: number;
}

export function makeMcpCancellationCompatibleProtocol(
  protocol: RpcServer.Protocol['Service'],
): RpcServer.Protocol['Service'] {
  const clients = new Map<number, McpProtocolClientState>();
  const clientStateFor = (clientId: number) => {
    let state = clients.get(clientId);
    if (state === undefined) {
      state = {
        activeByExternalId: new Map(),
        activeByInternalId: new Map(),
        cancellationTombstones: new Map(),
        nextNotificationGeneration: 0,
        nextRequestGeneration: 0,
      };
      clients.set(clientId, state);
    }
    return state;
  };
  const activeRequestFor = (clientId: number, externalId: string | number) =>
    clients.get(clientId)?.activeByExternalId.get(mcpRequestIdKey(externalId));
  const registerRequest = (clientId: number, externalId: string | number) => {
    const state = clientStateFor(clientId);
    const externalIdKey = mcpRequestIdKey(externalId);
    const existing = state.activeByExternalId.get(externalIdKey);
    if (existing !== undefined) return existing;
    state.nextRequestGeneration += 1;
    const request: McpActiveRequest = {
      externalId,
      externalIdKey,
      internalId: `threadnote:mcp-request:${clientId}:${state.nextRequestGeneration}:${externalIdKey}`,
    };
    state.activeByExternalId.set(externalIdKey, request);
    state.activeByInternalId.set(request.internalId, request);
    return request;
  };
  const notificationRequestId = (clientId: number) => {
    const state = clientStateFor(clientId);
    state.nextNotificationGeneration += 1;
    return `threadnote:mcp-notification:${clientId}:${state.nextNotificationGeneration}`;
  };
  const unmatchedRequestId = (clientId: number, externalId: string | number) =>
    `threadnote:mcp-unmatched:${clientId}:${mcpRequestIdKey(externalId)}`;
  const forgetActiveRequest = (state: McpProtocolClientState, request: McpActiveRequest) => {
    if (state.activeByExternalId.get(request.externalIdKey) === request) {
      state.activeByExternalId.delete(request.externalIdKey);
    }
    state.activeByInternalId.delete(request.internalId);
  };
  const rememberCancellation = (clientId: number, request: McpActiveRequest) => {
    const state = clientStateFor(clientId);
    forgetActiveRequest(state, request);
    state.cancellationTombstones.delete(request.internalId);
    state.cancellationTombstones.set(request.internalId, {progressTokenKey: request.progressTokenKey});
    while (state.cancellationTombstones.size > MCP_CANCELLED_REQUEST_TOMBSTONE_LIMIT) {
      const oldest = state.cancellationTombstones.keys().next().value;
      if (oldest === undefined) break;
      state.cancellationTombstones.delete(oldest);
    }
  };
  const isCancelledProgressToken = (clientId: number, progressToken: McpSchema.ProgressToken, generation: unknown) => {
    const progressTokenKey = mcpProgressTokenKey(progressToken);
    const tombstones = clients.get(clientId)?.cancellationTombstones;
    if (tombstones === undefined) return false;
    if (typeof generation === 'string') {
      return tombstones.get(generation)?.progressTokenKey === progressTokenKey;
    }
    // Unassociated progress cannot be proven fresh. Fail closed while a
    // matching bounded tombstone exists rather than re-admitting a queued old
    // notification after token reuse.
    for (const tombstone of tombstones.values()) {
      if (tombstone.progressTokenKey === progressTokenKey) return true;
    }
    return false;
  };
  return RpcServer.Protocol.of({
    ...protocol,
    end: clientId => protocol.end(clientId).pipe(Effect.ensuring(Effect.sync(() => clients.delete(clientId)))),
    run: handle =>
      protocol.run((clientId, externalRequest) => {
        let request = externalRequest;
        let progressAssociation: McpProgressRequestAssociation | undefined;
        if (externalRequest._tag === 'Request' && externalRequest.tag.startsWith('notifications/')) {
          if (
            externalRequest.tag === 'notifications/cancelled' &&
            typeof externalRequest.payload === 'object' &&
            externalRequest.payload !== null &&
            'requestId' in externalRequest.payload &&
            (typeof externalRequest.payload.requestId === 'number' ||
              typeof externalRequest.payload.requestId === 'string')
          ) {
            const cancelledRequest = activeRequestFor(clientId, externalRequest.payload.requestId);
            const internalRequestId =
              cancelledRequest?.internalId ?? unmatchedRequestId(clientId, externalRequest.payload.requestId);
            if (cancelledRequest !== undefined) rememberCancellation(clientId, cancelledRequest);
            request = {
              ...externalRequest,
              id: notificationRequestId(clientId),
              payload: {...externalRequest.payload, requestId: internalRequestId},
            };
          } else {
            request = {...externalRequest, id: notificationRequestId(clientId)};
          }
        } else if (externalRequest._tag === 'Request') {
          const activeRequest = registerRequest(clientId, externalRequest.id);
          const progressToken = callProgressToken(externalRequest);
          if (progressToken !== undefined && activeRequest.progressTokenKey === undefined) {
            activeRequest.progressToken = progressToken;
            activeRequest.progressTokenKey = mcpProgressTokenKey(progressToken);
          }
          if (activeRequest.progressToken !== undefined && activeRequest.progressTokenKey !== undefined) {
            progressAssociation = {
              generation: activeRequest.internalId,
              progressToken: activeRequest.progressToken,
              progressTokenKey: activeRequest.progressTokenKey,
            };
          }
          request = {...externalRequest, id: activeRequest.internalId};
        } else if (externalRequest._tag === 'Ack' || externalRequest._tag === 'Interrupt') {
          const activeRequest = activeRequestFor(clientId, externalRequest.requestId);
          request = {
            ...externalRequest,
            requestId: activeRequest?.internalId ?? unmatchedRequestId(clientId, externalRequest.requestId),
          };
        }
        const handling = handle(clientId, request);
        return progressAssociation === undefined
          ? handling
          : handling.pipe(Effect.provideService(CurrentMcpProgressRequestAssociation, progressAssociation));
      }),
    send: (clientId, response, transferables) => {
      const mcpResponse = response as RpcMessage.FromServerEncoded | RpcMessage.RequestEncoded;
      const outgoingProgressPayload =
        mcpResponse._tag === 'Request' &&
        mcpResponse.tag === 'notifications/progress' &&
        typeof mcpResponse.payload === 'object' &&
        mcpResponse.payload !== null
          ? mcpResponse.payload
          : undefined;
      const outgoingProgressToken =
        outgoingProgressPayload !== undefined && 'progressToken' in outgoingProgressPayload
          ? outgoingProgressPayload.progressToken
          : undefined;
      const outgoingProgressMetadata: Readonly<Record<string, unknown>> | undefined =
        outgoingProgressPayload !== undefined &&
        '_meta' in outgoingProgressPayload &&
        typeof outgoingProgressPayload._meta === 'object' &&
        outgoingProgressPayload._meta !== null
          ? (outgoingProgressPayload._meta as Readonly<Record<string, unknown>>)
          : undefined;
      const progressGeneration = outgoingProgressMetadata?.[MCP_PROGRESS_GENERATION_METADATA_KEY];
      if (
        (typeof outgoingProgressToken === 'number' || typeof outgoingProgressToken === 'string') &&
        isCancelledProgressToken(clientId, outgoingProgressToken, progressGeneration)
      ) {
        return Effect.void;
      }
      let wireResponse = response;
      if (outgoingProgressPayload !== undefined && outgoingProgressMetadata !== undefined) {
        const {[MCP_PROGRESS_GENERATION_METADATA_KEY]: _generation, ...wireMetadata} = outgoingProgressMetadata;
        if (MCP_PROGRESS_GENERATION_METADATA_KEY in outgoingProgressMetadata) {
          wireResponse = {
            ...mcpResponse,
            payload: {...outgoingProgressPayload, _meta: wireMetadata},
          } as unknown as typeof response;
        }
      }
      if (response._tag !== 'Chunk' && response._tag !== 'Exit') {
        return protocol.send(clientId, wireResponse, transferables);
      }
      const internalRequestId = String(response.requestId);
      const state = clients.get(clientId);
      if (state?.cancellationTombstones.has(internalRequestId) === true) {
        return Effect.void;
      }
      const activeRequest = state?.activeByInternalId.get(internalRequestId);
      const externalResponse =
        activeRequest === undefined ? response : {...response, requestId: activeRequest.externalId};
      const sending = protocol.send(clientId, externalResponse, transferables);
      return response._tag === 'Exit' && state !== undefined && activeRequest !== undefined
        ? sending.pipe(Effect.ensuring(Effect.sync(() => forgetActiveRequest(state, activeRequest))))
        : sending;
    },
  });
}

const cancellationCompatibleProtocolLayer: Layer.Layer<RpcServer.Protocol, never, RpcServer.Protocol> = Layer.effect(
  RpcServer.Protocol,
  Effect.map(RpcServer.Protocol, makeMcpCancellationCompatibleProtocol),
);

function mcpStdioLayer(options: {
  readonly name: string;
  readonly version: string;
}): Layer.Layer<McpServer.McpServer | McpSchema.McpServerClient, never, Stdio.Stdio> {
  // Effect 4.0.0-rc.112 still stringifies notifications/cancelled.requestId before
  // looking up the running RPC fiber. Move every external request id into a
  // private type-tagged namespace at the transport boundary so cancellation
  // addresses the same fiber without aliasing numeric and string twins. The
  // wrapper restores the original id type on ordinary responses and drops
  // terminal/chunk/progress frames after cancellation because the client has
  // already retired that request.
  return McpServer.layer({...options, protocols: MCP_PROTOCOLS}).pipe(
    Layer.orDie,
    Layer.provide(cancellationCompatibleProtocolLayer),
    Layer.provide(RpcServer.layerProtocolStdio),
    Layer.provide(Layer.succeed(RpcSerialization.RpcSerialization, mcpStdioSerialization(MCP_PROTOCOLS))),
  );
}

/**
 * @internal Mirrors Effect 4.0.0-rc.112's revision-aware stdio batch policy
 * around Threadnote's cancellation protocol wrapper. The encoder additionally
 * requires the exact synthetic batch failure, avoiding relabeling unrelated
 * null-id protocol failures.
 */
export function mcpStdioSerialization(
  protocols: readonly [McpProtocol.ProtocolAdapter, ...McpProtocol.ProtocolAdapter[]],
): RpcSerialization.RpcSerialization['Service'] {
  const serialization = RpcSerialization.jsonRpc({contentType: 'application/json-rpc'});
  return RpcSerialization.RpcSerialization.of({
    codecFor: serialization.codecFor,
    contentType: serialization.contentType,
    includesFraming: true,
    makeUnsafe: () => {
      const frames = RpcSerialization.ndjson.makeUnsafe();
      const parser = serialization.makeUnsafe();
      let selectedProtocol: McpProtocol.ProtocolAdapter | undefined;
      return {
        decode: data => {
          const decoded: unknown[] = [];
          for (const frame of frames.decode(data)) {
            if (Array.isArray(frame)) {
              if (
                selectedProtocol?.transport.acceptsJsonRpcBatches !== true ||
                frame.length === 0 ||
                frame.some(mcpStdioInitializeMessage)
              ) {
                decoded.push({_tag: 'Request', headers: [], id: null, payload: null, tag: MCP_INVALID_BATCH_METHOD});
                continue;
              }
            } else if (mcpStdioInitializeMessage(frame)) {
              const offered = mcpStdioProtocolVersion(frame);
              selectedProtocol = protocols.find(protocol => protocol.protocolVersion === offered) ?? protocols[0];
            }
            decoded.push(...parser.decode(JSON.stringify(frame)));
          }
          return decoded;
        },
        encode: response => {
          if (mcpInvalidBatchExit(response)) {
            return `${JSON.stringify({
              error: {
                _tag: 'Cause',
                code: McpSchema.INVALID_REQUEST_ERROR_CODE,
                data: response.exit.cause,
                message: 'JSON-RPC batches are not supported',
              },
              id: null,
              jsonrpc: '2.0',
            })}\n`;
          }
          const encoded = parser.encode(response);
          return encoded === undefined ? undefined : `${encoded}\n`;
        },
      };
    },
  });
}

function mcpStdioInitializeMessage(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'method' in value && value.method === 'initialize';
}

function mcpStdioProtocolVersion(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('params' in value)) return undefined;
  const params = value.params;
  if (typeof params !== 'object' || params === null || !('protocolVersion' in params)) return undefined;
  return typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
}

function mcpInvalidBatchExit(response: unknown): response is {
  readonly _tag: 'Exit';
  readonly exit: {readonly _tag: 'Failure'; readonly cause: unknown};
  readonly requestId: null;
} {
  if (
    typeof response !== 'object' ||
    response === null ||
    !('_tag' in response) ||
    response._tag !== 'Exit' ||
    !('requestId' in response) ||
    response.requestId !== null ||
    !('exit' in response) ||
    typeof response.exit !== 'object' ||
    response.exit === null ||
    !('_tag' in response.exit) ||
    response.exit._tag !== 'Failure' ||
    !('cause' in response.exit) ||
    !Array.isArray(response.exit.cause) ||
    response.exit.cause.length !== 1
  ) {
    return false;
  }
  const failure = response.exit.cause[0];
  if (
    typeof failure !== 'object' ||
    failure === null ||
    !('_tag' in failure) ||
    failure._tag !== 'Fail' ||
    !('error' in failure) ||
    typeof failure.error !== 'object' ||
    failure.error === null ||
    !('message' in failure.error)
  ) {
    return false;
  }
  return failure.error.message === 'JSON-RPC batches are not supported';
}

export type EffectMcpServer = Context.Service.Shape<typeof McpServer.McpServer>;

export function installCallToolProgressBridge(server: EffectMcpServer): boolean {
  // Effect 4.0.0-rc.112's live protocol handlers bypass public callTool, so
  // registrationLayer rehydrates their progress from the transport context.
  // Keep this wrapper for direct callTool consumers and, more importantly,
  // install the lifetime-single-client recipient guard used by both paths.
  if (MCP_PROGRESS_BRIDGED_SERVERS.has(server)) return true;
  const callToolDescriptor = Object.getOwnPropertyDescriptor(server, 'callTool');
  const clientsDescriptor = Object.getOwnPropertyDescriptor(server, 'initializedClients');
  if (
    Object.isFrozen(server) ||
    !isWritableDataProperty(callToolDescriptor) ||
    !isWritableDataProperty(clientsDescriptor) ||
    clientsDescriptor.configurable !== true ||
    server.initializedClients.size > 1
  ) {
    return false;
  }
  const originalCallToolMethod = server.callTool;
  const originalInitializedClients = server.initializedClients;
  const stdioInitializedClients = new StdioSingleClientSet(originalInitializedClients);
  const writableServer = server as unknown as {callTool: EffectMcpServer['callTool']};
  const wrappedCallTool: EffectMcpServer['callTool'] = request =>
    Effect.gen(function* () {
      // McpServerClient middleware rejects non-initialize requests before
      // providing this service, so reaching this point cannot promote a
      // pre-initialize request into an authorized progress sender.
      const client = yield* McpSchema.McpServerClient;
      // A successfully dispatched tool request has the initialized
      // McpServerClient middleware, so admit that exact client only when the
      // request opted into progress.
      const progressToken = admitMcpProgressToken(
        request._meta?.progressToken,
        client.clientId,
        server.initializedClients,
      );
      const progress = makeMcpToolProgress(progressToken, notification =>
        mcpProgressNotificationForCurrentRequest(notification).pipe(
          Effect.flatMap(outgoingNotification =>
            mcpProgressCanRouteToClient(server.initializedClients, client.clientId)
              ? server.notifications['notifications/progress'](outgoingNotification)
              : Effect.void,
          ),
        ),
      );
      return yield* originalCallToolMethod
        .call(server, request)
        .pipe(Effect.provideService(CurrentMcpToolProgress, progress));
    });
  try {
    // Effect 4.0.0-rc.112's canonical notification queue broadcasts at drain time. This
    // adapter is permanently backed by layerStdio, so replace its recipient
    // registry with a non-replaceable lifetime-single-client set before any
    // request can enqueue progress. A late foreign add is ignored even if the
    // first client disconnected, closing the enqueue-to-drain token leak.
    Object.defineProperty(server, 'initializedClients', {
      configurable: false,
      enumerable: clientsDescriptor.enumerable,
      value: stdioInitializedClients,
      writable: false,
    });
    writableServer.callTool = wrappedCallTool;
    if (server.callTool !== wrappedCallTool) throw new Error('Effect MCP callTool bridge was not installed.');
  } catch {
    try {
      writableServer.callTool = originalCallToolMethod;
    } catch {
      // The stdio recipient invariant is installed before the handler wrapper,
      // so even a hostile setter that prevents restoration cannot turn this
      // failure into a cross-client notification path.
    }
    return false;
  }
  MCP_PROGRESS_BRIDGED_SERVERS.add(server);
  return true;
}

export function admitMcpProgressToken(
  progressToken: McpSchema.ProgressToken | undefined,
  clientId: number,
  initializedClients: Set<number>,
): McpSchema.ProgressToken | undefined {
  if (progressToken === undefined || !mcpProgressCanRouteToClient(initializedClients, clientId)) return undefined;
  initializedClients.add(clientId);
  return initializedClients.has(clientId) ? progressToken : undefined;
}

export class StdioSingleClientSet extends Set<number> {
  #clientId: number | undefined;

  constructor(initializedClients: ReadonlySet<number> = new Set()) {
    super();
    for (const clientId of initializedClients) this.add(clientId);
  }

  override add(clientId: number): this {
    this.#clientId ??= clientId;
    if (clientId === this.#clientId) super.add(clientId);
    return this;
  }
}

function isWritableDataProperty(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor {
  return descriptor !== undefined && 'value' in descriptor && descriptor.writable === true;
}

function mcpProgressCanRouteToClient(initializedClients: ReadonlySet<number>, clientId: number): boolean {
  // Effect 4.0.0-rc.112's canonical outgoing notification queue broadcasts to the
  // complete initialized-client set. Threadnote's adapter is stdio-only, but
  // fail closed if the service is ever reused with another client so an opaque
  // request token cannot cross client boundaries.
  for (const initializedClientId of initializedClients) {
    if (initializedClientId !== clientId) return false;
  }
  return true;
}

export function makeMcpToolProgress(
  progressToken: McpSchema.ProgressToken | undefined,
  notify: (notification: McpProgressNotificationPayload) => Effect.Effect<void, unknown>,
): McpToolProgress {
  if (progressToken === undefined) return DISABLED_MCP_TOOL_PROGRESS;
  let sequence = 0;
  return {
    enabled: true,
    report: update =>
      Effect.suspend(() => {
        sequence += 1;
        return notify(mcpProgressNotification(progressToken, sequence, update)).pipe(
          // Effect's notification client queues canonical notifications on a
          // transport fiber. Give that fiber two bounded scheduler turns so a
          // fast phase does not race its response ahead of the progress frame.
          Effect.andThen(Effect.yieldNow),
          Effect.andThen(Effect.yieldNow),
          Effect.catchCause(cause =>
            Cause.hasInterrupts(cause) ? Effect.failCause(cause as Cause.Cause<never>) : Effect.void,
          ),
        );
      }),
  };
}

export function mcpProgressNotification(
  progressToken: McpSchema.ProgressToken,
  progress: number,
  update: McpProgressUpdate,
): McpProgressNotificationPayload {
  const phase = boundedMcpProgressPhase(update.phase);
  return {
    _meta: {
      [MCP_PROGRESS_METADATA_KEY]: {
        phase,
        version: 1,
      },
    },
    message: boundedMcpProgressMessage(update.message),
    progress: Number.isSafeInteger(progress) && progress > 0 ? progress : 1,
    progressToken,
  };
}

export function withMcpProgressHeartbeat<A, E, R>(
  progress: McpToolProgress,
  update: McpProgressUpdate,
  effect: Effect.Effect<A, E, R>,
  intervalMilliseconds = MCP_PROGRESS_HEARTBEAT_MILLISECONDS,
): Effect.Effect<A, E, R> {
  if (!progress.enabled) return effect;
  const interval = Number.isFinite(intervalMilliseconds)
    ? Math.max(1, Math.min(MCP_PROGRESS_INTERVAL_MAX_MILLISECONDS, Math.floor(intervalMilliseconds)))
    : MCP_PROGRESS_HEARTBEAT_MILLISECONDS;
  return Effect.scoped(
    Effect.gen(function* () {
      yield* progress.report(update);
      yield* Effect.sleep(interval).pipe(Effect.andThen(progress.report(update)), Effect.forever, Effect.forkScoped);
      return yield* effect;
    }),
  );
}

function boundedMcpProgressPhase(value: string): string {
  const bounded = value.trim().slice(0, MCP_PROGRESS_PHASE_MAX_CHARACTERS);
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(bounded) ? bounded : 'working';
}

function boundedMcpProgressMessage(value: string): string {
  const normalized = [...value.slice(0, MCP_PROGRESS_MESSAGE_MAX_BYTES)]
    .map(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  const fallback = normalized || 'Threadnote is working.';
  const encoded = MCP_PROGRESS_ENCODER.encode(fallback);
  if (encoded.byteLength <= MCP_PROGRESS_MESSAGE_MAX_BYTES) return fallback;
  let end = MCP_PROGRESS_MESSAGE_MAX_BYTES;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return MCP_PROGRESS_DECODER.decode(encoded.subarray(0, end)).trimEnd();
}

export function mcpResourceFailureResult(
  cause: Cause.Cause<unknown>,
): Effect.Effect<never, McpSchema.InternalError | McpSchema.InvalidParams> {
  if (Cause.hasInterrupts(cause)) {
    return Effect.failCause(cause as Cause.Cause<McpSchema.InternalError | McpSchema.InvalidParams>);
  }
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (
    (error instanceof McpSchema.InvalidParams || error instanceof McpSchema.InternalError) &&
    hasMcpResourceErrorBrand(error)
  ) {
    return Effect.fail(error);
  }
  return Effect.fail(
    new McpSchema.InternalError({
      data: MCP_RESOURCE_ERROR_DATA,
      message: 'Threadnote resource request failed.',
    }),
  );
}

export function mcpToolFailureResult(cause: Cause.Cause<unknown>): Effect.Effect<McpSchema.CallToolResult, never> {
  if (Cause.hasInterruptsOnly(cause)) {
    return Effect.failCause(cause as Cause.Cause<never>);
  }
  return Effect.succeed(
    attachAnonymousTelemetryError(
      new McpSchema.CallToolResult({
        content: [{type: 'text', text: causeMessage(cause)}],
        isError: true,
      }),
      Cause.squash(cause),
    ),
  );
}

function causeMessage(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error ? squashed.message : String(squashed);
}

function flattenJsonSchemaConstraints(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(flattenJsonSchemaConstraints);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const output = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, flattenJsonSchemaConstraints(entry)]),
  );
  const constraints = output.allOf;
  if (Array.isArray(constraints)) {
    const merged: Record<string, unknown> = {};
    for (const constraint of constraints) {
      if (typeof constraint !== 'object' || constraint === null || Array.isArray(constraint)) {
        return output;
      }
      for (const [key, entry] of Object.entries(constraint)) {
        const hasPrevious = Object.hasOwn(merged, key) || Object.hasOwn(output, key);
        const previous = Object.hasOwn(merged, key) ? merged[key] : output[key];
        if (hasPrevious && JSON.stringify(previous) !== JSON.stringify(entry)) {
          return output;
        }
        merged[key] = entry;
      }
    }
    delete output.allOf;
    Object.assign(output, merged);
  }
  return output;
}

function toolHandlerEffect(
  evaluate: () => ToolHandlerResult,
  applicationServices: Context.Context<ApplicationServices>,
): Effect.Effect<ToolResult, unknown> {
  return Effect.try({try: evaluate, catch: cause => applicationError('evaluate MCP tool handler', cause)}).pipe(
    Effect.flatMap(handled => {
      if (Effect.isEffect(handled)) {
        return handled.pipe(Effect.provideContext(applicationServices));
      }
      if (isPromiseLike(handled)) {
        return fromPromise('handle Effect AI MCP request', () => Promise.resolve(handled));
      }
      return Effect.succeed(handled);
    }),
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<ToolResult> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

const annotate = <S extends Schema.Top>(schema: S, description?: string): S['Rebuild'] =>
  schema.annotate(description ? {description} : {});

const numberSchema = (
  description: string | undefined,
  options: {readonly integer?: boolean; readonly maximum?: number; readonly minimum?: number},
) =>
  annotate(
    Schema.Number.check(
      Schema.isFinite(),
      ...(options.integer ? [Schema.isInt()] : []),
      ...(options.minimum === undefined ? [] : [Schema.isGreaterThanOrEqualTo(options.minimum)]),
      ...(options.maximum === undefined ? [] : [Schema.isLessThanOrEqualTo(options.maximum)]),
    ),
    description,
  );

export const McpInput = {
  boolean: (description?: string) => Schema.optionalKey(annotate(Schema.Boolean, description)),
  integer: (description?: string, options: {readonly maximum?: number; readonly minimum?: number} = {}) =>
    Schema.optionalKey(numberSchema(description, {...options, integer: true})),
  literals: <const Values extends readonly [string, ...string[]]>(values: Values, description?: string) =>
    Schema.optionalKey(annotate(Schema.Literals(values), description)),
  literalsOrLiterals: <const Values extends readonly [string, ...string[]]>(
    values: Values,
    description?: string,
    options: {readonly maximumItems?: number} = {},
  ) =>
    Schema.optionalKey(
      annotate(
        Schema.Union([
          Schema.Literals(values),
          options.maximumItems === undefined
            ? Schema.Array(Schema.Literals(values))
            : Schema.Array(Schema.Literals(values)).check(Schema.isMaxLength(options.maximumItems)),
        ]),
        description,
      ),
    ),
  messages: (description?: string) =>
    Schema.optionalKey(
      annotate(Schema.Array(Schema.Struct({content: Schema.String, role: Schema.String})), description),
    ),
  number: (description?: string, options: {readonly maximum?: number; readonly minimum?: number} = {}) =>
    Schema.optionalKey(numberSchema(description, options)),
  string: (description?: string) => Schema.optionalKey(annotate(Schema.String, description)),
  stringOrStrings: (description?: string, options: {readonly maximumItems?: number} = {}) =>
    Schema.optionalKey(
      annotate(
        Schema.Union([
          Schema.String,
          options.maximumItems === undefined
            ? Schema.Array(Schema.String)
            : Schema.Array(Schema.String).check(Schema.isMaxLength(options.maximumItems)),
        ]),
        description,
      ),
    ),
} as const;

const stdioWithInstructionsLayer = (instructions: string): Layer.Layer<Stdio.Stdio> =>
  Layer.effect(
    Stdio.Stdio,
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio;
      const addInstructions = makeInitializeInstructionsTransform(instructions);
      return Stdio.make({
        args: stdio.args,
        stderr: options => stdio.stderr(options),
        stdin: stdio.stdin,
        stdout: options => stdio.stdout(options).pipe(Sink.mapInput(addInstructions)),
      });
    }),
  ).pipe(Layer.provide(BunStdio.layer));

export function makeInitializeInstructionsTransform(
  instructions: string,
): (input: string | Uint8Array) => string | Uint8Array {
  let initialized = false;
  return input => {
    if (initialized && !couldContainEffectRpcCause(input)) return input;
    const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
    const parsed = parseMcpJsonRpcEnvelope(text);
    if (!parsed) {
      return input;
    }
    const isInitializeResponse = mcpJsonRpcEnvelopeContainsInitializeResponse(parsed);
    const transformed = repairMcpJsonRpcValue(parsed, initialized ? undefined : instructions);
    if (!initialized && isInitializeResponse) {
      initialized = true;
    }
    if (transformed === parsed) return input;
    const encoded = `${JSON.stringify(transformed)}\n`;
    return typeof input === 'string' ? encoded : new TextEncoder().encode(encoded);
  };
}

function repairMcpJsonRpcEnvelope(input: string, instructions: string | undefined): McpJsonRpcEnvelope | undefined {
  const parsed = parseMcpJsonRpcEnvelope(input);
  if (parsed === undefined) return undefined;
  const transformed = repairMcpJsonRpcValue(parsed, instructions);
  return transformed === parsed ? undefined : transformed;
}

type McpJsonRpcEnvelope = Record<string, unknown> | readonly Record<string, unknown>[];

function parseMcpJsonRpcEnvelope(input: string): McpJsonRpcEnvelope | undefined {
  const parsed = Option.getOrUndefined(
    Option.liftThrowable((content: string) => JSON.parse(content) as unknown)(input),
  );
  if (Array.isArray(parsed)) {
    if (parsed.length === 0 || parsed.some(item => typeof item !== 'object' || item === null || Array.isArray(item))) {
      return undefined;
    }
    return parsed as readonly Record<string, unknown>[];
  }
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
}

function repairMcpJsonRpcValue(parsed: McpJsonRpcEnvelope, instructions: string | undefined): McpJsonRpcEnvelope {
  if (!Array.isArray(parsed)) return repairMcpJsonRpcObject(parsed as Record<string, unknown>, instructions);
  let changed = false;
  const transformed = parsed.map(item => {
    const repaired = repairMcpJsonRpcObject(item, instructions);
    if (repaired !== item) changed = true;
    return repaired;
  });
  return changed ? transformed : parsed;
}

function mcpJsonRpcEnvelopeContainsInitializeResponse(parsed: McpJsonRpcEnvelope): boolean {
  return Array.isArray(parsed)
    ? parsed.some(item => mcpInitializeResponse(item))
    : mcpInitializeResponse(parsed as Record<string, unknown>);
}

function repairMcpJsonRpcObject(
  parsed: Record<string, unknown>,
  instructions: string | undefined,
): Record<string, unknown> {
  let transformed = parsed;
  if (mcpInitializeResponse(parsed)) {
    const capabilities = mcpRecord(parsed.result.capabilities);
    const resources = mcpRecord(capabilities?.resources);
    // RC.112 advertises subscriptions when resources are registered, but
    // Threadnote does not yet emit notifications/resources/updated across its
    // mutation paths. Keep the wire capability truthful until that complete
    // lifecycle exists instead of accepting inert subscriptions.
    const repairedResources = resources === undefined ? undefined : {...resources, subscribe: false};
    const repairedCapabilities =
      capabilities === undefined || repairedResources === undefined
        ? capabilities
        : {...capabilities, resources: repairedResources};
    const repairedResult = {
      ...parsed.result,
      ...(repairedCapabilities === undefined ? {} : {capabilities: repairedCapabilities}),
      ...(instructions === undefined ? {} : {instructions}),
    };
    if (instructions !== undefined || (resources !== undefined && resources.subscribe !== false)) {
      transformed = {...parsed, result: repairedResult};
    }
  }
  return unwrapEffectRpcMcpError(transformed);
}

function mcpRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function mcpInitializeResponse(parsed: Record<string, unknown>): parsed is Record<string, unknown> & {
  readonly result: Readonly<Record<string, unknown>>;
} {
  if (typeof parsed.result !== 'object' || parsed.result === null || Array.isArray(parsed.result)) return false;
  return 'protocolVersion' in parsed.result && 'serverInfo' in parsed.result;
}

function couldContainEffectRpcCause(input: string | Uint8Array): boolean {
  if (typeof input === 'string') return input.includes('"_tag":"Cause"');
  outer: for (let index = 0; index <= input.length - EFFECT_RPC_CAUSE_MARKER.length; index += 1) {
    for (let offset = 0; offset < EFFECT_RPC_CAUSE_MARKER.length; offset += 1) {
      if (input[index + offset] !== EFFECT_RPC_CAUSE_MARKER[offset]) continue outer;
    }
    return true;
  }
  return false;
}

// Effect 4.0.0-rc.112 preserves the typed MCP code on its outer Cause envelope,
// but clients still require a plain JSON-RPC error object. Repair only the exact
// single-Fail envelopes and branded protocol errors Threadnote emits. Keep the
// beta-era code-0 case bounded for compatible stored/test envelopes; unrelated
// results, defects, and Cause values pass through byte-for-byte.
function unwrapEffectRpcMcpError(parsed: Record<string, unknown>): Record<string, unknown> {
  const error = parsed.error;
  if (
    parsed.jsonrpc !== '2.0' ||
    !('id' in parsed) ||
    (typeof parsed.id !== 'number' && typeof parsed.id !== 'string') ||
    'result' in parsed ||
    typeof error !== 'object' ||
    error === null ||
    !('_tag' in error) ||
    error._tag !== 'Cause' ||
    !('code' in error) ||
    typeof error.code !== 'number'
  ) {
    return parsed;
  }
  if (!('data' in error) || !Array.isArray(error.data)) return parsed;
  if (error.data.length !== 1) return parsed;
  const failure = error.data[0];
  if (
    typeof failure !== 'object' ||
    failure === null ||
    !('_tag' in failure) ||
    failure._tag !== 'Fail' ||
    !('error' in failure)
  ) {
    return parsed;
  }
  const typed = failure.error;
  if (
    typeof typed !== 'object' ||
    typed === null ||
    !('code' in typed) ||
    typeof typed.code !== 'number' ||
    !('message' in typed) ||
    typeof typed.message !== 'string' ||
    !isRecognizedMcpError(typed) ||
    !hasMcpResourceErrorBrand(typed)
  ) {
    return parsed;
  }
  if (error.code !== 0 && error.code !== typed.code) return parsed;
  const memoryRecovery = mcpResourceMemoryRecovery(typed);
  return {
    ...parsed,
    error: {
      code: hasMcpResourceNotFoundErrorBrand(typed) ? -32_002 : typed.code,
      ...(memoryRecovery === undefined ? {} : {data: memoryRecovery}),
      message: typed.message,
    },
  };
}

function hasMcpResourceErrorBrand(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('data' in error)) return false;
  const data = error.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const record = data as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  const brand = record[MCP_RESOURCE_ERROR_BRAND_KEY];
  if (brand === 1) return keys.length === 1;
  if (brand !== 2) return false;
  if (keys.length === 1) return true;
  return (
    keys.length === 2 &&
    MCP_RESOURCE_MEMORY_RECOVERY_KEY in record &&
    isMemoryReadRecoveryV1(record[MCP_RESOURCE_MEMORY_RECOVERY_KEY])
  );
}

function hasMcpResourceNotFoundErrorBrand(error: unknown): boolean {
  if (!hasMcpResourceErrorBrand(error) || typeof error !== 'object' || error === null || !('data' in error)) {
    return false;
  }
  const data = error.data as Readonly<Record<string, unknown>>;
  return data[MCP_RESOURCE_ERROR_BRAND_KEY] === 2;
}

function mcpResourceMemoryRecovery(error: unknown): MemoryReadRecoveryV1 | undefined {
  if (!hasMcpResourceNotFoundErrorBrand(error) || typeof error !== 'object' || error === null || !('data' in error)) {
    return undefined;
  }
  const data = error.data as Readonly<Record<string, unknown>>;
  const recovery = data[MCP_RESOURCE_MEMORY_RECOVERY_KEY];
  return isMemoryReadRecoveryV1(recovery) ? recovery : undefined;
}

function isRecognizedMcpError(error: {readonly code: number} & Record<PropertyKey, unknown>): boolean {
  if (error.code === -32_002) {
    return !('_tag' in error) || error._tag === 'McpErrorBase';
  }
  return (
    (error.code === -32_602 && (!('_tag' in error) || error._tag === 'InvalidParams')) ||
    (error.code === -32_603 && (!('_tag' in error) || error._tag === 'InternalError'))
  );
}
