import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import {Clock, Console, Crypto, Effect, Encoding, FileSystem, Path, Result} from 'effect';
import {promptForSelection} from '../cli_ui.js';
import {
  DEFAULT_LOCAL_AI_MODEL,
  findLocalAiModel,
  LOCAL_AI_MODELS,
  type LocalAiModelDefinition,
  requireLocalAiModel,
} from '../local_ai_models.js';
import {runCommandEffect, runStreamingCommandEffect} from './command.js';
import {sha256Hex} from './digest.js';
import {withExclusiveFileLock} from './file_lock.js';
import {getJsonEffect} from './http.js';
import {SystemInfo} from './system.js';
import type {RuntimeConfig} from '../types.js';
import {
  ensureDirectory,
  errorMessage,
  expandPath,
  findExecutable,
  findOpenVikingCli,
  isJsonObject,
  isTcpPortOpen,
  pythonRuntimeForToolExecutable,
  readFileIfExists,
  toolRoot,
} from '../utils.js';

export const LOCAL_AI_MODEL_ID = DEFAULT_LOCAL_AI_MODEL.id;
export const LOCAL_AI_MODEL_FILE = DEFAULT_LOCAL_AI_MODEL.file;
export const LOCAL_AI_MODEL_REPOSITORY = DEFAULT_LOCAL_AI_MODEL.repository;
export const LOCAL_AI_MODEL_REVISION = DEFAULT_LOCAL_AI_MODEL.revision;
export const LOCAL_AI_MODEL_SHA256 = DEFAULT_LOCAL_AI_MODEL.sha256;
export const LOCAL_AI_MODEL_SIZE = DEFAULT_LOCAL_AI_MODEL.size;
export const LOCAL_AI_DEFAULT_PORT = 1934;

const LOCAL_AI_CONFIG_VERSION = 1;
const LOCAL_AI_CONFIG_FILE = 'local-ai.json';
const LOCAL_AI_TOKEN_FILE = 'local-ai-token';
const LOCAL_AI_LOCK_FILE = 'local-ai-server.lock';
const LOCAL_AI_PID_FILE = 'local-ai-server.json';
const LOCAL_AI_SERVICE_ID = 'threadnote-local-ai';
const LOCAL_AI_SERVER_SCRIPT = 'local-ai-server.py';
const LOCAL_AI_START_TIMEOUT_MILLISECONDS = 60_000;
const LOCAL_AI_STOP_TIMEOUT_MILLISECONDS = 10_000;
const LOCAL_AI_POLL_MILLISECONDS = 250;
const LOCAL_AI_LOCK_STALE_MILLISECONDS = 90_000;
const LOCAL_AI_LOCK_WAIT_MILLISECONDS = 75_000;
type LocalAiRuntimeConfig = Pick<RuntimeConfig, 'agentContextHome'>;

export interface LocalAiSettings {
  readonly enabled: boolean;
  readonly host: '127.0.0.1';
  readonly model: string;
  readonly modelPath: string;
  readonly port: number;
  readonly version: 1;
}

interface LocalAiProcessRecord {
  readonly launchId: string;
  readonly modelPath: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly version: 1;
}

interface LocalAiHealth {
  readonly launchId: string;
  readonly model: string;
  readonly pid: number;
  readonly service: typeof LOCAL_AI_SERVICE_ID;
  readonly status: 'ok';
}

export interface LocalAiInstallOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly model?: string;
  readonly modelPath?: string;
  readonly start?: boolean;
}

export interface LocalAiLifecycleOptions {
  readonly dryRun?: boolean;
}

export interface LocalAiModelSwitchOptions extends LocalAiLifecycleOptions {
  readonly model?: string;
}

export interface LocalAiUninstallOptions extends LocalAiLifecycleOptions {
  readonly eraseModel?: boolean;
}

export interface InstalledLocalAiModel {
  readonly definition: LocalAiModelDefinition;
  readonly path: string;
}

export const runLocalAiInstall = Effect.fn('localAi.install')(function* (
  config: RuntimeConfig,
  options: LocalAiInstallOptions,
) {
  const dryRun = options.dryRun === true;
  const model = yield* resolveLocalAiModel(options.model);
  const pathService = yield* Path.Path;
  const managedModelPath = yield* localAiManagedModelPath(config, model);
  const modelPath = options.modelPath ? yield* expandPath(options.modelPath) : managedModelPath;
  const settings: LocalAiSettings = {
    enabled: true,
    host: '127.0.0.1',
    model: model.id,
    modelPath,
    port: LOCAL_AI_DEFAULT_PORT,
    version: LOCAL_AI_CONFIG_VERSION,
  };
  const configPath = yield* localAiConfigPath(config);
  const tokenPath = yield* localAiTokenPath(config);

  if (dryRun) {
    if (!options.modelPath) {
      yield* Console.log(
        `Would download ${model.repository}/${model.file} (${formatModelSize(model.size)}) to ${modelPath}.`,
      );
    } else {
      yield* Console.log(`Would verify existing model: ${modelPath}`);
    }
    yield* Console.log(`Would verify SHA-256 ${model.sha256}.`);
    yield* Console.log(`Would write local AI configuration: ${configPath}`);
    yield* Console.log(`Would create a private local AI access token: ${tokenPath}`);
    if (options.start !== false) {
      yield* Console.log(`Would start the loopback model service at ${localAiApiUrl(settings)}.`);
    }
    return;
  }

  let verified = false;
  if (!options.modelPath) {
    if (options.force !== true) {
      verified = yield* verifyLocalAiModel(model, modelPath).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
    }
    if (!verified) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(modelPath, {force: true});
      yield* ensureDirectory(pathService.dirname(modelPath), false);
      const {args, executable} = yield* localAiDownloadCommand(model, modelPath);
      yield* Console.log(
        `Downloading ${model.id} (${formatModelSize(model.size)}). This is a one-time local download.`,
      );
      const download = yield* runStreamingCommandEffect(executable, args, {inheritOutput: true});
      if (download.exitCode !== 0) {
        return yield* Effect.fail(new Error(`Local AI model download exited with ${download.exitCode}.`));
      }
    }
  }

  if (!verified) {
    yield* verifyLocalAiModel(model, modelPath);
  }
  const token = yield* ensureLocalAiAccessToken(config);
  yield* configureLocalAiModel(config, settings, token, {start: options.start !== false});
  yield* Console.log(`Enabled local AI recall with ${model.id}.`);
  yield* Console.log(`Configuration: ${configPath}`);
});

