import {Effect} from 'effect';
import {McpSchema} from 'effect/unstable/ai';
import {
  isMemoryRelocationUri,
  MemoryRelocationError,
  MemoryPointerNotFound,
  readMemoryWithRelocations,
} from '../../memory/relocation.js';
import {
  MemoryIdentityResolutionError,
  resolveMemoryIdentityAliases,
  verifyResolvedMemoryIdentity,
} from '../../recall/memory_identity.js';
import {uriSegment} from '../../manifest.js';
import {memoryReadRecoveryForError, memoryReadRecoveryText} from '../../mcp/memory_read_recovery.js';
import {canonicalResourceUri, parseResourceId, resourceIdIsWithin} from '../../storage/resource-id.js';
import {ResourceNotFound, ResourceStore} from '../resource-store.js';
import {
  mcpResourceNotFoundRecoveryErrorData,
  MCP_RESOURCE_ERROR_DATA,
  MCP_RESOURCE_NOT_FOUND_ERROR_DATA,
} from './mcp.js';

export const MCP_RESOURCE_READ_MAX_BYTES = 4_500;
export const MCP_RESOURCE_MIME_TYPE = 'text/plain; charset=utf-8';
// The MCP resources contract uses this server-error code for a resource that
// does not exist across every protocol revision Threadnote advertises.
export const MCP_RESOURCE_NOT_FOUND_CODE = -32_002;

interface McpResourceConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

export function readThreadnoteMcpResource(config: McpResourceConfig, uri: string, scopeRoot?: string) {
  return Effect.gen(function* () {
    const requestedUri = yield* canonicalThreadnoteUri(uri);
    const [identity] = yield* resolveMemoryIdentityAliases(
      config,
      [requestedUri],
      [scopeRoot ?? canonicalResourceUri('user', [uriSegment(config.user), 'memories'])],
    );
    const canonicalUri = identity!.canonicalUri;
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
    yield* verifyResolvedMemoryIdentity(identity!, resolved.canonicalUri, read.content);
    return {
      contents: [
        {
          mimeType: MCP_RESOURCE_MIME_TYPE,
          text: read.content,
          uri: identity!.expectedMemoryId === undefined ? resolved.canonicalUri : identity!.requestedUri,
        },
      ],
    } satisfies typeof McpSchema.ReadResourceResult.Type;
  }).pipe(Effect.mapError(error => mcpResourceReadError(config, error)));
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

function mcpResourceReadError(
  config: McpResourceConfig,
  error: unknown,
): McpSchema.InternalError | McpSchema.InvalidParams {
  if (error instanceof McpSchema.InvalidParams || error instanceof McpSchema.InternalError) {
    return error;
  }
  if (error instanceof MemoryRelocationError) {
    return new McpSchema.InternalError({
      data: MCP_RESOURCE_ERROR_DATA,
      message: 'Threadnote memory relocation could not be verified safely.',
    });
  }
  if (error instanceof MemoryPointerNotFound) {
    const recovery = memoryReadRecoveryForError(config, error);
    return new McpSchema.InvalidParams({
      data: recovery === undefined ? MCP_RESOURCE_NOT_FOUND_ERROR_DATA : mcpResourceNotFoundRecoveryErrorData(recovery),
      message:
        recovery === undefined
          ? 'Threadnote resource was not found.'
          : `Threadnote resource was not found. Recovery: ${memoryReadRecoveryText(recovery)}`,
    });
  }
  if (error instanceof MemoryIdentityResolutionError) {
    return new McpSchema.InvalidParams({
      data: error.reason === 'not-found' ? MCP_RESOURCE_NOT_FOUND_ERROR_DATA : MCP_RESOURCE_ERROR_DATA,
      message: error.message,
    });
  }
  if (error instanceof ResourceNotFound) {
    return new McpSchema.InvalidParams({
      data: MCP_RESOURCE_NOT_FOUND_ERROR_DATA,
      message: 'Threadnote resource was not found.',
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
