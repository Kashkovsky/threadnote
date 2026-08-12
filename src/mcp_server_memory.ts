import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Effect, FileSystem, Path, Result} from 'effect';
import {
  type ArchiveAction,
  buildCompactPlan,
  type CompactableMemoryKind,
  formatCompactPlan,
  parseMemoryDocument,
  type MemoryRecord,
} from './memory_hygiene.js';
import {
  ensureSharedDirectoryChain,
  assertSharedWorktreeFileReady,
  isInSharedNamespace,
  publishShareGitChange,
  resolveTeam,
  applyScrubber,
  sharedMemoryUriParts,
  sharedTeamNameForUri,
  stripPersonalProvenance,
  resourceUriToWorktreeRelative,
  writeMemoryFile,
  writeSharedWorktreeFile,
} from './share.js';
import {errorMessage, safeTimestamp, sha256} from './utils.js';
import {EffectMcpServerAdapter, McpInput} from './effect/ai/mcp.js';
import {sha256Hex} from './effect/digest.js';
import {withMemoryUriLocks} from './effect/memory_lock.js';
import {withSharedRepositoryLock} from './effect/share_lock.js';
import {ResourceStore, type ResourceStoreMutation} from './effect/resource-store.js';
import {canonicalMemoryDocumentContent, formatMemoryDocument, type MemoryMetadata} from './memory_document.js';
import {canonicalResourceUri, parseResourceId, resourceIdWithoutAnchor} from './storage/resource-id.js';
import {
  McpServerOperationError,
  type RuntimeConfig,
  argumentError,
  normalizeOptionalMetadata,
  optionalResourceUri,
  rejectLeadingDash,
  requiredText,
  uriSegment,
} from './mcp_server_common.js';
export function registerCompactTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'compact_context',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        'Plan or apply scoped Threadnote memory hygiene. Defaults to dry-run; pass apply=true to archive stale handoffs and forget exact duplicates.',
      inputSchema: {
        apply: McpInput.boolean('Apply the compact plan; defaults to false'),
        dryRun: McpInput.boolean('Keep the call read-only; defaults to true unless apply=true'),
        kind: McpInput.literals(['durable', 'handoff', 'incident'], 'Optional memory kind filter'),
        project: McpInput.string('Required project/repo namespace, for example threadnote'),
        topic: McpInput.string('Optional stable topic name'),
      },
    },
    ({apply, dryRun, kind, project, topic}) => {
      const checkedProject = requiredText(project, 'compact_context', 'project', {project: 'threadnote'});
      if (!checkedProject.ok) {
        return checkedProject.error;
      }
      if (apply === true && dryRun === true) {
        return {
          content: [{type: 'text', text: 'compact_context cannot combine apply=true with dryRun=true.'}],
          isError: true,
        };
      }
      return Effect.gen(function* () {
        const records = yield* scopedCompactRecords(config, {
          kind: kind as CompactableMemoryKind | undefined,
          project: checkedProject.value,
        });
        const plan = buildCompactPlan(records, {
          kind: kind as CompactableMemoryKind | undefined,
          project: checkedProject.value,
          topic: normalizeOptionalMetadata(topic),
        });
        const shouldApply = apply === true;
        const planText = formatCompactPlan(plan, {apply: shouldApply});
        if (!shouldApply) {
          return {content: [{type: 'text', text: planText}]};
        }

        const ov = 'threadnote-native';
        const appliedMessages: string[] = [];
        for (const action of plan.keepUpdates) {
          const keepResult = yield* writeMemoryContentWithExpectedHash(
            config,
            ov,
            action.uri,
            action.content,
            action.expectedContent,
          );
          if (keepResult.isError === true) {
            return keepResult;
          }
          appliedMessages.push(`Updated kept memory: ${action.uri}`);
        }
        for (const action of plan.archives) {
          const archiveResult = yield* archiveMemoryForCompact(config, action);
          if (archiveResult.isError === true) {
            return archiveResult;
          }
          const [content] = archiveResult.content;
          if (content?.type === 'text') {
            appliedMessages.push(content.text);
          }
        }
        for (const action of plan.forgets) {
          const removed = yield* forgetResourceWithRetry(config, action.uri, false, action.expectedContent);
          appliedMessages.push(
            removed
              ? `Forgot exact duplicate: ${action.uri}`
              : `Exact duplicate is still processing; retry later with forget: ${action.uri}`,
          );
        }
        return {
          content: [
            {
              type: 'text',
              text: [planText, '', 'Applied actions:', ...appliedMessages.map(message => `- ${message}`)].join('\n'),
            },
          ],
        };
      }).pipe(
        Effect.catch(error =>
          Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
        ),
      );
    },
  );
}

