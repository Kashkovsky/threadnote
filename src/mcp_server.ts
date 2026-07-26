#! /usr/bin/env node

import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Clock, Console, Effect, FileSystem, Path, Result, pipe} from 'effect';
import {DEFAULT_ACCOUNT, DEFAULT_AGENT_ID, DEFAULT_HOST, DEFAULT_PORT} from './constants.js';
import {DEFAULT_MCP_TOOLSET, MCP_TOOLSET_ENV, type McpToolset, parseMcpToolset} from './mcp_toolset.js';
import {formatRecallIndexRepairMessages, repairStaleRecallIndex} from './index_repair.js';
import {inferProjectFromQuery, inferWorksetFromQuery, requireWorkset} from './manifest.js';
import {buildOnboardingGuide, gatherOnboardingContext} from './onboarding.js';
import type {ProjectManifest, ResolvedWorkset} from './types.js';
import {
  activePersonalMemoryUrisFromText,
  type ArchiveAction,
  buildCompactPlan,
  type CompactableMemoryKind,
  formatCompactPlan,
  formatReferencedContextPointers,
  parseMemoryDocument,
  recallHygieneNudges,
  referencedUrisFromRecords,
  type MemoryRecord,
} from './memory_hygiene.js';
import {
  ensureSharedDirectoryChain,
  isInSharedNamespace,
  publishShareGitChange,
  resolveTeam,
  applyScrubber,
  sharedMemoryUriParts,
  sharedTeamNameForUri,
  sharedUriFor,
  stripPersonalProvenance,
  vikingResourceExists as sharedVikingResourceExists,
  vikingUriToWorktreeRelative,
  writeMemoryFile,
} from './share.js';
import {
  collectExactMatches,
  currentPackageVersion,
  errorMessage,
  formatStaleVersionNotice,
  enrichRecallQueryWithWorkspaceContext,
  enrichRecallQueryWithWorkspaceProjectContext,
  exactMemoryScopeUris,
  exactRecallScopeIntents,
  exactRecallTerms,
  expandPath,
  findOpenVikingCli,
  parsePort,
  parseRecallHits,
  type RecallHit,
  recallScoreThreshold,
  resolveWorkspaceRepoName,
  runCommand,
  safeTimestamp,
  sha256,
  trimTrailingSlash,
} from './utils.js';
import {withIdentity} from './runtime.js';
import {EffectMcpServerAdapter, McpInput} from './effect/mcp.js';
import {
  boundedRecallExpansionScopes,
  expandWeakRecallQueryEffect,
  limitRecallRewritesForConfidence,
  localRecallAiEnabled,
  mergeRecallRewritesForConfidence,
  recallHybridMinimumScore,
  recallRewriteLimitForConfidence,
  selectExpandedRecallCandidatesEffect,
  shouldExpandRecall,
} from './effect/ai-recall.js';
import {resolveEffectAiConfiguration} from './effect/ai-consolidator.js';
import {enrichMemoryMetadataWithConfiguredLocalAi} from './effect/ai-enrichment.js';
import {sha256Hex} from './effect/digest.js';
import {removeOpenVikingResourceEffect} from './effect/openviking.js';
import {withMemoryUriLocks} from './effect/memory_lock.js';
import {ApplicationLayer} from './effect/runtime.js';
import {SystemInfo} from './effect/system.js';
import {
  installSharedAgentArtifacts,
  listShareConflicts,
  listSharedAgentArtifacts,
  monitorSharedRepositories,
  resolveShareConflict,
  shareAgentArtifact,
  shareBundlePack,
  showShareConflict,
  syncSharedReposBeforeAgentRead,
} from './effect/share.js';
import {withSharedRepositoryLock} from './effect/share_lock.js';
import {
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  isSharedMemoryUri,
  type MemoryMetadata,
} from './memory_document.js';
import {
  buildCandidateReview,
  candidateReviewWithAuditEvent,
  candidateReviewWithApplyStage,
  candidateReviewWithApplying,
  candidateReviewWithState,
  loadCandidateReview,
  readActiveProjectMemories,
  saveCandidateReview,
  type CandidateReview,
  type CandidateApplyOperation,
  type MemoryCandidate,
  type SessionCloseoutInput,
  validateSessionCloseoutInput,
  withCandidateReviewLock,
} from './candidate_memory.js';
import {recordRecallFeedback} from './recall/feedback.js';
import {RECALL_RANKER_VERSION} from './recall/rank.js';
import {
  buildRecallIndexSelectionCandidates,
  buildRecallSelectionCandidates,
  loadRecallExpansionVocabulary,
  prepareRecallSections,
  recallSelectionAnchorIds,
  recallSelectionQueries,
  selectedRecallCandidateUris,
} from './recall/runtime.js';

interface RuntimeConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly agentId: string;
  readonly manifestPath: string;
  readonly openVikingMcpUrl: string;
  readonly user: string;
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

type CheckedOptionalTextArray =
  | {
      readonly ok: true;
      readonly value: readonly string[] | undefined;
    }
  | {
      readonly error: CallToolResult;
      readonly ok: false;
    };

// Version this MCP server process started from, captured at startup. A later
// `threadnote update` overwrites the package on disk, but this resident stdio
// process keeps running the old code (clients don't respawn an MCP server on
// update), so we compare against the on-disk version and nudge the caller to
// reconnect — otherwise they silently keep hitting stale code.
let mcpStartupVersion: string | undefined;
let staleNoticeCache: {readonly checkedAtMs: number; readonly notice: string | undefined} | undefined;
const STALE_NOTICE_TTL_MS = 60_000;

const staleVersionNotice = Effect.fn('mcpServer.staleVersionNotice')(function* () {
  if (mcpStartupVersion === undefined) {
    return undefined;
  }
  const nowMs = yield* Clock.currentTimeMillis;
  if (staleNoticeCache && nowMs - staleNoticeCache.checkedAtMs < STALE_NOTICE_TTL_MS) {
    return staleNoticeCache.notice;
  }
  const notice = yield* currentPackageVersion().pipe(
    Effect.map(version => formatStaleVersionNotice(mcpStartupVersion as string, version)),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  staleNoticeCache = {checkedAtMs: nowMs, notice};
  return notice;
});

const withStaleVersionNotice = Effect.fn('mcpServer.withStaleVersionNotice')(function* (result: CallToolResult) {
  const notice = yield* staleVersionNotice();
  if (notice === undefined) {
    return result;
  }
  return {...result, content: [...(result.content ?? []), {type: 'text', text: `⚠ ${notice}`}]};
});

const mainEffect = Effect.gen(function* () {
  const system = yield* SystemInfo;
  const config = yield* getRuntimeConfig();
  const toolset = yield* Effect.try({
    try: () => parseMcpToolset(system.environment()[MCP_TOOLSET_ENV] ?? DEFAULT_MCP_TOOLSET),
    catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
  });
  mcpStartupVersion = yield* currentPackageVersion().pipe(Effect.catch(() => Effect.succeed(undefined)));
  const instructions =
    'For non-trivial work call `recall_context` with repo and absolute `callerCwd`; read `viking://` results. At closeout store durable feature knowledge and handoffs directly with `remember_context` without approval. Use `review_session_context` only for additional candidates; apply them only after explicit approval/edit/defer/reject. Use stable project/topic and replace duplicates. Do not store secrets, credentials, customer data, or raw logs. Confirm before `share_publish`; never publish handoffs/preferences.';
  const server = new EffectMcpServerAdapter('threadnote-local-adapter', '0.2.0', instructions);

  registerTools(server, config, toolset);
  yield* Effect.forkScoped(monitorSharedRepositories(config));
  yield* Console.error('Threadnote local MCP adapter running');
  return yield* server.run();
});

const getRuntimeConfig = Effect.fn('mcpServer.getRuntimeConfig')(function* () {
  const system = yield* SystemInfo;
  const environment = system.environment();
  const host = environment.THREADNOTE_HOST ?? DEFAULT_HOST;
  const port = parsePort(environment.THREADNOTE_PORT ?? String(DEFAULT_PORT));
  return {
    account: environment.THREADNOTE_ACCOUNT ?? DEFAULT_ACCOUNT,
    agentContextHome: yield* expandPath(environment.THREADNOTE_HOME ?? '~/.openviking'),
    agentId: environment.THREADNOTE_AGENT_ID ?? DEFAULT_AGENT_ID,
    manifestPath: yield* expandPath(environment.THREADNOTE_MANIFEST ?? '~/.openviking/seed-manifest.yaml'),
    openVikingMcpUrl: environment.THREADNOTE_OPENVIKING_MCP_URL ?? `http://${host}:${port}/mcp`,
    user: environment.THREADNOTE_USER ?? system.userName,
  };
});

function registerTools(server: EffectMcpServerAdapter, config: RuntimeConfig, toolset: McpToolset): void {
  registerSearchTool(
    server,
    config,
    'recall_context',
    'Search memories and seeded project guidance. Include the repo/project in the query; pass absolute callerCwd for current repo/branch. Returns viking:// pointers to read or list. Lower threshold if results are sparse.',
  );
  if (toolset === 'full') {
    registerSearchTool(
      server,
      config,
      'search',
      'Compatibility alias for recall_context. Searches both personal memories and seeded project resources; see recall_context for the query conventions.',
    );
  }

  registerReadTool(
    server,
    config,
    'read_context',
    'Read a viking:// file URI returned by recall_context or list_context.',
  );
  if (toolset === 'full') {
    registerReadTool(server, config, 'read', 'Compatibility alias for read_context.');
  }

  registerListTool(server, config, 'list_context', 'List a viking:// directory returned by recall_context.');
  if (toolset === 'full') {
    registerListTool(server, config, 'list', 'Compatibility alias for list_context.');
  }

  registerStoreTool(
    server,
    config,
    'remember_context',
    'Store a durable Threadnote memory. Required: pass JSON arguments with text.',
  );
  if (toolset === 'full') {
    registerStoreTool(server, config, 'store', 'Compatibility alias for remember_context.');
  }

  registerCandidateMemoryTools(server, config);

  if (toolset === 'full') {
    registerArchiveTool(
      server,
      config,
      'archive_context',
      'Archive a memory so it remains readable as provenance but is no longer current working context.',
    );
    registerArchiveTool(server, config, 'archive', 'Compatibility alias for archive_context.');
    registerCompactTool(server, config);
    registerRecallFeedbackTool(server, config);
  }

  server.registerTool(
    'threadnote_guide',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'Return a state-aware Threadnote capability tour. Call when the user asks what Threadnote can do or how to start; present it conversationally and offer one step at a time.',
      inputSchema: {},
    },
    Effect.fn('mcp_server.callback')(function* () {
      return yield* runThreadnoteGuideTool(config, toolset);
    }),
  );

  server.registerTool(
    'share_publish',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        'Publish a personal durable memory to the team shared repo. Scrubs sensitive data, writes and pushes the shared copy first, then removes the original. Confirm with the user; never publish handoffs or preferences. Use preview to inspect without writing.',
      inputSchema: {
        message: McpInput.string('Commit message override; defaults to "share: publish <path>"'),
        preview: McpInput.boolean(
          'Return the bytes that would land in the shared git repo (after frontmatter strip and redaction) without writing or committing. Use this to inspect the body before publishing.',
        ),
        push: McpInput.boolean('Push to remote after committing; defaults to true'),
        redact: McpInput.boolean(
          'Replace soft-leak matches (local paths) with placeholders and continue; credentials still block.',
        ),
        team: McpInput.string('Team name; defaults to the configured default team'),
        uri: McpInput.string('Required viking:// memory URI to publish'),
      },
    },
    ({message, preview, push, redact, team, uri}) => {
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

  if (toolset === 'core') {
    return;
  }

  server.registerTool(
    'forget',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: 'Remove a viking:// URI from OpenViking.',
      inputSchema: {
        recursive: McpInput.boolean('Remove a directory recursively'),
        uri: McpInput.string('Required viking:// URI to remove'),
      },
    },
    ({recursive, uri}) => {
      const checkedUri = requiredVikingUri(uri, 'forget', 'viking://user/you/memories/example.md');
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
        description: McpInput.string('Optional import reason/description'),
        path: McpInput.string('Local source file/directory or URL; native OpenViking MCP name'),
        sourcePath: McpInput.string('Required local source file or directory'),
        source_path: McpInput.string('Compatibility alias for path'),
        tempFileId: McpInput.string('Native progressive upload temp file id'),
        temp_file_id: McpInput.string('Native progressive upload temp file id'),
        to: McpInput.string('Optional destination viking:// URI'),
        wait: McpInput.boolean('Wait for processing to finish'),
        watchInterval: McpInput.integer('Watch interval in minutes', {minimum: 0}),
        watch_interval: McpInput.integer('Watch interval in minutes', {minimum: 0}),
      },
    },
    Effect.fn('mcp_server.callback')(function* (args) {
      return yield* runOpenVikingAddResourceTool(config, 'add_resource', {
        description: args.description,
        path: args.sourcePath ?? args.path ?? args.source_path,
        tempFileId: args.tempFileId ?? args.temp_file_id,
        to: args.to,
        wait: args.wait,
        watchInterval: args.watchInterval ?? args.watch_interval,
      });
    }),
  );

  server.registerTool(
    'grep',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'Run exact text search in OpenViking. Defaults to your memories subtree when uri is omitted (OpenViking grep requires a scope).',
      inputSchema: {
        caseInsensitive: McpInput.boolean('Case-insensitive search'),
        case_insensitive: McpInput.boolean('Case-insensitive search'),
        nodeLimit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 1000}),
        node_limit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 1000}),
        pattern: McpInput.string('Required text or regex pattern'),
        uri: McpInput.string('Optional viking:// subtree (defaults to your memories root)'),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({
      caseInsensitive,
      case_insensitive,
      nodeLimit,
      node_limit,
      pattern,
      uri,
    }) {
      const checkedPattern = requiredText(pattern, 'grep', 'pattern', {pattern: 'unity-ui-ccc'});
      if (!checkedPattern.ok) {
        return checkedPattern.error;
      }
      const checkedLiteralPattern = rejectLeadingDash(checkedPattern.value, 'grep', 'pattern');
      if (!checkedLiteralPattern.ok) {
        return checkedLiteralPattern.error;
      }
      const checkedUri = optionalVikingUri(uri, 'grep');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return yield* runOpenVikingMcpTool(config, 'grep', {
        case_insensitive: caseInsensitive ?? case_insensitive,
        node_limit: nodeLimit ?? node_limit,
        pattern: checkedLiteralPattern.value,
        uri: checkedUri.value ?? `viking://user/${uriSegment(config.user)}/memories`,
      });
    }),
  );

  server.registerTool(
    'glob',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Run glob file search in OpenViking.',
      inputSchema: {
        nodeLimit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 1000}),
        node_limit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 1000}),
        pattern: McpInput.string('Required glob pattern'),
        uri: McpInput.string('Optional viking:// subtree'),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({nodeLimit, node_limit, pattern, uri}) {
      const checkedPattern = requiredText(pattern, 'glob', 'pattern', {pattern: '**/AGENTS.md'});
      if (!checkedPattern.ok) {
        return checkedPattern.error;
      }
      const checkedLiteralPattern = rejectLeadingDash(checkedPattern.value, 'glob', 'pattern');
      if (!checkedLiteralPattern.ok) {
        return checkedLiteralPattern.error;
      }
      const checkedUri = optionalVikingUri(uri, 'glob');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return yield* runOpenVikingMcpTool(config, 'glob', {
        node_limit: nodeLimit ?? node_limit,
        pattern: checkedLiteralPattern.value,
        uri: checkedUri.value,
      });
    }),
  );

  server.registerTool(
    'health',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Check OpenViking server health through the CLI.',
      inputSchema: {},
    },
    Effect.fn('mcp_server.callback')(function* () {
      return yield* withStaleVersionNotice(yield* runOpenVikingMcpTool(config, 'health', {}));
    }),
  );

  registerOpenVikingParityTools(server, config);

  server.registerTool(
    'share_conflicts',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'List pending shared memory conflicts left by share sync reindex failures. Use this when recall/read/sync reports pending shared memory conflicts. Each result includes a stable id plus exact next-step guidance for show/resolve.',
      inputSchema: {
        team: McpInput.string('Team name; omit to inspect all configured teams'),
      },
    },
    ({team}) => runShareConflictsTool(config, {team}),
  );

  server.registerTool(
    'share_conflict_show',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'Show one pending shared memory conflict, including local OpenViking content vs shared file diff and safe resolution options. The id comes from share_conflicts and has the form team:durable/projects/.../topic.md; a shared viking:// URI also works.',
      inputSchema: {
        id: McpInput.string(
          'Required conflict id from share_conflicts, relative path plus team, or shared viking:// URI',
        ),
        team: McpInput.string('Team name when id is only a relative path'),
      },
    },
    ({id, team}) => {
      const checkedId = requiredText(id, 'share_conflict_show', 'id', {
        id: 'default:durable/projects/foo/bar.md',
      });
      if (!checkedId.ok) {
        return checkedId.error;
      }
      return runShareConflictShowTool(config, checkedId.value, {team});
    },
  );

  server.registerTool(
    'share_conflict_resolve',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        'Resolve one pending shared memory conflict on the user’s behalf after they choose a winner. Use take="shared" to accept the shared git file into OpenViking, take="local" to publish local OpenViking content back to the shared repo, or mergedContent to write explicit merged markdown to both places. Creates a local backup before mutation and clears only the resolved pending entry.',
      inputSchema: {
        dryRun: McpInput.boolean('Preview without writing OpenViking, shared files, git commits, or pending state'),
        id: McpInput.string(
          'Required conflict id from share_conflicts, relative path plus team, or shared viking:// URI',
        ),
        mergedContent: McpInput.string(
          'Explicit merged memory markdown. Mutually exclusive with take. MCP equivalent of CLI --from-file.',
        ),
        message: McpInput.string('Commit message when writing local or merged content to the shared repo'),
        push: McpInput.boolean('Push local/merged resolution commit to remote; defaults to true'),
        take: McpInput.literals(['shared', 'local'], 'Resolution side. Mutually exclusive with mergedContent.'),
        team: McpInput.string('Team name when id is only a relative path'),
      },
    },
    ({dryRun, id, mergedContent, message, push, take, team}) => {
      const checkedId = requiredText(id, 'share_conflict_resolve', 'id', {
        id: 'default:durable/projects/foo/bar.md',
      });
      if (!checkedId.ok) {
        return checkedId.error;
      }
      return runShareConflictResolveTool(config, checkedId.value, {
        dryRun,
        mergedContent,
        message,
        push,
        take,
        team,
      });
    },
  );

  server.registerTool(
    'share_skill',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        "Publish a local Codex/Claude skill or Claude command markdown file into a team's shared artifact catalog. Path inference handles ~/.codex/skills/**/SKILL.md, ~/.claude/skills/**/SKILL.md, and ~/.claude/commands/**/*.md; pass agent/kind/name when sharing from another path. A skill is shared as its whole directory: companion files (scripts, references, assets) beside the SKILL.md travel with it. Default team is used unless team is provided. Pass preview=true to inspect what would land without writing or committing.",
      inputSchema: {
        agent: McpInput.literals(['codex', 'claude'], 'Agent owner when path inference is ambiguous'),
        allowBinary: McpInput.boolean('Include binary skill files (unscannable by the scrubber); blocked by default'),
        force: McpInput.boolean('Replace an existing shared artifact with different content'),
        kind: McpInput.literals(['skill', 'command'], 'Artifact kind when path inference is ambiguous'),
        message: McpInput.string('Commit message override; defaults to "share: publish <path>"'),
        name: McpInput.string('Shared artifact name; defaults to skill directory or command file stem'),
        path: McpInput.string('Required local path to SKILL.md or a Claude command markdown file'),
        preview: McpInput.boolean('Return the bytes that would land in the shared git repo'),
        push: McpInput.boolean('Push to remote after committing; defaults to true'),
        redact: McpInput.boolean(
          'Replace soft-leak matches (local paths) with placeholders and continue; credentials still block.',
        ),
        team: McpInput.string('Team name; defaults to the configured default team'),
      },
    },
    ({agent, allowBinary, force, kind, message, name, path, preview, push, redact, team}) => {
      const checkedPath = requiredText(path, 'share_skill', 'path', {
        path: '~/.codex/skills/example/SKILL.md',
      });
      if (!checkedPath.ok) {
        return checkedPath.error;
      }
      return runShareSkillTool(config, checkedPath.value, {
        agent,
        allowBinary,
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
    'share_bundle',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        "Publish a multi-skill constellation (pack) into a team's shared artifact catalog from a threadnote-bundle.json manifest. Use this when several skills share code that lives outside any single skill directory (e.g. repo-root scripts/lib). The manifest declares name, agent, skills, include paths, external deps, and pathRewrites. Hardcoded repo-root paths are rewritten to a portable token and expanded on install. Pass preview=true to inspect what would land without writing or committing.",
      inputSchema: {
        allowBinary: McpInput.boolean('Include binary files (unscannable by the scrubber); blocked by default'),
        force: McpInput.boolean('Replace existing shared pack files with different content'),
        message: McpInput.string('Commit message override'),
        path: McpInput.string('Required local path to a threadnote-bundle.json manifest'),
        preview: McpInput.boolean('Return what would land in the shared git repo without writing'),
        push: McpInput.boolean('Push to remote after committing; defaults to true'),
        redact: McpInput.boolean(
          'Replace soft-leak matches (local paths) with placeholders and continue; credentials still block.',
        ),
        team: McpInput.string('Team name; defaults to the configured default team'),
      },
    },
    ({allowBinary, force, message, path, preview, push, redact, team}) => {
      const checkedPath = requiredText(path, 'share_bundle', 'path', {
        path: '~/src/reviewer/threadnote-bundle.json',
      });
      if (!checkedPath.ok) {
        return checkedPath.error;
      }
      return runShareBundleTool(config, checkedPath.value, {allowBinary, force, message, preview, push, redact, team});
    },
  );

  server.registerTool(
    'list_shared_skills',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'List shared Codex/Claude skills, Claude commands, and skill packs available in a configured Threadnote team repo, including whether each one is already installed locally.',
      inputSchema: {
        agent: McpInput.literals(['codex', 'claude'], 'Optional agent filter'),
        kind: McpInput.literals(['skill', 'command', 'pack'], 'Optional kind filter'),
        name: McpInput.string('Optional shared artifact name filter'),
        team: McpInput.string('Team name; defaults to the configured default team'),
      },
    },
    ({agent, kind, name, team}) => runListSharedSkillsTool(config, {agent, kind, name, team}),
  );

  server.registerTool(
    'install_shared_skill',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        'Install one shared Codex/Claude skill or Claude command from a configured Threadnote team repo into the local agent skill/command directory. Use list_shared_skills first to find names and disambiguate agent/kind.',
      inputSchema: {
        agent: McpInput.literals(['codex', 'claude'], 'Agent owner; required when name is ambiguous'),
        dryRun: McpInput.boolean('Preview install without writing local files'),
        force: McpInput.boolean('Replace an existing installed artifact with different content'),
        kind: McpInput.literals(['skill', 'command', 'pack'], 'Artifact kind; required when name is ambiguous'),
        name: McpInput.string('Required shared artifact name to install'),
        team: McpInput.string('Team name; defaults to the configured default team'),
      },
    },
    ({agent, dryRun, force, kind, name, team}) => {
      const checkedName = requiredText(name, 'install_shared_skill', 'name', {name: 'reviewer'});
      if (!checkedName.ok) {
        return checkedName.error;
      }
      return runInstallSharedSkillTool(config, checkedName.value, {agent, dryRun, force, kind, team});
    },
  );
}

