import {Effect} from 'effect';
import {McpSchema} from 'effect/unstable/ai';
import {parseResourceId, resourceIdIsWithin} from '../../storage/resource-id.js';
import {ResourceStore, type ResourceStoreError} from '../resource-store.js';
import {MCP_RESOURCE_ERROR_DATA, MCP_RESOURCE_NOT_FOUND_ERROR_DATA} from './mcp.js';

export const MCP_RESOURCE_READ_MAX_BYTES = 1_048_576;
export const MCP_RESOURCE_MIME_TYPE = 'text/plain; charset=utf-8';
// Effect beta.102 negotiates MCP 2025-06-18, whose resources contract uses
// this server-error code for a resource that does not exist.
export const MCP_RESOURCE_NOT_FOUND_CODE = -32_002;

interface McpResourceConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly user: string;
}

export function readThreadnoteMcpResource(
  config: McpResourceConfig,
  uri: string,
  scopeRoot?: string,
): Effect.Effect<
  typeof McpSchema.ReadResourceResult.Type,
  McpSchema.InternalError | McpSchema.InvalidParams,
  ResourceStore
> {
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
    const read = yield* store.readBounded(location, canonicalUri, MCP_RESOURCE_READ_MAX_BYTES);
    if (read.truncated) {
      return yield* resourceTooLarge();
    }
    if (Buffer.byteLength(read.content, 'utf8') > MCP_RESOURCE_READ_MAX_BYTES) {
      return yield* resourceTooLarge();
    }
    return {
      contents: [{mimeType: MCP_RESOURCE_MIME_TYPE, text: read.content, uri: canonicalUri}],
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
    message: `Threadnote resource exceeds the ${MCP_RESOURCE_READ_MAX_BYTES}-byte resources/read limit; use read_context for a complete canonical read.`,
  });
}

function mcpResourceReadError(
  error: ResourceStoreError | McpSchema.InternalError | McpSchema.InvalidParams,
): McpSchema.InternalError | McpSchema.InvalidParams {
  if (error instanceof McpSchema.InvalidParams || error instanceof McpSchema.InternalError) {
    return error;
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
