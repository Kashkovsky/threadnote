import {spawn} from 'node:child_process';
import {closeSync, openSync} from 'node:fs';
import {chmod, readFile, realpath, writeFile} from 'node:fs/promises';
import {platform} from 'node:os';
import {dirname, join} from 'node:path';
import {stdin as processStdin, stdout as processStdout} from 'node:process';
import {createInterface} from 'node:readline/promises';
import yaml from 'js-yaml';
import {
  LAUNCHD_LABEL,
  OPENVIKING_MCP_NAME,
  OPENVIKING_PACKAGE_NAME,
  OPENVIKING_SERVER_COMMAND,
  OPENVIKING_TOOL_PYTHON,
  PYTHON_SYSTEM_CERTS_MODULE,
  PYTHON_SYSTEM_CERTS_PACKAGE,
  SHIM_MARKER,
  START_HEALTH_POLL_INTERVAL_MS,
  START_HEALTH_TIMEOUT_MS,
  USER_AGENT_INSTRUCTION_TARGETS,
  USER_INSTRUCTIONS_END_MARKER,
  USER_INSTRUCTIONS_START_MARKER,
} from './constants.js';
import {hasManagedClaudeHooks, runHooksInstall} from './hooks.js';
import {startProgress} from './cli_ui.js';
import {
  findStaleRecallIndexTargets,
  formatRecallIndexRepairMessages,
  MAINTENANCE_COLLAPSE_DEPTH,
  MAINTENANCE_CONSECUTIVE_FAILURE_LIMIT,
  MAINTENANCE_MAX_REPAIR_TARGETS,
  repairStaleRecallIndex,
  summaryAutoGenerationDisabled,
} from './index_repair.js';
import {readSeedManifest} from './manifest.js';
import {removeMcpConfigs, removeMcpSnippets, resolveMcpClients, runMcpInstall} from './mcp.js';
import {maybeRunPostUpdateAfterRepair, readOpenVikingCliVersion} from './update.js';
import {
  builtInExampleManifestPath,
  openVikingHealthUrl,
  openVikingLogPath,
  openVikingServerArgs,
  renderTemplate,
  withIdentity,
} from './runtime.js';
import {projectManifestForRepo, resolveRepoRoot} from './seeding.js';
import type {
  DoctorCheck,
  DoctorOptions,
  ForgetOptions,
  InstallOptions,
  JsonObject,
  MappedCommand,
  PackageManager,
  RepairOptions,
  RuntimeConfig,
  StartOptions,
  UninstallOptions,
} from './types.js';
import {
  assertSafeThreadnoteHomeForErase,
  compareVersions,
  ensureDirectory,
  errorMessage,
  exists,
  expandPath,
  findExecutable,
  findOpenVikingCli,
  firstLine,
  formatShellCommand,
  formatStatus,
  getInvocationCwd,
  httpGetText,
  isExecutable,
  isJsonObject,
  isTcpPortOpen,
  maybeRun,
  parseJsonConfigObject,
  readFileIfExists,
  removePath,
  removePathIfExists,
  runCommand,
  runInteractive,
  safeTimestamp,
  shellQuote,
  sleep,
  suggestedShellRc,
  toolRoot,
} from './utils.js';

type UserAgentInstructionTarget = (typeof USER_AGENT_INSTRUCTION_TARGETS)[number];

export async function runDoctor(config: RuntimeConfig, options: DoctorOptions): Promise<void> {
  const checks = await collectDoctorChecks(config, options);

  for (const check of checks) {
    console.log(`${formatStatus(check.status)} ${check.name}: ${check.detail}`);
  }

  const failureCount = checks.filter(check => check.status === 'fail').length;
  const warningCount = checks.filter(check => check.status === 'warn').length;
  console.log(`\nSummary: ${failureCount} failure(s), ${warningCount} warning(s)`);
  if (options.strict === true && failureCount > 0) {
    process.exitCode = 1;
  }
}

export async function collectDoctorChecks(config: RuntimeConfig, options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push({name: 'mode', status: 'ok', detail: options.dryRun ? 'dry run; no writes' : 'read-only checks'});
  checks.push({name: 'platform', status: platform() === 'darwin' ? 'ok' : 'warn', detail: platform()});
  checks.push(await commandCheck('node', ['--version']));
  checks.push(await commandCheck('python3', ['--version']));
  checks.push(await openVikingServerCheck());
  checks.push(await openVikingCliCheck());
  checks.push(await openVikingVersionCheck(config));
  checks.push(await recallShapeCheck(config));
  checks.push(await localEmbeddingCheck());
  checks.push(await pythonSystemCertificatesCheck());
  checks.push(await firstCommandCheck('python installer', ['pipx', 'uv', 'pip3'], ['--version']));
  checks.push(await commandPresenceCheck('codex', ['--version']));
  checks.push(await commandPresenceCheck('claude', ['--version']));
  checks.push(await commandShimCheck());
  checks.push(...(await userAgentInstructionsChecks()));
  checks.push(await manifestCheck(config.manifestPath));
  checks.push(await recallIndexFreshnessCheck(config));
  checks.push(await fileCheck(join(toolRoot(), '.threadnoteignore'), 'ignore file'));
  checks.push(await fileCheck(join(toolRoot(), 'config', 'ov.conf.template.json'), 'server config template'));
  checks.push(await fileCheck(join(toolRoot(), 'config', 'ovcli.conf.template.json'), 'cli config template'));
  checks.push(await healthCheck(config));
  return checks;
}

export async function runInstall(config: RuntimeConfig, options: InstallOptions): Promise<void> {
  const repairInvalidConfigs = options.repairInvalidConfigs === true;
  const dryRun = options.dryRun === true;
  await ensureDirectory(config.agentContextHome, dryRun);
  await ensureDirectory(join(config.agentContextHome, 'logs'), dryRun);
  await ensureDirectory(join(config.agentContextHome, 'redacted'), dryRun);
  await ensureDirectory(join(config.agentContextHome, 'mcp'), dryRun);
  await installCommandShim(dryRun);
  await installUserAgentInstructions(dryRun);

  const serverPath = await findOpenVikingServer();
  // True only when an install/repair could have moved or created the
  // openviking-server binary itself. The python-certs branch patches the
  // existing Python env in place, so it does not flip this — the server
  // path is unchanged and the earlier resolution is still valid.
  let serverInstallRan = false;
  if (serverPath) {
    console.log(`OpenViking server already installed: ${serverPath}`);
    const localEmbeddingMissing = (await hasLocalEmbeddingDependency(serverPath)) === false;
    const pythonSystemCertificatesMissing = (await hasPythonSystemCertificatesPatch(serverPath)) === false;
    if (options.force === true) {
      console.log(`Reinstalling OpenViking at pinned version ${config.openVikingVersion} (--force).`);
      await runInstallCommands(config, options.packageManager, true, dryRun);
      serverInstallRan = true;
    } else if (localEmbeddingMissing) {
      const repairReasons: string[] = [];
      repairReasons.push('local embedding extra is missing');
      if (pythonSystemCertificatesMissing) {
        repairReasons.push('Python system certificate bridge is missing');
      }
      console.log(`OpenViking install needs repair: ${repairReasons.join('; ')}.`);
      await runInstallCommands(config, options.packageManager, true, dryRun);
      serverInstallRan = true;
    } else if (pythonSystemCertificatesMissing) {
      console.log('OpenViking install needs repair: Python system certificate bridge is missing.');
      const installCommand = await getPythonSystemCertificatesInstallCommand(serverPath);
      await maybeRun(dryRun, installCommand.executable, installCommand.args);
    }
  } else {
    await runInstallCommands(config, options.packageManager, false, dryRun);
    serverInstallRan = true;
  }
  const resolvedServerPath = serverInstallRan ? await findOpenVikingServer() : serverPath;
  if (serverInstallRan && !resolvedServerPath && !dryRun) {
    // The install command reported success but the binary is unresolvable.
    // Fail loudly for `install`; for `repair` (requireServerBinary === false)
    // warn and continue so config/manifest/MCP/hook repairs still run.
    const message =
      `OpenViking install ran but ${OPENVIKING_SERVER_COMMAND} was not found on PATH, in the uv tool bin dir, or ~/.local/bin. ` +
      'Re-run `threadnote install --force` (it streams the full build), then `threadnote doctor`.';
    if (options.requireServerBinary === false) {
      console.warn(`WARN ${message}`);
    } else {
      throw new Error(message);
    }
  }
  if (resolvedServerPath && !dryRun) {
    await maybePrintOpenVikingPathHint(resolvedServerPath);
  }

  await writeTemplateIfMissing({
    config,
    destinationPath: join(config.agentContextHome, 'ov.conf'),
    dryRun,
    shouldRepair: content =>
      shouldRepairOpenVikingConfig(content, config) ||
      (repairInvalidConfigs && parseJsonConfigObject(content) === undefined),
    templatePath: join(toolRoot(), 'config', 'ov.conf.template.json'),
  });
  await writeTemplateIfMissing({
    config,
    destinationPath: join(config.agentContextHome, 'ovcli.conf'),
    dryRun,
    shouldRepair: content =>
      shouldRepairLegacyOvCliConfig(content) || (repairInvalidConfigs && parseJsonConfigObject(content) === undefined),
    templatePath: join(toolRoot(), 'config', 'ovcli.conf.template.json'),
  });
  await configureOpenVikingCliLanguage(config, dryRun);

  if (options.start !== false) {
    const healthy = await repairServerHealth(config, dryRun);
    if (!healthy && !dryRun) {
      throw new Error(`OpenViking did not become healthy. Check logs: ${openVikingLogPath(config)}`);
    }
  }

  if (options.printNextSteps !== false) {
    printInstallNextSteps({dryRun, startsServer: options.start !== false});
  }
}

