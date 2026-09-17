import {Effect, Path} from 'effect';
import {EffectMcpServerAdapter, McpInput} from '../../effect/ai/mcp.js';
import {collectContextHealth, renderContextHealth} from '../../memory/context_health_commands.js';
import {readActiveProjectMemoryRecords} from '../../memory/maintenance_records.js';
import type {RuntimeConfig} from '../../types.js';
import {argumentError, mcpErrorResult, requiredText} from './common.js';

export function registerContextHealthTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'context_health',
    {
      annotations: {destructiveHint: false, readOnlyHint: true},
      description:
        'Inspect one project for stale, conflicting, duplicate, or invalid context using current local evidence. This is read-only and never prepares a graph or applies repairs.',
      inputSchema: {
        callerCwd: McpInput.string('Required absolute repository or worktree path'),
        project: McpInput.string('Required project/repo namespace'),
      },
    },
    ({callerCwd, project}) => {
      const checkedProject = requiredText(project, 'context_health', 'project', {
        callerCwd: '/workspace/project',
        project: 'threadnote',
      });
      if (!checkedProject.ok) return checkedProject.error;
      const checkedCwd = requiredText(callerCwd, 'context_health', 'callerCwd', {
        callerCwd: '/workspace/project',
        project: checkedProject.value,
      });
      if (!checkedCwd.ok) return checkedCwd.error;
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        if (!path.isAbsolute(checkedCwd.value)) {
          return argumentError('context_health callerCwd must be an absolute repository or worktree path.');
        }
        const records = yield* readActiveProjectMemoryRecords(config, checkedProject.value);
        const report = yield* collectContextHealth(config, checkedProject.value, records, checkedCwd.value);
        return {
          content: [{type: 'text' as const, text: renderContextHealth(report)}],
          structuredContent: report,
        };
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
    },
  );
}
