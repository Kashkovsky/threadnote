import {spawn} from 'node:child_process';
import {closeSync, openSync} from 'node:fs';
import {chmod, readdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {basename, delimiter, dirname, join, sep} from 'node:path';
import {stdin as processStdin, stdout as processStdout} from 'node:process';
import {createInterface} from 'node:readline/promises';
import {Cause, Clock, Console, Effect, Exit, FileSystem, Option, Path} from 'effect';
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
import {
  CommandExecutor,
  maybeRunEffect,
  runCommandEffect,
  runStreamingCommandEffect,
  windowsTaskkillExecutable,
} from './effect/command.js';
import {consoleOutput, syncWithConsole} from './effect/console.js';
import {applicationError, fromPromise} from './effect/errors.js';
import {getTextEffect, HttpService} from './effect/http.js';
import {SystemInfo} from './effect/system.js';
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
import {readSeedManifest, uriSegment} from './manifest.js';
import {
  bootoutLaunchAgent,
  bootstrapLaunchAgent,
  launchAgentPath,
  readLaunchAgentStatus,
  type LaunchAgentStatus,
} from './launchd.js';
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
  CommandResult,
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
  executableNames,
  exists,
  expandPath,
  findExecutable,
  findExecutableCandidates,
  findOpenVikingCli,
  firstLine,
  formatShellCommand,
  formatStatus,
  getInvocationCwd,
  httpGetText,
  isExecutable,
  isJsonObject,
  isSummarySidecarUri,
  isTcpPortOpen,
  maybeRun,
  memoryFrontmatterField,
  memoryUriProjectSegment,
  parseJsonConfigObject,
  pythonUserScriptsCandidateDirs,
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

const INSTALL_OUTPUT_TAIL_CHARS = 64_000;
const MINIMUM_UV_SYSTEM_CERTS_VERSION = '0.11.0';
const STOP_SERVER_TIMEOUT_MS = 10_000;

interface DetachedProcessRecord {
  readonly args?: readonly string[];
  readonly commandLine?: string;
  readonly executablePath?: string;
  readonly launcherPid?: number;
  readonly pid: number;
  readonly server?: string;
  readonly startedAt?: string;
}

export function pythonExecutableCandidates(currentPlatform: NodeJS.Platform = process.platform): readonly string[] {
  return currentPlatform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
}

export function shouldManageCommandShim(currentPlatform: NodeJS.Platform = process.platform): boolean {
  return currentPlatform !== 'win32';
}

interface UvExecutable {
  readonly executable: string;
  readonly version: string | undefined;
}

interface InstallCommandRetry {
  readonly command: MappedCommand;
  readonly env: Readonly<Record<string, string>>;
}

export interface LaunchAgentActivationEffects<R = never> {
  readonly bootout: (timeoutMs: number) => Effect.Effect<boolean, unknown, R>;
  readonly bootstrap: (plistPath: string, timeoutMs: number) => Effect.Effect<void, unknown, R>;
  readonly isPortOpen: (config: RuntimeConfig, timeoutMs: number) => Effect.Effect<boolean, unknown, R>;
  readonly stagePlist: (
    plistPath: string,
    content: string,
  ) => Effect.Effect<LaunchAgentPlistTransaction<R>, unknown, R>;
  readonly stopDetached: (config: RuntimeConfig, timeoutMs: number) => Effect.Effect<boolean, unknown, R>;
  readonly restartDetached: (config: RuntimeConfig, timeoutMs: number) => Effect.Effect<void, unknown, R>;
  readonly waitForHealth: (config: RuntimeConfig, timeoutMs: number) => Effect.Effect<string | undefined, unknown, R>;
  readonly waitForShutdown: (config: RuntimeConfig, timeoutMs: number) => Effect.Effect<boolean, unknown, R>;
}

export interface LaunchAgentPlistTransaction<R = never> {
  readonly hadPrevious: boolean;
  readonly commit: Effect.Effect<void, unknown, R>;
  readonly release: Effect.Effect<void, unknown, R>;
  readonly rollback: Effect.Effect<void, unknown, R>;
}

export interface LaunchAgentHealthEffects<R = never> {
  readonly ownsPort: (pid: number, config: RuntimeConfig, timeoutMs: number) => Effect.Effect<boolean, unknown, R>;
  readonly readHealth: (config: RuntimeConfig, timeoutMs: number) => Effect.Effect<string | undefined, unknown, R>;
  readonly readStatus: (timeoutMs: number) => Effect.Effect<LaunchAgentStatus, unknown, R>;
}

type UserAgentInstructionTarget = (typeof USER_AGENT_INSTRUCTION_TARGETS)[number];

export const runDoctor = Effect.fn('runDoctor')(function* (config: RuntimeConfig, options: DoctorOptions) {
  const system = yield* SystemInfo;
  const checks = yield* fromPromise('collect doctor checks', () =>
    collectDoctorChecks(config, options, system.platform),
  );

  yield* syncWithConsole(() => {
    for (const check of checks) {
      consoleOutput.log(`${formatStatus(check.status)} ${check.name}: ${check.detail}`);
    }

    const failureCount = checks.filter(check => check.status === 'fail').length;
    const warningCount = checks.filter(check => check.status === 'warn').length;
    consoleOutput.log(`\nSummary: ${failureCount} failure(s), ${warningCount} warning(s)`);
    if (options.strict === true && failureCount > 0) {
      process.exitCode = 1;
    }
  });
});

export async function collectDoctorChecks(
  config: RuntimeConfig,
  options: DoctorOptions = {},
  currentPlatform: NodeJS.Platform = process.platform,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push({name: 'mode', status: 'ok', detail: options.dryRun ? 'dry run; no writes' : 'read-only checks'});
  checks.push({
    name: 'platform',
    status: ['darwin', 'linux', 'win32'].includes(currentPlatform) ? 'ok' : 'warn',
    detail: currentPlatform,
  });
  checks.push(await commandCheck('node', ['--version']));
  checks.push(await firstCommandCheck('python', pythonExecutableCandidates(currentPlatform), ['--version']));
  checks.push(await openVikingServerCheck());
  checks.push(await openVikingCliCheck());
  checks.push(await openVikingVersionCheck(config));
  checks.push(await recallShapeCheck(config));
  checks.push(await localEmbeddingCheck());
  checks.push(await pythonSystemCertificatesCheck());
  checks.push(await pythonInstallerCheck());
  checks.push(await commandPresenceCheck('codex', ['--version']));
  checks.push(await commandPresenceCheck('claude', ['--version']));
  checks.push(await commandShimCheck());
  checks.push(...(await userAgentInstructionsChecks()));
  checks.push(await manifestCheck(config.manifestPath));
  checks.push(await recallIndexFreshnessCheck(config));
  checks.push(await memoryProjectConsistencyCheck(config));
  checks.push(await fileCheck(join(toolRoot(), '.threadnoteignore'), 'ignore file'));
  checks.push(await fileCheck(join(toolRoot(), 'config', 'ov.conf.template.json'), 'server config template'));
  checks.push(await fileCheck(join(toolRoot(), 'config', 'ovcli.conf.template.json'), 'cli config template'));
  checks.push(await healthCheck(config));
  return checks;
}

export const runInstall = Effect.fn('runInstall')(function* (config: RuntimeConfig, options: InstallOptions) {
  const repairInvalidConfigs = options.repairInvalidConfigs === true;
  const dryRun = options.dryRun === true;
  yield* fromPromise('create Threadnote home', () => ensureDirectory(config.agentContextHome, dryRun));
  yield* fromPromise('create Threadnote logs directory', () =>
    ensureDirectory(join(config.agentContextHome, 'logs'), dryRun),
  );
  yield* fromPromise('create Threadnote redacted directory', () =>
    ensureDirectory(join(config.agentContextHome, 'redacted'), dryRun),
  );
  yield* fromPromise('create Threadnote MCP directory', () =>
    ensureDirectory(join(config.agentContextHome, 'mcp'), dryRun),
  );
  yield* fromPromise('install command shim', () => installCommandShim(dryRun));
  yield* fromPromise('install user agent instructions', () => installUserAgentInstructions(dryRun));

  const serverPath = yield* fromPromise('find OpenViking server', findOpenVikingServer);
  // True only when an install/repair could have moved or created the
  // openviking-server binary itself. The python-certs branch patches the
  // existing Python env in place, so it does not flip this — the server
  // path is unchanged and the earlier resolution is still valid.
  let serverInstallRan = false;
  if (serverPath) {
    yield* syncWithConsole(() => consoleOutput.log(`OpenViking server already installed: ${serverPath}`));
    const localEmbeddingMissing =
      (yield* fromPromise('check OpenViking local embedding dependency', () =>
        hasLocalEmbeddingDependency(serverPath),
      )) === false;
    const pythonSystemCertificatesMissing =
      (yield* fromPromise('check OpenViking Python certificate bridge', () =>
        hasPythonSystemCertificatesPatch(serverPath),
      )) === false;
    if (options.force === true) {
      yield* syncWithConsole(() =>
        consoleOutput.log(`Reinstalling OpenViking at pinned version ${config.openVikingVersion} (--force).`),
      );
      yield* runInstallCommands(config, options.packageManager, true, dryRun);
      serverInstallRan = true;
    } else if (localEmbeddingMissing) {
      const repairReasons: string[] = [];
      repairReasons.push('local embedding extra is missing');
      if (pythonSystemCertificatesMissing) {
        repairReasons.push('Python system certificate bridge is missing');
      }
      yield* syncWithConsole(() => consoleOutput.log(`OpenViking install needs repair: ${repairReasons.join('; ')}.`));
      yield* runInstallCommands(config, options.packageManager, true, dryRun);
      serverInstallRan = true;
    } else if (pythonSystemCertificatesMissing) {
      yield* syncWithConsole(() =>
        consoleOutput.log('OpenViking install needs repair: Python system certificate bridge is missing.'),
      );
      const installCommand = yield* fromPromise('resolve Python certificate bridge install command', () =>
        getPythonSystemCertificatesInstallCommand(serverPath),
      );
      yield* maybeRunEffect(dryRun, installCommand.executable, installCommand.args);
    }
  } else {
    yield* runInstallCommands(config, options.packageManager, false, dryRun);
    serverInstallRan = true;
  }
  const resolvedServerPath = serverInstallRan
    ? yield* fromPromise('find installed OpenViking server', findOpenVikingServer)
    : serverPath;
  if (serverInstallRan && !resolvedServerPath && !dryRun) {
    // The install command reported success but the binary is unresolvable.
    // Fail loudly for `install`; for `repair` (requireServerBinary === false)
    // warn and continue so config/manifest/MCP/hook repairs still run.
    const message =
      `OpenViking install ran but ${OPENVIKING_SERVER_COMMAND} was not found on PATH, in the uv tool bin dir, or ~/.local/bin. ` +
      'Re-run `threadnote install --force` (it streams the full build), then `threadnote doctor`.';
    if (options.requireServerBinary === false) {
      yield* syncWithConsole(() => consoleOutput.warn(`WARN ${message}`));
    } else {
      return yield* Effect.fail(new Error(message));
    }
  }
  if (resolvedServerPath && !dryRun) {
    yield* fromPromise('print OpenViking path hint', () => maybePrintOpenVikingPathHint(resolvedServerPath));
  }

  yield* fromPromise('write OpenViking server configuration', () =>
    writeTemplateIfMissing({
      config,
      destinationPath: join(config.agentContextHome, 'ov.conf'),
      dryRun,
      shouldRepair: content =>
        shouldRepairOpenVikingConfig(content, config) ||
        (repairInvalidConfigs && parseJsonConfigObject(content) === undefined),
      templatePath: join(toolRoot(), 'config', 'ov.conf.template.json'),
    }),
  );
  yield* fromPromise('write OpenViking CLI configuration', () =>
    writeTemplateIfMissing({
      config,
      destinationPath: join(config.agentContextHome, 'ovcli.conf'),
      dryRun,
      shouldRepair: content =>
        shouldRepairLegacyOvCliConfig(content) ||
        (repairInvalidConfigs && parseJsonConfigObject(content) === undefined),
      templatePath: join(toolRoot(), 'config', 'ovcli.conf.template.json'),
    }),
  );
  yield* fromPromise('configure OpenViking CLI language', () => configureOpenVikingCliLanguage(config, dryRun));

  if (options.start !== false) {
    const healthy = yield* repairServerHealth(config, dryRun);
    if (!healthy && !dryRun) {
      return yield* Effect.fail(
        new Error(`OpenViking did not become healthy. Check logs: ${openVikingLogPath(config)}`),
      );
    }
  }

  if (options.printNextSteps !== false) {
    yield* syncWithConsole(() => printInstallNextSteps({dryRun, startsServer: options.start !== false}));
  }
});

export const runRepair = Effect.fn('runRepair')(function* (config: RuntimeConfig, options: RepairOptions) {
  yield* runRepairCore(config, options);
  if (options.postUpdate !== false) {
    yield* maybeRunPostUpdateAfterRepair(config, {dryRun: options.dryRun === true});
  }
});

function runRepairCore(config: RuntimeConfig, options: RepairOptions) {
  return Effect.gen(function* () {
    const dryRun = options.dryRun === true;
    yield* syncWithConsole(() => consoleOutput.log('Repairing local OpenViking agent context from this checkout.'));

    yield* runInstall(config, {
      dryRun,
      packageManager: options.packageManager,
      printNextSteps: false,
      repairInvalidConfigs: true,
      requireServerBinary: false,
      start: false,
    });
    yield* fromPromise('repair seed manifest', () => repairManifest(config, dryRun));

    if (options.start !== false) {
      yield* repairServerHealth(config, dryRun);
    } else {
      yield* syncWithConsole(() => consoleOutput.log('Skipping server health repair because --no-start was provided.'));
    }
    yield* fromPromise('repair recall index', () => repairRecallIndex(config, dryRun));

    const mcpClients = yield* fromPromise('resolve MCP clients for repair', () =>
      resolveMcpClients(options.mcp ?? 'available', 'repair'),
    );
    if (mcpClients.length === 0) {
      yield* syncWithConsole(() => consoleOutput.log('Skipping MCP config repair.'));
    } else {
      for (const client of mcpClients) {
        yield* syncWithConsole(() => consoleOutput.log(`Repairing ${client} MCP config for ${OPENVIKING_MCP_NAME}.`));
        yield* runMcpInstall(config, client, {apply: !dryRun, name: OPENVIKING_MCP_NAME});
      }
    }

    // Re-install agent hooks only if the user opted in previously (a managed
    // entry already exists). Never adds them unsolicited — `install-hooks` or
    // `install --with-hooks` is the opt-in.
    if (yield* fromPromise('check managed Claude hooks', hasManagedClaudeHooks)) {
      yield* syncWithConsole(() =>
        consoleOutput.log('\nRepairing claude hooks (re-asserting threadnote-managed entries).'),
      );
      yield* runHooksInstall(config, 'claude', {apply: !dryRun, dryRun});
    }

    yield* syncWithConsole(() => consoleOutput.log('\nPost-repair doctor:'));
    yield* runDoctor(config, {dryRun, strict: false});
  });
}

export const runUninstall = Effect.fn('runUninstall')(function* (config: RuntimeConfig, options: UninstallOptions) {
  const dryRun = options.dryRun === true;
  if (options.eraseMemories === true && options.preserveMemories === true) {
    yield* Effect.fail(new Error('Use either --erase-memories or --preserve-memories, not both.'));
  }

  yield* syncWithConsole(() => consoleOutput.log('Uninstalling local Threadnote setup.'));
  yield* runStop(config, {dryRun});
  yield* fromPromise('remove OpenViking pid file', () =>
    removePathIfExists(join(config.agentContextHome, 'openviking-server.pid'), 'pid file', dryRun),
  );
  yield* removeLaunchAgent(dryRun);
  yield* fromPromise('remove MCP configurations', () => removeMcpConfigs(options.mcp ?? 'available', dryRun));
  yield* fromPromise('remove MCP snippets', () => removeMcpSnippets(config, dryRun));
  if (yield* fromPromise('check managed Claude hooks', hasManagedClaudeHooks)) {
    yield* runHooksInstall(config, 'claude', {apply: !dryRun, dryRun, remove: true});
  }
  yield* fromPromise('remove command shim', () => removeCommandShim(dryRun));
  yield* fromPromise('remove user agent instructions', () => removeUserAgentInstructions(dryRun));

  if (options.eraseMemories === true) {
    yield* fromPromise('erase Threadnote home', () => eraseThreadnoteHome(config.agentContextHome, dryRun));
  } else {
    yield* syncWithConsole(() => {
      consoleOutput.log(`Preserving local memories and OpenViking home: ${config.agentContextHome}`);
      consoleOutput.log('Use --erase-memories to delete this directory during uninstall.');
    });
  }

  yield* syncWithConsole(() => {
    consoleOutput.log('Uninstall complete.');
    consoleOutput.log('The package remains installed. Remove it with your package manager if desired.');
  });
});

async function repairManifest(config: RuntimeConfig, dryRun: boolean): Promise<void> {
  try {
    await readSeedManifest(config.manifestPath);
    consoleOutput.log(`Manifest OK: ${config.manifestPath}`);
    return;
  } catch (err: unknown) {
    if (config.manifestPath === builtInExampleManifestPath()) {
      consoleOutput.log(`WARN built-in manifest is not readable: ${errorMessage(err)}`);
      return;
    }
    consoleOutput.log(`Manifest needs repair: ${config.manifestPath} (${errorMessage(err)})`);
  }

  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRoot(getInvocationCwd());
  } catch (err: unknown) {
    consoleOutput.log(`WARN cannot create replacement manifest from current directory: ${errorMessage(err)}`);
    return;
  }

  const project = await projectManifestForRepo(repoRoot, []);
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
    consoleOutput.log(`# Would write replacement manifest: ${config.manifestPath}`);
    consoleOutput.log(output.trimEnd());
    return;
  }

  await ensureDirectory(dirname(config.manifestPath), false);
  const currentContent = await readFileIfExists(config.manifestPath);
  if (currentContent !== undefined) {
    const backupPath = `${config.manifestPath}.legacy-${safeTimestamp()}`;
    await writeFile(backupPath, currentContent, {encoding: 'utf8', mode: 0o600});
    await chmod(backupPath, 0o600);
    consoleOutput.log(`Backup: ${backupPath}`);
  }
  await writeFile(config.manifestPath, output, {encoding: 'utf8', mode: 0o600});
  await chmod(config.manifestPath, 0o600);
  consoleOutput.log(`Wrote replacement manifest: ${config.manifestPath}`);
}

