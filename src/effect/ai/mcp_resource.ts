import {Effect} from 'effect';
import {McpSchema} from 'effect/unstable/ai';
import {isMemoryRelocationUri, MemoryRelocationError, readMemoryWithRelocations} from '../../memory/relocation.js';
import {parseResourceId, resourceIdIsWithin} from '../../storage/resource-id.js';
import {ResourceNotFound, ResourceStore} from '../resource-store.js';
import {MCP_RESOURCE_ERROR_DATA, MCP_RESOURCE_NOT_FOUND_ERROR_DATA} from './mcp.js';

export const MCP_RESOURCE_READ_MAX_BYTES = 4_500;
export const MCP_RESOURCE_MIME_TYPE = 'text/plain; charset=utf-8';
// The MCP resources contract uses this server-error code for a resource that
// does not exist across every protocol revision Threadnote advertises.
export const MCP_RESOURCE_NOT_FOUND_CODE = -32_002;

interface McpResourceConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly user: string;
}

export function readThreadnoteMcpResource(config: McpResourceConfig, uri: string, scopeRoot?: string) {
  return Effect.gen(function* () {
    const canonicalUri = yield* canonicalThreadnoteUri(uri);
    if (scopeRoot && !resourceIdIsWithin(canonicalUri, scopeRoot)) {
      return yield* new McpSchema.InvalidParams({
        data: MCP_RESOURCE_ERROR_DATA,
        message: 'The requested resource is outside the active Cursor Cloud memory scope.',
      });
    }
    const store = yield* ResourceStore;
    const location = {account: config.account, home: config.agentContextHome, user: config.user};
    const exact = yield* store.readBounded(location, canonicalUri, MCP_RESOURCE_READ_MAX_BYTES).pipe(
      Effect.map(read => ({canonicalUri, read})),
      Effect.catchTag('ResourceNotFound', () => Effect.succeed(undefined)),
    );
    const resolved =
      exact ??
      (isMemoryRelocationUri(config, canonicalUri)
        ? yield* readMemoryWithRelocations(config, canonicalUri).pipe(
            Effect.map(memory => ({
              canonicalUri: memory.canonicalUri,
              read: {content: memory.content, truncated: false},
            })),
          )
        : yield* new ResourceNotFound({
            message: `Resource does not exist: ${canonicalUri}`,
            uri: canonicalUri,
          }));
    if (scopeRoot && !resourceIdIsWithin(resolved.canonicalUri, scopeRoot)) {
      return yield* new McpSchema.InvalidParams({
        data: MCP_RESOURCE_ERROR_DATA,
        message: 'The relocated resource is outside the active Cursor Cloud memory scope.',
      });
    }
    const read = resolved.read;
    if (read.truncated) {
      return yield* resourceTooLarge();
    }
    if (Buffer.byteLength(read.content, 'utf8') > MCP_RESOURCE_READ_MAX_BYTES) {
      return yield* resourceTooLarge();
    }
    return {
      contents: [{mimeType: MCP_RESOURCE_MIME_TYPE, text: read.content, uri: resolved.canonicalUri}],
    } satisfies typeof McpSchema.ReadResourceResult.Type;
  }).pipe(Effect.mapError(mcpResourceReadError));
}

function canonicalThreadnoteUri(uri: string): Effect.Effect<string, McpSchema.InvalidParams> {
  return Effect.try({
    try: () => {
      const parsed = parseResourceId(uri);
      if (parsed.inputScheme !== 'threadnote' || parsed.canonicalUri !== uri) {
        throw new Error('non-canonical Threadnote resource URI');
      }
      return parsed.canonicalUri;
    },
    catch: () =>
      new McpSchema.InvalidParams({
        data: MCP_RESOURCE_ERROR_DATA,
        message: 'Expected a canonical threadnote:// URI.',
      }),
  });
}

function resourceTooLarge(): McpSchema.InvalidParams {
  return new McpSchema.InvalidParams({
    data: MCP_RESOURCE_ERROR_DATA,
    message: `Threadnote resource exceeds the ${MCP_RESOURCE_READ_MAX_BYTES}-byte resources/read limit; use read_context pagination.`,
  });
}

function mcpResourceReadError(error: unknown): McpSchema.InternalError | McpSchema.InvalidParams {
  if (error instanceof McpSchema.InvalidParams || error instanceof McpSchema.InternalError) {
    return error;
  }
  if (error instanceof MemoryRelocationError) {
    return new McpSchema.InternalError({
      data: MCP_RESOURCE_ERROR_DATA,
      message: 'Threadnote memory relocation could not be verified safely.',
    });
  }
  if (typeof error !== 'object' || error === null || !('_tag' in error)) {
    return new McpSchema.InternalError({
      data: MCP_RESOURCE_ERROR_DATA,
      message: 'Threadnote resource could not be read safely.',
    });
  }
  switch (error._tag) {
    case 'InvalidResourceId':
      return new McpSchema.InvalidParams({
        data: MCP_RESOURCE_ERROR_DATA,
        message: 'Expected a canonical threadnote:// URI.',
      });
    case 'ResourceAccessDenied':
      return new McpSchema.InvalidParams({
        data: MCP_RESOURCE_ERROR_DATA,
        message: 'Threadnote resource is not readable in the active account.',
      });
    case 'ResourceNotFound':
      return new McpSchema.InvalidParams({
        data: MCP_RESOURCE_NOT_FOUND_ERROR_DATA,
        message: 'Threadnote resource was not found.',
      });
    default:
      return new McpSchema.InternalError({
        data: MCP_RESOURCE_ERROR_DATA,
        message: 'Threadnote resource could not be read safely.',
      });
  }
}
