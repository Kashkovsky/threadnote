import {Console, Effect, FileSystem, Path, Schema} from 'effect';
import {USER_INSTRUCTIONS_START_MARKER, USER_INSTRUCTIONS_END_MARKER, THREADNOTE_MCP_CLIENT_ENV} from '../constants.js';
import {sha256Hex} from '../effect/digest.js';
import {SystemInfo} from '../effect/system.js';
import {mcpAdapterCommand} from '../mcp/install.js';
import {MCP_TOOLSET_ENV, type McpToolset} from '../mcp/toolset.js';
import {getThreadnoteVersion} from '../release/runtime_version.js';
import type {JsonObject, RuntimeConfig} from '../types.js';
import {errorMessage, isJsonObject, readFileIfExists, toolRoot} from '../utils.js';
import type {
  AgentAdapter,
  AgentAdapterActionOptions,
  AgentAdapterDefinition,
  AgentAdapterStatusContext,
  JsonAgentStrategy,
} from './adapters/contract.js';
import {
  atomicAgentWrite,
  assertAgentTargetNotSymlink,
  extractManagedBlock,
  removeAgentTargetIfUnchanged,
  removeArtifact,
  writeArtifact,
  type AgentArtifact,
} from './index.js';
import {jsonServerDisabled, mergeAgentServer, parseAgentJson, removeAgentServer} from './json_config.js';
import {
  artifactHasOtherConsumers,
  emptyAgentIntegrationRegistry,
  readAgentIntegrationRegistry,
  withAgentIntegrationLock,
  writeAgentIntegrationRegistry,
  type AgentIntegrationRegistry,
  type AgentSurfaceReceipt,
} from './registry.js';

export class AgentSurfaceError extends Schema.TaggedError<AgentSurfaceError>()('AgentSurfaceError', {
  message: Schema.String,
}) {}

function attempt<A>(body: () => A) {
  return Effect.try({try: body, catch: cause => AgentSurfaceError.make({message: errorMessage(cause)})});
}

export interface SurfaceInstallOptions {
  readonly apply?: boolean;
  readonly toolset?: McpToolset;
}

export const planAgentSurface = Effect.fn('agentSurfaces.plan')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: SurfaceInstallOptions = {},
  previous?: AgentSurfaceReceipt,
) {
  if (!adapter.json)
    return yield* AgentSurfaceError.make({
      message: `No managed JSON installer for ${adapter.catalog.id}; consult threadnote agents list.`,
    });
  const strategy = adapter.json;
  const system = yield* SystemInfo;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const xdg = system.environment().XDG_CONFIG_HOME;
  if (strategy.xdg && xdg && !path.isAbsolute(xdg))
    return yield* AgentSurfaceError.make({message: 'XDG_CONFIG_HOME must be absolute.'});
  const root =
    previous?.root ??
    path.join(strategy.xdg ? xdg || path.join(system.homeDirectory, '.config') : system.homeDirectory, strategy.root);
  const skillRoot =
    previous?.skillRoot ??
    (strategy.skillRoot === 'shared'
      ? path.join(system.homeDirectory, '.agents', 'skills')
      : path.join(root, 'skills'));
  const templateRoot = path.join(yield* toolRoot(), 'config');
  const bootstrap = (yield* fs.readFileString(path.join(templateRoot, 'agent-instructions.md'))).trim();
  const instruction = `${USER_INSTRUCTIONS_START_MARKER}\n${bootstrap}\n${USER_INSTRUCTIONS_END_MARKER}`;
  const artifacts: AgentArtifact[] = [
    {
      content: instruction,
      hash: yield* sha256Hex(instruction),
      kind: 'block',
      name: 'instructions',
      path: path.join(root, strategy.instructionFile),
    },
  ];
  for (const skill of ['threadnote-context', 'threadnote-code-graph', 'threadnote-memory']) {
    const content = `${(yield* fs.readFileString(path.join(templateRoot, 'agent-skills', skill, 'SKILL.md'))).trim()}\n`;
    artifacts.push({
      content,
      hash: yield* sha256Hex(content),
      kind: 'file',
      name: `skill ${skill}`,
      path: path.join(skillRoot, skill, 'SKILL.md'),
    });
  }
  const command = yield* mcpAdapterCommand();
  const toolset = options.toolset ?? previous?.mcp.toolset ?? 'core';
  const entry: JsonObject = {
    ...(strategy.entryType === undefined ? {} : {type: strategy.entryType}),
    command: command[0],
    args: command.slice(1),
    env: {
      THREADNOTE_ACCOUNT: config.account,
      THREADNOTE_AGENT_ID: config.agentId,
      THREADNOTE_HOME: config.agentContextHome,
      THREADNOTE_USER: config.user,
      [THREADNOTE_MCP_CLIENT_ENV]: adapter.catalog.agentId,
      [MCP_TOOLSET_ENV]: toolset,
    },
  };
  return {
    adapter,
    artifacts,
    root,
    skillRoot,
    entry,
    mcpPath: previous?.mcp.path ?? path.join(root, strategy.mcpFile),
    name: previous?.mcp.name ?? 'threadnote',
    toolset,
  };
});

