import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Console, Effect} from 'effect';
import {EffectMcpServerAdapter, McpInput} from '../../effect/ai/mcp.js';
import {enrichMemoryMetadataWithConfiguredLocalAi} from '../../effect/ai/enrichment.js';
import {isInSharedNamespace} from '../../share/index.js';
import {MemoryCodeCitationCaptureError} from '../../memory/code_citation_capture.js';
import {MAX_MEMORY_CODE_CITATIONS, MEMORY_SCHEMA_VERSION} from '../../memory/code_citation.js';
import {
  memoryCodeCitationSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '../../memory/code_citation_policy.js';
import type {MemoryMetadata} from '../../memory/document.js';
import {
  DEFAULT_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT,
  finalizeDeferredCodeAnchors,
  MAX_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT,
  type DeferredCodeAnchorWriteRequest,
} from '../../memory/deferred_code_anchor.js';
import type {CursorCloudMemoryScope} from '../../cursor/cloud.js';
import {resourceIdIsWithin} from '../../storage/resource-id.js';
import {resolveWorkspaceComponentContext} from '../../utils.js';
import {captureMemoryCodeCitationsForMcp} from '../memory_code_citation.js';
import {
  type RuntimeConfig,
  argumentError,
  mcpErrorResult,
  normalizeOptionalMetadata,
  optionalResourceUri,
  optionalResourceUriList,
  requiredText,
  uriSegment,
  withStaleVersionNotice,
} from './common.js';
import {readMemoryRecordsByUri, writeCursorCloudSharedMemory, writeDurableMemory} from './memory.js';

export function registerStoreTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: string,
  description: string,
  memoryScope?: CursorCloudMemoryScope,
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: `${description} Never store secrets, credentials, customer data, or raw logs.`,
      inputSchema: {
        callerCwd: McpInput.string('Absolute cwd for nested package/app scope'),
        codeRefs: McpInput.stringOrStrings(
          `Graph-indexed repository-relative path or cgs_/cgr_ ref; max ${MAX_MEMORY_CODE_CITATIONS}`,
          {maximumItems: MAX_MEMORY_CODE_CITATIONS},
        ),
        citationPolicy: McpInput.literals(
          ['require-current', 'defer'],
          'Private codeRefs default to defer; require-current fails pre-write',
        ),
        kind: McpInput.literals(['durable', 'handoff', 'incident', 'preference', 'smoke'], 'Memory lifecycle kind'),
        project: McpInput.string('Project/repo namespace'),
        references: McpInput.stringOrStrings('Prior read-only threadnote:// URI(s)'),
        replaceUri: McpInput.string('threadnote:// memory URI to replace safely'),
        text: McpInput.string('Memory text'),
        sourceAgentClient: McpInput.string('Originating client'),
        status: McpInput.literals(['active', 'archived', 'expired', 'superseded'], 'Memory status'),
        topic: McpInput.string('Stable topic'),
      },
    },
    ({
      callerCwd,
      citationPolicy,
      codeRefs,
      kind,
      project,
      references,
      replaceUri,
      sourceAgentClient,
      status,
      text,
      topic,
    }) => {
      const checkedText = requiredText(text, name, 'text', {text: 'Durable engineering note...'});
      if (!checkedText.ok) {
        return checkedText.error;
      }
      const checkedReplaceUri = optionalResourceUri(replaceUri, name);
      if (!checkedReplaceUri.ok) {
        return checkedReplaceUri.error;
      }
      const checkedReferences = optionalResourceUriList(references, name);
      if (!checkedReferences.ok) {
        return checkedReferences.error;
      }
      const memoryKind = kind ?? 'durable';
      if (memoryScope && memoryKind !== 'durable' && memoryKind !== 'handoff') {
        return argumentError(
          `${name} supports durable shared memories and transient local handoffs in the Cursor Cloud profile.`,
        );
      }
      if (memoryScope) {
        const outsideReference = checkedReferences.value?.find(
          reference => !resourceIdIsWithin(reference, memoryScope.root),
        );
        if (outsideReference) {
          return argumentError(`${name} references must stay within ${memoryScope.root}.`);
        }
        if (
          memoryKind === 'durable' &&
          checkedReplaceUri.value &&
          !resourceIdIsWithin(checkedReplaceUri.value, memoryScope.root)
        ) {
          return argumentError(`${name} replaceUri must stay within ${memoryScope.root}.`);
        }
        const handoffRoot = `threadnote://user/${uriSegment(config.user)}/memories/handoffs`;
        if (
          memoryKind === 'handoff' &&
          checkedReplaceUri.value &&
          !resourceIdIsWithin(checkedReplaceUri.value, handoffRoot)
        ) {
          return argumentError(`${name} local handoff replaceUri must stay within ${handoffRoot}.`);
        }
      }
      const metadata: MemoryMetadata = {
        kind: memoryKind,
        project: normalizeOptionalMetadata(project),
        references: checkedReferences.value,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        sourceAgentClient: sourceAgentClient ?? 'mcp',
        status: status ?? 'active',
        timestamp: new Date().toISOString(),
        topic: normalizeOptionalMetadata(topic),
      };
      return Effect.gen(function* () {
        const requestedCodeRefs = stringList(codeRefs);
        if (citationPolicy === 'defer' && requestedCodeRefs.length === 0) {
          return argumentError(`${name} citationPolicy=defer requires at least one codeRef.`);
        }
        if (citationPolicy === 'defer' && metadata.status !== 'active') {
          return argumentError(`${name} citationPolicy=defer requires status=active.`);
        }
        if (requestedCodeRefs.length > 0 && !callerCwd) {
          return argumentError(`${name} requires absolute callerCwd when codeRefs are provided.`);
        }
        const sharedTarget =
          (memoryScope !== undefined && memoryKind === 'durable') ||
          (checkedReplaceUri.value !== undefined && isInSharedNamespace(config, checkedReplaceUri.value));
        const effectiveCitationPolicy =
          citationPolicy ??
          (requestedCodeRefs.length > 0 && !sharedTarget && metadata.status === 'active' ? 'defer' : 'require-current');
        const captured = yield* captureMemoryCodeCitationsForMcp(
          config,
          {callerCwd: callerCwd!, refs: requestedCodeRefs},
          name,
        );
        const deferredCodeAnchor: DeferredCodeAnchorWriteRequest | undefined =
          !captured.ok &&
          effectiveCitationPolicy === 'defer' &&
          captured.failure instanceof MemoryCodeCitationCaptureError &&
          captured.failure.recovery
            ? {
                callerCwd: callerCwd!,
                codeRefs: requestedCodeRefs,
                recovery: captured.failure.recovery,
              }
            : undefined;
        if (!captured.ok && !deferredCodeAnchor) return captured.error;
        if (deferredCodeAnchor && sharedTarget) {
          return argumentError(`${name} deferred code anchors are private-local and cannot write shared memory.`);
        }
        const codeCitations = captured.ok ? captured.citations : ([] as const);
        const workspaceComponent = callerCwd
          ? yield* resolveWorkspaceComponentContext({cwd: callerCwd, includeProcessCwd: false})
          : undefined;
        const [replaced] = checkedReplaceUri.value
          ? yield* readMemoryRecordsByUri(config, [checkedReplaceUri.value])
          : [];
        const scopedMetadata = {
          ...metadata,
          ...(codeCitations.length === 0 ? {} : {codeCitations}),
          ...(commonCitationSourceCommit(codeCitations) === undefined
            ? {}
            : {sourceCommit: commonCitationSourceCommit(codeCitations)}),
          workspaceScope: replaced ? replaced.metadata.workspaceScope : workspaceComponent?.scope,
        } satisfies MemoryMetadata;
        if (memoryScope && memoryKind === 'durable') {
          const citationBlocker = memoryCodeCitationSharingBlocker(scopedMetadata);
          if (citationBlocker) {
            return argumentError(
              `Refusing shared memory write: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}.`,
            );
          }
          const result = yield* writeCursorCloudSharedMemory(config, memoryScope, {
            bodyText: checkedText.value,
            metadata: scopedMetadata,
            replaceUri: checkedReplaceUri.value,
          });
          return withClearedCodeCitationReceipt(result, replaced?.metadata.codeCitations?.length, codeCitations.length);
        }
        const enrichedMetadata =
          memoryScope || (checkedReplaceUri.value && isInSharedNamespace(config, checkedReplaceUri.value))
            ? scopedMetadata
            : yield* enrichMemoryMetadataWithConfiguredLocalAi(config, scopedMetadata, checkedText.value).pipe(
                Effect.catch(error =>
                  Console.log(
                    `Local AI memory enrichment skipped: ${error instanceof Error ? error.message : String(error)}`,
                  ).pipe(Effect.as(scopedMetadata)),
                ),
              );
        const result = yield* writeDurableMemory(config, {
          bodyText: checkedText.value,
          deferredCodeAnchor,
          metadata: enrichedMetadata,
          replaceUri: checkedReplaceUri.value,
        });
        const projectedResult =
          memoryScope && memoryKind === 'handoff'
            ? {
                ...result,
                _meta: {
                  ...result._meta,
                  'threadnote.io/persistence': {
                    durability: 'cloud-workspace-local',
                    note: 'This handoff may not survive a new Cursor Cloud session.',
                    type: 'threadnote-cloud-persistence',
                    version: 1,
                  },
                },
              }
            : result;
        return deferredCodeAnchor
          ? withDeferredCodeAnchorWriteReceipt(projectedResult, deferredCodeAnchor)
          : withClearedCodeCitationReceipt(
              projectedResult,
              replaced?.metadata.codeCitations?.length,
              codeCitations.length,
            );
      }).pipe(Effect.flatMap(withStaleVersionNotice));
    },
  );
}

export function registerFinalizeCodeRefsTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'finalize_code_refs',
    {
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true},
      description:
        'Finalize explicitly deferred private memory code citations from already-ready exact-current graphs. Never starts indexing.',
      inputSchema: {
        limit: McpInput.integer('Maximum pending memories to inspect', {
          minimum: 1,
          maximum: MAX_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT,
        }),
        uri: McpInput.stringOrStrings('Optional pending personal memory URI or list of URIs'),
      },
    },
    ({limit, uri}) =>
      Effect.gen(function* () {
        const checkedUris = optionalResourceUriList(uri, 'finalize_code_refs');
        if (!checkedUris.ok) return checkedUris.error;
        const receipt = yield* finalizeDeferredCodeAnchors(config, {
          limit: limit ?? DEFAULT_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT,
          uris: checkedUris.value,
        });
        const summary = [
          `Deferred code anchors: ${receipt.finalizedCount} finalized, ${receipt.pendingCount} pending, ${receipt.conflictCount} conflict, ${receipt.failedCount} failed.`,
          ...receipt.items.map(
            item =>
              `- ${item.memoryUri ?? 'invalid intent'}: ${item.state}` +
              (item.code ? ` [${item.code}]` : '') +
              (item.reason ? ` (${item.reason})` : '') +
              (item.recoveryAction ? ` · next: ${item.recoveryAction}` : '') +
              (item.citationCount === undefined ? '' : ` · ${item.citationCount} citation(s)`),
          ),
        ].join('\n');
        return {content: [{type: 'text' as const, text: summary}], structuredContent: receipt};
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error)))),
  );
}

