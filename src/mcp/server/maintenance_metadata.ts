import {Effect} from 'effect';
import {EffectMcpServerAdapter, McpInput} from '../../effect/ai/mcp.js';
import {
  applyMaintenanceMetadata,
  previewMaintenanceMetadata,
  renderMaintenanceMetadata,
} from '../../memory/maintenance/metadata_commands.js';
import type {RuntimeConfig} from '../../types.js';
import {argumentError, mcpErrorResult, optionalResourceUri, requiredText} from './common.js';

/** Registration is intentionally separate; server/index.ts owns top-level tool wiring. */
export function registerMaintenanceMetadataTools(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'context_metadata_preview',
    {
      annotations: {destructiveHint: false, readOnlyHint: true},
      description: 'Preview an exact metadata-only update for one active personal durable memory. No write occurs.',
      inputSchema: metadataInputSchema(),
    },
    input => metadataToolEffect('context_metadata_preview', input, false, config),
  );
  server.registerTool(
    'context_metadata_apply',
    {
      annotations: {destructiveHint: true, idempotentHint: true, readOnlyHint: false},
      description:
        'CAS-apply one explicitly approved previewed metadata proposal; shared or changed memories fail closed.',
      inputSchema: {
        ...metadataInputSchema(),
        approved: McpInput.boolean('Required true after explicit review'),
        expectedContentHash: McpInput.string('Exact content_hash from preview'),
        proposalId: McpInput.string('Exact proposal ID from preview'),
        revision: McpInput.string('Exact proposal revision from preview'),
      },
    },
    input => metadataToolEffect('context_metadata_apply', input, true, config),
  );
}

function metadataInputSchema() {
  return {
    clearOwner: McpInput.boolean('Clear owner explicitly; cannot be combined with owner'),
    clearReviewAfter: McpInput.boolean('Clear review_after explicitly; cannot be combined with reviewAfter'),
    clearValidTo: McpInput.boolean('Clear valid_to explicitly; cannot be combined with validTo'),
    memoryId: McpInput.string('Optional stable tn_ memory ID; provide exactly one of memoryId or uri'),
    owner: McpInput.string('Optional opaque owner label'),
    reviewAfter: McpInput.string('Optional ISO calendar date or canonical ISO instant'),
    uri: McpInput.string('Optional canonical threadnote URI; provide exactly one of uri or memoryId'),
    validTo: McpInput.string('Optional canonical ISO instant'),
  };
}

function metadataToolEffect(name: string, input: Record<string, unknown>, apply: boolean, config: RuntimeConfig) {
  const parsed = parseInput(name, input, apply);
  if (!parsed.ok) return parsed.error;
  return Effect.gen(function* () {
    const result = apply
      ? yield* applyMaintenanceMetadata(
          config,
          parsed.value as unknown as Parameters<typeof applyMaintenanceMetadata>[1],
        )
      : yield* previewMaintenanceMetadata(config, parsed.value);
    return {content: [{type: 'text' as const, text: renderMaintenanceMetadata(result)}], structuredContent: result};
  }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
}

function parseInput(
  name: string,
  input: Record<string, unknown>,
  apply: boolean,
):
  | {readonly ok: true; readonly value: Record<string, unknown>}
  | {readonly ok: false; readonly error: ReturnType<typeof argumentError>} {
  const uri = optionalResourceUri(typeof input.uri === 'string' ? input.uri : undefined, name);
  if (!uri.ok) return uri;
  const memoryId = typeof input.memoryId === 'string' && input.memoryId.trim() ? input.memoryId.trim() : undefined;
  if ((uri.value === undefined) === (memoryId === undefined))
    return {ok: false, error: argumentError(`${name} requires exactly one uri or memoryId.`)};
  const patch = patchField(name, input, 'owner', 'clearOwner', true);
  if (!patch.ok) return patch;
  const reviewAfter = patchField(name, input, 'reviewAfter', 'clearReviewAfter', false);
  if (!reviewAfter.ok) return reviewAfter;
  const validTo = patchField(name, input, 'validTo', 'clearValidTo', false);
  if (!validTo.ok) return validTo;
  const value: Record<string, unknown> = {
    ...(uri.value === undefined ? {} : {uri: uri.value}),
    ...(memoryId === undefined ? {} : {memoryId}),
    ...(patch.value === undefined ? {} : {owner: patch.value}),
    ...(reviewAfter.value === undefined ? {} : {reviewAfter: reviewAfter.value}),
    ...(validTo.value === undefined ? {} : {validTo: validTo.value}),
  };
  if (!apply) return {ok: true, value};
  const approved = input.approved === true;
  const expectedContentHash = requiredText(
    typeof input.expectedContentHash === 'string' ? input.expectedContentHash : undefined,
    name,
    'expectedContentHash',
    {expectedContentHash: '0'.repeat(64)},
  );
  const proposalId = requiredText(
    typeof input.proposalId === 'string' ? input.proposalId : undefined,
    name,
    'proposalId',
    {proposalId: 'maintenance-metadata-'.concat('0'.repeat(40))},
  );
  const revision = requiredText(typeof input.revision === 'string' ? input.revision : undefined, name, 'revision', {
    revision: '0'.repeat(64),
  });
  if (!expectedContentHash.ok) return expectedContentHash;
  if (!proposalId.ok) return proposalId;
  if (!revision.ok) return revision;
  return {
    ok: true,
    value: {
      ...value,
      approved,
      expectedContentHash: expectedContentHash.value,
      proposalId: proposalId.value,
      revision: revision.value,
    },
  };
}

function patchField(
  name: string,
  input: Record<string, unknown>,
  valueName: string,
  clearName: string,
  normalize: boolean,
):
  | {readonly ok: true; readonly value: string | null | undefined}
  | {readonly ok: false; readonly error: ReturnType<typeof argumentError>} {
  const rawValue = typeof input[valueName] === 'string' ? input[valueName] : undefined;
  const value = rawValue === undefined ? undefined : normalize ? rawValue.trim() || undefined : rawValue;
  if (input[clearName] === true && value !== undefined)
    return {ok: false, error: argumentError(`${name} cannot combine ${valueName} with ${clearName}=true.`)};
  return {ok: true, value: input[clearName] === true ? null : value};
}