function registerCandidateMemoryTools(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'review_session_context',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description:
        'After routine durable and handoff writes, form up to three additional reviewable decision, invariant, preference, or handoff candidates. Compares active project/topic memories and persists only a pending review plus audit event; it never creates active memory.',
      inputSchema: {
        callerCwd: McpInput.string('Absolute caller workspace path, used to infer project when project is omitted'),
        decisions: McpInput.stringOrStrings('Decisions worth carrying into later agent sessions'),
        evidence: McpInput.stringOrStrings('Bounded evidence pointers such as files, commits, or session turn IDs'),
        handoff: McpInput.stringOrStrings('Current status, blockers, checks, and next steps'),
        invariants: McpInput.stringOrStrings('Stable constraints or contracts future work must preserve'),
        outcome: McpInput.string('Required concise task outcome'),
        preferences: McpInput.stringOrStrings('User preferences explicitly expressed during this session'),
        project: McpInput.string('Stable project/repo namespace; inferred from callerCwd when omitted'),
        sourceAgentClient: McpInput.string('Originating client, for example codex or claude'),
        sourceCommit: McpInput.string('Optional source commit'),
        sourceSessionId: McpInput.string('Optional source session/thread identifier'),
        task: McpInput.string('Required concise task description'),
        topic: McpInput.string('Stable memory topic; defaults to a slug derived from task'),
      },
    },
    ({
      callerCwd,
      decisions,
      evidence,
      handoff,
      invariants,
      outcome,
      preferences,
      project,
      sourceAgentClient,
      sourceCommit,
      sourceSessionId,
      task,
      topic,
    }) => {
      const checkedTask = requiredText(task, 'review_session_context', 'task', {
        task: 'Improve recall and memory formation',
      });
      if (!checkedTask.ok) {
        return checkedTask.error;
      }
      const checkedOutcome = requiredText(outcome, 'review_session_context', 'outcome', {
        outcome: 'Implemented candidate review workflow',
      });
      if (!checkedOutcome.ok) {
        return checkedOutcome.error;
      }
      return Effect.gen(function* () {
        const candidatePolicy = parseCandidatePolicy((yield* SystemInfo).environment().THREADNOTE_CANDIDATE_POLICY);
        if (candidatePolicy === 'off') {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Session memory suggestions are disabled by THREADNOTE_CANDIDATE_POLICY=off.',
              },
            ],
            structuredContent: {candidates: [], noAction: true},
          };
        }
        const inferredProject =
          normalizeOptionalMetadata(project) ??
          (callerCwd ? yield* resolveWorkspaceRepoName({cwd: callerCwd, includeProcessCwd: false}) : undefined);
        if (!inferredProject) {
          return argumentError(
            'review_session_context requires project or an absolute callerCwd from which the repo can be inferred.',
          );
        }
        const rawCloseout: SessionCloseoutInput = {
          decisions: candidatePolicy === 'handoff-only' ? [] : stringList(decisions),
          evidence: stringList(evidence),
          handoff: stringList(handoff),
          invariants: candidatePolicy === 'handoff-only' ? [] : stringList(invariants),
          outcome: checkedOutcome.value,
          preferences: candidatePolicy === 'handoff-only' ? [] : stringList(preferences),
          project: inferredProject,
          sourceAgentClient: sourceAgentClient?.trim() || 'mcp',
          sourceCommit: normalizeOptionalMetadata(sourceCommit),
          sourceSessionId: normalizeOptionalMetadata(sourceSessionId),
          task: checkedTask.value,
          topic: normalizeOptionalMetadata(topic) ?? uriSegment(checkedTask.value),
        };
        const closeoutSizeError = validateSessionCloseoutInput(rawCloseout);
        if (closeoutSizeError) {
          return argumentError(`Refusing session review: ${closeoutSizeError}`);
        }
        const closeout = scrubSessionCloseout(rawCloseout);
        if (!closeout.ok) {
          return argumentError(closeout.error);
        }
        if (sessionCloseoutHasCandidateMaterial(closeout.input) && !sessionCloseoutHasEvidence(closeout.input)) {
          return argumentError(
            'review_session_context requires at least one evidence pointer, sourceSessionId, or sourceCommit before proposing durable memory.',
          );
        }
        const existing = yield* readActiveProjectMemories(config, closeout.input.project);
        const now = new Date(yield* Clock.currentTimeMillis);
        const review = yield* buildCandidateReview(closeout.input, existing, now);
        yield* saveCandidateReview(config.agentContextHome, review);
        return candidateReviewResult(review);
      }).pipe(
        Effect.catch(error =>
          Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
        ),
      );
    },
  );

  server.registerTool(
    'apply_memory_candidates',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        'Record an explicit user decision for one pending session-memory candidate. approve may create or replace active memory; reject and defer never write memory. Pass the review revision to prevent stale decisions.',
      inputSchema: {
        action: McpInput.literals(['approve', 'defer', 'reject'], 'Explicit user decision for this candidate'),
        approved: McpInput.boolean('Must be true for approve, confirming the user explicitly approved this write'),
        candidateId: McpInput.string('Candidate ID returned by review_session_context'),
        editedText: McpInput.string('Optional user-edited replacement for the proposed memory text'),
        operation: McpInput.literals(
          ['create', 'replace'],
          'Required for replace/manual-review candidates: explicitly create a new memory or replace the reviewed target',
        ),
        replaceUri: McpInput.string(
          'Required with operation=replace; must exactly match the target returned by review_session_context',
        ),
        reviewId: McpInput.string('Review ID returned by review_session_context'),
        revision: McpInput.integer('Review revision returned by review_session_context', {minimum: 1}),
      },
    },
    ({action, approved, candidateId, editedText, operation, replaceUri, reviewId, revision}) => {
      const checkedReviewId = requiredText(reviewId, 'apply_memory_candidates', 'reviewId', {
        reviewId: 'review-0123456789abcdef',
      });
      if (!checkedReviewId.ok) {
        return checkedReviewId.error;
      }
      const checkedCandidateId = requiredText(candidateId, 'apply_memory_candidates', 'candidateId', {
        candidateId: 'review-0123456789abcdef-1',
      });
      if (!checkedCandidateId.ok) {
        return checkedCandidateId.error;
      }
      const checkedReplaceUri = optionalVikingUri(replaceUri, 'apply_memory_candidates');
      if (!checkedReplaceUri.ok) {
        return checkedReplaceUri.error;
      }
      if (!action) {
        return argumentError('apply_memory_candidates requires action: approve, defer, or reject.');
      }
      if (revision === undefined) {
        return argumentError('apply_memory_candidates requires the current review revision.');
      }
      if (action === 'approve' && approved !== true) {
        return argumentError('approve requires approved=true after explicit user approval.');
      }
      return withCandidateReviewLock(
        config.agentContextHome,
        checkedReviewId.value,
        Effect.gen(function* () {
          const review = yield* loadCandidateReview(config.agentContextHome, checkedReviewId.value);
          const candidate = review.candidates.find(item => item.candidateId === checkedCandidateId.value);
          if (!candidate) {
            return argumentError(`Candidate ${checkedCandidateId.value} is not part of ${checkedReviewId.value}.`);
          }
          if (
            action === 'approve' &&
            candidate.state === 'applied' &&
            (review.revision === revision || review.revision === revision + 1)
          ) {
            const memoryMessage = candidate.applyTargetUri ? ` at ${candidate.applyTargetUri}` : '';
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Candidate ${candidate.candidateId} was already approved${memoryMessage}.`,
                },
              ],
              structuredContent: {
                action: candidate.applyTargetUri ? 'approve' : 'no_action',
                candidateId: candidate.candidateId,
                memoryUri: candidate.applyTargetUri,
                reviewId: review.reviewId,
                revision: review.revision,
              },
            };
          }
          if (review.revision !== revision) {
            return argumentError(
              `Candidate review revision changed: expected ${revision}, current ${review.revision}. Review it again before applying.`,
            );
          }
          if (candidate.state === 'applying' && candidate.applyTargetUri) {
            const [appliedRecord] = yield* readMemoryRecordsByUri(config, [candidate?.applyTargetUri as string]);
            if (appliedRecord?.metadata.candidateId === candidate.candidateId) {
              if (
                !candidate.applyContentHash ||
                (yield* sha256Hex(canonicalMemoryDocumentContent(appliedRecord.content))) !== candidate.applyContentHash
              ) {
                return yield* persistCandidateConflict(
                  config,
                  review,
                  candidate,
                  `Candidate ${candidate.candidateId} found mismatched content at ${candidate.applyTargetUri}. The partial apply is recorded as a conflict.`,
                );
              }
              const cleanup = yield* reconcileCandidateReplacementCleanup(config, candidate);
              if (cleanup === 'conflict') {
                return yield* persistCandidateConflict(
                  config,
                  review,
                  candidate,
                  `Candidate ${candidate.candidateId} was written at ${candidate.applyTargetUri}, but its reviewed replacement target changed before cleanup. The partial apply is recorded as a conflict; review both memories before continuing.`,
                );
              }
              if (cleanup === 'pending') {
                const pendingCleanup = candidateReviewWithApplyStage(review, candidate.candidateId, 'cleanup_pending');
                yield* saveCandidateReview(config.agentContextHome, pendingCleanup);
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `Candidate ${candidate.candidateId} is stored at ${candidate.applyTargetUri}, but its reviewed replacement still exists. Retry this approval to finish cleanup.`,
                    },
                  ],
                  isError: true,
                  structuredContent: {
                    action: 'cleanup_pending',
                    candidateId: candidate.candidateId,
                    memoryUri: candidate.applyTargetUri,
                    reviewId: review.reviewId,
                    revision: review.revision,
                  },
                };
              }
              const withBeginAudit = candidateReviewWithAuditEvent(review, {
                action: 'begin_apply',
                at: appliedRecord.metadata.timestamp,
                candidateId: candidate.candidateId,
                memoryUri: candidate.applyTargetUri,
                reviewId: review.reviewId,
                revision: review.revision,
              });
              const recovered = candidateReviewWithState(withBeginAudit, candidate.candidateId, 'applied', {
                action: 'apply',
                at: appliedRecord.metadata.timestamp,
                memoryUri: candidate.applyTargetUri,
              });
              yield* saveCandidateReview(config.agentContextHome, recovered);
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Recovered approved candidate ${candidate.candidateId} at ${candidate.applyTargetUri}.`,
                  },
                ],
                structuredContent: {
                  action: 'approve',
                  candidateId: candidate.candidateId,
                  memoryUri: candidate.applyTargetUri,
                  reviewId: review.reviewId,
                  revision: recovered.revision,
                },
              };
            }
          }
          if (candidate.state === 'applied' || candidate.state === 'conflict' || candidate.state === 'rejected') {
            return argumentError(`Candidate ${candidate.candidateId} is already ${candidate.state}.`);
          }
          const at = new Date(yield* Clock.currentTimeMillis).toISOString();
          if (action === 'defer' || action === 'reject') {
            if (candidate.state === 'applying') {
              return argumentError(
                `Candidate ${candidate.candidateId} has an interrupted approval in progress. Retry approve to recover it before recording another decision.`,
              );
            }
            if (action === 'defer' && candidate.state === 'deferred') {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Candidate ${candidate.candidateId} is already deferred in review ${review.reviewId}.`,
                  },
                ],
                structuredContent: {
                  action,
                  candidateId: candidate.candidateId,
                  reviewId: review.reviewId,
                  revision: review.revision,
                },
              };
            }
            const updated = candidateReviewWithState(
              review,
              candidate.candidateId,
              action === 'defer' ? 'deferred' : 'rejected',
              {action, at},
            );
            yield* saveCandidateReview(config.agentContextHome, updated);
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    action === 'defer'
                      ? `Deferred candidate ${candidate.candidateId}. It remains available in review ${review.reviewId}.`
                      : `Rejected candidate ${candidate.candidateId}. No memory was written.`,
                },
              ],
              structuredContent: {
                action,
                candidateId: candidate.candidateId,
                reviewId: review.reviewId,
                revision: updated.revision,
              },
            };
          }
          if (candidate.recommendation === 'no_action') {
            if (!(yield* reviewedCandidateTargetIsCurrent(config, candidate))) {
              return argumentError(
                `Duplicate candidate ${candidate.candidateId} is stale because its reviewed target changed or disappeared. Run review_session_context again.`,
              );
            }
            const updated = candidateReviewWithState(review, candidate.candidateId, 'applied', {
              action: 'apply',
              at,
            });
            yield* saveCandidateReview(config.agentContextHome, updated);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Confirmed no action for duplicate candidate ${candidate.candidateId}. No memory was written.`,
                },
              ],
              structuredContent: {
                action: 'no_action',
                candidateId: candidate.candidateId,
                reviewId: review.reviewId,
                revision: updated.revision,
              },
            };
          }
          const text = normalizeOptionalMetadata(editedText) ?? candidate.proposedText;
          const scrub = applyScrubber(text, {redact: true});
          if (scrub.blocker) {
            return argumentError(
              `Refusing to store candidate ${candidate.candidateId}: possible ${scrub.blocker}. Remove the sensitive value first.`,
            );
          }
          const reviewedTargetUri = candidate.targetUri;
          const effectiveOperation = operation ?? candidate.applyOperation;
          const effectiveReplaceUri = checkedReplaceUri.value ?? candidate.applyReplaceUri;
          const requiresExplicitOperation =
            candidate.recommendation === 'replace' || candidate.recommendation === 'manual_review';
          if (requiresExplicitOperation && effectiveOperation === undefined) {
            return argumentError(
              `Candidate ${candidate.candidateId} requires an explicit operation: create or replace.`,
            );
          }
          if (candidate.applyOperation && operation && operation !== candidate.applyOperation) {
            return argumentError(
              `Candidate ${candidate.candidateId} is recovering an approved ${candidate.applyOperation} operation; the retry cannot change it to ${operation}.`,
            );
          }
          if (
            candidate.applyReplaceUri &&
            checkedReplaceUri.value &&
            checkedReplaceUri.value !== candidate.applyReplaceUri
          ) {
            return argumentError(
              `Candidate ${candidate.candidateId} is recovering approved target ${candidate.applyReplaceUri}; the retry cannot change it.`,
            );
          }
          const reviewedTargetIsShared = reviewedTargetUri !== undefined && isSharedMemoryUri(reviewedTargetUri);
          if (
            effectiveOperation === 'create' &&
            !reviewedTargetIsShared &&
            (candidate.recommendation === 'replace' || candidate.comparison === 'contradiction')
          ) {
            return argumentError(
              `Candidate ${candidate.candidateId} has the same stable identity as active memory and cannot be created separately; choose operation=replace with its reviewed target.`,
            );
          }
          if (effectiveOperation === 'replace' && reviewedTargetUri === undefined) {
            return argumentError(`Candidate ${candidate.candidateId} has no reviewed replacement target.`);
          }
          if (
            effectiveOperation === 'replace' &&
            (effectiveReplaceUri === undefined || effectiveReplaceUri !== reviewedTargetUri)
          ) {
            return argumentError(
              `Candidate ${candidate.candidateId} requires replaceUri=${reviewedTargetUri} for the reviewed replacement.`,
            );
          }
          if (effectiveOperation !== 'replace' && effectiveReplaceUri !== undefined) {
            return argumentError(`Candidate ${candidate.candidateId} cannot use replaceUri without operation=replace.`);
          }
          const targetUri = effectiveOperation === 'replace' ? reviewedTargetUri : undefined;
          if (targetUri && isSharedMemoryUri(targetUri)) {
            return argumentError(
              `Candidate ${candidate.candidateId} targets shared memory. Choose operation=create to store the reviewed candidate personally without overwriting the shared source.`,
            );
          }
          if (targetUri) {
            if (!candidate.targetContentHash) {
              return argumentError(`Candidate ${candidate.candidateId} has no reviewed content hash for ${targetUri}.`);
            }
          }
          const approvedOperation: CandidateApplyOperation = effectiveOperation ?? 'create';
          const approvedAt = candidate.applyApprovedAt ?? at;
          const metadata = approvedCandidateMetadata(review, candidate, approvedAt);
          const writeParams: WriteDurableMemoryParams = {
            bodyText: scrub.cleaned,
            expectedReplaceContentHash: targetUri ? candidate.targetContentHash : undefined,
            metadata,
            operation: approvedOperation,
            replaceUri: targetUri,
          };
          const preparedWrite = yield* preparePersonalMemoryWrite(config, writeParams);
          const intendedMemoryUri = preparedWrite.memoryUri;
          const approvedContentHash = yield* sha256Hex(canonicalMemoryDocumentContent(preparedWrite.memory));
          if (candidate.applyContentHash && candidate.applyContentHash !== approvedContentHash) {
            return argumentError(
              `Candidate ${candidate.candidateId} retry does not match the previously approved content. Retry with the same editedText or start a new review.`,
            );
          }
          const applying =
            candidate.state === 'applying'
              ? review
              : candidateReviewWithApplying(
                  review,
                  candidate.candidateId,
                  {
                    contentHash: approvedContentHash,
                    operation: approvedOperation,
                    replaceUri: targetUri,
                    targetUri: intendedMemoryUri,
                  },
                  approvedAt,
                );
          if (candidate.state !== 'applying') {
            yield* saveCandidateReview(config.agentContextHome, applying);
          }
          const result = yield* writeDurableMemory(config, {
            ...writeParams,
            prepared: preparedWrite,
          });
          if (result.isError === true) {
            const resultText = textFromCallToolResult(result);
            if (resultText.includes('Candidate replacement is stale')) {
              return yield* persistCandidateConflict(
                config,
                applying,
                applying.candidates.find(item => item.candidateId === candidate?.candidateId) ?? candidate,
                `${resultText} The approval is recorded as a conflict; start a new review against the current target.`,
              );
            }
            const [possiblyWritten] = yield* readMemoryRecordsByUri(config, [intendedMemoryUri]);
            const destinationCanConflict = approvedOperation === 'create' || intendedMemoryUri !== targetUri;
            if (
              (destinationCanConflict &&
                possiblyWritten &&
                possiblyWritten.metadata.candidateId !== candidate.candidateId) ||
              resultText.includes('Create conflict')
            ) {
              return yield* persistCandidateConflict(
                config,
                applying,
                applying.candidates.find(item => item.candidateId === candidate?.candidateId) ?? candidate,
                `Candidate ${candidate.candidateId} could not be created because ${intendedMemoryUri} contains another memory. The apply is recorded as a conflict.`,
              );
            }
            return result;
          }
          if (replacementCleanupIsPending(result)) {
            const pendingCleanup = candidateReviewWithApplyStage(applying, candidate.candidateId, 'cleanup_pending');
            yield* saveCandidateReview(config.agentContextHome, pendingCleanup);
            return {
              ...result,
              isError: true,
              structuredContent: {
                action: 'cleanup_pending',
                candidateId: candidate.candidateId,
                memoryUri: intendedMemoryUri,
                reviewId: review.reviewId,
                revision: review.revision,
              },
            };
          }
          const memoryUri = storedMemoryUri(result) ?? intendedMemoryUri;
          const updated = candidateReviewWithState(applying, candidate.candidateId, 'applied', {
            action: 'apply',
            at,
            memoryUri,
          });
          yield* saveCandidateReview(config.agentContextHome, updated);
          return {
            ...result,
            structuredContent: {
              action: 'approve',
              candidateId: candidate.candidateId,
              memoryUri,
              reviewId: review.reviewId,
              revision: updated.revision,
            },
          };
        }),
      ).pipe(
        Effect.catch(error =>
          Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
        ),
      );
    },
  );
}

