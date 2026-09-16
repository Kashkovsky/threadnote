import type {Effect} from 'effect';
import {Argument, Command} from 'effect/unstable/cli';
import type {AgentClient, HookRunnerOptions, HooksInstallOptions} from '../types.js';
import type {CursorHookEvent} from '../cursor_hooks.js';
import {boolean, optionalChoice, optionalString} from './cli_flags.js';

export function makeInstallHooksCommand<E, R>(
  handler: (agent: AgentClient, options: HooksInstallOptions) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'install-hooks',
    {
      agent: Argument.Literals('agent', ['codex', 'claude', 'cursor', 'copilot', 'omp']).pipe(
        Argument.withDescription('codex, claude, cursor, copilot, or omp'),
      ),
      apply: boolean('apply', 'Actually modify the selected agent config'),
      dryRun: boolean('dry-run', 'Print the planned change without applying it'),
      remove: boolean('remove', 'Remove threadnote-managed hook entries instead of adding them'),
      target: optionalChoice('target', ['desktop', 'cloud'], 'Cursor hook environment (default: desktop)'),
      project: optionalString('project', 'Cursor project repository root; required for hosted Cloud hooks'),
    },
    ({agent, ...options}) => handler(agent, options),
  ).pipe(Command.withDescription('Install deterministic agent lifecycle hooks'));
}

export function makeCursorHookCommand<E, R>(
  handler: (event: CursorHookEvent, options: HookRunnerOptions) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'cursor-hook',
    {
      event: Argument.Literals('event', ['sessionStart', 'preCompact']),
      dryRun: boolean('dry-run', 'Preview the hook action without storing memory'),
    },
    ({event, ...options}) => handler(event, options),
  ).pipe(Command.withDescription('Run a managed Cursor JSON lifecycle hook'), Command.unlisted);
}

export function makePreCompactHookCommand<E, R>(
  handler: (options: HookRunnerOptions & {readonly sourceAgentClient?: 'omp'}) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'pre-compact-hook',
    {
      dryRun: boolean('dry-run', 'Print the handoff payload without writing it'),
      sourceAgentClient: optionalChoice('source-agent-client', ['omp'], 'Source host for a state-only snapshot'),
    },
    handler,
  ).pipe(Command.withDescription('Store a handoff snapshot before context compaction'), Command.unlisted);
}
