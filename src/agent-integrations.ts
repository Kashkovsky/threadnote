import {Console, Effect, FileSystem, Path} from 'effect';
import {
  AGENT_CLIENTS,
  AGENT_INTEGRATION_ARTIFACT_VERSION,
  agentIntegrationRegistryPath,
  emptyAgentIntegrationRegistry,
  readAgentIntegrationRegistry,
  registeredAgentClients,
  repairableAgentClients,
  type AgentIntegrationHostReceipt,
  type AgentIntegrationMcpReceipt,
  withAgentIntegrationHost,
  withAgentIntegrationLock,
  writeAgentIntegrationRegistry,
} from './agent-integration-registry.js';
import {
  LEGACY_CURSOR_INSTRUCTION_PATHS,
  USER_INSTRUCTIONS_END_MARKER,
  USER_INSTRUCTIONS_START_MARKER,
} from './constants.js';
import {isCursorMarketplacePluginInstalled} from './cursor/plugin.js';
import {sha256Hex} from './effect/digest.js';
import type {McpToolset} from './mcp/toolset.js';
import type {AgentClient, ClaudeMcpScope, DoctorCheck, RuntimeConfig} from './types.js';
import {expandPath, getInvocationCwd, readFileIfExists, toolRoot} from './utils.js';
import {getThreadnoteVersion} from './version.js';

const AGENT_SKILLS = ['threadnote-context', 'threadnote-code-graph', 'threadnote-memory'] as const;

const HOST_TARGETS = {
  claude: {
    instruction: {kind: 'block', path: '~/.claude/CLAUDE.md'},
    skillRoot: '~/.claude/skills',
  },
  codex: {
    instruction: {kind: 'block', path: '~/.codex/AGENTS.md'},
    skillRoot: '~/.agents/skills',
  },
  copilot: {
    instruction: {kind: 'file', path: '~/.copilot/instructions/threadnote.instructions.md'},
    skillRoot: '~/.copilot/skills',
  },
  cursor: {
    instruction: {kind: 'file', path: '~/.cursor/rules/threadnote.mdc'},
    skillRoot: '~/.cursor/skills',
  },
} as const satisfies Record<
  AgentClient,
  {
    readonly instruction: {readonly kind: 'block' | 'file'; readonly path: string};
    readonly skillRoot: string;
  }
>;

interface InstallAgentIntegrationOptions {
  readonly cwd?: string;
  readonly dryRun: boolean;
  readonly name: string;
  readonly scope?: ClaudeMcpScope;
  readonly toolset: McpToolset;
}

interface AgentArtifact {
  readonly content: string;
  readonly hash: string;
  readonly kind: 'block' | 'file';
  readonly name: string;
  readonly path: string;
}

class AgentIntegrationError extends Error {
  readonly _tag = 'AgentIntegrationError' as const;
}

export {readAgentIntegrationRegistry, registeredAgentClients, repairableAgentClients};

export const installAgentIntegration = Effect.fn('agentIntegrations.install')(function* (
  config: RuntimeConfig,
  agent: AgentClient,
  options: InstallAgentIntegrationOptions,
) {
  const cwd =
    options.cwd ?? (options.scope === 'local' || options.scope === 'project' ? yield* getInvocationCwd() : undefined);
  const mcp: AgentIntegrationMcpReceipt = {
    ...(cwd === undefined ? {} : {cwd}),
    name: options.name,
    repair: true,
    ...(options.scope === undefined ? {} : {scope: options.scope}),
    toolset: options.toolset,
  };
  const install = installAgentIntegrationInTransaction(config, agent, mcp, options.dryRun);
  yield* options.dryRun ? install : withAgentIntegrationLock(config, install);
});

export const migrateLegacyAgentIntegrations = Effect.fn('agentIntegrations.migrateLegacy')(function* (
  config: RuntimeConfig,
  inferredClients: readonly AgentClient[],
  dryRun: boolean,
) {
  const migration = migrateLegacyAgentIntegrationsInTransaction(config, inferredClients, dryRun);
  return yield* dryRun ? migration : withAgentIntegrationLock(config, migration);
});