function registerOpenVikingParityTools(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'ov_search',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP search parity. Unlike search/recall_context, this does not enrich the query.',
      inputSchema: {
        contextType: McpInput.literals(['resource', 'memory', 'skill'], 'Optional native context-type filter'),
        context_type: McpInput.literals(['resource', 'memory', 'skill'], 'Optional native context-type filter'),
        limit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 1000}),
        minScore: McpInput.number('Minimum score threshold', {minimum: 0, maximum: 1}),
        min_score: McpInput.number('Minimum score threshold', {minimum: 0, maximum: 1}),
        query: McpInput.string('Required search query'),
        sessionId: McpInput.string('Optional native session id'),
        session_id: McpInput.string('Optional native session id'),
        targetUri: McpInput.string('Optional target viking:// subtree'),
        target_uri: McpInput.string('Optional target viking:// subtree'),
        uri: McpInput.string('Compatibility alias for target_uri'),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({
      contextType,
      context_type,
      limit,
      minScore,
      min_score,
      query,
      sessionId,
      session_id,
      targetUri,
      target_uri,
      uri,
    }) {
      const checkedQuery = requiredText(query, 'ov_search', 'query', {query: 'current repo release notes'});
      if (!checkedQuery.ok) {
        return checkedQuery.error;
      }
      const checkedUri = optionalVikingUri(targetUri ?? target_uri ?? uri, 'ov_search');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      const normalizedSessionId = (sessionId ?? session_id)?.trim();
      return yield* runOpenVikingMcpTool(config, 'search', {
        context_type: contextType ?? context_type,
        limit,
        min_score: minScore ?? min_score,
        query: checkedQuery.value,
        session_id: normalizedSessionId || undefined,
        target_uri: checkedUri.value,
      });
    }),
  );

  server.registerTool(
    'ov_read',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'Raw OpenViking MCP read parity. Reads one or more viking:// URIs without Threadnote shared-memory sync.',
      inputSchema: {
        uri: McpInput.string('Single viking:// URI'),
        uris: McpInput.stringOrStrings('Single viking:// URI or array of URIs'),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({uri, uris}) {
      const checkedUris = requiredVikingUriList(
        uris ?? uri,
        'ov_read',
        'viking://resources/repos/threadnote/README.md',
      );
      if (!checkedUris.ok) {
        return checkedUris.error;
      }
      return yield* runOpenVikingReadTool(config, checkedUris.value);
    }),
  );

  server.registerTool(
    'ov_list',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP list parity.',
      inputSchema: {
        all: McpInput.boolean('Show hidden files like .abstract.md and .overview.md'),
        nodeLimit: McpInput.integer('Maximum node count', {minimum: 1, maximum: 1000}),
        node_limit: McpInput.integer('Maximum node count', {minimum: 1, maximum: 1000}),
        recursive: McpInput.boolean('List recursively'),
        simple: McpInput.boolean('Only return paths'),
        uri: McpInput.string('Optional viking:// directory URI; defaults to viking://'),
      },
    },
    ({recursive, uri}) => {
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
        description: McpInput.string('Optional import reason/description'),
        path: McpInput.string('Local source file/directory or URL'),
        sourcePath: McpInput.string('Compatibility alias for path'),
        source_path: McpInput.string('Compatibility alias for path'),
        tempFileId: McpInput.string('Native progressive upload temp file id'),
        temp_file_id: McpInput.string('Native progressive upload temp file id'),
        to: McpInput.string('Optional destination viking:// URI'),
        wait: McpInput.boolean('Wait for processing to finish'),
        watchInterval: McpInput.integer('Watch interval in minutes', {minimum: 0}),
        watch_interval: McpInput.integer('Watch interval in minutes', {minimum: 0}),
      },
    },
    Effect.fn('mcp_server.callback')(function* (args) {
      return yield* runOpenVikingAddResourceTool(config, 'ov_add_resource', {
        description: args.description,
        path: args.path ?? args.sourcePath ?? args.source_path,
        tempFileId: args.tempFileId ?? args.temp_file_id,
        to: args.to,
        wait: args.wait,
        watchInterval: args.watchInterval ?? args.watch_interval,
      });
    }),
  );

  server.registerTool(
    'ov_list_watches',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP list_watches parity.',
      inputSchema: {
        activeOnly: McpInput.boolean('Only show active watch tasks'),
        active_only: McpInput.boolean('Only show active watch tasks'),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({activeOnly, active_only}) {
      return yield* runOpenVikingMcpTool(config, 'list_watches', {active_only: activeOnly ?? active_only});
    }),
  );

  server.registerTool(
    'ov_cancel_watch',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: 'Raw OpenViking MCP cancel_watch parity. Accepts to_uri, toUri, or uri.',
      inputSchema: {
        toUri: McpInput.string('Watch target viking:// URI'),
        to_uri: McpInput.string('Watch target viking:// URI'),
        uri: McpInput.string('Compatibility alias for to_uri'),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({toUri, to_uri, uri}) {
      const checkedUri = requiredVikingUri(
        toUri ?? to_uri ?? uri,
        'ov_cancel_watch',
        'viking://resources/repos/threadnote',
      );
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return yield* runOpenVikingMcpTool(config, 'cancel_watch', {to_uri: checkedUri.value});
    }),
  );

  server.registerTool(
    'ov_grep',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP grep parity.',
      inputSchema: {
        caseInsensitive: McpInput.boolean('Case-insensitive search'),
        case_insensitive: McpInput.boolean('Case-insensitive search'),
        nodeLimit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 1000}),
        node_limit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 1000}),
        pattern: McpInput.string('Required regex pattern'),
        uri: McpInput.string('Optional viking:// subtree'),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({
      caseInsensitive,
      case_insensitive,
      nodeLimit,
      node_limit,
      pattern,
      uri,
    }) {
      const checkedPattern = requiredText(pattern, 'ov_grep', 'pattern', {pattern: 'threadnote'});
      if (!checkedPattern.ok) {
        return checkedPattern.error;
      }
      const checkedLiteralPattern = rejectLeadingDash(checkedPattern.value, 'ov_grep', 'pattern');
      if (!checkedLiteralPattern.ok) {
        return checkedLiteralPattern.error;
      }
      const checkedUri = optionalVikingUri(uri, 'ov_grep');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return yield* runOpenVikingMcpTool(config, 'grep', {
        case_insensitive: caseInsensitive ?? case_insensitive,
        node_limit: nodeLimit ?? node_limit,
        pattern: checkedLiteralPattern.value,
        uri: checkedUri.value,
      });
    }),
  );

  server.registerTool(
    'ov_glob',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP glob parity.',
      inputSchema: {
        nodeLimit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 1000}),
        node_limit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 1000}),
        pattern: McpInput.string('Required glob pattern'),
        uri: McpInput.string('Optional viking:// subtree'),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({nodeLimit, node_limit, pattern, uri}) {
      const checkedPattern = requiredText(pattern, 'ov_glob', 'pattern', {pattern: '**/AGENTS.md'});
      if (!checkedPattern.ok) {
        return checkedPattern.error;
      }
      const checkedLiteralPattern = rejectLeadingDash(checkedPattern.value, 'ov_glob', 'pattern');
      if (!checkedLiteralPattern.ok) {
        return checkedLiteralPattern.error;
      }
      const checkedUri = optionalVikingUri(uri, 'ov_glob');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return yield* runOpenVikingMcpTool(config, 'glob', {
        node_limit: nodeLimit ?? node_limit,
        pattern: checkedLiteralPattern.value,
        uri: checkedUri.value,
      });
    }),
  );

  server.registerTool(
    'ov_forget',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: 'Raw OpenViking MCP forget parity.',
      inputSchema: {
        recursive: McpInput.boolean('Remove a directory recursively'),
        uri: McpInput.string('Required viking:// URI to remove'),
      },
    },
    ({recursive, uri}) => {
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
        uri: McpInput.string('Required viking:// file URI'),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({uri}) {
      const checkedUri = requiredVikingUri(
        uri,
        'ov_code_outline',
        'viking://resources/repos/threadnote/src/mcp_server.ts',
      );
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return yield* runOpenVikingMcpTool(config, 'code_outline', {uri: checkedUri.value});
    }),
  );

  server.registerTool(
    'ov_code_search',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP code_search parity. Requires a query and viking:// directory URI.',
      inputSchema: {
        query: McpInput.string('Required symbol-name substring'),
        uri: McpInput.string('Required viking:// directory URI'),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({query, uri}) {
      const checkedQuery = requiredText(query, 'ov_code_search', 'query', {query: 'registerTools'});
      if (!checkedQuery.ok) {
        return checkedQuery.error;
      }
      const checkedUri = requiredVikingUri(uri, 'ov_code_search', 'viking://resources/repos/threadnote/src');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return yield* runOpenVikingMcpTool(config, 'code_search', {
        query: checkedQuery.value,
        uri: checkedUri.value,
      });
    }),
  );

  server.registerTool(
    'ov_code_expand',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP code_expand parity. Requires a viking:// file URI and symbol.',
      inputSchema: {
        symbol: McpInput.string('Required symbol name, e.g. bar or Foo.bar'),
        uri: McpInput.string('Required viking:// file URI'),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({symbol, uri}) {
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
      return yield* runOpenVikingMcpTool(config, 'code_expand', {
        symbol: checkedSymbol.value,
        uri: checkedUri.value,
      });
    }),
  );

  server.registerTool(
    'ov_health',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Raw OpenViking MCP health parity.',
      inputSchema: {},
    },
    Effect.fn('mcp_server.callback')(function* () {
      return yield* runOpenVikingMcpTool(config, 'health', {});
    }),
  );
}

function registerOpenVikingStoreTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: 'ov_remember' | 'ov_store',
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: `Raw OpenViking MCP ${name === 'ov_remember' ? 'remember' : 'store'} parity. Stores message(s) through ov add-memory.`,
      inputSchema: {
        content: McpInput.string('Compatibility shortcut for a single user message'),
        messages: McpInput.messages('Native messages array of {role, content}'),
        text: McpInput.string('Compatibility shortcut for a single user message'),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({content, messages, text}) {
      if (messages && messages.length > 0) {
        return yield* runOpenVikingMcpTool(config, 'remember', {messages});
      }
      const checkedContent = requiredText(content ?? text, name, 'content', {content: 'Remember this note'});
      if (!checkedContent.ok) {
        return checkedContent.error;
      }
      return yield* runOpenVikingMcpTool(config, 'remember', {
        messages: [{content: checkedContent.value, role: 'user'}],
      });
    }),
  );
}

function registerSearchTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: string,
  description: string,
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description,
      inputSchema: {
        query: McpInput.string('Required search query, for example "unity-ui-ccc latest handoff"'),
        uri: McpInput.string('Optional viking:// subtree to search'),
        callerCwd: McpInput.string(
          'Optional absolute caller workspace path used to resolve this/current branch queries',
        ),
        nodeLimit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 100}),
        includeArchived: McpInput.boolean('Include archived memories in recall results'),
        threshold: McpInput.number(
          'Minimum relevance score 0-1 (default 0.5); lower it (toward 0) to broaden when a recall comes back empty',
          {minimum: 0, maximum: 1},
        ),
        workset: McpInput.string(
          'Optional named workset (a set of related repos from the seed manifest) to recall across as one working set',
        ),
      },
    },
    ({callerCwd, includeArchived, nodeLimit, query, threshold, uri, workset}) => {
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
        workset: workset?.trim() || undefined,
      }).pipe(
        Effect.flatMap(withStaleVersionNotice),
        Effect.catch(error =>
          Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
        ),
      );
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
  readonly workset: string | undefined;
}

function runRecallTool(config: RuntimeConfig, params: RecallToolParams) {
  return Effect.gen(function* () {
    const syncWarnings: string[] = [];
    const syncedTeams = yield* syncSharedReposBeforeAgentRead(config).pipe(
      Effect.map(syncResult => {
        syncWarnings.push(...syncResult.warnings);
        return syncResult.syncedTeams;
      }),
      Effect.catch(error => {
        syncWarnings.push(errorMessage(error));
        return Effect.succeed([] as readonly string[]);
      }),
    );
    const query = yield* enrichRecallQueryWithWorkspaceContext(params.query, {
      cwd: params.callerCwd,
      includeProcessCwd: false,
    });
    const projectQuery = yield* enrichRecallQueryWithWorkspaceProjectContext(params.query, {
      cwd: params.callerCwd,
      includeProcessCwd: false,
    });
    const indexRepairMessages = yield* Effect.gen(function* () {
      const ov = yield* requiredOpenVikingCli();
      const indexRepair = yield* repairStaleRecallIndex(config, ov, {query: projectQuery});
      return formatRecallIndexRepairMessages(indexRepair);
    }).pipe(Effect.catch(error => Effect.succeed([`Auto-index repair warning: ${errorMessage(error)}`])));
    const queryProject = params.pinnedUri ? undefined : yield* inferProjectFromQuery(config.manifestPath, params.query);
    const project =
      queryProject ?? (params.pinnedUri ? undefined : yield* inferProjectFromQuery(config.manifestPath, projectQuery));
    const projectMemoryName = params.pinnedUri
      ? undefined
      : yield* resolveWorkspaceRepoName({cwd: params.callerCwd, includeProcessCwd: false});
    const recallProjectName = project?.name ?? projectMemoryName;
    const limitArgs = params.nodeLimit ? ['--node-limit', String(params.nodeLimit)] : [];
    const threshold = params.threshold ?? (yield* recallScoreThreshold());
    const explicitWorkset = params.workset ? yield* requireWorkset(config.manifestPath, params.workset) : undefined;
    const pinnedArgs = params.pinnedUri ? ['--uri', params.pinnedUri] : [];
    const base = yield* recallSearchHits(
      config,
      ['search', query, ...pinnedArgs, ...limitArgs],
      threshold,
      params.includeArchived,
    );
    const searchedScopes: Array<string | undefined> = [params.pinnedUri];
    const passes: Array<readonly RecallHit[]> = [base.hits];
    const scopedRecallUris = new Set([params.pinnedUri].filter((uri): uri is string => uri !== undefined));
    for (const scope of projectMemoryScopeUris(config, recallProjectName, params.includeArchived)) {
      if (!scopedRecallUris.has(scope)) {
        scopedRecallUris.add(scope);
        searchedScopes.push(scope);
        const projectMemoryPass = yield* recallSearchHits(
          config,
          ['search', query, '--uri', scope, ...limitArgs],
          threshold,
          params.includeArchived,
        );
        passes.push(projectMemoryPass.hits);
      }
    }
    const seededUri = project ? trimTrailingSlash(project.uri) : undefined;
    if (seededUri?.startsWith('viking://') && seededUri !== params.pinnedUri) {
      searchedScopes.push(seededUri);
      const seeded = yield* recallSearchHits(
        config,
        ['search', params.query, '--uri', seededUri, ...limitArgs],
        threshold,
        params.includeArchived,
      );
      passes.push(seeded.hits);
    }

    const sections: string[] = [];
    const workset = params.pinnedUri
      ? undefined
      : explicitWorkset
        ? explicitWorkset
        : yield* inferWorksetFromQuery(config.manifestPath, projectQuery);
    if (workset && workset.projects.length > 0) {
      sections.push(`Workset scope: ${workset.name} (${workset.projects.map(member => member.name).join(', ')})`);
      const alreadyScoped = new Set(
        [params.pinnedUri, seededUri, ...scopedRecallUris].filter((uri): uri is string => uri !== undefined),
      );
      const worksetScopes = worksetScopeUris(config, workset)
        .filter(uri => !alreadyScoped.has(uri))
        .slice(0, MAX_WORKSET_PASSES);
      for (const scope of worksetScopes) {
        searchedScopes.push(scope);
        const worksetPass = yield* recallSearchHits(
          config,
          ['search', query, '--uri', scope, ...limitArgs],
          threshold,
          params.includeArchived,
        );
        passes.push(worksetPass.hits);
      }
    }

    const exactMatches = yield* collectExactMemoryMatches(config, query, params.includeArchived, project);
    const environment = (yield* SystemInfo).environment();
    const effectAiResult = yield* resolveEffectAiConfiguration(config, environment).pipe(Effect.result);
    const effectAi = Result.isSuccess(effectAiResult) ? effectAiResult.success : undefined;
    if (Result.isFailure(effectAiResult)) {
      sections.push(
        `Local AI recall unavailable: ${errorMessage(effectAiResult.failure)}. Deterministic recall continued.`,
      );
    }
    let hybridMinimumScore = recallHybridMinimumScore(Number(threshold), params.threshold !== undefined);
    const expansionQueries: string[] = [];
    const prepareSections = (candidateUris?: readonly string[]) =>
      prepareRecallSections(config, {
        allowExactRescue: params.threshold === undefined,
        allowedUriScopes: params.pinnedUri ? [params.pinnedUri] : undefined,
        candidateUris,
        exactMatches,
        feedbackQuery: params.query,
        includeInactive: params.includeArchived,
        limit: params.nodeLimit ?? 12,
        minimumScore: hybridMinimumScore,
        passes,
        project: recallProjectName,
        query,
        queryVariants: expansionQueries,
        readRecords: uris => readMemoryRecordsByUri(config, uris),
        seedUris: [params.pinnedUri, seededUri].filter((uri): uri is string => uri !== undefined),
      });
    let recallSections = yield* prepareSections();
    const shouldAttemptAiExpansion =
      localRecallAiEnabled(effectAi?.configuration) && shouldExpandRecall(recallSections.confidence);
    const indexSelectionCandidates = shouldAttemptAiExpansion
      ? buildRecallIndexSelectionCandidates(recallSections.expansionCandidates, recallProjectName, 24)
      : [];
    const indexSelectionIds =
      indexSelectionCandidates.length > 0
        ? yield* selectExpandedRecallCandidatesEffect(
            {candidates: indexSelectionCandidates, query: params.query},
            config,
            effectAi,
          )
        : undefined;
    const groundedExpansionQueries =
      indexSelectionIds && indexSelectionIds.length > 0
        ? limitRecallRewritesForConfidence(
            recallSections.confidence,
            recallSelectionQueries(
              indexSelectionCandidates,
              recallSections.expansionCandidates,
              indexSelectionIds,
              params.query,
              2,
            ),
          )
        : [];
    const needsFallbackExpansion =
      shouldExpandRecall(recallSections.confidence) &&
      groundedExpansionQueries.length < recallRewriteLimitForConfidence(recallSections.confidence);
    const expansionVocabulary =
      needsFallbackExpansion &&
      localRecallAiEnabled(effectAi?.configuration) &&
      shouldExpandRecall(recallSections.confidence)
        ? yield* loadRecallExpansionVocabulary(config, {
            allowedUriScopes: params.pinnedUri ? [params.pinnedUri] : undefined,
            includeInactive: params.includeArchived,
            project: recallProjectName,
            rankedCandidates: recallSections.expansionCandidates,
          }).pipe(Effect.catch(() => Effect.succeed([])))
        : [];
    const fallbackExpansionQueries = needsFallbackExpansion
      ? yield* expandWeakRecallQueryEffect(
          {
            confidence: recallSections.confidence,
            project: recallProjectName,
            query: params.query,
            vocabulary: expansionVocabulary,
          },
          config,
          effectAi,
        )
      : [];
    const proposedExpansionQueries = mergeRecallRewritesForConfidence(
      recallSections.confidence,
      groundedExpansionQueries,
      fallbackExpansionQueries,
    );
    for (const expansionQuery of proposedExpansionQueries) {
      expansionQueries.push(expansionQuery);
      for (const scope of boundedRecallExpansionScopes(searchedScopes)) {
        const expansionPass = yield* recallSearchHits(
          config,
          ['search', expansionQuery, ...(scope ? ['--uri', scope] : []), ...limitArgs],
          threshold,
          params.includeArchived,
        );
        passes.push(expansionPass.hits);
      }
      hybridMinimumScore = recallHybridMinimumScore(Number(threshold), params.threshold !== undefined);
      recallSections = yield* prepareSections();
    }
    if (expansionQueries.length > 0) {
      sections.push(`Recall query expansion: evaluated ${expansionQueries.length} model rewrite(s).`);
      const selectionCandidates = buildRecallSelectionCandidates(
        recallSections.ranked,
        recallSections.expansionCandidates,
        Math.max(params.nodeLimit ?? 12, 12) * 2,
      );
      const selectedIds = yield* selectExpandedRecallCandidatesEffect(
        {candidates: selectionCandidates, query: params.query},
        config,
        effectAi,
      );
      if (selectedIds !== undefined) {
        const selectedUris = selectedRecallCandidateUris(
          selectionCandidates,
          selectedIds,
          recallSelectionAnchorIds(selectionCandidates, recallSections.ranked),
        );
        recallSections = yield* prepareSections(selectedUris);
        sections.push(
          `Recall local AI post-filter: kept ${selectedUris.length} of ${selectionCandidates.length} candidate(s).`,
        );
      }
    }
    const {semanticSection, exactTail} = recallSections;
    if (semanticSection) {
      sections.push(semanticSection);
    } else if (!base.ok) {
      sections.push(`Recall semantic search unavailable: ${base.errorText || 'ov search failed'}`);
    }
    if (indexRepairMessages.length > 0) {
      sections.push(indexRepairMessages.join('\n'));
    }
    if (exactTail) {
      sections.push(exactTail);
    }
    const referencedContext = yield* referencedContextSection(config, semanticSection ?? '');
    if (referencedContext) {
      sections.push(referencedContext);
    }
    const hygieneHints = yield* recallHygieneHintsSection(config, semanticSection ?? '');
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
      return {content: [{type: 'text' as const, text: 'No recall results found.'}]};
    }
    const onlyErrorNote = !base.ok && !semanticSection && sections.length === 1;
    return {
      content: [{type: 'text' as const, text: sections.join('\n\n')}],
      isError: onlyErrorNote || undefined,
      structuredContent: {
        confidence: recallSections.confidence,
        queryExpansions: expansionQueries,
        rankerVersion: RECALL_RANKER_VERSION,
        results: recallSections.ranked.slice(0, params.nodeLimit ?? 12).map(hit => ({
          category: hit.category,
          finalScore: hit.finalScore,
          reasons: hit.rankReasons,
          signals: hit.rankSignals,
          uri: hit.uri,
          warnings: hit.rankWarnings,
        })),
      },
    };
  });
}

