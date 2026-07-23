import {Cause, Clock, Console, Effect, Encoding, Exit, FileSystem, Option, Path, Result, Sink, Terminal} from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import {ChildProcessSpawner} from 'effect/unstable/process/ChildProcessSpawner';
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
  renderJsonTemplate,
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
  safeTimestamp,
  shellQuote,
  suggestedShellRc,
  toolRoot,
} from './utils.js';

const INSTALL_OUTPUT_TAIL_CHARS = 64_000;
const MINIMUM_UV_SYSTEM_CERTS_VERSION = '0.11.0';
const STOP_SERVER_TIMEOUT_MS = 10_000;
const WINDOWS_DETACHED_SERVER_HOST_SCRIPT = [
  "$ErrorActionPreference = 'Continue'",
  "'Launching OpenViking.' | Out-File -LiteralPath $env:THREADNOTE_DETACHED_SERVER_LOG -Append -Encoding utf8",
  '$serverArgs = @(ConvertFrom-Json -InputObject $env:THREADNOTE_DETACHED_SERVER_ARGS)',
  '& $env:THREADNOTE_DETACHED_SERVER @serverArgs 2>&1 | Out-File -LiteralPath $env:THREADNOTE_DETACHED_SERVER_LOG -Append -Encoding utf8',
  'exit $LASTEXITCODE',
].join('; ');
const WINDOWS_DETACHED_SERVER_HOST_COMMAND = encodeWindowsPowerShellCommand(WINDOWS_DETACHED_SERVER_HOST_SCRIPT);
const WINDOWS_DETACHED_SERVER_START_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$hostArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', $env:THREADNOTE_DETACHED_SERVER_HOST_COMMAND)",
  '$process = Start-Process -FilePath $env:THREADNOTE_DETACHED_POWERSHELL -ArgumentList $hostArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $env:THREADNOTE_DETACHED_HOST_STDOUT -RedirectStandardError $env:THREADNOTE_DETACHED_HOST_STDERR',
  '$processId = $process.Id',
  '$process.Dispose()',
  '[Console]::Out.WriteLine($processId)',
  'exit 0',
].join('; ');
const parseJson = Option.liftThrowable((content: string): unknown => JSON.parse(content));

export function encodeWindowsPowerShellCommand(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let index = 0; index < script.length; index += 1) {
    const codeUnit = script.charCodeAt(index);
    bytes[index * 2] = codeUnit & 0xff;
    bytes[index * 2 + 1] = codeUnit >>> 8;
  }
  return Encoding.encodeBase64(bytes);
}

interface DetachedProcessRecord {
  readonly args?: readonly string[];
  readonly commandLine?: string;
  readonly executablePath?: string;
  readonly launcherPid?: number;
  readonly pid: number;
  readonly server?: string;
  readonly startedAt?: string;
}

export function pythonExecutableCandidates(currentPlatform: NodeJS.Platform): readonly string[] {
  return currentPlatform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
}

export function shouldManageCommandShim(currentPlatform: NodeJS.Platform): boolean {
  return currentPlatform !== 'win32';
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

const pathJoin = Effect.fn('lifecycle.pathJoin')(function* (...parts: readonly string[]) {
  const path = yield* Path.Path;
  return path.join(...parts);
});

const pathBasename = Effect.fn('lifecycle.pathBasename')(function* (target: string) {
  const path = yield* Path.Path;
  return path.basename(target);
});

const pathDirname = Effect.fn('lifecycle.pathDirname')(function* (target: string) {
  const path = yield* Path.Path;
  return path.dirname(target);
});

const pathSeparator = Effect.map(Path.Path, path => path.sep);

const chmod = Effect.fn('lifecycle.chmod')(function* (target: string, mode: number) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.chmod(target, mode);
});

const readdir = Effect.fn('lifecycle.readdir')(function* (target: string, options?: {readonly recursive?: boolean}) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readDirectory(target, options);
});

const readFile = Effect.fn('lifecycle.readFile')(function* (target: string, encoding: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(target, encoding);
});

const realpath = Effect.fn('lifecycle.realpath')(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(target);
});

const writeFile = Effect.fn('lifecycle.writeFile')(function* (
  target: string,
  content: string,
  options?: {readonly encoding?: string; readonly mode?: number},
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(target, content, {mode: options?.mode});
});

export const runDoctor = Effect.fn('runDoctor')(function* (config: RuntimeConfig, options: DoctorOptions) {
  const system = yield* SystemInfo;
  const checks = yield* collectDoctorChecks(config, options, system.platform);
  for (const check of checks) {
    yield* Console.log(`${formatStatus(check.status)} ${check.name}: ${check.detail}`);
  }
  const failureCount = checks.filter(check => check.status === 'fail').length;
  const warningCount = checks.filter(check => check.status === 'warn').length;
  yield* Console.log(`\nSummary: ${failureCount} failure(s), ${warningCount} warning(s)`);
  if (options.strict === true && failureCount > 0) {
    yield* Effect.sync(() => system.setExitCode(1));
  }
});

export const collectDoctorChecks = Effect.fn('lifecycle.collectDoctorChecks')(function* (
  config: RuntimeConfig,
  options: DoctorOptions = {},
  currentPlatform?: NodeJS.Platform,
) {
  const system = yield* SystemInfo;
  const platform = currentPlatform ?? system.platform;
  const checks: DoctorCheck[] = [];
  checks.push({name: 'mode', status: 'ok', detail: options.dryRun ? 'dry run; no writes' : 'read-only checks'});
  checks.push({
    name: 'platform',
    status: ['darwin', 'linux', 'win32'].includes(platform) ? 'ok' : 'warn',
    detail: platform,
  });
  checks.push((yield* commandCheck('node', ['--version'])) as DoctorCheck);
  checks.push((yield* firstCommandCheck('python', pythonExecutableCandidates(platform), ['--version'])) as DoctorCheck);
  checks.push((yield* openVikingServerCheck()) as DoctorCheck);
  checks.push((yield* openVikingCliCheck()) as DoctorCheck);
  checks.push((yield* openVikingVersionCheck(config)) as DoctorCheck);
  checks.push((yield* recallShapeCheck(config)) as DoctorCheck);
  checks.push((yield* localEmbeddingCheck()) as DoctorCheck);
  checks.push((yield* pythonSystemCertificatesCheck()) as DoctorCheck);
  checks.push((yield* pythonInstallerCheck()) as DoctorCheck);
  checks.push((yield* commandPresenceCheck('codex', ['--version'])) as DoctorCheck);
  checks.push((yield* commandPresenceCheck('claude', ['--version'])) as DoctorCheck);
  checks.push((yield* commandShimCheck()) as DoctorCheck);
  checks.push(...((yield* userAgentInstructionsChecks()) as DoctorCheck[]));
  checks.push((yield* manifestCheck(config.manifestPath)) as DoctorCheck);
  checks.push((yield* recallIndexFreshnessCheck(config)) as DoctorCheck);
  checks.push((yield* memoryProjectConsistencyCheck(config)) as DoctorCheck);
  const root = yield* toolRoot();
  checks.push((yield* fileCheck(yield* pathJoin(root, '.threadnoteignore'), 'ignore file')) as DoctorCheck);
  checks.push(
    (yield* fileCheck(
      yield* pathJoin(root, 'config', 'ov.conf.template.json'),
      'server config template',
    )) as DoctorCheck,
  );
  checks.push(
    (yield* fileCheck(
      yield* pathJoin(root, 'config', 'ovcli.conf.template.json'),
      'cli config template',
    )) as DoctorCheck,
  );
  checks.push((yield* healthCheck(config)) as DoctorCheck);
  return checks;
});

