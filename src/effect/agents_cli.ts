import {Clock, Console, DateTime, Effect} from 'effect';
import {Argument, Command} from 'effect/unstable/cli';
import {AGENT_ADAPTERS, getAgentAdapter} from '../agent_integration/adapters.js';
import {
  agentAdapterStatuses,
  registeredAgentAdapterIds,
  runAgentAdapterAction,
} from '../agent_integration/adapter_actions.js';
import type {AgentAdapter, AgentAdapterAction} from '../agent_integration/adapters/contract.js';
import {AGENT_CATALOG} from '../agent_integration/catalog.js';
import {AgentSurfaceError} from '../agent_integration/surfaces.js';
import type {RuntimeConfig} from '../types.js';
import {recordSetupCompletionValueEvent} from '../value_report/events.js';
import {boolean} from './cli_flags.js';

export const agentsCommandMetadata = {
  productionLog: {
    subcommands: {
      list: 'never',
      status: 'never',
      install: 'requires-apply',
      repair: 'requires-apply',
      remove: 'requires-apply',
    },
  },
} as const;

export function setupCompletionForRegistration(
  registeredBefore: readonly string[],
  registeredAfter: readonly string[],
  installedAdapterId: string,
): {readonly supportedAgentReuse: boolean} | undefined {
  const before = new Set(registeredBefore);
  if (before.has(installedAdapterId) || !new Set(registeredAfter).has(installedAdapterId)) return undefined;
  return {supportedAgentReuse: before.size > 0};
}

export const runAgentCliAction = Effect.fn('agents.cliAction')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  action: AgentAdapterAction,
  apply: boolean,
) {
  if (action !== 'install' || !apply) return yield* runAgentAdapterAction(config, adapter, action, apply);
  const registeredBefore = yield* registeredAgentAdapterIds(config);
  const result = yield* runAgentAdapterAction(config, adapter, action, apply);
  const registeredAfter = yield* registeredAgentAdapterIds(config);
  const completion = setupCompletionForRegistration(registeredBefore, registeredAfter, adapter.catalog.id);
  if (completion !== undefined) {
    const timestamp = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    yield* recordSetupCompletionValueEvent(config.agentContextHome, {...completion, timestamp}).pipe(Effect.ignore);
  }
  return result;
});

export function makeAgentsCommand(
  withRuntime: <E, R>(body: (config: RuntimeConfig) => Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>,
) {
  const list = Command.make('list', {json: boolean('json', 'Print the canonical support catalog as JSON')}, ({json}) =>
    Console.log(
      json
        ? JSON.stringify({version: 1, agents: AGENT_CATALOG}, undefined, 2)
        : AGENT_CATALOG.map(
            entry => `${entry.id}\t${entry.tier}\t${entry.displayName}\n  ${entry.setup.join(' ')}`,
          ).join('\n'),
    ),
  );
  const status = Command.make('status', {json: boolean('json', 'Print installed surface status as JSON')}, ({json}) =>
    withRuntime(
      Effect.fn(function* (config: RuntimeConfig) {
        const agents = yield* agentAdapterStatuses(config, AGENT_ADAPTERS);
        yield* Console.log(
          json
            ? JSON.stringify({version: 1, agents}, undefined, 2)
            : agents.map(agent => `${agent.id}\t${agent.state}\t${agent.detail}`).join('\n'),
        );
      }),
    ),
  );
  const actions = (['install', 'repair', 'remove'] as const).map(action =>
    Command.make(
      action,
      {
        surface: Argument.String('surface'),
        apply: boolean('apply', 'Apply the plan; otherwise only preview paths'),
      },
      ({surface, apply}) =>
        withRuntime(
          Effect.fn(function* (config: RuntimeConfig) {
            const adapter = getAgentAdapter(surface);
            if (!adapter)
              return yield* AgentSurfaceError.make({
                message: `Unknown surface ${surface}; run threadnote agents list.`,
              });
            yield* runAgentCliAction(config, adapter, action, apply);
          }),
        ),
    ),
  );
  return Command.make('agents').pipe(
    Command.withDescription('Inspect the support catalog and manage concrete agent surfaces'),
    Command.withSubcommands([list, status, ...actions]),
  );
}