export const migrateLegacyAgentIntegrationsInTransaction = Effect.fn('agentIntegrations.migrateLegacyInTransaction')(
  function* (config: RuntimeConfig, inferredClients: readonly AgentClient[], dryRun: boolean) {
    const existing = yield* readAgentIntegrationRegistry(config);
    if (existing !== undefined) return registeredAgentClients(existing);
    const selected = AGENT_CLIENTS.filter(agent => inferredClients.includes(agent));
    const unknownMcp: AgentIntegrationMcpReceipt = {name: 'threadnote', repair: false};
    if (dryRun) {
      yield* removeOrphanedLegacyInstructions(selected, true);
      for (const agent of selected) yield* installAgentIntegrationInTransaction(config, agent, unknownMcp, true);
    } else {
      const concurrentRegistry = yield* readAgentIntegrationRegistry(config);
      if (concurrentRegistry !== undefined) return registeredAgentClients(concurrentRegistry);
      const installedVersion = yield* getThreadnoteVersion();
      let pendingRegistry = emptyAgentIntegrationRegistry(true);
      for (const agent of selected) {
        const artifacts = yield* agentArtifacts(agent);
        pendingRegistry = withAgentIntegrationHost(
          pendingRegistry,
          agent,
          hostReceipt(artifacts, installedVersion, unknownMcp, 'pending'),
        );
      }
      yield* writeAgentIntegrationRegistry(config, pendingRegistry);
      yield* removeOrphanedLegacyInstructions(selected, false);
      for (const agent of selected) yield* installAgentIntegrationInTransaction(config, agent, unknownMcp, false);
    }
    if (selected.length === 0) {
      yield* Console.log('No legacy agent integrations found.');
    } else if (dryRun) {
      yield* Console.log(`Would migrate ${selected.length} legacy agent integration(s).`);
    } else {
      yield* Console.log(`Migrated ${selected.length} legacy agent integration(s).`);
    }
    return selected;
  },
);

export const repairAgentIntegrations = Effect.fn('agentIntegrations.repair')(function* (
  config: RuntimeConfig,
  dryRun: boolean,
) {
  const registry = yield* readAgentIntegrationRegistry(config);
  if (registry === undefined) return [];
  const clients = registeredAgentClients(registry);
  const repair = Effect.gen(function* () {
    for (const agent of clients) {
      const current = yield* readAgentIntegrationRegistry(config);
      const receipt = current?.hosts[agent];
      if (receipt !== undefined) yield* installAgentIntegrationInTransaction(config, agent, receipt.mcp, dryRun);
    }
  });
  yield* dryRun ? repair : withAgentIntegrationLock(config, repair);
  return clients;
});

export const agentIntegrationDoctorChecks = Effect.fn('agentIntegrations.doctorChecks')(function* (
  config: RuntimeConfig,
  legacyInferredClients: readonly AgentClient[] = [],
) {
  const registry = yield* readAgentIntegrationRegistry(config);
  if (registry === undefined) {
    return AGENT_CLIENTS.filter(agent => legacyInferredClients.includes(agent)).map(agent => ({
      detail: 'legacy Threadnote MCP entry detected; repair will register host-specific instructions and skills',
      name: `${agent} agent integration`,
      status: 'warn' as const,
    }));
  }
  const checks: DoctorCheck[] = [];
  for (const agent of registeredAgentClients(registry)) {
    const receipt = registry.hosts[agent]!;
    if (receipt.status === 'pending') {
      checks.push({
        detail: 'installation did not complete; repair will retry it',
        name: `${agent} agent integration`,
        status: 'warn',
      });
    }
    const artifacts = yield* agentArtifacts(agent);
    for (const artifact of artifacts) {
      const current = yield* readFileIfExists(artifact.path);
      const currentManagedBlock = current === undefined ? undefined : extractManagedBlock(current);
      const expectedManagedBlock = extractManagedBlock(artifact.content);
      const currentMatches =
        current !== undefined &&
        (current === artifact.content ||
          (expectedManagedBlock !== undefined && currentManagedBlock === expectedManagedBlock));
      const recordedHash = receipt.artifacts[artifact.path];
      checks.push({
        detail: currentMatches && recordedHash === artifact.hash ? artifact.path : `${artifact.path} missing or stale`,
        name: `${agent} ${artifact.name}`,
        status: currentMatches && recordedHash === artifact.hash ? 'ok' : 'warn',
      });
    }
  }
  return checks;
});