export const runLocalAiModelSwitch = Effect.fn('localAi.model.switch')(function* (
  config: RuntimeConfig,
  options: LocalAiModelSwitchOptions,
) {
  const current = yield* readLocalAiSettings(config);
  const installed = yield* listInstalledLocalAiModels(config, current);
  if (installed.length === 0) {
    yield* Console.log('No installed local AI models are available.');
    yield* Console.log('Install one with:');
    yield* Console.log(`  threadnote local-ai install`);
    yield* Console.log(`  threadnote local-ai install --model LFM2.5-350M`);
    return;
  }

  let selected: InstalledLocalAiModel | undefined;
  if (options.model) {
    const requested = yield* resolveLocalAiModel(options.model);
    selected = installed.find(item => item.definition.id === requested.id);
    if (!selected) {
      yield* Console.log(`${requested.id} is not installed.`);
      yield* Console.log(`Install it with: threadnote local-ai install --model ${requested.id}`);
      return;
    }
  } else {
    const system = yield* SystemInfo;
    if (!system.stdinIsTTY || !system.stdoutIsTTY) {
      yield* Console.log('Interactive model selection requires a terminal.');
      yield* Console.log('Switch directly with: threadnote local-ai model switch --model <model>');
      return;
    }
    const currentIndex = Math.max(
      0,
      installed.findIndex(item => item.definition.id === current?.model && item.path === current.modelPath),
    );
    const selectedIndex = yield* promptForSelection(
      'Select an installed local AI model:',
      installed.map(item => {
        const active = item.definition.id === current?.model && item.path === current.modelPath ? ' (current)' : '';
        return `${item.definition.displayName} — ${formatModelSize(item.definition.size)}${active}`;
      }),
      currentIndex,
    );
    selected = installed[selectedIndex];
  }

  if (!selected) {
    return;
  }
  if (selected.definition.id === current?.model && selected.path === current.modelPath) {
    yield* Console.log(`${selected.definition.id} is already selected.`);
    return;
  }

  const settings: LocalAiSettings = {
    enabled: current?.enabled ?? true,
    host: '127.0.0.1',
    model: selected.definition.id,
    modelPath: selected.path,
    port: current?.port ?? LOCAL_AI_DEFAULT_PORT,
    version: LOCAL_AI_CONFIG_VERSION,
  };
  if (options.dryRun === true) {
    yield* Console.log(`Would switch local AI from ${current?.model ?? 'no configured model'} to ${settings.model}.`);
    yield* Console.log(
      settings.enabled
        ? `Would restart the loopback model service at ${localAiApiUrl(settings)}.`
        : 'Would preserve the disabled local AI state.',
    );
    return;
  }

  yield* assertLocalAiModelPresent(settings);
  const token = yield* ensureLocalAiAccessToken(config);
  yield* configureLocalAiModel(config, settings, token, {start: settings.enabled});
  yield* Console.log(`Switched local AI model to ${settings.model}.`);
});

export const runLocalAiEnable = Effect.fn('localAi.enable')(function* (
  config: RuntimeConfig,
  options: LocalAiLifecycleOptions,
) {
  yield* withLocalAiLifecycleLock(
    config,
    Effect.gen(function* () {
      const settings = yield* readLocalAiSettings(config);
      if (!settings) {
        return yield* Effect.fail(new Error('Local AI is not installed. Run: threadnote local-ai install'));
      }
      if (settings.enabled) {
        yield* Console.log('Threadnote local AI recall is already enabled.');
        return;
      }
      if (options.dryRun === true) {
        yield* Console.log('Would enable Threadnote local AI recall.');
        return;
      }
      yield* requireLocalAiAccessToken(config);
      yield* writeLocalAiSettings(config, {...settings, enabled: true});
      yield* Console.log('Enabled Threadnote local AI recall.');
    }),
  );
});

export const runLocalAiDisable = Effect.fn('localAi.disable')(function* (
  config: RuntimeConfig,
  options: LocalAiLifecycleOptions,
) {
  yield* withLocalAiLifecycleLock(
    config,
    Effect.gen(function* () {
      const settings = yield* readLocalAiSettings(config);
      if (!settings) {
        yield* Console.log('Local AI recall is not installed.');
        return;
      }
      if (options.dryRun === true) {
        yield* stopRecordedLocalAi(config, options);
        yield* Console.log('Would disable Threadnote local AI recall without removing its model.');
        return;
      }
      yield* writeLocalAiSettings(config, {...settings, enabled: false});
      yield* stopRecordedLocalAi(config, options);
      yield* Console.log('Disabled Threadnote local AI recall.');
    }),
  );
});