export function installJsonAgentSurface(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: SurfaceInstallOptions = {},
) {
  const install = Effect.gen(function* () {
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    if (path.resolve(config.agentContextHome) !== path.join(system.homeDirectory, '.threadnote')) {
      return yield* AgentSurfaceError.make({
        message: 'These adapters currently support personal user scope only; use the personal ~/.threadnote home.',
      });
    }
    const registry = (yield* readAgentIntegrationRegistry(config)) ?? emptyAgentIntegrationRegistry(false);
    const id = adapter.catalog.id;
    const previous = registry.surfaces?.[id];
    const plan = yield* planAgentSurface(config, adapter, options, previous);
    if (previous !== undefined && !receiptMatchesPlan(previous, plan)) {
      return yield* AgentSurfaceError.make({
        message:
          `${id} was installed with a different adapter contract. ` +
          'A versioned adapter migration is required before repair can continue.',
      });
    }
    const raw = yield* readFileIfExists(plan.mcpPath);
    const parsed = yield* attempt(() => parseAgentJson(raw));
    const strategy = plan.adapter.json!;
    const container = parsed[strategy.container];
    const current = isJsonObject(container) ? container[plan.name] : undefined;
    if (
      current !== undefined &&
      (!previous || !isOwnedEntry(current, plan.adapter.catalog.agentId, config.agentContextHome))
    ) {
      return yield* AgentSurfaceError.make({
        message: `${plan.mcpPath} already contains an unowned ${plan.name} entry; not replacing it.`,
      });
    }
    const currentEnvironment = isJsonObject(current) && isJsonObject(current.env) ? current.env : {};
    const entry = {
      ...(isJsonObject(current) ? current : {}),
      ...plan.entry,
      env: {...currentEnvironment, ...(isJsonObject(plan.entry.env) ? plan.entry.env : {})},
    };
    const next = yield* attempt(() => mergeAgentServer(parsed, strategy.container, plan.name, entry));
    if (!options.apply) {
      yield* Console.log(`Would merge ${strategy.container}.${plan.name} in ${plan.mcpPath}`);
      for (const artifact of plan.artifacts) yield* Console.log(`Would install ${artifact.name}: ${artifact.path}`);
      return;
    }
    yield* assertAgentTargetNotSymlink(plan.mcpPath);
    for (const artifact of plan.artifacts) yield* assertAgentTargetNotSymlink(artifact.path);
    const receipt: AgentSurfaceReceipt = {
      adapterVersion: plan.adapter.adapterVersion,
      surfaceId: id,
      agentId: plan.adapter.catalog.agentId,
      root: plan.root,
      skillRoot: plan.skillRoot,
      installedVersion: yield* getThreadnoteVersion(),
      status: 'pending',
      artifacts: Object.fromEntries(plan.artifacts.map(artifact => [artifact.path, artifact.hash])),
      artifactDescriptors: plan.artifacts.map(({hash, kind, name, path}) => ({hash, kind, name, path})),
      strategy: {codec: 'json', container: strategy.container, kind: 'json'},
      mcp: {
        path: plan.mcpPath,
        name: plan.name,
        hash: yield* sha256Hex(JSON.stringify(entry)),
        toolset: plan.toolset,
        createdContainer: previous?.mcp.createdContainer ?? container === undefined,
        createdFile: previous?.mcp.createdFile ?? raw === undefined,
      },
    };
    const pending = {...registry, surfaces: {...registry.surfaces, [id]: receipt}};
    yield* writeAgentIntegrationRegistry(config, pending);
    if (JSON.stringify(next) !== JSON.stringify(parsed))
      yield* atomicAgentWrite(plan.mcpPath, `${JSON.stringify(next, undefined, 2)}\n`, 0o600, {content: raw});
    for (const artifact of plan.artifacts) yield* writeArtifact(artifact);
    yield* writeAgentIntegrationRegistry(config, {
      ...pending,
      surfaces: {...pending.surfaces, [id]: {...receipt, status: 'current'}},
    });
    yield* Console.log(
      `Installed ${plan.adapter.catalog.displayName}; restart the host. Lifecycle hooks are not installed.`,
    );
  });
  return options.apply ? withAgentIntegrationLock(config, install) : install;
}

