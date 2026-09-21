import {Effect} from 'effect';
import {EffectMcpServerAdapter, McpInput} from '../../effect/ai/mcp.js';
import {publishVerifiedProcedure} from '../../procedure/publication.js';
import type {RuntimeConfig} from '../../types.js';
import {mcpErrorResult, requiredText} from './common.js';

export function registerProcedurePublicationTools(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'procedure_publish_preview',
    {
      annotations: {destructiveHint: false, idempotentHint: true, readOnlyHint: true},
      description:
        'Build a deterministic Git-share proposal for exact locally verified procedure bytes. Never writes, commits, or pushes.',
      inputSchema: publicationInputSchema(false),
    },
    input => publicationHandler(config, input, false),
  );
  server.registerTool(
    'procedure_publish_apply',
    {
      annotations: {destructiveHint: true, idempotentHint: true, readOnlyHint: false},
      description:
        'Publish an exact procedure proposal into the configured team Git share. Requires explicit approval and the unchanged preview proposal ID.',
      inputSchema: publicationInputSchema(true),
    },
    input => publicationHandler(config, input, true),
  );
}

function publicationInputSchema(apply: boolean) {
  return {
    approved: McpInput.boolean(apply ? 'Required true after reviewing the exact preview' : 'Ignored in preview'),
    artifact: McpInput.string('Explicit local artifact path'),
    manifest: McpInput.string('Explicit local procedure manifest path'),
    proposalId: McpInput.string(apply ? 'Exact ID emitted by procedure_publish_preview' : 'Ignored in preview'),
    push: McpInput.boolean('Push the resulting Git commit; default false'),
    receipt: McpInput.string('Explicit local verification receipt path'),
    team: McpInput.string('Configured shared team; defaults to the default team'),
  };
}

function publicationHandler(
  config: RuntimeConfig,
  input: {
    readonly approved?: boolean;
    readonly artifact?: string;
    readonly manifest?: string;
    readonly proposalId?: string;
    readonly push?: boolean;
    readonly receipt?: string;
    readonly team?: string;
  },
  apply: boolean,
) {
  const tool = apply ? 'procedure_publish_apply' : 'procedure_publish_preview';
  const artifact = requiredText(input.artifact, tool, 'artifact', {artifact: '/workspace/procedure.md'});
  if (!artifact.ok) return artifact.error;
  const manifest = requiredText(input.manifest, tool, 'manifest', {manifest: '/workspace/procedure.json'});
  if (!manifest.ok) return manifest.error;
  const receipt = requiredText(input.receipt, tool, 'receipt', {receipt: '/workspace/receipt.json'});
  if (!receipt.ok) return receipt.error;
  return publishVerifiedProcedure(config, {
    apply,
    approved: input.approved,
    artifact: artifact.value,
    manifest: manifest.value,
    proposalId: input.proposalId,
    push: input.push,
    receipt: receipt.value,
    team: input.team,
  }).pipe(
    Effect.map(plan => ({content: [{type: 'text' as const, text: JSON.stringify(plan)}], structuredContent: plan})),
    Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
  );
}