export const runLocalAiStart = Effect.fn('localAi.start')(function* (
  config: RuntimeConfig,
  options: LocalAiLifecycleOptions,
) {
  const settings = yield* requireLocalAiSettings(config);
  if (options.dryRun === true) {
    yield* Console.log(`Would start ${settings.model} at ${localAiApiUrl(settings)}.`);
    return;
  }
  if (!(yield* startLocalAiServer(config, {announce: true}))) {
    return yield* Effect.fail(new Error('Local AI recall is disabled. Run: threadnote local-ai enable'));
  }
});

export const ensureLocalAiStarted = Effect.fn('localAi.ensureStarted')(function* (config: LocalAiRuntimeConfig) {
  const settings = yield* readLocalAiSettings(config);
  if (!settings?.enabled) return false;
  return yield* startLocalAiServer(config, {announce: false});
});

export const runLocalAiStop = Effect.fn('localAi.stop')(function* (
  config: RuntimeConfig,
  options: LocalAiLifecycleOptions,
) {
  yield* withLocalAiLifecycleLock(config, stopRecordedLocalAi(config, options));
});

const stopRecordedLocalAi = Effect.fn('localAi.stopRecorded')(function* (
  config: RuntimeConfig,
  options: LocalAiLifecycleOptions,
) {
  const record = yield* readLocalAiProcessRecord(config);
  if (!record) {
    if (options.dryRun !== true) {
      yield* Console.log('No Threadnote local AI process is recorded.');
    }
    return;
  }
  if (options.dryRun === true) {
    yield* Console.log(`Would stop Threadnote local AI process ${record.pid}.`);
    return;
  }
  yield* stopLocalAiProcess(config, record);
});

export const runLocalAiStatus = Effect.fn('localAi.status')(function* (config: RuntimeConfig) {
  const settings = yield* readLocalAiSettings(config);
  if (!settings) {
    yield* Console.log('Local AI recall is not installed.');
    yield* Console.log('Install it with: threadnote local-ai install');
    return;
  }
  const model = findLocalAiModel(settings.model);
  const modelPresent = model ? yield* localAiModelFilePresent(model, settings.modelPath) : false;
  yield* Console.log(`Local AI recall: ${settings.enabled ? 'enabled' : 'disabled'}`);
  yield* Console.log(`Model: ${settings.model}`);
  yield* Console.log(`Model file: ${settings.modelPath}`);
  yield* Console.log(`Model present: ${modelPresent ? 'yes' : 'no'}`);
  yield* Console.log(`Endpoint: ${localAiApiUrl(settings)}`);
  if (!settings.enabled) {
    const token = yield* readLocalAiAccessToken(config).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const health = token ? yield* readLocalAiHealth(settings, token) : undefined;
    yield* Console.log(health ? `Service: healthy but disabled (pid ${health.pid})` : 'Service: stopped or unhealthy');
    yield* Console.log('Enable it with: threadnote local-ai enable');
    return;
  }
  const token = yield* requireLocalAiAccessToken(config);
  const health = yield* readLocalAiHealth(settings, token);
  yield* Console.log(health ? `Service: healthy (pid ${health.pid})` : 'Service: stopped or unhealthy');
});

export const localAiDoctorCheck = Effect.fn('localAi.doctorCheck')(function* (config: RuntimeConfig) {
  return yield* Effect.gen(function* () {
    const settings = yield* readLocalAiSettings(config);
    if (!settings) {
      const installed = yield* listInstalledLocalAiModels(config);
      return installed.length === 0
        ? {
            detail: 'not installed (optional); run threadnote local-ai install',
            name: 'local AI',
            status: 'ok' as const,
          }
        : {
            detail:
              `${installed.length} model${installed.length === 1 ? '' : 's'} present but not configured; ` +
              'run threadnote local-ai model switch',
            name: 'local AI',
            status: 'ok' as const,
          };
    }

    const model = findLocalAiModel(settings.model);
    if (!model) {
      return {
        detail: `configured model ${settings.model} is not in this Threadnote model catalog`,
        name: 'local AI',
        status: 'warn' as const,
      };
    }
    if (!(yield* localAiModelFilePresent(model, settings.modelPath))) {
      return {
        detail:
          `${settings.enabled ? 'enabled' : 'disabled'}; ${model.id} model file missing or wrong size; ` +
          `run threadnote local-ai install --model ${model.id}`,
        name: 'local AI',
        status: 'warn' as const,
      };
    }

    const token = yield* readLocalAiAccessToken(config).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (!token) {
      return {
        detail:
          `${settings.enabled ? 'enabled' : 'disabled'}; ${model.id} present; access token missing or invalid; ` +
          `run threadnote local-ai install --model ${model.id} --force`,
        name: 'local AI',
        status: 'warn' as const,
      };
    }

    const health = yield* readLocalAiHealth(settings, token);
    if (!settings.enabled) {
      return health
        ? {
            detail: `disabled; ${model.id} present; service still healthy (pid ${health.pid})`,
            name: 'local AI',
            status: 'warn' as const,
          }
        : {
            detail: `disabled; ${model.id} present; service stopped`,
            name: 'local AI',
            status: 'ok' as const,
          };
    }
    return health?.model === settings.model
      ? {
          detail: `enabled; ${model.id} present; service healthy (pid ${health.pid})`,
          name: 'local AI',
          status: 'ok' as const,
        }
      : {
          detail: `enabled; ${model.id} present; service stopped or unhealthy; run threadnote local-ai start`,
          name: 'local AI',
          status: 'warn' as const,
        };
  }).pipe(
    Effect.catch(error =>
      Effect.succeed({
        detail: `could not inspect local AI: ${errorMessage(error)}`,
        name: 'local AI',
        status: 'warn' as const,
      }),
    ),
  );
});

