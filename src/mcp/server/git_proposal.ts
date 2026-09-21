import {Effect} from 'effect';
import {EffectMcpServerAdapter, McpInput} from '../../effect/ai/mcp.js';
import {buildReviewedKnowledgeDeltaGitProposal} from '../../git_proposal/commands.js';
import type {RuntimeConfig} from '../../types.js';
import {argumentError, mcpErrorResult, requiredText} from './common.js';

export function registerKnowledgeDeltaGitProposalTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'share_propose',
    {
      annotations: {destructiveHint: false, readOnlyHint: true},
      description:
        'Export explicitly approved, applied Knowledge Delta candidates as canonical provider-neutral Git proposal JSON. Reads the configured shared Git base but never writes files, commits, branches, pull requests, or network state.',
      inputSchema: {
        approved: McpInput.boolean('Required true after explicit review of the shared mutations'),
        candidateIds: McpInput.stringOrStrings('Applied candidate ID(s), one to three', {maximumItems: 3}),
        reviewId: McpInput.string('Candidate review ID from closeout preview'),
        revision: McpInput.integer('Exact current candidate review revision', {minimum: 1}),
        team: McpInput.string('Shared Git team; defaults to the configured default team'),
      },
    },
    ({approved, candidateIds, reviewId, revision, team}) => {
      const checkedReview = requiredText(reviewId, 'share_propose', 'reviewId', {
        reviewId: 'review-0123456789abcdef',
      });
      if (!checkedReview.ok) return checkedReview.error;
      if (revision === undefined || !Number.isSafeInteger(revision) || revision < 1) {
        return argumentError('share_propose requires a positive integer revision.');
      }
      const ids = stringList(candidateIds);
      if (ids.length === 0) return argumentError('share_propose requires at least one candidateId.');
      return buildReviewedKnowledgeDeltaGitProposal(config, {
        approved,
        candidateIds: ids,
        reviewId: checkedReview.value,
        revision,
        team,
      }).pipe(
        Effect.map(built => ({
          content: [{type: 'text' as const, text: built.artifact.trimEnd()}],
          structuredContent: built.proposal,
        })),
        Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
      );
    },
  );
}

function stringList(value: string | readonly string[] | undefined): readonly string[] {
  return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}