async function repairRecallIndex(config: RuntimeConfig, dryRun: boolean): Promise<void> {
  consoleOutput.log('\nRepairing recall index freshness.');
  const ov = dryRun ? ((await findOpenVikingCli()) ?? 'ov') : await findOpenVikingCli();
  if (!ov) {
    consoleOutput.log('Skipping recall index repair: neither ov nor openviking was found.');
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
      consoleOutput.log('Recall index freshness OK.');
      return;
    }
    for (const message of messages) {
      consoleOutput.log(message);
    }
  } catch (err: unknown) {
    progress.stop();
    consoleOutput.log(`WARN could not repair recall index freshness: ${errorMessage(err)}`);
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
export async function findOpenVikingServer(): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    const onPath = await findExecutable([OPENVIKING_SERVER_COMMAND]);
    if (onPath) {
      return onPath;
    }
  } else {
    for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
      for (const name of openVikingServerExecutableNames()) {
        const candidate = join(directory, name);
        if (await isExecutable(candidate)) {
          return candidate;
        }
      }
    }
  }
  for (const candidateDir of await openVikingServerCandidateDirs()) {
    for (const name of openVikingServerExecutableNames()) {
      const candidate = join(candidateDir, name);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

const findOpenVikingServerEffectCore = Effect.fn('findOpenVikingServer')(function* (timeoutMs: number) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
  const pathDirectories = (process.env.PATH ?? '').split(system.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const directory of pathDirectories) {
    for (const name of openVikingServerExecutableNames(system.platform)) {
      const candidate = join(directory, name);
      if (yield* isExecutableFileEffect(fs, candidate, system.platform)) {
        return candidate;
      }
    }
  }

  const candidateDirectories: string[] = [];
  const uv = yield* findExecutableInDirectoriesEffect(fs, 'uv', pathDirectories, system.platform);
  if (uv) {
    const result = yield* runCommandEffect(uv, ['tool', 'dir', '--bin'], {
      allowFailure: true,
      timeoutMs: yield* remainingBudget(deadline, timeoutMs),
    });
    if (result.exitCode === 0 && result.stdout.trim()) {
      candidateDirectories.push(result.stdout.trim());
    }
  }
  if (process.env.UV_TOOL_BIN_DIR) {
    candidateDirectories.push(process.env.UV_TOOL_BIN_DIR);
  }
  candidateDirectories.push(...(yield* pythonUserScriptsCandidateDirsEffect()));
  candidateDirectories.push(expandPath('~/.local/bin'));
  for (const directory of new Set(candidateDirectories)) {
    for (const name of openVikingServerExecutableNames(system.platform)) {
      const candidate = join(directory, name);
      if (yield* isExecutableFileEffect(fs, candidate, system.platform)) {
        return candidate;
      }
    }
  }
  return undefined;
});

export function openVikingServerExecutableNames(
  currentPlatform: NodeJS.Platform = process.platform,
  pathExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
): readonly string[] {
  const names = executableNames(OPENVIKING_SERVER_COMMAND, currentPlatform, pathExt);
  return currentPlatform === 'win32' ? names.filter(name => /\.(?:com|exe)$/i.test(name)) : names;
}

export function findOpenVikingServerEffect(timeoutMs: number) {
  return findOpenVikingServerEffectCore(timeoutMs).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new Error(`OpenViking server discovery timed out after ${timeoutMs / 1000}s.`)),
    }),
  );
}

const findExecutableInDirectoriesEffect = Effect.fn('findExecutableInDirectories')(function* (
  fs: FileSystem.FileSystem,
  name: string,
  directories: readonly string[],
  currentPlatform: NodeJS.Platform,
) {
  for (const directory of directories) {
    for (const executableName of executableNames(name, currentPlatform)) {
      const candidate = join(directory, executableName);
      if (yield* isExecutableFileEffect(fs, candidate, currentPlatform)) {
        return candidate;
      }
    }
  }
  return undefined;
});