export async function runRepair(config: RuntimeConfig, options: RepairOptions): Promise<void> {
  const dryRun = options.dryRun === true;
  console.log('Repairing local OpenViking agent context from this checkout.');

  await runInstall(config, {
    dryRun,
    packageManager: options.packageManager,
    printNextSteps: false,
    repairInvalidConfigs: true,
    requireServerBinary: false,
    start: false,
  });
  await repairManifest(config, dryRun);

  if (options.start !== false) {
    await repairServerHealth(config, dryRun);
  } else {
    console.log('Skipping server health repair because --no-start was provided.');
  }
  await repairRecallIndex(config, dryRun);

  const mcpClients = await resolveMcpClients(options.mcp ?? 'available', 'repair');
  if (mcpClients.length === 0) {
    console.log('Skipping MCP config repair.');
  } else {
    for (const client of mcpClients) {
      console.log(`Repairing ${client} MCP config for ${OPENVIKING_MCP_NAME}.`);
      await runMcpInstall(config, client, {apply: !dryRun, name: OPENVIKING_MCP_NAME});
    }
  }

  // Re-install agent hooks only if the user opted in previously (a managed
  // entry already exists). Never adds them unsolicited — `install-hooks` or
  // `install --with-hooks` is the opt-in.
  if (await hasManagedClaudeHooks()) {
    console.log('\nRepairing claude hooks (re-asserting threadnote-managed entries).');
    await runHooksInstall(config, 'claude', {apply: !dryRun, dryRun});
  }

  console.log('\nPost-repair doctor:');
  await runDoctor(config, {dryRun, strict: false});
  if (options.postUpdate !== false) {
    await maybeRunPostUpdateAfterRepair(config, {dryRun});
  }
}

export async function runUninstall(config: RuntimeConfig, options: UninstallOptions): Promise<void> {
  const dryRun = options.dryRun === true;
  if (options.eraseMemories === true && options.preserveMemories === true) {
    throw new Error('Use either --erase-memories or --preserve-memories, not both.');
  }

  console.log('Uninstalling local Threadnote setup.');
  await runStop(config, {dryRun});
  await removePathIfExists(join(config.agentContextHome, 'openviking-server.pid'), 'pid file', dryRun);
  await removeLaunchAgent(dryRun);
  await removeMcpConfigs(options.mcp ?? 'available', dryRun);
  await removeMcpSnippets(config, dryRun);
  if (await hasManagedClaudeHooks()) {
    await runHooksInstall(config, 'claude', {apply: !dryRun, dryRun, remove: true});
  }
  await removeCommandShim(dryRun);
  await removeUserAgentInstructions(dryRun);

  if (options.eraseMemories === true) {
    await eraseThreadnoteHome(config.agentContextHome, dryRun);
  } else {
    console.log(`Preserving local memories and OpenViking home: ${config.agentContextHome}`);
    console.log('Use --erase-memories to delete this directory during uninstall.');
  }

  console.log('Uninstall complete.');
  console.log('The package remains installed. Remove it with your package manager if desired.');
}

async function repairManifest(config: RuntimeConfig, dryRun: boolean): Promise<void> {
  try {
    await readSeedManifest(config.manifestPath);
    console.log(`Manifest OK: ${config.manifestPath}`);
    return;
  } catch (err: unknown) {
    if (config.manifestPath === builtInExampleManifestPath()) {
      console.log(`WARN built-in manifest is not readable: ${errorMessage(err)}`);
      return;
    }
    console.log(`Manifest needs repair: ${config.manifestPath} (${errorMessage(err)})`);
  }

  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRoot(getInvocationCwd());
  } catch (err: unknown) {
    console.log(`WARN cannot create replacement manifest from current directory: ${errorMessage(err)}`);
    return;
  }

  const project = projectManifestForRepo(repoRoot, []);
  const output = yaml.dump(
    {
      version: 1,
      projects: [
        {
          name: project.name,
          path: project.path,
          uri: project.uri,
          seed: [...project.seed],
        },
      ],
    },
    {lineWidth: 120, noRefs: true},
  );

  if (dryRun) {
    console.log(`# Would write replacement manifest: ${config.manifestPath}`);
    console.log(output.trimEnd());
    return;
  }

  await ensureDirectory(dirname(config.manifestPath), false);
  const currentContent = await readFileIfExists(config.manifestPath);
  if (currentContent !== undefined) {
    const backupPath = `${config.manifestPath}.legacy-${safeTimestamp()}`;
    await writeFile(backupPath, currentContent, {encoding: 'utf8', mode: 0o600});
    await chmod(backupPath, 0o600);
    console.log(`Backup: ${backupPath}`);
  }
  await writeFile(config.manifestPath, output, {encoding: 'utf8', mode: 0o600});
  await chmod(config.manifestPath, 0o600);
  console.log(`Wrote replacement manifest: ${config.manifestPath}`);
}

async function repairRecallIndex(config: RuntimeConfig, dryRun: boolean): Promise<void> {
  console.log('\nRepairing recall index freshness.');
  const ov = dryRun ? ((await findOpenVikingCli()) ?? 'ov') : await findOpenVikingCli();
  if (!ov) {
    console.log('Skipping recall index repair: neither ov nor openviking was found.');
    return;
  }

  const progress = startProgress('Scanning recall index freshness across memories and seeded resources.');
  try {
    const result = await repairStaleRecallIndex(config, ov, {
      collapseDepth: MAINTENANCE_COLLAPSE_DEPTH,
      collapseToRoots: true,
      consecutiveFailureLimit: MAINTENANCE_CONSECUTIVE_FAILURE_LIMIT,
      dryRun,
      ignoreBackoff: true,
      includeAgentSkills: true,
      includeManifestResources: true,
      maxTargets: MAINTENANCE_MAX_REPAIR_TARGETS,
      onProgress: event => {
        if (event.type === 'scan-complete') {
          if (event.totalTargets === 0) {
            progress.update('No stale recall index scopes found.');
          } else {
            progress.update(
              `Found ${event.totalTargets} stale recall index scope(s); repairing ${event.repairTargetCount}.`,
            );
          }
        } else if (event.type === 'repair-start') {
          progress.update(
            `Reindexing ${event.index}/${event.total}: ${event.target.uri} (${event.target.staleCount} stale summaries).`,
          );
        } else if (event.type === 'repair-dry-run') {
          progress.update(
            `Planning reindex ${event.index}/${event.total}: ${event.target.uri} (${event.target.staleCount} stale summaries).`,
          );
        } else if (event.type === 'repair-skip-recent') {
          progress.update(`Skipping recently repaired scope ${event.index}/${event.total}: ${event.target.uri}.`);
        }
      },
    });
    progress.stop();
    const messages = formatRecallIndexRepairMessages(result, {dryRun, maxUris: 20});
    if (messages.length === 0) {
      console.log('Recall index freshness OK.');
      return;
    }
    for (const message of messages) {
      console.log(message);
    }
  } catch (err: unknown) {
    progress.stop();
    console.log(`WARN could not repair recall index freshness: ${errorMessage(err)}`);
  }
}