function archiveMemoryForCompact(config: RuntimeConfig, action: ArchiveAction) {
  return Effect.gen(function* () {
    const readResult = yield* runNativeReadTool(config, [action.uri]);
    const original = textFromCallToolResult(readResult);
    if (!original) {
      return {content: [{type: 'text', text: `Could not read ${action.uri} before archiving.`}], isError: true};
    }
    const archiveResult = yield* writeDurableMemory(config, {
      bodyText: ['Archived original Threadnote memory.', '', original].join('\n'),
      expectedSourceContent: [{content: action.expectedContent, uri: action.uri}],
      metadata: {
        archivedFrom: action.uri,
        kind: action.kind,
        project: action.project,
        sourceAgentClient: 'mcp',
        status: 'archived',
        timestamp: new Date().toISOString(),
        topic: action.topic,
      },
    });
    if (archiveResult.isError === true) {
      return archiveResult;
    }
    const removedOriginal = yield* forgetResourceWithRetry(config, action.uri, false, action.expectedContent);
    const [content] = archiveResult.content;
    const text = content?.type === 'text' ? content.text : 'Archived memory stored.';
    return {
      content: [
        {
          type: 'text',
          text: removedOriginal
            ? `${text}\nArchived original memory: ${action.uri}`
            : `${text}\nArchive stored, but original memory is still processing. Retry later with forget: ${action.uri}`,
        },
      ],
    } satisfies CallToolResult;
  });
}

const scopedCompactRecords = Effect.fn('mcpServer.scopedCompactRecords')(function* (
  config: RuntimeConfig,
  options: {readonly kind?: CompactableMemoryKind; readonly project: string},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const kinds: readonly CompactableMemoryKind[] = options.kind ? [options.kind] : ['handoff', 'durable', 'incident'];
  const records: MemoryRecord[] = [];
  for (const kind of kinds) {
    const directory = yield* localMemoryDirectoryForCompact(config, kind, options.project);
    const uriDirectory = memoryUriDirectoryForCompact(config, kind, options.project);
    const entries = yield* fs.readDirectory(directory).pipe(Effect.option);
    if (entries._tag === 'None') {
      continue;
    }
    for (const entry of entries.value) {
      if (entry.startsWith('.') || !entry.endsWith('.md')) {
        continue;
      }
      const entryPath = path.join(directory, entry);
      const info = yield* fs.stat(entryPath).pipe(Effect.option);
      if (info._tag === 'None' || info.value.type !== 'File') {
        continue;
      }
      const content = yield* readTextIfExists(entryPath);
      if (!content) {
        continue;
      }
      const record = parseMemoryDocument(`${uriDirectory}/${entry}`, content);
      if (record) {
        records.push(record);
      }
    }
  }
  return records;
});

export const readMemoryRecordsByUri = Effect.fn('mcpServer.readMemoryRecordsByUri')(function* (
  config: RuntimeConfig,
  uris: readonly string[],
) {
  const records: MemoryRecord[] = [];
  for (const uri of uris) {
    const localPath = yield* localMemoryPathForUri(config, uri);
    if (!localPath) {
      continue;
    }
    const content = yield* readTextIfExists(localPath);
    if (!content) {
      continue;
    }
    const record = parseMemoryDocument(uri, content);
    if (record) {
      records.push(record);
    }
  }
  return records;
});

const localMemoryDirectoryForCompact = Effect.fn('mcpServer.localMemoryDirectoryForCompact')(function* (
  config: RuntimeConfig,
  kind: CompactableMemoryKind,
  project: string,
) {
  const path = yield* Path.Path;
  const root = yield* localUserMemoriesRoot(config);
  const projectSegment = uriSegment(project);
  switch (kind) {
    case 'durable':
      return path.join(root, 'durable', 'projects', projectSegment);
    case 'handoff':
      return path.join(root, 'handoffs', 'active', projectSegment);
    case 'incident':
      return path.join(root, 'incidents', 'active', projectSegment);
  }
});