const isExecutableFileEffect = Effect.fn('isExecutableFile')(function* (
  fs: FileSystem.FileSystem,
  path: string,
  currentPlatform: NodeJS.Platform,
) {
  const info = yield* fs.stat(path).pipe(
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.succeed(undefined),
    ),
  );
  return info?.type === 'File' && (currentPlatform === 'win32' || (info.mode & 0o111) !== 0);
});

const findExecutableEffect = Effect.fn('findExecutable')(function* (commands: readonly string[]) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const directories = (process.env.PATH ?? '').split(system.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const command of commands) {
    const executable = yield* findExecutableInDirectoriesEffect(fs, command, directories, system.platform);
    if (executable) {
      return executable;
    }
  }
  return undefined;
});

const pythonUserScriptsCandidateDirsEffect = Effect.fn('pythonUserScriptsCandidateDirs')(function* () {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const directories: string[] = [];
  for (const command of pythonExecutableCandidates(system.platform)) {
    const executable = yield* findExecutableEffect([command]);
    if (!executable) {
      continue;
    }
    const result = yield* runCommandEffect(executable, ['-c', 'import site; print(site.getuserbase())'], {
      allowFailure: true,
      timeoutMs: 5000,
    });
    const userBase = result.exitCode === 0 ? result.stdout.trim() : '';
    if (userBase) {
      directories.push(path.join(userBase, system.platform === 'win32' ? 'Scripts' : 'bin'));
    }
  }
  return Array.from(new Set(directories));
});

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
  dirs.push(...(await pythonUserScriptsCandidateDirs()));
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
  if (process.platform === 'win32') {
    consoleOutput.log(
      `Note: ${serverPath} is installed but ${binDir} is not on this PowerShell PATH. ` +
        `Run \`$env:Path = "${binDir};$env:Path"\` for this shell.`,
    );
    return;
  }
  const rcHint = suggestedShellRc(process.env.SHELL, process.platform);
  consoleOutput.log(
    `Note: ${serverPath} is installed but ${binDir} is not on this shell's PATH. ` +
      `Add \`export PATH="${binDir}:$PATH"\` to ${rcHint} so other tools can find openviking-server.`,
  );
}

function repairServerHealth(config: RuntimeConfig, dryRun: boolean) {
  return Effect.gen(function* () {
    const existingHealth = yield* fromPromise('check OpenViking health', () =>
      readOpenVikingHealthIfAvailable(config, 800),
    );
    if (existingHealth) {
      yield* syncWithConsole(() =>
        consoleOutput.log(`OpenViking health OK at http://${config.host}:${config.port}/health`),
      );
      return true;
    }

    yield* syncWithConsole(() =>
      consoleOutput.log(
        `OpenViking health is not responding at http://${config.host}:${config.port}/health; starting server.`,
      ),
    );
    return yield* runStart(config, {dryRun}).pipe(
      Effect.as(true),
      Effect.catch(error =>
        syncWithConsole(() => {
          consoleOutput.log(`WARN could not repair OpenViking health: ${errorMessage(error)}`);
          return false;
        }),
      ),
    );
  });
}

export const runStart = Effect.fn('runStart')(function* (config: RuntimeConfig, options: StartOptions) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  if (options.launchd === true) {
    yield* installLaunchAgent(config, options.dryRun === true);
    return;
  }

  const server =
    options.dryRun === true
      ? ((yield* fromPromise('find OpenViking server', findOpenVikingServer)) ?? OPENVIKING_SERVER_COMMAND)
      : yield* fromPromise('require OpenViking server', requireOpenVikingServer);
  const args = openVikingServerArgs(config);
  if (options.dryRun === true) {
    yield* syncWithConsole(() => consoleOutput.log(formatShellCommand(server, args)));
    return;
  }

  const existingHealth = yield* fromPromise('check existing OpenViking health', () =>
    readOpenVikingHealthIfAvailable(config, 500),
  );
  const healthUrl = openVikingHealthUrl(config);
  if (existingHealth) {
    yield* syncWithConsole(() => consoleOutput.log(`OpenViking is already healthy at ${healthUrl}`));
    return;
  }
  if (yield* fromPromise('check OpenViking TCP port', () => isTcpPortOpen(config.host, config.port, 500))) {
    return yield* Effect.fail(
      new Error(
        `Port ${config.host}:${config.port} is already in use, but it is not a healthy OpenViking server. ` +
          'Set THREADNOTE_PORT or pass --port to use a different port.',
      ),
    );
  }

  const logPath = openVikingLogPath(config);
  yield* fs.makeDirectory(dirname(logPath), {recursive: true});
  if (options.foreground === true) {
    const result = yield* fromPromise('run OpenViking in foreground', () => runInteractive(server, args));
    yield* syncWithConsole(() => {
      process.exitCode = result;
    });
    return;
  }

  const child = yield* Effect.try({
    try: () => {
      const logFd = openSync(logPath, 'a');
      const spawned = spawnDetachedServerWithLog(server, args, logFd);
      spawned.unref();
      return spawned;
    },
    catch: cause => applicationError('start detached OpenViking server', cause),
  });
  if (child.pid === undefined) {
    return yield* Effect.fail(new Error('Detached OpenViking server did not report a pid.'));
  }
  const childPid = child.pid;
  yield* fs.writeFileString(
    join(config.agentContextHome, 'openviking-server.pid'),
    detachedProcessRecordContent(childPid, server, args, system.platform),
  );
  const health = yield* fromPromise('wait for OpenViking health', () =>
    waitForOpenVikingHealth(config, START_HEALTH_TIMEOUT_MS, `Waiting for OpenViking health at ${healthUrl}.`),
  );
  if (health) {
    let managedPid = childPid;
    if (system.platform === 'win32') {
      const servingProcess = yield* findWindowsServingProcess(childPid, config, server, args);
      if (!servingProcess) {
        const termination = yield* terminateWindowsProcessTree(childPid);
        if (!termination.stopped) {
          return yield* Effect.fail(windowsTerminationError(childPid, termination.result));
        }
        yield* fs.remove(join(config.agentContextHome, 'openviking-server.pid'), {force: true});
        return yield* Effect.fail(
          new Error('OpenViking became healthy, but Threadnote could not verify its Windows serving process.'),
        );
      }
      managedPid = servingProcess.pid;
      yield* fs.writeFileString(
        join(config.agentContextHome, 'openviking-server.pid'),
        windowsDetachedProcessRecordContent(childPid, server, args, servingProcess),
      );
    }
    yield* syncWithConsole(() =>
      consoleOutput.log(`Started OpenViking with pid ${managedPid}. Health OK at ${healthUrl}. Logs: ${logPath}`),
    );
    return;
  }
  if (system.platform === 'win32') {
    const termination = yield* terminateWindowsProcessTree(childPid);
    if (!termination.stopped) {
      return yield* Effect.fail(windowsTerminationError(childPid, termination.result));
    }
    yield* fs.remove(join(config.agentContextHome, 'openviking-server.pid'), {force: true});
  }
  return yield* Effect.fail(
    new Error(
      `Started OpenViking with pid ${childPid}, but ${healthUrl} did not become healthy within ` +
        `${START_HEALTH_TIMEOUT_MS / 1000}s. Logs: ${logPath}`,
    ),
  );
});

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
    windowsHide: true,
  });
}

const restartDetachedOpenVikingServer = Effect.fn('restartDetachedOpenVikingServer')(function* (
  config: RuntimeConfig,
  server: string,
  timeoutMs: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const logPath = openVikingLogPath(config);
  yield* fs.makeDirectory(dirname(logPath), {recursive: true});
  const child = yield* Effect.try({
    try: () => {
      const logFd = openSync(logPath, 'a');
      const spawned = spawnDetachedServerWithLog(server, openVikingServerArgs(config), logFd);
      spawned.unref();
      return spawned;
    },
    catch: cause => applicationError('restore detached OpenViking server', cause),
  });
  if (child.pid === undefined) {
    return yield* Effect.fail(new Error('Restored detached OpenViking server did not report a pid.'));
  }
  const childPid = child.pid;
  yield* fs.writeFileString(
    join(config.agentContextHome, 'openviking-server.pid'),
    detachedProcessRecordContent(childPid, server, openVikingServerArgs(config), system.platform),
  );
  const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
  while ((yield* Clock.currentTimeMillis) < deadline) {
    const remainingMs = deadline - (yield* Clock.currentTimeMillis);
    if (yield* readOpenVikingHealthEffect(config, Math.max(1, Math.min(500, remainingMs)))) {
      if (system.platform === 'win32') {
        const args = openVikingServerArgs(config);
        const servingProcess = yield* findWindowsServingProcess(childPid, config, server, args);
        if (!servingProcess) {
          const termination = yield* terminateWindowsProcessTree(childPid);
          if (!termination.stopped) {
            return yield* Effect.fail(windowsTerminationError(childPid, termination.result));
          }
          yield* fs.remove(join(config.agentContextHome, 'openviking-server.pid'), {force: true});
          return yield* Effect.fail(
            new Error('Restored OpenViking became healthy, but its Windows serving process could not be verified.'),
          );
        }
        yield* fs.writeFileString(
          join(config.agentContextHome, 'openviking-server.pid'),
          windowsDetachedProcessRecordContent(childPid, server, args, servingProcess),
        );
      }
      return;
    }
    yield* Effect.sleep(Math.min(START_HEALTH_POLL_INTERVAL_MS, remainingMs));
  }
  if (system.platform === 'win32') {
    const termination = yield* terminateWindowsProcessTree(childPid);
    if (!termination.stopped) {
      return yield* Effect.fail(windowsTerminationError(childPid, termination.result));
    }
    yield* fs.remove(join(config.agentContextHome, 'openviking-server.pid'), {force: true});
  } else {
    yield* signalProcessEffect(childPid, 'SIGTERM').pipe(Effect.ignore);
  }
  return yield* Effect.fail(
    new Error(`Restored detached OpenViking server did not become healthy within ${timeoutMs}ms.`),
  );
});