export const runLocalAiUninstall = Effect.fn('localAi.uninstall')(function* (
  config: RuntimeConfig,
  options: LocalAiUninstallOptions,
) {
  const settings = yield* readLocalAiSettings(config);
  const configPath = yield* localAiConfigPath(config);
  if (options.dryRun === true) {
    yield* runLocalAiStop(config, options);
    yield* Console.log(`Would remove local AI configuration: ${configPath}`);
    if (options.eraseModel === true && settings) {
      yield* Console.log(`Would remove managed local AI model when safe: ${settings.modelPath}`);
    }
    return;
  }
  yield* runLocalAiStop(config, options);
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(configPath, {force: true});
  yield* fs.remove(yield* localAiTokenPath(config), {force: true});
  if (options.eraseModel === true && settings) {
    const managedDirectory = yield* localAiModelsDirectory(config);
    const pathService = yield* Path.Path;
    const relative = pathService.relative(managedDirectory, settings.modelPath);
    if (relative && !relative.startsWith('..') && !pathService.isAbsolute(relative)) {
      yield* fs.remove(settings.modelPath, {force: true});
      yield* Console.log(`Removed local AI model: ${settings.modelPath}`);
    } else {
      yield* Console.log(`Preserved external model path: ${settings.modelPath}`);
    }
  }
  yield* Console.log('Removed Threadnote local AI configuration.');
});

export const readLocalAiSettings = Effect.fn('localAi.readSettings')(function* (config: LocalAiRuntimeConfig) {
  const raw = yield* readFileIfExists(yield* localAiConfigPath(config));
  if (!raw) return undefined;
  return yield* Effect.try({
    try: () => parseLocalAiSettings(JSON.parse(raw)),
    catch: cause => new Error(`Invalid Threadnote local AI configuration: ${errorMessage(cause)}`, {cause}),
  });
});

export const listInstalledLocalAiModels = Effect.fn('localAi.listInstalledModels')(function* (
  config: LocalAiRuntimeConfig,
  configured?: LocalAiSettings,
) {
  const installed: InstalledLocalAiModel[] = [];
  for (const model of LOCAL_AI_MODELS) {
    const managedPath = yield* localAiManagedModelPath(config, model);
    const candidates =
      configured?.model === model.id ? Array.from(new Set([configured.modelPath, managedPath])) : [managedPath];
    for (const candidate of candidates) {
      if (yield* localAiModelFilePresent(model, candidate)) {
        installed.push({definition: model, path: candidate});
        break;
      }
    }
  }
  return installed;
});

export function parseLocalAiSettings(value: unknown): LocalAiSettings {
  if (
    !isJsonObject(value) ||
    value.version !== LOCAL_AI_CONFIG_VERSION ||
    typeof value.enabled !== 'boolean' ||
    value.host !== '127.0.0.1' ||
    typeof value.model !== 'string' ||
    value.model.trim().length === 0 ||
    typeof value.modelPath !== 'string' ||
    value.modelPath.trim().length === 0 ||
    !Number.isInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535
  ) {
    throw new Error(`${LOCAL_AI_CONFIG_FILE} has an unsupported shape.`);
  }
  return {
    enabled: value.enabled,
    host: '127.0.0.1',
    model: value.model,
    modelPath: value.modelPath,
    port: value.port as number,
    version: LOCAL_AI_CONFIG_VERSION,
  };
}

export function localAiApiUrl(settings: Pick<LocalAiSettings, 'host' | 'port'>): string {
  return `http://${settings.host}:${settings.port}/v1`;
}

const resolveLocalAiModel = Effect.fn('localAi.resolveModel')((requested: string | undefined) =>
  Effect.try({
    try: () => requireLocalAiModel(requested),
    catch: cause => new Error(errorMessage(cause), {cause}),
  }),
);

const configureLocalAiModel = Effect.fn('localAi.configureModel')(function* (
  config: RuntimeConfig,
  settings: LocalAiSettings,
  token: string,
  options: {readonly start: boolean},
) {
  yield* withLocalAiLifecycleLock(
    config,
    Effect.gen(function* () {
      const previous = yield* readLocalAiSettings(config);
      const switching =
        previous !== undefined && (previous.model !== settings.model || previous.modelPath !== settings.modelPath);
      if (switching) {
        const record = yield* readLocalAiProcessRecord(config);
        if (record) {
          yield* stopLocalAiProcess(config, record);
        }
      }
      yield* writeLocalAiSettings(config, settings);
      if (options.start) {
        yield* startLocalAiServerUnlocked(config, settings, token, {announce: true});
      }
    }),
  );
});