/**
 * Run one recall search pass with `--output json` via the ov CLI and return
 * parsed hits, falling back to a plain search (no --threshold/--level) on a
 * non-zero exit so an older ov does not fail the recall.
 */
const recallSearchHits = Effect.fn('mcp_server.recallSearchHits')(function* (
  config: RuntimeConfig,
  searchArgs: readonly string[],
  threshold: string,
  includeArchived: boolean,
) {
  let result = yield* runOpenVikingTool(config, [
    ...searchArgs,
    '--threshold',
    threshold,
    '--level',
    '2',
    '--output',
    'json',
  ]);
  if (result.isError === true) {
    result = yield* runOpenVikingTool(config, [...searchArgs, '--output', 'json']);
  }
  const firstContent = result.content[0];
  const text = firstContent?.type === 'text' ? firstContent.text : '';
  if (result.isError === true) {
    return {errorText: text.trim(), hits: [], ok: false};
  }
  return {errorText: '', hits: parseRecallHits(text, {includeArchived}), ok: true};
});

const recallHygieneHintsSection = Effect.fn('mcpServer.recallHygieneHints')(function* (
  config: RuntimeConfig,
  recallText: string,
) {
  const uris = activePersonalMemoryUrisFromText(recallText, config.user);
  if (uris.length === 0) {
    return undefined;
  }
  const records = yield* readMemoryRecordsByUri(config, uris);
  const nudges = recallHygieneNudges(recallText, {records, user: config.user});
  return nudges.length > 0 ? ['Memory hygiene hints:', ...nudges.map(nudge => `- ${nudge}`)].join('\n') : undefined;
});

const MAX_REFERENCED_CONTEXT = 5;

/**
 * Resolves the one-way `references:` pointers carried by the personal memories
 * recall just surfaced and appends bounded URI-only pointers. The caller can
 * explicitly read a relevant pointer without recall inlining unrelated text.
 */
const referencedContextSection = Effect.fn('mcpServer.referencedContext')(function* (
  config: RuntimeConfig,
  recallText: string,
) {
  const surfacedUris = activePersonalMemoryUrisFromText(recallText, config.user);
  if (surfacedUris.length === 0) {
    return undefined;
  }
  const surfaced = yield* readMemoryRecordsByUri(config, surfacedUris);
  const referenced = referencedUrisFromRecords(surfaced, recallText);
  if (referenced.length === 0) {
    return undefined;
  }
  return formatReferencedContextPointers(referenced, MAX_REFERENCED_CONTEXT);
});

const collectExactMemoryMatches = Effect.fn('mcp_server.collectExactMemoryMatches')(function* (
  config: RuntimeConfig,
  query: string,
  includeArchived: boolean,
  project: ProjectManifest | undefined,
) {
  const terms = exactRecallTerms(query);
  if (terms.length === 0) {
    return [];
  }
  const ov = yield* requiredOpenVikingCli();
  const scopes = exactMemoryScopes(config, includeArchived, query, project);
  return yield* collectExactMatches(
    terms,
    scopes,
    Effect.fn('mcp_server.callback')(function* (term, scope) {
      const result = yield* runCommand(
        ov,
        withIdentity(config, ['grep', term, '--uri', scope, '--node-limit', '5', '--output', 'json']),
        {allowFailure: true},
      );
      return result.exitCode === 0 ? result.stdout : undefined;
    }),
  );
});

function registerReadTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: string,
  description: string,
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: `${description} Required: pass JSON arguments with uri, or native OpenViking uris.`,
      inputSchema: {
        uri: McpInput.string('Required viking:// file URI'),
        uris: McpInput.stringOrStrings('Native OpenViking MCP read input: a single viking:// URI or array of URIs'),
      },
    },
    ({uri, uris}) => {
      const checkedUris = requiredVikingUriList(uris ?? uri, name, 'viking://user/you/memories/.abstract.md');
      if (!checkedUris.ok) {
        return checkedUris.error;
      }
      return Effect.gen(function* () {
        const syncWarnings: string[] = [];
        const syncedTeams = yield* syncSharedReposBeforeAgentRead(config).pipe(
          Effect.map(result => {
            syncWarnings.push(...result.warnings);
            return result.syncedTeams;
          }),
          Effect.catch(error => {
            syncWarnings.push(error instanceof Error ? error.message : String(error));
            return Effect.succeed([] as readonly string[]);
          }),
        );
        const result = yield* runOpenVikingReadTool(config, checkedUris.value);
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
      });
    },
  );
}

function registerListTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: string,
  description: string,
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description,
      inputSchema: {
        uri: McpInput.string('Optional viking:// directory URI; defaults to viking://'),
        all: McpInput.boolean('Show hidden files like .abstract.md and .overview.md'),
        recursive: McpInput.boolean('List recursively'),
        simple: McpInput.boolean('Only return paths'),
        nodeLimit: McpInput.integer('Maximum node count', {minimum: 1, maximum: 1000}),
        node_limit: McpInput.integer('Maximum node count', {minimum: 1, maximum: 1000}),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({recursive, uri}) {
      const checkedUri = optionalVikingUri(uri, name);
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return yield* runOpenVikingMcpTool(config, 'list', {
        recursive,
        uri: checkedUri.value ?? 'viking://',
      });
    }),
  );
}

function registerStoreTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: string,
  description: string,
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: `${description} Never store secrets, credentials, customer data, or raw logs.`,
      inputSchema: {
        kind: McpInput.literals(
          ['durable', 'handoff', 'incident', 'preference', 'smoke'],
          'Memory lifecycle kind; durable facts and handoffs are most common',
        ),
        project: McpInput.string('Project/repo namespace, for example threadnote or mobile-native'),
        references: McpInput.stringOrStrings(
          'Optional viking:// URI(s) to record as one-way, read-only prior context for this memory. Recall surfaces a short excerpt of each. Stripped from shared copies on publish.',
        ),
        replaceUri: McpInput.string(
          'Optional viking:// memory URI to replace. Shared URIs are updated in place and pushed; personal URIs are forgotten after the replacement is safely stored.',
        ),
        text: McpInput.string('Required memory text to store'),
        sourceAgentClient: McpInput.string('Originating client, for example cursor, copilot, codex, or claude'),
        status: McpInput.literals(['active', 'archived', 'superseded'], 'Memory lifecycle status'),
        topic: McpInput.string('Stable topic; active project/topic memories update one file'),
      },
    },
    ({kind, project, references, replaceUri, sourceAgentClient, status, text, topic}) => {
      const checkedText = requiredText(text, name, 'text', {text: 'Durable engineering note...'});
      if (!checkedText.ok) {
        return checkedText.error;
      }
      const checkedReplaceUri = optionalVikingUri(replaceUri, name);
      if (!checkedReplaceUri.ok) {
        return checkedReplaceUri.error;
      }
      const checkedReferences = optionalVikingUriList(references, name);
      if (!checkedReferences.ok) {
        return checkedReferences.error;
      }
      const metadata: MemoryMetadata = {
        kind: kind ?? 'durable',
        project: normalizeOptionalMetadata(project),
        references: checkedReferences.value,
        sourceAgentClient: sourceAgentClient ?? 'mcp',
        status: status ?? 'active',
        timestamp: new Date().toISOString(),
        topic: normalizeOptionalMetadata(topic),
      };
      return Effect.gen(function* () {
        const enrichedMetadata =
          checkedReplaceUri.value && isInSharedNamespace(config, checkedReplaceUri.value)
            ? metadata
            : yield* enrichMemoryMetadataWithConfiguredLocalAi(config, metadata, checkedText.value).pipe(
                Effect.catch(error =>
                  Console.log(
                    `Local AI memory enrichment skipped: ${error instanceof Error ? error.message : String(error)}`,
                  ).pipe(Effect.as(metadata)),
                ),
              );
        return yield* writeDurableMemory(config, {
          bodyText: checkedText.value,
          metadata: enrichedMetadata,
          replaceUri: checkedReplaceUri.value,
        });
      }).pipe(
        Effect.flatMap(withStaleVersionNotice),
        Effect.catch(error =>
          Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
        ),
      );
    },
  );
}

function stringList(value: string | readonly string[] | undefined): readonly string[] {
  return typeof value === 'string' ? [value] : (value ?? []);
}

function sessionCloseoutHasCandidateMaterial(input: SessionCloseoutInput): boolean {
  return [input.decisions, input.handoff, input.invariants, input.preferences].some(items => (items?.length ?? 0) > 0);
}

function sessionCloseoutHasEvidence(input: SessionCloseoutInput): boolean {
  return (input.evidence?.length ?? 0) > 0 || input.sourceSessionId !== undefined || input.sourceCommit !== undefined;
}

function parseCandidatePolicy(value: string | undefined): 'handoff-only' | 'off' | 'suggest' {
  const normalized = value?.trim() || 'suggest';
  if (normalized === 'suggest' || normalized === 'handoff-only' || normalized === 'off') {
    return normalized;
  }
  throw new Error(`Invalid THREADNOTE_CANDIDATE_POLICY=${normalized}. Expected suggest, handoff-only, or off.`);
}

function scrubSessionCloseout(
  input: SessionCloseoutInput,
): {readonly input: SessionCloseoutInput; readonly ok: true} | {readonly error: string; readonly ok: false} {
  const scrubText = (value: string): {readonly blocker?: string; readonly cleaned: string} =>
    applyScrubber(value, {redact: true});
  const scalarValues = [
    ['task', input.task],
    ['outcome', input.outcome],
    ['project', input.project],
    ['topic', input.topic],
    ['sourceAgentClient', input.sourceAgentClient],
    ['sourceCommit', input.sourceCommit],
    ['sourceSessionId', input.sourceSessionId],
  ] as const;
  const scrubbedScalars = new Map<string, string | undefined>();
  for (const [key, value] of scalarValues) {
    if (value === undefined) {
      scrubbedScalars.set(key, undefined);
      continue;
    }
    const scrubbed = scrubText(value);
    if (scrubbed.blocker) {
      return {error: `Refusing session review: ${key} may contain ${scrubbed.blocker}.`, ok: false};
    }
    scrubbedScalars.set(key, scrubbed.cleaned);
  }
  const scrubList = (key: string, values: readonly string[] | undefined): readonly string[] | undefined => {
    if (!values) {
      return undefined;
    }
    const result: string[] = [];
    for (const value of values) {
      const scrubbed = scrubText(value);
      if (scrubbed.blocker) {
        throw new Error(`${key} may contain ${scrubbed.blocker}`);
      }
      result.push(scrubbed.cleaned);
    }
    return result;
  };
  try {
    return {
      input: {
        decisions: scrubList('decisions', input.decisions),
        evidence: scrubList('evidence', input.evidence),
        handoff: scrubList('handoff', input.handoff),
        invariants: scrubList('invariants', input.invariants),
        outcome: scrubbedScalars.get('outcome') as string,
        preferences: scrubList('preferences', input.preferences),
        project: scrubbedScalars.get('project') as string,
        sourceAgentClient: scrubbedScalars.get('sourceAgentClient') as string,
        sourceCommit: scrubbedScalars.get('sourceCommit'),
        sourceSessionId: scrubbedScalars.get('sourceSessionId'),
        task: scrubbedScalars.get('task') as string,
        topic: scrubbedScalars.get('topic') as string,
      },
      ok: true,
    };
  } catch (cause: unknown) {
    return {error: `Refusing session review: ${errorMessage(cause)}.`, ok: false};
  }
}

