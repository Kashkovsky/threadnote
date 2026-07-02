#! /usr/bin/env node

import {Command} from 'commander';
import {DEFAULT_HOST, DEFAULT_PORT, OPENVIKING_MCP_NAME} from './constants.js';
import type {
  ArchiveOptions,
  CompactOptions,
  DoctorOptions,
  ForgetOptions,
  HandoffOptions,
  HookRunnerOptions,
  HooksInstallOptions,
  InitManifestOptions,
  InstallOptions,
  ListOptions,
  ManageOptions,
  MigrateLifecycleOptions,
  McpInstallOptions,
  MigrateMemoriesOptions,
  PackOptions,
  PostUpdateOptions,
  ReadOptions,
  RecallOptions,
  RememberOptions,
  RepairOptions,
  SeedOptions,
  ShareInstallArtifactsOptions,
  ShareInitOptions,
  ShareListOptions,
  SharePublishArtifactOptions,
  SharePublishOptions,
  ShareRenameOptions,
  ShareRemoveOptions,
  ShareSetUrlOptions,
  ShareStatusOptions,
  ShareSyncOptions,
  ShareUnpublishOptions,
  StartOptions,
  UninstallOptions,
  UpdateOptions,
  VersionOptions,
} from './types.js';
import {parseHookClient, runHooksInstall, runPreCompactHook, runSessionStartHook} from './hooks.js';
import {collectOption, errorMessage, parsePort} from './utils.js';
import {parseAgentClient, parseClaudeMcpScope, runMcpInstall} from './mcp.js';
import {getRuntimeConfig} from './runtime.js';
import {
  parseCompactKind,
  parseMemoryKind,
  parseMemoryStatus,
  runArchive,
  runCompact,
  runExportPack,
  runForget,
  runHandoff,
  runImportPack,
  runList,
  runMigrateLifecycle,
  runMigrateMemories,
  runRead,
  runRecall,
  runRemember,
} from './memory.js';
import {runInitManifest, runSeed, runSeedSkills, runWorksetList, runWorksetShow} from './seeding.js';
import {
  runShareInit,
  runShareInstallArtifacts,
  runShareList,
  runSharePublish,
  runSharePublishArtifact,
  runSharePublishBundle,
  runShareRename,
  runShareRemove,
  runShareSetUrl,
  runShareStatus,
  runShareSync,
  runShareUnpublish,
} from './share.js';
import {parsePackageManager, runDoctor, runInstall, runRepair, runStart, runStop, runUninstall} from './lifecycle.js';
import {maybeNotifyUpdate, parseUpdateRuntime, runPostUpdate, runUpdate} from './update.js';
import {runVersion} from './version_command.js';
import {runManage} from './manager.js';

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('threadnote')
    .description('Threadnote shared context workflow for development agents')
    .showHelpAfterError()
    .option('--home <path>', 'Override THREADNOTE_HOME for this invocation')
    .option('--manifest <path>', 'Override THREADNOTE_MANIFEST for this invocation')
    .option('--host <host>', 'OpenViking host', DEFAULT_HOST)
    .option('--port <port>', 'OpenViking port', parsePort, DEFAULT_PORT);

  program
    .command('manage')
    .description('Open the local Threadnote web manager')
    .option('--ui-port <port>', 'Port for the local manager UI; defaults to a random free port')
    .option('--no-open', 'Start the manager without opening a browser')
    .action(async (options: ManageOptions) => {
      await runManage(getRuntimeConfig(program), options);
    });

  program
    .command('doctor')
    .description('Check local prerequisites, config files, manifest shape, and server health')
    .option('--dry-run', 'Show checks without writing anything')
    .option('--strict', 'Exit non-zero if any check fails')
    .action(async (options: DoctorOptions) => {
      const config = getRuntimeConfig(program);
      await runDoctor(config, options);
      await maybeNotifyUpdate(config, {dryRun: options.dryRun === true});
    });

  program
    .command('install')
    .description('Install OpenViking, local config files, command shim, and user-level agent instructions')
    .option('--dry-run', 'Print the actions without making changes')
    .option('--force', 'Reinstall OpenViking at the pinned version even if a working install is already present')
    .option('--no-start', 'Do not start OpenViking or check server health after installing')
    .option('--package-manager <manager>', 'uv, pipx, or pip', parsePackageManager)
    .option(
      '--with-hooks',
      'Also install agent-side hooks (Claude PreCompact + SessionStart) for deterministic handoff snapshots and context preload',
    )
    .action(async (options: InstallOptions) => {
      const config = getRuntimeConfig(program);
      await runInstall(config, options);
      if (options.withHooks === true) {
        const dryRun = options.dryRun === true;
        for (const agent of ['claude', 'codex', 'cursor', 'copilot'] as const) {
          console.log(`\n--- ${agent} hooks ---`);
          await runHooksInstall(config, agent, {apply: !dryRun, dryRun});
        }
      }
      await maybeNotifyUpdate(config, {dryRun: options.dryRun === true});
    });

  program
    .command('version')
    .description('Print the installed Threadnote version, latest npm version, and release notes')
    .option('--registry <url>', 'npm registry URL')
    .option('--allow-untrusted-registry', 'Allow a non-default npm registry without package signature verification')
    .action(async (options: VersionOptions) => {
      await runVersion(getRuntimeConfig(program), options);
    });

  program
    .command('update')
    .description('Update the published Threadnote package, then repair local shims and MCP config')
    .option('--check', 'Only check whether a newer version is available')
    .option('--dry-run', 'Print update and repair commands without running them')
    .option('--force', 'Run package-manager update even if this version is already current')
    .option('--registry <url>', 'npm registry URL')
    .option('--allow-untrusted-registry', 'Allow a non-default npm registry without package signature verification')
    .option('--runtime <runtime>', 'auto, npm, bun, or deno', parseUpdateRuntime, 'auto')
    .option('--no-repair', 'Skip threadnote repair after updating the package')
    .option('--no-post-update', 'Skip post-update migration prompts')
    .option('--yes', 'Accept applicable post-update migrations without prompting')
    .action(async (options: UpdateOptions) => {
      await runUpdate(getRuntimeConfig(program), options);
    });

  program
    .command('post-update', {hidden: true})
    .description('Run packaged post-update migration prompts')
    .requiredOption('--from-version <version>', 'Version before update')
    .requiredOption('--to-version <version>', 'Version after update')
    .option('--dry-run', 'Print post-update actions without running them')
    .option('--yes', 'Accept applicable post-update migrations without prompting')
    .action(async (options: PostUpdateOptions) => {
      await runPostUpdate(getRuntimeConfig(program), options);
    });

  program
    .command('repair')
    .description('Repair local OpenViking install, config files, server health, shim, manifest, and MCP config')
    .option('--dry-run', 'Print the repair actions without making changes')
    .option(
      '--mcp <clients>',
      'MCP clients to repair: available, all, none, codex, claude, cursor, copilot, or comma-separated list',
      'available',
    )
    .option('--no-start', 'Do not start OpenViking if health is failing')
    .option('--no-post-update', 'Skip post-update migration prompts after repair')
    .option('--package-manager <manager>', 'uv, pipx, or pip', parsePackageManager)
    .action(async (options: RepairOptions) => {
      const config = getRuntimeConfig(program);
      await runRepair(config, options);
      await maybeNotifyUpdate(config, {dryRun: options.dryRun === true});
    });

  program
    .command('start')
    .description('Start the local OpenViking server')
    .option('--dry-run', 'Print the start command without running it')
    .option('--foreground', 'Run in the foreground instead of detaching')
    .option('--launchd', 'Install and start a macOS LaunchAgent')
    .action(async (options: StartOptions) => {
      const config = getRuntimeConfig(program);
      await runStart(config, options);
      await maybeNotifyUpdate(config, {dryRun: options.dryRun === true});
    });

  program
    .command('stop')
    .description('Stop the local OpenViking server or LaunchAgent')
    .option('--dry-run', 'Print the stop actions without running them')
    .action(async (options: ForgetOptions) => {
      await runStop(getRuntimeConfig(program), options);
    });

  program
    .command('uninstall')
    .description('Remove Threadnote setup and optionally erase local memories')
    .option('--dry-run', 'Print uninstall actions without making changes')
    .option(
      '--mcp <clients>',
      'MCP clients to remove: available, all, none, codex, claude, cursor, copilot, or comma-separated list',
      'available',
    )
    .option('--preserve-memories', 'Preserve THREADNOTE_HOME and OpenViking memories (default)')
    .option('--erase-memories', 'Delete THREADNOTE_HOME, including all OpenViking memories')
    .action(async (options: UninstallOptions) => {
      await runUninstall(getRuntimeConfig(program), options);
    });

  program
    .command('seed')
    .description('Seed curated context from the manifest; never indexes whole repos by default')
    .option('--dry-run', 'Print files and ov commands without importing')
    .option('--force', 'Re-upload every candidate even if mtime+size match the recorded state')
    .option(
      '--graph',
      'Also seed a per-project .graph.md dependency-facts resource (package.json/go.mod), with [[project]] cross-repo edges',
    )
    .option('--manifest <path>', 'Manifest path for this seed run')
    .option(
      '--only <project>',
      'Restrict seeding to one or more manifest projects by name; repeat for multiple',
      collectOption,
      [],
    )
    .action(async (options: SeedOptions) => {
      await runSeed(getRuntimeConfig(program, options.manifest), options);
    });

  program
    .command('init-manifest')
    .description('Create or update a per-developer seed manifest from one or more repo roots')
    .option('--dry-run', 'Print the manifest without writing it')
    .option('--path <path>', 'Manifest path; defaults to THREADNOTE_MANIFEST or ~/.openviking/seed-manifest.yaml')
    .option('--replace', 'Replace the manifest instead of merging with existing projects')
    .option('--repo <path>', 'Repo root to include; repeat for multiple repos', collectOption, [])
    .action(async (options: InitManifestOptions) => {
      await runInitManifest(getRuntimeConfig(program), options);
    });

  program
    .command('seed-skills')
    .description('Seed Codex/Claude skills and Claude command markdown files as a searchable catalog')
    .option('--dry-run', 'Print skill files and ov commands without importing')
    .option('--manifest <path>', 'Manifest path for repo-local skill discovery')
    .option('--native', 'Use native OpenViking skill ingestion; requires a working VLM config')
    .action(async (options: SeedOptions) => {
      await runSeedSkills(getRuntimeConfig(program, options.manifest), options);
    });

  program
    .command('mcp-install')
    .description('Install OpenViking MCP config for a supported agent')
    .argument('<agent>', 'codex, claude, cursor, or copilot')
    .option('--apply', 'Actually modify the selected agent config')
    .option('--name <name>', 'MCP server name', OPENVIKING_MCP_NAME)
    .option('--native-http', 'Install OpenViking native HTTP MCP endpoint instead of the local stdio adapter')
    .option('--scope <scope>', 'Claude MCP config scope: user, local, or project', parseClaudeMcpScope, 'user')
    .option('--url <url>', 'OpenViking native HTTP MCP URL')
    .option('--bearer-token-env-var <name>', 'Environment variable containing the local API key')
    .action(async (agent: string, options: McpInstallOptions) => {
      await runMcpInstall(getRuntimeConfig(program), parseAgentClient(agent), options);
    });

  program
    .command('install-hooks')
    .description(
      'Install deterministic agent hooks (Claude PreCompact + SessionStart). Soft instruction files remain the cross-agent guidance surface; hooks add a deterministic safety net where the agent supports it.',
    )
    .argument('<agent>', 'codex, claude, cursor, or copilot')
    .option('--apply', 'Actually modify the selected agent config')
    .option('--dry-run', 'Print the planned change without applying it')
    .option('--remove', 'Remove threadnote-managed hook entries instead of adding them')
    .action(async (agent: string, options: HooksInstallOptions) => {
      await runHooksInstall(getRuntimeConfig(program), parseHookClient(agent), options);
    });

  program
    .command('pre-compact-hook', {hidden: true})
    .description(
      'Hook entry point: store a handoff snapshot before context compaction. Used by `install-hooks claude`.',
    )
    .option('--dry-run', 'Print the handoff payload without writing it')
    .action(async (options: HookRunnerOptions) => {
      await runPreCompactHook(getRuntimeConfig(program), options);
    });

  program
    .command('session-start-hook', {hidden: true})
    .description(
      'Hook entry point: print the latest threadnote handoff/feature memory for the current repo so Claude can preload it.',
    )
    .option('--dry-run', 'Print the planned ov command without running it')
    .action(async (options: HookRunnerOptions) => {
      await runSessionStartHook(getRuntimeConfig(program), options);
    });

  program
    .command('remember')
    .description('Store a durable engineering memory in OpenViking')
    .option('--dry-run', 'Print memory and ov command without storing')
    .option('--kind <kind>', 'durable, handoff, incident, preference, or smoke', parseMemoryKind, 'durable')
    .option('--project <name>', 'Project/repo/topic namespace for lifecycle-aware storage')
    .option('--replace <uri>', 'Supersede an existing viking:// memory after the new memory is stored')
    .option('--source-agent-client <name>', 'codex, claude, cursor, copilot, or another client name', 'codex')
    .option('--status <status>', 'active, archived, or superseded', parseMemoryStatus, 'active')
    .option('--stdin', 'Read memory text from stdin')
    .option('--text <text>', 'Memory text to store')
    .option('--topic <name>', 'Stable topic name; active memories with the same project/topic update one file')
    .action(async (options: RememberOptions) => {
      await runRemember(getRuntimeConfig(program), options);
    });

  program
    .command('migrate-memories')
    .description('Migrate legacy session-only Threadnote memories into durable memory files')
    .option('--all-accounts', 'Scan all local OpenViking accounts under THREADNOTE_HOME')
    .option('--dry-run', 'Print migration actions without writing memories')
    .option('--limit <count>', 'Maximum number of memories to migrate')
    .option(
      '--source-account <account>',
      'Source OpenViking account to scan; repeat for multiple accounts',
      collectOption,
      [],
    )
    .action(async (options: MigrateMemoriesOptions) => {
      await runMigrateMemories(getRuntimeConfig(program), options);
    });

  program
    .command('migrate-lifecycle')
    .description('Move clear legacy handoff memories into lifecycle-aware archive paths')
    .option('--apply', 'Perform the migration; without this, prints a dry run')
    .option('--dry-run', 'Print migration actions without writing or removing memories')
    .option('--limit <count>', 'Maximum number of legacy handoffs to migrate')
    .action(async (options: MigrateLifecycleOptions) => {
      await runMigrateLifecycle(getRuntimeConfig(program), options);
    });

  program
    .command('recall')
    .description('Search shared OpenViking context')
    .requiredOption('--query <query>', 'Search query')
    .option('--dry-run', 'Print ov command without searching')
    .option('--include-archived', 'Include archived memories in recall results')
    .option('-n, --node-limit <count>', 'Maximum number of search results')
    .option('--no-infer-scope', 'Disable query-based scope inference')
    .option('--project <name>', 'Prioritize a project: add a scoped pass over its memories alongside the global search')
    .option('--threshold <score>', 'Minimum relevance score 0-1 (default 0.45); lower to broaden when recall is empty')
    .option('--uri <uri>', 'Restrict search to a viking:// URI')
    .option(
      '--workset <name>',
      'Recall across a named seed-manifest workset (a set of related repos) as one working set',
    )
    .action(async (options: RecallOptions) => {
      await runRecall(getRuntimeConfig(program), options);
    });

  const workset = program
    .command('workset')
    .description('Inspect seed-manifest worksets (named sets of related repos recalled as one working set)');

  workset
    .command('list')
    .description('List worksets defined in the seed manifest')
    .action(async () => {
      await runWorksetList(getRuntimeConfig(program));
    });

  workset
    .command('show')
    .description('Show the member projects of a workset')
    .argument('<name>', 'Workset name')
    .action(async (name: string) => {
      await runWorksetShow(getRuntimeConfig(program), name);
    });

  program
    .command('compact')
    .description('Plan or apply scoped memory hygiene for active personal memories')
    .requiredOption('--project <name>', 'Project/repo namespace to inspect')
    .option('--apply', 'Apply the compact plan; without this, prints a dry run')
    .option('--dry-run', 'Print the compact plan without changing anything')
    .option('--kind <kind>', 'durable, handoff, or incident', parseCompactKind)
    .option('--topic <name>', 'Stable topic name to inspect')
    .action(async (options: CompactOptions) => {
      await runCompact(getRuntimeConfig(program), options);
    });

  program
    .command('read')
    .description('Read a viking:// URI returned by recall or list')
    .argument('<uri>', 'viking:// URI to read')
    .option('--dry-run', 'Print ov command without reading')
    .action(async (uri: string, options: ReadOptions) => {
      await runRead(getRuntimeConfig(program), uri, options);
    });

  program
    .command('list')
    .alias('ls')
    .description('List a viking:// directory')
    .argument('[uri]', 'viking:// URI to list', 'viking://')
    .option('-a, --all', 'Show hidden files such as .abstract.md and .overview.md')
    .option('--dry-run', 'Print ov command without listing')
    .option('-n, --node-limit <count>', 'Maximum number of nodes to list')
    .option('-r, --recursive', 'List subdirectories recursively')
    .option('-s, --simple', 'Print only paths')
    .action(async (uri: string, options: ListOptions) => {
      await runList(getRuntimeConfig(program), uri, options);
    });

  program
    .command('handoff')
    .description('Capture current repo state as a durable cross-agent handoff memory')
    .option('--blockers <text>', 'Known blockers')
    .option('--ci <text>', 'Captured CI status snapshot (free text; not a live status board)')
    .option('--dry-run', 'Print handoff without storing')
    .option('--issue <text>', 'Related issue reference (number or URL)')
    .option('--next-step <text>', 'Suggested next step')
    .option('--pr <text>', 'Related pull request reference (number or URL)')
    .option('--project <name>', 'Project/repo namespace; defaults to current repo basename')
    .option(
      '--reference <uri>',
      'viking:// memory to record as one-way read-only prior context; repeat for multiple',
      collectOption,
      [],
    )
    .option('--replace <uri>', 'Supersede an existing viking:// memory after the new handoff is stored')
    .option('--source-agent-client <name>', 'codex, claude, cursor, copilot, or another client name', 'codex')
    .option('--task <text>', 'Current task summary')
    .option('--tests <text>', 'Tests or checks run')
    .option('--timestamped', 'Store a historical timestamped handoff instead of updating the current branch handoff')
    .option('--topic <name>', 'Stable topic name; active handoffs with the same project/topic update one file')
    .action(async (options: HandoffOptions & {readonly reference?: readonly string[]}) => {
      await runHandoff(getRuntimeConfig(program), {...options, references: options.reference});
    });

  program
    .command('archive')
    .description('Move a memory into the archived lifecycle tree, then remove the original after the archive is stored')
    .argument('<uri>', 'viking:// memory URI to archive')
    .option('--dry-run', 'Print archive content and ov commands without changing anything')
    .option('--kind <kind>', 'durable, handoff, incident, preference, or smoke', parseMemoryKind)
    .option('--project <name>', 'Override inferred project/repo namespace')
    .option('--topic <name>', 'Override inferred topic')
    .action(async (uri: string, options: ArchiveOptions) => {
      await runArchive(getRuntimeConfig(program), uri, options);
    });

  program
    .command('forget')
    .description('Remove a viking:// URI from local OpenViking context')
    .argument('<uri>', 'viking:// URI to remove')
    .option('--dry-run', 'Print ov command without deleting')
    .action(async (uri: string, options: ForgetOptions) => {
      await runForget(getRuntimeConfig(program), uri, options);
    });

  const share = program
    .command('share')
    .description('Share durable memories with teammates through a git-backed repository');

  share
    .command('init')
    .description('Configure a shared memories repo for a team (clones the remote into the local memory tree)')
    .argument('<remote-url>', 'git remote URL of the shared memories repo')
    .option('--team <name>', 'Team name; defaults to "default"')
    .option('--set-default', 'Mark this team as the default for future share commands')
    .option(
      '--no-push',
      'Do not push the auto-generated .gitignore housekeeping commit. Does not affect future publishes.',
    )
    .option('--dry-run', 'Print actions without running them')
    .action(async (remoteUrl: string, options: ShareInitOptions) => {
      await runShareInit(getRuntimeConfig(program), remoteUrl, options);
    });

  share
    .command('status')
    .description('Show git status and ahead/behind counts for a shared team')
    .option('--team <name>', 'Team name; defaults to the configured default team')
    .option('--dry-run', 'Print git commands without running them')
    .action(async (options: ShareStatusOptions) => {
      await runShareStatus(getRuntimeConfig(program), options);
    });

  share
    .command('sync')
    .description('Pull, reindex, and push the shared memories repo for a team')
    .option('--team <name>', 'Team name; defaults to the configured default team')
    .option('--message <text>', 'Commit message when auto-committing local edits')
    .option('--no-auto-commit', 'Refuse to sync if there are uncommitted local changes')
    .option('--no-push', 'Skip the push step after pulling and reindexing')
    .option('--dry-run', 'Print actions without running them')
    .action(async (options: ShareSyncOptions) => {
      await runShareSync(getRuntimeConfig(program), options);
    });

  share
    .command('publish')
    .description('Move a personal memory into the shared team namespace, commit and push')
    .argument('<viking-uri>', 'viking:// memory URI to publish')
    .option('--team <name>', 'Team name; defaults to the configured default team')
    .option('--message <text>', 'Commit message override')
    .option('--no-push', 'Skip the push step')
    .option('--dry-run', 'Print actions without running them')
    .option(
      '--preview',
      'Print the exact bytes that would land in the shared git repo (after frontmatter strip and scrubber redaction) without writing, committing, or pushing',
    )
    .option(
      '--redact',
      'Replace soft-leak matches (local paths) with placeholders and continue; credentials still block',
    )
    .action(async (uri: string, options: SharePublishOptions) => {
      await runSharePublish(getRuntimeConfig(program), uri, options);
    });

  share
    .command('publish-artifact')
    .description('Publish a local Codex/Claude skill or Claude command into the shared team repo')
    .argument('<path>', 'Path to SKILL.md or a Claude command markdown file')
    .option('--team <name>', 'Team name; defaults to the configured default team')
    .option('--agent <agent>', 'Agent owner when path inference is ambiguous: codex or claude')
    .option('--kind <kind>', 'Artifact kind when path inference is ambiguous: skill or command')
    .option('--name <name>', 'Shared artifact name; defaults to skill directory or command file stem')
    .option('--message <text>', 'Commit message override')
    .option('--force', 'Replace an existing shared artifact with different content')
    .option('--allow-binary', 'Include binary skill files (unscannable by the scrubber); blocked by default')
    .option('--no-push', 'Skip the push step')
    .option('--dry-run', 'Print actions without running them')
    .option('--preview', 'Print what would land in the shared git repo without writing or committing')
    .option(
      '--redact',
      'Replace soft-leak matches (local paths) with placeholders and continue; credentials still block',
    )
    .action(async (path: string, options: SharePublishArtifactOptions) => {
      await runSharePublishArtifact(getRuntimeConfig(program), path, options);
    });

  share
    .command('publish-bundle')
    .description('Publish a multi-skill constellation (pack) declared by a threadnote-bundle.json manifest')
    .argument('<manifest>', 'Path to a threadnote-bundle.json manifest')
    .option('--team <name>', 'Team name; defaults to the configured default team')
    .option('--message <text>', 'Commit message override')
    .option('--force', 'Replace existing shared pack files with different content')
    .option('--allow-binary', 'Include binary files (unscannable by the scrubber); blocked by default')
    .option('--no-push', 'Skip the push step')
    .option('--dry-run', 'Print actions without running them')
    .option('--preview', 'Print what would land in the shared git repo without writing or committing')
    .option(
      '--redact',
      'Replace soft-leak matches (local paths) with placeholders and continue; credentials still block',
    )
    .action(async (manifest: string, options: SharePublishArtifactOptions) => {
      await runSharePublishBundle(getRuntimeConfig(program), manifest, options);
    });

  share
    .command('install-artifacts')
    .description('Install shared Codex/Claude skills and Claude commands from a team repo')
    .option('--team <name>', 'Team name; defaults to the configured default team')
    .option('--agent <agent>', 'Install only artifacts for this agent: codex or claude')
    .option('--kind <kind>', 'Install only artifacts of this kind: skill or command')
    .option('--name <name>', 'Install only this shared artifact name')
    .option('--apply', 'Actually write files into local agent skill/command directories')
    .option('--force', 'Replace existing installed artifacts with different content')
    .option('--no-sync', 'Skip pulling shared team updates before listing/installing artifacts')
    .option('--dry-run', 'Preview install actions without writing files')
    .action(async (options: ShareInstallArtifactsOptions) => {
      await runShareInstallArtifacts(getRuntimeConfig(program), options);
    });

  share
    .command('unpublish')
    .description('Pull a shared memory back into the personal namespace, commit removal and push')
    .argument('<viking-uri>', 'viking:// memory URI inside a team shared subtree')
    .option('--team <name>', 'Team name; defaults to the configured default team')
    .option('--message <text>', 'Commit message override')
    .option('--no-push', 'Skip the push step')
    .option('--dry-run', 'Print actions without running them')
    .action(async (uri: string, options: ShareUnpublishOptions) => {
      await runShareUnpublish(getRuntimeConfig(program), uri, options);
    });

  share
    .command('list')
    .description('List configured shared teams')
    .option('--dry-run', 'Print without side effects (no-op for list)')
    .action(async (options: ShareListOptions) => {
      await runShareList(getRuntimeConfig(program), options);
    });

  share
    .command('rename')
    .description('Rename a configured shared team')
    .requiredOption('--team <name>', 'Existing team name')
    .requiredOption('--to <name>', 'New team name')
    .option('--dry-run', 'Print actions without running them')
    .action(async (options: ShareRenameOptions) => {
      await runShareRename(getRuntimeConfig(program), options);
    });

  share
    .command('set-url')
    .description('Change the git remote URL for a configured shared team')
    .argument('<remote-url>', 'New git remote URL')
    .option('--team <name>', 'Team name; defaults to the configured default team')
    .option('--dry-run', 'Print actions without running them')
    .action(async (remoteUrl: string, options: ShareSetUrlOptions) => {
      await runShareSetUrl(getRuntimeConfig(program), remoteUrl, options);
    });

  share
    .command('remove')
    .description('Forget a configured team and optionally delete its worktree/gitdir')
    .option('--team <name>', 'Team name; defaults to the configured default team')
    .option('--keep-files', 'Keep the worktree and gitdir on disk; only forget the team entry')
    .option('--preserve-local', 'Copy shared durable memories into the personal tree before removing the team')
    .option('--dry-run', 'Print actions without running them')
    .action(async (options: ShareRemoveOptions) => {
      await runShareRemove(getRuntimeConfig(program), options);
    });

  program
    .command('export-pack')
    .description('Export local OpenViking context to an .ovpack')
    .option('--dry-run', 'Print ov command without exporting')
    .option('--path <path>', 'Output .ovpack path')
    .option('--uri <uri>', 'Source viking:// URI to export', 'viking://')
    .action(async (options: PackOptions) => {
      await runExportPack(getRuntimeConfig(program), options);
    });

  program
    .command('import-pack')
    .description('Import an .ovpack into local OpenViking context')
    .requiredOption('--path <path>', 'Input .ovpack path')
    .option('--dry-run', 'Print ov command without importing')
    .option('--target-uri <uri>', 'Target parent viking:// URI', 'viking://')
    .action(async (options: PackOptions) => {
      await runImportPack(getRuntimeConfig(program), options);
    });

  await program.parseAsync(process.argv);
}

main().catch(err => {
  console.error(errorMessage(err));
  process.exit(1);
});
