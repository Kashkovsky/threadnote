import {spawn} from 'node:child_process';
import {closeSync, openSync} from 'node:fs';
import {chmod, readFile, realpath, writeFile} from 'node:fs/promises';
import {platform} from 'node:os';
import {dirname, join} from 'node:path';
import yaml from 'js-yaml';
import {
  LAUNCHD_LABEL,
  OPENVIKING_MCP_NAME,
  OPENVIKING_PACKAGE_NAME,
  OPENVIKING_SERVER_COMMAND,
  PYTHON_SYSTEM_CERTS_MODULE,
  PYTHON_SYSTEM_CERTS_PACKAGE,
  SHIM_MARKER,
  START_HEALTH_POLL_INTERVAL_MS,
  START_HEALTH_TIMEOUT_MS,
  USER_AGENT_INSTRUCTION_TARGETS,
  USER_INSTRUCTIONS_END_MARKER,
  USER_INSTRUCTIONS_START_MARKER,
} from './constants.js';
import {readSeedManifest} from './manifest.js';
import {removeMcpConfigs, removeMcpSnippets, resolveMcpClients, runMcpInstall} from './mcp.js';
import {maybeRunPostUpdateAfterRepair} from './update.js';
import {
  builtInExampleManifestPath,
  openVikingHealthUrl,
  openVikingLogPath,
  openVikingServerArgs,
  renderTemplate,
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
  ensureDirectory,
  errorMessage,
  exists,
  expandPath,
  findExecutable,
  firstLine,
  formatShellCommand,
  formatStatus,
  getInvocationCwd,
  httpGetText,
  isJsonObject,
  isTcpPortOpen,
  maybeRun,
  parseJsonConfigObject,
  readFileIfExists,
  removePath,
  removePathIfExists,
  requiredExecutable,
  runCommand,
  runInteractive,
  safeTimestamp,
  shellQuote,
  sleep,
  toolRoot,
} from './utils.js';

type UserAgentInstructionTarget = (typeof USER_AGENT_INSTRUCTION_TARGETS)[number];