function memoryUriDirectoryForCompact(config: RuntimeConfig, kind: CompactableMemoryKind, project: string): string {
  const base = `threadnote://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(project);
  switch (kind) {
    case 'durable':
      return `${base}/durable/projects/${projectSegment}`;
    case 'handoff':
      return `${base}/handoffs/active/${projectSegment}`;
    case 'incident':
      return `${base}/incidents/active/${projectSegment}`;
  }
}

const localMemoryPathForUri = Effect.fn('mcpServer.localMemoryPathForUri')(function* (
  config: RuntimeConfig,
  uri: string,
) {
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/`;
  if (!uri.startsWith(prefix)) {
    return undefined;
  }
  const relative = uri.slice(prefix.length);
  if (relative.includes('..') || relative.startsWith('/')) {
    return undefined;
  }
  const path = yield* Path.Path;
  return path.join(yield* localUserMemoriesRoot(config), ...relative.split('/'));
});

const localUserMemoriesRoot = Effect.fn('mcpServer.localUserMemoriesRoot')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, 'data', config.account, 'user', uriSegment(config.user), 'memories');
});

const readTextIfExists = Effect.fn('mcpServer.readTextIfExists')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path).pipe(Effect.catch(() => Effect.succeed(undefined)));
});

export interface WriteDurableMemoryParams {
  readonly bodyText: string;
  readonly expectedReplaceContentHash?: string;
  readonly expectedSourceContent?: readonly {readonly content: string; readonly uri: string}[];
  readonly metadata: MemoryMetadata;
  readonly operation?: 'create' | 'replace' | 'upsert';
  readonly prepared?: PreparedPersonalMemoryWrite;
  readonly replaceUri?: string;
}

interface PreparedPersonalMemoryWrite {
  readonly finalMetadata: MemoryMetadata;
  readonly isInPlaceUpdate: boolean;
  readonly memory: string;
  readonly memoryUri: string;
}

export function writeDurableMemory(config: RuntimeConfig, params: WriteDurableMemoryParams) {
  const write = Effect.gen(function* () {
    const prepared = params.prepared ?? (yield* preparePersonalMemoryWrite(config, params));
    const fs = yield* FileSystem.FileSystem;
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [params.replaceUri, prepared.memoryUri, ...(params.expectedSourceContent ?? []).map(source => source.uri)],
      Effect.gen(function* () {
        const ov = 'threadnote-native';
        if (params.operation === 'replace' && !params.replaceUri) {
          return argumentError('A replace write requires replaceUri.');
        }
        if (params.replaceUri && params.expectedReplaceContentHash) {
          const [currentTarget] = yield* readMemoryRecordsByUri(config, [params.replaceUri as string]);
          if (
            !currentTarget ||
            (yield* sha256Hex(canonicalMemoryDocumentContent(currentTarget.content))) !==
              params.expectedReplaceContentHash
          ) {
            return argumentError(
              `Candidate replacement is stale because ${params.replaceUri} changed after review. Run review_session_context again before replacing it.`,
            );
          }
        }
        for (const source of params.expectedSourceContent ?? []) {
          const [currentSource] = yield* readMemoryRecordsByUri(config, [source.uri]);
          if (!currentSource || currentSource.content !== source.content) {
            return argumentError(
              `Memory ${source.uri} changed after this mutation was planned. Re-run the operation before writing.`,
            );
          }
        }
        if (params.replaceUri && isInSharedNamespace(config, params.replaceUri)) {
          return yield* writeSharedMemoryReplacement(config, ov, params, params.replaceUri as string);
        }
        const {finalMetadata, isInPlaceUpdate, memory, memoryUri} = prepared;
        const destinationExists = yield* resourceExists(ov, config, memoryUri);
        if (params.operation === 'replace' && destinationExists && params.replaceUri !== memoryUri) {
          const [destinationRecord] = yield* readMemoryRecordsByUri(config, [memoryUri]);
          if (destinationRecord?.metadata.candidateId !== params.metadata.candidateId) {
            return argumentError(`Replacement destination already contains another memory: ${memoryUri}.`);
          }
        }
        const directoryUri = memoryDirectoryUri(config, finalMetadata);
        yield* ensureMemoryDirectory(ov, config, directoryUri);
        const writeMode =
          params.operation === 'create'
            ? 'create'
            : params.operation === 'replace'
              ? destinationExists
                ? 'replace'
                : 'create'
              : yield* memoryWriteMode(ov, config, memoryUri, finalMetadata);
        yield* writeMemoryFile(config, ov, memoryUri, memory, writeMode, false, {quiet: true});
        const messages = [`Stored memory: ${memoryUri}`];
        let replacementCleanupPending = false;
        if (params.replaceUri && !isInPlaceUpdate) {
          const removedReplacedMemory = yield* removeResourceWithRetry(ov, config, params.replaceUri);
          replacementCleanupPending = !removedReplacedMemory;
          messages.push(
            removedReplacedMemory
              ? `Forgot replaced memory: ${params.replaceUri}`
              : `Replacement stored, but superseded memory is still processing. Retry later with forget: ${params.replaceUri}`,
          );
        } else if (isInPlaceUpdate) {
          messages.push(`Updated existing memory in place: ${memoryUri}`);
        }
        return {
          content: [{type: 'text' as const, text: messages.join('\n')}],
          structuredContent: {memoryUri, replacementCleanupPending},
        };
      }),
    );
  });
  const serializedWrite =
    params.replaceUri && isInSharedNamespace(config, params.replaceUri)
      ? withSharedRepositoryLock(config, write)
      : write;
  return serializedWrite.pipe(
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
    Effect.map(result => result as CallToolResult),
  );
}