async function configureOpenVikingCliLanguage(config: RuntimeConfig, dryRun: boolean): Promise<void> {
  const ov = dryRun ? ((await findOpenVikingCli()) ?? 'ov') : await findOpenVikingCli();
  if (!ov) {
    return;
  }
  const installedVersion = dryRun ? undefined : await readOpenVikingCliVersion(ov);
  const effectiveVersion = installedVersion ?? config.openVikingVersion;
  if (compareVersions(effectiveVersion, '0.3.23') < 0) {
    return;
  }
  await maybeRun(dryRun, ov, ['language', 'en'], {allowFailure: true});
}

/**
 * Locate the openviking-server binary even when its install directory is not on
 * PATH — which is the default state on a fresh macOS shell after `uv tool install`.
 *
 * Resolution order: shell PATH, then `uv tool dir --bin`, then $UV_TOOL_BIN_DIR,
 * then ~/.local/bin (the default for uv tool install, pipx, and pip --user).
 *
 * The candidate directories are memoised for the lifetime of the process so a
 * single `threadnote doctor` invocation does not spawn `uv tool dir --bin`
 * three times. The resolved path itself is not memoised: a `threadnote install`
 * may create the binary mid-process and the second resolution must see it.
 */
async function findOpenVikingServer(): Promise<string | undefined> {
  const onPath = await findExecutable([OPENVIKING_SERVER_COMMAND]);
  if (onPath) {
    return onPath;
  }
  for (const candidateDir of await openVikingServerCandidateDirs()) {
    const candidate = join(candidateDir, OPENVIKING_SERVER_COMMAND);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

let candidateDirsPromise: Promise<readonly string[]> | undefined;

async function openVikingServerCandidateDirs(): Promise<readonly string[]> {
  if (!candidateDirsPromise) {
    candidateDirsPromise = computeOpenVikingServerCandidateDirs();
  }
  return candidateDirsPromise;
}

async function computeOpenVikingServerCandidateDirs(): Promise<readonly string[]> {
  const dirs: string[] = [];
  const uv = await findExecutable(['uv']);
  if (uv) {
    const result = await runCommand(uv, ['tool', 'dir', '--bin'], {allowFailure: true});
    if (result.exitCode === 0) {
      const dir = result.stdout.trim();
      if (dir) {
        dirs.push(dir);
      }
    }
  }
  if (process.env.UV_TOOL_BIN_DIR) {
    dirs.push(process.env.UV_TOOL_BIN_DIR);
  }
  dirs.push(expandPath('~/.local/bin'));
  return Array.from(new Set(dirs));
}

async function requireOpenVikingServer(): Promise<string> {
  const resolved = await findOpenVikingServer();
  if (!resolved) {
    throw new Error(
      `${OPENVIKING_SERVER_COMMAND} was not found in PATH, uv tool bin dir, ` +
        '$UV_TOOL_BIN_DIR, or ~/.local/bin. Run `threadnote install` first.',
    );
  }
  return resolved;
}

async function maybePrintOpenVikingPathHint(serverPath: string): Promise<void> {
  const onPath = await findExecutable([OPENVIKING_SERVER_COMMAND]);
  if (onPath) {
    return;
  }
  const binDir = dirname(serverPath);
  const rcHint = suggestedShellRc(process.env.SHELL, platform());
  console.log(
    `Note: ${serverPath} is installed but ${binDir} is not on this shell's PATH. ` +
      `Add \`export PATH="${binDir}:$PATH"\` to ${rcHint} so other tools can find openviking-server.`,
  );
}

async function repairServerHealth(config: RuntimeConfig, dryRun: boolean): Promise<boolean> {
  const existingHealth = await readOpenVikingHealthIfAvailable(config, 800);
  if (existingHealth) {
    console.log(`OpenViking health OK at http://${config.host}:${config.port}/health`);
    return true;
  }

  console.log(`OpenViking health is not responding at http://${config.host}:${config.port}/health; starting server.`);
  try {
    await runStart(config, {dryRun});
    return true;
  } catch (err: unknown) {
    console.log(`WARN could not repair OpenViking health: ${errorMessage(err)}`);
    return false;
  }
}

export async function runStart(config: RuntimeConfig, options: StartOptions): Promise<void> {
  if (options.launchd === true) {
    await installLaunchAgent(config, options.dryRun === true);
    return;
  }

  const server =
    options.dryRun === true
      ? ((await findOpenVikingServer()) ?? OPENVIKING_SERVER_COMMAND)
      : await requireOpenVikingServer();
  const args = openVikingServerArgs(config);
  if (options.dryRun === true) {
    console.log(formatShellCommand(server, args));
    return;
  }

  const existingHealth = await readOpenVikingHealthIfAvailable(config, 500);
  const healthUrl = openVikingHealthUrl(config);
  if (existingHealth) {
    console.log(`OpenViking is already healthy at ${healthUrl}`);
    return;
  }
  if (await isTcpPortOpen(config.host, config.port, 500)) {
    throw new Error(
      `Port ${config.host}:${config.port} is already in use, but it is not a healthy OpenViking server. ` +
        'Set THREADNOTE_PORT or pass --port to use a different port.',
    );
  }

  const logPath = openVikingLogPath(config);
  await ensureDirectory(dirname(logPath), false);
  if (options.foreground === true) {
    const result = await runInteractive(server, args);
    process.exitCode = result;
    return;
  }

  const logFd = openSync(logPath, 'a');
  const child = spawnDetachedServerWithLog(server, args, logFd);
  child.unref();
  await writeFile(join(config.agentContextHome, 'openviking-server.pid'), `${child.pid}\n`, 'utf8');
  const health = await waitForOpenVikingHealth(
    config,
    START_HEALTH_TIMEOUT_MS,
    `Waiting for OpenViking health at ${healthUrl}.`,
  );
  if (health) {
    console.log(`Started OpenViking with pid ${child.pid}. Health OK at ${healthUrl}. Logs: ${logPath}`);
    return;
  }
  throw new Error(
    `Started OpenViking with pid ${child.pid}, but ${healthUrl} did not become healthy within ` +
      `${START_HEALTH_TIMEOUT_MS / 1000}s. Logs: ${logPath}`,
  );
}

function spawnDetachedServerWithLog(server: string, args: readonly string[], logFd: number): ReturnType<typeof spawn> {
  try {
    return spawnDetachedServer(server, args, logFd);
  } finally {
    closeSync(logFd);
  }
}

function spawnDetachedServer(server: string, args: readonly string[], logFd: number): ReturnType<typeof spawn> {
  return spawn(server, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
}

export async function runStop(config: RuntimeConfig, options: ForgetOptions): Promise<void> {
  const launchAgentPath = expandPath(`~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
  if (platform() === 'darwin') {
    if (options.dryRun === true || (await exists(launchAgentPath))) {
      await maybeRun(options.dryRun === true, 'launchctl', ['unload', launchAgentPath], {allowFailure: true});
    } else {
      console.log(`No LaunchAgent found: ${launchAgentPath}`);
    }
  }

  const pidPath = join(config.agentContextHome, 'openviking-server.pid');
  const pidText = await readFileIfExists(pidPath);
  if (!pidText) {
    console.log('No pid file found for detached OpenViking server.');
    return;
  }
  const pid = Number(pidText.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    console.log(`Invalid pid file: ${pidPath}`);
    return;
  }
  if (options.dryRun === true) {
    console.log(`Would stop process ${pid}`);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Stopped process ${pid}`);
  } catch (err: unknown) {
    console.log(`Could not stop process ${pid}: ${errorMessage(err)}`);
  }
}

async function commandCheck(name: string, args: readonly string[]): Promise<DoctorCheck> {
  const executable = await findExecutable([name]);
  if (!executable) {
    return {name, status: 'fail', detail: 'missing from PATH'};
  }
  const result = await runCommand(executable, args, {allowFailure: true});
  return {
    name,
    status: result.exitCode === 0 ? 'ok' : 'warn',
    detail: firstLine(result.stdout || result.stderr) || executable,
  };
}

async function openVikingServerCheck(): Promise<DoctorCheck> {
  const name = OPENVIKING_SERVER_COMMAND;
  const executable = await findOpenVikingServer();
  if (!executable) {
    return {
      name,
      status: 'fail',
      detail:
        'missing; run `threadnote install` to fetch it via uv or pipx (local-embed may compile from source on first install)',
    };
  }
  const result = await runCommand(executable, ['--help'], {allowFailure: true});
  const onPath = await findExecutable([OPENVIKING_SERVER_COMMAND]);
  const detail = onPath ? executable : `${executable} (found outside PATH; add ${dirname(executable)} to PATH)`;
  return {
    name,
    status: result.exitCode === 0 ? 'ok' : 'warn',
    detail: result.exitCode === 0 ? detail : firstLine(result.stderr || result.stdout) || detail,
  };
}

async function commandPresenceCheck(name: string, args: readonly string[]): Promise<DoctorCheck> {
  const executable = await findExecutable([name]);
  if (!executable) {
    return {name, status: 'warn', detail: 'missing; only needed for MCP install'};
  }
  const result = await runCommand(executable, args, {allowFailure: true});
  return {
    name,
    status: 'ok',
    detail: firstLine(result.stdout || result.stderr) || executable,
  };
}

async function firstCommandCheck(
  name: string,
  commands: readonly string[],
  args: readonly string[],
): Promise<DoctorCheck> {
  for (const command of commands) {
    const executable = await findExecutable([command]);
    if (!executable) {
      continue;
    }
    const result = await runCommand(executable, args, {allowFailure: true});
    return {
      name,
      status: result.exitCode === 0 ? 'ok' : 'warn',
      detail: `${command}: ${firstLine(result.stdout || result.stderr) || executable}`,
    };
  }
  return {name, status: 'fail', detail: `none found: ${commands.join(', ')}`};
}

async function openVikingCliCheck(): Promise<DoctorCheck> {
  const executable = await findOpenVikingCli();
  if (!executable) {
    return {name: 'openviking cli', status: 'fail', detail: 'none found: ov, openviking'};
  }
  const result = await runCommand(executable, ['--help'], {allowFailure: true});
  const onPath = await findExecutable(['ov', 'openviking']);
  const detail = onPath ? executable : `${executable} (found outside PATH; add ${dirname(executable)} to PATH)`;
  return {
    name: 'openviking cli',
    status: result.exitCode === 0 ? 'ok' : 'warn',
    detail: result.exitCode === 0 ? detail : firstLine(result.stderr || result.stdout) || detail,
  };
}

/**
 * Warns when the installed OpenViking CLI is older than the version Threadnote
 * pins. `install`/`doctor` (unlike `repair`/`update`) don't upgrade OpenViking,
 * so without this a healthy-but-stale server silently stays behind the pin.
 */
async function openVikingVersionCheck(config: RuntimeConfig): Promise<DoctorCheck> {
  const executable = await findOpenVikingCli();
  const pinned = config.openVikingVersion;
  if (!executable) {
    return {name: 'openviking version', status: 'warn', detail: `CLI not found; pinned ${pinned}`};
  }
  const installed = await readOpenVikingCliVersion(executable);
  if (!installed) {
    return {
      name: 'openviking version',
      status: 'warn',
      detail: `could not detect via \`${executable} version\`; pinned ${pinned}`,
    };
  }
  if (compareVersions(installed, pinned) < 0) {
    return {
      name: 'openviking version',
      status: 'warn',
      detail: `installed ${installed} is older than pinned ${pinned}; run \`threadnote repair\` or \`threadnote update\` to upgrade`,
    };
  }
  return {name: 'openviking version', status: 'ok', detail: `${installed} (pinned ${pinned})`};
}

/**
 * Recall reads its hits from a JSON object with `memories`/`resources`/`skills`
 * arrays (see parseRecallHits). If a future OpenViking renames those buckets,
 * parseRecallHits would return zero hits with no error, silently degrading
 * recall. This probe asserts the shape is intact — empty buckets are fine, only
 * a missing/renamed bucket structure (or non-JSON output) warns.
 */
async function recallShapeCheck(config: RuntimeConfig): Promise<DoctorCheck> {
  const executable = await findOpenVikingCli();
  if (!executable) {
    return {name: 'recall shape', status: 'warn', detail: 'CLI not found'};
  }
  const args = withIdentity(config, ['find', 'threadnote', '--node-limit', '1', '--output', 'json']);
  const result = await runCommand(executable, args, {allowFailure: true});
  if (result.exitCode !== 0) {
    return {name: 'recall shape', status: 'warn', detail: 'search failed; run threadnote repair'};
  }
  // Mirror parseRecallHits: `ov find/search --output json` prints a `cmd: ...`
  // preamble line before the JSON, and the buckets live under the `result`
  // envelope (`{ok, result: {memories, resources, skills}}`). Start at the
  // first line beginning with `{`, exactly as recall parsing does — otherwise
  // this probe false-warns on a perfectly healthy OpenViking.
  const start = result.stdout.search(/^\{/m);
  let envelope: unknown;
  try {
    const parsed: unknown = start >= 0 ? JSON.parse(result.stdout.slice(start)) : undefined;
    envelope = isJsonObject(parsed) ? parsed.result : undefined;
  } catch {
    envelope = undefined;
  }
  const buckets = ['memories', 'resources', 'skills'];
  if (!isJsonObject(envelope) || !buckets.some(key => Array.isArray(envelope[key]))) {
    return {
      name: 'recall shape',
      status: 'warn',
      detail: `search JSON missing the result.{${buckets.join(',')}} buckets recall parsing depends on`,
    };
  }
  return {name: 'recall shape', status: 'ok', detail: 'memories/resources/skills buckets present'};
}

async function localEmbeddingCheck(): Promise<DoctorCheck> {
  const serverPath = await findOpenVikingServer();
  if (!serverPath) {
    return {name: 'local embedding extra', status: 'warn', detail: 'openviking-server missing'};
  }
  const hasDependency = await hasLocalEmbeddingDependency(serverPath);
  if (hasDependency === undefined) {
    return {
      name: 'local embedding extra',
      status: 'warn',
      detail: 'could not inspect tool Python; install openviking[local-embed] or configure a remote embedding provider',
    };
  }
  return hasDependency
    ? {name: 'local embedding extra', status: 'ok', detail: 'llama_cpp import works'}
    : {
        name: 'local embedding extra',
        status: 'warn',
        detail: 'llama_cpp missing; install will repair with openviking[local-embed]',
      };
}

async function pythonSystemCertificatesCheck(): Promise<DoctorCheck> {
  const serverPath = await findOpenVikingServer();
  if (!serverPath) {
    return {name: 'python system certs', status: 'warn', detail: 'openviking-server missing'};
  }
  const hasDependency = await hasPythonSystemCertificatesPatch(serverPath);
  if (hasDependency === undefined) {
    return {name: 'python system certs', status: 'warn', detail: 'could not inspect tool Python'};
  }
  return hasDependency
    ? {name: 'python system certs', status: 'ok', detail: `${PYTHON_SYSTEM_CERTS_MODULE} import works`}
    : {
        name: 'python system certs',
        status: 'warn',
        detail: `${PYTHON_SYSTEM_CERTS_MODULE} missing; install will repair corporate TLS support`,
      };
}

async function commandShimCheck(): Promise<DoctorCheck> {
  const shimPath = join(expandPath(process.env.THREADNOTE_BIN_DIR ?? '~/.local/bin'), 'threadnote');
  const content = await readFileIfExists(shimPath);
  if (content === undefined) {
    return {name: 'threadnote shim', status: 'warn', detail: `${shimPath} missing; repair will create it`};
  }
  if (!isManagedCommandShim(content)) {
    return {
      name: 'threadnote shim',
      status: 'warn',
      detail: `${shimPath} exists but was not generated by this tool; repair will not overwrite it`,
    };
  }
  if (content !== renderCommandShim()) {
    return {
      name: 'threadnote shim',
      status: 'warn',
      detail: `${shimPath} points at a different checkout; repair will rewrite it`,
    };
  }
  return {name: 'threadnote shim', status: 'ok', detail: shimPath};
}

async function userAgentInstructionsChecks(): Promise<DoctorCheck[]> {
  return Promise.all(
    USER_AGENT_INSTRUCTION_TARGETS.map(async target => {
      const expectedInstructions = await renderUserAgentInstructions(target);
      const targetPath = expandPath(target.path);
      const content = await readFileIfExists(targetPath);
      if (content === undefined) {
        return {name: target.label, status: 'warn', detail: `${targetPath} missing; install will create it`};
      }
      const existingBlock = extractManagedBlock(content);
      if (existingBlock === undefined) {
        return {
          name: target.label,
          status: 'warn',
          detail: `${targetPath} missing threadnote block; install will add it`,
        };
      }
      if (
        (target.kind === 'file' && content !== expectedInstructions) ||
        (target.kind === 'block' && existingBlock !== expectedInstructions)
      ) {
        return {
          name: target.label,
          status: 'warn',
          detail: `${targetPath} has stale threadnote block; install will update it`,
        };
      }
      return {name: target.label, status: 'ok', detail: targetPath};
    }),
  );
}

async function hasLocalEmbeddingDependency(serverPath: string): Promise<boolean | undefined> {
  return hasPythonModule(serverPath, 'llama_cpp');
}

async function hasPythonSystemCertificatesPatch(serverPath: string): Promise<boolean | undefined> {
  return hasPythonModule(serverPath, PYTHON_SYSTEM_CERTS_MODULE);
}

async function hasPythonModule(serverPath: string, moduleName: string): Promise<boolean | undefined> {
  const pythonPath = await siblingPythonForExecutable(serverPath);
  if (!pythonPath) {
    return undefined;
  }
  const result = await runCommand(pythonPath, ['-c', `import ${moduleName}`], {allowFailure: true});
  return result.exitCode === 0;
}

async function siblingPythonForExecutable(executablePath: string): Promise<string | undefined> {
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(executablePath);
  } catch (_err: unknown) {
    return undefined;
  }
  const pythonPath = join(dirname(resolvedPath), 'python');
  return (await exists(pythonPath)) ? pythonPath : undefined;
}

async function manifestCheck(path: string): Promise<DoctorCheck> {
  try {
    const manifest = await readSeedManifest(path);
    return {name: 'manifest', status: 'ok', detail: `${path} (${manifest.projects.length} project(s))`};
  } catch (err: unknown) {
    return {name: 'manifest', status: 'fail', detail: errorMessage(err)};
  }
}

async function recallIndexFreshnessCheck(config: RuntimeConfig): Promise<DoctorCheck> {
  try {
    if (await summaryAutoGenerationDisabled(config)) {
      return {
        name: 'recall index freshness',
        status: 'ok',
        detail:
          'OpenViking L0/L1 summary auto-generation disabled in ov.conf; ' +
          'directory summary placeholders are expected and not reindexed',
      };
    }
    const targets = await findStaleRecallIndexTargets(config, {
      collapseToRoots: true,
      includeAgentSkills: true,
      includeManifestResources: true,
    });
    if (targets.length === 0) {
      return {name: 'recall index freshness', status: 'ok', detail: 'no stale generated summaries found'};
    }
    const staleSummaryCount = targets.reduce((total, target) => total + target.staleCount, 0);
    const sampleUris = targets.slice(0, 3).map(target => target.uri);
    const extraCount = targets.length - sampleUris.length;
    const sample = `${sampleUris.join(', ')}${extraCount > 0 ? `, +${extraCount} more` : ''}`;
    return {
      name: 'recall index freshness',
      status: 'warn',
      detail: `${staleSummaryCount} stale generated summary file(s) under ${targets.length} scope(s); run repair to reindex ${sample}`,
    };
  } catch (err: unknown) {
    return {name: 'recall index freshness', status: 'warn', detail: errorMessage(err)};
  }
}

async function fileCheck(path: string, label: string): Promise<DoctorCheck> {
  return (await exists(path))
    ? {name: label, status: 'ok', detail: path}
    : {name: label, status: 'fail', detail: `${path} missing`};
}

async function healthCheck(config: RuntimeConfig): Promise<DoctorCheck> {
  try {
    const body = await readOpenVikingHealth(config, 1200);
    return {name: 'openviking health', status: 'ok', detail: firstLine(body) || 'healthy'};
  } catch (err: unknown) {
    return {name: 'openviking health', status: 'warn', detail: errorMessage(err)};
  }
}

async function readOpenVikingHealth(config: RuntimeConfig, timeoutMs: number): Promise<string> {
  return httpGetText(openVikingHealthUrl(config), timeoutMs);
}

async function readOpenVikingHealthIfAvailable(config: RuntimeConfig, timeoutMs: number): Promise<string | undefined> {
  try {
    return await readOpenVikingHealth(config, timeoutMs);
  } catch (_err: unknown) {
    return undefined;
  }
}

async function waitForOpenVikingHealth(
  config: RuntimeConfig,
  timeoutMs: number,
  progressMessage?: string,
): Promise<string | undefined> {
  const progress = progressMessage ? startProgress(progressMessage) : undefined;
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const requestTimeoutMs = Math.max(100, Math.min(1000, deadline - Date.now()));
      const health = await readOpenVikingHealthIfAvailable(config, requestTimeoutMs);
      if (health) {
        return health;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await sleep(Math.min(START_HEALTH_POLL_INTERVAL_MS, remainingMs));
    }
    return undefined;
  } finally {
    progress?.stop();
  }
}

async function runInstallCommands(
  config: RuntimeConfig,
  preferred: PackageManager | undefined,
  force: boolean,
  dryRun: boolean,
): Promise<void> {
  // When the user didn't ask for a specific manager and detection fell back
  // to plain `pip`, offer to install `uv` first — `pip install --user` is
  // refused under PEP 668 on Homebrew / system-managed Python, which is most
  // macOS and modern Linux setups.
  let manager = preferred;
  if (manager === undefined && !dryRun) {
    const detected = await detectPackageManager();
    if (detected === 'pip' && (await offerToInstallUv())) {
      const rediscovered = await detectPackageManager();
      if (rediscovered === 'uv') {
        manager = 'uv';
      }
    }
  }
  const installCommands = await getInstallCommands(config, manager, force);
  for (const installCommand of installCommands) {
    if (dryRun) {
      await maybeRun(true, installCommand.executable, installCommand.args);
      continue;
    }
    // Stream live instead of buffering through runCommand. openviking[local-embed]
    // can compile llama-cpp-python from source (10-20 min, memory-heavy); buffering
    // hides all progress and the 10-minute command timeout would SIGKILL a
    // legitimate build. Because uv/pipx --force removes the existing tool env
    // first, a killed reinstall leaves openviking-server missing — so we also
    // print recovery guidance before failing.
    console.log(`Running: ${formatShellCommand(installCommand.executable, installCommand.args)}`);
    const exitCode = await runInteractive(installCommand.executable, installCommand.args);
    if (exitCode !== 0) {
      printOpenVikingInstallFailureHelp(installCommand);
      throw new Error(`${formatShellCommand(installCommand.executable, installCommand.args)} exited with ${exitCode}.`);
    }
  }
}

function printOpenVikingInstallFailureHelp(failedCommand: MappedCommand): void {
  console.error('');
  console.error('OpenViking install did not complete.');
  console.error(
    'openviking[local-embed] includes llama-cpp-python, which compiles from source when no prebuilt wheel matches your Python/platform — that build can run 10-20 minutes and is memory-heavy, so it may be killed by the OS (out of memory) or look stuck.',
  );
  console.error('Re-run it directly to see full output without any wrapper timeout:');
  console.error(`  ${formatShellCommand(failedCommand.executable, failedCommand.args)}`);
  console.error('Cap memory use during the compile with: CMAKE_BUILD_PARALLEL_LEVEL=2 <command above>');
  if (failedCommand.executable === 'uv') {
    if (failedCommand.args.includes('--python')) {
      console.error(
        'If uv could not fetch a managed CPython (offline or restricted network), drop the version pin and retry: THREADNOTE_OPENVIKING_PYTHON= threadnote install --force',
      );
    }
    console.error('If it was killed mid-build, clear the partial install first, then retry:');
    console.error('  uv cache clean');
    console.error('  rm -rf "$(uv tool dir)/openviking"');
  }
}

async function offerToInstallUv(): Promise<boolean> {
  if (processStdin.isTTY !== true || processStdout.isTTY !== true) {
    console.warn(
      'Neither uv nor pipx was found on PATH. Falling back to `python3 -m pip install --user`, which fails on PEP 668 (Homebrew/system) Python.\n' +
        'Re-run with --package-manager uv after installing uv (brew install uv), or pass --package-manager pipx.',
    );
    return false;
  }
  const readline = createInterface({input: processStdin, output: processStdout});
  let answer: string;
  try {
    answer = (
      await readline.question(
        'OpenViking installs into Python; neither uv nor pipx is on PATH so threadnote would fall back to `pip install --user`, which fails on PEP 668 setups.\nInstall uv now? [Y/n] ',
      )
    )
      .trim()
      .toLowerCase();
  } finally {
    readline.close();
  }
  if (answer === 'n' || answer === 'no') {
    console.log('Continuing with `python3 -m pip install --user`. You may hit PEP 668 errors on managed Pythons.');
    return false;
  }
  return await installUv();
}

async function installUv(): Promise<boolean> {
  const brew = await findExecutable(['brew']);
  if (brew) {
    console.log('Installing uv via Homebrew...');
    const result = await runCommand(brew, ['install', 'uv'], {allowFailure: true});
    if (result.exitCode === 0) {
      if (result.stdout.trim()) {
        console.log(result.stdout.trim());
      }
      if (await findExecutable(['uv'])) {
        // Drop the candidate-dirs cache so subsequent openviking-server
        // resolutions can query `uv tool dir --bin` now that uv is on PATH.
        candidateDirsPromise = undefined;
        return true;
      }
    } else {
      console.warn(`brew install uv failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }
  // Fall back to the official install script. Requires curl + sh; honors any
  // proxy env vars the user already has.
  if ((await findExecutable(['curl'])) && (await findExecutable(['sh']))) {
    console.log('Installing uv via the official install script (curl -LsSf https://astral.sh/uv/install.sh | sh)...');
    const result = await runCommand('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], {
      allowFailure: true,
    });
    if (result.exitCode === 0) {
      if (result.stdout.trim()) {
        console.log(result.stdout.trim());
      }
      if (await findExecutable(['uv'])) {
        candidateDirsPromise = undefined;
        return true;
      }
      console.warn(
        'uv installed, but the new binary is not yet on this shell PATH. Open a new shell (or `source ~/.zshrc` / `source ~/.bashrc`) and re-run `threadnote install`.',
      );
      return false;
    }
    console.warn(`uv install script failed: ${(result.stderr || result.stdout).trim()}`);
  }
  console.warn(
    'Could not install uv automatically. Install it manually (brew install uv) and re-run threadnote install.',
  );
  return false;
}

async function getPythonSystemCertificatesInstallCommand(serverPath: string): Promise<MappedCommand> {
  const pythonPath = await siblingPythonForExecutable(serverPath);
  if (!pythonPath) {
    throw new Error(`Could not find the OpenViking Python environment for ${serverPath}`);
  }
  const uvPath = await findExecutable(['uv']);
  if (uvPath) {
    return {
      executable: uvPath,
      args: ['pip', 'install', '--native-tls', '--python', pythonPath, PYTHON_SYSTEM_CERTS_PACKAGE],
    };
  }
  return {executable: pythonPath, args: ['-m', 'pip', 'install', PYTHON_SYSTEM_CERTS_PACKAGE]};
}

/**
 * Prebuilt llama-cpp-python wheel index for openviking[local-embed]. PyPI ships
 * only an sdist, so without this every install compiles the native extension
 * from source. The abetlen community index publishes per-backend wheels; we pick
 * a sensible CPU/Metal default by platform. CUDA/ROCm users (or anyone needing
 * to disable it, e.g. air-gapped) can override via THREADNOTE_LLAMA_WHEEL_INDEX;
 * setting it empty turns the extra index off and restores a from-source build.
 */
export function localEmbedWheelIndexUrl(): string | undefined {
  const override = process.env.THREADNOTE_LLAMA_WHEEL_INDEX;
  if (override !== undefined) {
    return override.trim() === '' ? undefined : override.trim();
  }
  const base = 'https://abetlen.github.io/llama-cpp-python/whl';
  return platform() === 'darwin' ? `${base}/metal` : `${base}/cpu`;
}

/**
 * CPython version the uv-managed OpenViking tool is pinned to, so local-embed
 * resolves a prebuilt llama-cpp-python wheel instead of compiling. Defaults to
 * the pinned {@link OPENVIKING_TOOL_PYTHON}. Override via THREADNOTE_OPENVIKING_PYTHON
 * (e.g. a specific interpreter); set it empty to drop the pin and let uv use its
 * default interpreter — useful in locked or offline environments where a managed
 * CPython cannot be fetched.
 */
export function openVikingToolPython(): string | undefined {
  const override = process.env.THREADNOTE_OPENVIKING_PYTHON;
  if (override !== undefined) {
    return override.trim() === '' ? undefined : override.trim();
  }
  return OPENVIKING_TOOL_PYTHON;
}

export async function getInstallCommands(
  config: RuntimeConfig,
  preferred: PackageManager | undefined,
  force: boolean,
): Promise<readonly MappedCommand[]> {
  const packageSpec = `${OPENVIKING_PACKAGE_NAME}==${config.openVikingVersion}`;
  const wheelIndex = localEmbedWheelIndexUrl();
  const manager = preferred ?? (await detectPackageManager());
  if (manager === 'pipx') {
    const installArgs = force ? ['install', '--force'] : ['install'];
    if (wheelIndex) {
      installArgs.push('--pip-args', `--extra-index-url ${wheelIndex}`);
    }
    installArgs.push(packageSpec);
    return [
      {executable: 'pipx', args: installArgs},
      {
        executable: 'pipx',
        args: force
          ? ['inject', '--force', 'openviking', PYTHON_SYSTEM_CERTS_PACKAGE]
          : ['inject', 'openviking', PYTHON_SYSTEM_CERTS_PACKAGE],
      },
    ];
  }
  if (manager === 'uv') {
    // --python pins the tool to a wheel-supported interpreter (uv fetches a
    // managed CPython when none is present), so local-embed resolves a prebuilt
    // wheel instead of compiling. --extra-index-url points at that wheel index.
    const toolPython = openVikingToolPython();
    const uvArgs = [
      'tool',
      'install',
      '--native-tls',
      ...(toolPython ? ['--python', toolPython] : []),
      '--with',
      PYTHON_SYSTEM_CERTS_PACKAGE,
      ...(wheelIndex ? ['--extra-index-url', wheelIndex] : []),
    ];
    return [
      {
        executable: 'uv',
        args: force ? [...uvArgs, '--force', packageSpec] : [...uvArgs, packageSpec],
      },
    ];
  }
  const pipArgs = ['-m', 'pip', 'install', '--user'];
  if (force) {
    pipArgs.push('--upgrade', '--force-reinstall');
  }
  if (wheelIndex) {
    pipArgs.push('--extra-index-url', wheelIndex);
  }
  pipArgs.push(PYTHON_SYSTEM_CERTS_PACKAGE);
  pipArgs.push(packageSpec);
  return [{executable: 'python3', args: pipArgs}];
}

async function detectPackageManager(): Promise<PackageManager> {
  if (await findExecutable(['uv'])) {
    return 'uv';
  }
  if (await findExecutable(['pipx'])) {
    return 'pipx';
  }
  return 'pip';
}

function printInstallNextSteps(options: {readonly dryRun: boolean; readonly startsServer: boolean}): void {
  if (options.dryRun) {
    console.log('Dry run complete. Run without --dry-run to install and start OpenViking.');
    return;
  }

  if (options.startsServer) {
    console.log('Install complete. OpenViking health is ready. Next:');
    console.log('  threadnote doctor --dry-run');
    return;
  }

  console.log('Install complete. Run start, then doctor:');
  console.log('  threadnote start');
  console.log('  threadnote doctor --dry-run');
}

async function writeTemplateIfMissing(options: {
  readonly config: RuntimeConfig;
  readonly destinationPath: string;
  readonly dryRun: boolean;
  readonly shouldRepair?: (content: string) => boolean;
  readonly templatePath: string;
}): Promise<void> {
  if (await exists(options.destinationPath)) {
    const currentContent = await readFile(options.destinationPath, 'utf8');
    if (options.shouldRepair?.(currentContent) !== true) {
      console.log(`Already exists: ${options.destinationPath}`);
      return;
    }
    const rendered = renderTemplate(await readFile(options.templatePath, 'utf8'), options.config);
    if (options.dryRun) {
      console.log(`Would repair generated config: ${options.destinationPath}`);
      return;
    }
    const backupPath = `${options.destinationPath}.legacy-${safeTimestamp()}`;
    await writeFile(backupPath, currentContent, {encoding: 'utf8', mode: 0o600});
    await chmod(backupPath, 0o600);
    await writeFile(options.destinationPath, rendered, {encoding: 'utf8', mode: 0o600});
    await chmod(options.destinationPath, 0o600);
    console.log(`Repaired generated config: ${options.destinationPath}`);
    console.log(`Backup: ${backupPath}`);
    return;
  }
  const rendered = renderTemplate(await readFile(options.templatePath, 'utf8'), options.config);
  if (options.dryRun) {
    console.log(`Would write ${options.destinationPath}`);
    return;
  }
  await ensureDirectory(dirname(options.destinationPath), false);
  await writeFile(options.destinationPath, rendered, {encoding: 'utf8', mode: 0o600});
  await chmod(options.destinationPath, 0o600);
  console.log(`Wrote ${options.destinationPath}`);
}

async function installCommandShim(dryRun: boolean): Promise<void> {
  const binDir = expandPath(process.env.THREADNOTE_BIN_DIR ?? '~/.local/bin');
  const shimPath = join(binDir, 'threadnote');
  const existingContent = await readFileIfExists(shimPath);
  if (existingContent && !isManagedCommandShim(existingContent)) {
    console.log(`WARN not overwriting existing command shim: ${shimPath}`);
    return;
  }

  const content = renderCommandShim();
  if (existingContent === content) {
    console.log(`Already exists: ${shimPath}`);
    return;
  }
  if (dryRun) {
    console.log(`Would write command shim: ${shimPath}`);
    return;
  }
  await ensureDirectory(binDir, false);
  await writeFile(shimPath, content, {encoding: 'utf8', mode: 0o755});
  await chmod(shimPath, 0o755);
  console.log(`Wrote command shim: ${shimPath}`);
}

async function removeCommandShim(dryRun: boolean): Promise<void> {
  const shimPath = join(expandPath(process.env.THREADNOTE_BIN_DIR ?? '~/.local/bin'), 'threadnote');
  const content = await readFileIfExists(shimPath);
  if (content === undefined) {
    console.log(`Already absent: ${shimPath}`);
    return;
  }
  if (!isManagedCommandShim(content)) {
    console.log(`WARN not removing unmanaged command shim: ${shimPath}`);
    return;
  }
  await removePath(shimPath, 'command shim', dryRun);
}

async function installUserAgentInstructions(dryRun: boolean): Promise<void> {
  for (const target of USER_AGENT_INSTRUCTION_TARGETS) {
    const instructions = await renderUserAgentInstructions(target);
    const targetPath = expandPath(target.path);
    const currentContent = await readFileIfExists(targetPath);
    if (target.kind === 'file' && currentContent !== undefined && extractManagedBlock(currentContent) === undefined) {
      console.log(`WARN ${targetPath} is not managed by threadnote; not modifying it`);
      continue;
    }
    const nextContent = target.kind === 'file' ? instructions : upsertManagedBlock(currentContent ?? '', instructions);
    if (nextContent === undefined) {
      console.log(`WARN ${targetPath} has partial threadnote markers; not modifying it`);
      continue;
    }
    if (currentContent === nextContent) {
      console.log(`Already exists: ${targetPath}`);
      continue;
    }
    if (dryRun) {
      console.log(currentContent === undefined ? `Would write ${targetPath}` : `Would update ${targetPath}`);
      continue;
    }
    await ensureDirectory(dirname(targetPath), false);
    await writeFile(targetPath, nextContent, {encoding: 'utf8', mode: 0o644});
    console.log(currentContent === undefined ? `Wrote ${targetPath}` : `Updated ${targetPath}`);
  }
}

async function removeUserAgentInstructions(dryRun: boolean): Promise<void> {
  for (const target of USER_AGENT_INSTRUCTION_TARGETS) {
    const targetPath = expandPath(target.path);
    const currentContent = await readFileIfExists(targetPath);
    if (currentContent === undefined) {
      console.log(`Already absent: ${targetPath}`);
      continue;
    }
    if (target.kind === 'file') {
      if (extractManagedBlock(currentContent) === undefined) {
        console.log(`WARN ${targetPath} is not managed by threadnote; not removing it`);
        continue;
      }
      await removePath(targetPath, target.label, dryRun);
      continue;
    }
    const nextContent = removeManagedBlock(currentContent);
    if (nextContent === undefined) {
      console.log(`WARN ${targetPath} has partial threadnote markers; not modifying it`);
      continue;
    }
    if (nextContent === currentContent) {
      console.log(`No threadnote block found: ${targetPath}`);
      continue;
    }
    if (nextContent.trim().length === 0) {
      await removePath(targetPath, target.label, dryRun);
      continue;
    }
    if (dryRun) {
      console.log(`Would update ${targetPath}`);
      continue;
    }
    await writeFile(targetPath, nextContent, {encoding: 'utf8', mode: 0o644});
    console.log(`Updated ${targetPath}`);
  }
}

async function renderUserAgentInstructions(target: UserAgentInstructionTarget): Promise<string> {
  const block = await renderUserAgentInstructionsBlock();
  if (target.kind === 'block') {
    return block;
  }
  return [
    '---',
    'name: Threadnote',
    'description: Shared local context and handoffs through Threadnote',
    'applyTo: "**"',
    '---',
    '',
    block,
  ].join('\n');
}

async function renderUserAgentInstructionsBlock(): Promise<string> {
  const instructions = (await readFile(join(toolRoot(), 'docs', 'agent-instructions.md'), 'utf8')).trim();
  return `${USER_INSTRUCTIONS_START_MARKER}\n${instructions}\n${USER_INSTRUCTIONS_END_MARKER}`;
}

function extractManagedBlock(content: string): string | undefined {
  const startIndex = content.indexOf(USER_INSTRUCTIONS_START_MARKER);
  const endIndex = content.indexOf(USER_INSTRUCTIONS_END_MARKER);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return undefined;
  }
  return content.slice(startIndex, endIndex + USER_INSTRUCTIONS_END_MARKER.length);
}

function upsertManagedBlock(content: string, block: string): string | undefined {
  const startIndex = content.indexOf(USER_INSTRUCTIONS_START_MARKER);
  const endIndex = content.indexOf(USER_INSTRUCTIONS_END_MARKER);
  if ((startIndex === -1) !== (endIndex === -1) || endIndex < startIndex) {
    return undefined;
  }
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
  if ((startIndex === -1) !== (endIndex === -1) || endIndex < startIndex) {
    return undefined;
  }
  if (startIndex === -1) {
    return content;
  }
  const before = content.slice(0, startIndex).trimEnd();
  const after = content.slice(endIndex + USER_INSTRUCTIONS_END_MARKER.length).trimStart();
  const nextContent = joinMarkdownSections([before, after]);
  return nextContent.trim().length > 0 ? nextContent : '';
}

function joinMarkdownSections(sections: readonly string[]): string {
  return `${sections.filter(section => section.length > 0).join('\n\n')}\n`;
}

function renderCommandShim(): string {
  const root = toolRoot();
  return [
    '#!/usr/bin/env bash',
    `# ${SHIM_MARKER}`,
    'set -euo pipefail',
    `THREADNOTE_ROOT=${shellQuote(root)}`,
    'THREADNOTE_ENTRY="$THREADNOTE_ROOT/dist/threadnote.cjs"',
    'if [ ! -f "$THREADNOTE_ENTRY" ]; then',
    '  THREADNOTE_ENTRY="$THREADNOTE_ROOT/bin/threadnote.cjs"',
    'fi',
    'THREADNOTE_CALLER_CWD="$PWD"',
    'export THREADNOTE_CALLER_CWD',
    'if command -v node >/dev/null 2>&1; then',
    '  exec node "$THREADNOTE_ENTRY" "$@"',
    'fi',
    'if command -v bun >/dev/null 2>&1; then',
    '  exec bun "$THREADNOTE_ENTRY" "$@"',
    'fi',
    'if command -v deno >/dev/null 2>&1; then',
    '  exec deno run --allow-read --allow-write --allow-run --allow-env --allow-net "$THREADNOTE_ENTRY" "$@"',
    'fi',
    'echo "threadnote requires Node.js, Bun, or Deno." >&2',
    'exit 127',
    '',
  ].join('\n');
}

function isManagedCommandShim(content: string): boolean {
  return content.includes(SHIM_MARKER);
}

async function installLaunchAgent(config: RuntimeConfig, dryRun: boolean): Promise<void> {
  if (platform() !== 'darwin') {
    throw new Error('launchd autostart is only supported on macOS.');
  }
  // launchd uses a minimal default PATH (/usr/bin:/bin:/usr/sbin:/sbin) and
  // does not source the user's shell rc, so the plist must reference the
  // absolute path to openviking-server — otherwise a LaunchAgent on a fresh
  // macOS box would exit 127.
  const resolvedServer = await findOpenVikingServer();
  if (!resolvedServer && !dryRun) {
    throw new Error(
      `Cannot install LaunchAgent: ${OPENVIKING_SERVER_COMMAND} was not found in PATH, ` +
        'uv tool bin dir, $UV_TOOL_BIN_DIR, or ~/.local/bin. Run `threadnote install` first.',
    );
  }
  const source = join(toolRoot(), 'config', 'launchd', `${LAUNCHD_LABEL}.plist.template`);
  const destination = expandPath(`~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
  const rendered = renderTemplate(await readFile(source, 'utf8'), config, {
    OPENVIKING_SERVER_PATH: resolvedServer ?? OPENVIKING_SERVER_COMMAND,
  });
  if (dryRun) {
    const resolutionDetail = resolvedServer ?? `<not found; would use bare \`${OPENVIKING_SERVER_COMMAND}\`>`;
    console.log(`Resolved openviking-server: ${resolutionDetail}`);
    console.log(`Would write ${destination}`);
    console.log(`Would run: launchctl unload ${destination}`);
    console.log(`Would run: launchctl load ${destination}`);
    console.log(`Would run: launchctl start ${LAUNCHD_LABEL}`);
    return;
  }
  await ensureDirectory(dirname(destination), false);
  await ensureDirectory(dirname(openVikingLogPath(config)), false);
  await writeFile(destination, rendered, 'utf8');
  await maybeRun(false, 'launchctl', ['unload', destination], {allowFailure: true});
  await maybeRun(false, 'launchctl', ['load', destination]);
  await maybeRun(false, 'launchctl', ['start', LAUNCHD_LABEL]);
  const healthUrl = openVikingHealthUrl(config);
  const health = await waitForOpenVikingHealth(
    config,
    START_HEALTH_TIMEOUT_MS,
    `Waiting for OpenViking health at ${healthUrl}.`,
  );
  if (health) {
    console.log(`Installed and started ${LAUNCHD_LABEL}. Health OK at ${healthUrl}`);
    return;
  }
  throw new Error(
    `Installed and started ${LAUNCHD_LABEL}, but ${healthUrl} did not become healthy within ` +
      `${START_HEALTH_TIMEOUT_MS / 1000}s. Logs: ${openVikingLogPath(config)}`,
  );
}

async function removeLaunchAgent(dryRun: boolean): Promise<void> {
  const launchAgentPath = expandPath(`~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
  const content = await readFileIfExists(launchAgentPath);
  if (content === undefined) {
    console.log(`Already absent: ${launchAgentPath}`);
    return;
  }
  if (!content.includes(LAUNCHD_LABEL) || !content.includes(OPENVIKING_SERVER_COMMAND)) {
    console.log(`WARN not removing unmanaged LaunchAgent: ${launchAgentPath}`);
    return;
  }
  await removePath(launchAgentPath, 'LaunchAgent', dryRun);
}

async function eraseThreadnoteHome(path: string, dryRun: boolean): Promise<void> {
  assertSafeThreadnoteHomeForErase(path);
  await removePathIfExists(path, 'THREADNOTE_HOME and all memories', dryRun);
}

function shouldRepairOpenVikingConfig(content: string, config: RuntimeConfig): boolean {
  const parsed = parseJsonConfigObject(content);
  if (!parsed) {
    return false;
  }
  if (isLegacyOpenVikingConfig(parsed)) {
    return true;
  }
  return (
    isGeneratedLocalPilotConfig(parsed, config) &&
    (parsed.auto_generate_l0 !== false || parsed.auto_generate_l1 !== false)
  );
}

function isLegacyOpenVikingConfig(parsed: JsonObject): boolean {
  return (
    isJsonObject(parsed.server) &&
    typeof parsed.server.storage_dir === 'string' &&
    isJsonObject(parsed.identity) &&
    isJsonObject(parsed.privacy) &&
    isJsonObject(parsed.models)
  );
}

function isGeneratedLocalPilotConfig(parsed: JsonObject, config: RuntimeConfig): boolean {
  const allowedKeys = new Set([
    'auto_generate_l0',
    'auto_generate_l1',
    'default_account',
    'default_agent',
    'default_user',
    'server',
    'storage',
  ]);
  if (Object.keys(parsed).some(key => !allowedKeys.has(key))) {
    return false;
  }
  if (parsed.default_account !== config.account || parsed.default_agent !== config.agentId) {
    return false;
  }
  if (typeof parsed.default_user !== 'string') {
    return false;
  }
  if (!isJsonObject(parsed.storage) || parsed.storage.workspace !== join(config.agentContextHome, 'data')) {
    return false;
  }
  return (
    isJsonObject(parsed.server) &&
    parsed.server.host === config.host &&
    String(parsed.server.port) === String(config.port)
  );
}

function shouldRepairLegacyOvCliConfig(content: string): boolean {
  const parsed = parseJsonConfigObject(content);
  if (!parsed) {
    return false;
  }
  return typeof parsed.server_url === 'string' && isJsonObject(parsed.identity);
}

export function parsePackageManager(value: string): PackageManager {
  if (value === 'pipx' || value === 'uv' || value === 'pip') {
    return value;
  }
  throw new Error(`Invalid package manager: ${value}`);
}