const startLocalAiServer = Effect.fn('localAi.startServer')(function* (
  config: LocalAiRuntimeConfig,
  options: {readonly announce: boolean},
) {
  return yield* withLocalAiLifecycleLock(
    config,
    Effect.gen(function* () {
      const settings = yield* readLocalAiSettings(config);
      if (!settings?.enabled) return false;
      const token = yield* requireLocalAiAccessToken(config);
      yield* startLocalAiServerUnlocked(config, settings, token, options);
      return true;
    }),
  );
});

const startLocalAiServerUnlocked = Effect.fn('localAi.startServerUnlocked')(function* (
  config: LocalAiRuntimeConfig,
  settings: LocalAiSettings,
  token: string,
  options: {readonly announce: boolean},
) {
  const healthy = yield* readLocalAiHealth(settings, token);
  if (healthy) {
    if (healthy.model !== settings.model) {
      return yield* Effect.fail(
        new Error(`Local AI endpoint is serving ${healthy.model}, but Threadnote is configured for ${settings.model}.`),
      );
    }
    if (options.announce) {
      yield* Console.log(`Local AI is already healthy at ${localAiApiUrl(settings)} (pid ${healthy.pid}).`);
    }
    return;
  }

  yield* assertLocalAiModelPresent(settings);
  const system = yield* SystemInfo;
  const existingRecord = yield* readLocalAiProcessRecord(config);
  if (existingRecord && system.isProcessRunning(existingRecord.pid)) {
    const recovered = yield* waitForLocalAiHealth(settings, token, LOCAL_AI_START_TIMEOUT_MILLISECONDS);
    if (
      recovered?.pid === existingRecord.pid &&
      recovered.launchId === existingRecord.launchId &&
      recovered.model === settings.model
    ) {
      return;
    }
    return yield* Effect.fail(
      new Error(
        `Recorded local AI process ${existingRecord.pid} is running but ownership could not be verified. ` +
          'Inspect it before removing the process record or stopping it manually.',
      ),
    );
  }
  if (existingRecord) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(yield* localAiPidPath(config), {force: true});
  }
  if (yield* isTcpPortOpen(settings.host, settings.port, 300)) {
    return yield* Effect.fail(
      new Error(
        `Port ${settings.host}:${settings.port} is in use by a service that is not Threadnote local AI. ` +
          'Stop it before running threadnote local-ai start.',
      ),
    );
  }

  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const python = yield* resolveOpenVikingPython();
  const script = pathService.join(yield* toolRoot(), 'scripts', LOCAL_AI_SERVER_SCRIPT);
  const tokenPath = yield* localAiTokenPath(config);
  const logPath = pathService.join(config.agentContextHome, 'logs', 'local-ai.log');
  const crypto = yield* Crypto.Crypto;
  const launchId = yield* crypto.randomUUIDv4;
  yield* ensureDirectory(pathService.dirname(logPath), false);
  yield* fs.writeFileString(logPath, '', {flag: 'a', mode: 0o600});
  const args = [
    script,
    '--host',
    settings.host,
    '--port',
    String(settings.port),
    '--model',
    settings.modelPath,
    '--model-id',
    settings.model,
    '--token-file',
    tokenPath,
    '--launch-id',
    launchId,
    '--log',
    logPath,
  ];
  const pid = yield* Effect.scoped(spawnDetachedLocalAi(python, args));
  const record: LocalAiProcessRecord = {
    launchId,
    modelPath: settings.modelPath,
    pid,
    startedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
    version: 1,
  };
  yield* fs.writeFileString(yield* localAiPidPath(config), `${JSON.stringify(record, null, 2)}\n`, {mode: 0o600});
  const started = yield* waitForLocalAiHealth(settings, token, LOCAL_AI_START_TIMEOUT_MILLISECONDS);
  if (!started) {
    yield* terminateLocalAiProcess(pid).pipe(Effect.ignore);
    yield* fs.remove(yield* localAiPidPath(config), {force: true});
    return yield* Effect.fail(
      new Error(
        `Local AI process ${pid} did not become healthy within ${LOCAL_AI_START_TIMEOUT_MILLISECONDS / 1000}s. ` +
          `Logs: ${logPath}`,
      ),
    );
  }
  if (started.pid !== pid || started.launchId !== launchId) {
    yield* terminateLocalAiProcess(pid).pipe(Effect.ignore);
    yield* fs.remove(yield* localAiPidPath(config), {force: true});
    return yield* Effect.fail(
      new Error(
        `Local AI endpoint changed ownership while process ${pid} was starting; refusing to record or stop pid ${started.pid}.`,
      ),
    );
  }
  if (options.announce) {
    yield* Console.log(`Started local AI with pid ${pid}. Endpoint: ${localAiApiUrl(settings)}. Logs: ${logPath}`);
  }
});

const spawnDetachedLocalAi = Effect.fn('localAi.spawnDetached')(function* (
  executable: string,
  args: readonly string[],
) {
  const child = yield* ChildProcess.make(executable, [...args], {
    detached: true,
    stderr: 'ignore',
    stdin: 'ignore',
    stdout: 'ignore',
  });
  yield* child.unref;
  return Number(child.pid);
});