/**
 * Computes the exact personal-memory destination and final document before a
 * candidate enters its recoverable `applying` state. The writer consumes this
 * same prepared value so recovery and the actual write cannot disagree.
 */
export const preparePersonalMemoryWrite = Effect.fn('mcpServer.preparePersonalMemoryWrite')(function* (
  config: RuntimeConfig,
  params: Pick<WriteDurableMemoryParams, 'bodyText' | 'metadata' | 'replaceUri'>,
) {
  const [replaced] = params.replaceUri ? yield* readMemoryRecordsByUri(config, [params.replaceUri]) : [];
  const metadata: MemoryMetadata = {
    ...params.metadata,
    createdAt:
      replaced?.metadata.createdAt ??
      replaced?.metadata.timestamp ??
      params.metadata.createdAt ??
      params.metadata.timestamp,
    memoryId:
      replaced?.metadata.memoryId ??
      params.metadata.memoryId ??
      `tn_${(yield* sha256Hex(
        params.metadata.candidateId ??
          `${params.metadata.project ?? ''}\n${params.metadata.topic ?? ''}\n${params.bodyText}`,
      )).slice(0, 20)}`,
    schemaVersion: Math.max(3, params.metadata.schemaVersion ?? 0),
    updatedAt: params.metadata.updatedAt ?? params.metadata.timestamp,
    visibility: 'personal',
  };
  // Two-pass formatting: see src/memory.ts:storeMemory for the rationale.
  // Drops the supersedes line when replaceUri points at the URI we're about
  // to write to (in-place update).
  const candidateMetadata: MemoryMetadata = {...metadata, supersedes: params.replaceUri};
  const candidateMemory = formatMemoryDocument('MEMORY', candidateMetadata, params.bodyText);
  const memoryUri = yield* memoryUriFor(config, candidateMemory, candidateMetadata);
  const isInPlaceUpdate = params.replaceUri !== undefined && params.replaceUri === memoryUri;
  const finalMetadata: MemoryMetadata = isInPlaceUpdate ? {...metadata, supersedes: undefined} : candidateMetadata;
  const memory = isInPlaceUpdate ? formatMemoryDocument('MEMORY', finalMetadata, params.bodyText) : candidateMemory;
  return {finalMetadata, isInPlaceUpdate, memory, memoryUri} satisfies PreparedPersonalMemoryWrite;
});

