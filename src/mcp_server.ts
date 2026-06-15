#! /usr/bin/env node

import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {DEFAULT_ACCOUNT, DEFAULT_AGENT_ID, DEFAULT_HOST, DEFAULT_PORT} from './constants.js';
import {formatRecallIndexRepairMessages, repairStaleRecallIndex} from './index_repair.js';
import {inferProjectFromQuery} from './manifest.js';
import type {ProjectManifest} from './types.js';
import {
  activePersonalMemoryUrisFromText,
  type ArchiveAction,
  buildCompactPlan,
  type CompactableMemoryKind,
  formatCompactPlan,
  parseMemoryDocument,
  recallHygieneNudges,
  type MemoryRecord,
} from './memory_hygiene.js';
import {
  ensureSharedDirectoryChain,
  installSharedAgentArtifacts,
  isInSharedNamespace,
  listSharedAgentArtifacts,
  publishShareGitChange,
  resolveTeam,
  applyScrubber,
  sharedMemoryUriParts,
  sharedTeamNameForUri,
  sharedUriFor,
  shareAgentArtifact,
  startShareBackgroundFetch,
  stripPersonalProvenance,
  syncSharedReposBeforeAgentRead,
  vikingResourceExists as sharedVikingResourceExists,
  vikingUriToWorktreeRelative,
  writeMemoryFile,
} from './share.js';
import {
  applyExactMatchBoost,
  collectExactMatches,
  type ExactMatch,
  errorMessage,
  enrichRecallQueryWithWorkspaceContext,
  enrichRecallQueryWithWorkspaceProjectContext,
  exactMemoryScopeUris,
  exactRecallScopeIntents,
  exactRecallTerms,
  expandPath,
  findOpenVikingCli,
  formatExactMatchPointers,
  formatRecallHits,
  mergeRecallHits,
  parsePort,
  parseRecallHits,
  type RecallHit,
  RECALL_SCORE_THRESHOLD,
  runCommand,
  safeTimestamp,
  sha256,
  sleep,
  trimTrailingSlash,
} from './utils.js';

interface RuntimeConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly agentId: string;
  readonly manifestPath: string;
  readonly openVikingMcpUrl: string;
  readonly user: string;
}

type MemoryKind = 'durable' | 'handoff' | 'incident' | 'preference' | 'smoke';
type MemoryStatus = 'active' | 'archived' | 'superseded';

interface MemoryMetadata {
  readonly archivedFrom?: string;
  readonly kind: MemoryKind;
  readonly project?: string;
  readonly sourceAgentClient: string;
  readonly status: MemoryStatus;
  readonly supersedes?: string;
  readonly timestamp: string;
  readonly topic?: string;
}

type CheckedText =
  | {
      readonly ok: true;
      readonly value: string;
    }
  | {
      readonly error: CallToolResult;
      readonly ok: false;
    };

type CheckedOptionalText =
  | {
      readonly ok: true;
      readonly value: string | undefined;
    }
  | {
      readonly error: CallToolResult;
      readonly ok: false;
    };

type CheckedTextArray =
  | {
      readonly ok: true;
      readonly value: readonly string[];
    }
  | {
      readonly error: CallToolResult;
      readonly ok: false;
    };

async function main(): Promise<void> {
  const config = getRuntimeConfig();
  const server = new McpServer(
    {name: 'threadnote-local-adapter', version: '0.2.0'},
    {
      instructions: [
        '# Threadnote Local Adapter',
        '',
        'Stdio MCP adapter for Threadnote shared local context.',
        'Prefer `recall_context` to find candidate viking:// URIs, then `read_context` files or `list_context` directories.',
        'Always pass JSON arguments. Example: recall_context({"query":"current repo latest handoff","callerCwd":"/absolute/workspace/path"}).',
        'recall_context also surfaces seeded project resources under viking://resources/repos/<project> when the query mentions a project from the seed manifest. See its tool description for the query convention.',
        'Older clients may use the compatibility aliases `search`, `read`, and `list`.',
        'For durable facts, store kind="durable"; for current work logs, store kind="handoff" with project/topic so Threadnote keeps one active memory updated.',
        'When a handoff describes an active branch or feature, recall durable feature memories for the same branch/topic before coding.',
        'During feature work, update durable feature knowledge when valuable implementation details, decisions, interfaces, or gotchas change.',
        'When updating the same active issue, pass project/topic or replaceUri to remember_context so duplicate durable memories or handoffs do not accumulate.',
        'Use compact_context with dryRun=true for scoped memory hygiene when recall surfaces overlapping active memories.',
        'To share a durable memory with teammates, call `share_publish` with its viking:// URI. share_publish scrubs for secrets, writes and pushes the shared copy first, then removes the personal copy after the push succeeds. Do not publish handoffs, preferences, or anything carrying machine-local paths or in-flight task context.',
        'To share a local Codex/Claude skill or Claude command with teammates, call `share_skill` with the local file path. It publishes into the shared artifact catalog after the same scrubber checks.',
        'To use a team shared skill as a native local skill, call `list_shared_skills` first, then `install_shared_skill` for the selected name/agent/kind.',
        'Do not store secrets, customer data, raw production logs, or credentials.',
      ].join('\n'),
    },
  );

  registerTools(server, config);
  startShareBackgroundFetch(config);
  await server.connect(new StdioServerTransport());
  process.stderr.write('Threadnote local MCP adapter running\n');
}

function getRuntimeConfig(): RuntimeConfig {
  const host = process.env.THREADNOTE_HOST ?? DEFAULT_HOST;
  const port = parsePort(process.env.THREADNOTE_PORT ?? String(DEFAULT_PORT));
  return {
    account: process.env.THREADNOTE_ACCOUNT ?? DEFAULT_ACCOUNT,
    agentContextHome: expandPath(process.env.THREADNOTE_HOME ?? '~/.openviking'),
    agentId: process.env.THREADNOTE_AGENT_ID ?? DEFAULT_AGENT_ID,
    manifestPath: expandPath(process.env.THREADNOTE_MANIFEST ?? '~/.openviking/seed-manifest.yaml'),
    openVikingMcpUrl: process.env.THREADNOTE_OPENVIKING_MCP_URL ?? `http://${host}:${port}/mcp`,
    user: process.env.THREADNOTE_USER ?? process.env.USER ?? 'unknown',
  };
}