const stopLocalAiProcess = Effect.fn('localAi.stopProcess')(function* (
  config: LocalAiRuntimeConfig,
  record: LocalAiProcessRecord,
) {
  const system = yield* SystemInfo;
  const fs = yield* FileSystem.FileSystem;
  const pidPath = yield* localAiPidPath(config);
  if (!system.isProcessRunning(record.pid)) {
    yield* fs.remove(pidPath, {force: true});
    yield* Console.log(`Removed stale local AI process record for ${record.pid}.`);
    return;
  }
  const settings = yield* readLocalAiSettings(config);
  const token = settings ? yield* requireLocalAiAccessToken(config) : undefined;
  const health = settings && token ? yield* readLocalAiHealth(settings, token) : undefined;
  if (!settings || !health || !localAiProcessOwnershipMatches(record, health, settings)) {
    return yield* Effect.fail(
      new Error(
        `Refusing to stop pid ${record.pid}: Threadnote could not verify the recorded local AI process. ` +
          'Inspect the process before stopping it manually or removing the stale process record.',
      ),
    );
  }
  yield* terminateLocalAiProcess(record.pid);
  const stopped = yield* waitForProcessExit(record.pid, LOCAL_AI_STOP_TIMEOUT_MILLISECONDS);
  if (!stopped) {
    return yield* Effect.fail(
      new Error(`Local AI process ${record.pid} did not stop within ${LOCAL_AI_STOP_TIMEOUT_MILLISECONDS / 1000}s.`),
    );
  }
  yield* fs.remove(pidPath, {force: true});
  yield* Console.log(`Stopped Threadnote local AI process ${record.pid}.`);
});

const terminateLocalAiProcess = Effect.fn('localAi.terminateProcess')(function* (pid: number) {
  const system = yield* SystemInfo;
  return yield* Effect.try({
    try: () => system.signalProcess(pid, 'SIGTERM'),
    catch: cause => new Error(`Could not stop local AI process ${pid}: ${errorMessage(cause)}`, {cause}),
  });
});

const waitForProcessExit = Effect.fn('localAi.waitForProcessExit')(function* (pid: number, timeoutMs: number) {
  const system = yield* SystemInfo;
  const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
  while ((yield* Clock.currentTimeMillis) < deadline) {
    if (!system.isProcessRunning(pid)) return true;
    yield* Effect.sleep(LOCAL_AI_POLL_MILLISECONDS);
  }
  return !system.isProcessRunning(pid);
});

const readLocalAiHealth = Effect.fn('localAi.readHealth')(function* (settings: LocalAiSettings, token: string) {
  const crypto = yield* Crypto.Crypto;
  const challenge = Encoding.encodeBase64Url(yield* crypto.randomBytes(24));
  const response = yield* getJsonEffect(
    `http://${settings.host}:${settings.port}/health?challenge=${encodeURIComponent(challenge)}`,
    {timeoutMs: 800},
  ).pipe(Effect.result);
  if (Result.isFailure(response)) return undefined;
  const body = response.success.body;
  if (
    !isJsonObject(body) ||
    body.status !== 'ok' ||
    body.service !== LOCAL_AI_SERVICE_ID ||
    typeof body.model !== 'string' ||
    typeof body.launchId !== 'string' ||
    typeof body.proof !== 'string' ||
    !Number.isInteger(body.pid) ||
    (body.pid as number) <= 0
  ) {
    return undefined;
  }
  const proof = yield* localAiHealthProof({
    challenge,
    launchId: body.launchId,
    model: body.model,
    pid: body.pid as number,
    token,
  });
  if (!constantTimeTextEqual(body.proof, proof)) {
    return undefined;
  }
  return {
    launchId: body.launchId,
    model: body.model,
    pid: body.pid as number,
    service: LOCAL_AI_SERVICE_ID,
    status: 'ok',
  } satisfies LocalAiHealth;
});

const waitForLocalAiHealth = Effect.fn('localAi.waitForHealth')(function* (
  settings: LocalAiSettings,
  token: string,
  timeoutMs: number,
) {
  const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
  while ((yield* Clock.currentTimeMillis) < deadline) {
    const health = yield* readLocalAiHealth(settings, token);
    if (health?.model === settings.model) return health;
    yield* Effect.sleep(LOCAL_AI_POLL_MILLISECONDS);
  }
  return undefined;
});

export function localAiProcessOwnershipMatches(
  record: Pick<LocalAiProcessRecord, 'launchId' | 'modelPath' | 'pid'>,
  health: Pick<LocalAiHealth, 'launchId' | 'model' | 'pid'> | undefined,
  settings: Pick<LocalAiSettings, 'model' | 'modelPath'>,
): boolean {
  return (
    health !== undefined &&
    record.pid === health.pid &&
    record.launchId === health.launchId &&
    record.modelPath === settings.modelPath &&
    health.model === settings.model
  );
}

export const localAiHealthProof = Effect.fn('localAi.healthProof')(function* (input: {
  readonly challenge: string;
  readonly launchId: string;
  readonly model: string;
  readonly pid: number;
  readonly token: string;
}) {
  return yield* sha256Hex(
    [input.challenge, LOCAL_AI_SERVICE_ID, input.model, String(input.pid), input.launchId, input.token].join('\u0000'),
  );
});