const writeSharedMemoryReplacement = Effect.fn('mcp_server.writeSharedMemoryReplacement')(function* (
  config: RuntimeConfig,
  ov: string,
  params: WriteDurableMemoryParams,
  targetUri: string,
) {
  if (params.metadata.kind !== 'durable') {
    return argumentError('Shared memory replacement only supports durable memories.');
  }
  const teamName = sharedTeamNameForUri(config, targetUri);
  if (!teamName) {
    return argumentError(`Memory ${targetUri} is not in the shared namespace.`);
  }
  const resolved = yield* resolveTeam(config, teamName);
  const inferred = sharedMemoryUriParts(config, targetUri);
  const metadata: MemoryMetadata = {
    ...params.metadata,
    project: params.metadata.project ?? inferred?.project,
    topic: params.metadata.topic ?? inferred?.topic,
  };
  const rawMemory = formatMemoryDocument('MEMORY', metadata, params.bodyText);
  const scrub = applyScrubber(stripPersonalProvenance(rawMemory), {redact: false});
  if (scrub.blocker) {
    return argumentError(
      `Refusing to update shared memory ${targetUri}: possible ${scrub.blocker}. Strip the sensitive value first.`,
    );
  }

  const [existingTarget] = yield* readMemoryRecordsByUri(config, [targetUri]);
  if (!existingTarget) {
    return argumentError(`Shared memory ${targetUri} no longer exists.`);
  }
  const relativePath = resourceUriToWorktreeRelative(config, targetUri, resolved.name);
  yield* assertSharedWorktreeFileReady(resolved.config.worktree, relativePath, existingTarget.content);
  yield* ensureSharedDirectoryChain(config, ov, targetUri, false, {quiet: true});
  yield* writeMemoryFile(config, ov, targetUri, scrub.cleaned, 'replace', false, {quiet: true});

  yield* writeSharedWorktreeFile(resolved.config.worktree, relativePath, scrub.cleaned);
  const messages = [`Updated shared memory: ${targetUri}`];
  for (const redaction of scrub.redactions) {
    messages.push(`Redacted ${redaction.count}× ${redaction.name} before shared update.`);
  }
  messages.push(
    ...(yield* publishShareGitChange(resolved.config.worktree, relativePath, `share: update ${relativePath}`)),
  );
  return {content: [{type: 'text', text: messages.join('\n')}]};
});

export const resourceExists = Effect.fn('mcp_server.resourceExists')(function* (
  _ov: string,
  config: RuntimeConfig,
  uri: string,
) {
  const store = yield* ResourceStore;
  return yield* store.stat(resourceStoreLocation(config), uri).pipe(
    Effect.as(true),
    Effect.catchTag('ResourceNotFound', () => Effect.succeed(false)),
  );
});

export function removeResourceWithRetry(_ov: string, config: RuntimeConfig, uri: string, recursive = false) {
  return Effect.gen(function* () {
    const store = yield* ResourceStore;
    return yield* store.remove(resourceStoreLocation(config), uri, {recursive}).pipe(
      Effect.as(true),
      Effect.catchTag('ResourceNotFound', () => Effect.succeed(false)),
    );
  });
}

export function resourceStoreLocation(config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>) {
  return {
    account: config.account,
    home: config.agentContextHome,
    user: config.user,
  } as const;
}

export function runNativeRemoveTool(config: RuntimeConfig, uri: string, recursive: boolean) {
  return Effect.gen(function* () {
    const removed = yield* forgetResourceWithRetry(config, uri, recursive);
    return {
      content: [
        {
          type: 'text',
          text: removed ? `Removed: ${uri}` : `Resource not found: ${uri}`,
        },
      ],
      isError: false,
    } satisfies CallToolResult;
  }).pipe(
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
  );
}

const ensureMemoryDirectory = Effect.fn('mcp_server.ensureMemoryDirectory')(function* (
  _ov: string,
  config: RuntimeConfig,
  directoryUri: string,
) {
  const store = yield* ResourceStore;
  yield* store.makeDirectory(resourceStoreLocation(config), directoryUri);
});

const memoryUriFor = Effect.fn('mcpServer.memoryUriFor')(function* (
  config: RuntimeConfig,
  memory: string,
  metadata: MemoryMetadata,
) {
  const filename = shouldUseStableMemoryUri(metadata)
    ? `${uriSegment(metadata.topic ?? 'current')}.md`
    : `threadnote-${safeTimestamp()}-${(yield* sha256(memory)).slice(0, 12)}.md`;
  return `${memoryDirectoryUri(config, metadata)}/${filename}`;
});