function candidateReviewResult(review: CandidateReview): CallToolResult {
  const actionable = review.candidates.filter(candidate => candidate.recommendation !== 'no_action');
  const lines =
    review.candidates.length === 0
      ? ['No additional memory candidates found in this task closeout. No candidate memory was written.']
      : actionable.length === 0
        ? ['No memory update is recommended; every candidate duplicates active memory.']
        : [
            `Review ${review.reviewId} · revision ${review.revision}`,
            'Present these additional recommendations in the current conversation. Do not write these additional candidates until the user decides:',
            ...review.candidates.map(
              (candidate, index) =>
                `${index + 1}. [${candidate.recommendation}] ${candidate.kind}/${candidate.topic} · ${candidate.reason}\n` +
                `   candidate: ${candidate.candidateId}` +
                (candidate.targetUri ? `\n   target: ${candidate.targetUri}` : '') +
                `\n${candidate.proposedText
                  .split('\n')
                  .map(line => `   ${line}`)
                  .join('\n')}`,
            ),
          ];
  return {
    content: [{type: 'text', text: lines.join('\n')}],
    structuredContent: {
      candidates: review.candidates,
      noAction: actionable.length === 0,
      reviewId: review.reviewId,
      revision: review.revision,
    },
  };
}

function approvedCandidateMetadata(
  review: CandidateReview,
  candidate: MemoryCandidate,
  approvedAt: string,
): MemoryMetadata {
  return {
    authority: 'user_approved',
    candidateId: candidate.candidateId,
    evidence: candidate.evidence,
    kind: candidate.kind,
    lastReviewed: approvedAt,
    project: candidate.project,
    schemaVersion: 2,
    sourceAgentClient: review.sourceAgentClient,
    sourceCommit: review.sourceCommit,
    sourceObservedAt: review.createdAt,
    sourceSessionId: review.sourceSessionId,
    status: 'active',
    timestamp: approvedAt,
    topic: candidate.topic,
    trust: 'approved',
  };
}

function storedMemoryUri(result: CallToolResult): string | undefined {
  const structuredMemoryUri = result.structuredContent?.memoryUri;
  if (typeof structuredMemoryUri === 'string') {
    return structuredMemoryUri;
  }
  const text = textFromCallToolResult(result);
  return /Stored memory:\s+(viking:\/\/\S+)/.exec(text)?.[1];
}

function replacementCleanupIsPending(result: CallToolResult): boolean {
  return result.structuredContent?.replacementCleanupPending === true;
}

function reviewedCandidateTargetIsCurrent(config: RuntimeConfig, candidate: MemoryCandidate) {
  if (!candidate.targetUri || !candidate.targetContentHash) {
    return Effect.succeed(false);
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [candidate.targetUri],
      Effect.gen(function* () {
        const [target] = yield* readMemoryRecordsByUri(config, [candidate.targetUri as string]);
        return (
          target !== undefined &&
          (yield* sha256Hex(canonicalMemoryDocumentContent(target.content))) === candidate.targetContentHash
        );
      }),
    );
  });
}

function persistCandidateConflict(
  config: RuntimeConfig,
  review: CandidateReview,
  candidate: MemoryCandidate,
  message: string,
) {
  return Effect.gen(function* () {
    const conflicted = candidateReviewWithState(
      candidateReviewWithApplyStage(review, candidate.candidateId, 'conflict'),
      candidate.candidateId,
      'conflict',
      {
        action: 'conflict',
        at: new Date(yield* Clock.currentTimeMillis).toISOString(),
        memoryUri: candidate.applyTargetUri,
      },
    );
    yield* saveCandidateReview(config.agentContextHome, conflicted);
    return argumentError(message);
  });
}

function reconcileCandidateReplacementCleanup(config: RuntimeConfig, candidate: MemoryCandidate) {
  if (
    candidate.applyOperation !== 'replace' ||
    !candidate.applyReplaceUri ||
    !candidate.applyTargetUri ||
    candidate.applyReplaceUri === candidate.applyTargetUri
  ) {
    return Effect.succeed('complete');
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [candidate.applyReplaceUri, candidate.applyTargetUri],
      Effect.gen(function* () {
        const [currentTarget] = yield* readMemoryRecordsByUri(config, [candidate.applyReplaceUri as string]);
        if (!currentTarget) {
          return 'complete' as const;
        }
        if (
          !candidate.targetContentHash ||
          (yield* sha256Hex(canonicalMemoryDocumentContent(currentTarget.content))) !== candidate.targetContentHash
        ) {
          return 'conflict' as const;
        }
        const ov = yield* requiredOpenVikingCli();
        const removed = yield* removeVikingResourceWithRetry(ov, config, candidate.applyReplaceUri as string);
        if (!removed) {
          return 'pending' as const;
        }
        const stillExists = yield* vikingResourceExists(ov, config, candidate.applyReplaceUri as string);
        return stillExists ? ('pending' as const) : ('complete' as const);
      }),
    );
  });
}

function registerRecallFeedbackTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'recall_feedback',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description:
        'Record bounded local feedback for one recall result. Stores a query fingerprint, never the full query. Feedback cannot bypass topical relevance and decays over time.',
      inputSchema: {
        action: McpInput.literals(['dismiss', 'pin', 'useful', 'wrong']),
        project: McpInput.string('Optional project scope; pin is never global'),
        query: McpInput.string('The recall query; only its SHA-256 fingerprint is stored'),
        uri: McpInput.string('The viking:// result URI receiving feedback'),
      },
    },
    ({action, project, query, uri}) => {
      const checkedQuery = requiredText(query, 'recall_feedback', 'query', {query: 'threadnote recall quality'});
      if (!checkedQuery.ok) {
        return checkedQuery.error;
      }
      const checkedUri = requiredVikingUri(
        uri,
        'recall_feedback',
        'viking://user/example/memories/durable/projects/threadnote/recall.md',
      );
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      if (!action) {
        return argumentError('recall_feedback requires action: useful, wrong, pin, or dismiss.');
      }
      const normalizedProject = normalizeOptionalMetadata(project);
      if (action === 'pin' && normalizedProject === undefined) {
        return argumentError('recall_feedback requires project when action is pin; pins are never global.');
      }
      return Effect.gen(function* () {
        const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString();
        const result = yield* recordRecallFeedback(config.agentContextHome, {
          action,
          project: normalizedProject,
          query: checkedQuery.value,
          timestamp,
          uri: checkedUri.value,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: result.recorded
                ? `Recorded ${action} feedback for ${checkedUri.value}.`
                : `Equivalent recent ${action} feedback already exists for ${checkedUri.value}; no duplicate was added.`,
            },
          ],
        };
      }).pipe(
        Effect.catch(error =>
          Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
        ),
      );
    },
  );
}

function registerArchiveTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  name: string,
  description: string,
): void {
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: `${description} The archive is written before the original URI is removed.`,
      inputSchema: {
        kind: McpInput.literals(['durable', 'handoff', 'incident', 'preference', 'smoke']),
        project: McpInput.string('Project/repo namespace for the archived copy'),
        topic: McpInput.string('Topic for the archived copy'),
        uri: McpInput.string('Required viking:// memory URI to archive'),
      },
    },
    ({kind, project, topic, uri}) => {
      const checkedUri = requiredVikingUri(uri, name, 'viking://user/example/memories/handoffs/active/repo/topic.md');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return Effect.gen(function* () {
        const [sourceRecord] = yield* readMemoryRecordsByUri(config, [checkedUri.value]);
        if (!sourceRecord) {
          return argumentError(`Could not resolve local memory content for ${checkedUri.value} before archiving.`);
        }
        const sourceContent = sourceRecord.content;
        const readResult = yield* runOpenVikingReadTool(config, [checkedUri.value]);
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
        const archiveResult = yield* writeDurableMemory(config, {
          bodyText: ['Archived original Threadnote memory.', '', original].join('\n'),
          expectedSourceContent: [{content: sourceContent, uri: checkedUri.value}],
          metadata,
        });
        if (archiveResult.isError === true) {
          return archiveResult;
        }
        const removedOriginal = yield* forgetVikingResourceWithRetry(config, checkedUri.value, false, sourceContent);
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
      }).pipe(
        Effect.catch(error =>
          Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
        ),
      );
    },
  );
}

function registerCompactTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'compact_context',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        'Plan or apply scoped Threadnote memory hygiene. Defaults to dry-run; pass apply=true to archive stale handoffs and forget exact duplicates.',
      inputSchema: {
        apply: McpInput.boolean('Apply the compact plan; defaults to false'),
        dryRun: McpInput.boolean('Keep the call read-only; defaults to true unless apply=true'),
        kind: McpInput.literals(['durable', 'handoff', 'incident'], 'Optional memory kind filter'),
        project: McpInput.string('Required project/repo namespace, for example threadnote'),
        topic: McpInput.string('Optional stable topic name'),
      },
    },
    ({apply, dryRun, kind, project, topic}) => {
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
      return Effect.gen(function* () {
        const records = yield* scopedCompactRecords(config, {
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

        const ov = yield* requiredOpenVikingCli();
        const appliedMessages: string[] = [];
        for (const action of plan.keepUpdates) {
          const keepResult = yield* writeMemoryContentWithExpectedHash(
            config,
            ov,
            action.uri,
            action.content,
            action.expectedContent,
          );
          if (keepResult.isError === true) {
            return keepResult;
          }
          appliedMessages.push(`Updated kept memory: ${action.uri}`);
        }
        for (const action of plan.archives) {
          const archiveResult = yield* archiveMemoryForCompact(config, action);
          if (archiveResult.isError === true) {
            return archiveResult;
          }
          const [content] = archiveResult.content;
          if (content?.type === 'text') {
            appliedMessages.push(content.text);
          }
        }
        for (const action of plan.forgets) {
          const removed = yield* forgetVikingResourceWithRetry(config, action.uri, false, action.expectedContent);
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
      }).pipe(
        Effect.catch(error =>
          Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
        ),
      );
    },
  );
}

function archiveMemoryForCompact(config: RuntimeConfig, action: ArchiveAction) {
  return Effect.gen(function* () {
    const readResult = yield* runOpenVikingReadTool(config, [action.uri]);
    const original = textFromCallToolResult(readResult);
    if (!original) {
      return {content: [{type: 'text', text: `Could not read ${action.uri} before archiving.`}], isError: true};
    }
    const archiveResult = yield* writeDurableMemory(config, {
      bodyText: ['Archived original Threadnote memory.', '', original].join('\n'),
      expectedSourceContent: [{content: action.expectedContent, uri: action.uri}],
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
    const removedOriginal = yield* forgetVikingResourceWithRetry(config, action.uri, false, action.expectedContent);
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
    } satisfies CallToolResult;
  });
}

const scopedCompactRecords = Effect.fn('mcpServer.scopedCompactRecords')(function* (
  config: RuntimeConfig,
  options: {readonly kind?: CompactableMemoryKind; readonly project: string},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const kinds: readonly CompactableMemoryKind[] = options.kind ? [options.kind] : ['handoff', 'durable', 'incident'];
  const records: MemoryRecord[] = [];
  for (const kind of kinds) {
    const directory = yield* localMemoryDirectoryForCompact(config, kind, options.project);
    const uriDirectory = memoryUriDirectoryForCompact(config, kind, options.project);
    const entries = yield* fs.readDirectory(directory).pipe(Effect.option);
    if (entries._tag === 'None') {
      continue;
    }
    for (const entry of entries.value) {
      if (entry.startsWith('.') || !entry.endsWith('.md')) {
        continue;
      }
      const entryPath = path.join(directory, entry);
      const info = yield* fs.stat(entryPath).pipe(Effect.option);
      if (info._tag === 'None' || info.value.type !== 'File') {
        continue;
      }
      const content = yield* readTextIfExists(entryPath);
      if (!content) {
        continue;
      }
      const record = parseMemoryDocument(`${uriDirectory}/${entry}`, content);
      if (record) {
        records.push(record);
      }
    }
  }
  return records;
});

const readMemoryRecordsByUri = Effect.fn('mcpServer.readMemoryRecordsByUri')(function* (
  config: RuntimeConfig,
  uris: readonly string[],
) {
  const records: MemoryRecord[] = [];
  for (const uri of uris) {
    const localPath = yield* localMemoryPathForUri(config, uri);
    if (!localPath) {
      continue;
    }
    const content = yield* readTextIfExists(localPath);
    if (!content) {
      continue;
    }
    const record = parseMemoryDocument(uri, content);
    if (record) {
      records.push(record);
    }
  }
  return records;
});

const localMemoryDirectoryForCompact = Effect.fn('mcpServer.localMemoryDirectoryForCompact')(function* (
  config: RuntimeConfig,
  kind: CompactableMemoryKind,
  project: string,
) {
  const path = yield* Path.Path;
  const root = yield* localUserMemoriesRoot(config);
  const projectSegment = uriSegment(project);
  switch (kind) {
    case 'durable':
      return path.join(root, 'durable', 'projects', projectSegment);
    case 'handoff':
      return path.join(root, 'handoffs', 'active', projectSegment);
    case 'incident':
      return path.join(root, 'incidents', 'active', projectSegment);
  }
});

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

const localMemoryPathForUri = Effect.fn('mcpServer.localMemoryPathForUri')(function* (
  config: RuntimeConfig,
  uri: string,
) {
  const prefix = `viking://user/${uriSegment(config.user)}/memories/`;
  if (!uri.startsWith(prefix)) {
    return undefined;
  }
  const relative = uri.slice(prefix.length);
  if (relative.includes('..') || relative.startsWith('/')) {
    return undefined;
  }
  const path = yield* Path.Path;
  return path.join(yield* localUserMemoriesRoot(config), ...relative.split('/'));
});

const localUserMemoriesRoot = Effect.fn('mcpServer.localUserMemoriesRoot')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  return path.join(
    config.agentContextHome,
    'data',
    'viking',
    config.account,
    'user',
    uriSegment(config.user),
    'memories',
  );
});

const readTextIfExists = Effect.fn('mcpServer.readTextIfExists')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path).pipe(Effect.catch(() => Effect.succeed(undefined)));
});

interface WriteDurableMemoryParams {
  readonly bodyText: string;
  readonly expectedReplaceContentHash?: string;
  readonly expectedSourceContent?: readonly {readonly content: string; readonly uri: string}[];
  readonly metadata: MemoryMetadata;
  readonly operation?: 'create' | 'replace' | 'upsert';
  readonly prepared?: PreparedPersonalMemoryWrite;
  readonly replaceUri?: string;
}

interface PreparedPersonalMemoryWrite {
  readonly finalMetadata: MemoryMetadata;
  readonly isInPlaceUpdate: boolean;
  readonly memory: string;
  readonly memoryUri: string;
}