function constantTimeTextEqual(left: string, right: string): boolean {
  const maximumLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximumLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

const assertLocalAiModelPresent = Effect.fn('localAi.assertModelPresent')(function* (settings: LocalAiSettings) {
  const model = findLocalAiModel(settings.model);
  if (!model) {
    return yield* Effect.fail(new Error(`Configured local AI model is unsupported: ${settings.model}.`));
  }
  if (!(yield* localAiModelFilePresent(model, settings.modelPath))) {
    return yield* Effect.fail(
      new Error(
        `Configured local AI model is missing or has the wrong size: ${settings.modelPath}. ` +
          `Run threadnote local-ai install --model ${model.id} --force.`,
      ),
    );
  }
});

const localAiModelFilePresent = Effect.fn('localAi.modelFilePresent')(function* (
  model: LocalAiModelDefinition,
  modelPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(modelPath).pipe(Effect.catch(() => Effect.succeed(undefined)));
  return info?.type === 'File' && Number(info.size) === model.size;
});

const verifyLocalAiModel = Effect.fn('localAi.verifyModel')(function* (
  model: LocalAiModelDefinition,
  modelPath: string,
) {
  yield* assertLocalAiModelPresent({
    enabled: true,
    host: '127.0.0.1',
    model: model.id,
    modelPath,
    port: LOCAL_AI_DEFAULT_PORT,
    version: 1,
  });
  yield* Console.log(`Verifying ${model.id} SHA-256.`);
  const digest = yield* sha256File(modelPath);
  if (digest !== model.sha256) {
    return yield* Effect.fail(
      new Error(`Local AI model checksum mismatch for ${modelPath}. Expected ${model.sha256}, got ${digest}.`),
    );
  }
});

const sha256File = Effect.fn('localAi.sha256File')(function* (filePath: string) {
  const system = yield* SystemInfo;
  const command =
    system.platform === 'win32'
      ? yield* findHashCommand(['certutil'], executable => ({args: ['-hashfile', filePath, 'SHA256'], executable}))
      : yield* findHashCommand(['shasum'], executable => ({args: ['-a', '256', filePath], executable})).pipe(
          Effect.catch(() => findHashCommand(['sha256sum'], executable => ({args: [filePath], executable}))),
        );
  const result = yield* runCommandEffect(command.executable, command.args);
  for (const line of result.stdout.split(/\r?\n/)) {
    const firstToken = line.trim().split(/\s+/, 1)[0] ?? '';
    if (/^[a-f0-9]{64}$/i.test(firstToken)) return firstToken.toLowerCase();
    const compact = line.replace(/\s+/g, '');
    if (/^[a-f0-9]{64}$/i.test(compact)) return compact.toLowerCase();
  }
  return yield* Effect.fail(new Error(`Could not parse the SHA-256 output for ${filePath}.`));
});

const findHashCommand = Effect.fn('localAi.findHashCommand')(function* (
  candidates: readonly string[],
  build: (executable: string) => {readonly args: readonly string[]; readonly executable: string},
) {
  const executable = yield* findExecutable(candidates);
  if (!executable) {
    return yield* Effect.fail(new Error(`Could not find ${candidates.join(' or ')} to verify the local AI model.`));
  }
  return build(executable);
});

const localAiDownloadCommand = Effect.fn('localAi.downloadCommand')(function* (
  model: LocalAiModelDefinition,
  modelPath: string,
) {
  const pathService = yield* Path.Path;
  const python = yield* resolveOpenVikingPython();
  const binDirectory = pathService.dirname(python);
  const system = yield* SystemInfo;
  const hfName = system.platform === 'win32' ? 'hf.exe' : 'hf';
  const siblingHf = pathService.join(binDirectory, hfName);
  const fs = yield* FileSystem.FileSystem;
  const hf = (yield* fs.exists(siblingHf)) ? siblingHf : yield* findExecutable(['hf']);
  const commonArgs = [
    'download',
    model.repository,
    model.file,
    '--revision',
    model.revision,
    '--local-dir',
    pathService.dirname(modelPath),
  ];
  return hf
    ? {args: commonArgs, executable: hf}
    : {
        args: ['-m', 'huggingface_hub.commands.huggingface_cli', ...commonArgs],
        executable: python,
      };
});

const resolveOpenVikingPython = Effect.fn('localAi.resolveOpenVikingPython')(function* () {
  const ov = yield* findOpenVikingCli();
  if (!ov) {
    return yield* Effect.fail(
      new Error('OpenViking is required before installing local AI. Run threadnote install or threadnote repair.'),
    );
  }
  const python = yield* pythonRuntimeForToolExecutable(ov, 'openviking');
  if (python) return python;
  return yield* Effect.fail(new Error(`Could not resolve the Python runtime used by OpenViking from ${ov}.`));
});

const writeLocalAiSettings = Effect.fn('localAi.writeSettings')(function* (
  config: LocalAiRuntimeConfig,
  settings: LocalAiSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  const destination = yield* localAiConfigPath(config);
  yield* ensureDirectory(pathService.dirname(destination), false);
  const temporary = `${destination}.${system.processId}.tmp`;
  yield* fs.writeFileString(temporary, `${JSON.stringify(settings, null, 2)}\n`, {mode: 0o600});
  yield* fs.rename(temporary, destination);
});

export const readLocalAiAccessToken = Effect.fn('localAi.readAccessToken')(function* (config: LocalAiRuntimeConfig) {
  const tokenPath = yield* localAiTokenPath(config);
  const raw = yield* readFileIfExists(tokenPath);
  if (!raw) return undefined;
  const token = raw.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return yield* Effect.fail(new Error(`${LOCAL_AI_TOKEN_FILE} has an unsupported shape.`));
  }
  const system = yield* SystemInfo;
  if (system.platform !== 'win32') {
    const info = yield* (yield* FileSystem.FileSystem).stat(tokenPath);
    if ((info.mode & 0o077) !== 0) {
      return yield* Effect.fail(new Error(`${LOCAL_AI_TOKEN_FILE} must only be readable by its owner (mode 0600).`));
    }
  }
  return token;
});