function memoryDirectoryUri(config: RuntimeConfig, metadata: MemoryMetadata): string {
  const baseUri = `threadnote://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(metadata.project ?? 'general');
  switch (metadata.kind) {
    case 'preference':
      return metadata.status === 'active'
        ? `${baseUri}/preferences`
        : `${baseUri}/preferences/${uriSegment(metadata.status)}`;
    case 'handoff':
      return `${baseUri}/handoffs/${uriSegment(metadata.status)}/${projectSegment}`;
    case 'incident':
      return `${baseUri}/incidents/${uriSegment(metadata.status)}/${projectSegment}`;
    case 'smoke':
      return `${baseUri}/smoke/${uriSegment(metadata.status)}`;
    case 'durable':
      return metadata.status === 'active'
        ? `${baseUri}/durable/projects/${projectSegment}`
        : `${baseUri}/durable/${uriSegment(metadata.status)}/${projectSegment}`;
  }
}

function shouldUseStableMemoryUri(metadata: MemoryMetadata): boolean {
  return metadata.status === 'active' && metadata.topic !== undefined && metadata.kind !== 'smoke';
}

const memoryWriteMode = Effect.fn('mcp_server.memoryWriteMode')(function* (
  ov: string,
  config: RuntimeConfig,
  memoryUri: string,
  metadata: MemoryMetadata,
) {
  if (!shouldUseStableMemoryUri(metadata)) {
    return 'create';
  }
  return (yield* resourceExists(ov, config, memoryUri)) ? 'replace' : 'create';
});

interface NativeAddResourceParams {
  readonly description?: string;
  readonly path?: string;
  readonly tempFileId?: string;
  readonly to?: string;
  readonly wait?: boolean;
  readonly watchInterval?: number;
}

export const runNativeAddResourceTool = Effect.fn('mcp_server.runNativeAddResourceTool')(function* (
  config: RuntimeConfig,
  toolName: string,
  params: NativeAddResourceParams,
) {
  const tempFileId = params.tempFileId?.trim();
  const source = params.path?.trim();
  if (!source && !tempFileId) {
    return argumentError(
      [
        `Threadnote MCP tool "${toolName}" needs a non-empty "path" argument.`,
        'Pass JSON arguments to the tool call.',
        `Example: ${toolName}(${JSON.stringify({path: '/path/to/README.md', to: 'threadnote://resources/my-repo/README.md'})})`,
      ].join('\n'),
    );
  }
  if (source) {
    const checkedSource = rejectLeadingDash(source, toolName, 'path');
    if (!checkedSource.ok) {
      return checkedSource.error;
    }
  }
  if (tempFileId) {
    return argumentError(
      `Threadnote 4 does not support native canonical store progressive-upload IDs. Pass a local file or directory in "path".`,
    );
  }
  const checkedTo = optionalResourceUri(params.to, toolName);
  if (!checkedTo.ok) {
    return checkedTo.error;
  }
  if (!source) return argumentError(`Threadnote MCP tool "${toolName}" needs a local path.`);
  if (/^https?:\/\//i.test(source)) {
    return argumentError(
      'Threadnote 4 add_resource accepts local files only; download and review remote content first.',
    );
  }
  if ((params.watchInterval ?? 0) > 0) {
    return argumentError(
      'Threadnote 4 does not run filesystem watches. Re-run add_resource or `threadnote seed` when content changes.',
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedSource = path.resolve(source);
  const link = yield* fs.readLink(resolvedSource).pipe(Effect.option);
  if (link._tag === 'Some') {
    return argumentError(`Refusing to import a symbolic link: ${resolvedSource}`);
  }
  const info = yield* fs.stat(resolvedSource).pipe(Effect.result);
  if (Result.isFailure(info)) {
    return argumentError(`Could not read local import path ${resolvedSource}: ${errorMessage(info.failure)}`);
  }
  const store = yield* ResourceStore;
  const location = resourceStoreLocation(config);
  const imported: string[] = [];
  if (info.success.type === 'File') {
    const target = checkedTo.value
      ? resourceIdWithoutAnchor(parseResourceId(checkedTo.value)).canonicalUri
      : canonicalResourceUri('resources', ['imports', path.basename(resolvedSource).normalize('NFC')]);
    yield* store.write(location, target, yield* fs.readFileString(resolvedSource), {mode: 'upsert'});
    imported.push(target);
  } else if (info.success.type === 'Directory') {
    const root = resourceIdWithoutAnchor(
      parseResourceId(
        checkedTo.value ??
          canonicalResourceUri('resources', ['imports', path.basename(resolvedSource).normalize('NFC')]),
      ),
    );
    const planned: Array<{readonly filePath: string; readonly target: string}> = [];
    for (const entry of yield* fs.readDirectory(resolvedSource, {recursive: true})) {
      const filePath = path.join(resolvedSource, entry);
      if ((yield* fs.readLink(filePath).pipe(Effect.option))._tag === 'Some') continue;
      const fileInfo = yield* fs.stat(filePath);
      if (fileInfo.type !== 'File') continue;
      const relativeSegments = path
        .relative(resolvedSource, filePath)
        .split(path.sep)
        .map(segment => segment.normalize('NFC'));
      planned.push({
        filePath,
        target: canonicalResourceUri(root.namespace, [...root.segments, ...relativeSegments]),
      });
    }
    const destinations = new Set<string>();
    for (const plannedImport of planned) {
      const collisionKey = plannedImport.target.normalize('NFC').toLocaleLowerCase();
      if (destinations.has(collisionKey)) {
        return argumentError(`Local import paths collide at destination URI: ${plannedImport.target}`);
      }
      destinations.add(collisionKey);
    }
    const mutations: ResourceStoreMutation[] = [];
    for (const plannedImport of planned) {
      mutations.push({
        content: yield* fs.readFileString(plannedImport.filePath),
        options: {mode: 'upsert'},
        type: 'write',
        uri: plannedImport.target,
      });
      imported.push(plannedImport.target);
    }
    yield* store.mutate(location, mutations);
  } else {
    return argumentError(`Refusing to import non-file path: ${resolvedSource}`);
  }
  return {
    content: [
      {
        type: 'text',
        text: `Imported ${imported.length} canonical resource(s).${params.description ? ` ${params.description.trim()}` : ''}`,
      },
    ],
    structuredContent: {imported},
  } satisfies CallToolResult;
});

interface NativeListToolOptions {
  readonly all?: boolean;
  readonly nodeLimit?: number;
  readonly recursive?: boolean;
  readonly simple?: boolean;
  readonly uri: string;
}

interface NativePatternToolOptions {
  readonly caseInsensitive?: boolean;
  readonly nodeLimit?: number;
  readonly pattern: string;
  readonly uri: string;
}

export function runNativeListTool(
  config: RuntimeConfig,
  options: NativeListToolOptions,
): Effect.Effect<CallToolResult, never, ResourceStore> {
  return Effect.gen(function* () {
    const store = yield* ResourceStore;
    const location = resourceStoreLocation(config);
    const listOne = (uri: string) =>
      store
        .list(location, uri, {recursive: options.recursive === true})
        .pipe(Effect.catchTag('ResourceNotFound', () => Effect.succeed([])));
    const entries =
      options.uri === 'threadnote://'
        ? [
            ...(yield* listOne('threadnote://resources')),
            ...(yield* listOne(`threadnote://user/${uriSegment(config.user)}`)),
          ]
        : yield* listOne(options.uri);
    const visible =
      options.all === true ? entries : entries.filter(entry => !entry.uri.split('/').at(-1)?.startsWith('.'));
    const limited = visible.slice(0, options.nodeLimit ?? 1000);
    const text =
      limited.length === 0
        ? `(nothing found at ${options.uri})`
        : options.simple === true
          ? limited.map(entry => entry.uri).join('\n')
          : limited
              .map(entry => `${entry.type === 'directory' ? 'directory' : 'file'}\t${entry.size}\t${entry.uri}`)
              .join('\n');
    return {
      content: [{type: 'text' as const, text}],
      structuredContent: {entries: limited},
    } satisfies CallToolResult;
  }).pipe(
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
  );
}