function registerTools(server: McpServer, config: RuntimeConfig): void {
  registerSearchTool(
    server,
    config,
    'recall_context',
    'Search Threadnote context across personal memories and seeded project resources. Returns semantic hits from indexed Threadnote context (handoffs, durable feature memories, preferences, shared team memories) — and, when the query mentions a project name from the seed manifest, also from that project\'s seeded guidance (README, AGENTS.md, CLAUDE.md, SKILL.md, docs/**) under viking://resources/repos/<project>. Queries that mention this/current branch are enriched with local git/workspace terms when callerCwd is provided. Include the repo or project name in the query to make the project-guidance pass fire. Results are filtered by a default relevance threshold (0.5); if a recall comes back empty or too sparse, retry with a lower threshold (e.g. {"query":"...","threshold":0.2}) to broaden. Required: pass JSON arguments with a non-empty query, for example {"query":"unity-ui-ccc latest handoff"}.',
  );
  registerSearchTool(
    server,
    config,
    'search',
    'Compatibility alias for recall_context. Searches both personal memories and seeded project resources; see recall_context for the query conventions.',
  );

  registerReadTool(
    server,
    config,
    'read_context',
    'Read a viking:// file URI returned by recall_context or list_context.',
  );
  registerReadTool(server, config, 'read', 'Compatibility alias for read_context.');

  registerListTool(server, config, 'list_context', 'List a viking:// directory returned by recall_context.');
  registerListTool(server, config, 'list', 'Compatibility alias for list_context.');

  registerStoreTool(
    server,
    config,
    'remember_context',
    'Store a durable Threadnote memory. Required: pass JSON arguments with text.',
  );
  registerStoreTool(server, config, 'store', 'Compatibility alias for remember_context.');

  registerArchiveTool(
    server,
    config,
    'archive_context',
    'Archive a memory so it remains readable as provenance but is no longer current working context.',
  );
  registerArchiveTool(server, config, 'archive', 'Compatibility alias for archive_context.');

  registerCompactTool(server, config);

  server.registerTool(
    'forget',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: 'Remove a viking:// URI from OpenViking.',
      inputSchema: {
        recursive: z.boolean().optional().describe('Remove a directory recursively'),
        uri: z.string().optional().describe('Required viking:// URI to remove'),
      },
    },
    async ({recursive, uri}) => {
      const checkedUri = requiredVikingUri(uri, 'forget', 'viking://agent/threadnote/memories/example.md');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingRemoveTool(config, checkedUri.value, recursive === true);
    },
  );

  server.registerTool(
    'add_resource',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Add a local file or directory to OpenViking as a resource.',
      inputSchema: {
        description: z.string().optional().describe('Optional import reason/description'),
        path: z.string().optional().describe('Local source file/directory or URL; native OpenViking MCP name'),
        sourcePath: z.string().optional().describe('Required local source file or directory'),
        source_path: z.string().optional().describe('Compatibility alias for path'),
        tempFileId: z.string().optional().describe('Native progressive upload temp file id'),
        temp_file_id: z.string().optional().describe('Native progressive upload temp file id'),
        to: z.string().optional().describe('Optional destination viking:// URI'),
        wait: z.boolean().optional().describe('Wait for processing to finish'),
        watchInterval: z.number().int().min(0).optional().describe('Watch interval in minutes'),
        watch_interval: z.number().int().min(0).optional().describe('Watch interval in minutes'),
      },
    },
    async args =>
      runOpenVikingAddResourceTool(config, 'add_resource', {
        description: args.description,
        path: args.sourcePath ?? args.path ?? args.source_path,
        tempFileId: args.tempFileId ?? args.temp_file_id,
        to: args.to,
        wait: args.wait,
        watchInterval: args.watchInterval ?? args.watch_interval,
      }),
  );

  server.registerTool(
    'grep',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'Run exact text search in OpenViking. Defaults to your memories subtree when uri is omitted (OpenViking grep requires a scope).',
      inputSchema: {
        caseInsensitive: z.boolean().optional().describe('Case-insensitive search'),
        case_insensitive: z.boolean().optional().describe('Case-insensitive search'),
        nodeLimit: z.number().int().positive().max(1000).optional().describe('Maximum result count'),
        node_limit: z.number().int().positive().max(1000).optional().describe('Maximum result count'),
        pattern: z.string().optional().describe('Required text or regex pattern'),
        uri: z.string().optional().describe('Optional viking:// subtree (defaults to your memories root)'),
      },
    },
    async ({caseInsensitive, case_insensitive, nodeLimit, node_limit, pattern, uri}) => {
      const checkedPattern = requiredText(pattern, 'grep', 'pattern', {pattern: 'unity-ui-ccc'});
      if (!checkedPattern.ok) {
        return checkedPattern.error;
      }
      const checkedUri = optionalVikingUri(uri, 'grep');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingMcpTool(config, 'grep', {
        case_insensitive: caseInsensitive ?? case_insensitive,
        node_limit: nodeLimit ?? node_limit,
        pattern: checkedPattern.value,
        uri: checkedUri.value ?? `viking://user/${uriSegment(config.user)}/memories`,
      });
    },
  );

  server.registerTool(
    'glob',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Run glob file search in OpenViking.',
      inputSchema: {
        nodeLimit: z.number().int().positive().max(1000).optional().describe('Maximum result count'),
        node_limit: z.number().int().positive().max(1000).optional().describe('Maximum result count'),
        pattern: z.string().optional().describe('Required glob pattern'),
        uri: z.string().optional().describe('Optional viking:// subtree'),
      },
    },
    async ({nodeLimit, node_limit, pattern, uri}) => {
      const checkedPattern = requiredText(pattern, 'glob', 'pattern', {pattern: '**/AGENTS.md'});
      if (!checkedPattern.ok) {
        return checkedPattern.error;
      }
      const checkedUri = optionalVikingUri(uri, 'glob');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingMcpTool(config, 'glob', {
        node_limit: nodeLimit ?? node_limit,
        pattern: checkedPattern.value,
        uri: checkedUri.value,
      });
    },
  );

  server.registerTool(
    'health',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Check OpenViking server health through the CLI.',
      inputSchema: {},
    },
    async () => runOpenVikingMcpTool(config, 'health', {}),
  );

  registerOpenVikingParityTools(server, config);

  server.registerTool(
    'share_publish',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        "Publish a personal memory into a team's shared memories git repo. Reads the memory, strips local-only provenance frontmatter (supersedes:, archived_from:), refuses publish if it matches secret patterns, writes and pushes the shared copy first, then removes the personal original. Default team is used unless team is provided. Pass preview=true to return the would-be-published bytes without writing or committing.",
      inputSchema: {
        message: z.string().optional().describe('Commit message override; defaults to "share: publish <path>"'),
        preview: z
          .boolean()
          .optional()
          .describe(
            'Return the bytes that would land in the shared git repo (after frontmatter strip and redaction) without writing or committing. Use this to inspect the body before publishing.',
          ),
        push: z.boolean().optional().describe('Push to remote after committing; defaults to true'),
        redact: z
          .boolean()
          .optional()
          .describe('Replace soft-leak matches (local paths) with placeholders and continue; credentials still block.'),
        team: z.string().optional().describe('Team name; defaults to the configured default team'),
        uri: z.string().optional().describe('Required viking:// memory URI to publish'),
      },
    },
    async ({message, preview, push, redact, team, uri}) => {
      const checkedUri = requiredVikingUri(
        uri,
        'share_publish',
        'viking://user/example/memories/durable/projects/foo/bar.md',
      );
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runSharePublishTool(config, checkedUri.value, {message, preview, push, redact, team});
    },
  );

  server.registerTool(
    'share_skill',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        "Publish a local Codex/Claude skill or Claude command markdown file into a team's shared artifact catalog. Path inference handles ~/.codex/skills/**/SKILL.md, ~/.claude/skills/**/SKILL.md, and ~/.claude/commands/**/*.md; pass agent/kind/name when sharing from another path. Default team is used unless team is provided. Pass preview=true to inspect bytes without writing or committing.",
      inputSchema: {
        agent: z.enum(['codex', 'claude']).optional().describe('Agent owner when path inference is ambiguous'),
        force: z.boolean().optional().describe('Replace an existing shared artifact with different content'),
        kind: z.enum(['skill', 'command']).optional().describe('Artifact kind when path inference is ambiguous'),
        message: z.string().optional().describe('Commit message override; defaults to "share: publish <path>"'),
        name: z.string().optional().describe('Shared artifact name; defaults to skill directory or command file stem'),
        path: z.string().optional().describe('Required local path to SKILL.md or a Claude command markdown file'),
        preview: z.boolean().optional().describe('Return the bytes that would land in the shared git repo'),
        push: z.boolean().optional().describe('Push to remote after committing; defaults to true'),
        redact: z
          .boolean()
          .optional()
          .describe('Replace soft-leak matches (local paths) with placeholders and continue; credentials still block.'),
        team: z.string().optional().describe('Team name; defaults to the configured default team'),
      },
    },
    async ({agent, force, kind, message, name, path, preview, push, redact, team}) => {
      const checkedPath = requiredText(path, 'share_skill', 'path', {
        path: '~/.codex/skills/example/SKILL.md',
      });
      if (!checkedPath.ok) {
        return checkedPath.error;
      }
      return runShareSkillTool(config, checkedPath.value, {
        agent,
        force,
        kind,
        message,
        name,
        preview,
        push,
        redact,
        team,
      });
    },
  );

  server.registerTool(
    'list_shared_skills',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'List shared Codex/Claude skills and Claude commands available in a configured Threadnote team repo, including whether each one is already installed locally.',
      inputSchema: {
        agent: z.enum(['codex', 'claude']).optional().describe('Optional agent filter'),
        kind: z.enum(['skill', 'command']).optional().describe('Optional kind filter'),
        name: z.string().optional().describe('Optional shared artifact name filter'),
        team: z.string().optional().describe('Team name; defaults to the configured default team'),
      },
    },
    async ({agent, kind, name, team}) => runListSharedSkillsTool(config, {agent, kind, name, team}),
  );

  server.registerTool(
    'install_shared_skill',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        'Install one shared Codex/Claude skill or Claude command from a configured Threadnote team repo into the local agent skill/command directory. Use list_shared_skills first to find names and disambiguate agent/kind.',
      inputSchema: {
        agent: z.enum(['codex', 'claude']).optional().describe('Agent owner; required when name is ambiguous'),
        dryRun: z.boolean().optional().describe('Preview install without writing local files'),
        force: z.boolean().optional().describe('Replace an existing installed artifact with different content'),
        kind: z.enum(['skill', 'command']).optional().describe('Artifact kind; required when name is ambiguous'),
        name: z.string().optional().describe('Required shared artifact name to install'),
        team: z.string().optional().describe('Team name; defaults to the configured default team'),
      },
    },
    async ({agent, dryRun, force, kind, name, team}) => {
      const checkedName = requiredText(name, 'install_shared_skill', 'name', {name: 'reviewer'});
      if (!checkedName.ok) {
        return checkedName.error;
      }
      return runInstallSharedSkillTool(config, checkedName.value, {agent, dryRun, force, kind, team});
    },
  );
}