export const runStop = Effect.fn('runStop')(function* (config: RuntimeConfig, options: ForgetOptions) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  if (system.platform === 'darwin') {
    yield* bootoutLaunchAgent(options.dryRun === true, undefined, STOP_SERVER_TIMEOUT_MS);
  }

  const pidPath = join(config.agentContextHome, 'openviking-server.pid');
  const pidText = yield* fs.readFileString(pidPath).pipe(
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.succeed(undefined),
    ),
  );
  if (!pidText) {
    yield* syncWithConsole(() => consoleOutput.log('No pid file found for detached OpenViking server.'));
    return;
  }
  const processRecord = parseDetachedProcessRecord(pidText);
  const pid = processRecord?.pid ?? Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0) {
    yield* syncWithConsole(() => consoleOutput.log(`Invalid pid file: ${pidPath}`));
    if (options.dryRun !== true) {
      yield* fs.remove(pidPath, {force: true});
    }
    return;
  }
  if (options.dryRun === true) {
    yield* syncWithConsole(() => consoleOutput.log(`Would stop process ${pid}`));
    return;
  }
  if (!(yield* isProcessRunningEffect(pid))) {
    yield* fs.remove(pidPath, {force: true});
    yield* syncWithConsole(() => consoleOutput.log(`Removed stale pid file for process ${pid}.`));
    return;
  }
  if (system.platform === 'win32') {
    const server =
      processRecord?.server ??
      (yield* fromPromise('find OpenViking server for process verification', findOpenVikingServer));
    if (!server) {
      return yield* Effect.fail(
        new Error(`Refusing to stop process ${pid}: OpenViking server path is unavailable for verification.`),
      );
    }
    const expected = {
      args: processRecord?.args ?? openVikingServerArgs(config),
      commandLine: processRecord?.commandLine,
      executablePath: processRecord?.executablePath,
      launcherPid: processRecord?.launcherPid,
      server,
      startedAt: processRecord?.startedAt,
    };
    if (!(yield* isManagedWindowsOpenVikingProcess(pid, config, expected))) {
      return yield* Effect.fail(
        new Error(`Refusing to stop process ${pid}: the pid file does not identify this Threadnote OpenViking server.`),
      );
    }
    if (!(yield* isManagedWindowsOpenVikingProcess(pid, config, expected))) {
      return yield* Effect.fail(new Error(`Refusing to stop process ${pid}: its identity changed before signaling.`));
    }
  }
  let signaled: boolean;
  if (system.platform === 'win32') {
    const termination = yield* terminateWindowsProcessTree(pid);
    if (!termination.stopped) {
      return yield* Effect.fail(windowsTerminationError(pid, termination.result));
    }
    signaled = true;
  } else {
    signaled = yield* signalProcessEffect(pid, 'SIGTERM');
  }
  if (!signaled) {
    yield* fs.remove(pidPath, {force: true});
    yield* syncWithConsole(() => consoleOutput.log(`Process ${pid} was already stopped.`));
    return;
  }
  const deadline = (yield* Clock.currentTimeMillis) + STOP_SERVER_TIMEOUT_MS;
  while (yield* isProcessRunningEffect(pid)) {
    const remainingMs = deadline - (yield* Clock.currentTimeMillis);
    if (remainingMs <= 0) {
      return yield* Effect.fail(new Error(`Process ${pid} did not stop within ${STOP_SERVER_TIMEOUT_MS / 1000}s.`));
    }
    yield* Effect.sleep(Math.min(START_HEALTH_POLL_INTERVAL_MS, remainingMs));
  }
  yield* fs.remove(pidPath, {force: true});
  yield* syncWithConsole(() => consoleOutput.log(`Stopped process ${pid}`));
});

function detachedProcessRecordContent(
  pid: number,
  server: string,
  args: readonly string[],
  currentPlatform: NodeJS.Platform,
): string {
  if (currentPlatform !== 'win32') {
    return `${pid}\n`;
  }
  return `${JSON.stringify({args, pid, server, startedAt: new Date().toISOString()})}\n`;
}

interface WindowsProcessIdentity {
  readonly commandLine: string;
  readonly executablePath: string;
  readonly pid: number;
  readonly startedAt: string;
}

function windowsDetachedProcessRecordContent(
  launcherPid: number,
  server: string,
  args: readonly string[],
  servingProcess: WindowsProcessIdentity,
): string {
  return `${JSON.stringify({
    args,
    commandLine: servingProcess.commandLine,
    executablePath: servingProcess.executablePath,
    launcherPid,
    pid: servingProcess.pid,
    server,
    startedAt: servingProcess.startedAt,
  })}\n`;
}

function parseDetachedProcessRecord(content: string): DetachedProcessRecord | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value === 'number') {
      return {pid: value};
    }
    if (!isJsonObject(value) || typeof value.pid !== 'number') {
      return undefined;
    }
    const args =
      Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string')
        ? (value.args as readonly string[])
        : undefined;
    return {
      args,
      commandLine: typeof value.commandLine === 'string' ? value.commandLine : undefined,
      executablePath: typeof value.executablePath === 'string' ? value.executablePath : undefined,
      launcherPid: typeof value.launcherPid === 'number' ? value.launcherPid : undefined,
      pid: value.pid,
      server: typeof value.server === 'string' ? value.server : undefined,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : undefined,
    };
  } catch {
    const pid = Number(trimmed);
    return Number.isInteger(pid) ? {pid} : undefined;
  }
}

const findWindowsServingProcess = Effect.fn('findWindowsServingProcess')(function* (
  launcherPid: number,
  config: RuntimeConfig,
  server: string,
  args: readonly string[],
) {
  const powershell = yield* findExecutableEffect(['powershell.exe', 'pwsh.exe', 'powershell', 'pwsh']);
  if (!powershell) {
    return undefined;
  }
  const script = `
$processes = @(Get-CimInstance Win32_Process)
$owners = @(Get-NetTCPConnection -LocalPort ${config.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)
$match = $null
foreach ($owner in $owners) {
  $candidate = $processes | Where-Object { $_.ProcessId -eq $owner } | Select-Object -First 1
  $cursor = [uint32]$owner
  while ($null -ne $candidate -and $cursor -gt 0) {
    if ($cursor -eq ${launcherPid}) {
      $match = $processes | Where-Object { $_.ProcessId -eq $owner } | Select-Object -First 1
      break
    }
    $cursor = [uint32]$candidate.ParentProcessId
    $candidate = $processes | Where-Object { $_.ProcessId -eq $cursor } | Select-Object -First 1
  }
  if ($null -ne $match) { break }
}
if ($null -eq $match) { exit 4 }
[pscustomobject]@{
  CommandLine = $match.CommandLine
  CreationTime = $match.CreationDate.ToUniversalTime().ToString('o')
  ExecutablePath = $match.ExecutablePath
  ProcessId = $match.ProcessId
} | ConvertTo-Json -Compress
`.trim();
  const result = yield* runCommandEffect(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    allowFailure: true,
    timeoutMs: 5000,
  });
  if (result.exitCode !== 0) {
    return undefined;
  }
  const identity = parseWindowsProcessIdentity(result.stdout);
  if (!identity || !matchesExpectedWindowsProcess(identity, server, args)) {
    return undefined;
  }
  return identity;
});

function parseWindowsProcessIdentity(output: string): WindowsProcessIdentity | undefined {
  try {
    const value: unknown = JSON.parse(output);
    if (
      !isJsonObject(value) ||
      typeof value.CommandLine !== 'string' ||
      typeof value.CreationTime !== 'string' ||
      typeof value.ExecutablePath !== 'string' ||
      typeof value.ProcessId !== 'number'
    ) {
      return undefined;
    }
    return {
      commandLine: value.CommandLine,
      executablePath: value.ExecutablePath,
      pid: value.ProcessId,
      startedAt: value.CreationTime,
    };
  } catch {
    return undefined;
  }
}

function matchesExpectedWindowsProcess(
  identity: Pick<WindowsProcessIdentity, 'commandLine' | 'executablePath'>,
  server: string,
  args: readonly string[],
): boolean {
  const commandLine = identity.commandLine.toLowerCase();
  const expectedServer = basename(server).toLowerCase();
  if (!commandLine.includes(expectedServer) && basename(identity.executablePath).toLowerCase() !== expectedServer) {
    return false;
  }
  return args.every(arg => commandLine.includes(arg.toLowerCase()));
}

const terminateWindowsProcessTree = Effect.fn('terminateWindowsProcessTree')(function* (pid: number) {
  const result = yield* runCommandEffect(windowsTaskkillExecutable(), ['/pid', String(pid), '/t', '/f'], {
    allowFailure: true,
    timeoutMs: 5000,
  });
  return {result, stopped: !(yield* isProcessRunningEffect(pid))};
});

function windowsTerminationError(pid: number, result: CommandResult): Error {
  const detail = firstLine(result.stderr) || firstLine(result.stdout) || `taskkill exited with ${result.exitCode}`;
  return new Error(`Could not terminate Windows process tree ${pid}; preserving its pid record: ${detail}`);
}

const isManagedWindowsOpenVikingProcess = Effect.fn('isManagedWindowsOpenVikingProcess')(function* (
  pid: number,
  config: RuntimeConfig,
  expected: {
    readonly args: readonly string[];
    readonly commandLine?: string;
    readonly executablePath?: string;
    readonly launcherPid?: number;
    readonly server: string;
    readonly startedAt?: string;
  },
) {
  const powershell = yield* findExecutableEffect(['powershell.exe', 'pwsh.exe', 'powershell', 'pwsh']);
  if (!powershell) {
    return false;
  }
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    'if ($null -eq $process) { exit 3 }',
    `$owners = @(Get-NetTCPConnection -LocalPort ${config.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)`,
    `[pscustomobject]@{CommandLine=$process.CommandLine;CreationTime=$process.CreationDate.ToUniversalTime().ToString('o');ExecutablePath=$process.ExecutablePath;OwnsPort=($owners -contains ${pid})} | ConvertTo-Json -Compress`,
  ].join('; ');
  const result = yield* runCommandEffect(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    allowFailure: true,
    timeoutMs: 5000,
  });
  if (result.exitCode !== 0) {
    return false;
  }
  let identity: JsonObject;
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!isJsonObject(value)) {
      return false;
    }
    identity = value;
  } catch {
    return false;
  }
  if (identity.OwnsPort !== true || typeof identity.CommandLine !== 'string') {
    return false;
  }
  const commandLine = identity.CommandLine;
  const executablePath = typeof identity.ExecutablePath === 'string' ? identity.ExecutablePath : '';
  if (expected.commandLine && commandLine.toLowerCase() !== expected.commandLine.toLowerCase()) {
    return false;
  }
  if (expected.executablePath && executablePath.toLowerCase() !== expected.executablePath.toLowerCase()) {
    return false;
  }
  if (!matchesExpectedWindowsProcess({commandLine, executablePath}, expected.server, expected.args)) {
    return false;
  }
  if (expected.startedAt) {
    const recordedAt = Date.parse(expected.startedAt);
    const createdAt = typeof identity.CreationTime === 'string' ? Date.parse(identity.CreationTime) : Number.NaN;
    if (!Number.isFinite(recordedAt) || !Number.isFinite(createdAt) || Math.abs(recordedAt - createdAt) > 30_000) {
      return false;
    }
  }
  return true;
});

const stopDetachedOpenVikingServerForLaunchdCore = Effect.fn('stopDetachedOpenVikingServerForLaunchd')(function* (
  config: RuntimeConfig,
  dryRun: boolean,
  timeoutMs: number = STOP_SERVER_TIMEOUT_MS,
  resolvedServer?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const pidPath = join(config.agentContextHome, 'openviking-server.pid');
  const pidText = yield* fs.readFileString(pidPath).pipe(
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.succeed(undefined),
    ),
  );
  if (pidText === undefined) {
    yield* Console.log('No pid file found for detached OpenViking server.');
    return false;
  }
  const pid = Number(pidText.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    yield* Console.log(`Invalid pid file: ${pidPath}`);
    if (!dryRun) {
      yield* fs.remove(pidPath, {force: true});
    }
    return false;
  }
  if (dryRun) {
    yield* Console.log(`Would stop detached OpenViking process ${pid}`);
    return true;
  }
  const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
  if (!(yield* isProcessRunningEffect(pid))) {
    yield* fs.remove(pidPath, {force: true});
    return false;
  }
  const server = resolvedServer ?? (yield* findOpenVikingServerEffect(yield* remainingBudget(deadline, timeoutMs)));
  if (!server) {
    return yield* Effect.fail(new Error(`Refusing to stop process ${pid}: OpenViking server path is unavailable.`));
  }
  const expectedProcess = {
    args: openVikingServerArgs(config),
    server,
    shebangInterpreter: yield* fs.readFileString(server).pipe(
      Effect.map(parseShebangInterpreter),
      Effect.catch(() => Effect.succeed(undefined)),
    ),
  };
  if (!(yield* isManagedDetachedOpenVikingProcess(pid, pidPath, config, expectedProcess, deadline, timeoutMs))) {
    return yield* Effect.fail(
      new Error(`Refusing to stop process ${pid}: the pid file does not identify this Threadnote OpenViking server.`),
    );
  }
  if (!(yield* isManagedDetachedOpenVikingProcess(pid, pidPath, config, expectedProcess, deadline, timeoutMs))) {
    return yield* Effect.fail(new Error(`Refusing to stop process ${pid}: its identity changed before signaling.`));
  }
  const signaled = yield* signalProcessEffect(pid, 'SIGTERM');
  if (!signaled) {
    yield* fs.remove(pidPath, {force: true});
    return false;
  }
  while (yield* isProcessRunningEffect(pid)) {
    const remainingMs = deadline - (yield* Clock.currentTimeMillis);
    if (remainingMs <= 0) {
      return yield* Effect.fail(
        new Error(`Detached OpenViking process ${pid} did not stop within ${timeoutMs / 1000}s.`),
      );
    }
    yield* Effect.sleep(Math.min(START_HEALTH_POLL_INTERVAL_MS, remainingMs));
  }
  yield* fs.remove(pidPath, {force: true});
  yield* Console.log(`Stopped detached OpenViking process ${pid}`);
  return true;
});

