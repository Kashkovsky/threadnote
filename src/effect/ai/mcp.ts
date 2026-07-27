import * as NodeStdio from '@effect/platform-node/NodeStdio';
import {Cause, Context, Effect, Layer, Logger, Option, Schema, Sink, Stdio} from 'effect';
import {McpSchema, McpServer} from 'effect/unstable/ai';
import {fromPromiseError} from '../errors.js';
import type {ApplicationServices} from '../runtime.js';

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

export class EffectMcpServerAdapter {
  readonly #tools: RegisteredTool[] = [];

  constructor(
    readonly name: string,
    readonly version: string,
    readonly instructions: string,
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

  private registrationLayer(): Layer.Layer<never, never, McpServer.McpServer | ApplicationServices> {
    const registrations = [...this.#tools];
    return Layer.effectDiscard(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const applicationServices = yield* Effect.context<ApplicationServices>();
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
              return Schema.decodeUnknownEffect(input, {errors: 'all'})(payload).pipe(
                Effect.flatMap(parsed =>
                  toolHandlerEffect(() => registration.handle(parsed), applicationServices).pipe(
                    Effect.matchCause({
                      onFailure: cause =>
                        new McpSchema.CallToolResult({
                          content: [{type: 'text', text: causeMessage(cause)}],
                          isError: true,
                        }),
                      onSuccess: result => new McpSchema.CallToolResult(result as McpSchema.CallToolResult),
                    }),
                  ),
                ),
                Effect.catchCause(cause =>
                  Effect.succeed(
                    new McpSchema.CallToolResult({
                      content: [{type: 'text', text: causeMessage(cause)}],
                      isError: true,
                    }),
                  ),
                ),
              );
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
      return Stdio.make({
        args: stdio.args,
        stderr: options => stdio.stderr(options),
        stdin: stdio.stdin,
        stdout: options =>
          stdio
            .stdout(options)
            .pipe(Sink.mapInput((input: string | Uint8Array) => addInitializeInstructions(input, instructions))),
      });
    }),
  ).pipe(Layer.provide(NodeStdio.layer));

function addInitializeInstructions(input: string | Uint8Array, instructions: string): string | Uint8Array {
  const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
  const parsed = Option.getOrUndefined(
    Option.liftThrowable(
      (content: string) =>
        JSON.parse(content) as {
          readonly result?: {
            readonly capabilities?: unknown;
            readonly protocolVersion?: unknown;
            readonly serverInfo?: unknown;
          };
        },
    )(text),
  );
  if (!parsed || parsed.result?.protocolVersion === undefined || parsed.result.serverInfo === undefined) {
    return input;
  }
  const encoded = `${JSON.stringify({...parsed, result: {...parsed.result, instructions}})}\n`;
  return typeof input === 'string' ? encoded : new TextEncoder().encode(encoded);
}