function registerOpenVikingParityTools(server: McpServer, config: RuntimeConfig): void {
  server.registerTool(
    'ov_search',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP search parity. Unlike search/recall_context, this does not enrich the query.',
      inputSchema: {
        limit: z.number().int().positive().max(1000).optional().describe('Maximum result count'),
        minScore: z.number().min(0).max(1).optional().describe('Minimum score threshold'),
        min_score: z.number().min(0).max(1).optional().describe('Minimum score threshold'),
        peerId: z.string().optional().describe('Optional native peer id'),
        peer_id: z.string().optional().describe('Optional native peer id'),
        query: z.string().optional().describe('Required search query'),
        sessionId: z.string().optional().describe('Optional native session id'),
        session_id: z.string().optional().describe('Optional native session id'),
        targetUri: z.string().optional().describe('Optional target viking:// subtree'),
        target_uri: z.string().optional().describe('Optional target viking:// subtree'),
        uri: z.string().optional().describe('Compatibility alias for target_uri'),
      },
    },
    async ({limit, minScore, min_score, query, sessionId, session_id, targetUri, target_uri, uri}) => {
      const checkedQuery = requiredText(query, 'ov_search', 'query', {query: 'current repo release notes'});
      if (!checkedQuery.ok) {
        return checkedQuery.error;
      }
      const checkedUri = optionalVikingUri(targetUri ?? target_uri ?? uri, 'ov_search');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      const normalizedSessionId = (sessionId ?? session_id)?.trim();
      return runOpenVikingMcpTool(config, 'search', {
        limit,
        min_score: minScore ?? min_score,
        query: checkedQuery.value,
        session_id: normalizedSessionId || undefined,
        target_uri: checkedUri.value,
      });
    },
  );

  server.registerTool(
    'ov_read',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'Raw OpenViking MCP read parity. Reads one or more viking:// URIs without Threadnote shared-memory sync.',
      inputSchema: {
        uri: z.string().optional().describe('Single viking:// URI'),
        uris: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('Single viking:// URI or array of URIs'),
      },
    },
    async ({uri, uris}) => {
      const checkedUris = requiredVikingUriList(
        uris ?? uri,
        'ov_read',
        'viking://resources/repos/threadnote/README.md',
      );
      if (!checkedUris.ok) {
        return checkedUris.error;
      }
      return runOpenVikingReadTool(config, checkedUris.value);
    },
  );

  server.registerTool(
    'ov_list',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP list parity.',
      inputSchema: {
        all: z.boolean().optional().describe('Show hidden files like .abstract.md and .overview.md'),
        nodeLimit: z.number().int().positive().max(1000).optional().describe('Maximum node count'),
        node_limit: z.number().int().positive().max(1000).optional().describe('Maximum node count'),
        recursive: z.boolean().optional().describe('List recursively'),
        simple: z.boolean().optional().describe('Only return paths'),
        uri: z.string().optional().describe('Optional viking:// directory URI; defaults to viking://'),
      },
    },
    async ({recursive, uri}) => {
      const checkedUri = optionalVikingUri(uri, 'ov_list');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingMcpTool(config, 'list', {
        recursive,
        uri: checkedUri.value ?? 'viking://',
      });
    },
  );

  registerOpenVikingStoreTool(server, config, 'ov_store');
  registerOpenVikingStoreTool(server, config, 'ov_remember');

  server.registerTool(
    'ov_add_resource',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Raw OpenViking MCP add_resource parity.',
      inputSchema: {
        description: z.string().optional().describe('Optional import reason/description'),
        path: z.string().optional().describe('Local source file/directory or URL'),
        sourcePath: z.string().optional().describe('Compatibility alias for path'),
        source_path: z.string().optional().describe('Compatibility alias for path'),
        tempFileId: z.string().optional().describe('Native progressive upload temp file id'),
        temp_file_id: z.string().optional().describe('Native progressive upload temp file id'),
        to: z.string().optional().describe('Optional destination viking:// URI'),
        wait: z.boolean().optional().describe('Wait for processing to finish'),
        watchInterval: z.number().int().min(0).optional().describe('Watch interval in minutes'),
        watch_interval: z.number().int().min(0).optional().describe('Watch interval in minutes'),
      },
    },
    async args =>
      runOpenVikingAddResourceTool(config, 'ov_add_resource', {
        description: args.description,
        path: args.path ?? args.sourcePath ?? args.source_path,
        tempFileId: args.tempFileId ?? args.temp_file_id,
        to: args.to,
        wait: args.wait,
        watchInterval: args.watchInterval ?? args.watch_interval,
      }),
  );

  server.registerTool(
    'ov_list_watches',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP list_watches parity.',
      inputSchema: {
        activeOnly: z.boolean().optional().describe('Only show active watch tasks'),
        active_only: z.boolean().optional().describe('Only show active watch tasks'),
      },
    },
    async ({activeOnly, active_only}) =>
      runOpenVikingMcpTool(config, 'list_watches', {active_only: activeOnly ?? active_only}),
  );

  server.registerTool(
    'ov_cancel_watch',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: 'Raw OpenViking MCP cancel_watch parity. Accepts to_uri, toUri, or uri.',
      inputSchema: {
        toUri: z.string().optional().describe('Watch target viking:// URI'),
        to_uri: z.string().optional().describe('Watch target viking:// URI'),
        uri: z.string().optional().describe('Compatibility alias for to_uri'),
      },
    },
    async ({toUri, to_uri, uri}) => {
      const checkedUri = requiredVikingUri(
        toUri ?? to_uri ?? uri,
        'ov_cancel_watch',
        'viking://resources/repos/threadnote',
      );
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingMcpTool(config, 'cancel_watch', {to_uri: checkedUri.value});
    },
  );

  server.registerTool(
    'ov_grep',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP grep parity.',
      inputSchema: {
        caseInsensitive: z.boolean().optional().describe('Case-insensitive search'),
        case_insensitive: z.boolean().optional().describe('Case-insensitive search'),
        nodeLimit: z.number().int().positive().max(1000).optional().describe('Maximum result count'),
        node_limit: z.number().int().positive().max(1000).optional().describe('Maximum result count'),
        pattern: z.string().optional().describe('Required regex pattern'),
        uri: z.string().optional().describe('Optional viking:// subtree'),
      },
    },
    async ({caseInsensitive, case_insensitive, nodeLimit, node_limit, pattern, uri}) => {
      const checkedPattern = requiredText(pattern, 'ov_grep', 'pattern', {pattern: 'threadnote'});
      if (!checkedPattern.ok) {
        return checkedPattern.error;
      }
      const checkedUri = optionalVikingUri(uri, 'ov_grep');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingMcpTool(config, 'grep', {
        case_insensitive: caseInsensitive ?? case_insensitive,
        node_limit: nodeLimit ?? node_limit,
        pattern: checkedPattern.value,
        uri: checkedUri.value,
      });
    },
  );

  server.registerTool(
    'ov_glob',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP glob parity.',
      inputSchema: {
        nodeLimit: z.number().int().positive().max(1000).optional().describe('Maximum result count'),
        node_limit: z.number().int().positive().max(1000).optional().describe('Maximum result count'),
        pattern: z.string().optional().describe('Required glob pattern'),
        uri: z.string().optional().describe('Optional viking:// subtree'),
      },
    },
    async ({nodeLimit, node_limit, pattern, uri}) => {
      const checkedPattern = requiredText(pattern, 'ov_glob', 'pattern', {pattern: '**/AGENTS.md'});
      if (!checkedPattern.ok) {
        return checkedPattern.error;
      }
      const checkedUri = optionalVikingUri(uri, 'ov_glob');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingMcpTool(config, 'glob', {
        node_limit: nodeLimit ?? node_limit,
        pattern: checkedPattern.value,
        uri: checkedUri.value,
      });
    },
  );

  server.registerTool(
    'ov_forget',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: 'Raw OpenViking MCP forget parity.',
      inputSchema: {
        recursive: z.boolean().optional().describe('Remove a directory recursively'),
        uri: z.string().optional().describe('Required viking:// URI to remove'),
      },
    },
    async ({recursive, uri}) => {
      const checkedUri = requiredVikingUri(uri, 'ov_forget', 'viking://resources/repos/threadnote/tmp');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingRemoveTool(config, checkedUri.value, recursive === true);
    },
  );

  server.registerTool(
    'ov_code_outline',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP code_outline parity. Requires a viking:// file URI.',
      inputSchema: {
        uri: z.string().optional().describe('Required viking:// file URI'),
      },
    },
    async ({uri}) => {
      const checkedUri = requiredVikingUri(
        uri,
        'ov_code_outline',
        'viking://resources/repos/threadnote/src/mcp_server.ts',
      );
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingMcpTool(config, 'code_outline', {uri: checkedUri.value});
    },
  );

  server.registerTool(
    'ov_code_search',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP code_search parity. Requires a query and viking:// directory URI.',
      inputSchema: {
        query: z.string().optional().describe('Required symbol-name substring'),
        uri: z.string().optional().describe('Required viking:// directory URI'),
      },
    },
    async ({query, uri}) => {
      const checkedQuery = requiredText(query, 'ov_code_search', 'query', {query: 'registerTools'});
      if (!checkedQuery.ok) {
        return checkedQuery.error;
      }
      const checkedUri = requiredVikingUri(uri, 'ov_code_search', 'viking://resources/repos/threadnote/src');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingMcpTool(config, 'code_search', {
        query: checkedQuery.value,
        uri: checkedUri.value,
      });
    },
  );

  server.registerTool(
    'ov_code_expand',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP code_expand parity. Requires a viking:// file URI and symbol.',
      inputSchema: {
        symbol: z.string().optional().describe('Required symbol name, e.g. bar or Foo.bar'),
        uri: z.string().optional().describe('Required viking:// file URI'),
      },
    },
    async ({symbol, uri}) => {
      const checkedUri = requiredVikingUri(
        uri,
        'ov_code_expand',
        'viking://resources/repos/threadnote/src/mcp_server.ts',
      );
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      const checkedSymbol = requiredText(symbol, 'ov_code_expand', 'symbol', {symbol: 'registerTools'});
      if (!checkedSymbol.ok) {
        return checkedSymbol.error;
      }
      return runOpenVikingMcpTool(config, 'code_expand', {symbol: checkedSymbol.value, uri: checkedUri.value});
    },
  );

  server.registerTool(
    'ov_health',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP health parity.',
      inputSchema: {},
    },
    async () => runOpenVikingMcpTool(config, 'health', {}),
  );
}

function registerOpenVikingStoreTool(server: McpServer, config: RuntimeConfig, name: 'ov_remember' | 'ov_store'): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: `Raw OpenViking MCP ${name === 'ov_remember' ? 'remember' : 'store'} parity. Stores message(s) through ov add-memory.`,
      inputSchema: {
        content: z.string().optional().describe('Compatibility shortcut for a single user message'),
        messages: z
          .array(z.object({content: z.string(), role: z.string()}))
          .optional()
          .describe('Native messages array of {role, content}'),
        text: z.string().optional().describe('Compatibility shortcut for a single user message'),
      },
    },
    async ({content, messages, text}) => {
      if (messages && messages.length > 0) {
        return runOpenVikingMcpTool(config, 'remember', {messages});
      }
      const checkedContent = requiredText(content ?? text, name, 'content', {content: 'Remember this note'});
      if (!checkedContent.ok) {
        return checkedContent.error;
      }
      return runOpenVikingMcpTool(config, 'remember', {
        messages: [{content: checkedContent.value, role: 'user'}],
      });
    },
  );
}

