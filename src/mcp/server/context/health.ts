import {Effect, Path} from 'effect';
import {EffectMcpServerAdapter, McpInput} from '../../../effect/ai/mcp.js';
import {collectContextHealth, renderContextHealth} from '../../../memory/context/health_commands.js';
import {collectContextHealthAggregate} from '../../../memory/context/health_aggregate_commands.js';
import {
  buildContextHealthSchedulePlanV1,
  ContextHealthScheduleError,
  renderContextHealthAggregate,
  renderContextHealthSchedulePlan,
} from '../../../memory/context/health_schedule.js';
import {readActiveProjectMemoryRecords} from '../../../memory/maintenance/records.js';
import {
  CONTEXT_HEALTH_FINDING_CATEGORIES,
  CONTEXT_HEALTH_MEMORY_KINDS,
  contextHealthSelectorFindingUris,
  normalizeContextHealthSelector,
  projectContextHealthRecords,
} from '../../../memory/context/health_selector.js';
import type {RuntimeConfig} from '../../../types.js';
import {errorMessage} from '../../../utils.js';
import {argumentError, mcpErrorResult, requiredText} from '../common.js';

export function registerContextHealthTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'context_health',
    {
      annotations: {destructiveHint: false, readOnlyHint: true},
      description:
        'Inspect one project for stale, conflicting, duplicate, or invalid context using current local evidence. This is read-only and never prepares a graph or applies repairs.',
      inputSchema: {
        after: McpInput.string('Opaque continuation cursor returned by the prior exact-scope page'),
        callerCwd: McpInput.string('Required absolute repository or worktree path'),
        findingCategory: McpInput.literals(
          CONTEXT_HEALTH_FINDING_CATEGORIES,
          'Optional exact finding category; intersects with kind and topic',
        ),
        kind: McpInput.literals(CONTEXT_HEALTH_MEMORY_KINDS, 'Optional exact memory kind'),
        project: McpInput.string('Required project/repo namespace'),
        topic: McpInput.string('Optional exact memory topic; may be combined with kind'),
      },
    },
    ({after, callerCwd, findingCategory, kind, project, topic}) => {
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
        const selector = normalizeContextHealthSelector({after, findingCategory, kind, topic});
        const selectedRecords = projectContextHealthRecords(records, selector);
        const report = yield* collectContextHealth(config, checkedProject.value, selectedRecords, checkedCwd.value, {
          after: selector?.after,
          duplicateCorpus: records,
          ...(selector === undefined ? {} : {includeFindingCombination: 'all' as const}),
          ...(selector?.findingCategory === undefined ? {} : {includeFindingCategories: [selector.findingCategory]}),
          ...(contextHealthSelectorFindingUris(selector, selectedRecords) === undefined
            ? {}
            : {includeFindingUris: contextHealthSelectorFindingUris(selector, selectedRecords)}),
        });
        return {
          content: [{type: 'text' as const, text: renderContextHealth(report, selector)}],
          structuredContent: report,
        };
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
    },
  );

  server.registerTool(
    'context_health_aggregate',
    {
      annotations: {destructiveHint: false, readOnlyHint: true},
      description:
        'Aggregate personal context health with explicitly selected configured local Git team snapshots. Omit team to select every configured team. This never fetches, syncs, writes, or prepares a graph.',
      inputSchema: {
        callerCwd: McpInput.string('Required absolute repository or worktree path for personal citation evidence'),
        project: McpInput.string('Required project/repo namespace'),
        team: McpInput.stringOrStrings('Configured Git team snapshot(s); omit for every configured team', {
          maximumItems: 32,
        }),
      },
    },
    ({callerCwd, project, team}) => {
      const checkedProject = requiredText(project, 'context_health_aggregate', 'project', {
        callerCwd: '/workspace/project',
        project: 'threadnote',
      });
      if (!checkedProject.ok) return checkedProject.error;
      const checkedCwd = requiredText(callerCwd, 'context_health_aggregate', 'callerCwd', {
        callerCwd: '/workspace/project',
        project: checkedProject.value,
      });
      if (!checkedCwd.ok) return checkedCwd.error;
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        if (!path.isAbsolute(checkedCwd.value)) {
          return argumentError('context_health_aggregate callerCwd must be an absolute repository or worktree path.');
        }
        const aggregate = yield* collectContextHealthAggregate(config, {
          callerCwd: checkedCwd.value,
          project: checkedProject.value,
          teams: stringList(team),
        });
        return {
          content: [{type: 'text' as const, text: renderContextHealthAggregate(aggregate)}],
          structuredContent: aggregate,
        };
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
    },
  );

  server.registerTool(
    'context_health_schedule',
    {
      annotations: {destructiveHint: false, readOnlyHint: true},
      description:
        'Render a provider-neutral scheduled invocation contract for local context health aggregation. The plan is read-only and network-disabled; it does not install a schedule.',
      inputSchema: {
        cadenceMinutes: McpInput.integer('Required cadence in minutes, from 5 through 43200', {
          maximum: 43_200,
          minimum: 5,
        }),
        project: McpInput.string('Required project/repo namespace'),
        team: McpInput.stringOrStrings('Configured Git team snapshot(s); omit for every configured team', {
          maximumItems: 32,
        }),
      },
    },
    ({cadenceMinutes, project, team}) => {
      const checkedProject = requiredText(project, 'context_health_schedule', 'project', {project: 'threadnote'});
      if (!checkedProject.ok) return checkedProject.error;
      if (cadenceMinutes === undefined || !Number.isSafeInteger(cadenceMinutes)) {
        return argumentError('context_health_schedule requires an integer cadenceMinutes from 5 through 43200.');
      }
      return Effect.try({
        try: () =>
          buildContextHealthSchedulePlanV1({
            cadenceMinutes,
            project: checkedProject.value,
            teams: stringList(team),
          }),
        catch: cause => ContextHealthScheduleError.make({message: errorMessage(cause)}),
      }).pipe(
        Effect.map(plan => ({
          content: [{type: 'text' as const, text: renderContextHealthSchedulePlan(plan)}],
          structuredContent: plan,
        })),
        Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
      );
    },
  );
}

function stringList(value: string | readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? [value] : value;
}