export function stopDetachedOpenVikingServerForLaunchd(
  config: RuntimeConfig,
  dryRun: boolean,
  timeoutMs: number = STOP_SERVER_TIMEOUT_MS,
  resolvedServer?: string,
) {
  return stopDetachedOpenVikingServerForLaunchdCore(config, dryRun, timeoutMs, resolvedServer).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(new Error(`Stopping the detached OpenViking server timed out after ${timeoutMs / 1000}s.`)),
    }),
  );
}

interface ExpectedOpenVikingProcess {
  readonly args: readonly string[];
  readonly server: string;
  readonly shebangInterpreter?: string;
}

const isManagedDetachedOpenVikingProcess = Effect.fn('isManagedDetachedOpenVikingProcess')(function* (
  pid: number,
  pidPath: string,
  config: RuntimeConfig,
  expected: ExpectedOpenVikingProcess,
  deadline: number,
  timeoutMs: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const result = yield* runCommandEffect('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
    allowFailure: true,
    timeoutMs: yield* remainingBudget(deadline, timeoutMs),
  });
  if (result.exitCode !== 0) {
    return false;
  }
  const output = result.stdout.trim();
  const processStartedAt = Date.parse(output.slice(0, 24));
  const pidFile = yield* fs.stat(pidPath);
  const pidFileMtime = Option.getOrUndefined(pidFile.mtime)?.getTime();
  if (
    !Number.isFinite(processStartedAt) ||
    pidFileMtime === undefined ||
    Math.abs(pidFileMtime - processStartedAt) > 2000
  ) {
    return false;
  }
  const command = output.slice(24).trim();
  if (!isExpectedLaunchdProcessCommand(command, expected.server, expected.args, expected.shebangInterpreter)) {
    return false;
  }
  return yield* launchdProcessOwnsPort(pid, config, Math.min(yield* remainingBudget(deadline, timeoutMs), 2000));
});

export function isExpectedLaunchdProcessCommand(
  command: string,
  server: string,
  args: readonly string[],
  shebangInterpreter?: string,
): boolean {
  const directCommand = [server, ...args].join(' ');
  return (
    command === directCommand ||
    (shebangInterpreter !== undefined && command === `${shebangInterpreter} ${directCommand}`)
  );
}

function parseShebangInterpreter(content: string): string | undefined {
  const first = content.split(/\r?\n/, 1)[0];
  const interpreter = first?.startsWith('#!') ? first.slice(2).trim() : '';
  return interpreter && !/\s/.test(interpreter) ? interpreter : undefined;
}

const isProcessRunningEffect = Effect.fn('isProcessRunning')(function* (pid: number) {
  return yield* Effect.try({
    try: () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (cause: unknown) {
        if (isNodeError(cause) && cause.code === 'ESRCH') {
          return false;
        }
        throw cause;
      }
    },
    catch: cause => applicationError(`check process ${pid}`, cause),
  });
});

const signalProcessEffect = Effect.fn('signalProcess')(function* (pid: number, signal: NodeJS.Signals) {
  return yield* Effect.try({
    try: () => {
      try {
        process.kill(pid, signal);
        return true;
      } catch (cause: unknown) {
        if (isNodeError(cause) && cause.code === 'ESRCH') {
          return false;
        }
        throw cause;
      }
    },
    catch: cause => applicationError(`signal process ${pid}`, cause),
  });
});

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
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

async function pythonInstallerCheck(): Promise<DoctorCheck> {
  const failures: string[] = [];
  for (const manager of ['uv', 'pipx']) {
    const executable = await findExecutable([manager]);
    if (!executable) {
      continue;
    }
    const result = await runCommand(executable, ['--version'], {allowFailure: true});
    if (result.exitCode === 0) {
      return {
        name: 'python installer',
        status: 'ok',
        detail: `${manager}: ${firstLine(result.stdout || result.stderr) || executable}`,
      };
    }
    failures.push(`${manager}: ${firstLine(result.stderr || result.stdout) || 'not working'}`);
  }
  for (const python of pythonExecutableCandidates()) {
    const executable = await findExecutable([python]);
    if (!executable) {
      continue;
    }
    const result = await runCommand(executable, ['-m', 'pip', '--version'], {allowFailure: true});
    if (result.exitCode === 0) {
      return {
        name: 'python installer',
        status: 'ok',
        detail: `${python} -m pip: ${firstLine(result.stdout || result.stderr) || executable}`,
      };
    }
    failures.push(`${python} -m pip: ${firstLine(result.stderr || result.stdout) || 'not working'}`);
  }
  return {
    name: 'python installer',
    status: 'fail',
    detail: failures.length > 0 ? failures.join('; ') : 'none found: uv, pipx, or Python with pip',
  };
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
      detail: `could not detect via \`${executable} --version\`; pinned ${pinned}`,
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
  if (!shouldManageCommandShim()) {
    const launcher = await findExecutable(['threadnote']);
    return launcher
      ? {name: 'threadnote launcher', status: 'ok', detail: launcher}
      : {
          name: 'threadnote launcher',
          status: 'warn',
          detail: 'npm threadnote.cmd launcher is not on PATH; repair preserves package-manager launchers',
        };
  }
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
  const names = process.platform === 'win32' ? ['python.exe', 'python'] : ['python'];
  for (const name of names) {
    const pythonPath = join(dirname(resolvedPath), name);
    if (await exists(pythonPath)) {
      return pythonPath;
    }
  }
  return undefined;
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

/**
 * Flag memories whose frontmatter `project` disagrees with the project segment
 * of their storage path. Recall scopes and boosts by the path project, so a
 * divergence (e.g. a shared memory living under `.../projects/coda/` but tagged
 * `project: mobile-native`) makes project-aware ranking unreliable. Read-only:
 * walks the on-disk memories tree and reports; the fix is to re-store the memory
 * under the correct project (which relocates the file).
 */
export async function memoryProjectConsistencyCheck(config: RuntimeConfig): Promise<DoctorCheck> {
  const name = 'memory project consistency';
  const memoriesRoot = join(
    config.agentContextHome,
    'data',
    'viking',
    config.account,
    'user',
    uriSegment(config.user),
    'memories',
  );
  try {
    let entries: string[];
    try {
      entries = await readdir(memoriesRoot, {recursive: true});
    } catch {
      return {name, status: 'ok', detail: 'no memories directory yet'};
    }
    const mismatches: string[] = [];
    let checked = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.md') || isSummarySidecarUri(entry)) {
        continue;
      }
      const uri = `viking://user/${uriSegment(config.user)}/memories/${entry.split(sep).join('/')}`;
      const pathProject = memoryUriProjectSegment(uri);
      if (!pathProject) {
        continue;
      }
      let content: string;
      try {
        content = await readFile(join(memoriesRoot, entry), 'utf8');
      } catch {
        // Removed mid-walk (concurrent forget/compact/archive) or transiently
        // unreadable — skip this file rather than aborting the whole check.
        continue;
      }
      checked += 1;
      const frontProject = memoryFrontmatterField(content, 'project');
      if (frontProject && uriSegment(frontProject) !== pathProject) {
        mismatches.push(`${uri} (frontmatter "${frontProject}" vs path "${pathProject}")`);
      }
    }
    if (mismatches.length === 0) {
      return {name, status: 'ok', detail: `${checked} project-scoped memories consistent`};
    }
    const sample = mismatches.slice(0, 3).join('; ');
    const extra = Math.max(0, mismatches.length - 3);
    return {
      name,
      status: 'warn',
      detail:
        `${mismatches.length} memory(ies) whose frontmatter project differs from their storage path; ` +
        `re-store under the correct project to fix: ${sample}${extra > 0 ? `, +${extra} more` : ''}`,
    };
  } catch (err: unknown) {
    return {name, status: 'warn', detail: errorMessage(err)};
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
      if (health) return health;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(START_HEALTH_POLL_INTERVAL_MS, remainingMs));
    }
    return undefined;
  } finally {
    progress?.stop();
  }
}

const runInstallCommands = Effect.fn('runInstallCommands')(function* (
  config: RuntimeConfig,
  preferred: PackageManager | undefined,
  force: boolean,
  dryRun: boolean,
) {
  // When the user didn't ask for a specific manager and detection fell back
  // to plain `pip`, offer to install `uv` first — `pip install --user` is
  // refused under PEP 668 on Homebrew / system-managed Python, which is most
  // macOS and modern Linux setups.
  let manager = preferred;
  if (manager === undefined && !dryRun) {
    const detected = yield* fromPromise('detect OpenViking package manager', detectPackageManager);
    if (detected === 'pip' && (yield* fromPromise('offer to install uv', offerToInstallUv))) {
      const rediscovered = yield* fromPromise('rediscover OpenViking package manager', detectPackageManager);
      if (rediscovered === 'uv') {
        manager = 'uv';
      }
    }
  }
  const installCommands = yield* fromPromise('build OpenViking install commands', () =>
    getInstallCommands(config, manager, force),
  );
  for (const installCommand of installCommands) {
    if (dryRun) {
      yield* maybeRunEffect(true, installCommand.executable, installCommand.args);
      continue;
    }
    const resolvedInstallCommand = yield* fromPromise('resolve OpenViking install command', () =>
      resolveOpenVikingInstallCommand(installCommand),
    );
    // Stream live instead of buffering through runCommand. openviking[local-embed]
    // can compile llama-cpp-python from source (10-20 min, memory-heavy); buffering
    // hides all progress and the 10-minute command timeout would SIGKILL a
    // legitimate build. Because uv/pipx --force removes the existing tool env
    // first, a killed reinstall leaves openviking-server missing — so we also
    // print recovery guidance before failing.
    consoleOutput.log(`Running: ${formatShellCommand(resolvedInstallCommand.executable, resolvedInstallCommand.args)}`);
    const result = yield* runStreamingCommandEffect(resolvedInstallCommand.executable, resolvedInstallCommand.args, {
      maxOutputChars: INSTALL_OUTPUT_TAIL_CHARS,
    });
    if (result.exitCode !== 0) {
      const commandOutput = `${result.stderr}\n${result.stdout}`;
      const retry = openVikingSourceBuildRetryForArchiveFailure(resolvedInstallCommand, commandOutput);
      if (retry) {
        consoleOutput.error('');
        consoleOutput.error(
          'The prebuilt llama-cpp-python wheel failed ZIP archive validation; retrying with a local source build.',
        );
        consoleOutput.error('This avoids the rejected wheel and can take 10-20 minutes.');
        consoleOutput.log(`Running: ${formatInstallCommand(retry.command, retry.env)}`);
        const retryResult = yield* runStreamingCommandEffect(retry.command.executable, retry.command.args, {
          env: {...process.env, ...retry.env},
          maxOutputChars: INSTALL_OUTPUT_TAIL_CHARS,
        });
        if (retryResult.exitCode === 0) {
          continue;
        }
        printOpenVikingInstallFailureHelp(retry.command, `${retryResult.stderr}\n${retryResult.stdout}`);
        throw new Error(
          `${formatInstallCommand(retry.command, retry.env)} exited with ${retryResult.exitCode} after automatic source-build retry.`,
        );
      }

      printOpenVikingInstallFailureHelp(resolvedInstallCommand, commandOutput);
      throw new Error(
        `${formatShellCommand(resolvedInstallCommand.executable, resolvedInstallCommand.args)} exited with ${result.exitCode}.`,
      );
    }
  }
});