function registerSearchTool(server: McpServer, config: RuntimeConfig, name: string, description: string): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description,
      inputSchema: {
        query: z.string().optional().describe('Required search query, for example "unity-ui-ccc latest handoff"'),
        uri: z.string().optional().describe('Optional viking:// subtree to search'),
        callerCwd: z
          .string()
          .optional()
          .describe('Optional absolute caller workspace path used to resolve this/current branch queries'),
        nodeLimit: z.number().int().positive().max(100).optional().describe('Maximum result count'),
        includeArchived: z.boolean().optional().describe('Include archived memories in recall results'),
        threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            'Minimum relevance score 0-1 (default 0.5); lower it (toward 0) to broaden when a recall comes back empty',
          ),
      },
    },
    async ({callerCwd, includeArchived, nodeLimit, query, threshold, uri}) => {
      const checkedQuery = requiredText(query, name, 'query', {query: 'unity-ui-ccc latest handoff'});
      if (!checkedQuery.ok) {
        return checkedQuery.error;
      }
      const checkedUri = optionalVikingUri(uri, name);
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runRecallTool(config, {
        callerCwd,
        query: checkedQuery.value,
        pinnedUri: checkedUri.value,
        nodeLimit,
        includeArchived: includeArchived === true,
        threshold: threshold === undefined ? undefined : String(threshold),
      });
    },
  );
}

interface RecallToolParams {
  readonly callerCwd: string | undefined;
  readonly includeArchived: boolean;
  readonly nodeLimit: number | undefined;
  readonly pinnedUri: string | undefined;
  readonly query: string;
  readonly threshold: string | undefined;
}

async function runRecallTool(config: RuntimeConfig, params: RecallToolParams): Promise<CallToolResult> {
  let syncedTeams: readonly string[] = [];
  const syncWarnings: string[] = [];
  try {
    const syncResult = await syncSharedReposBeforeAgentRead(config);
    syncedTeams = syncResult.syncedTeams;
    syncWarnings.push(...syncResult.warnings);
  } catch (err: unknown) {
    syncWarnings.push(errorMessage(err));
  }
  const query = await enrichRecallQueryWithWorkspaceContext(params.query, {
    cwd: params.callerCwd,
    includeProcessCwd: false,
  });
  const projectQuery = await enrichRecallQueryWithWorkspaceProjectContext(params.query, {
    cwd: params.callerCwd,
    includeProcessCwd: false,
  });
  let indexRepairMessages: readonly string[];
  try {
    const ov = await requiredOpenVikingCli();
    const indexRepair = await repairStaleRecallIndex(config, ov, {query: projectQuery});
    indexRepairMessages = formatRecallIndexRepairMessages(indexRepair);
  } catch (err: unknown) {
    indexRepairMessages = [`Auto-index repair warning: ${errorMessage(err)}`];
  }
  const project = params.pinnedUri ? undefined : await inferProjectFromQuery(config.manifestPath, projectQuery);
  const limitArgs = params.nodeLimit ? ['--node-limit', String(params.nodeLimit)] : [];
  const threshold = params.threshold ?? RECALL_SCORE_THRESHOLD;
  // Run the global base pass plus a seeded project pass, then merge into one
  // deduped ranked list (per document, chunk anchors stripped) so the seeded
  // pass only adds project docs the base missed. --level 2 keeps Level-2
  // content and drops the L0/L1 .overview/.abstract summary sidecars.
  const pinnedArgs = params.pinnedUri ? ['--uri', params.pinnedUri] : [];
  const base = await recallSearchHits(
    config,
    ['search', query, ...pinnedArgs, ...limitArgs],
    threshold,
    params.includeArchived,
  );
  const passes: Array<readonly RecallHit[]> = [base.hits];
  const seededUri = project ? trimTrailingSlash(project.uri) : undefined;
  if (seededUri?.startsWith('viking://') && seededUri !== params.pinnedUri) {
    const seeded = await recallSearchHits(
      config,
      ['search', params.query, '--uri', seededUri, ...limitArgs],
      threshold,
      params.includeArchived,
    );
    passes.push(seeded.hits);
  }

  const sections: string[] = [];
  const exactMatches = await collectExactMemoryMatches(config, query, params.includeArchived, project);
  const limit = params.nodeLimit ?? 12;
  const ranked = applyExactMatchBoost(mergeRecallHits(passes), exactMatches);
  const semanticSection = formatRecallHits(ranked, limit);
  if (semanticSection) {
    sections.push(semanticSection);
  } else if (!base.ok) {
    // Semantic search failed even after the plain fallback (e.g. ov down).
    // Degrade rather than abort: note it and still run exact below.
    sections.push(`Recall semantic search unavailable: ${base.errorText || 'ov search failed'}`);
  }
  if (indexRepairMessages.length > 0) {
    sections.push(indexRepairMessages.join('\n'));
  }
  const shownUris = new Set(ranked.slice(0, limit).map(hit => hit.uri));
  const exactSection = formatExactMatchPointers(exactMatches.filter(match => !shownUris.has(match.uri)));
  if (exactSection) {
    sections.push(exactSection);
  }
  const hygieneHints = await recallHygieneHintsSection(config, sections.join('\n\n'));
  if (hygieneHints) {
    sections.push(hygieneHints);
  }
  if (syncedTeams.length > 0) {
    sections.push(`Auto-synced shared memories: ${syncedTeams.join(', ')}`);
  }
  for (const warning of syncWarnings) {
    sections.push(`Auto-sync warning: ${warning}`);
  }
  if (sections.length === 0) {
    return {content: [{type: 'text', text: 'No recall results found.'}]};
  }
  const onlyErrorNote = !base.ok && !semanticSection && sections.length === 1;
  return {content: [{type: 'text', text: sections.join('\n\n')}], isError: onlyErrorNote || undefined};
}

/**
 * Run one recall search pass with `--output json` via the ov CLI and return
 * parsed hits, falling back to a plain search (no --threshold/--level) on a
 * non-zero exit so an older ov does not fail the recall.
 */
async function recallSearchHits(
  config: RuntimeConfig,
  searchArgs: readonly string[],
  threshold: string,
  includeArchived: boolean,
): Promise<{readonly errorText: string; readonly hits: readonly RecallHit[]; readonly ok: boolean}> {
  let result = await runOpenVikingTool(config, [
    ...searchArgs,
    '--threshold',
    threshold,
    '--level',
    '2',
    '--output',
    'json',
  ]);
  if (result.isError === true) {
    result = await runOpenVikingTool(config, [...searchArgs, '--output', 'json']);
  }
  const firstContent = result.content[0];
  const text = firstContent?.type === 'text' ? firstContent.text : '';
  if (result.isError === true) {
    return {errorText: text.trim(), hits: [], ok: false};
  }
  return {errorText: '', hits: parseRecallHits(text, {includeArchived}), ok: true};
}

async function recallHygieneHintsSection(config: RuntimeConfig, recallText: string): Promise<string | undefined> {
  const uris = activePersonalMemoryUrisFromText(recallText, config.user);
  if (uris.length === 0) {
    return undefined;
  }
  const records = await readMemoryRecordsByUri(config, uris);
  const nudges = recallHygieneNudges(recallText, {records, user: config.user});
  return nudges.length > 0 ? ['Memory hygiene hints:', ...nudges.map(nudge => `- ${nudge}`)].join('\n') : undefined;
}

async function collectExactMemoryMatches(
  config: RuntimeConfig,
  query: string,
  includeArchived: boolean,
  project: ProjectManifest | undefined,
): Promise<readonly ExactMatch[]> {
  const terms = exactRecallTerms(query);
  if (terms.length === 0) {
    return [];
  }
  const ov = await requiredOpenVikingCli();
  const scopes = exactMemoryScopes(config, includeArchived, query, project);
  return collectExactMatches(terms, scopes, async (term, scope) => {
    const result = await runCommand(
      ov,
      withIdentity(config, ['grep', term, '--uri', scope, '--node-limit', '5', '--output', 'json']),
      {allowFailure: true},
    );
    return result.exitCode === 0 ? result.stdout : undefined;
  });
}

function registerReadTool(server: McpServer, config: RuntimeConfig, name: string, description: string): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: `${description} Required: pass JSON arguments with uri, or native OpenViking uris.`,
      inputSchema: {
        uri: z.string().optional().describe('Required viking:// file URI'),
        uris: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('Native OpenViking MCP read input: a single viking:// URI or array of URIs'),
      },
    },
    async ({uri, uris}) => {
      const checkedUris = requiredVikingUriList(uris ?? uri, name, 'viking://agent/threadnote/memories/.abstract.md');
      if (!checkedUris.ok) {
        return checkedUris.error;
      }
      let syncedTeams: readonly string[] = [];
      const syncWarnings: string[] = [];
      try {
        const syncResult = await syncSharedReposBeforeAgentRead(config);
        syncedTeams = syncResult.syncedTeams;
        syncWarnings.push(...syncResult.warnings);
      } catch (err: unknown) {
        syncWarnings.push(errorMessage(err));
      }
      const result = await runOpenVikingReadTool(config, checkedUris.value);
      if (result.isError === true || (syncedTeams.length === 0 && syncWarnings.length === 0)) {
        return result;
      }
      const syncMessages = [
        syncedTeams.length > 0 ? `Auto-synced shared memories: ${syncedTeams.join(', ')}` : undefined,
        ...syncWarnings.map(warning => `Auto-sync warning: ${warning}`),
      ].filter((part): part is string => part !== undefined);
      return {
        ...result,
        content: [...result.content, {type: 'text', text: syncMessages.join('\n')}],
      };
    },
  );
}