export function runNativeGrepTool(
  config: RuntimeConfig,
  options: NativePatternToolOptions,
): Effect.Effect<CallToolResult, never, ResourceStore> {
  return Effect.gen(function* () {
    const store = yield* ResourceStore;
    const matches = yield* store.grep(
      resourceStoreLocation(config),
      options.uri,
      options.pattern,
      options.nodeLimit ?? 100,
    );
    const text =
      matches.length === 0
        ? `(nothing found at ${options.uri})`
        : matches.map(match => `${match.uri}:${match.line}:${match.text}`).join('\n');
    return {
      content: [{type: 'text' as const, text}],
      structuredContent: {matches},
    } satisfies CallToolResult;
  }).pipe(
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
  );
}

export function runNativeGlobTool(
  config: RuntimeConfig,
  options: NativePatternToolOptions,
): Effect.Effect<CallToolResult, never, ResourceStore> {
  return Effect.gen(function* () {
    const store = yield* ResourceStore;
    const entries = yield* store.glob(resourceStoreLocation(config), options.uri, options.pattern);
    const limited = entries.slice(0, options.nodeLimit ?? 100);
    return {
      content: [
        {
          type: 'text' as const,
          text: limited.length === 0 ? `(nothing found at ${options.uri})` : limited.map(entry => entry.uri).join('\n'),
        },
      ],
      structuredContent: {entries: limited},
    } satisfies CallToolResult;
  }).pipe(
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
  );
}

