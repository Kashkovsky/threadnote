#! /usr/bin/env node

import {Command} from 'commander';
import {DEFAULT_HOST, DEFAULT_PORT, OPENVIKING_MCP_NAME} from './constants.js';
import type {
  DoctorOptions,
  ForgetOptions,
  HandoffOptions,
  InitManifestOptions,
  InstallOptions,
  ListOptions,
  McpInstallOptions,
  MigrateMemoriesOptions,
  PackOptions,
  ReadOptions,
  RecallOptions,
  RememberOptions,
  RepairOptions,
  SeedOptions,
  StartOptions,
  UninstallOptions,
  UpdateOptions,
} from './types.js';
import {collectOption, errorMessage, parsePort} from './utils.js';
import {parseAgentClient, parseClaudeMcpScope, runMcpInstall} from './mcp.js';
import {getRuntimeConfig} from './runtime.js';
import {
  runExportPack,
  runForget,
  runHandoff,
  runImportPack,
  runList,
  runMigrateMemories,
  runRead,
  runRecall,
  runRemember,
} from './memory.js';
import {runInitManifest, runSeed, runSeedSkills} from './seeding.js';
import {parsePackageManager, runDoctor, runInstall, runRepair, runStart, runStop, runUninstall} from './lifecycle.js';
import {maybeNotifyUpdate, parseUpdateRuntime, runUpdate} from './update.js';

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
    .option('--package-manager <manager>', 'pipx, uv, or pip', parsePackageManager)
    .action(async (options: InstallOptions) => {
      const config = getRuntimeConfig(program);
      await runInstall(config, options);
      await maybeNotifyUpdate(config, {dryRun: options.dryRun === true});
    });

  program
    .command('update')
    .description('Update the published Threadnote package, then repair local shims and MCP config')
    .option('--check', 'Only check whether a newer version is available')
    .option('--dry-run', 'Print update and repair commands without running them')
    .option('--force', 'Run package-manager update even if this version is already current')
    .option('--registry <url>', 'npm registry URL', process.env.THREADNOTE_NPM_REGISTRY)
    .option('--runtime <runtime>', 'auto, npm, bun, or deno', parseUpdateRuntime, 'auto')
    .option('--no-repair', 'Skip threadnote repair after updating the package')
    .action(async (options: UpdateOptions) => {
      await runUpdate(getRuntimeConfig(program), options);
    });

  program
    .command('repair')
    .description('Repair local OpenViking install, config files, server health, shim, manifest, and MCP config')
    .option('--dry-run', 'Print the repair actions without making changes')
    .option(
      '--mcp <clients>',
      'MCP clients to repair: available, all, none, codex, claude, cursor, or comma-separated list',
      'available',
    )
    .option('--no-start', 'Do not start OpenViking if health is failing')
    .option('--package-manager <manager>', 'pipx, uv, or pip', parsePackageManager)
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
      'MCP clients to remove: available, all, none, codex, claude, cursor, or comma-separated list',
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
    .option('--manifest <path>', 'Manifest path for this seed run')
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
    .description('Seed Codex, Claude, and repo-local SKILL.md files as a searchable catalog')
    .option('--dry-run', 'Print skill files and ov commands without importing')
    .option('--manifest <path>', 'Manifest path for repo-local skill discovery')
    .option('--native', 'Use native OpenViking skill ingestion; requires a working VLM config')
    .action(async (options: SeedOptions) => {
      await runSeedSkills(getRuntimeConfig(program, options.manifest), options);
    });

  program
    .command('mcp-install')
    .description('Install OpenViking MCP config for a supported agent')
    .argument('<agent>', 'codex, claude, or cursor')
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
    .command('remember')
    .description('Store a durable engineering memory in OpenViking')
    .option('--dry-run', 'Print memory and ov command without storing')
    .option('--source-agent-client <name>', 'codex, claude, cursor, gemini, or another client name', 'codex')
    .option('--stdin', 'Read memory text from stdin')
    .option('--text <text>', 'Memory text to store')
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
    .command('recall')
    .description('Search shared OpenViking context')
    .requiredOption('--query <query>', 'Search query')
    .option('--dry-run', 'Print ov command without searching')
    .option('-n, --node-limit <count>', 'Maximum number of search results')
    .option('--no-infer-scope', 'Disable query-based scope inference')
    .option('--uri <uri>', 'Restrict search to a viking:// URI')
    .action(async (options: RecallOptions) => {
      await runRecall(getRuntimeConfig(program), options);
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
    .option('--dry-run', 'Print handoff without storing')
    .option('--next-step <text>', 'Suggested next step')
    .option('--source-agent-client <name>', 'codex, claude, cursor, gemini, or another client name', 'codex')
    .option('--task <text>', 'Current task summary')
    .option('--tests <text>', 'Tests or checks run')
    .action(async (options: HandoffOptions) => {
      await runHandoff(getRuntimeConfig(program), options);
    });

  program
    .command('forget')
    .description('Remove a viking:// URI from local OpenViking context')
    .argument('<uri>', 'viking:// URI to remove')
    .option('--dry-run', 'Print ov command without deleting')
    .action(async (uri: string, options: ForgetOptions) => {
      await runForget(getRuntimeConfig(program), uri, options);
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