export async function runDoctor(config: RuntimeConfig, options: DoctorOptions): Promise<void> {
  const checks: DoctorCheck[] = [];
  checks.push({name: 'mode', status: 'ok', detail: options.dryRun ? 'dry run; no writes' : 'read-only checks'});
  checks.push({name: 'platform', status: platform() === 'darwin' ? 'ok' : 'warn', detail: platform()});
  checks.push(await commandCheck('node', ['--version']));
  checks.push(await commandCheck('python3', ['--version']));
  checks.push(await commandCheck('openviking-server', ['--help']));
  checks.push(await firstCommandCheck('openviking cli', ['ov', 'openviking'], ['--help']));
  checks.push(await localEmbeddingCheck());
  checks.push(await pythonSystemCertificatesCheck());
  checks.push(await firstCommandCheck('python installer', ['pipx', 'uv', 'pip3'], ['--version']));
  checks.push(await commandPresenceCheck('codex', ['--version']));
  checks.push(await commandPresenceCheck('claude', ['--version']));
  checks.push(await commandShimCheck());
  checks.push(...(await userAgentInstructionsChecks()));
  checks.push(await manifestCheck(config.manifestPath));
  checks.push(await fileCheck(join(toolRoot(), '.threadnoteignore'), 'ignore file'));
  checks.push(await fileCheck(join(toolRoot(), 'config', 'ov.conf.template.json'), 'server config template'));
  checks.push(await fileCheck(join(toolRoot(), 'config', 'ovcli.conf.template.json'), 'cli config template'));
  checks.push(await healthCheck(config));

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

export async function runInstall(config: RuntimeConfig, options: InstallOptions): Promise<void> {
  const repairInvalidConfigs = options.repairInvalidConfigs === true;
  const dryRun = options.dryRun === true;
  await ensureDirectory(config.agentContextHome, dryRun);
  await ensureDirectory(join(config.agentContextHome, 'logs'), dryRun);
  await ensureDirectory(join(config.agentContextHome, 'redacted'), dryRun);
  await ensureDirectory(join(config.agentContextHome, 'mcp'), dryRun);
  await installCommandShim(dryRun);
  await installUserAgentInstructions(dryRun);

  const serverPath = await findExecutable([OPENVIKING_SERVER_COMMAND]);
  if (serverPath) {
    console.log(`OpenViking server already installed: ${serverPath}`);
    const localEmbeddingMissing = (await hasLocalEmbeddingDependency(serverPath)) === false;
    const pythonSystemCertificatesMissing = (await hasPythonSystemCertificatesPatch(serverPath)) === false;
    if (localEmbeddingMissing) {
      const repairReasons: string[] = [];
      repairReasons.push('local embedding extra is missing');
      if (pythonSystemCertificatesMissing) {
        repairReasons.push('Python system certificate bridge is missing');
      }
      console.log(`OpenViking install needs repair: ${repairReasons.join('; ')}.`);
      await runInstallCommands(config, options.packageManager, true, dryRun);
    } else if (pythonSystemCertificatesMissing) {
      console.log('OpenViking install needs repair: Python system certificate bridge is missing.');
      const installCommand = await getPythonSystemCertificatesInstallCommand(serverPath);
      await maybeRun(dryRun, installCommand.executable, installCommand.args);
    }
  } else {
    await runInstallCommands(config, options.packageManager, false, dryRun);
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
    start: false,
  });
  await repairManifest(config, dryRun);

  if (options.start !== false) {
    await repairServerHealth(config, dryRun);
  } else {
    console.log('Skipping server health repair because --no-start was provided.');
  }

  const mcpClients = await resolveMcpClients(options.mcp ?? 'available', 'repair');
  if (mcpClients.length === 0) {
    console.log('Skipping MCP config repair.');
  } else {
    for (const client of mcpClients) {
      console.log(`Repairing ${client} MCP config for ${OPENVIKING_MCP_NAME}.`);
      await runMcpInstall(config, client, {apply: !dryRun, name: OPENVIKING_MCP_NAME});
    }
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
      ? ((await findExecutable([OPENVIKING_SERVER_COMMAND])) ?? OPENVIKING_SERVER_COMMAND)
      : await requiredExecutable(OPENVIKING_SERVER_COMMAND);
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
  const health = await waitForOpenVikingHealth(config, START_HEALTH_TIMEOUT_MS);
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

async function localEmbeddingCheck(): Promise<DoctorCheck> {
  const serverPath = await findExecutable([OPENVIKING_SERVER_COMMAND]);
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
  const serverPath = await findExecutable([OPENVIKING_SERVER_COMMAND]);
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

async function waitForOpenVikingHealth(config: RuntimeConfig, timeoutMs: number): Promise<string | undefined> {
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
}

async function runInstallCommands(
  config: RuntimeConfig,
  preferred: PackageManager | undefined,
  force: boolean,
  dryRun: boolean,
): Promise<void> {
  const installCommands = await getInstallCommands(config, preferred, force);
  for (const installCommand of installCommands) {
    await maybeRun(dryRun, installCommand.executable, installCommand.args);
  }
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

async function getInstallCommands(
  config: RuntimeConfig,
  preferred: PackageManager | undefined,
  force: boolean,
): Promise<readonly MappedCommand[]> {
  const packageSpec = `${OPENVIKING_PACKAGE_NAME}==${config.openVikingVersion}`;
  const manager = preferred ?? (await detectPackageManager());
  if (manager === 'pipx') {
    return [
      {executable: 'pipx', args: force ? ['install', '--force', packageSpec] : ['install', packageSpec]},
      {
        executable: 'pipx',
        args: force
          ? ['inject', '--force', 'openviking', PYTHON_SYSTEM_CERTS_PACKAGE]
          : ['inject', 'openviking', PYTHON_SYSTEM_CERTS_PACKAGE],
      },
    ];
  }
  if (manager === 'uv') {
    const uvArgs = ['tool', 'install', '--native-tls', '--with', PYTHON_SYSTEM_CERTS_PACKAGE];
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
  const source = join(toolRoot(), 'config', 'launchd', `${LAUNCHD_LABEL}.plist.template`);
  const destination = expandPath(`~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
  const rendered = renderTemplate(await readFile(source, 'utf8'), config);
  if (dryRun) {
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
  const health = await waitForOpenVikingHealth(config, START_HEALTH_TIMEOUT_MS);
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