function stringList(value: string | readonly string[] | undefined): readonly string[] {
  return typeof value === 'string' ? [value] : (value ?? []);
}

function commonCitationSourceCommit(citations: readonly {readonly sourceCommit: string}[]): string | undefined {
  const commits = new Set(citations.map(citation => citation.sourceCommit));
  return commits.size === 1 ? citations[0]?.sourceCommit : undefined;
}

function withClearedCodeCitationReceipt(
  result: CallToolResult,
  previousCount: number | undefined,
  currentCount: number,
): CallToolResult {
  if (!previousCount || currentCount > 0) return result;
  const note = `Cleared ${previousCount} prior code citation(s); provide codeRefs to recapture them.`;
  return {
    ...result,
    content: [...result.content, {type: 'text', text: note}],
    structuredContent: {
      ...(result.structuredContent ?? {}),
      clearedCodeCitations: previousCount,
    },
  };
}

function withDeferredCodeAnchorWriteReceipt(
  result: CallToolResult,
  request: DeferredCodeAnchorWriteRequest,
): CallToolResult {
  if (result.isError === true) return result;
  const memoryUri = (result.structuredContent as {readonly memoryUri?: unknown} | undefined)?.memoryUri;
  const preparation = request.recovery.preparation;
  const recovery = {
    action: preparation.action,
    arguments: preparation.arguments,
    automaticRetry:
      preparation.target === 'callerCwd'
        ? (['after-graph-index', 'next-code-linked-context-brief'] as const)
        : (['after-workset-prepare'] as const),
    command: preparation.command,
    cliCommand: 'threadnote finalize-code-refs',
    replaceUri: typeof memoryUri === 'string' ? memoryUri : undefined,
    retry: 'replace-stored-memory',
    runFrom: preparation.target === 'callerCwd' ? 'callerCwd' : 'any-directory',
    target: preparation.target,
  };
  const note = [
    'Memory stored now without finalized code citations.',
    `${request.codeRefs.length} code reference(s) are pending in a private local outbox.`,
    preparation.target === 'callerCwd'
      ? 'After the graph is prepared, Threadnote retries automatically during graph indexing and the next code-linked Context Brief.'
      : 'After the Workset is prepared, Threadnote retries automatically.',
    typeof memoryUri === 'string'
      ? `If it remains pending, call remember_context with the same content and replaceUri: "${memoryUri}", or run threadnote finalize-code-refs.`
      : 'If it remains pending, replace the stored memory with the same content and codeRefs, or run threadnote finalize-code-refs.',
  ].join(' ');
  return {
    ...result,
    content: [...result.content, {type: 'text', text: note}],
    structuredContent: {
      ...(result.structuredContent ?? {}),
      citationsFinalized: false,
      citationPolicy: 'defer',
      graph: request.recovery.observedGraph,
      memoryStored: true,
      memoryUri,
      pendingCodeRefs: request.codeRefs.length,
      recovery,
      type: 'memory-code-citation-write-receipt',
      version: 1,
    },
  };
}