export const removeAgentIntegrations = Effect.fn('agentIntegrations.remove')(function* (
  config: RuntimeConfig,
  dryRun: boolean,
) {
  const removal = removeAgentIntegrationsInTransaction(config, dryRun);
  yield* dryRun ? removal : withAgentIntegrationLock(config, removal);
});

export const removeAgentIntegrationsInTransaction = Effect.fn('agentIntegrations.removeInTransaction')(function* (
  config: RuntimeConfig,
  dryRun: boolean,
) {
  const registry = yield* readAgentIntegrationRegistry(config);
  const clients = registry === undefined ? AGENT_CLIENTS : registeredAgentClients(registry);
  for (const agent of clients) {
    for (const artifact of yield* agentArtifacts(agent)) yield* removeArtifact(artifact, dryRun);
  }
  for (const legacyPath of LEGACY_CURSOR_INSTRUCTION_PATHS) {
    const target = yield* expandPath(legacyPath);
    yield* removeManagedPath(target, 'legacy Cursor user rule', dryRun, false);
  }
  const target = yield* agentIntegrationRegistryPath(config);
  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists(target)) {
    if (dryRun) yield* Console.log(`Would remove agent integration registry: ${target}`);
    else {
      yield* fs.remove(target);
      yield* Console.log(`Removed agent integration registry: ${target}`);
    }
  }
});

export const installAgentIntegrationInTransaction = Effect.fn('agentIntegrations.installInTransaction')(function* (
  config: RuntimeConfig,
  agent: AgentClient,
  mcp: AgentIntegrationMcpReceipt,
  dryRun: boolean,
) {
  const currentRegistry = (yield* readAgentIntegrationRegistry(config)) ?? emptyAgentIntegrationRegistry(false);
  const artifacts = yield* agentArtifacts(agent);
  const installedVersion = yield* getThreadnoteVersion();
  const receipt = hostReceipt(artifacts, installedVersion, mcp, 'pending');
  if (dryRun) {
    if (agent === 'cursor' && !artifacts.some(artifact => artifact.name === 'instructions')) {
      yield* removeManagedPath(
        yield* expandPath(HOST_TARGETS.cursor.instruction.path),
        'duplicate Cursor instructions',
        true,
        false,
      );
    }
    for (const artifact of artifacts) yield* logArtifactPlan(artifact);
    yield* Console.log(`Would register ${agent} agent integration in ${yield* agentIntegrationRegistryPath(config)}.`);
    return;
  }

  yield* writeAgentIntegrationRegistry(config, withAgentIntegrationHost(currentRegistry, agent, receipt));
  if (agent === 'cursor' && !artifacts.some(artifact => artifact.name === 'instructions')) {
    yield* removeManagedPath(
      yield* expandPath(HOST_TARGETS.cursor.instruction.path),
      'duplicate Cursor instructions',
      false,
      false,
    );
  }
  for (const artifact of artifacts) yield* writeArtifact(artifact);
  const latestRegistry = (yield* readAgentIntegrationRegistry(config)) ?? currentRegistry;
  yield* writeAgentIntegrationRegistry(
    config,
    withAgentIntegrationHost(latestRegistry, agent, {...receipt, status: 'current'}),
  );
  yield* Console.log(`Registered ${agent} agent integration.`);
});