function writeDurableMemory(config: RuntimeConfig, params: WriteDurableMemoryParams) {
  const write = Effect.gen(function* () {
    const prepared = params.prepared ?? (yield* preparePersonalMemoryWrite(config, params));
    const fs = yield* FileSystem.FileSystem;
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [params.replaceUri, prepared.memoryUri, ...(params.expectedSourceContent ?? []).map(source => source.uri)],
      Effect.gen(function* () {
        const ov = yield* requiredOpenVikingCli();
        if (params.operation === 'replace' && !params.replaceUri) {
          return argumentError('A replace write requires replaceUri.');
        }
        if (params.replaceUri && params.expectedReplaceContentHash) {
          const [currentTarget] = yield* readMemoryRecordsByUri(config, [params.replaceUri as string]);
          if (
            !currentTarget ||
            (yield* sha256Hex(canonicalMemoryDocumentContent(currentTarget.content))) !==
              params.expectedReplaceContentHash
          ) {
            return argumentError(
              `Candidate replacement is stale because ${params.replaceUri} changed after review. Run review_session_context again before replacing it.`,
            );
          }
        }
        for (const source of params.expectedSourceContent ?? []) {
          const [currentSource] = yield* readMemoryRecordsByUri(config, [source.uri]);
          if (!currentSource || currentSource.content !== source.content) {
            return argumentError(
              `Memory ${source.uri} changed after this mutation was planned. Re-run the operation before writing.`,
            );
          }
        }
        if (params.replaceUri && isInSharedNamespace(config, params.replaceUri)) {
          return yield* writeSharedMemoryReplacement(config, ov, params, params.replaceUri as string);
        }
        const {finalMetadata, isInPlaceUpdate, memory, memoryUri} = prepared;
        const destinationExists = yield* vikingResourceExists(ov, config, memoryUri);
        if (params.operation === 'replace' && destinationExists && params.replaceUri !== memoryUri) {
          const [destinationRecord] = yield* readMemoryRecordsByUri(config, [memoryUri]);
          if (destinationRecord?.metadata.candidateId !== params.metadata.candidateId) {
            return argumentError(`Replacement destination already contains another memory: ${memoryUri}.`);
          }
        }
        const directoryUri = memoryDirectoryUri(config, finalMetadata);
        yield* ensureMemoryDirectory(ov, config, directoryUri);
        const writeMode =
          params.operation === 'create'
            ? 'create'
            : params.operation === 'replace'
              ? destinationExists
                ? 'replace'
                : 'create'
              : yield* memoryWriteMode(ov, config, memoryUri, finalMetadata);
        yield* writeMemoryFile(config, ov, memoryUri, memory, writeMode, false, {quiet: true});
        const messages = [`Stored memory: ${memoryUri}`];
        let replacementCleanupPending = false;
        if (params.replaceUri && !isInPlaceUpdate) {
          const removedReplacedMemory = yield* removeVikingResourceWithRetry(ov, config, params.replaceUri);
          replacementCleanupPending = !removedReplacedMemory;
          messages.push(
            removedReplacedMemory
              ? `Forgot replaced memory: ${params.replaceUri}`
              : `Replacement stored, but superseded memory is still processing. Retry later with forget: ${params.replaceUri}`,
          );
        } else if (isInPlaceUpdate) {
          messages.push(`Updated existing memory in place: ${memoryUri}`);
        }
        return {
          content: [{type: 'text' as const, text: messages.join('\n')}],
          structuredContent: {memoryUri, replacementCleanupPending},
        };
      }),
    );
  });
  const serializedWrite =
    params.replaceUri && isInSharedNamespace(config, params.replaceUri)
      ? withSharedRepositoryLock(config, write)
      : write;
  return serializedWrite.pipe(
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
    Effect.map(result => result as CallToolResult),
  );
}

/**
 * Computes the exact personal-memory destination and final document before a
 * candidate enters its recoverable `applying` state. The writer consumes this
 * same prepared value so recovery and the actual write cannot disagree.
 */
const preparePersonalMemoryWrite = Effect.fn('mcpServer.preparePersonalMemoryWrite')(function* (
  config: RuntimeConfig,
  params: Pick<WriteDurableMemoryParams, 'bodyText' | 'metadata' | 'replaceUri'>,
) {
  // Two-pass formatting: see src/memory.ts:storeMemory for the rationale.
  // Drops the supersedes line when replaceUri points at the URI we're about
  // to write to (in-place update).
  const candidateMetadata: MemoryMetadata = {...params.metadata, supersedes: params.replaceUri};
  const candidateMemory = formatMemoryDocument('MEMORY', candidateMetadata, params.bodyText);
  const memoryUri = yield* memoryUriFor(config, candidateMemory, candidateMetadata);
  const isInPlaceUpdate = params.replaceUri !== undefined && params.replaceUri === memoryUri;
  const finalMetadata: MemoryMetadata = isInPlaceUpdate
    ? {...params.metadata, supersedes: undefined}
    : candidateMetadata;
  const memory = isInPlaceUpdate ? formatMemoryDocument('MEMORY', finalMetadata, params.bodyText) : candidateMemory;
  return {finalMetadata, isInPlaceUpdate, memory, memoryUri} satisfies PreparedPersonalMemoryWrite;
});

const writeSharedMemoryReplacement = Effect.fn('mcp_server.writeSharedMemoryReplacement')(function* (
  config: RuntimeConfig,
  ov: string,
  params: WriteDurableMemoryParams,
  targetUri: string,
) {
  if (params.metadata.kind !== 'durable') {
    return argumentError('Shared memory replacement only supports durable memories.');
  }
  const teamName = sharedTeamNameForUri(config, targetUri);
  if (!teamName) {
    return argumentError(`Memory ${targetUri} is not in the shared namespace.`);
  }
  const resolved = yield* resolveTeam(config, teamName);
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

  yield* ensureSharedDirectoryChain(config, ov, targetUri, false, {quiet: true});
  yield* writeMemoryFile(config, ov, targetUri, scrub.cleaned, 'replace', false, {quiet: true});

  const relativePath = vikingUriToWorktreeRelative(config, targetUri, resolved.name);
  const messages = [`Updated shared memory: ${targetUri}`];
  for (const redaction of scrub.redactions) {
    messages.push(`Redacted ${redaction.count}× ${redaction.name} before shared update.`);
  }
  messages.push(
    ...(yield* publishShareGitChange(resolved.config.worktree, relativePath, `share: update ${relativePath}`)),
  );
  return {content: [{type: 'text', text: messages.join('\n')}]};
});

const vikingResourceExists = Effect.fn('mcp_server.vikingResourceExists')(function* (
  ov: string,
  config: RuntimeConfig,
  uri: string,
) {
  const stat = yield* runCommand(ov, withIdentity(config, ['stat', uri]), {allowFailure: true});
  return stat.exitCode === 0;
});

function removeVikingResourceWithRetry(ov: string, config: RuntimeConfig, uri: string, recursive = false) {
  const args = withIdentity(config, ['rm', uri, ...(recursive ? ['--recursive'] : [])]);
  return pipe(
    removeOpenVikingResourceEffect(ov, args, {isBusy: isResourceBusy}),
    Effect.map(result => result !== undefined),
  );
}

function runOpenVikingRemoveTool(config: RuntimeConfig, uri: string, recursive: boolean) {
  return Effect.gen(function* () {
    const removed = yield* forgetVikingResourceWithRetry(config, uri, recursive);
    return {
      content: [
        {
          type: 'text',
          text: removed ? `Removed: ${uri}` : `Resource is still being processed; retry later: ${uri}`,
        },
      ],
      isError: !removed,
    } satisfies CallToolResult;
  }).pipe(
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
  );
}

function isResourceBusy(stderr: string, stdout: string): boolean {
  const output = `${stderr}\n${stdout}`.toLowerCase();
  return output.includes('resource is busy') || output.includes('resource is being processed');
}

const ensureMemoryDirectory = Effect.fn('mcp_server.ensureMemoryDirectory')(function* (
  ov: string,
  config: RuntimeConfig,
  directoryUri: string,
) {
  for (const uri of vikingDirectoryChain(directoryUri)) {
    const statResult = yield* runCommand(ov, withIdentity(config, ['stat', uri]), {allowFailure: true});
    if (statResult.exitCode === 0) {
      continue;
    }
    yield* runCommand(
      ov,
      withIdentity(config, ['mkdir', uri, '--description', 'Threadnote lifecycle-aware local memories.']),
    );
  }
});

const memoryUriFor = Effect.fn('mcpServer.memoryUriFor')(function* (
  config: RuntimeConfig,
  memory: string,
  metadata: MemoryMetadata,
) {
  const filename = shouldUseStableMemoryUri(metadata)
    ? `${uriSegment(metadata.topic ?? 'current')}.md`
    : `threadnote-${safeTimestamp()}-${(yield* sha256(memory)).slice(0, 12)}.md`;
  return `${memoryDirectoryUri(config, metadata)}/${filename}`;
});

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

const memoryWriteMode = Effect.fn('mcp_server.memoryWriteMode')(function* (
  ov: string,
  config: RuntimeConfig,
  memoryUri: string,
  metadata: MemoryMetadata,
) {
  if (!shouldUseStableMemoryUri(metadata)) {
    return 'create';
  }
  return (yield* vikingResourceExists(ov, config, memoryUri)) ? 'replace' : 'create';
});

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

const MAX_WORKSET_PASSES = 12;

/** Durable + seeded recall scopes for every member of a workset (see src/memory.ts:worksetScopeUris). */
function worksetScopeUris(config: RuntimeConfig, workset: ResolvedWorkset): readonly string[] {
  const scopes: string[] = [];
  for (const member of workset.projects) {
    scopes.push(`viking://user/${uriSegment(config.user)}/memories/durable/projects/${uriSegment(member.name)}`);
    const seeded = trimTrailingSlash(member.uri);
    if (seeded.startsWith('viking://')) {
      scopes.push(seeded);
    }
  }
  return [...new Set(scopes)];
}

function projectMemoryScopeUris(
  config: RuntimeConfig,
  projectName: string | undefined,
  includeArchived: boolean,
): readonly string[] {
  if (!projectName) {
    return [];
  }
  const base = `viking://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(projectName);
  const scopes = [
    `${base}/durable/projects/${projectSegment}`,
    `${base}/handoffs/active/${projectSegment}`,
    `${base}/incidents/active/${projectSegment}`,
  ];
  return includeArchived
    ? [
        ...scopes,
        `${base}/durable/archived/${projectSegment}`,
        `${base}/handoffs/archived/${projectSegment}`,
        `${base}/incidents/archived/${projectSegment}`,
      ]
    : scopes;
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

function rejectLeadingDash(value: string, toolName: string, fieldName: string): CheckedText {
  if (!value.startsWith('-')) {
    return {ok: true, value};
  }
  return {
    error: argumentError(
      `Threadnote MCP tool "${toolName}" rejects "${fieldName}" values that start with "-". Prefix relative file paths with "./" or use an absolute path.`,
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

function optionalVikingUriList(
  value: readonly string[] | string | undefined,
  toolName: string,
): CheckedOptionalTextArray {
  const rawValues = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const uris = rawValues.map(uri => uri.trim()).filter(Boolean);
  if (uris.length === 0) {
    return {ok: true, value: undefined};
  }
  const invalid = uris.find(uri => !uri.startsWith('viking://'));
  if (invalid) {
    return {
      error: argumentError(
        `Threadnote MCP tool "${toolName}" needs viking:// URI values for "references". Received: ${invalid}`,
      ),
      ok: false,
    };
  }
  return {ok: true, value: [...new Set(uris)]};
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

const runOpenVikingAddResourceTool = Effect.fn('mcp_server.runOpenVikingAddResourceTool')(function* (
  config: RuntimeConfig,
  toolName: string,
  params: OpenVikingAddResourceParams,
) {
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
  if (source) {
    const checkedSource = rejectLeadingDash(source, toolName, 'path');
    if (!checkedSource.ok) {
      return checkedSource.error;
    }
  }
  if (tempFileId) {
    const checkedTo = optionalVikingUri(params.to, toolName);
    if (!checkedTo.ok) {
      return checkedTo.error;
    }
    return yield* runOpenVikingMcpTool(config, 'add_resource', {
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
  return yield* runOpenVikingMcpTool(config, 'add_resource', {
    description,
    path: source,
    to: checkedTo.value,
    watch_interval: params.watchInterval,
  });
});

const runOpenVikingReadTool = Effect.fn('mcp_server.runOpenVikingReadTool')(function* (
  config: RuntimeConfig,
  uris: readonly string[],
) {
  const result = yield* runOpenVikingMcpTool(config, 'read', {uris});
  if (result.isError !== true && !nativeReadMissedAnyUri(result, uris)) {
    return result;
  }
  return yield* runOpenVikingReadToolWithCliFallback(config, uris);
});

function nativeReadMissedAnyUri(result: CallToolResult, uris: readonly string[]): boolean {
  const text = textFromCallToolResult(result);
  return uris.some(uri => text.includes(`(nothing found at ${uri})`));
}

const runOpenVikingReadToolWithCliFallback = Effect.fn('mcp_server.runOpenVikingReadToolWithCliFallback')(function* (
  config: RuntimeConfig,
  uris: readonly string[],
) {
  const outputs: string[] = [];
  for (const uri of uris) {
    const nativeResult = yield* runOpenVikingMcpTool(config, 'read', {uris: [uri]});
    const nativeText = textFromCallToolResult(nativeResult);
    let text = nativeText;
    if (nativeResult.isError === true || nativeText.includes(`(nothing found at ${uri})`)) {
      const cliResult = yield* runOpenVikingCliReadTool(config, uri);
      if (cliResult.isError === true) {
        return cliResult;
      }
      text = textFromCallToolResult(cliResult);
    }
    outputs.push(uris.length === 1 ? text : `=== ${uri} ===\n${text}`);
  }
  return {content: [{type: 'text', text: outputs.filter(Boolean).join('\n\n') || 'OK'}]} satisfies CallToolResult;
});

const runOpenVikingCliReadTool = Effect.fn('mcp_server.runOpenVikingCliReadTool')(function* (
  config: RuntimeConfig,
  uri: string,
) {
  return yield* Effect.gen(function* () {
    const ov = yield* requiredOpenVikingCli();
    const result = yield* runCommand(ov, withIdentity(config, ['read', uri]));
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    return {content: [{type: 'text', text: text || 'OK'}]} satisfies CallToolResult;
  }).pipe(
    Effect.catch(error =>
      Effect.succeed({
        content: [{type: 'text', text: errorMessage(error)}],
        isError: true,
      } satisfies CallToolResult),
    ),
    Effect.map(result => result as CallToolResult),
  );
});

/**
 * Run an `ov` CLI subcommand and wrap its output as a CallToolResult. Used by
 * the enriched recall path (`recall_context`) so semantic search returns the
 * compact ranked list (URI + score + short snippet) instead of the native
 * `/mcp` search, which returns full Level-2 bodies and bloats recall ~15x.
 * Goes through `runCommand` (no-shell `execFile`), so it stays injection-safe.
 */
const runOpenVikingTool = Effect.fn('mcp_server.runOpenVikingTool')(function* (
  config: RuntimeConfig,
  args: readonly string[],
) {
  return yield* Effect.gen(function* () {
    const ov = yield* requiredOpenVikingCli();
    const result = yield* runCommand(ov, withIdentity(config, args));
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    return {content: [{type: 'text', text: text || 'OK'}]} satisfies CallToolResult;
  }).pipe(
    Effect.catch(error =>
      Effect.succeed({
        content: [{type: 'text', text: errorMessage(error)}],
        isError: true,
      } satisfies CallToolResult),
    ),
    Effect.map(result => result as CallToolResult),
  );
});

const runOpenVikingMcpTool = Effect.fn('mcp_server.runOpenVikingMcpTool')(function* (
  config: RuntimeConfig,
  toolName: string,
  args: Record<string, unknown>,
) {
  const invocation = Effect.gen(function* () {
    const client = new Client({name: 'threadnote-openviking-proxy', version: '1.1.0'});
    const transport = yield* Effect.try({
      try: () =>
        new StreamableHTTPClientTransport(new URL(config.openVikingMcpUrl), {
          requestInit: {
            headers: {
              // OpenViking 0.4.x dropped agent_id as an identity input; only
              // account + user are honored (mirrors withIdentity in runtime.ts).
              'X-OpenViking-Account': config.account,
              'X-OpenViking-User': config.user,
            },
          },
        }),
      catch: error => error,
    });
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => {
          await client.connect(transport);
          return client;
        },
        catch: error => error,
      }),
      connectedClient =>
        Effect.tryPromise({
          try: () =>
            connectedClient.callTool({arguments: stripUndefinedValues(args), name: toolName}, undefined, {
              timeout: 30_000,
            }),
          catch: error => error,
        }).pipe(Effect.map(normalizeCallToolResult)),
      connectedClient =>
        Effect.tryPromise({
          try: () => connectedClient.close(),
          catch: error => error,
        }).pipe(Effect.ignore),
    );
  });
  return yield* invocation.pipe(
    Effect.catch(error =>
      Effect.succeed({
        content: [
          {
            type: 'text',
            text: `OpenViking native MCP tool "${toolName}" failed at ${config.openVikingMcpUrl}: ${errorMessage(error)}`,
          },
        ],
        isError: true,
      } satisfies CallToolResult),
    ),
    Effect.map(result => result as CallToolResult),
  );
});

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

