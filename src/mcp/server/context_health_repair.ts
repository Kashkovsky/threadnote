import {Effect, Path} from 'effect';
import {EffectMcpServerAdapter, McpInput} from '../../effect/ai/mcp.js';
import {
  applyContextHealthRepair,
  previewContextHealthRepairs,
  renderContextHealthRepairApply,
  renderContextHealthRepairPlan,
} from '../../memory/context_health_repair_commands.js';
import type {RuntimeConfig} from '../../types.js';
import {argumentError, mcpErrorResult, requiredText} from './common.js';

export function registerContextHealthRepairTools(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'context_health_repair_preview',
    {
      annotations: {destructiveHint: false, readOnlyHint: true},
      description:
        'Preview bounded, exact context-health repairs. Semantic supersede suggestions require an explicit contradiction ID, report revision, stale URI, and current URI from a prior preview.',
      inputSchema: {
        callerCwd: McpInput.string('Required absolute repository or worktree path'),
        contradictionId: McpInput.string('Optional analyzer contradiction ID; supply all semantic direction fields'),
        currentUri: McpInput.string('Optional reviewed current memory URI; supply all semantic direction fields'),
        project: McpInput.string('Required project/repo namespace'),
        reportRevision: McpInput.string('Optional exact health report revision; supply all semantic direction fields'),
        staleUri: McpInput.string('Optional reviewed stale memory URI; supply all semantic direction fields'),
      },
    },
    ({callerCwd, contradictionId, currentUri, project, reportRevision, staleUri}) => {
      const checked = repairToolScope('context_health_repair_preview', callerCwd, project);
      if (!checked.ok) return checked.error;
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        if (!path.isAbsolute(checked.cwd)) {
          return argumentError('context health repair callerCwd must be an absolute repository or worktree path.');
        }
        const plan = yield* previewContextHealthRepairs(config, checked.project, checked.cwd, {
          contradictionId,
          currentUri,
          reportRevision,
          staleUri,
        });
        return {
          content: [{type: 'text' as const, text: renderContextHealthRepairPlan(plan)}],
          structuredContent: plan,
        };
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
    },
  );

  server.registerTool(
    'context_health_repair_apply',
    {
      annotations: {destructiveHint: true, readOnlyHint: false},
      description:
        'Apply one exact personal-memory repair after explicit approval. Requires the proposal ID and revision from preview; shared and review-only proposals are never mutated.',
      inputSchema: {
        approved: McpInput.boolean('Required true after explicit approval of this proposal revision'),
        callerCwd: McpInput.string('Required absolute repository or worktree path'),
        project: McpInput.string('Required project/repo namespace'),
        proposalId: McpInput.string('Exact proposal ID from context_health_repair_preview'),
        revision: McpInput.string('Exact proposal revision from context_health_repair_preview'),
      },
    },
    ({approved, callerCwd, project, proposalId, revision}) => {
      const checked = repairToolScope('context_health_repair_apply', callerCwd, project);
      if (!checked.ok) return checked.error;
      const checkedProposal = requiredText(proposalId, 'context_health_repair_apply', 'proposalId', {
        proposalId: `health-repair-${'0'.repeat(40)}`,
      });
      if (!checkedProposal.ok) return checkedProposal.error;
      const checkedRevision = requiredText(revision, 'context_health_repair_apply', 'revision', {
        revision: '0'.repeat(64),
      });
      if (!checkedRevision.ok) return checkedRevision.error;
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        if (!path.isAbsolute(checked.cwd)) {
          return argumentError('context health repair callerCwd must be an absolute repository or worktree path.');
        }
        const result = yield* applyContextHealthRepair(config, {
          approved,
          cwd: checked.cwd,
          project: checked.project,
          proposalId: checkedProposal.value,
          revision: checkedRevision.value,
        });
        return {
          content: [{type: 'text' as const, text: renderContextHealthRepairApply(result)}],
          structuredContent: result,
        };
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
    },
  );
}

function repairToolScope(name: string, callerCwd: string | undefined, project: string | undefined) {
  const checkedProject = requiredText(project, name, 'project', {
    callerCwd: '/workspace/project',
    project: 'threadnote',
  });
  if (!checkedProject.ok) return {error: checkedProject.error, ok: false as const};
  const checkedCwd = requiredText(callerCwd, name, 'callerCwd', {
    callerCwd: '/workspace/project',
    project: checkedProject.value,
  });
  if (!checkedCwd.ok) return {error: checkedCwd.error, ok: false as const};
  return {
    cwd: checkedCwd.value,
    ok: true as const,
    project: checkedProject.value,
  };
}