export const runInstall = Effect.fn('runInstall')(function* (config: RuntimeConfig, options: InstallOptions) {
  const repairInvalidConfigs = options.repairInvalidConfigs === true;
  const dryRun = options.dryRun === true;
  yield* ensureDirectory(config.agentContextHome, dryRun);
  yield* ensureDirectory(yield* pathJoin(config.agentContextHome, 'logs'), dryRun);
  yield* ensureDirectory(yield* pathJoin(config.agentContextHome, 'redacted'), dryRun);
  yield* ensureDirectory(yield* pathJoin(config.agentContextHome, 'mcp'), dryRun);
  yield* installCommandShim(dryRun);
  yield* installUserAgentInstructions(dryRun);

  const serverPath = yield* findOpenVikingServer();
  // True only when an install/repair could have moved or created the
  // openviking-server binary itself. The python-certs branch patches the
  // existing Python env in place, so it does not flip this — the server
  // path is unchanged and the earlier resolution is still valid.
  let serverInstallRan = false;
  if (serverPath) {
    yield* Console.log(`OpenViking server already installed: ${serverPath}`);
    const localEmbeddingMissing = (yield* hasLocalEmbeddingDependency(serverPath)) === false;
    const pythonSystemCertificatesMissing = (yield* hasPythonSystemCertificatesPatch(serverPath)) === false;
    if (options.force === true) {
      yield* Console.log(`Reinstalling OpenViking at pinned version ${config.openVikingVersion} (--force).`);
      yield* runInstallCommands(config, options.packageManager, true, dryRun);
      serverInstallRan = true;
    } else if (localEmbeddingMissing) {
      const repairReasons: string[] = [];
      repairReasons.push('local embedding extra is missing');
      if (pythonSystemCertificatesMissing) {
        repairReasons.push('Python system certificate bridge is missing');
      }
      yield* Console.log(`OpenViking install needs repair: ${repairReasons.join('; ')}.`);
      yield* runInstallCommands(config, options.packageManager, true, dryRun);
      serverInstallRan = true;
    } else if (pythonSystemCertificatesMissing) {
      yield* Console.log('OpenViking install needs repair: Python system certificate bridge is missing.');
      const installCommand = yield* getPythonSystemCertificatesInstallCommand(serverPath);
      yield* maybeRunEffect(dryRun, installCommand.executable, installCommand.args);
    }
  } else {
    yield* runInstallCommands(config, options.packageManager, false, dryRun);
    serverInstallRan = true;
  }
  const resolvedServerPath = serverInstallRan ? yield* findOpenVikingServer() : serverPath;
  if (serverInstallRan && !resolvedServerPath && !dryRun) {
    // The install command reported success but the binary is unresolvable.
    // Fail loudly for `install`; for `repair` (requireServerBinary === false)
    // warn and continue so config/manifest/MCP/hook repairs still run.
    const message =
      `OpenViking install ran but ${OPENVIKING_SERVER_COMMAND} was not found on PATH, in the uv tool bin dir, or ~/.local/bin. ` +
      'Re-run `threadnote install --force` (it streams the full build), then `threadnote doctor`.';
    if (options.requireServerBinary === false) {
      yield* Console.warn(`WARN ${message}`);
    } else {
      return yield* Effect.fail(new Error(message));
    }
  }
  if (resolvedServerPath && !dryRun) {
    yield* maybePrintOpenVikingPathHint(resolvedServerPath);
  }

  const root = yield* toolRoot();
  yield* writeTemplateIfMissing({
    config,
    destinationPath: yield* pathJoin(config.agentContextHome, 'ov.conf'),
    dryRun,
    shouldRepair: content =>
      shouldRepairOpenVikingConfig(content, config).pipe(
        Effect.map(
          shouldRepair => shouldRepair || (repairInvalidConfigs && parseJsonConfigObject(content) === undefined),
        ),
      ),
    templatePath: yield* pathJoin(root, 'config', 'ov.conf.template.json'),
  });
  yield* writeTemplateIfMissing({
    config,
    destinationPath: yield* pathJoin(config.agentContextHome, 'ovcli.conf'),
    dryRun,
    shouldRepair: content =>
      shouldRepairLegacyOvCliConfig(content) || (repairInvalidConfigs && parseJsonConfigObject(content) === undefined),
    templatePath: yield* pathJoin(root, 'config', 'ovcli.conf.template.json'),
  });
  yield* configureOpenVikingCliLanguage(config, dryRun);

  if (options.start !== false) {
    const healthy = yield* repairServerHealth(config, dryRun);
    if (!healthy && !dryRun) {
      const logPath = yield* openVikingLogPath(config);
      return yield* Effect.fail(new Error(`OpenViking did not become healthy. Check logs: ${logPath}`));
    }
  }

  if (options.printNextSteps !== false) {
    yield* printInstallNextSteps({dryRun, startsServer: options.start !== false});
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
    yield* Console.log('Repairing local OpenViking agent context from this checkout.');

    yield* runInstall(config, {
      dryRun,
      packageManager: options.packageManager,
      printNextSteps: false,
      repairInvalidConfigs: true,
      requireServerBinary: false,
      start: false,
    });
    yield* repairManifest(config, dryRun);

    if (options.start !== false) {
      yield* repairServerHealth(config, dryRun);
    } else {
      yield* Console.log('Skipping server health repair because --no-start was provided.');
    }
    yield* repairRecallIndex(config, dryRun);

    const mcpClients = yield* resolveMcpClients(options.mcp ?? 'available', 'repair');
    if (mcpClients.length === 0) {
      yield* Console.log('Skipping MCP config repair.');
    } else {
      for (const client of mcpClients) {
        yield* Console.log(`Repairing ${client} MCP config for ${OPENVIKING_MCP_NAME}.`);
        yield* runMcpInstall(config, client, {apply: !dryRun, name: OPENVIKING_MCP_NAME});
      }
    }

    // Re-install agent hooks only if the user opted in previously (a managed
    // entry already exists). Never adds them unsolicited — `install-hooks` or
    // `install --with-hooks` is the opt-in.
    if (yield* hasManagedClaudeHooks()) {
      yield* Console.log('\nRepairing claude hooks (re-asserting threadnote-managed entries).');
      yield* runHooksInstall(config, 'claude', {apply: !dryRun, dryRun});
    }

    yield* Console.log('\nPost-repair doctor:');
    yield* runDoctor(config, {dryRun, strict: false});
  });
}

export const runUninstall = Effect.fn('runUninstall')(function* (config: RuntimeConfig, options: UninstallOptions) {
  const dryRun = options.dryRun === true;
  if (options.eraseMemories === true && options.preserveMemories === true) {
    yield* Effect.fail(new Error('Use either --erase-memories or --preserve-memories, not both.'));
  }

  yield* Console.log('Uninstalling local Threadnote setup.');
  yield* runStop(config, {dryRun});
  yield* removePathIfExists(yield* pathJoin(config.agentContextHome, 'openviking-server.pid'), 'pid file', dryRun);
  yield* removeLaunchAgent(dryRun);
  yield* removeMcpConfigs(options.mcp ?? 'available', dryRun);
  yield* removeMcpSnippets(config, dryRun);
  if (yield* hasManagedClaudeHooks()) {
    yield* runHooksInstall(config, 'claude', {apply: !dryRun, dryRun, remove: true});
  }
  yield* removeCommandShim(dryRun);
  yield* removeUserAgentInstructions(dryRun);

  if (options.eraseMemories === true) {
    yield* eraseThreadnoteHome(config.agentContextHome, dryRun);
  } else {
    yield* Console.log(`Preserving local memories and OpenViking home: ${config.agentContextHome}`);
    yield* Console.log('Use --erase-memories to delete this directory during uninstall.');
  }

  yield* Console.log('Uninstall complete.');
  yield* Console.log('The package remains installed. Remove it with your package manager if desired.');
});

const repairManifest = Effect.fn('lifecycle.repairManifest')(function* (config: RuntimeConfig, dryRun: boolean) {
  const manifestResult = yield* Effect.result(readSeedManifest(config.manifestPath));
  if (Result.isSuccess(manifestResult)) {
    yield* Console.log(`Manifest OK: ${config.manifestPath}`);
    return;
  }
  if (config.manifestPath === (yield* builtInExampleManifestPath())) {
    yield* Console.warn(`WARN built-in manifest is not readable: ${errorMessage(manifestResult.failure)}`);
    return;
  }
  yield* Console.log(`Manifest needs repair: ${config.manifestPath} (${errorMessage(manifestResult.failure)})`);

  const repoRootResult = yield* Effect.result(
    Effect.gen(function* () {
      return yield* resolveRepoRoot(yield* getInvocationCwd());
    }),
  );
  if (Result.isFailure(repoRootResult)) {
    yield* Console.warn(
      `WARN cannot create replacement manifest from current directory: ${errorMessage(repoRootResult.failure)}`,
    );
    return;
  }
  const repoRoot = repoRootResult.success;

  const project = yield* projectManifestForRepo(repoRoot, []);
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
    yield* Console.log(`# Would write replacement manifest: ${config.manifestPath}`);
    yield* Console.log(output.trimEnd());
    return;
  }

  yield* ensureDirectory(yield* pathDirname(config.manifestPath), false);
  const currentContent = yield* readFileIfExists(config.manifestPath);
  if (currentContent !== undefined) {
    const backupPath = `${config.manifestPath}.legacy-${safeTimestamp()}`;
    yield* writeFile(backupPath, currentContent, {encoding: 'utf8', mode: 0o600});
    yield* chmod(backupPath, 0o600);
    yield* Console.log(`Backup: ${backupPath}`);
  }
  yield* writeFile(config.manifestPath, output, {encoding: 'utf8', mode: 0o600});
  yield* chmod(config.manifestPath, 0o600);
  yield* Console.log(`Wrote replacement manifest: ${config.manifestPath}`);
});

const repairRecallIndex = Effect.fn('lifecycle.repairRecallIndex')(function* (config: RuntimeConfig, dryRun: boolean) {
  yield* Console.log('\nRepairing recall index freshness.');
  const ov = dryRun ? ((yield* findOpenVikingCli()) ?? 'ov') : yield* findOpenVikingCli();
  if (!ov) {
    yield* Console.log('Skipping recall index repair: neither ov nor openviking was found.');
    return;
  }

  const progress = yield* startProgress('Scanning recall index freshness across memories and seeded resources.');
  yield* Effect.gen(function* () {
    const result = yield* repairStaleRecallIndex(config, ov, {
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
            return progress.update('No stale recall index scopes found.');
          } else {
            return progress.update(
              `Found ${event.totalTargets} stale recall index scope(s); repairing ${event.repairTargetCount}.`,
            );
          }
        } else if (event.type === 'repair-start') {
          return progress.update(
            `Reindexing ${event.index}/${event.total}: ${event.target.uri} (${event.target.staleCount} stale summaries).`,
          );
        } else if (event.type === 'repair-dry-run') {
          return progress.update(
            `Planning reindex ${event.index}/${event.total}: ${event.target.uri} (${event.target.staleCount} stale summaries).`,
          );
        } else if (event.type === 'repair-skip-recent') {
          return progress.update(
            `Skipping recently repaired scope ${event.index}/${event.total}: ${event.target.uri}.`,
          );
        }
        return Effect.void;
      },
    });
    yield* progress.stop();
    const messages = formatRecallIndexRepairMessages(result, {dryRun, maxUris: 20});
    if (messages.length === 0) {
      yield* Console.log('Recall index freshness OK.');
      return;
    }
    for (const message of messages) {
      yield* Console.log(message);
    }
  }).pipe(
    Effect.catch(error =>
      Effect.gen(function* () {
        yield* progress.stop();
        yield* Console.log(`WARN could not repair recall index freshness: ${errorMessage(error)}`);
      }),
    ),
  );
});