function registerListTool(server: McpServer, config: RuntimeConfig, name: string, description: string): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description,
      inputSchema: {
        uri: z.string().optional().describe('Optional viking:// directory URI; defaults to viking://'),
        all: z.boolean().optional().describe('Show hidden files like .abstract.md and .overview.md'),
        recursive: z.boolean().optional().describe('List recursively'),
        simple: z.boolean().optional().describe('Only return paths'),
        nodeLimit: z.number().int().positive().max(1000).optional().describe('Maximum node count'),
        node_limit: z.number().int().positive().max(1000).optional().describe('Maximum node count'),
      },
    },
    async ({recursive, uri}) => {
      const checkedUri = optionalVikingUri(uri, name);
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runOpenVikingMcpTool(config, 'list', {
        recursive,
        uri: checkedUri.value ?? 'viking://',
      });
    },
  );
}

function registerStoreTool(server: McpServer, config: RuntimeConfig, name: string, description: string): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: `${description} Never store secrets, credentials, customer data, or raw logs.`,
      inputSchema: {
        kind: z
          .enum(['durable', 'handoff', 'incident', 'preference', 'smoke'])
          .optional()
          .describe('Memory lifecycle kind; durable facts and handoffs are most common'),
        project: z.string().optional().describe('Project/repo namespace, for example threadnote or mobile-native'),
        replaceUri: z
          .string()
          .optional()
          .describe(
            'Optional viking:// memory URI to replace. Shared URIs are updated in place and pushed; personal URIs are forgotten after the replacement is safely stored.',
          ),
        text: z.string().optional().describe('Required memory text to store'),
        sourceAgentClient: z
          .string()
          .optional()
          .describe('Originating client, for example cursor, copilot, codex, or claude'),
        status: z.enum(['active', 'archived', 'superseded']).optional().describe('Memory lifecycle status'),
        topic: z.string().optional().describe('Stable topic; active project/topic memories update one file'),
      },
    },
    async ({kind, project, replaceUri, sourceAgentClient, status, text, topic}) => {
      const checkedText = requiredText(text, name, 'text', {text: 'Durable engineering note...'});
      if (!checkedText.ok) {
        return checkedText.error;
      }
      const checkedReplaceUri = optionalVikingUri(replaceUri, name);
      if (!checkedReplaceUri.ok) {
        return checkedReplaceUri.error;
      }
      const metadata: MemoryMetadata = {
        kind: kind ?? 'durable',
        project: normalizeOptionalMetadata(project),
        sourceAgentClient: sourceAgentClient ?? 'mcp',
        status: status ?? 'active',
        timestamp: new Date().toISOString(),
        topic: normalizeOptionalMetadata(topic),
      };
      return writeDurableMemory(config, {
        bodyText: checkedText.value,
        metadata,
        replaceUri: checkedReplaceUri.value,
      });
    },
  );
}

function registerArchiveTool(server: McpServer, config: RuntimeConfig, name: string, description: string): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: `${description} The archive is written before the original URI is removed.`,
      inputSchema: {
        kind: z.enum(['durable', 'handoff', 'incident', 'preference', 'smoke']).optional(),
        project: z.string().optional().describe('Project/repo namespace for the archived copy'),
        topic: z.string().optional().describe('Topic for the archived copy'),
        uri: z.string().optional().describe('Required viking:// memory URI to archive'),
      },
    },
    async ({kind, project, topic, uri}) => {
      const checkedUri = requiredVikingUri(uri, name, 'viking://user/example/memories/handoffs/active/repo/topic.md');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      try {
        const readResult = await runOpenVikingReadTool(config, [checkedUri.value]);
        const original = textFromCallToolResult(readResult);
        if (!original) {
          return {
            content: [{type: 'text', text: `Could not read ${checkedUri.value} before archiving.`}],
            isError: true,
          };
        }
        const metadata: MemoryMetadata = {
          archivedFrom: checkedUri.value,
          kind: kind ?? 'handoff',
          project: normalizeOptionalMetadata(project),
          sourceAgentClient: 'mcp',
          status: 'archived',
          timestamp: new Date().toISOString(),
          topic: normalizeOptionalMetadata(topic),
        };
        const archiveResult = await writeDurableMemory(config, {
          bodyText: ['Archived original Threadnote memory.', '', original].join('\n'),
          metadata,
        });
        if (archiveResult.isError === true) {
          return archiveResult;
        }
        const removedOriginal = await forgetVikingResourceWithRetry(config, checkedUri.value);
        const [content] = archiveResult.content;
        const text = content?.type === 'text' ? content.text : 'Archived memory stored.';
        return {
          content: [
            {
              type: 'text',
              text: removedOriginal
                ? `${text}\nArchived original memory: ${checkedUri.value}`
                : `${text}\nArchive stored, but original memory is still processing. Retry later with forget: ${checkedUri.value}`,
            },
          ],
        };
      } catch (err: unknown) {
        return {content: [{type: 'text', text: errorMessage(err)}], isError: true};
      }
    },
  );
}

function registerCompactTool(server: McpServer, config: RuntimeConfig): void {
  server.registerTool(
    'compact_context',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        'Plan or apply scoped Threadnote memory hygiene. Defaults to dry-run; pass apply=true to archive stale handoffs and forget exact duplicates.',
      inputSchema: {
        apply: z.boolean().optional().describe('Apply the compact plan; defaults to false'),
        dryRun: z.boolean().optional().describe('Keep the call read-only; defaults to true unless apply=true'),
        kind: z.enum(['durable', 'handoff', 'incident']).optional().describe('Optional memory kind filter'),
        project: z.string().optional().describe('Required project/repo namespace, for example threadnote'),
        topic: z.string().optional().describe('Optional stable topic name'),
      },
    },
    async ({apply, dryRun, kind, project, topic}) => {
      const checkedProject = requiredText(project, 'compact_context', 'project', {project: 'threadnote'});
      if (!checkedProject.ok) {
        return checkedProject.error;
      }
      if (apply === true && dryRun === true) {
        return {
          content: [{type: 'text', text: 'compact_context cannot combine apply=true with dryRun=true.'}],
          isError: true,
        };
      }
      try {
        const records = await scopedCompactRecords(config, {
          kind: kind as CompactableMemoryKind | undefined,
          project: checkedProject.value,
        });
        const plan = buildCompactPlan(records, {
          kind: kind as CompactableMemoryKind | undefined,
          project: checkedProject.value,
          topic: normalizeOptionalMetadata(topic),
        });
        const shouldApply = apply === true;
        const planText = formatCompactPlan(plan, {apply: shouldApply});
        if (!shouldApply) {
          return {content: [{type: 'text', text: planText}]};
        }

        const ov = await requiredOpenVikingCli();
        const appliedMessages: string[] = [];
        for (const action of plan.keepUpdates) {
          await writeMemoryFile(config, ov, action.uri, action.content, 'replace', false, {quiet: true});
          appliedMessages.push(`Updated kept memory: ${action.uri}`);
        }
        for (const action of plan.archives) {
          const archiveResult = await archiveMemoryForCompact(config, action);
          if (archiveResult.isError === true) {
            return archiveResult;
          }
          const [content] = archiveResult.content;
          if (content?.type === 'text') {
            appliedMessages.push(content.text);
          }
        }
        for (const action of plan.forgets) {
          const removed = await forgetVikingResourceWithRetry(config, action.uri);
          appliedMessages.push(
            removed
              ? `Forgot exact duplicate: ${action.uri}`
              : `Exact duplicate is still processing; retry later with forget: ${action.uri}`,
          );
        }
        return {
          content: [
            {
              type: 'text',
              text: [planText, '', 'Applied actions:', ...appliedMessages.map(message => `- ${message}`)].join('\n'),
            },
          ],
        };
      } catch (err: unknown) {
        return {content: [{type: 'text', text: errorMessage(err)}], isError: true};
      }
    },
  );
}

async function archiveMemoryForCompact(config: RuntimeConfig, action: ArchiveAction): Promise<CallToolResult> {
  const readResult = await runOpenVikingReadTool(config, [action.uri]);
  const original = textFromCallToolResult(readResult);
  if (!original) {
    return {content: [{type: 'text', text: `Could not read ${action.uri} before archiving.`}], isError: true};
  }
  const archiveResult = await writeDurableMemory(config, {
    bodyText: ['Archived original Threadnote memory.', '', original].join('\n'),
    metadata: {
      archivedFrom: action.uri,
      kind: action.kind,
      project: action.project,
      sourceAgentClient: 'mcp',
      status: 'archived',
      timestamp: new Date().toISOString(),
      topic: action.topic,
    },
  });
  if (archiveResult.isError === true) {
    return archiveResult;
  }
  const removedOriginal = await forgetVikingResourceWithRetry(config, action.uri);
  const [content] = archiveResult.content;
  const text = content?.type === 'text' ? content.text : 'Archived memory stored.';
  return {
    content: [
      {
        type: 'text',
        text: removedOriginal
          ? `${text}\nArchived original memory: ${action.uri}`
          : `${text}\nArchive stored, but original memory is still processing. Retry later with forget: ${action.uri}`,
      },
    ],
  };
}

async function scopedCompactRecords(
  config: RuntimeConfig,
  options: {readonly kind?: CompactableMemoryKind; readonly project: string},
): Promise<readonly MemoryRecord[]> {
  const kinds: readonly CompactableMemoryKind[] = options.kind ? [options.kind] : ['handoff', 'durable', 'incident'];
  const records: MemoryRecord[] = [];
  for (const kind of kinds) {
    const directory = localMemoryDirectoryForCompact(config, kind, options.project);
    const uriDirectory = memoryUriDirectoryForCompact(config, kind, options.project);
    let entries;
    try {
      entries = await readdir(directory, {withFileTypes: true});
    } catch (_err: unknown) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.md')) {
        continue;
      }
      const content = await readTextIfExists(join(directory, entry.name));
      if (!content) {
        continue;
      }
      const record = parseMemoryDocument(`${uriDirectory}/${entry.name}`, content);
      if (record) {
        records.push(record);
      }
    }
  }
  return records;
}

