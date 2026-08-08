import * as BunStdio from '@effect/platform-bun/BunStdio';
import {Cause, Context, Effect, Layer, Logger, Option, Schema, Sink, Stdio} from 'effect';
import {McpSchema, McpServer} from 'effect/unstable/ai';
import {fromPromiseError} from '../errors.js';
import type {ApplicationServices} from '../runtime.js';
import {omitProductionLogPhaseRecorder, withProductionLogging} from '../production_log.js';

const MCP_PRODUCTION_LOG_WRITE_TIMEOUT_MILLISECONDS = 50;
const EFFECT_RPC_CAUSE_MARKER = new TextEncoder().encode('"_tag":"Cause"');
const MCP_RESOURCE_ERROR_BRAND_KEY = 'threadnote.io/resource-read-error';
export const MCP_RESOURCE_ERROR_DATA = Object.freeze({[MCP_RESOURCE_ERROR_BRAND_KEY]: 1});

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

interface RegisteredTool {
  readonly definition: ToolDefinition<ToolFields>;
  readonly handle: (args: Record<string, unknown>) => ToolHandlerResult;
  readonly name: string;
}

type ToolHandlerResult = ToolResult | Effect.Effect<ToolResult, unknown, ApplicationServices> | PromiseLike<ToolResult>;

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
) => Effect.Effect<
  typeof McpSchema.ReadResourceResult.Type,
  McpSchema.InternalError | McpSchema.InvalidParams | McpSchema.McpErrorBase,
  ApplicationServices
>;

export class EffectMcpServerAdapter {
  readonly #resourceTemplates: RegisteredResourceTemplate[] = [];
  readonly #tools: RegisteredTool[] = [];

  constructor(
    readonly name: string,
    readonly version: string,
    readonly instructions: string,
    readonly productionLogHome?: string,
  ) {}

  registerTool<const Fields extends ToolFields>(
    name: string,
    definition: ToolDefinition<Fields>,
    handle: (args: Schema.Struct.Type<Fields>) => ToolHandlerResult,
  ): void {
    this.#tools.push({
      definition,
      handle: args => handle(args as Schema.Struct.Type<Fields>),
      name,
    });
  }

  registerResourceTemplate(definition: ResourceTemplateDefinition, handle: ResourceTemplateHandler): void {
    this.#resourceTemplates.push({definition, handle});
  }

  private registrationLayer(): Layer.Layer<never, never, McpServer.McpServer | ApplicationServices> {
    const resourceTemplates = [...this.#resourceTemplates];
    const registrations = [...this.#tools];
    const productionLogHome = this.productionLogHome;
    return Layer.effectDiscard(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const applicationServices = omitProductionLogPhaseRecorder(yield* Effect.context<ApplicationServices>());
        for (const registration of resourceTemplates) {
          yield* server.addResourceTemplate({
            annotations: Context.empty(),
            completions: {},
            handle: uri =>
              // The negotiated Effect MCP revision accepts McpErrorBase on
              // the wire, but addResourceTemplate's beta type only lists two
              // concrete subclasses. Preserve the wider protocol error here.
              registration
                .handle(uri)
                .pipe(
                  Effect.provideContext(applicationServices),
                  Effect.catchCause(mcpResourceFailureResult),
                ) as Effect.Effect<
                typeof McpSchema.ReadResourceResult.Type,
                McpSchema.InternalError | McpSchema.InvalidParams
              >,
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
            handle: payload => {
              const handling = Schema.decodeUnknownEffect(input, {errors: 'all'})(payload).pipe(
                Effect.flatMap(parsed =>
                  toolHandlerEffect(() => registration.handle(parsed), applicationServices).pipe(
                    Effect.matchCauseEffect({
                      onFailure: mcpToolFailureResult,
                      onSuccess: result =>
                        Effect.succeed(new McpSchema.CallToolResult(result as McpSchema.CallToolResult)),
                    }),
                  ),
                ),
                Effect.catchCause(mcpToolFailureResult),
              );
              return productionLogHome === undefined
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
                  ).pipe(Effect.provideContext(applicationServices));
            },
          });
        }
      }),
    );
  }

  run(): Effect.Effect<never, never, ApplicationServices> {
    return Layer.launch(
      this.registrationLayer().pipe(
        Layer.provide(McpServer.layerStdio({name: this.name, version: this.version})),
        Layer.provide(stdioWithInstructionsLayer(this.instructions)),
        Layer.provide(Layer.succeed(Logger.LogToStderr)(true)),
      ),
    );
  }
}