function writeMemoryContentWithExpectedHash(
  config: RuntimeConfig,
  ov: string,
  uri: string,
  content: string,
  expectedContent: string,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [uri],
      Effect.gen(function* () {
        const [current] = yield* readMemoryRecordsByUri(config, [uri]);
        if (!current || current.content !== expectedContent) {
          return argumentError(`Memory ${uri} changed after compact_context planned its update. Re-run the plan.`);
        }
        yield* writeMemoryFile(config, ov, uri, content, 'replace', false, {quiet: true});
        return {content: [{type: 'text' as const, text: `Updated memory: ${uri}`}]};
      }),
    );
  });
}

function forgetVikingResourceWithRetry(
  config: RuntimeConfig,
  uri: string,
  recursive = false,
  expectedContent?: string,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [uri],
      Effect.gen(function* () {
        if (expectedContent) {
          const [current] = yield* readMemoryRecordsByUri(config, [uri]);
          if (!current || current.content !== expectedContent) {
            return yield* Effect.fail(
              new Error(`Memory ${uri} changed after this removal was planned. Re-run the operation.`),
            );
          }
        }
        const ov = yield* requiredOpenVikingCli();
        return yield* removeVikingResourceWithRetry(ov, config, uri, recursive);
      }),
    );
  });
}

interface SharePublishToolOptions {
  readonly message?: string;
  readonly preview?: boolean;
  readonly push?: boolean;
  readonly redact?: boolean;
  readonly team?: string;
}

interface ShareConflictToolOptions {
  readonly team?: string;
}

interface ShareConflictResolveToolOptions {
  readonly dryRun?: boolean;
  readonly mergedContent?: string;
  readonly message?: string;
  readonly push?: boolean;
  readonly take?: 'local' | 'shared';
  readonly team?: string;
}

interface ShareSkillToolOptions {
  readonly agent?: 'claude' | 'codex';
  readonly allowBinary?: boolean;
  readonly force?: boolean;
  readonly kind?: 'command' | 'pack' | 'skill';
  readonly message?: string;
  readonly name?: string;
  readonly preview?: boolean;
  readonly push?: boolean;
  readonly redact?: boolean;
  readonly team?: string;
}

interface SharedSkillFilterOptions {
  readonly agent?: 'claude' | 'codex';
  readonly kind?: 'command' | 'pack' | 'skill';
  readonly name?: string;
  readonly team?: string;
}

interface InstallSharedSkillToolOptions {
  readonly agent?: 'claude' | 'codex';
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly kind?: 'command' | 'pack' | 'skill';
  readonly team?: string;
}

function runShareConflictsTool(config: RuntimeConfig, options: ShareConflictToolOptions) {
  return listShareConflicts(config, options).pipe(
    Effect.map(conflicts => {
      if (conflicts.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: options.team
                ? `No pending shared memory conflicts for team "${options.team}".`
                : 'No pending shared memory conflicts.',
            },
          ],
        };
      }
      const lines = [`Pending shared memory conflicts: ${conflicts.length}`];
      for (const conflict of conflicts) {
        lines.push(
          '',
          conflict.id,
          `uri: ${conflict.uri}`,
          `status: ${conflict.status}`,
          `reason: ${conflict.reason}`,
          `show: share_conflict_show({"id":${JSON.stringify(conflict.id)}})`,
          `take shared: share_conflict_resolve({"id":${JSON.stringify(conflict.id)},"take":"shared"})`,
          `take local: share_conflict_resolve({"id":${JSON.stringify(conflict.id)},"take":"local"})`,
          `merged: share_conflict_resolve({"id":${JSON.stringify(conflict.id)},"mergedContent":"<merged MEMORY markdown>"})`,
        );
      }
      return {content: [{type: 'text' as const, text: lines.join('\n')}]};
    }),
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
  );
}

function runShareConflictShowTool(config: RuntimeConfig, id: string, options: ShareConflictToolOptions) {
  return showShareConflict(config, id, options).pipe(
    Effect.map(detail => ({
      content: [
        {
          type: 'text' as const,
          text: [
            `Conflict: ${detail.id}`,
            `URI: ${detail.uri}`,
            `Status: ${detail.status}`,
            `Reason: ${detail.reason}`,
            '',
            detail.diff,
            '',
            'Resolve:',
            `share_conflict_resolve({"id":${JSON.stringify(detail.id)},"take":"shared"})`,
            `share_conflict_resolve({"id":${JSON.stringify(detail.id)},"take":"local"})`,
            `share_conflict_resolve({"id":${JSON.stringify(detail.id)},"mergedContent":"<merged MEMORY markdown>"})`,
          ].join('\n'),
        },
      ],
    })),
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
  );
}

function runShareConflictResolveTool(config: RuntimeConfig, id: string, options: ShareConflictResolveToolOptions) {
  return resolveShareConflict(config, id, {
    dryRun: options.dryRun,
    mergedContent: options.mergedContent,
    message: options.message,
    push: options.push,
    take: options.take,
    team: options.team,
  }).pipe(
    Effect.map(result => {
      const lines = [...result.messages];
      if (result.backupPath) {
        lines.push(`Backup: ${result.backupPath}`);
      }
      lines.push(...result.gitMessages, `Resolved shared memory conflict: ${result.id}`);
      return {content: [{type: 'text' as const, text: lines.join('\n')}]};
    }),
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
  );
}

function runSharePublishTool(config: RuntimeConfig, sourceUri: string, options: SharePublishToolOptions) {
  return Effect.gen(function* () {
    if (isInSharedNamespace(config, sourceUri)) {
      return argumentError(`Memory ${sourceUri} is already in the shared namespace.`);
    }
    const ov = yield* requiredOpenVikingCli();
    const readResult = yield* runOpenVikingReadTool(config, [sourceUri]);
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

    if (options.preview === true) {
      const resolved = yield* resolveTeam(config, options.team);
      const targetUri = sharedUriFor(config, sourceUri, resolved.name);
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
    const {publication, targetUri} = yield* withSharedRepositoryLock(
      config,
      Effect.gen(function* () {
        const resolved = yield* resolveTeam(config, options.team);
        const targetUri = sharedUriFor(config, sourceUri, resolved.name);
        const relativePath = vikingUriToWorktreeRelative(config, targetUri, resolved.name);
        const commitMessage = options.message ?? `share: publish ${relativePath}`;
        const fs = yield* FileSystem.FileSystem;
        const publication = yield* withMemoryUriLocks(
          fs,
          config.agentContextHome,
          [sourceUri, targetUri],
          Effect.gen(function* () {
            const [currentSource] = yield* readMemoryRecordsByUri(config, [sourceUri]);
            if (!currentSource) {
              return {kind: 'source_missing' as const};
            }
            const currentScrub = applyScrubber(
              stripPersonalProvenance(canonicalMemoryDocumentContent(currentSource.content)),
              {
                redact: options.redact === true,
              },
            );
            if (currentScrub.blocker) {
              return {blocker: currentScrub.blocker, kind: 'blocked' as const};
            }
            // Refuse to silently overwrite an existing shared memory (e.g., a
            // teammate already published the same project/topic).
            if (yield* sharedVikingResourceExists(ov, config, targetUri)) {
              return {kind: 'target_conflict' as const};
            }
            yield* ensureSharedDirectoryChain(config, ov, targetUri, false, {quiet: true});
            yield* writeMemoryFile(config, ov, targetUri, currentScrub.cleaned, 'create', false, {quiet: true});
            const [storedTarget] = yield* readMemoryRecordsByUri(config, [targetUri]);
            if (
              !storedTarget ||
              canonicalMemoryDocumentContent(storedTarget.content) !==
                canonicalMemoryDocumentContent(currentScrub.cleaned)
            ) {
              return {kind: 'target_verification_failed' as const};
            }
            const gitMessages = yield* publishShareGitChange(resolved.config.worktree, relativePath, commitMessage, {
              push: options.push,
            });
            const [sourceBeforeRemoval] = yield* readMemoryRecordsByUri(config, [sourceUri]);
            if (!sourceBeforeRemoval || sourceBeforeRemoval.content !== currentSource.content) {
              return {
                gitMessages,
                kind: 'source_changed' as const,
                redactions: currentScrub.redactions,
              };
            }
            const removed = yield* removeVikingResourceWithRetry(ov, config, sourceUri);
            return {
              gitMessages,
              kind: removed ? ('published' as const) : ('cleanup_pending' as const),
              redactions: currentScrub.redactions,
            };
          }),
        );
        return {publication, targetUri};
      }),
    );
    if (publication.kind === 'source_missing') {
      return argumentError(`Could not resolve local memory content for ${sourceUri} before publishing.`);
    }
    if (publication.kind === 'blocked') {
      return argumentError(
        `Refusing to publish ${sourceUri}: possible ${publication.blocker}. Strip the sensitive value or pass redact=true for soft-leak patterns.`,
      );
    }
    if (publication.kind === 'target_conflict') {
      return argumentError(
        `Refusing to publish: ${targetUri} already exists in the shared namespace. Inspect it via threadnote read; if it should be replaced, forget the existing shared copy first.`,
      );
    }
    if (publication.kind === 'target_verification_failed') {
      return argumentError(
        `Shared target verification failed after writing ${targetUri}. The personal source was preserved for recovery.`,
      );
    }
    const messages = [`Published ${sourceUri} -> ${targetUri}`];
    for (const redaction of publication.redactions) {
      messages.push(`Redacted ${redaction.count}× ${redaction.name} before publish.`);
    }
    if (publication.kind === 'source_changed' || publication.kind === 'cleanup_pending') {
      const cleanupReason =
        publication.kind === 'source_changed'
          ? `Memory ${sourceUri} changed while publication was in progress.`
          : `Resource is still being processed: ${sourceUri}`;
      return {
        content: [
          {
            type: 'text',
            text: [
              ...messages,
              ...publication.gitMessages,
              `Could not remove the personal source after publish: ${sourceUri}.`,
              `Retry cleanup later with: threadnote forget ${sourceUri}`,
              cleanupReason,
            ].join('\n'),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{type: 'text', text: [...messages, ...publication.gitMessages].join('\n')}],
      isError: false,
    };
  }).pipe(
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
  );
}

function runShareSkillTool(config: RuntimeConfig, sourcePath: string, options: ShareSkillToolOptions) {
  return shareAgentArtifact(config, sourcePath, options).pipe(
    Effect.map(result => {
      const lines = [...result.messages, ...result.gitMessages];
      if (result.previewContent !== undefined) {
        lines.push('-----BEGIN PREVIEW-----');
        lines.push(result.previewContent);
        lines.push('-----END PREVIEW-----');
      }
      return {content: [{type: 'text' as const, text: lines.join('\n')}], isError: false};
    }),
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
  );
}

interface ShareBundleToolOptions {
  readonly allowBinary?: boolean;
  readonly force?: boolean;
  readonly message?: string;
  readonly preview?: boolean;
  readonly push?: boolean;
  readonly redact?: boolean;
  readonly team?: string;
}

function runShareBundleTool(config: RuntimeConfig, manifestPath: string, options: ShareBundleToolOptions) {
  return shareBundlePack(config, manifestPath, options).pipe(
    Effect.map(result => {
      const lines = [...result.messages, ...result.gitMessages];
      if (result.previewContent !== undefined) {
        lines.push('-----BEGIN PREVIEW-----');
        lines.push(result.previewContent);
        lines.push('-----END PREVIEW-----');
      }
      return {content: [{type: 'text' as const, text: lines.join('\n')}], isError: false};
    }),
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
  );
}

const runThreadnoteGuideTool = Effect.fn('mcp_server.runThreadnoteGuideTool')(function* (
  config: RuntimeConfig,
  toolset: McpToolset,
) {
  const serverUp = yield* probeServerUp(config);
  const context = yield* gatherOnboardingContext(config);
  const text = buildOnboardingGuide({...context, serverUp, toolset});
  return {content: [{type: 'text', text}], isError: false};
});

const probeServerUp = Effect.fn('mcp_server.probeServerUp')(function* (config: RuntimeConfig) {
  return yield* runOpenVikingMcpTool(config, 'health', {}).pipe(
    Effect.map(result => result.isError !== true),
    Effect.catch(() => Effect.succeed(false)),
  );
});

function runListSharedSkillsTool(config: RuntimeConfig, options: SharedSkillFilterOptions) {
  return listSharedAgentArtifacts(config, options).pipe(
    Effect.map(result => {
      const lines = shareArtifactToolHeader(result.team, result.syncedTeams, result.warnings);
      if (result.artifacts.length === 0) {
        lines.push(`No shared skills or commands found for team "${result.team}".`);
      } else {
        lines.push(`Shared skills and commands for team "${result.team}":`);
        for (const artifact of result.artifacts) {
          lines.push(
            `- ${artifact.artifact.kind} ${artifact.artifact.agent}/${artifact.artifact.name} (${artifact.installStatus})`,
          );
          lines.push(
            `  install: install_shared_skill({"name":"${artifact.artifact.name}","agent":"${artifact.artifact.agent}","kind":"${artifact.artifact.kind}"})`,
          );
        }
      }
      return {content: [{type: 'text' as const, text: lines.join('\n')}], isError: false};
    }),
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
  );
}

function runInstallSharedSkillTool(config: RuntimeConfig, name: string, options: InstallSharedSkillToolOptions) {
  return installSharedAgentArtifacts(config, {
    ...options,
    apply: options.dryRun !== true,
    name,
  }).pipe(
    Effect.map(result => ({
      content: [
        {
          type: 'text' as const,
          text: [...shareArtifactToolHeader(result.team, result.syncedTeams, result.warnings), ...result.messages].join(
            '\n',
          ),
        },
      ],
      isError: false,
    })),
    Effect.catch(error =>
      Effect.succeed({content: [{type: 'text' as const, text: errorMessage(error)}], isError: true}),
    ),
  );
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

const requiredOpenVikingCli = Effect.fn('mcp_server.requiredOpenVikingCli')(function* () {
  const command = yield* findOpenVikingCli();
  if (!command) {
    throw new Error('Neither ov nor openviking was found. Run threadnote install first.');
  }
  return command;
});

NodeRuntime.runMain(Effect.scoped(mainEffect).pipe(Effect.provide(ApplicationLayer)), {disableErrorReporting: false});