function isOwnedEntry(value: unknown, agentId: string, home: string): value is JsonObject {
  return (
    isJsonObject(value) &&
    typeof value.command === 'string' &&
    isJsonObject(value.env) &&
    value.env[THREADNOTE_MCP_CLIENT_ENV] === agentId &&
    value.env.THREADNOTE_HOME === home
  );
}

export const agentSurfaceStatus = Effect.fn('agentSurfaces.status')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  context: AgentAdapterStatusContext,
) {
  const receipt = context.registry?.surfaces?.[adapter.catalog.id];
  if (!adapter.json)
    return {
      state: adapter.catalog.tier === 'manual' ? ('manual' as const) : ('unsupported' as const),
      detail: adapter.catalog.caveats.join(' '),
    };
  if (!receipt) return {state: 'absent' as const, detail: 'No managed installation receipt.'};
  if (receipt.status === 'pending')
    return {state: 'stale' as const, detail: 'Installation is incomplete; repair will retry.'};
  const plan = yield* planAgentSurface(config, adapter, {}, receipt);
  if (!receiptMatchesPlan(receipt, plan)) {
    return {state: 'stale' as const, detail: 'Installed adapter contract requires a versioned migration.'};
  }
  const raw = yield* readFileIfExists(receipt.mcp.path);
  const parsed = yield* attempt(() => parseAgentJson(raw));
  if (jsonServerDisabled(parsed, receipt.strategy.container, receipt.mcp.name, adapter.json.policyGlobs))
    return {state: 'disabled' as const, detail: 'Host configuration disables the server; review host policy.'};
  const container = parsed[receipt.strategy.container];
  const entry = isJsonObject(container) ? container[receipt.mcp.name] : undefined;
  if (
    !entry ||
    (yield* sha256Hex(JSON.stringify(entry))) !== receipt.mcp.hash ||
    !isJsonObject(entry) ||
    entry.command !== plan.entry.command ||
    JSON.stringify(entry.args) !== JSON.stringify(plan.entry.args) ||
    !isJsonObject(entry.env) ||
    !isJsonObject(plan.entry.env) ||
    Object.entries(plan.entry.env).some(([key, value]) => !isJsonObject(entry.env) || entry.env[key] !== value)
  ) {
    return {state: 'stale' as const, detail: 'MCP entry is missing or changed.'};
  }
  for (const artifact of plan.artifacts) {
    const current = yield* readFileIfExists(artifact.path);
    if (
      current === undefined ||
      (current !== artifact.content && extractManagedBlock(current) !== extractManagedBlock(artifact.content)) ||
      receipt.artifacts[artifact.path] !== artifact.hash
    )
      return {state: 'stale' as const, detail: `${artifact.name} is missing or changed.`};
  }
  if (adapter.json.unverifiedPolicyFile !== undefined) {
    const path = yield* Path.Path;
    if ((yield* readFileIfExists(path.join(receipt.root, adapter.json.unverifiedPolicyFile))) !== undefined) {
      return {
        state: 'stale' as const,
        detail: 'Separate host enablement policy exists; verify server state with the host CLI.',
      };
    }
  }
  return {
    state: 'current' as const,
    detail: 'Managed files match. Host runtime, higher-precedence policy and lifecycle hooks are not verified.',
  };
});

export function removeJsonAgentSurface(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: AgentAdapterActionOptions,
) {
  const remove = Effect.gen(function* () {
    if (!adapter.json)
      return yield* AgentSurfaceError.make({message: `No managed JSON installer for ${adapter.catalog.id}.`});
    const registry = options.registry ?? (yield* readAgentIntegrationRegistry(config));
    if (!registry) return;
    return yield* removeAgentSurfaceFromRegistry(config, adapter, registry, options.apply, options.excludedConsumers);
  });
  return options.apply && !options.inTransaction ? withAgentIntegrationLock(config, remove) : remove;
}