export function mcpResourceFailureResult(
  cause: Cause.Cause<unknown>,
): Effect.Effect<never, McpSchema.InternalError | McpSchema.InvalidParams | McpSchema.McpErrorBase> {
  if (Cause.hasInterrupts(cause)) {
    return Effect.failCause(
      cause as Cause.Cause<McpSchema.InternalError | McpSchema.InvalidParams | McpSchema.McpErrorBase>,
    );
  }
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (
    (error instanceof McpSchema.InvalidParams ||
      error instanceof McpSchema.InternalError ||
      error instanceof McpSchema.McpErrorBase) &&
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
    new McpSchema.CallToolResult({
      content: [{type: 'text', text: causeMessage(cause)}],
      isError: true,
    }),
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
  return Effect.try({try: evaluate, catch: normalizeError}).pipe(
    Effect.flatMap(handled => {
      if (Effect.isEffect(handled)) {
        return handled.pipe(Effect.provideContext(applicationServices));
      }
      if (isPromiseLike(handled)) {
        return fromPromiseError(() => Promise.resolve(handled));
      }
      return Effect.succeed(handled);
    }),
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<ToolResult> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

function normalizeError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
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
  messages: (description?: string) =>
    Schema.optionalKey(
      annotate(Schema.Array(Schema.Struct({content: Schema.String, role: Schema.String})), description),
    ),
  number: (description?: string, options: {readonly maximum?: number; readonly minimum?: number} = {}) =>
    Schema.optionalKey(numberSchema(description, options)),
  string: (description?: string) => Schema.optionalKey(annotate(Schema.String, description)),
  stringOrStrings: (description?: string) =>
    Schema.optionalKey(annotate(Schema.Union([Schema.String, Schema.Array(Schema.String)]), description)),
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
    const parsed = Option.getOrUndefined(
      Option.liftThrowable(
        (content: string) =>
          JSON.parse(content) as {
            readonly error?: unknown;
            readonly result?: {
              readonly capabilities?: unknown;
              readonly protocolVersion?: unknown;
              readonly serverInfo?: unknown;
            };
          },
      )(text),
    );
    if (!parsed) {
      return input;
    }
    let transformed: Record<string, unknown> = parsed;
    if (!initialized && parsed.result?.protocolVersion !== undefined && parsed.result.serverInfo !== undefined) {
      initialized = true;
      transformed = {...transformed, result: {...parsed.result, instructions}};
    }
    transformed = unwrapEffectRpcMcpError(transformed);
    if (transformed === parsed) return input;
    const encoded = `${JSON.stringify(transformed)}\n`;
    return typeof input === 'string' ? encoded : new TextEncoder().encode(encoded);
  };
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

// Effect 4.0.0-beta.102's JSON-RPC serializer reads `code` from the outer
// Fail reason instead of its typed error, so native MCP failures reach clients
// as code 0. Repair only the exact single-Fail envelopes and protocol error
// types Threadnote emits; unrelated results, defects, and Cause values pass
// through byte-for-byte.
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
    error.code !== 0
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
  return {
    ...parsed,
    error: {
      code: typed.code,
      message: typed.message,
    },
  };
}

function hasMcpResourceErrorBrand(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('data' in error)) return false;
  const data = error.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    Object.keys(data).length === 1 &&
    MCP_RESOURCE_ERROR_BRAND_KEY in data &&
    data[MCP_RESOURCE_ERROR_BRAND_KEY] === 1
  );
}

function isRecognizedMcpError(error: {readonly code: number} & Record<PropertyKey, unknown>): boolean {
  if (error.code === -32_002) {
    return !('_tag' in error) || error._tag === 'McpErrorBase';
  }
  return (
    (error.code === -32_602 && error._tag === 'InvalidParams') ||
    (error.code === -32_603 && error._tag === 'InternalError')
  );
}