function printOpenVikingInstallFailureHelp(failedCommand: MappedCommand, commandOutput: string): void {
  for (const line of openVikingInstallFailureHelpLines(failedCommand, commandOutput)) {
    consoleOutput.error(line);
  }
}

export function openVikingInstallFailureHelpLines(failedCommand: MappedCommand, commandOutput = ''): readonly string[] {
  if (isLlamaWheelArchiveExtractionFailure(commandOutput)) {
    return [
      '',
      'OpenViking install did not complete.',
      'The prebuilt llama-cpp-python wheel failed ZIP archive validation. Threadnote only falls back to a source build automatically when the failed command came from a prebuilt wheel index.',
    ];
  }

  const lines = [
    '',
    'OpenViking install did not complete.',
    'openviking[local-embed] includes llama-cpp-python, which compiles from source when no prebuilt wheel matches your Python/platform — that build can run 10-20 minutes and is memory-heavy, so it may be killed by the OS (out of memory) or look stuck.',
    'The package-manager output above contains the underlying build or download error.',
  ];
  if (isUvExecutable(failedCommand.executable)) {
    if (failedCommand.args.includes('--python')) {
      lines.push(
        'If uv could not fetch managed CPython, Threadnote cannot complete the local install until that Python download is available.',
      );
    }
  }
  return lines;
}

export function isLlamaWheelArchiveExtractionFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    (normalized.includes('llama-cpp-python') || normalized.includes('llama_cpp_python')) &&
    (normalized.includes('failed to extract archive') ||
      normalized.includes('zip file contains trailing contents after the end-of-central-directory record'))
  );
}

export function openVikingSourceBuildRetryForArchiveFailure(
  failedCommand: MappedCommand,
  commandOutput: string,
): InstallCommandRetry | undefined {
  if (!isLlamaWheelArchiveExtractionFailure(commandOutput)) {
    return undefined;
  }
  const command = withoutExtraIndexUrl(failedCommand);
  if (!command) {
    return undefined;
  }
  return {command, env: sourceBuildEnvironment(failedCommand)};
}

function withoutExtraIndexUrl(command: MappedCommand): MappedCommand | undefined {
  const args: string[] = [];
  let changed = false;
  for (let index = 0; index < command.args.length; index += 1) {
    const arg = command.args[index];
    const next = command.args[index + 1];
    if (arg === '--extra-index-url' && next !== undefined) {
      changed = true;
      index += 1;
      continue;
    }
    if (arg === '--pip-args' && next?.includes('--extra-index-url') === true) {
      changed = true;
      index += 1;
      continue;
    }
    args.push(arg);
  }
  return changed ? {...command, args} : undefined;
}

function formatInstallCommand(command: MappedCommand, env: Readonly<Record<string, string>> = {}): string {
  return [...formatEnvironmentAssignments(env), formatShellCommand(command.executable, command.args)].join(' ');
}

function formatEnvironmentAssignments(env: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(env).map(([key, value]) =>
    key === 'CMAKE_ARGS' ? `${key}="${value.replaceAll('"', '\\"')}"` : `${key}=${shellQuote(value)}`,
  );
}

function sourceBuildEnvironment(command: MappedCommand): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  if (extraIndexUrl(command)?.replace(/\/+$/, '').toLowerCase().endsWith('/metal') === true) {
    env.CMAKE_ARGS = '-DGGML_METAL=on';
  }
  env.CMAKE_BUILD_PARALLEL_LEVEL = '2';
  return env;
}

function extraIndexUrl(command: MappedCommand): string | undefined {
  for (let index = 0; index < command.args.length; index += 1) {
    const arg = command.args[index];
    if (arg === '--extra-index-url') {
      return command.args[index + 1];
    }
    if (arg === '--pip-args') {
      const match = command.args[index + 1]?.match(/(?:^|\s)--extra-index-url\s+(\S+)/);
      if (match) {
        return match[1];
      }
    }
  }
  return undefined;
}