const ensureLocalAiAccessToken = Effect.fn('localAi.ensureAccessToken')(function* (config: LocalAiRuntimeConfig) {
  const existing = yield* readLocalAiAccessToken(config);
  if (existing) return existing;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const tokenPath = yield* localAiTokenPath(config);
  yield* ensureDirectory(pathService.dirname(tokenPath), false);
  const crypto = yield* Crypto.Crypto;
  const token = Encoding.encodeBase64Url(yield* crypto.randomBytes(32));
  const stored = yield* fs.writeFileString(tokenPath, `${token}\n`, {flag: 'wx', mode: 0o600}).pipe(
    Effect.as(token),
    Effect.catch(() => requireLocalAiAccessToken(config)),
  );
  if ((yield* SystemInfo).platform !== 'win32') {
    yield* fs.chmod(tokenPath, 0o600);
  }
  return stored;
});

const requireLocalAiAccessToken = Effect.fn('localAi.requireAccessToken')(function* (config: LocalAiRuntimeConfig) {
  const token = yield* readLocalAiAccessToken(config);
  if (!token) {
    return yield* Effect.fail(new Error(`Local AI access token is missing. Run: threadnote local-ai install --force`));
  }
  return token;
});

const readLocalAiProcessRecord = Effect.fn('localAi.readProcessRecord')(function* (config: LocalAiRuntimeConfig) {
  const raw = yield* readFileIfExists(yield* localAiPidPath(config));
  if (!raw) return undefined;
  const parsed = yield* Effect.try({
    try: (): unknown => JSON.parse(raw),
    catch: cause => new Error(`Invalid ${LOCAL_AI_PID_FILE}: ${errorMessage(cause)}`, {cause}),
  });
  if (
    !isJsonObject(parsed) ||
    parsed.version !== 1 ||
    !Number.isInteger(parsed.pid) ||
    (parsed.pid as number) <= 0 ||
    typeof parsed.launchId !== 'string' ||
    parsed.launchId.length === 0 ||
    typeof parsed.modelPath !== 'string' ||
    typeof parsed.startedAt !== 'string'
  ) {
    return yield* Effect.fail(new Error(`${LOCAL_AI_PID_FILE} has an unsupported shape.`));
  }
  return {
    launchId: parsed.launchId,
    modelPath: parsed.modelPath,
    pid: parsed.pid as number,
    startedAt: parsed.startedAt,
    version: 1,
  } satisfies LocalAiProcessRecord;
});

const requireLocalAiSettings = Effect.fn('localAi.requireSettings')(function* (config: LocalAiRuntimeConfig) {
  const settings = yield* readLocalAiSettings(config);
  if (!settings) {
    return yield* Effect.fail(new Error('Local AI is not installed. Run: threadnote local-ai install'));
  }
  if (!settings.enabled) {
    return yield* Effect.fail(new Error('Local AI recall is disabled. Run: threadnote local-ai enable'));
  }
  return settings;
});

const localAiConfigPath = Effect.fn('localAi.configPath')(function* (config: LocalAiRuntimeConfig) {
  const pathService = yield* Path.Path;
  return pathService.join(config.agentContextHome, 'threadnote', LOCAL_AI_CONFIG_FILE);
});

const localAiTokenPath = Effect.fn('localAi.tokenPath')(function* (config: LocalAiRuntimeConfig) {
  const pathService = yield* Path.Path;
  return pathService.join(config.agentContextHome, 'threadnote', LOCAL_AI_TOKEN_FILE);
});

const localAiPidPath = Effect.fn('localAi.pidPath')(function* (config: LocalAiRuntimeConfig) {
  const pathService = yield* Path.Path;
  return pathService.join(config.agentContextHome, LOCAL_AI_PID_FILE);
});

const localAiLockPath = Effect.fn('localAi.lockPath')(function* (config: LocalAiRuntimeConfig) {
  const pathService = yield* Path.Path;
  return pathService.join(config.agentContextHome, LOCAL_AI_LOCK_FILE);
});

const localAiModelsDirectory = Effect.fn('localAi.modelsDirectory')(function* (config: LocalAiRuntimeConfig) {
  const pathService = yield* Path.Path;
  return pathService.join(config.agentContextHome, 'threadnote', 'models');
});

const localAiManagedModelPath = Effect.fn('localAi.managedModelPath')(function* (
  config: LocalAiRuntimeConfig,
  model: LocalAiModelDefinition = DEFAULT_LOCAL_AI_MODEL,
) {
  const pathService = yield* Path.Path;
  return pathService.join(yield* localAiModelsDirectory(config), model.file);
});

function formatModelSize(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function withLocalAiLifecycleLock<A, E, R>(config: LocalAiRuntimeConfig, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withExclusiveFileLock(
      fs,
      yield* localAiLockPath(config),
      {
        heartbeatIntervalMilliseconds: 10_000,
        retryIntervalMilliseconds: LOCAL_AI_POLL_MILLISECONDS,
        staleAfterMilliseconds: LOCAL_AI_LOCK_STALE_MILLISECONDS,
        waitTimeoutMilliseconds: LOCAL_AI_LOCK_WAIT_MILLISECONDS,
      },
      effect,
    );
  });
}