async function readMemoryRecordsByUri(
  config: RuntimeConfig,
  uris: readonly string[],
): Promise<readonly MemoryRecord[]> {
  const records: MemoryRecord[] = [];
  for (const uri of uris) {
    const localPath = localMemoryPathForUri(config, uri);
    if (!localPath) {
      continue;
    }
    const content = await readTextIfExists(localPath);
    if (!content) {
      continue;
    }
    const record = parseMemoryDocument(uri, content);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

function localMemoryDirectoryForCompact(config: RuntimeConfig, kind: CompactableMemoryKind, project: string): string {
  const root = localUserMemoriesRoot(config);
  const projectSegment = uriSegment(project);
  switch (kind) {
    case 'durable':
      return join(root, 'durable', 'projects', projectSegment);
    case 'handoff':
      return join(root, 'handoffs', 'active', projectSegment);
    case 'incident':
      return join(root, 'incidents', 'active', projectSegment);
  }
}

function memoryUriDirectoryForCompact(config: RuntimeConfig, kind: CompactableMemoryKind, project: string): string {
  const base = `viking://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(project);
  switch (kind) {
    case 'durable':
      return `${base}/durable/projects/${projectSegment}`;
    case 'handoff':
      return `${base}/handoffs/active/${projectSegment}`;
    case 'incident':
      return `${base}/incidents/active/${projectSegment}`;
  }
}

function localMemoryPathForUri(config: RuntimeConfig, uri: string): string | undefined {
  const prefix = `viking://user/${uriSegment(config.user)}/memories/`;
  if (!uri.startsWith(prefix) || uri.includes('/shared/')) {
    return undefined;
  }
  const relative = uri.slice(prefix.length);
  if (relative.includes('..') || relative.startsWith('/')) {
    return undefined;
  }
  return join(localUserMemoriesRoot(config), ...relative.split('/'));
}

function localUserMemoriesRoot(config: RuntimeConfig): string {
  return join(config.agentContextHome, 'data', 'viking', config.account, 'user', uriSegment(config.user), 'memories');
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (_err: unknown) {
    return undefined;
  }
}

interface WriteDurableMemoryParams {
  readonly bodyText: string;
  readonly metadata: MemoryMetadata;
  readonly replaceUri?: string;
}

async function writeDurableMemory(config: RuntimeConfig, params: WriteDurableMemoryParams): Promise<CallToolResult> {
  try {
    const ov = await requiredOpenVikingCli();
    if (params.replaceUri && isInSharedNamespace(config, params.replaceUri)) {
      return await writeSharedMemoryReplacement(config, ov, params, params.replaceUri);
    }
    const directoryUri = memoryDirectoryUri(config, params.metadata);
    await ensureMemoryDirectory(ov, config, directoryUri);

    // Two-pass formatting: see src/memory.ts:storeMemory for the rationale.
    // Drops the supersedes line when replaceUri points at the URI we're about
    // to write to (in-place update).
    const candidateMetadata: MemoryMetadata = {...params.metadata, supersedes: params.replaceUri};
    const candidateMemory = formatMemoryDocument('MEMORY', candidateMetadata, params.bodyText);
    const memoryUri = memoryUriFor(config, candidateMemory, candidateMetadata);
    const isInPlaceUpdate = params.replaceUri !== undefined && params.replaceUri === memoryUri;
    const finalMetadata: MemoryMetadata = isInPlaceUpdate
      ? {...params.metadata, supersedes: undefined}
      : candidateMetadata;
    const memory = isInPlaceUpdate ? formatMemoryDocument('MEMORY', finalMetadata, params.bodyText) : candidateMemory;
    const writeMode = await memoryWriteMode(ov, config, memoryUri, finalMetadata);
    await writeMemoryFile(config, ov, memoryUri, memory, writeMode, false, {quiet: true});
    const messages = [`Stored memory: ${memoryUri}`];
    if (params.replaceUri && !isInPlaceUpdate) {
      const removedReplacedMemory = await removeVikingResourceWithRetry(ov, config, params.replaceUri);
      messages.push(
        removedReplacedMemory
          ? `Forgot replaced memory: ${params.replaceUri}`
          : `Replacement stored, but superseded memory is still processing. Retry later with forget: ${params.replaceUri}`,
      );
    } else if (isInPlaceUpdate) {
      messages.push(`Updated existing memory in place: ${memoryUri}`);
    }
    return {content: [{type: 'text', text: messages.join('\n')}]};
  } catch (err: unknown) {
    return {content: [{type: 'text', text: errorMessage(err)}], isError: true};
  }
}

async function writeSharedMemoryReplacement(
  config: RuntimeConfig,
  ov: string,
  params: WriteDurableMemoryParams,
  targetUri: string,
): Promise<CallToolResult> {
  if (params.metadata.kind !== 'durable') {
    return argumentError('Shared memory replacement only supports durable memories.');
  }
  const teamName = sharedTeamNameForUri(config, targetUri);
  if (!teamName) {
    return argumentError(`Memory ${targetUri} is not in the shared namespace.`);
  }
  const resolved = await resolveTeam(config, teamName);
  const inferred = sharedMemoryUriParts(config, targetUri);
  const metadata: MemoryMetadata = {
    ...params.metadata,
    project: params.metadata.project ?? inferred?.project,
    topic: params.metadata.topic ?? inferred?.topic,
  };
  const rawMemory = formatMemoryDocument('MEMORY', metadata, params.bodyText);
  const scrub = applyScrubber(stripPersonalProvenance(rawMemory), {redact: false});
  if (scrub.blocker) {
    return argumentError(
      `Refusing to update shared memory ${targetUri}: possible ${scrub.blocker}. Strip the sensitive value first.`,
    );
  }

  await ensureSharedDirectoryChain(config, ov, targetUri, false, {quiet: true});
  await writeMemoryFile(config, ov, targetUri, scrub.cleaned, 'replace', false, {quiet: true});

  const relativePath = vikingUriToWorktreeRelative(config, targetUri, resolved.name);
  const messages = [`Updated shared memory: ${targetUri}`];
  for (const redaction of scrub.redactions) {
    messages.push(`Redacted ${redaction.count}× ${redaction.name} before shared update.`);
  }
  messages.push(
    ...(await publishShareGitChange(resolved.config.worktree, relativePath, `share: update ${relativePath}`)),
  );
  return {content: [{type: 'text', text: messages.join('\n')}]};
}

async function vikingResourceExists(ov: string, config: RuntimeConfig, uri: string): Promise<boolean> {
  const stat = await runCommand(ov, withIdentity(config, ['stat', uri]), {allowFailure: true});
  return stat.exitCode === 0;
}

async function removeVikingResourceWithRetry(
  ov: string,
  config: RuntimeConfig,
  uri: string,
  recursive = false,
): Promise<boolean> {
  const args = withIdentity(config, ['rm', uri, ...(recursive ? ['--recursive'] : [])]);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await runCommand(ov, args, {allowFailure: true});
    if (result.exitCode === 0) {
      return true;
    }
    if (isResourceBusy(result.stderr, result.stdout) && attempt === 3) {
      return false;
    }
    if (!isResourceBusy(result.stderr, result.stdout)) {
      throw new Error(`${ov} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    await sleep(1000 * (attempt + 1));
  }
  return false;
}

async function runOpenVikingRemoveTool(
  config: RuntimeConfig,
  uri: string,
  recursive: boolean,
): Promise<CallToolResult> {
  try {
    const ov = await requiredOpenVikingCli();
    const removed = await removeVikingResourceWithRetry(ov, config, uri, recursive);
    return {
      content: [
        {
          type: 'text',
          text: removed ? `Removed: ${uri}` : `Resource is still being processed; retry later: ${uri}`,
        },
      ],
      isError: !removed,
    };
  } catch (err: unknown) {
    return {content: [{type: 'text', text: errorMessage(err)}], isError: true};
  }
}

function isResourceBusy(stderr: string, stdout: string): boolean {
  const output = `${stderr}\n${stdout}`.toLowerCase();
  return output.includes('resource is busy') || output.includes('resource is being processed');
}

async function ensureMemoryDirectory(ov: string, config: RuntimeConfig, directoryUri: string): Promise<void> {
  for (const uri of vikingDirectoryChain(directoryUri)) {
    const statResult = await runCommand(ov, withIdentity(config, ['stat', uri]), {allowFailure: true});
    if (statResult.exitCode === 0) {
      continue;
    }
    await runCommand(
      ov,
      withIdentity(config, ['mkdir', uri, '--description', 'Threadnote lifecycle-aware local memories.']),
    );
  }
}

function memoryUriFor(config: RuntimeConfig, memory: string, metadata: MemoryMetadata): string {
  const filename = shouldUseStableMemoryUri(metadata)
    ? `${uriSegment(metadata.topic ?? 'current')}.md`
    : `threadnote-${safeTimestamp()}-${sha256(memory).slice(0, 12)}.md`;
  return `${memoryDirectoryUri(config, metadata)}/${filename}`;
}

function memoryDirectoryUri(config: RuntimeConfig, metadata: MemoryMetadata): string {
  const baseUri = `viking://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(metadata.project ?? 'general');
  switch (metadata.kind) {
    case 'preference':
      return metadata.status === 'active'
        ? `${baseUri}/preferences`
        : `${baseUri}/preferences/${uriSegment(metadata.status)}`;
    case 'handoff':
      return `${baseUri}/handoffs/${uriSegment(metadata.status)}/${projectSegment}`;
    case 'incident':
      return `${baseUri}/incidents/${uriSegment(metadata.status)}/${projectSegment}`;
    case 'smoke':
      return `${baseUri}/smoke/${uriSegment(metadata.status)}`;
    case 'durable':
      return metadata.status === 'active'
        ? `${baseUri}/durable/projects/${projectSegment}`
        : `${baseUri}/durable/${uriSegment(metadata.status)}/${projectSegment}`;
  }
}

function shouldUseStableMemoryUri(metadata: MemoryMetadata): boolean {
  return metadata.status === 'active' && metadata.topic !== undefined && metadata.kind !== 'smoke';
}

async function memoryWriteMode(
  ov: string,
  config: RuntimeConfig,
  memoryUri: string,
  metadata: MemoryMetadata,
): Promise<'create' | 'replace'> {
  if (!shouldUseStableMemoryUri(metadata)) {
    return 'create';
  }
  return (await vikingResourceExists(ov, config, memoryUri)) ? 'replace' : 'create';
}

function vikingDirectoryChain(directoryUri: string): readonly string[] {
  const prefix = 'viking://';
  if (!directoryUri.startsWith(prefix)) {
    return [directoryUri];
  }
  const parts = directoryUri.slice(prefix.length).split('/').filter(Boolean);
  const startIndex = parts[0] === 'user' && parts.length > 2 ? 3 : 1;
  const chain: string[] = [];
  for (let index = startIndex; index <= parts.length; index += 1) {
    chain.push(`${prefix}${parts.slice(0, index).join('/')}`);
  }
  return chain;
}

function exactMemoryScopes(
  config: RuntimeConfig,
  includeArchived: boolean,
  query: string,
  project: ProjectManifest | undefined,
): readonly string[] {
  return exactMemoryScopeUris({
    agentMemoriesUri: `viking://agent/${uriSegment(config.agentId)}/memories`,
    includeArchived,
    intents: exactRecallScopeIntents(query),
    projectName: project ? uriSegment(project.name) : undefined,
    projectResourceUri: project ? trimTrailingSlash(project.uri) : undefined,
    userBase: `viking://user/${uriSegment(config.user)}/memories`,
  });
}

function formatMemoryDocument(title: 'MEMORY', metadata: MemoryMetadata, body: string): string {
  const header = [
    title,
    `kind: ${metadata.kind}`,
    `status: ${metadata.status}`,
    metadata.project ? `project: ${metadata.project}` : undefined,
    metadata.topic ? `topic: ${metadata.topic}` : undefined,
    `source_agent_client: ${metadata.sourceAgentClient}`,
    `timestamp: ${metadata.timestamp}`,
    metadata.supersedes ? `supersedes: ${metadata.supersedes}` : undefined,
    metadata.archivedFrom ? `archived_from: ${metadata.archivedFrom}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return [...header, '', body.trim()].join('\n');
}

function normalizeOptionalMetadata(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function uriSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'unknown';
}

function requiredText(
  value: string | undefined,
  toolName: string,
  fieldName: string,
  example: Record<string, string>,
): CheckedText {
  const normalized = value?.trim();
  if (normalized) {
    return {ok: true, value: normalized};
  }
  return {
    error: argumentError(
      [
        `Threadnote MCP tool "${toolName}" needs a non-empty "${fieldName}" argument.`,
        'Pass JSON arguments to the tool call.',
        `Example: ${toolName}(${JSON.stringify(example)})`,
      ].join('\n'),
    ),
    ok: false,
  };
}

function requiredVikingUri(value: string | undefined, toolName: string, exampleUri: string): CheckedText {
  const checked = requiredText(value, toolName, 'uri', {uri: exampleUri});
  if (!checked.ok) {
    return checked;
  }
  if (checked.value.startsWith('viking://')) {
    return checked;
  }
  return {
    error: argumentError(`Threadnote MCP tool "${toolName}" needs a viking:// URI. Received: ${checked.value}`),
    ok: false,
  };
}

function optionalVikingUri(value: string | undefined, toolName: string): CheckedOptionalText {
  const normalized = value?.trim();
  if (!normalized) {
    return {ok: true, value: undefined};
  }
  if (normalized.startsWith('viking://')) {
    return {ok: true, value: normalized};
  }
  return {
    error: argumentError(
      `Threadnote MCP tool "${toolName}" optional "uri" must start with viking://. Received: ${normalized}`,
    ),
    ok: false,
  };
}

function requiredVikingUriList(
  value: readonly string[] | string | undefined,
  toolName: string,
  exampleUri: string,
): CheckedTextArray {
  const rawValues = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const uris = rawValues.map(uri => uri.trim()).filter(Boolean);
  if (uris.length === 0) {
    return {
      error: argumentError(
        [
          `Threadnote MCP tool "${toolName}" needs a non-empty "uri" or "uris" argument.`,
          'Pass JSON arguments to the tool call.',
          `Example: ${toolName}(${JSON.stringify({uris: [exampleUri]})})`,
        ].join('\n'),
      ),
      ok: false,
    };
  }
  const invalid = uris.find(uri => !uri.startsWith('viking://'));
  if (invalid) {
    return {
      error: argumentError(`Threadnote MCP tool "${toolName}" needs viking:// URI values. Received: ${invalid}`),
      ok: false,
    };
  }
  return {ok: true, value: uris};
}

function argumentError(text: string): CallToolResult {
  return {content: [{type: 'text', text}], isError: true};
}

interface OpenVikingAddResourceParams {
  readonly description?: string;
  readonly path?: string;
  readonly tempFileId?: string;
  readonly to?: string;
  readonly wait?: boolean;
  readonly watchInterval?: number;
}

async function runOpenVikingAddResourceTool(
  config: RuntimeConfig,
  toolName: string,
  params: OpenVikingAddResourceParams,
): Promise<CallToolResult> {
  const tempFileId = params.tempFileId?.trim();
  const source = params.path?.trim();
  if (!source && !tempFileId) {
    return argumentError(
      [
        `Threadnote MCP tool "${toolName}" needs a non-empty "path" argument.`,
        'Pass JSON arguments to the tool call.',
        `Example: ${toolName}(${JSON.stringify({path: '/path/to/README.md', to: 'viking://resources/my-repo/README.md'})})`,
      ].join('\n'),
    );
  }
  if (tempFileId) {
    const checkedTo = optionalVikingUri(params.to, toolName);
    if (!checkedTo.ok) {
      return checkedTo.error;
    }
    return runOpenVikingMcpTool(config, 'add_resource', {
      description: params.description,
      temp_file_id: tempFileId,
      to: checkedTo.value,
      watch_interval: params.watchInterval,
    });
  }
  const checkedTo = optionalVikingUri(params.to, toolName);
  if (!checkedTo.ok) {
    return checkedTo.error;
  }
  const description = params.description?.trim();
  return runOpenVikingMcpTool(config, 'add_resource', {
    description,
    path: source,
    to: checkedTo.value,
    watch_interval: params.watchInterval,
  });
}

async function runOpenVikingReadTool(config: RuntimeConfig, uris: readonly string[]): Promise<CallToolResult> {
  const result = await runOpenVikingMcpTool(config, 'read', {uris});
  if (result.isError !== true && !nativeReadMissedAnyUri(result, uris)) {
    return result;
  }
  return runOpenVikingReadToolWithCliFallback(config, uris);
}

function nativeReadMissedAnyUri(result: CallToolResult, uris: readonly string[]): boolean {
  const text = textFromCallToolResult(result);
  return uris.some(uri => text.includes(`(nothing found at ${uri})`));
}

async function runOpenVikingReadToolWithCliFallback(
  config: RuntimeConfig,
  uris: readonly string[],
): Promise<CallToolResult> {
  const outputs: string[] = [];
  for (const uri of uris) {
    const nativeResult = await runOpenVikingMcpTool(config, 'read', {uris: [uri]});
    const nativeText = textFromCallToolResult(nativeResult);
    let text = nativeText;
    if (nativeResult.isError === true || nativeText.includes(`(nothing found at ${uri})`)) {
      const cliResult = await runOpenVikingCliReadTool(config, uri);
      if (cliResult.isError === true) {
        return cliResult;
      }
      text = textFromCallToolResult(cliResult);
    }
    outputs.push(uris.length === 1 ? text : `=== ${uri} ===\n${text}`);
  }
  return {content: [{type: 'text', text: outputs.filter(Boolean).join('\n\n') || 'OK'}]};
}

async function runOpenVikingCliReadTool(config: RuntimeConfig, uri: string): Promise<CallToolResult> {
  try {
    const ov = await requiredOpenVikingCli();
    const result = await runCommand(ov, withIdentity(config, ['read', uri]));
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    return {content: [{type: 'text', text: text || 'OK'}]};
  } catch (err: unknown) {
    return {content: [{type: 'text', text: errorMessage(err)}], isError: true};
  }
}

/**
 * Run an `ov` CLI subcommand and wrap its output as a CallToolResult. Used by
 * the enriched recall path (`recall_context`) so semantic search returns the
 * compact ranked list (URI + score + short snippet) instead of the native
 * `/mcp` search, which returns full Level-2 bodies and bloats recall ~15x.
 * Goes through `runCommand` (no-shell `execFile`), so it stays injection-safe.
 */
async function runOpenVikingTool(config: RuntimeConfig, args: readonly string[]): Promise<CallToolResult> {
  try {
    const ov = await requiredOpenVikingCli();
    const result = await runCommand(ov, withIdentity(config, args));
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    return {content: [{type: 'text', text: text || 'OK'}]};
  } catch (err: unknown) {
    return {content: [{type: 'text', text: errorMessage(err)}], isError: true};
  }
}

async function runOpenVikingMcpTool(
  config: RuntimeConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const client = new Client({name: 'threadnote-openviking-proxy', version: '1.1.0'});
  try {
    const transport = new StreamableHTTPClientTransport(new URL(config.openVikingMcpUrl), {
      requestInit: {
        headers: {
          'X-OpenViking-Account': config.account,
          'X-OpenViking-Agent': config.agentId,
          'X-OpenViking-User': config.user,
        },
      },
    });
    await client.connect(transport);
    const result = await client.callTool({arguments: stripUndefinedValues(args), name: toolName}, undefined, {
      timeout: 30_000,
    });
    return normalizeCallToolResult(result);
  } catch (err: unknown) {
    return {
      content: [
        {
          type: 'text',
          text: `OpenViking native MCP tool "${toolName}" failed at ${config.openVikingMcpUrl}: ${errorMessage(err)}`,
        },
      ],
      isError: true,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function stripUndefinedValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, unknown] => entry[1] !== undefined),
  );
}

function normalizeCallToolResult(result: unknown): CallToolResult {
  const maybeResult = result as Partial<CallToolResult>;
  if (Array.isArray(maybeResult.content)) {
    return {
      content: maybeResult.content,
      isError: maybeResult.isError,
    } as CallToolResult;
  }
  return {content: [{type: 'text', text: JSON.stringify(result)}]};
}

function textFromCallToolResult(result: CallToolResult): string {
  return result.content
    .map(content => (content.type === 'text' ? content.text : ''))
    .join('\n')
    .trim();
}

async function forgetVikingResourceWithRetry(config: RuntimeConfig, uri: string): Promise<boolean> {
  const ov = await requiredOpenVikingCli();
  return removeVikingResourceWithRetry(ov, config, uri);
}

interface SharePublishToolOptions {
  readonly message?: string;
  readonly preview?: boolean;
  readonly push?: boolean;
  readonly redact?: boolean;
  readonly team?: string;
}

interface ShareSkillToolOptions {
  readonly agent?: 'claude' | 'codex';
  readonly force?: boolean;
  readonly kind?: 'command' | 'skill';
  readonly message?: string;
  readonly name?: string;
  readonly preview?: boolean;
  readonly push?: boolean;
  readonly redact?: boolean;
  readonly team?: string;
}

interface SharedSkillFilterOptions {
  readonly agent?: 'claude' | 'codex';
  readonly kind?: 'command' | 'skill';
  readonly name?: string;
  readonly team?: string;
}

interface InstallSharedSkillToolOptions {
  readonly agent?: 'claude' | 'codex';
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly kind?: 'command' | 'skill';
  readonly team?: string;
}

async function runSharePublishTool(
  config: RuntimeConfig,
  sourceUri: string,
  options: SharePublishToolOptions,
): Promise<CallToolResult> {
  try {
    if (isInSharedNamespace(config, sourceUri)) {
      return argumentError(`Memory ${sourceUri} is already in the shared namespace.`);
    }
    const resolved = await resolveTeam(config, options.team);
    const ov = await requiredOpenVikingCli();
    const readResult = await runOpenVikingReadTool(config, [sourceUri]);
    const sourceText = textFromCallToolResult(readResult);
    if (readResult.isError === true || !sourceText) {
      return {
        content: [
          {
            type: 'text',
            text: `Could not read ${sourceUri}: ${sourceText || 'unknown error'}`,
          },
        ],
        isError: true,
      };
    }
    const stripped = stripPersonalProvenance(sourceText);
    const scrub = applyScrubber(stripped, {redact: options.redact === true});
    const targetUri = sharedUriFor(config, sourceUri, resolved.name);

    if (options.preview === true) {
      const previewLines = [`PREVIEW source: ${sourceUri}`, `PREVIEW destination: ${targetUri}`];
      if (scrub.blocker) {
        previewLines.push(
          `PREVIEW BLOCKED: ${scrub.blocker}. Strip the sensitive value or pass redact=true for soft-leak patterns.`,
        );
        return {content: [{type: 'text', text: previewLines.join('\n')}]};
      }
      for (const redaction of scrub.redactions) {
        previewLines.push(`PREVIEW redact: ${redaction.count}× ${redaction.name}`);
      }
      previewLines.push('-----BEGIN PREVIEW-----');
      previewLines.push(scrub.cleaned);
      previewLines.push('-----END PREVIEW-----');
      return {content: [{type: 'text', text: previewLines.join('\n')}]};
    }

    if (scrub.blocker) {
      return argumentError(
        `Refusing to publish ${sourceUri}: possible ${scrub.blocker}. Strip the sensitive value or pass redact=true for soft-leak patterns.`,
      );
    }
    const content = scrub.cleaned;
    // Refuse to silently overwrite an existing shared memory (e.g., a teammate
    // already published the same project/topic). Mirrors the CLI publish path.
    if (await sharedVikingResourceExists(ov, config, targetUri)) {
      return argumentError(
        `Refusing to publish: ${targetUri} already exists in the shared namespace. Inspect it via threadnote read; if it should be replaced, forget the existing shared copy first.`,
      );
    }
    await ensureSharedDirectoryChain(config, ov, targetUri, false, {quiet: true});
    await writeMemoryFile(config, ov, targetUri, content, 'create', false, {quiet: true});
    const messages = [`Published ${sourceUri} -> ${targetUri}`];
    for (const redaction of scrub.redactions) {
      messages.push(`Redacted ${redaction.count}× ${redaction.name} before publish.`);
    }
    const relativePath = vikingUriToWorktreeRelative(config, targetUri, resolved.name);
    const commitMessage = options.message ?? `share: publish ${relativePath}`;
    const gitMessages = await publishShareGitChange(resolved.config.worktree, relativePath, commitMessage, {
      push: options.push,
    });
    try {
      await forgetVikingResourceWithRetry(config, sourceUri);
    } catch (sourceErr: unknown) {
      return {
        content: [
          {
            type: 'text',
            text: [
              ...messages,
              ...gitMessages,
              `Could not remove the personal source after publish: ${sourceUri}.`,
              `Retry cleanup later with: threadnote forget ${sourceUri}`,
              sourceErr instanceof Error ? sourceErr.message : String(sourceErr),
            ].join('\n'),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{type: 'text', text: [...messages, ...gitMessages].join('\n')}],
      isError: false,
    };
  } catch (err: unknown) {
    return {content: [{type: 'text', text: errorMessage(err)}], isError: true};
  }
}

async function runShareSkillTool(
  config: RuntimeConfig,
  sourcePath: string,
  options: ShareSkillToolOptions,
): Promise<CallToolResult> {
  try {
    const result = await shareAgentArtifact(config, sourcePath, options);
    const lines = [...result.messages, ...result.gitMessages];
    if (result.previewContent !== undefined) {
      lines.push('-----BEGIN PREVIEW-----');
      lines.push(result.previewContent);
      lines.push('-----END PREVIEW-----');
    }
    return {content: [{type: 'text', text: lines.join('\n')}], isError: false};
  } catch (err: unknown) {
    return {content: [{type: 'text', text: errorMessage(err)}], isError: true};
  }
}

async function runListSharedSkillsTool(
  config: RuntimeConfig,
  options: SharedSkillFilterOptions,
): Promise<CallToolResult> {
  try {
    const result = await listSharedAgentArtifacts(config, options);
    if (result.artifacts.length === 0) {
      const lines = shareArtifactToolHeader(result.team, result.syncedTeams, result.warnings);
      lines.push(`No shared skills or commands found for team "${result.team}".`);
      return {content: [{type: 'text', text: lines.join('\n')}]};
    }
    const lines = shareArtifactToolHeader(result.team, result.syncedTeams, result.warnings);
    lines.push(`Shared skills and commands for team "${result.team}":`);
    for (const artifact of result.artifacts) {
      lines.push(
        `- ${artifact.artifact.kind} ${artifact.artifact.agent}/${artifact.artifact.name} (${artifact.installStatus})`,
      );
      lines.push(
        `  install: install_shared_skill({"name":"${artifact.artifact.name}","agent":"${artifact.artifact.agent}","kind":"${artifact.artifact.kind}"})`,
      );
    }
    return {content: [{type: 'text', text: lines.join('\n')}], isError: false};
  } catch (err: unknown) {
    return {content: [{type: 'text', text: errorMessage(err)}], isError: true};
  }
}

async function runInstallSharedSkillTool(
  config: RuntimeConfig,
  name: string,
  options: InstallSharedSkillToolOptions,
): Promise<CallToolResult> {
  try {
    const result = await installSharedAgentArtifacts(config, {
      ...options,
      apply: options.dryRun !== true,
      name,
    });
    return {
      content: [
        {
          type: 'text',
          text: [...shareArtifactToolHeader(result.team, result.syncedTeams, result.warnings), ...result.messages].join(
            '\n',
          ),
        },
      ],
      isError: false,
    };
  } catch (err: unknown) {
    return {content: [{type: 'text', text: errorMessage(err)}], isError: true};
  }
}

function shareArtifactToolHeader(team: string, syncedTeams: readonly string[], warnings: readonly string[]): string[] {
  const lines = [`Team: ${team}`];
  if (syncedTeams.length > 0) {
    lines.push(`Synced shared teams: ${syncedTeams.join(', ')}`);
  }
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }
  return lines;
}

function withIdentity(config: RuntimeConfig, args: readonly string[]): readonly string[] {
  return [...args, '--account', config.account, '--user', config.user, '--agent-id', config.agentId];
}

async function requiredOpenVikingCli(): Promise<string> {
  const command = await findOpenVikingCli();
  if (!command) {
    throw new Error('Neither ov nor openviking was found. Run threadnote install first.');
  }
  return command;
}

main().catch(err => {
  process.stderr.write(`${errorMessage(err)}\n`);
  process.exit(1);
});