async function offerToInstallUv(): Promise<boolean> {
  if (processStdin.isTTY !== true || processStdout.isTTY !== true) {
    if (process.platform === 'win32') {
      consoleOutput.warn(
        'Neither uv nor pipx was found on PATH. Falling back to Python pip. ' +
          'Install uv with `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"` ' +
          'and re-run with --package-manager uv for an isolated OpenViking environment.',
      );
      return false;
    }
    consoleOutput.warn(
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
    consoleOutput.log(
      'Continuing with `python3 -m pip install --user`. You may hit PEP 668 errors on managed Pythons.',
    );
    return false;
  }
  return await installUv();
}

async function installUv(): Promise<boolean> {
  if (process.platform === 'win32') {
    const powershell = await findExecutable(['powershell', 'pwsh']);
    if (!powershell) {
      consoleOutput.warn('Could not install uv automatically because PowerShell was not found.');
      return false;
    }
    consoleOutput.log('Installing uv via the official PowerShell installer...');
    const result = await runCommand(
      powershell,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex'],
      {allowFailure: true},
    );
    if (result.exitCode === 0) {
      process.env.PATH = [join(expandPath('~'), '.local', 'bin'), process.env.PATH ?? ''].join(delimiter);
      if (await findExecutable(['uv'])) {
        candidateDirsPromise = undefined;
        return true;
      }
    }
    consoleOutput.warn('uv installation did not produce an executable on PATH. Open a new PowerShell and retry.');
    return false;
  }
  const brew = await findExecutable(['brew']);
  if (brew) {
    consoleOutput.log('Installing uv via Homebrew...');
    const result = await runCommand(brew, ['install', 'uv'], {allowFailure: true});
    if (result.exitCode === 0) {
      if (result.stdout.trim()) {
        consoleOutput.log(result.stdout.trim());
      }
      if (await findExecutable(['uv'])) {
        // Drop the candidate-dirs cache so subsequent openviking-server
        // resolutions can query `uv tool dir --bin` now that uv is on PATH.
        candidateDirsPromise = undefined;
        return true;
      }
    } else {
      consoleOutput.warn(`brew install uv failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }
  // Fall back to the official install script. Requires curl + sh; honors any
  // proxy env vars the user already has.
  if ((await findExecutable(['curl'])) && (await findExecutable(['sh']))) {
    consoleOutput.log(
      'Installing uv via the official install script (curl -LsSf https://astral.sh/uv/install.sh | sh)...',
    );
    const result = await runCommand('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], {
      allowFailure: true,
    });
    if (result.exitCode === 0) {
      if (result.stdout.trim()) {
        consoleOutput.log(result.stdout.trim());
      }
      if (await findExecutable(['uv'])) {
        candidateDirsPromise = undefined;
        return true;
      }
      consoleOutput.warn(
        'uv installed, but the new binary is not yet on this shell PATH. Open a new shell (or `source ~/.zshrc` / `source ~/.bashrc`) and re-run `threadnote install`.',
      );
      return false;
    }
    consoleOutput.warn(`uv install script failed: ${(result.stderr || result.stdout).trim()}`);
  }
  consoleOutput.warn(
    'Could not install uv automatically. Install it manually (brew install uv) and re-run threadnote install.',
  );
  return false;
}

async function uvExecutables(): Promise<readonly UvExecutable[]> {
  const executables = await findExecutableCandidates(['uv']);
  return await Promise.all(
    executables.map(async executable => {
      const result = await runCommand(executable, ['--version'], {allowFailure: true, timeoutMs: 5000});
      const match = `${result.stdout}\n${result.stderr}`.match(/\buv\s+v?(\d+(?:\.\d+){1,2})\b/i);
      return {executable, version: match?.[1]};
    }),
  );
}

export async function findSupportedUvExecutable(): Promise<string | undefined> {
  const candidates = await uvExecutables();
  return candidates.find(
    candidate =>
      candidate.version !== undefined && compareVersions(candidate.version, MINIMUM_UV_SYSTEM_CERTS_VERSION) >= 0,
  )?.executable;
}

export async function ensureSupportedUvExecutable(): Promise<string | undefined> {
  const candidates = await uvExecutables();
  const supported = candidates.find(
    candidate =>
      candidate.version !== undefined && compareVersions(candidate.version, MINIMUM_UV_SYSTEM_CERTS_VERSION) >= 0,
  );
  if (supported) {
    return supported.executable;
  }
  if (candidates.length === 0) {
    return undefined;
  }

  consoleOutput.log(`Updating uv to ${MINIMUM_UV_SYSTEM_CERTS_VERSION} or newer for system certificate support.`);
  for (const candidate of candidates) {
    const result = await runCommand(candidate.executable, ['self', 'update'], {allowFailure: true});
    if (result.exitCode === 0) {
      const updated = await findSupportedUvExecutable();
      if (updated) {
        return updated;
      }
    }
  }

  const brew = await findExecutable(['brew']);
  if (brew) {
    const result = await runCommand(brew, ['upgrade', 'uv'], {allowFailure: true});
    if (result.exitCode === 0) {
      const updated = await findSupportedUvExecutable();
      if (updated) {
        return updated;
      }
    }
  }

  const found = candidates
    .map(candidate => `${candidate.version ?? 'unknown version'} at ${candidate.executable}`)
    .join(', ');
  throw new Error(
    `Threadnote requires uv ${MINIMUM_UV_SYSTEM_CERTS_VERSION} or newer to use --system-certs. ` +
      `Found ${found}; automatic update did not produce a compatible uv. ` +
      'Run `uv self update` (standalone install) or `brew upgrade uv`, then re-run `threadnote update`.',
  );
}

function isUvExecutable(executable: string): boolean {
  const name = basename(executable).toLowerCase();
  return name === 'uv' || name === 'uv.exe';
}

export async function resolveOpenVikingInstallCommand(command: MappedCommand): Promise<MappedCommand> {
  if (!isUvExecutable(command.executable)) {
    return command;
  }
  const uv = await ensureSupportedUvExecutable();
  if (!uv) {
    throw new Error(
      `uv was selected to install OpenViking but was not found on PATH. Install uv ${MINIMUM_UV_SYSTEM_CERTS_VERSION} or newer and re-run Threadnote.`,
    );
  }
  return {...command, executable: uv};
}

async function getPythonSystemCertificatesInstallCommand(serverPath: string): Promise<MappedCommand> {
  const pythonPath = await siblingPythonForExecutable(serverPath);
  if (!pythonPath) {
    throw new Error(`Could not find the OpenViking Python environment for ${serverPath}`);
  }
  const uvPath = await ensureSupportedUvExecutable();
  if (uvPath) {
    return {
      executable: uvPath,
      args: ['pip', 'install', '--system-certs', '--python', pythonPath, PYTHON_SYSTEM_CERTS_PACKAGE],
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
  return process.platform === 'darwin' ? `${base}/metal` : `${base}/cpu`;
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
      '--system-certs',
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
  const executable = (await findExecutable(pythonExecutableCandidates())) ?? pythonExecutableCandidates()[0]!;
  return [{executable, args: pipArgs}];
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
    consoleOutput.log('Dry run complete. Run without --dry-run to install and start OpenViking.');
    return;
  }

  if (options.startsServer) {
    consoleOutput.log('Install complete. OpenViking health is ready. Next:');
    consoleOutput.log('  threadnote doctor --dry-run');
    return;
  }

  consoleOutput.log('Install complete. Run start, then doctor:');
  consoleOutput.log('  threadnote start');
  consoleOutput.log('  threadnote doctor --dry-run');
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
      consoleOutput.log(`Already exists: ${options.destinationPath}`);
      return;
    }
    const rendered = renderTemplate(await readFile(options.templatePath, 'utf8'), options.config);
    if (options.dryRun) {
      consoleOutput.log(`Would repair generated config: ${options.destinationPath}`);
      return;
    }
    const backupPath = `${options.destinationPath}.legacy-${safeTimestamp()}`;
    await writeFile(backupPath, currentContent, {encoding: 'utf8', mode: 0o600});
    await chmod(backupPath, 0o600);
    await writeFile(options.destinationPath, rendered, {encoding: 'utf8', mode: 0o600});
    await chmod(options.destinationPath, 0o600);
    consoleOutput.log(`Repaired generated config: ${options.destinationPath}`);
    consoleOutput.log(`Backup: ${backupPath}`);
    return;
  }
  const rendered = renderTemplate(await readFile(options.templatePath, 'utf8'), options.config);
  if (options.dryRun) {
    consoleOutput.log(`Would write ${options.destinationPath}`);
    return;
  }
  await ensureDirectory(dirname(options.destinationPath), false);
  await writeFile(options.destinationPath, rendered, {encoding: 'utf8', mode: 0o600});
  await chmod(options.destinationPath, 0o600);
  consoleOutput.log(`Wrote ${options.destinationPath}`);
}

async function installCommandShim(dryRun: boolean): Promise<void> {
  if (!shouldManageCommandShim()) {
    consoleOutput.log('Preserving the package-manager threadnote.cmd launcher on Windows.');
    return;
  }
  const binDir = expandPath(process.env.THREADNOTE_BIN_DIR ?? '~/.local/bin');
  const shimPath = join(binDir, 'threadnote');
  const existingContent = await readFileIfExists(shimPath);
  if (existingContent && !isManagedCommandShim(existingContent)) {
    consoleOutput.log(`WARN not overwriting existing command shim: ${shimPath}`);
    return;
  }

  const content = renderCommandShim();
  if (existingContent === content) {
    consoleOutput.log(`Already exists: ${shimPath}`);
    return;
  }
  if (dryRun) {
    consoleOutput.log(`Would write command shim: ${shimPath}`);
    return;
  }
  await ensureDirectory(binDir, false);
  await writeFile(shimPath, content, {encoding: 'utf8', mode: 0o755});
  await chmod(shimPath, 0o755);
  consoleOutput.log(`Wrote command shim: ${shimPath}`);
}

async function removeCommandShim(dryRun: boolean): Promise<void> {
  if (!shouldManageCommandShim()) {
    consoleOutput.log('Preserving the package-manager threadnote.cmd launcher on Windows.');
    return;
  }
  const shimPath = join(expandPath(process.env.THREADNOTE_BIN_DIR ?? '~/.local/bin'), 'threadnote');
  const content = await readFileIfExists(shimPath);
  if (content === undefined) {
    consoleOutput.log(`Already absent: ${shimPath}`);
    return;
  }
  if (!isManagedCommandShim(content)) {
    consoleOutput.log(`WARN not removing unmanaged command shim: ${shimPath}`);
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
      consoleOutput.log(`WARN ${targetPath} is not managed by threadnote; not modifying it`);
      continue;
    }
    const nextContent = target.kind === 'file' ? instructions : upsertManagedBlock(currentContent ?? '', instructions);
    if (nextContent === undefined) {
      consoleOutput.log(`WARN ${targetPath} has partial threadnote markers; not modifying it`);
      continue;
    }
    if (currentContent === nextContent) {
      consoleOutput.log(`Already exists: ${targetPath}`);
      continue;
    }
    if (dryRun) {
      consoleOutput.log(currentContent === undefined ? `Would write ${targetPath}` : `Would update ${targetPath}`);
      continue;
    }
    await ensureDirectory(dirname(targetPath), false);
    await writeFile(targetPath, nextContent, {encoding: 'utf8', mode: 0o644});
    consoleOutput.log(currentContent === undefined ? `Wrote ${targetPath}` : `Updated ${targetPath}`);
  }
}

async function removeUserAgentInstructions(dryRun: boolean): Promise<void> {
  for (const target of USER_AGENT_INSTRUCTION_TARGETS) {
    const targetPath = expandPath(target.path);
    const currentContent = await readFileIfExists(targetPath);
    if (currentContent === undefined) {
      consoleOutput.log(`Already absent: ${targetPath}`);
      continue;
    }
    if (target.kind === 'file') {
      if (extractManagedBlock(currentContent) === undefined) {
        consoleOutput.log(`WARN ${targetPath} is not managed by threadnote; not removing it`);
        continue;
      }
      await removePath(targetPath, target.label, dryRun);
      continue;
    }
    const nextContent = removeManagedBlock(currentContent);
    if (nextContent === undefined) {
      consoleOutput.log(`WARN ${targetPath} has partial threadnote markers; not modifying it`);
      continue;
    }
    if (nextContent === currentContent) {
      consoleOutput.log(`No threadnote block found: ${targetPath}`);
      continue;
    }
    if (nextContent.trim().length === 0) {
      await removePath(targetPath, target.label, dryRun);
      continue;
    }
    if (dryRun) {
      consoleOutput.log(`Would update ${targetPath}`);
      continue;
    }
    await writeFile(targetPath, nextContent, {encoding: 'utf8', mode: 0o644});
    consoleOutput.log(`Updated ${targetPath}`);
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
    'THREADNOTE_ENTRY="$THREADNOTE_ROOT/dist/threadnote.js"',
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

const installLaunchAgent = Effect.fn('installLaunchAgent')(function* (config: RuntimeConfig, dryRun: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  if (system.platform !== 'darwin') {
    return yield* Effect.fail(new Error('launchd autostart is only supported on macOS.'));
  }
  // launchd uses a minimal default PATH (/usr/bin:/bin:/usr/sbin:/sbin) and
  // does not source the user's shell rc, so the plist must reference the
  // absolute path to openviking-server — otherwise a LaunchAgent on a fresh
  // macOS box would exit 127.
  const installDeadline = (yield* Clock.currentTimeMillis) + START_HEALTH_TIMEOUT_MS;
  const resolvedServer = yield* findOpenVikingServerEffect(
    yield* remainingBudget(installDeadline, START_HEALTH_TIMEOUT_MS),
  );
  if (!resolvedServer && !dryRun) {
    return yield* Effect.fail(
      new Error(
        `Cannot install LaunchAgent: ${OPENVIKING_SERVER_COMMAND} was not found in PATH, ` +
          'uv tool bin dir, $UV_TOOL_BIN_DIR, or ~/.local/bin. Run `threadnote install` first.',
      ),
    );
  }
  const source = join(toolRoot(), 'config', 'launchd', `${LAUNCHD_LABEL}.plist.template`);
  const destination = launchAgentPath();
  const rendered = renderTemplate(yield* fs.readFileString(source), config, {
    OPENVIKING_SERVER_PATH: resolvedServer ?? OPENVIKING_SERVER_COMMAND,
  });
  if (dryRun) {
    const resolutionDetail = resolvedServer ?? `<not found; would use bare \`${OPENVIKING_SERVER_COMMAND}\`>`;
    yield* Console.log(`Resolved openviking-server: ${resolutionDetail}`);
    yield* Console.log(`Would write ${destination}`);
    yield* bootoutLaunchAgent(true);
    yield* stopDetachedOpenVikingServerForLaunchd(config, true);
    yield* bootstrapLaunchAgent(destination, true);
    return;
  }
  yield* fs.makeDirectory(dirname(destination), {recursive: true});
  yield* fs.makeDirectory(dirname(openVikingLogPath(config)), {recursive: true});
  const healthUrl = openVikingHealthUrl(config);
  const activationTimeoutMs = yield* remainingBudget(installDeadline, START_HEALTH_TIMEOUT_MS);
  const health = yield* activateLaunchAgent<
    CommandExecutor | FileSystem.FileSystem | HttpService | Path.Path | SystemInfo
  >(config, destination, rendered, activationTimeoutMs, {
    bootout: timeoutMs => bootoutLaunchAgent(false, undefined, timeoutMs),
    bootstrap: (plistPath, timeoutMs) => bootstrapLaunchAgent(plistPath, false, undefined, timeoutMs),
    isPortOpen: (current, timeoutMs) => isTcpPortOpenEffect(current.host, current.port, Math.min(500, timeoutMs)),
    stagePlist: (plistPath, content) => stageLaunchAgentPlist(plistPath, content),
    stopDetached: (current, timeoutMs) =>
      stopDetachedOpenVikingServerForLaunchd(current, false, timeoutMs, resolvedServer),
    restartDetached: (current, timeoutMs) => restartDetachedOpenVikingServer(current, resolvedServer!, timeoutMs),
    waitForHealth: (current, timeoutMs) =>
      waitForLaunchAgentHealth(current, timeoutMs, `Waiting for OpenViking health at ${healthUrl}.`),
    waitForShutdown: waitForOpenVikingShutdown,
  });
  if (health) {
    yield* Console.log(`Installed and started ${LAUNCHD_LABEL}. Health OK at ${healthUrl}`);
    return;
  }
  return yield* Effect.fail(
    new Error(
      `Installed and started ${LAUNCHD_LABEL}, but ${healthUrl} did not become healthy within ` +
        `${START_HEALTH_TIMEOUT_MS / 1000}s. Logs: ${openVikingLogPath(config)}`,
    ),
  );
});

export function activateLaunchAgent<R>(
  config: RuntimeConfig,
  plistPath: string,
  plistContent: string,
  timeoutMs: number,
  effects: LaunchAgentActivationEffects<R>,
): Effect.Effect<string | undefined, unknown, R> {
  const timedOut = new Error(`LaunchAgent activation timed out after ${timeoutMs / 1000}s.`);
  const recoveryTimeoutMs = Math.min(2000, timeoutMs);
  let transaction: LaunchAgentPlistTransaction<R> | undefined;
  let launchAgentWasLoaded = false;
  let detachedServerWasStopped = false;
  let replacementCommitted = false;
  let serviceHealthy = false;
  const operation = Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    const remaining = () => remainingBudget(deadline, timeoutMs);
    transaction = yield* effects.stagePlist(plistPath, plistContent);
    yield* Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        launchAgentWasLoaded = yield* restore(effects.bootout(yield* remaining()));
      }),
    );
    yield* Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        detachedServerWasStopped = yield* restore(effects.stopDetached(config, yield* remaining()));
      }),
    );
    if (!(yield* effects.waitForShutdown(config, yield* remaining()))) {
      return yield* Effect.fail(
        new Error(
          `OpenViking at ${openVikingHealthUrl(config)} is still running outside Threadnote's managed process. ` +
            'Stop that process before enabling launchd autostart.',
        ),
      );
    }
    if (yield* effects.isPortOpen(config, yield* remaining())) {
      return yield* Effect.fail(
        new Error(
          `Port ${config.host}:${config.port} is still in use after stopping the managed OpenViking server. ` +
            'Stop the process using that port before enabling launchd autostart.',
        ),
      );
    }
    yield* transaction.commit;
    replacementCommitted = true;
    yield* effects.bootstrap(plistPath, yield* remaining());
    const health = yield* effects.waitForHealth(config, yield* remaining());
    if (health === undefined) {
      return yield* Effect.fail(timedOut);
    }
    serviceHealthy = true;
    yield* transaction.release;
    return health;
  });
  const boundedOperation = operation.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(timedOut),
    }),
  );
  return boundedOperation.pipe(
    Effect.onExit(exit => {
      if (Exit.isSuccess(exit) || !transaction) {
        return Effect.void;
      }
      const activeTransaction = transaction;
      if (serviceHealthy) {
        return boundedRecovery(activeTransaction.release, recoveryTimeoutMs, exit);
      }
      const recovery = Effect.gen(function* () {
        if (replacementCommitted) {
          yield* effects.bootout(recoveryTimeoutMs);
        }
        yield* activeTransaction.rollback;
        if (launchAgentWasLoaded) {
          yield* effects.bootstrap(plistPath, recoveryTimeoutMs);
        } else if (detachedServerWasStopped) {
          yield* effects.restartDetached(config, recoveryTimeoutMs);
        }
      }).pipe(Effect.ensuring(activeTransaction.release.pipe(Effect.orDie)));
      return boundedRecovery(recovery, recoveryTimeoutMs, exit);
    }),
  );
}