const removeAgentSurfaceFromRegistry = Effect.fn('agentSurfaces.removeFromRegistry')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  registry: AgentIntegrationRegistry,
  apply: boolean,
  excludedConsumers: ReadonlySet<string> = new Set(),
) {
  const receipt = registry.surfaces?.[adapter.catalog.id];
  if (!receipt) return registry;
  const raw = yield* readFileIfExists(receipt.mcp.path);
  const parsed = yield* attempt(() => parseAgentJson(raw));
  const container = parsed[receipt.strategy.container];
  const entry = isJsonObject(container) ? container[receipt.mcp.name] : undefined;
  if (
    entry !== undefined &&
    (!isOwnedEntry(entry, receipt.agentId, config.agentContextHome) ||
      (yield* sha256Hex(JSON.stringify(entry))) !== receipt.mcp.hash)
  ) {
    return yield* AgentSurfaceError.make({
      message: 'MCP entry changed since installation; leaving its receipt and files intact.',
    });
  }
  if (!apply) yield* Console.log(`Would remove owned MCP entry from ${receipt.mcp.path}`);
  else if (entry !== undefined) {
    const next = removeAgentServer(parsed, receipt.strategy.container, receipt.mcp.name, receipt.mcp.createdContainer);
    if (receipt.mcp.createdFile && Object.keys(next).length === 0)
      yield* removeAgentTargetIfUnchanged(receipt.mcp.path, raw!);
    else yield* atomicAgentWrite(receipt.mcp.path, `${JSON.stringify(next, undefined, 2)}\n`, 0o600, {content: raw});
  }
  for (const artifact of receipt.artifactDescriptors) {
    if (!artifactHasOtherConsumers(registry, artifact.path, adapter.catalog.id, excludedConsumers)) {
      yield* removeReceiptArtifact(artifact, !apply);
    }
  }
  const surfaces = {...registry.surfaces};
  delete surfaces[adapter.catalog.id];
  const nextRegistry = {...registry, surfaces};
  if (apply) {
    yield* writeAgentIntegrationRegistry(config, nextRegistry);
  }
  return nextRegistry;
});

export function defineJsonAgentAdapter(id: string, json: JsonAgentStrategy): AgentAdapterDefinition {
  const install: AgentAdapterDefinition['actions']['install'] = (config, adapter, options) =>
    installJsonAgentSurface(config, adapter, {apply: options.apply, toolset: options.toolset});
  return {
    actions: {
      install,
      repair: (config, adapter, options) =>
        Effect.gen(function* () {
          const registry = options.registry ?? (yield* readAgentIntegrationRegistry(config));
          if (!registry?.surfaces?.[adapter.catalog.id]) {
            return yield* AgentSurfaceError.make({
              message: `No receipt for ${adapter.catalog.id}; use agents install.`,
            });
          }
          yield* install(config, adapter, {...options, registry});
        }),
      remove: removeJsonAgentSurface,
      status: agentSurfaceStatus,
    },
    adapterVersion: 1,
    id,
    json,
    kind: 'json',
  };
}

function receiptMatchesPlan(
  receipt: AgentSurfaceReceipt,
  plan: {readonly adapter: AgentAdapter; readonly artifacts: readonly AgentArtifact[]},
): boolean {
  if (
    receipt.adapterVersion !== plan.adapter.adapterVersion ||
    receipt.strategy.kind !== 'json' ||
    receipt.strategy.codec !== 'json' ||
    receipt.strategy.container !== plan.adapter.json?.container
  ) {
    return false;
  }
  const installed = receipt.artifactDescriptors.map(({kind, path}) => `${kind}:${path}`).sort();
  const current = plan.artifacts.map(({kind, path}) => `${kind}:${path}`).sort();
  return JSON.stringify(installed) === JSON.stringify(current);
}

const removeReceiptArtifact = Effect.fn('agentSurfaces.removeReceiptArtifact')(function* (
  artifact: AgentSurfaceReceipt['artifactDescriptors'][number],
  dryRun: boolean,
) {
  const current = yield* readFileIfExists(artifact.path);
  if (current === undefined) return;
  const currentHash = yield* sha256Hex(current);
  const managedBlock = extractManagedBlock(current);
  if (currentHash !== artifact.hash && managedBlock === undefined) {
    yield* Console.log(`WARN ${artifact.path} changed since installation; not modifying it`);
    return;
  }
  yield* removeArtifact(
    {
      content: currentHash === artifact.hash ? current : managedBlock!,
      hash: artifact.hash,
      kind: artifact.kind,
      name: artifact.name,
      path: artifact.path,
    },
    dryRun,
  );
});