export const runNativeHealthTool = Effect.fn('mcp_server.runNativeHealthTool')(function* (config: RuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
  const homeExists = yield* fs.exists(config.agentContextHome);
  return {
    content: [
      {
        type: 'text' as const,
        text: `Threadnote native runtime: ok\nHome: ${config.agentContextHome}\nHome initialized: ${homeExists ? 'yes' : 'no'}`,
      },
    ],
    structuredContent: {
      home: config.agentContextHome,
      homeInitialized: homeExists,
      status: 'ok',
      storage: 'native',
    },
  } satisfies CallToolResult;
});

export function runNativeReadTool(
  config: RuntimeConfig,
  uris: readonly string[],
): Effect.Effect<CallToolResult, never, ResourceStore> {
  // Canonical memory reads are intentionally complete. Context budgets belong
  // to derived graph/search evidence, never to user-authored memory content.
  // Keep the canonical bytes in MCP content only: repeating them in
  // structuredContent can make an otherwise valid read exceed a client's
  // transport-frame policy, while metadata-only structuredContent can cause
  // clients that prefer structured results to hide the canonical bytes. The
  // URI-to-content association is implementation metadata, so keep it in the
  // protocol-reserved _meta field instead of a model-facing result field.
  return Effect.gen(function* () {
    const store = yield* ResourceStore;
    const content: Array<{readonly text: string; readonly type: 'text'}> = [];
    const resources: Array<{readonly contentIndex: number; readonly uri: string}> = [];
    for (const uri of uris) {
      const text = yield* store.read(resourceStoreLocation(config), uri);
      resources.push({contentIndex: content.length, uri});
      content.push({text, type: 'text'});
    }
    return {
      _meta: {
        'threadnote.io/canonical-read': {resources, type: 'threadnote-canonical-read', version: 1},
      },
      content,
    } satisfies CallToolResult;
  }).pipe(
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
  );
}

export function textFromCallToolResult(result: CallToolResult): string {
  return result.content
    .map(content => (content.type === 'text' ? content.text : ''))
    .join('\n')
    .trim();
}

export function writeMemoryContentWithExpectedHash(
  config: RuntimeConfig,
  ov: string,
  uri: string,
  content: string,
  expectedContent: string,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [uri],
      Effect.gen(function* () {
        const [current] = yield* readMemoryRecordsByUri(config, [uri]);
        if (!current || current.content !== expectedContent) {
          return argumentError(`Memory ${uri} changed after compact_context planned its update. Re-run the plan.`);
        }
        yield* writeMemoryFile(config, ov, uri, content, 'replace', false, {quiet: true});
        return {content: [{type: 'text' as const, text: `Updated memory: ${uri}`}]};
      }),
    );
  });
}

export function forgetResourceWithRetry(
  config: RuntimeConfig,
  uri: string,
  recursive = false,
  expectedContent?: string,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [uri],
      Effect.gen(function* () {
        if (expectedContent) {
          const [current] = yield* readMemoryRecordsByUri(config, [uri]);
          if (!current || current.content !== expectedContent) {
            return yield* Effect.fail(
              new McpServerOperationError(
                `Memory ${uri} changed after this removal was planned. Re-run the operation.`,
              ),
            );
          }
        }
        return yield* removeResourceWithRetry('threadnote-native', config, uri, recursive);
      }),
    );
  });
}