function agentArtifacts(agent: AgentClient) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* toolRoot();
    const host = HOST_TARGETS[agent];
    const instructionPath = yield* expandPath(host.instruction.path);
    const bootstrap = (yield* (yield* FileSystem.FileSystem).readFileString(
      path.join(root, 'config', 'agent-instructions.md'),
    )).trim();
    const block = `${USER_INSTRUCTIONS_START_MARKER}\n${bootstrap}\n${USER_INSTRUCTIONS_END_MARKER}`;
    const instructionContent = renderInstructionContent(agent, host.instruction.kind, block);
    const cursorPluginProvidesInstructions = agent === 'cursor' && (yield* isCursorMarketplacePluginInstalled());
    const artifacts: AgentArtifact[] = cursorPluginProvidesInstructions
      ? []
      : [
          {
            content: instructionContent,
            hash: yield* sha256Hex(instructionContent),
            kind: host.instruction.kind,
            name: 'instructions',
            path: instructionPath,
          },
        ];
    const skillRoot = yield* expandPath(host.skillRoot);
    for (const skill of AGENT_SKILLS) {
      const content = `${(yield* (yield* FileSystem.FileSystem).readFileString(
        path.join(root, 'config', 'agent-skills', skill, 'SKILL.md'),
      )).trim()}\n`;
      artifacts.push({
        content,
        hash: yield* sha256Hex(content),
        kind: 'file',
        name: `skill ${skill}`,
        path: path.join(skillRoot, skill, 'SKILL.md'),
      });
    }
    return artifacts;
  });
}

function hostReceipt(
  artifacts: readonly AgentArtifact[],
  installedVersion: string,
  mcp: AgentIntegrationMcpReceipt,
  status: AgentIntegrationHostReceipt['status'],
): AgentIntegrationHostReceipt {
  return {
    artifacts: Object.fromEntries(artifacts.map(artifact => [artifact.path, artifact.hash])),
    artifactVersion: AGENT_INTEGRATION_ARTIFACT_VERSION,
    installedVersion,
    mcp,
    status,
  };
}

function renderInstructionContent(agent: AgentClient, kind: 'block' | 'file', block: string): string {
  if (kind === 'block') return block;
  const frontmatter =
    agent === 'cursor'
      ? [
          '---',
          'description: Route non-trivial work through installed Threadnote skills',
          'globs:',
          'alwaysApply: true',
          '---',
        ]
      : [
          '---',
          'name: Threadnote',
          'description: Route non-trivial work through installed Threadnote skills',
          'applyTo: "**"',
          '---',
        ];
  return [...frontmatter, '', block, ''].join('\n');
}

function logArtifactPlan(artifact: AgentArtifact) {
  return readFileIfExists(artifact.path).pipe(
    Effect.flatMap(current =>
      Console.log(`${current === undefined ? 'Would write' : 'Would update'} ${artifact.name}: ${artifact.path}`),
    ),
  );
}

const writeArtifact = Effect.fn('agentIntegrations.writeArtifact')(function* (artifact: AgentArtifact) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = yield* readFileIfExists(artifact.path);
  let next: string | undefined = artifact.content;
  if (artifact.kind === 'block') {
    next = upsertManagedBlock(current ?? '', artifact.content);
    if (next === undefined) {
      return yield* Effect.fail(
        new AgentIntegrationError(`${artifact.path} has partial Threadnote markers; not modifying it.`),
      );
    }
  } else if (current !== undefined && current !== artifact.content) {
    const currentBlock = extractManagedBlock(current);
    const expectedBlock = extractManagedBlock(artifact.content);
    if (currentBlock === undefined || expectedBlock === undefined) {
      return yield* Effect.fail(
        new AgentIntegrationError(`${artifact.path} is not managed by Threadnote; not modifying it.`),
      );
    }
    const unmanagedContent = removeManagedBlock(current);
    next =
      unmanagedContent !== undefined && isGeneratedInstructionFrontmatter(unmanagedContent)
        ? artifact.content
        : upsertManagedBlock(current, expectedBlock);
  }
  if (next === undefined) {
    return yield* Effect.fail(
      new AgentIntegrationError(`${artifact.path} has partial Threadnote markers; not modifying it.`),
    );
  }
  if (current === next) {
    yield* Console.log(`${artifact.name} already current: ${artifact.path}`);
    return;
  }
  yield* fs.makeDirectory(path.dirname(artifact.path), {recursive: true, mode: 0o700});
  yield* fs.writeFileString(artifact.path, next, {mode: 0o644});
  yield* Console.log(`${current === undefined ? 'Wrote' : 'Updated'} ${artifact.name}: ${artifact.path}`);
});