function boundedRecovery<R>(
  recovery: Effect.Effect<void, unknown, R>,
  timeoutMs: number,
  activationExit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void, Error, R> {
  const activationFailure = Exit.isFailure(activationExit) ? Cause.pretty(activationExit.cause) : 'unknown failure';
  return recovery.pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new Error(`LaunchAgent recovery timed out after ${timeoutMs / 1000}s.`)),
    }),
    Effect.mapError(
      recoveryError =>
        new Error(
          `LaunchAgent activation failed: ${activationFailure}\nRecovery also failed: ${errorMessage(recoveryError)}`,
        ),
    ),
  );
}

export const stageLaunchAgentPlist = Effect.fn('stageLaunchAgentPlist')(function* (plistPath: string, content: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* stageLaunchAgentPlistWithFileSystem(fs, plistPath, content);
});

function stageLaunchAgentPlistWithFileSystem(
  fs: FileSystem.FileSystem,
  plistPath: string,
  content: string,
): Effect.Effect<LaunchAgentPlistTransaction, unknown> {
  return Effect.gen(function* () {
    const stagePath = `${plistPath}.threadnote-stage-${process.pid}`;
    const rollbackPath = `${plistPath}.threadnote-rollback-${process.pid}`;
    const lockPath = `${plistPath}.threadnote-lock`;
    yield* fs.makeDirectory(lockPath);
    const prepare = Effect.gen(function* () {
      const previous = yield* readOptionalFileEffect(fs, plistPath);
      let committed = false;
      yield* fs.writeFileString(stagePath, content, {mode: 0o600});
      return {
        hadPrevious: previous !== undefined,
        commit: Effect.gen(function* () {
          const current = yield* readOptionalFileEffect(fs, plistPath);
          if (current !== previous) {
            return yield* Effect.fail(new Error(`LaunchAgent plist changed while activation was staged: ${plistPath}`));
          }
          yield* fs.rename(stagePath, plistPath);
          committed = true;
        }),
        release: fs.remove(lockPath, {force: true, recursive: true}),
        rollback: Effect.gen(function* () {
          yield* fs.remove(stagePath, {force: true});
          const current = yield* readOptionalFileEffect(fs, plistPath);
          const expected = committed ? content : previous;
          if (current !== expected) {
            return yield* Effect.fail(
              new Error(`LaunchAgent plist changed before activation could roll back: ${plistPath}`),
            );
          }
          if (!committed) {
            return;
          }
          if (previous === undefined) {
            yield* fs.remove(plistPath, {force: true});
            return;
          }
          yield* fs.writeFileString(rollbackPath, previous, {mode: 0o600});
          yield* fs.rename(rollbackPath, plistPath);
        }),
      } satisfies LaunchAgentPlistTransaction;
    });
    return yield* prepare.pipe(
      Effect.onError(() => fs.remove(lockPath, {force: true, recursive: true}).pipe(Effect.orDie)),
    );
  });
}

const readOptionalFileEffect = Effect.fn('readOptionalFile')(function* (fs: FileSystem.FileSystem, path: string) {
  return yield* fs.readFileString(path).pipe(
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.succeed(undefined),
    ),
  );
});

const waitForOpenVikingShutdown = Effect.fn('waitForOpenVikingShutdown')(function* (
  config: RuntimeConfig,
  timeoutMs: number,
) {
  const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
  while ((yield* Clock.currentTimeMillis) <= deadline) {
    const remainingMs = deadline - (yield* Clock.currentTimeMillis);
    if (!(yield* readOpenVikingHealthEffect(config, Math.max(1, Math.min(500, remainingMs))))) {
      return true;
    }
    if (remainingMs <= 0) {
      break;
    }
    yield* Effect.sleep(Math.min(START_HEALTH_POLL_INTERVAL_MS, remainingMs));
  }
  return false;
});

export function waitForLaunchAgentHealth(
  config: RuntimeConfig,
  timeoutMs: number,
  progressMessage: string,
): Effect.Effect<string | undefined, unknown, CommandExecutor | HttpService> {
  return waitForLaunchAgentHealthWithEffects(config, timeoutMs, progressMessage, liveLaunchAgentHealthEffects());
}

export function waitForLaunchAgentHealthWithEffects<R>(
  config: RuntimeConfig,
  timeoutMs: number,
  progressMessage: string,
  effects: LaunchAgentHealthEffects<R>,
): Effect.Effect<string | undefined, unknown, R> {
  return Effect.gen(function* () {
    yield* Console.log(progressMessage);
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while ((yield* Clock.currentTimeMillis) <= deadline) {
      const statusTimeoutMs = Math.max(1, Math.min(1000, deadline - (yield* Clock.currentTimeMillis)));
      const status = yield* effects.readStatus(statusTimeoutMs);
      if (status.running && status.pid !== undefined) {
        const preOwnershipTimeoutMs = Math.max(1, Math.min(1000, deadline - (yield* Clock.currentTimeMillis)));
        if (yield* effects.ownsPort(status.pid, config, preOwnershipTimeoutMs)) {
          const requestTimeoutMs = Math.max(1, Math.min(1000, deadline - (yield* Clock.currentTimeMillis)));
          const health = yield* effects.readHealth(config, requestTimeoutMs);
          if (health !== undefined) {
            const postOwnershipTimeoutMs = Math.max(1, Math.min(1000, deadline - (yield* Clock.currentTimeMillis)));
            const ownsPort = yield* effects.ownsPort(status.pid, config, postOwnershipTimeoutMs);
            const confirmationTimeoutMs = Math.max(1, Math.min(1000, deadline - (yield* Clock.currentTimeMillis)));
            const confirmedStatus = yield* effects.readStatus(confirmationTimeoutMs);
            if (ownsPort && launchAgentHealthIsStable(status, health, confirmedStatus)) {
              return health;
            }
          }
        }
      }
      const remainingMs = deadline - (yield* Clock.currentTimeMillis);
      if (remainingMs <= 0) {
        break;
      }
      yield* Effect.sleep(Math.min(START_HEALTH_POLL_INTERVAL_MS, remainingMs));
    }
    return undefined;
  });
}

const launchdProcessOwnsPort = Effect.fn('launchdProcessOwnsPort')(function* (
  pid: number,
  config: RuntimeConfig,
  timeoutMs: number,
) {
  const result = yield* runCommandEffect(
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(pid), `-iTCP@${config.host}:${config.port}`, '-sTCP:LISTEN', '-Fp'],
    {allowFailure: true, timeoutMs},
  );
  return result.exitCode === 0 && result.stdout.split('\n').includes(`p${pid}`);
});

const readOpenVikingHealthEffect = Effect.fn('readOpenVikingHealth')(function* (
  config: RuntimeConfig,
  timeoutMs: number,
) {
  return yield* getTextEffect(openVikingHealthUrl(config), {timeoutMs}).pipe(
    Effect.map(response => response.body),
    Effect.catch(() => Effect.succeed(undefined)),
  );
});

function liveLaunchAgentHealthEffects(): LaunchAgentHealthEffects<CommandExecutor | HttpService> {
  return {
    ownsPort: (pid, config, timeoutMs) => launchdProcessOwnsPort(pid, config, timeoutMs),
    readHealth: readOpenVikingHealthEffect,
    readStatus: timeoutMs => readLaunchAgentStatus(undefined, timeoutMs),
  };
}

const isTcpPortOpenEffect = Effect.fn('isTcpPortOpen')(function* (host: string, port: number, timeoutMs: number) {
  return yield* fromPromise(`check TCP port ${host}:${port}`, () => isTcpPortOpen(host, port, timeoutMs));
});

const remainingBudget = Effect.fn('remainingLaunchAgentBudget')(function* (deadline: number, timeoutMs: number) {
  const remaining = deadline - (yield* Clock.currentTimeMillis);
  if (remaining <= 0) {
    return yield* Effect.fail(new Error(`LaunchAgent activation timed out after ${timeoutMs / 1000}s.`));
  }
  return remaining;
});

export function launchAgentHealthIsStable(
  initial: LaunchAgentStatus,
  health: string | undefined,
  confirmed: LaunchAgentStatus,
): health is string {
  return (
    health !== undefined &&
    initial.running &&
    confirmed.running &&
    initial.pid !== undefined &&
    initial.pid === confirmed.pid
  );
}

const removeLaunchAgent = Effect.fn('removeLaunchAgent')(function* (dryRun: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const agentPath = launchAgentPath();
  const content = yield* fs.readFileString(agentPath).pipe(
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.succeed(undefined),
    ),
  );
  if (content === undefined) {
    yield* Console.log(`Already absent: ${agentPath}`);
    return;
  }
  if (!content.includes(LAUNCHD_LABEL) || !content.includes(OPENVIKING_SERVER_COMMAND)) {
    yield* Console.log(`WARN not removing unmanaged LaunchAgent: ${agentPath}`);
    return;
  }
  if (dryRun) {
    yield* Console.log(`Would remove LaunchAgent: ${agentPath}`);
    return;
  }
  yield* fs.remove(agentPath);
  yield* Console.log(`Removed LaunchAgent: ${agentPath}`);
});

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
