import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import {Clock, Console, Crypto, Effect, Encoding, FileSystem, Path, Result} from 'effect';
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

export const LOCAL_AI_MODEL_ID = 'gemma-4-E4B-it-Q4_0';
export const LOCAL_AI_MODEL_FILE = 'gemma-4-E4B-it-Q4_0.gguf';
export const LOCAL_AI_MODEL_REPOSITORY = 'ggml-org/gemma-4-E4B-it-GGUF';
export const LOCAL_AI_MODEL_REVISION = '06f24bb269339b2a19a5167199b81e89ef813c10';
export const LOCAL_AI_MODEL_SHA256 = 'a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2';
export const LOCAL_AI_MODEL_SIZE = 4_590_807_392;
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
  readonly modelPath?: string;
  readonly start?: boolean;
}

export interface LocalAiLifecycleOptions {
  readonly dryRun?: boolean;
}

export interface LocalAiUninstallOptions extends LocalAiLifecycleOptions {
  readonly eraseModel?: boolean;
}

export const runLocalAiInstall = Effect.fn('localAi.install')(function* (
  config: RuntimeConfig,
  options: LocalAiInstallOptions,
) {
  const dryRun = options.dryRun === true;
  const pathService = yield* Path.Path;
  const managedModelPath = yield* localAiManagedModelPath(config);
  const modelPath = options.modelPath ? yield* expandPath(options.modelPath) : managedModelPath;
  const settings: LocalAiSettings = {
    enabled: true,
    host: '127.0.0.1',
    model: LOCAL_AI_MODEL_ID,
    modelPath,
    port: LOCAL_AI_DEFAULT_PORT,
    version: LOCAL_AI_CONFIG_VERSION,
  };
  const configPath = yield* localAiConfigPath(config);
  const tokenPath = yield* localAiTokenPath(config);

  if (dryRun) {
    if (!options.modelPath) {
      yield* Console.log(
        `Would download ${LOCAL_AI_MODEL_REPOSITORY}/${LOCAL_AI_MODEL_FILE} (${formatModelSize(LOCAL_AI_MODEL_SIZE)}) to ${modelPath}.`,
      );
    } else {
      yield* Console.log(`Would verify existing model: ${modelPath}`);
    }
    yield* Console.log(`Would verify SHA-256 ${LOCAL_AI_MODEL_SHA256}.`);
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
      verified = yield* verifyLocalAiModel(modelPath).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
    }
    if (!verified) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(modelPath, {force: true});
      yield* ensureDirectory(pathService.dirname(modelPath), false);
      const {args, executable} = yield* localAiDownloadCommand(modelPath);
      yield* Console.log(
        `Downloading ${LOCAL_AI_MODEL_ID} (${formatModelSize(LOCAL_AI_MODEL_SIZE)}). This is a one-time local download.`,
      );
      const download = yield* runStreamingCommandEffect(executable, args, {inheritOutput: true});
      if (download.exitCode !== 0) {
        return yield* Effect.fail(new Error(`Local AI model download exited with ${download.exitCode}.`));
      }
    }
  }

  if (!verified) {
    yield* verifyLocalAiModel(modelPath);
  }
  yield* ensureLocalAiAccessToken(config);
  yield* writeLocalAiSettings(config, settings);
  yield* Console.log(`Enabled local AI recall with ${LOCAL_AI_MODEL_ID}.`);
  yield* Console.log(`Configuration: ${configPath}`);
  if (options.start !== false) {
    yield* startLocalAiServer(config, {announce: true});
  }
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
  const fs = yield* FileSystem.FileSystem;
  const modelInfo = yield* fs.stat(settings.modelPath).pipe(Effect.catch(() => Effect.succeed(undefined)));
  yield* Console.log(`Local AI recall: ${settings.enabled ? 'enabled' : 'disabled'}`);
  yield* Console.log(`Model: ${settings.model}`);
  yield* Console.log(`Model file: ${settings.modelPath}`);
  yield* Console.log(
    `Model present: ${modelInfo?.type === 'File' && Number(modelInfo.size) === LOCAL_AI_MODEL_SIZE ? 'yes' : 'no'}`,
  );
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
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(settings.modelPath).pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (info?.type !== 'File' || Number(info.size) !== LOCAL_AI_MODEL_SIZE) {
    return yield* Effect.fail(
      new Error(
        `Configured local AI model is missing or has the wrong size: ${settings.modelPath}. ` +
          'Run threadnote local-ai install --force.',
      ),
    );
  }
});

const verifyLocalAiModel = Effect.fn('localAi.verifyModel')(function* (modelPath: string) {
  yield* assertLocalAiModelPresent({
    enabled: true,
    host: '127.0.0.1',
    model: LOCAL_AI_MODEL_ID,
    modelPath,
    port: LOCAL_AI_DEFAULT_PORT,
    version: 1,
  });
  yield* Console.log(`Verifying ${LOCAL_AI_MODEL_ID} SHA-256.`);
  const digest = yield* sha256File(modelPath);
  if (digest !== LOCAL_AI_MODEL_SHA256) {
    return yield* Effect.fail(
      new Error(`Local AI model checksum mismatch for ${modelPath}. Expected ${LOCAL_AI_MODEL_SHA256}, got ${digest}.`),
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

const localAiDownloadCommand = Effect.fn('localAi.downloadCommand')(function* (modelPath: string) {
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
    LOCAL_AI_MODEL_REPOSITORY,
    LOCAL_AI_MODEL_FILE,
    '--revision',
    LOCAL_AI_MODEL_REVISION,
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

const localAiManagedModelPath = Effect.fn('localAi.managedModelPath')(function* (config: LocalAiRuntimeConfig) {
  const pathService = yield* Path.Path;
  return pathService.join(yield* localAiModelsDirectory(config), LOCAL_AI_MODEL_FILE);
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