const configureOpenVikingCliLanguage = Effect.fn('lifecycle.configureOpenVikingCliLanguage')(function* (
  config: RuntimeConfig,
  dryRun: boolean,
) {
  const ov = dryRun ? ((yield* findOpenVikingCli()) ?? 'ov') : yield* findOpenVikingCli();
  if (!ov) {
    return;
  }
  const installedVersion = dryRun ? undefined : yield* readOpenVikingCliVersion(ov);
  const effectiveVersion = installedVersion ?? config.openVikingVersion;
  if (compareVersions(effectiveVersion, '0.3.23') < 0) {
    return;
  }
  yield* maybeRun(dryRun, ov, ['language', 'en'], {allowFailure: true});
});

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
export const findOpenVikingServer = Effect.fn('lifecycle.findOpenVikingServer')(function* () {
  const system = yield* SystemInfo;
  if (system.platform !== 'win32') {
    const onPath = yield* findExecutable([OPENVIKING_SERVER_COMMAND]);
    if (onPath) {
      return onPath;
    }
  } else {
    for (const directory of (system.environment().PATH ?? '').split(system.pathDelimiter).filter(Boolean)) {
      for (const name of openVikingServerExecutableNames(system.platform, system.environment().PATHEXT)) {
        const candidate = yield* pathJoin(directory, name);
        if (yield* isExecutable(candidate)) {
          return candidate;
        }
      }
    }
  }
  for (const candidateDir of yield* openVikingServerCandidateDirs()) {
    for (const name of openVikingServerExecutableNames(system.platform, system.environment().PATHEXT)) {
      const candidate = yield* pathJoin(candidateDir, name);
      if (yield* isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
});

const findOpenVikingServerEffectCore = Effect.fn('findOpenVikingServer')(function* (timeoutMs: number) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
  const environment = system.environment();
  const pathDirectories = (environment.PATH ?? '').split(system.pathDelimiter).filter(Boolean);
  for (const directory of pathDirectories) {
    for (const name of openVikingServerExecutableNames(system.platform)) {
      const candidate = yield* pathJoin(directory, name);
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
  if (environment.UV_TOOL_BIN_DIR) {
    candidateDirectories.push(environment.UV_TOOL_BIN_DIR);
  }
  candidateDirectories.push(...(yield* pythonUserScriptsCandidateDirsEffect()));
  candidateDirectories.push(yield* expandPath('~/.local/bin'));
  for (const directory of new Set(candidateDirectories)) {
    for (const name of openVikingServerExecutableNames(system.platform)) {
      const candidate = yield* pathJoin(directory, name);
      if (yield* isExecutableFileEffect(fs, candidate, system.platform)) {
        return candidate;
      }
    }
  }
  return undefined;
});

export function openVikingServerExecutableNames(
  currentPlatform: NodeJS.Platform,
  pathExt = '.COM;.EXE;.BAT;.CMD',
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
      const candidate = yield* pathJoin(directory, executableName);
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
  const directories = (system.environment().PATH ?? '').split(system.pathDelimiter).filter(Boolean);
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

let candidateDirsCache: readonly string[] | undefined;

const openVikingServerCandidateDirs = Effect.fn('lifecycle.openVikingServerCandidateDirs')(function* () {
  if (!candidateDirsCache) {
    candidateDirsCache = yield* computeOpenVikingServerCandidateDirs();
  }
  return candidateDirsCache;
});

const computeOpenVikingServerCandidateDirs = Effect.fn('lifecycle.computeOpenVikingServerCandidateDirs')(function* () {
  const system = yield* SystemInfo;
  const environment = system.environment();
  const dirs: string[] = [];
  const uv = yield* findExecutable(['uv']);
  if (uv) {
    const result = yield* runCommand(uv, ['tool', 'dir', '--bin'], {allowFailure: true});
    if (result.exitCode === 0) {
      const dir = result.stdout.trim();
      if (dir) {
        dirs.push(dir);
      }
    }
  }
  if (environment.UV_TOOL_BIN_DIR) {
    dirs.push(environment.UV_TOOL_BIN_DIR);
  }
  dirs.push(...(yield* pythonUserScriptsCandidateDirs()));
  dirs.push(yield* expandPath('~/.local/bin'));
  return Array.from(new Set(dirs));
});

const requireOpenVikingServer = Effect.fn('lifecycle.requireOpenVikingServer')(function* () {
  const resolved = yield* findOpenVikingServer();
  if (!resolved) {
    throw new Error(
      `${OPENVIKING_SERVER_COMMAND} was not found in PATH, uv tool bin dir, ` +
        '$UV_TOOL_BIN_DIR, or ~/.local/bin. Run `threadnote install` first.',
    );
  }
  return resolved;
});

const maybePrintOpenVikingPathHint = Effect.fn('lifecycle.maybePrintOpenVikingPathHint')(function* (
  serverPath: string,
) {
  const onPath = yield* findExecutable([OPENVIKING_SERVER_COMMAND]);
  if (onPath) {
    return;
  }
  const system = yield* SystemInfo;
  const binDir = yield* pathDirname(serverPath);
  if (system.platform === 'win32') {
    yield* Console.log(
      `Note: ${serverPath} is installed but ${binDir} is not on this PowerShell PATH. ` +
        `Run \`$env:Path = "${binDir};$env:Path"\` for this shell.`,
    );
    return;
  }
  const rcHint = suggestedShellRc(system.environment().SHELL, system.platform);
  yield* Console.log(
    `Note: ${serverPath} is installed but ${binDir} is not on this shell's PATH. ` +
      `Add \`export PATH="${binDir}:$PATH"\` to ${rcHint} so other tools can find openviking-server.`,
  );
});

function repairServerHealth(config: RuntimeConfig, dryRun: boolean) {
  return Effect.gen(function* () {
    const existingHealth = yield* readOpenVikingHealthIfAvailable(config, 800);
    if (existingHealth) {
      yield* Console.log(`OpenViking health OK at http://${config.host}:${config.port}/health`);
      return true;
    }

    yield* Console.log(
      `OpenViking health is not responding at http://${config.host}:${config.port}/health; starting server.`,
    );
    return yield* runStart(config, {dryRun}).pipe(
      Effect.as(true),
      Effect.catch(error =>
        Console.log(`WARN could not repair OpenViking health: ${errorMessage(error)}`).pipe(Effect.as(false)),
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
      ? ((yield* findOpenVikingServer()) ?? OPENVIKING_SERVER_COMMAND)
      : yield* requireOpenVikingServer();
  const args = yield* openVikingServerArgs(config);
  if (options.dryRun === true) {
    yield* Console.log(formatShellCommand(server, args));
    return;
  }

  const existingHealth = yield* readOpenVikingHealthIfAvailable(config, 500);
  const healthUrl = openVikingHealthUrl(config);
  if (existingHealth) {
    yield* Console.log(`OpenViking is already healthy at ${healthUrl}`);
    return;
  }
  if (yield* isTcpPortOpen(config.host, config.port, 500)) {
    return yield* Effect.fail(
      new Error(
        `Port ${config.host}:${config.port} is already in use, but it is not a healthy OpenViking server. ` +
          'Set THREADNOTE_PORT or pass --port to use a different port.',
      ),
    );
  }

  const logPath = yield* openVikingLogPath(config);
  yield* fs.makeDirectory(yield* pathDirname(logPath), {recursive: true});
  if (options.foreground === true) {
    const result = yield* runStreamingCommandEffect(server, args, {maxOutputChars: INSTALL_OUTPUT_TAIL_CHARS});
    yield* Effect.sync(() => system.setExitCode(result.exitCode));
    return;
  }

  const childPid = yield* Effect.scoped(spawnDetachedServer(server, args, logPath));
  yield* fs.writeFileString(
    yield* pathJoin(config.agentContextHome, 'openviking-server.pid'),
    detachedProcessRecordContent(childPid, server, args, system.platform),
  );
  const health = yield* waitForOpenVikingHealth(
    config,
    START_HEALTH_TIMEOUT_MS,
    `Waiting for OpenViking health at ${healthUrl}.`,
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
        yield* fs.remove(yield* pathJoin(config.agentContextHome, 'openviking-server.pid'), {force: true});
        return yield* Effect.fail(
          new Error('OpenViking became healthy, but Threadnote could not verify its Windows serving process.'),
        );
      }
      managedPid = servingProcess.pid;
      yield* fs.writeFileString(
        yield* pathJoin(config.agentContextHome, 'openviking-server.pid'),
        windowsDetachedProcessRecordContent(childPid, server, args, servingProcess),
      );
    }
    yield* Console.log(`Started OpenViking with pid ${managedPid}. Health OK at ${healthUrl}. Logs: ${logPath}`);
    return;
  }
  if (system.platform === 'win32') {
    const termination = yield* terminateWindowsProcessTree(childPid);
    if (!termination.stopped) {
      return yield* Effect.fail(windowsTerminationError(childPid, termination.result));
    }
    yield* fs.remove(yield* pathJoin(config.agentContextHome, 'openviking-server.pid'), {force: true});
  }
  return yield* Effect.fail(
    new Error(
      `Started OpenViking with pid ${childPid}, but ${healthUrl} did not become healthy within ` +
        `${START_HEALTH_TIMEOUT_MS / 1000}s. Logs: ${logPath}`,
    ),
  );
});

const spawnDetachedServer = Effect.fn('lifecycle.spawnDetachedServer')(function* (
  server: string,
  args: readonly string[],
  logPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  if (system.platform === 'win32') {
    const powershell = yield* findExecutable(['powershell']);
    if (!powershell) {
      return yield* Effect.fail(new Error('PowerShell is required to start OpenViking in the background on Windows.'));
    }
    const launched = yield* runCommandEffect(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        WINDOWS_DETACHED_SERVER_START_SCRIPT,
      ],
      {
        env: {
          ...system.environment(),
          THREADNOTE_DETACHED_HOST_STDERR: `${logPath}.host.stderr`,
          THREADNOTE_DETACHED_HOST_STDOUT: `${logPath}.host.stdout`,
          THREADNOTE_DETACHED_POWERSHELL: powershell,
          THREADNOTE_DETACHED_SERVER: server,
          THREADNOTE_DETACHED_SERVER_ARGS: JSON.stringify(args),
          THREADNOTE_DETACHED_SERVER_HOST_COMMAND: WINDOWS_DETACHED_SERVER_HOST_COMMAND,
          THREADNOTE_DETACHED_SERVER_LOG: logPath,
        },
        timeoutMs: STOP_SERVER_TIMEOUT_MS,
      },
    );
    const childPid = Number(launched.stdout.trim().split(/\s+/).at(-1));
    if (!Number.isInteger(childPid) || childPid <= 0) {
      return yield* Effect.fail(new Error('PowerShell did not report the detached OpenViking server pid.'));
    }
    return childPid;
  }
  const logSink = fs.sink(logPath, {flag: 'a'}).pipe(Sink.as(new Uint8Array()));
  const child = yield* ChildProcess.make(server, [...args], {
    detached: true,
    stderr: logSink,
    stdin: 'ignore',
    stdout: logSink,
  });
  yield* child.unref;
  return Number(child.pid);
});

const restartDetachedOpenVikingServer = Effect.fn('restartDetachedOpenVikingServer')(function* (
  config: RuntimeConfig,
  server: string,
  timeoutMs: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const logPath = yield* openVikingLogPath(config);
  yield* fs.makeDirectory(yield* pathDirname(logPath), {recursive: true});
  const args = yield* openVikingServerArgs(config);
  const childPid = yield* Effect.scoped(spawnDetachedServer(server, args, logPath));
  yield* fs.writeFileString(
    yield* pathJoin(config.agentContextHome, 'openviking-server.pid'),
    detachedProcessRecordContent(childPid, server, args, system.platform),
  );
  const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
  while ((yield* Clock.currentTimeMillis) < deadline) {
    const remainingMs = deadline - (yield* Clock.currentTimeMillis);
    if (yield* readOpenVikingHealthEffect(config, Math.max(1, Math.min(500, remainingMs)))) {
      if (system.platform === 'win32') {
        const servingProcess = yield* findWindowsServingProcess(childPid, config, server, args);
        if (!servingProcess) {
          const termination = yield* terminateWindowsProcessTree(childPid);
          if (!termination.stopped) {
            return yield* Effect.fail(windowsTerminationError(childPid, termination.result));
          }
          yield* fs.remove(yield* pathJoin(config.agentContextHome, 'openviking-server.pid'), {force: true});
          return yield* Effect.fail(
            new Error('Restored OpenViking became healthy, but its Windows serving process could not be verified.'),
          );
        }
        yield* fs.writeFileString(
          yield* pathJoin(config.agentContextHome, 'openviking-server.pid'),
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
    yield* fs.remove(yield* pathJoin(config.agentContextHome, 'openviking-server.pid'), {force: true});
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

  const pidPath = yield* pathJoin(config.agentContextHome, 'openviking-server.pid');
  const pidText = yield* fs.readFileString(pidPath).pipe(
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.succeed(undefined),
    ),
  );
  if (!pidText) {
    yield* Console.log('No pid file found for detached OpenViking server.');
    return;
  }
  const processRecord = parseDetachedProcessRecord(pidText);
  const pid = processRecord?.pid ?? Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0) {
    yield* Console.log(`Invalid pid file: ${pidPath}`);
    if (options.dryRun !== true) {
      yield* fs.remove(pidPath, {force: true});
    }
    return;
  }
  if (options.dryRun === true) {
    yield* Console.log(`Would stop process ${pid}`);
    return;
  }
  if (!(yield* isProcessRunningEffect(pid))) {
    yield* fs.remove(pidPath, {force: true});
    yield* Console.log(`Removed stale pid file for process ${pid}.`);
    return;
  }
  let windowsTerminationPid = pid;
  if (system.platform === 'win32') {
    const launcherPid = processRecord?.launcherPid;
    if (launcherPid !== undefined && (!Number.isInteger(launcherPid) || launcherPid <= 0)) {
      return yield* Effect.fail(new Error(`Refusing to stop process ${pid}: its launcher pid record is invalid.`));
    }
    const runningLauncherPid =
      launcherPid !== undefined && (yield* isProcessRunningEffect(launcherPid)) ? launcherPid : undefined;
    windowsTerminationPid = runningLauncherPid ?? pid;
    const server = processRecord?.server ?? (yield* findOpenVikingServer());
    if (!server) {
      return yield* Effect.fail(
        new Error(`Refusing to stop process ${pid}: OpenViking server path is unavailable for verification.`),
      );
    }
    const expected = {
      args: processRecord?.args ?? (yield* openVikingServerArgs(config)),
      commandLine: processRecord?.commandLine,
      executablePath: processRecord?.executablePath,
      launcherPid: runningLauncherPid,
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
    const termination = yield* terminateWindowsProcessTree(windowsTerminationPid);
    if (!termination.stopped) {
      return yield* Effect.fail(windowsTerminationError(windowsTerminationPid, termination.result));
    }
    signaled = true;
  } else {
    signaled = yield* signalProcessEffect(pid, 'SIGTERM');
  }
  if (!signaled) {
    yield* fs.remove(pidPath, {force: true});
    yield* Console.log(`Process ${pid} was already stopped.`);
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
  yield* Console.log(`Stopped process ${pid}`);
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
  const value = Option.getOrUndefined(parseJson(trimmed));
  if (value !== undefined) {
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
  }
  const pid = Number(trimmed);
  return Number.isInteger(pid) ? {pid} : undefined;
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
  if (!identity || !(yield* matchesExpectedWindowsProcess(identity, server, args))) {
    return undefined;
  }
  return identity;
});

function parseWindowsProcessIdentity(output: string): WindowsProcessIdentity | undefined {
  const value = Option.getOrUndefined(parseJson(output));
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
}

const matchesExpectedWindowsProcess = Effect.fn('lifecycle.matchesExpectedWindowsProcess')(function* (
  identity: Pick<WindowsProcessIdentity, 'commandLine' | 'executablePath'>,
  server: string,
  args: readonly string[],
) {
  const commandLine = identity.commandLine.toLowerCase();
  const expectedServer = (yield* pathBasename(server)).toLowerCase();
  if (
    !commandLine.includes(expectedServer) &&
    (yield* pathBasename(identity.executablePath)).toLowerCase() !== expectedServer
  ) {
    return false;
  }
  return args.every(arg => commandLine.includes(arg.toLowerCase()));
});

const terminateWindowsProcessTree = Effect.fn('terminateWindowsProcessTree')(function* (pid: number) {
  const result = yield* runCommandEffect(yield* windowsTaskkillExecutable(), ['/pid', String(pid), '/t', '/f'], {
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
  const launcherPid = expected.launcherPid;
  if (launcherPid !== undefined && (!Number.isInteger(launcherPid) || launcherPid <= 0)) {
    return false;
  }
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    'if ($null -eq $process) { exit 3 }',
    '$descendsFromLauncher = $true',
    ...(launcherPid === undefined
      ? []
      : [
          '$processes = @(Get-CimInstance Win32_Process)',
          '$cursor = $process',
          '$descendsFromLauncher = $false',
          'while ($null -ne $cursor -and [uint32]$cursor.ProcessId -gt 0) {',
          `if ([uint32]$cursor.ProcessId -eq ${launcherPid}) { $descendsFromLauncher = $true; break }`,
          '$parentId = [uint32]$cursor.ParentProcessId',
          '$cursor = $processes | Where-Object { [uint32]$_.ProcessId -eq $parentId } | Select-Object -First 1',
          '}',
        ]),
    `$owners = @(Get-NetTCPConnection -LocalPort ${config.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)`,
    `[pscustomobject]@{CommandLine=$process.CommandLine;CreationTime=$process.CreationDate.ToUniversalTime().ToString('o');DescendsFromLauncher=$descendsFromLauncher;ExecutablePath=$process.ExecutablePath;OwnsPort=($owners -contains ${pid})} | ConvertTo-Json -Compress`,
  ].join('; ');
  const result = yield* runCommandEffect(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    allowFailure: true,
    timeoutMs: 5000,
  });
  if (result.exitCode !== 0) {
    return false;
  }
  const identity = Option.getOrUndefined(parseJson(result.stdout));
  if (!isJsonObject(identity)) {
    return false;
  }
  if (
    identity.DescendsFromLauncher !== true ||
    identity.OwnsPort !== true ||
    typeof identity.CommandLine !== 'string'
  ) {
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
  if (!(yield* matchesExpectedWindowsProcess({commandLine, executablePath}, expected.server, expected.args))) {
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
  const pidPath = yield* pathJoin(config.agentContextHome, 'openviking-server.pid');
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
    args: yield* openVikingServerArgs(config),
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
  const system = yield* SystemInfo;
  if (system.platform === 'win32') {
    const result = yield* runCommandEffect('tasklist.exe', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
      allowFailure: true,
      timeoutMs: 5000,
    });
    return result.exitCode === 0 && new RegExp(`"${pid}"(?:,|$)`).test(result.stdout);
  }
  const result = yield* runCommandEffect('kill', ['-0', String(pid)], {allowFailure: true, timeoutMs: 5000});
  return result.exitCode === 0;
});

const signalProcessEffect = Effect.fn('signalProcess')(function* (pid: number, signal: NodeJS.Signals) {
  const system = yield* SystemInfo;
  const result =
    system.platform === 'win32'
      ? yield* runCommandEffect(yield* windowsTaskkillExecutable(), ['/pid', String(pid), '/t'], {
          allowFailure: true,
          timeoutMs: 5000,
        })
      : yield* runCommandEffect('kill', [`-${signal.replace(/^SIG/, '')}`, String(pid)], {
          allowFailure: true,
          timeoutMs: 5000,
        });
  return result.exitCode === 0 || !(yield* isProcessRunningEffect(pid));
});

const commandCheck = Effect.fn('lifecycle.commandCheck')(function* (name: string, args: readonly string[]) {
  const executable = yield* findExecutable([name]);
  if (!executable) {
    return {name, status: 'fail', detail: 'missing from PATH'};
  }
  const result = yield* runCommand(executable, args, {allowFailure: true});
  return {
    name,
    status: result.exitCode === 0 ? 'ok' : 'warn',
    detail: firstLine(result.stdout || result.stderr) || executable,
  };
});

const openVikingServerCheck = Effect.fn('lifecycle.openVikingServerCheck')(function* () {
  const name = OPENVIKING_SERVER_COMMAND;
  const executable = yield* findOpenVikingServer();
  if (!executable) {
    return {
      name,
      status: 'fail',
      detail:
        'missing; run `threadnote install` to fetch it via uv or pipx (local-embed may compile from source on first install)',
    };
  }
  const result = yield* runCommand(executable, ['--help'], {allowFailure: true});
  const onPath = yield* findExecutable([OPENVIKING_SERVER_COMMAND]);
  const detail = onPath
    ? executable
    : `${executable} (found outside PATH; add ${yield* pathDirname(executable)} to PATH)`;
  return {
    name,
    status: result.exitCode === 0 ? 'ok' : 'warn',
    detail: result.exitCode === 0 ? detail : firstLine(result.stderr || result.stdout) || detail,
  };
});

const commandPresenceCheck = Effect.fn('lifecycle.commandPresenceCheck')(function* (
  name: string,
  args: readonly string[],
) {
  const executable = yield* findExecutable([name]);
  if (!executable) {
    return {name, status: 'warn', detail: 'missing; only needed for MCP install'};
  }
  const result = yield* runCommand(executable, args, {allowFailure: true});
  return {
    name,
    status: 'ok',
    detail: firstLine(result.stdout || result.stderr) || executable,
  };
});

const firstCommandCheck = Effect.fn('lifecycle.firstCommandCheck')(function* (
  name: string,
  commands: readonly string[],
  args: readonly string[],
) {
  for (const command of commands) {
    const executable = yield* findExecutable([command]);
    if (!executable) {
      continue;
    }
    const result = yield* runCommand(executable, args, {allowFailure: true});
    return {
      name,
      status: result.exitCode === 0 ? 'ok' : 'warn',
      detail: `${command}: ${firstLine(result.stdout || result.stderr) || executable}`,
    };
  }
  return {name, status: 'fail', detail: `none found: ${commands.join(', ')}`};
});

const pythonInstallerCheck = Effect.fn('lifecycle.pythonInstallerCheck')(function* () {
  const system = yield* SystemInfo;
  const failures: string[] = [];
  for (const manager of ['uv', 'pipx']) {
    const executable = yield* findExecutable([manager]);
    if (!executable) {
      continue;
    }
    const result = yield* runCommand(executable, ['--version'], {allowFailure: true});
    if (result.exitCode === 0) {
      return {
        name: 'python installer',
        status: 'ok',
        detail: `${manager}: ${firstLine(result.stdout || result.stderr) || executable}`,
      };
    }
    failures.push(`${manager}: ${firstLine(result.stderr || result.stdout) || 'not working'}`);
  }
  for (const python of pythonExecutableCandidates(system.platform)) {
    const executable = yield* findExecutable([python]);
    if (!executable) {
      continue;
    }
    const result = yield* runCommand(executable, ['-m', 'pip', '--version'], {allowFailure: true});
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
});

const openVikingCliCheck = Effect.fn('lifecycle.openVikingCliCheck')(function* () {
  const executable = yield* findOpenVikingCli();
  if (!executable) {
    return {name: 'openviking cli', status: 'fail', detail: 'none found: ov, openviking'};
  }
  const result = yield* runCommand(executable, ['--help'], {allowFailure: true});
  const onPath = yield* findExecutable(['ov', 'openviking']);
  const detail = onPath
    ? executable
    : `${executable} (found outside PATH; add ${yield* pathDirname(executable)} to PATH)`;
  return {
    name: 'openviking cli',
    status: result.exitCode === 0 ? 'ok' : 'warn',
    detail: result.exitCode === 0 ? detail : firstLine(result.stderr || result.stdout) || detail,
  };
});

/**
 * Warns when the installed OpenViking CLI is older than the version Threadnote
 * pins. `install`/`doctor` (unlike `repair`/`update`) don't upgrade OpenViking,
 * so without this a healthy-but-stale server silently stays behind the pin.
 */
const openVikingVersionCheck = Effect.fn('lifecycle.openVikingVersionCheck')(function* (config: RuntimeConfig) {
  const executable = yield* findOpenVikingCli();
  const pinned = config.openVikingVersion;
  if (!executable) {
    return {name: 'openviking version', status: 'warn', detail: `CLI not found; pinned ${pinned}`};
  }
  const installed = yield* readOpenVikingCliVersion(executable);
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
});

/**
 * Recall reads its hits from a JSON object with `memories`/`resources`/`skills`
 * arrays (see parseRecallHits). If a future OpenViking renames those buckets,
 * parseRecallHits would return zero hits with no error, silently degrading
 * recall. This probe asserts the shape is intact — empty buckets are fine, only
 * a missing/renamed bucket structure (or non-JSON output) warns.
 */
const recallShapeCheck = Effect.fn('lifecycle.recallShapeCheck')(function* (config: RuntimeConfig) {
  const executable = yield* findOpenVikingCli();
  if (!executable) {
    return {name: 'recall shape', status: 'warn', detail: 'CLI not found'};
  }
  const args = withIdentity(config, ['find', 'threadnote', '--node-limit', '1', '--output', 'json']);
  const result = yield* runCommand(executable, args, {allowFailure: true});
  if (result.exitCode !== 0) {
    return {name: 'recall shape', status: 'warn', detail: 'search failed; run threadnote repair'};
  }
  // Mirror parseRecallHits: `ov find/search --output json` prints a `cmd: ...`
  // preamble line before the JSON, and the buckets live under the `result`
  // envelope (`{ok, result: {memories, resources, skills}}`). Start at the
  // first line beginning with `{`, exactly as recall parsing does — otherwise
  // this probe false-warns on a perfectly healthy OpenViking.
  const start = result.stdout.search(/^\{/m);
  const parsed = start >= 0 ? Option.getOrUndefined(parseJson(result.stdout.slice(start))) : undefined;
  const envelope = isJsonObject(parsed) ? parsed.result : undefined;
  const buckets = ['memories', 'resources', 'skills'];
  if (!isJsonObject(envelope) || !buckets.some(key => Array.isArray(envelope[key]))) {
    return {
      name: 'recall shape',
      status: 'warn',
      detail: `search JSON missing the result.{${buckets.join(',')}} buckets recall parsing depends on`,
    };
  }
  return {name: 'recall shape', status: 'ok', detail: 'memories/resources/skills buckets present'};
});

const localEmbeddingCheck = Effect.fn('lifecycle.localEmbeddingCheck')(function* () {
  const serverPath = yield* findOpenVikingServer();
  if (!serverPath) {
    return {name: 'local embedding extra', status: 'warn', detail: 'openviking-server missing'};
  }
  const hasDependency = yield* hasLocalEmbeddingDependency(serverPath);
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
});

const pythonSystemCertificatesCheck = Effect.fn('lifecycle.pythonSystemCertificatesCheck')(function* () {
  const serverPath = yield* findOpenVikingServer();
  if (!serverPath) {
    return {name: 'python system certs', status: 'warn', detail: 'openviking-server missing'};
  }
  const hasDependency = yield* hasPythonSystemCertificatesPatch(serverPath);
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
});

const commandShimCheck = Effect.fn('lifecycle.commandShimCheck')(function* () {
  const system = yield* SystemInfo;
  if (!shouldManageCommandShim(system.platform)) {
    const launcher = yield* findExecutable(['threadnote']);
    return launcher
      ? {name: 'threadnote launcher', status: 'ok', detail: launcher}
      : {
          name: 'threadnote launcher',
          status: 'warn',
          detail: 'npm threadnote.cmd launcher is not on PATH; repair preserves package-manager launchers',
        };
  }
  const shimPath = yield* pathJoin(
    yield* expandPath(system.environment().THREADNOTE_BIN_DIR ?? '~/.local/bin'),
    'threadnote',
  );
  const content = yield* readFileIfExists(shimPath);
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
  if (content !== (yield* renderCommandShim())) {
    return {
      name: 'threadnote shim',
      status: 'warn',
      detail: `${shimPath} points at a different checkout; repair will rewrite it`,
    };
  }
  return {name: 'threadnote shim', status: 'ok', detail: shimPath};
});

const userAgentInstructionsChecks = Effect.fn('lifecycle.userAgentInstructionsChecks')(function* () {
  return yield* Effect.forEach(
    USER_AGENT_INSTRUCTION_TARGETS,
    target =>
      Effect.gen(function* () {
        const expectedInstructions = yield* renderUserAgentInstructions(target);
        const targetPath = yield* expandPath(target.path);
        const content = yield* readFileIfExists(targetPath);
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
    {concurrency: 'unbounded'},
  );
});

const hasLocalEmbeddingDependency = Effect.fn('lifecycle.hasLocalEmbeddingDependency')(function* (serverPath: string) {
  return yield* hasPythonModule(serverPath, 'llama_cpp');
});

const hasPythonSystemCertificatesPatch = Effect.fn('lifecycle.hasPythonSystemCertificatesPatch')(function* (
  serverPath: string,
) {
  return yield* hasPythonModule(serverPath, PYTHON_SYSTEM_CERTS_MODULE);
});

const hasPythonModule = Effect.fn('lifecycle.hasPythonModule')(function* (serverPath: string, moduleName: string) {
  const pythonPath = yield* siblingPythonForExecutable(serverPath);
  if (!pythonPath) {
    return undefined;
  }
  const result = yield* runCommand(pythonPath, ['-c', `import ${moduleName}`], {allowFailure: true});
  return result.exitCode === 0;
});

const siblingPythonForExecutable = Effect.fn('lifecycle.siblingPythonForExecutable')(function* (
  executablePath: string,
) {
  const system = yield* SystemInfo;
  const resolvedPath = yield* realpath(executablePath).pipe(Effect.option);
  if (Option.isNone(resolvedPath)) {
    return undefined;
  }
  const names = system.platform === 'win32' ? ['python.exe', 'python'] : ['python'];
  for (const name of names) {
    const pythonPath = yield* pathJoin(yield* pathDirname(resolvedPath.value), name);
    if (yield* exists(pythonPath)) {
      return pythonPath;
    }
  }
  return undefined;
});

const manifestCheck = Effect.fn('lifecycle.manifestCheck')((path: string) =>
  readSeedManifest(path).pipe(
    Effect.map(manifest => ({
      name: 'manifest',
      status: 'ok' as const,
      detail: `${path} (${manifest.projects.length} project(s))`,
    })),
    Effect.catch(error => Effect.succeed({name: 'manifest', status: 'fail' as const, detail: errorMessage(error)})),
  ),
);

const recallIndexFreshnessCheck = Effect.fn('lifecycle.recallIndexFreshnessCheck')((config: RuntimeConfig) =>
  Effect.gen(function* () {
    if (yield* summaryAutoGenerationDisabled(config)) {
      return {
        name: 'recall index freshness',
        status: 'ok' as const,
        detail:
          'OpenViking L0/L1 summary auto-generation disabled in ov.conf; ' +
          'directory summary placeholders are expected and not reindexed',
      };
    }
    const targets = yield* findStaleRecallIndexTargets(config, {
      collapseToRoots: true,
      includeAgentSkills: true,
      includeManifestResources: true,
    });
    if (targets.length === 0) {
      return {
        name: 'recall index freshness',
        status: 'ok' as const,
        detail: 'no stale generated summaries found',
      };
    }
    const staleSummaryCount = targets.reduce((total, target) => total + target.staleCount, 0);
    const sampleUris = targets.slice(0, 3).map(target => target.uri);
    const extraCount = targets.length - sampleUris.length;
    const sample = `${sampleUris.join(', ')}${extraCount > 0 ? `, +${extraCount} more` : ''}`;
    return {
      name: 'recall index freshness',
      status: 'warn' as const,
      detail: `${staleSummaryCount} stale generated summary file(s) under ${targets.length} scope(s); run repair to reindex ${sample}`,
    };
  }).pipe(
    Effect.catch(error =>
      Effect.succeed({
        name: 'recall index freshness',
        status: 'warn' as const,
        detail: errorMessage(error),
      }),
    ),
  ),
);

/**
 * Flag memories whose frontmatter `project` disagrees with the project segment
 * of their storage path. Recall scopes and boosts by the path project, so a
 * divergence (e.g. a shared memory living under `.../projects/coda/` but tagged
 * `project: mobile-native`) makes project-aware ranking unreliable. Read-only:
 * walks the on-disk memories tree and reports; the fix is to re-store the memory
 * under the correct project (which relocates the file).
 */
export const memoryProjectConsistencyCheck = Effect.fn('lifecycle.memoryProjectConsistencyCheck')(function* (
  config: RuntimeConfig,
) {
  const name = 'memory project consistency';
  const memoriesRoot = yield* pathJoin(
    config.agentContextHome,
    'data',
    'viking',
    config.account,
    'user',
    uriSegment(config.user),
    'memories',
  );
  return yield* Effect.gen(function* () {
    const entriesResult = yield* Effect.result(readdir(memoriesRoot, {recursive: true}));
    if (Result.isFailure(entriesResult)) {
      return {name, status: 'ok' as const, detail: 'no memories directory yet'};
    }
    const entries = entriesResult.success;
    const mismatches: string[] = [];
    let checked = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.md') || isSummarySidecarUri(entry)) {
        continue;
      }
      const uri = `viking://user/${uriSegment(config.user)}/memories/${entry.split(yield* pathSeparator).join('/')}`;
      const pathProject = memoryUriProjectSegment(uri);
      if (!pathProject) {
        continue;
      }
      const content = yield* readFile(yield* pathJoin(memoriesRoot, entry), 'utf8').pipe(Effect.option);
      if (Option.isNone(content)) {
        // Removed mid-walk (concurrent forget/compact/archive) or transiently
        // unreadable — skip this file rather than aborting the whole check.
        continue;
      }
      checked += 1;
      const frontProject = memoryFrontmatterField(content.value, 'project');
      if (frontProject && uriSegment(frontProject) !== pathProject) {
        mismatches.push(`${uri} (frontmatter "${frontProject}" vs path "${pathProject}")`);
      }
    }
    if (mismatches.length === 0) {
      return {name, status: 'ok' as const, detail: `${checked} project-scoped memories consistent`};
    }
    const sample = mismatches.slice(0, 3).join('; ');
    const extra = Math.max(0, mismatches.length - 3);
    return {
      name,
      status: 'warn' as const,
      detail:
        `${mismatches.length} memory(ies) whose frontmatter project differs from their storage path; ` +
        `re-store under the correct project to fix: ${sample}${extra > 0 ? `, +${extra} more` : ''}`,
    };
  }).pipe(Effect.catch(error => Effect.succeed({name, status: 'warn' as const, detail: errorMessage(error)})));
});

const fileCheck = Effect.fn('lifecycle.fileCheck')(function* (path: string, label: string) {
  return (yield* exists(path))
    ? {name: label, status: 'ok', detail: path}
    : {name: label, status: 'fail', detail: `${path} missing`};
});

const healthCheck = Effect.fn('lifecycle.healthCheck')((config: RuntimeConfig) =>
  readOpenVikingHealth(config, 1200).pipe(
    Effect.map(body => ({
      name: 'openviking health',
      status: 'ok' as const,
      detail: firstLine(body) || 'healthy',
    })),
    Effect.catch(error =>
      Effect.succeed({
        name: 'openviking health',
        status: 'warn' as const,
        detail: errorMessage(error),
      }),
    ),
  ),
);

const readOpenVikingHealth = Effect.fn('lifecycle.readOpenVikingHealth')(function* (
  config: RuntimeConfig,
  timeoutMs: number,
) {
  return yield* httpGetText(openVikingHealthUrl(config), timeoutMs);
});

const readOpenVikingHealthIfAvailable = Effect.fn('lifecycle.readOpenVikingHealthIfAvailable')(function* (
  config: RuntimeConfig,
  timeoutMs: number,
) {
  return yield* readOpenVikingHealth(config, timeoutMs).pipe(Effect.catch(() => Effect.succeed(undefined)));
});

const waitForOpenVikingHealth = Effect.fn('lifecycle.waitForOpenVikingHealth')(function* (
  config: RuntimeConfig,
  timeoutMs: number,
  progressMessage?: string,
) {
  const progress = progressMessage ? yield* startProgress(progressMessage) : undefined;
  return yield* Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while ((yield* Clock.currentTimeMillis) <= deadline) {
      const requestTimeoutMs = Math.max(100, Math.min(1000, deadline - (yield* Clock.currentTimeMillis)));
      const health = yield* readOpenVikingHealthIfAvailable(config, requestTimeoutMs);
      if (health) return health;
      const remainingMs = deadline - (yield* Clock.currentTimeMillis);
      if (remainingMs <= 0) break;
      yield* Effect.sleep(Math.min(START_HEALTH_POLL_INTERVAL_MS, remainingMs));
    }
    return undefined;
  }).pipe(Effect.ensuring(progress ? progress.stop().pipe(Effect.ignore) : Effect.void));
});

const runInstallCommands = Effect.fn('runInstallCommands')(function* (
  config: RuntimeConfig,
  preferred: PackageManager | undefined,
  force: boolean,
  dryRun: boolean,
) {
  const system = yield* SystemInfo;
  // When the user didn't ask for a specific manager and detection fell back
  // to plain `pip`, offer to install `uv` first — `pip install --user` is
  // refused under PEP 668 on Homebrew / system-managed Python, which is most
  // macOS and modern Linux setups.
  let manager = preferred;
  if (manager === undefined && !dryRun) {
    const detected = yield* detectPackageManager();
    if (detected === 'pip' && (yield* offerToInstallUv())) {
      const rediscovered = yield* detectPackageManager();
      if (rediscovered === 'uv') {
        manager = 'uv';
      }
    }
  }
  const installCommands = yield* getInstallCommands(config, manager, force);
  for (const installCommand of installCommands) {
    if (dryRun) {
      yield* maybeRunEffect(true, installCommand.executable, installCommand.args);
      continue;
    }
    const resolvedInstallCommand = yield* resolveOpenVikingInstallCommand(installCommand);
    // Stream live instead of buffering through runCommand. openviking[local-embed]
    // can compile llama-cpp-python from source (10-20 min, memory-heavy); buffering
    // hides all progress and the 10-minute command timeout would SIGKILL a
    // legitimate build. Because uv/pipx --force removes the existing tool env
    // first, a killed reinstall leaves openviking-server missing — so we also
    // print recovery guidance before failing.
    yield* Console.log(
      `Running: ${formatShellCommand(resolvedInstallCommand.executable, resolvedInstallCommand.args)}`,
    );
    const result = yield* runStreamingCommandEffect(resolvedInstallCommand.executable, resolvedInstallCommand.args, {
      maxOutputChars: INSTALL_OUTPUT_TAIL_CHARS,
    });
    if (result.exitCode !== 0) {
      const commandOutput = `${result.stderr}\n${result.stdout}`;
      const retry = openVikingSourceBuildRetryForArchiveFailure(resolvedInstallCommand, commandOutput);
      if (retry) {
        yield* Console.error('');
        yield* Console.error(
          'The prebuilt llama-cpp-python wheel failed ZIP archive validation; retrying with a local source build.',
        );
        yield* Console.error('This avoids the rejected wheel and can take 10-20 minutes.');
        yield* Console.log(`Running: ${formatInstallCommand(retry.command, retry.env)}`);
        const retryResult = yield* runStreamingCommandEffect(retry.command.executable, retry.command.args, {
          env: {...system.environment(), ...retry.env},
          maxOutputChars: INSTALL_OUTPUT_TAIL_CHARS,
        });
        if (retryResult.exitCode === 0) {
          continue;
        }
        yield* printOpenVikingInstallFailureHelp(retry.command, `${retryResult.stderr}\n${retryResult.stdout}`);
        throw new Error(
          `${formatInstallCommand(retry.command, retry.env)} exited with ${retryResult.exitCode} after automatic source-build retry.`,
        );
      }

      yield* printOpenVikingInstallFailureHelp(resolvedInstallCommand, commandOutput);
      throw new Error(
        `${formatShellCommand(resolvedInstallCommand.executable, resolvedInstallCommand.args)} exited with ${result.exitCode}.`,
      );
    }
  }
});

const printOpenVikingInstallFailureHelp = Effect.fn('lifecycle.printOpenVikingInstallFailureHelp')(function* (
  failedCommand: MappedCommand,
  commandOutput: string,
) {
  for (const line of openVikingInstallFailureHelpLines(failedCommand, commandOutput)) {
    yield* Console.error(line);
  }
});

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

const offerToInstallUv = Effect.fn('lifecycle.offerToInstallUv')(function* () {
  const system = yield* SystemInfo;
  if (!system.stdinIsTTY || !system.stdoutIsTTY) {
    if (system.platform === 'win32') {
      yield* Console.warn(
        'Neither uv nor pipx was found on PATH. Falling back to Python pip. ' +
          'Install uv with `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"` ' +
          'and re-run with --package-manager uv for an isolated OpenViking environment.',
      );
      return false;
    }
    yield* Console.warn(
      'Neither uv nor pipx was found on PATH. Falling back to `python3 -m pip install --user`, which fails on PEP 668 (Homebrew/system) Python.\n' +
        'Re-run with --package-manager uv after installing uv (brew install uv), or pass --package-manager pipx.',
    );
    return false;
  }
  const terminal = yield* Terminal.Terminal;
  yield* terminal.display(
    'OpenViking installs into Python; neither uv nor pipx is on PATH so threadnote would fall back to `pip install --user`, which fails on PEP 668 setups.\nInstall uv now? [Y/n] ',
  );
  const answer = (yield* terminal.readLine).trim().toLowerCase();
  if (answer === 'n' || answer === 'no') {
    yield* Console.log(
      'Continuing with `python3 -m pip install --user`. You may hit PEP 668 errors on managed Pythons.',
    );
    return false;
  }
  return yield* installUv();
});

const installUv = Effect.fn('lifecycle.installUv')(function* () {
  const system = yield* SystemInfo;
  if (system.platform === 'win32') {
    const powershell = yield* findExecutable(['powershell', 'pwsh']);
    if (!powershell) {
      yield* Console.warn('Could not install uv automatically because PowerShell was not found.');
      return false;
    }
    yield* Console.log('Installing uv via the official PowerShell installer...');
    const result = yield* runCommand(
      powershell,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex'],
      {allowFailure: true},
    );
    if (result.exitCode === 0) {
      const localBin = yield* pathJoin(yield* expandPath('~'), '.local', 'bin');
      system.setEnvironmentVariable('PATH', [localBin, system.environment().PATH ?? ''].join(system.pathDelimiter));
      if (yield* findExecutable(['uv'])) {
        candidateDirsCache = undefined;
        return true;
      }
    }
    yield* Console.warn('uv installation did not produce an executable on PATH. Open a new PowerShell and retry.');
    return false;
  }
  const brew = yield* findExecutable(['brew']);
  if (brew) {
    yield* Console.log('Installing uv via Homebrew...');
    const result = yield* runCommand(brew, ['install', 'uv'], {allowFailure: true});
    if (result.exitCode === 0) {
      if (result.stdout.trim()) {
        yield* Console.log(result.stdout.trim());
      }
      if (yield* findExecutable(['uv'])) {
        // Drop the candidate-dirs cache so subsequent openviking-server
        // resolutions can query `uv tool dir --bin` now that uv is on PATH.
        candidateDirsCache = undefined;
        return true;
      }
    } else {
      yield* Console.warn(`brew install uv failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }
  // Fall back to the official install script. Requires curl + sh; honors any
  // proxy env vars the user already has.
  if ((yield* findExecutable(['curl'])) && (yield* findExecutable(['sh']))) {
    yield* Console.log(
      'Installing uv via the official install script (curl -LsSf https://astral.sh/uv/install.sh | sh)...',
    );
    const result = yield* runCommand('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], {
      allowFailure: true,
    });
    if (result.exitCode === 0) {
      if (result.stdout.trim()) {
        yield* Console.log(result.stdout.trim());
      }
      if (yield* findExecutable(['uv'])) {
        candidateDirsCache = undefined;
        return true;
      }
      yield* Console.warn(
        'uv installed, but the new binary is not yet on this shell PATH. Open a new shell (or `source ~/.zshrc` / `source ~/.bashrc`) and re-run `threadnote install`.',
      );
      return false;
    }
    yield* Console.warn(`uv install script failed: ${(result.stderr || result.stdout).trim()}`);
  }
  yield* Console.warn(
    'Could not install uv automatically. Install it manually (brew install uv) and re-run threadnote install.',
  );
  return false;
});

const uvExecutables = Effect.fn('lifecycle.uvExecutables')(function* () {
  const executables = yield* findExecutableCandidates(['uv']);
  return yield* Effect.forEach(
    executables,
    executable =>
      Effect.gen(function* () {
        const result = yield* runCommand(executable, ['--version'], {allowFailure: true, timeoutMs: 5000});
        const match = `${result.stdout}\n${result.stderr}`.match(/\buv\s+v?(\d+(?:\.\d+){1,2})\b/i);
        return {executable, version: match?.[1]};
      }),
    {concurrency: 'unbounded'},
  );
});

export const findSupportedUvExecutable = Effect.fn('lifecycle.findSupportedUvExecutable')(function* () {
  const candidates = yield* uvExecutables();
  return candidates.find(
    candidate =>
      candidate.version !== undefined && compareVersions(candidate.version, MINIMUM_UV_SYSTEM_CERTS_VERSION) >= 0,
  )?.executable;
});

export const ensureSupportedUvExecutable = Effect.fn('lifecycle.ensureSupportedUvExecutable')(function* () {
  const candidates = yield* uvExecutables();
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

  yield* Console.log(`Updating uv to ${MINIMUM_UV_SYSTEM_CERTS_VERSION} or newer for system certificate support.`);
  for (const candidate of candidates) {
    const result = yield* runCommand(candidate.executable, ['self', 'update'], {allowFailure: true});
    if (result.exitCode === 0) {
      const updated = yield* findSupportedUvExecutable();
      if (updated) {
        return updated;
      }
    }
  }

  const brew = yield* findExecutable(['brew']);
  if (brew) {
    const result = yield* runCommand(brew, ['upgrade', 'uv'], {allowFailure: true});
    if (result.exitCode === 0) {
      const updated = yield* findSupportedUvExecutable();
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
});

const isUvExecutable = Effect.fn('lifecycle.isUvExecutable')(function* (executable: string) {
  const name = (yield* pathBasename(executable)).toLowerCase();
  return name === 'uv' || name === 'uv.exe';
});

export const resolveOpenVikingInstallCommand = Effect.fn('lifecycle.resolveOpenVikingInstallCommand')(function* (
  command: MappedCommand,
) {
  if (!(yield* isUvExecutable(command.executable))) {
    return command;
  }
  const uv = yield* ensureSupportedUvExecutable();
  if (!uv) {
    throw new Error(
      `uv was selected to install OpenViking but was not found on PATH. Install uv ${MINIMUM_UV_SYSTEM_CERTS_VERSION} or newer and re-run Threadnote.`,
    );
  }
  return {...command, executable: uv};
});

const getPythonSystemCertificatesInstallCommand = Effect.fn('lifecycle.getPythonSystemCertificatesInstallCommand')(
  function* (serverPath: string) {
    const pythonPath = yield* siblingPythonForExecutable(serverPath);
    if (!pythonPath) {
      throw new Error(`Could not find the OpenViking Python environment for ${serverPath}`);
    }
    const uvPath = yield* ensureSupportedUvExecutable();
    if (uvPath) {
      return {
        executable: uvPath,
        args: ['pip', 'install', '--system-certs', '--python', pythonPath, PYTHON_SYSTEM_CERTS_PACKAGE],
      };
    }
    return {executable: pythonPath, args: ['-m', 'pip', 'install', PYTHON_SYSTEM_CERTS_PACKAGE]};
  },
);

/**
 * Prebuilt llama-cpp-python wheel index for openviking[local-embed]. PyPI ships
 * only an sdist, so without this every install compiles the native extension
 * from source. The abetlen community index publishes per-backend wheels; we pick
 * a sensible CPU/Metal default by platform. CUDA/ROCm users (or anyone needing
 * to disable it, e.g. air-gapped) can override via THREADNOTE_LLAMA_WHEEL_INDEX;
 * setting it empty turns the extra index off and restores a from-source build.
 */
export const localEmbedWheelIndexUrl = Effect.fn('lifecycle.localEmbedWheelIndexUrl')(function* () {
  const system = yield* SystemInfo;
  const override = system.environment().THREADNOTE_LLAMA_WHEEL_INDEX;
  if (override !== undefined) {
    return override.trim() === '' ? undefined : override.trim();
  }
  const base = 'https://abetlen.github.io/llama-cpp-python/whl';
  return system.platform === 'darwin' ? `${base}/metal` : `${base}/cpu`;
});

/**
 * CPython version the uv-managed OpenViking tool is pinned to, so local-embed
 * resolves a prebuilt llama-cpp-python wheel instead of compiling. Defaults to
 * the pinned {@link OPENVIKING_TOOL_PYTHON}. Override via THREADNOTE_OPENVIKING_PYTHON
 * (e.g. a specific interpreter); set it empty to drop the pin and let uv use its
 * default interpreter — useful in locked or offline environments where a managed
 * CPython cannot be fetched.
 */
export const openVikingToolPython = Effect.fn('lifecycle.openVikingToolPython')(function* () {
  const system = yield* SystemInfo;
  const override = system.environment().THREADNOTE_OPENVIKING_PYTHON;
  if (override !== undefined) {
    return override.trim() === '' ? undefined : override.trim();
  }
  return OPENVIKING_TOOL_PYTHON;
});

export const getInstallCommands = Effect.fn('lifecycle.getInstallCommands')(function* (
  config: RuntimeConfig,
  preferred: PackageManager | undefined,
  force: boolean,
) {
  const packageSpec = `${OPENVIKING_PACKAGE_NAME}==${config.openVikingVersion}`;
  const wheelIndex = yield* localEmbedWheelIndexUrl();
  const manager = preferred ?? (yield* detectPackageManager());
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
    const toolPython = yield* openVikingToolPython();
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
  const system = yield* SystemInfo;
  const pythonCandidates = pythonExecutableCandidates(system.platform);
  const executable = (yield* findExecutable(pythonCandidates)) ?? pythonCandidates[0]!;
  return [{executable, args: pipArgs}];
});

const detectPackageManager = Effect.fn('lifecycle.detectPackageManager')(function* () {
  if (yield* findExecutable(['uv'])) {
    return 'uv';
  }
  if (yield* findExecutable(['pipx'])) {
    return 'pipx';
  }
  return 'pip';
});

const printInstallNextSteps = Effect.fn('lifecycle.printInstallNextSteps')(function* (options: {
  readonly dryRun: boolean;
  readonly startsServer: boolean;
}) {
  if (options.dryRun) {
    yield* Console.log('Dry run complete. Run without --dry-run to install and start OpenViking.');
    return;
  }

  if (options.startsServer) {
    yield* Console.log('Install complete. OpenViking health is ready. Next:');
    yield* Console.log('  threadnote doctor --dry-run');
    return;
  }

  yield* Console.log('Install complete. Run start, then doctor:');
  yield* Console.log('  threadnote start');
  yield* Console.log('  threadnote doctor --dry-run');
});

const writeTemplateIfMissing = Effect.fn('lifecycle.writeTemplateIfMissing')(function* (options: {
  readonly config: RuntimeConfig;
  readonly destinationPath: string;
  readonly dryRun: boolean;
  readonly shouldRepair?: (content: string) => boolean | Effect.Effect<boolean, unknown, Path.Path>;
  readonly templatePath: string;
}) {
  if (yield* exists(options.destinationPath)) {
    const currentContent = yield* readFile(options.destinationPath, 'utf8');
    const repairDecision = options.shouldRepair?.(currentContent);
    const shouldRepair = Effect.isEffect(repairDecision) ? yield* repairDecision : repairDecision;
    if (shouldRepair !== true) {
      yield* Console.log(`Already exists: ${options.destinationPath}`);
      return;
    }
    const rendered = renderJsonTemplate(yield* readFile(options.templatePath, 'utf8'), options.config);
    if (options.dryRun) {
      yield* Console.log(`Would repair generated config: ${options.destinationPath}`);
      return;
    }
    const backupPath = `${options.destinationPath}.legacy-${safeTimestamp()}`;
    yield* writeFile(backupPath, currentContent, {encoding: 'utf8', mode: 0o600});
    yield* chmod(backupPath, 0o600);
    yield* writeFile(options.destinationPath, rendered, {encoding: 'utf8', mode: 0o600});
    yield* chmod(options.destinationPath, 0o600);
    yield* Console.log(`Repaired generated config: ${options.destinationPath}`);
    yield* Console.log(`Backup: ${backupPath}`);
    return;
  }
  const rendered = renderJsonTemplate(yield* readFile(options.templatePath, 'utf8'), options.config);
  if (options.dryRun) {
    yield* Console.log(`Would write ${options.destinationPath}`);
    return;
  }
  yield* ensureDirectory(yield* pathDirname(options.destinationPath), false);
  yield* writeFile(options.destinationPath, rendered, {encoding: 'utf8', mode: 0o600});
  yield* chmod(options.destinationPath, 0o600);
  yield* Console.log(`Wrote ${options.destinationPath}`);
});

const installCommandShim = Effect.fn('lifecycle.installCommandShim')(function* (dryRun: boolean) {
  const system = yield* SystemInfo;
  if (!shouldManageCommandShim(system.platform)) {
    yield* Console.log('Preserving the package-manager threadnote.cmd launcher on Windows.');
    return;
  }
  const binDir = yield* expandPath(system.environment().THREADNOTE_BIN_DIR ?? '~/.local/bin');
  const shimPath = yield* pathJoin(binDir, 'threadnote');
  const existingContent = yield* readFileIfExists(shimPath);
  if (existingContent && !isManagedCommandShim(existingContent)) {
    yield* Console.log(`WARN not overwriting existing command shim: ${shimPath}`);
    return;
  }

  const content = yield* renderCommandShim();
  if (existingContent === content) {
    yield* Console.log(`Already exists: ${shimPath}`);
    return;
  }
  if (dryRun) {
    yield* Console.log(`Would write command shim: ${shimPath}`);
    return;
  }
  yield* ensureDirectory(binDir, false);
  yield* writeFile(shimPath, content, {encoding: 'utf8', mode: 0o755});
  yield* chmod(shimPath, 0o755);
  yield* Console.log(`Wrote command shim: ${shimPath}`);
});

const removeCommandShim = Effect.fn('lifecycle.removeCommandShim')(function* (dryRun: boolean) {
  const system = yield* SystemInfo;
  if (!shouldManageCommandShim(system.platform)) {
    yield* Console.log('Preserving the package-manager threadnote.cmd launcher on Windows.');
    return;
  }
  const shimPath = yield* pathJoin(
    yield* expandPath(system.environment().THREADNOTE_BIN_DIR ?? '~/.local/bin'),
    'threadnote',
  );
  const content = yield* readFileIfExists(shimPath);
  if (content === undefined) {
    yield* Console.log(`Already absent: ${shimPath}`);
    return;
  }
  if (!isManagedCommandShim(content)) {
    yield* Console.log(`WARN not removing unmanaged command shim: ${shimPath}`);
    return;
  }
  yield* removePath(shimPath, 'command shim', dryRun);
});

const installUserAgentInstructions = Effect.fn('lifecycle.installUserAgentInstructions')(function* (dryRun: boolean) {
  for (const target of USER_AGENT_INSTRUCTION_TARGETS) {
    const instructions = yield* renderUserAgentInstructions(target);
    const targetPath = yield* expandPath(target.path);
    const currentContent = yield* readFileIfExists(targetPath);
    if (target.kind === 'file' && currentContent !== undefined && extractManagedBlock(currentContent) === undefined) {
      yield* Console.log(`WARN ${targetPath} is not managed by threadnote; not modifying it`);
      continue;
    }
    const nextContent = target.kind === 'file' ? instructions : upsertManagedBlock(currentContent ?? '', instructions);
    if (nextContent === undefined) {
      yield* Console.log(`WARN ${targetPath} has partial threadnote markers; not modifying it`);
      continue;
    }
    if (currentContent === nextContent) {
      yield* Console.log(`Already exists: ${targetPath}`);
      continue;
    }
    if (dryRun) {
      yield* Console.log(currentContent === undefined ? `Would write ${targetPath}` : `Would update ${targetPath}`);
      continue;
    }
    yield* ensureDirectory(yield* pathDirname(targetPath), false);
    yield* writeFile(targetPath, nextContent, {encoding: 'utf8', mode: 0o644});
    yield* Console.log(currentContent === undefined ? `Wrote ${targetPath}` : `Updated ${targetPath}`);
  }
});

const removeUserAgentInstructions = Effect.fn('lifecycle.removeUserAgentInstructions')(function* (dryRun: boolean) {
  for (const target of USER_AGENT_INSTRUCTION_TARGETS) {
    const targetPath = yield* expandPath(target.path);
    const currentContent = yield* readFileIfExists(targetPath);
    if (currentContent === undefined) {
      yield* Console.log(`Already absent: ${targetPath}`);
      continue;
    }
    if (target.kind === 'file') {
      if (extractManagedBlock(currentContent) === undefined) {
        yield* Console.log(`WARN ${targetPath} is not managed by threadnote; not removing it`);
        continue;
      }
      yield* removePath(targetPath, target.label, dryRun);
      continue;
    }
    const nextContent = removeManagedBlock(currentContent);
    if (nextContent === undefined) {
      yield* Console.log(`WARN ${targetPath} has partial threadnote markers; not modifying it`);
      continue;
    }
    if (nextContent === currentContent) {
      yield* Console.log(`No threadnote block found: ${targetPath}`);
      continue;
    }
    if (nextContent.trim().length === 0) {
      yield* removePath(targetPath, target.label, dryRun);
      continue;
    }
    if (dryRun) {
      yield* Console.log(`Would update ${targetPath}`);
      continue;
    }
    yield* writeFile(targetPath, nextContent, {encoding: 'utf8', mode: 0o644});
    yield* Console.log(`Updated ${targetPath}`);
  }
});

const renderUserAgentInstructions = Effect.fn('lifecycle.renderUserAgentInstructions')(function* (
  target: UserAgentInstructionTarget,
) {
  const block = yield* renderUserAgentInstructionsBlock();
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
});

const renderUserAgentInstructionsBlock = Effect.fn('lifecycle.renderUserAgentInstructionsBlock')(function* () {
  const instructions = (yield* readFile(
    yield* pathJoin(yield* toolRoot(), 'docs', 'agent-instructions.md'),
    'utf8',
  )).trim();
  return `${USER_INSTRUCTIONS_START_MARKER}\n${instructions}\n${USER_INSTRUCTIONS_END_MARKER}`;
});

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

const renderCommandShim = Effect.fn('lifecycle.renderCommandShim')(function* () {
  const root = yield* toolRoot();
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
});

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
  const source = yield* pathJoin(yield* toolRoot(), 'config', 'launchd', `${LAUNCHD_LABEL}.plist.template`);
  const destination = yield* launchAgentPath();
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
  yield* fs.makeDirectory(yield* pathDirname(destination), {recursive: true});
  yield* fs.makeDirectory(yield* pathDirname(yield* openVikingLogPath(config)), {recursive: true});
  const healthUrl = openVikingHealthUrl(config);
  const activationTimeoutMs = yield* remainingBudget(installDeadline, START_HEALTH_TIMEOUT_MS);
  const health = yield* activateLaunchAgent<
    ChildProcessSpawner | CommandExecutor | FileSystem.FileSystem | HttpService | Path.Path | SystemInfo
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
        `${START_HEALTH_TIMEOUT_MS / 1000}s. Logs: ${yield* openVikingLogPath(config)}`,
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
  const system = yield* SystemInfo;
  return yield* stageLaunchAgentPlistWithFileSystem(fs, plistPath, content, system.processId);
});

function stageLaunchAgentPlistWithFileSystem(
  fs: FileSystem.FileSystem,
  plistPath: string,
  content: string,
  processId: number,
): Effect.Effect<LaunchAgentPlistTransaction, unknown> {
  return Effect.gen(function* () {
    const stagePath = `${plistPath}.threadnote-stage-${processId}`;
    const rollbackPath = `${plistPath}.threadnote-rollback-${processId}`;
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
): Effect.Effect<string | undefined, unknown, CommandExecutor | HttpService | SystemInfo> {
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

function liveLaunchAgentHealthEffects(): LaunchAgentHealthEffects<CommandExecutor | HttpService | SystemInfo> {
  return {
    ownsPort: (pid, config, timeoutMs) => launchdProcessOwnsPort(pid, config, timeoutMs),
    readHealth: readOpenVikingHealthEffect,
    readStatus: timeoutMs => readLaunchAgentStatus(undefined, timeoutMs),
  };
}

const isTcpPortOpenEffect = Effect.fn('isTcpPortOpen')(function* (host: string, port: number, timeoutMs: number) {
  return yield* isTcpPortOpen(host, port, timeoutMs);
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
  const agentPath = yield* launchAgentPath();
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

const eraseThreadnoteHome = Effect.fn('lifecycle.eraseThreadnoteHome')(function* (path: string, dryRun: boolean) {
  assertSafeThreadnoteHomeForErase(path);
  yield* removePathIfExists(path, 'THREADNOTE_HOME and all memories', dryRun);
});

const shouldRepairOpenVikingConfig = Effect.fn('lifecycle.shouldRepairOpenVikingConfig')(function* (
  content: string,
  config: RuntimeConfig,
) {
  const parsed = parseJsonConfigObject(content);
  if (!parsed) {
    return false;
  }
  if (isLegacyOpenVikingConfig(parsed)) {
    return true;
  }
  return (
    (yield* isGeneratedLocalPilotConfig(parsed, config)) &&
    (parsed.auto_generate_l0 !== false || parsed.auto_generate_l1 !== false)
  );
});

function isLegacyOpenVikingConfig(parsed: JsonObject): boolean {
  return (
    isJsonObject(parsed.server) &&
    typeof parsed.server.storage_dir === 'string' &&
    isJsonObject(parsed.identity) &&
    isJsonObject(parsed.privacy) &&
    isJsonObject(parsed.models)
  );
}

const isGeneratedLocalPilotConfig = Effect.fn('lifecycle.isGeneratedLocalPilotConfig')(function* (
  parsed: JsonObject,
  config: RuntimeConfig,
) {
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
  if (
    !isJsonObject(parsed.storage) ||
    parsed.storage.workspace !== (yield* pathJoin(config.agentContextHome, 'data'))
  ) {
    return false;
  }
  return (
    isJsonObject(parsed.server) &&
    parsed.server.host === config.host &&
    String(parsed.server.port) === String(config.port)
  );
});

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