function removeOrphanedLegacyInstructions(selected: readonly AgentClient[], dryRun: boolean) {
  return Effect.gen(function* () {
    for (const agent of AGENT_CLIENTS) {
      if (selected.includes(agent)) continue;
      const target = yield* expandPath(HOST_TARGETS[agent].instruction.path);
      yield* removeManagedPath(
        target,
        `${agent} instructions`,
        dryRun,
        HOST_TARGETS[agent].instruction.kind === 'file',
      );
    }
    const cursorMarkdown = yield* expandPath('~/.cursor/rules/threadnote.md');
    yield* removeManagedPath(cursorMarkdown, 'legacy Cursor user rule', dryRun, true);
  });
}

function removeArtifact(artifact: AgentArtifact, dryRun: boolean) {
  return removeManagedPath(artifact.path, artifact.name, dryRun, artifact.kind === 'file', artifact.content);
}

const removeManagedPath = Effect.fn('agentIntegrations.removeManagedPath')(function* (
  target: string,
  label: string,
  dryRun: boolean,
  removeWholeFile: boolean,
  expectedContent?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const current = yield* readFileIfExists(target);
  if (current === undefined) return;
  const next = removeManagedBlock(current);
  if (next === undefined) {
    yield* Console.log(`WARN ${target} has partial Threadnote markers; not modifying it`);
    return;
  }
  if (next === current) return;
  const shouldRemove =
    next.trim().length === 0 ||
    (removeWholeFile && (current === expectedContent || isGeneratedInstructionFrontmatter(next)));
  if (dryRun) {
    yield* Console.log(`${shouldRemove ? 'Would remove' : 'Would update'} ${label}: ${target}`);
  } else if (shouldRemove) {
    yield* fs.remove(target);
    yield* Console.log(`Removed ${label}: ${target}`);
  } else {
    yield* fs.writeFileString(target, next, {mode: 0o644});
    yield* Console.log(`Updated ${target}`);
  }
});

function isGeneratedInstructionFrontmatter(content: string): boolean {
  const trimmed = content.trim();
  if (!/^---\n[\s\S]*\n---$/.test(trimmed)) return false;
  return (
    trimmed.includes('description: Route non-trivial work through installed Threadnote skills') &&
    (trimmed.includes('alwaysApply: true') || trimmed.includes('applyTo: "**"'))
  );
}

function extractManagedBlock(content: string): string | undefined {
  const startIndex = content.indexOf(USER_INSTRUCTIONS_START_MARKER);
  const endIndex = content.indexOf(USER_INSTRUCTIONS_END_MARKER);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return undefined;
  return content.slice(startIndex, endIndex + USER_INSTRUCTIONS_END_MARKER.length);
}

function upsertManagedBlock(content: string, block: string): string | undefined {
  const startIndex = content.indexOf(USER_INSTRUCTIONS_START_MARKER);
  const endIndex = content.indexOf(USER_INSTRUCTIONS_END_MARKER);
  if ((startIndex === -1) !== (endIndex === -1) || endIndex < startIndex) return undefined;
  if (startIndex !== -1) {
    const before = content.slice(0, startIndex).trimEnd();
    const after = content.slice(endIndex + USER_INSTRUCTIONS_END_MARKER.length).trimStart();
    return joinMarkdownSections([before, block, after]);
  }
  return joinMarkdownSections([content.trimEnd(), block]);
}

function removeManagedBlock(content: string): string | undefined {
  const startIndex = content.indexOf(USER_INSTRUCTIONS_START_MARKER);
  const endIndex = content.indexOf(USER_INSTRUCTIONS_END_MARKER);
  if ((startIndex === -1) !== (endIndex === -1) || endIndex < startIndex) return undefined;
  if (startIndex === -1) return content;
  const before = content.slice(0, startIndex).trimEnd();
  const after = content.slice(endIndex + USER_INSTRUCTIONS_END_MARKER.length).trimStart();
  return joinMarkdownSections([before, after]);
}

function joinMarkdownSections(sections: readonly string[]): string {
  return `${sections.filter(section => section.length > 0).join('\n\n')}\n`;
}
