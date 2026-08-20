import {Crypto, Effect, Encoding, FileSystem, Option, Path, Result} from 'effect';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {SystemInfo} from '../effect/system.js';
import type {RuntimeConfig} from '../types.js';
import {isJsonObject} from '../utils.js';

export const TELEMETRY_CONFIGURATION_VERSION = 1 as const;
export const TELEMETRY_CONSENT_VERSION = 4 as const;
export const DEFAULT_TELEMETRY_ENDPOINT = 'https://telemetry.threadnote.io/v1/traces';

export interface DisabledTelemetryConfiguration {
  readonly consentVersion: typeof TELEMETRY_CONSENT_VERSION;
  readonly enabled: false;
  readonly version: typeof TELEMETRY_CONFIGURATION_VERSION;
}

export interface EnabledTelemetryConfiguration {
  readonly consentVersion: typeof TELEMETRY_CONSENT_VERSION;
  readonly enabled: true;
  readonly endpoint: string;
  /** Local HMAC key for provider session pseudonyms. Never exported. */
  readonly sessionSalt: string;
  readonly version: typeof TELEMETRY_CONFIGURATION_VERSION;
}

export type TelemetryConfiguration = DisabledTelemetryConfiguration | EnabledTelemetryConfiguration;

export type TelemetryEnvironmentOptOut = 'DNT' | 'DO_NOT_TRACK' | 'THREADNOTE_TELEMETRY';

export class TelemetryConfigurationError extends Error {
  readonly _tag = 'TelemetryConfigurationError' as const;
}

const TELEMETRY_DIRECTORY_NAME = 'telemetry';
const TELEMETRY_CONFIGURATION_FILE_NAME = 'config.json';
const TELEMETRY_CONFIGURATION_MAX_BYTES = 16 * 1024;
const TELEMETRY_ENDPOINT_MAX_CHARACTERS = 2_048;
const TELEMETRY_SESSION_SALT_BYTES = 32;
const TELEMETRY_DIRECTORY_MODE = 0o700;
const TELEMETRY_CONFIGURATION_FILE_MODE = 0o600;
const TELEMETRY_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 2_000,
} as const;

export const telemetryConfigurationPath = Effect.fn('telemetry.configurationPath')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, TELEMETRY_DIRECTORY_NAME, TELEMETRY_CONFIGURATION_FILE_NAME);
});

export const readTelemetryConfiguration = Effect.fn('telemetry.readConfiguration')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* telemetryConfigurationPath(config);
  if (!(yield* fs.exists(file))) return undefined;
  yield* assertRegularTelemetryDirectory(fs, path.dirname(file));
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
    return yield* Effect.fail(new TelemetryConfigurationError('Telemetry configuration must not be a symbolic link.'));
  }
  const info = yield* fs.stat(file);
  if (info.type !== 'File' || Number(info.size) > TELEMETRY_CONFIGURATION_MAX_BYTES) {
    return yield* Effect.fail(
      new TelemetryConfigurationError('Telemetry configuration must be a bounded regular file.'),
    );
  }
  const raw = yield* fs.readFileString(file);
  return yield* Effect.try({
    try: () => parseTelemetryConfiguration(raw, file),
    catch: cause =>
      cause instanceof TelemetryConfigurationError
        ? cause
        : new TelemetryConfigurationError('Telemetry configuration could not be parsed.', {cause}),
  });
});

/** Invalid, unreadable, absent, disabled, or environment-suppressed consent always resolves to off. */
export const resolveTelemetryConfiguration = Effect.fn('telemetry.resolveConfiguration')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const system = yield* SystemInfo;
  if (telemetryEnvironmentOptOut(system.environment()) !== undefined) return undefined;
  return yield* readTelemetryConfiguration(config).pipe(
    Effect.map(value => (value?.enabled === true ? value : undefined)),
    Effect.catch(() => Effect.succeed(undefined)),
  );
});

export const writeTelemetryConfiguration = Effect.fn('telemetry.writeConfiguration')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  value: TelemetryConfiguration,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* telemetryConfigurationPath(config);
  const directory = path.dirname(file);
  const serialized = renderTelemetryConfiguration(value);
  yield* prepareTelemetryDirectory(fs, directory);
  yield* withExclusiveFileLock(
    fs,
    `${file}.lock`,
    TELEMETRY_LOCK_OPTIONS,
    Effect.gen(function* () {
      yield* assertRegularTelemetryDirectory(fs, directory);
      if ((yield* fs.exists(file)) && Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
        return yield* Effect.fail(
          new TelemetryConfigurationError('Telemetry configuration must not be a symbolic link.'),
        );
      }
      const temporary = path.join(directory, `.config.${yield* crypto.randomUUIDv4}.tmp`);
      yield* fs.writeFileString(temporary, serialized, {mode: TELEMETRY_CONFIGURATION_FILE_MODE});
      yield* fs
        .rename(temporary, file)
        .pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.catch(() => Effect.void))));
      yield* fs.chmod(file, TELEMETRY_CONFIGURATION_FILE_MODE);
      yield* fs.chmod(directory, TELEMETRY_DIRECTORY_MODE);
    }),
  );
  return file;
});

export const createEnabledTelemetryConfiguration = Effect.fn('telemetry.createEnabledConfiguration')(function* (
  endpoint = DEFAULT_TELEMETRY_ENDPOINT,
) {
  const crypto = yield* Crypto.Crypto;
  return enabledTelemetryConfiguration(
    endpoint,
    Encoding.encodeBase64Url(yield* crypto.randomBytes(TELEMETRY_SESSION_SALT_BYTES)),
  );
});

export function enabledTelemetryConfiguration(endpoint: string, sessionSalt: string): EnabledTelemetryConfiguration {
  return {
    consentVersion: TELEMETRY_CONSENT_VERSION,
    enabled: true,
    endpoint: normalizeTelemetryEndpoint(endpoint),
    sessionSalt: normalizeTelemetrySessionSalt(sessionSalt),
    version: TELEMETRY_CONFIGURATION_VERSION,
  };
}

export function disabledTelemetryConfiguration(): DisabledTelemetryConfiguration {
  return {
    consentVersion: TELEMETRY_CONSENT_VERSION,
    enabled: false,
    version: TELEMETRY_CONFIGURATION_VERSION,
  };
}

export function parseTelemetryConfiguration(
  raw: string,
  source = TELEMETRY_CONFIGURATION_FILE_NAME,
): TelemetryConfiguration {
  try {
    return parseTelemetryConfigurationValue(JSON.parse(raw) as unknown, source);
  } catch (cause) {
    if (cause instanceof TelemetryConfigurationError) throw cause;
    throw new TelemetryConfigurationError(`Telemetry configuration is not valid JSON: ${source}`, {cause});
  }
}

export function renderTelemetryConfiguration(value: TelemetryConfiguration): string {
  const parsed = parseTelemetryConfigurationValue(value, TELEMETRY_CONFIGURATION_FILE_NAME);
  return `${JSON.stringify(parsed, undefined, 2)}\n`;
}

export function normalizeTelemetryEndpoint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > TELEMETRY_ENDPOINT_MAX_CHARACTERS) {
    throw new TelemetryConfigurationError('Telemetry endpoint must be a non-empty bounded URL.');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(trimmed);
  } catch (cause) {
    throw new TelemetryConfigurationError('Telemetry endpoint must be an absolute URL.', {cause});
  }
  if (endpoint.username || endpoint.password) {
    throw new TelemetryConfigurationError('Telemetry endpoint must not contain credentials.');
  }
  if (endpoint.search || endpoint.hash) {
    throw new TelemetryConfigurationError('Telemetry endpoint must not contain a query string or fragment.');
  }
  const loopback = isLoopbackHostname(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    throw new TelemetryConfigurationError('Telemetry endpoint must use HTTPS, except for a loopback HTTP collector.');
  }
  return endpoint.toString();
}

export function normalizeTelemetrySessionSalt(value: string): string {
  const decoded = Encoding.decodeBase64Url(value);
  if (
    !Result.isSuccess(decoded) ||
    decoded.success.byteLength !== TELEMETRY_SESSION_SALT_BYTES ||
    Encoding.encodeBase64Url(decoded.success) !== value
  ) {
    throw new TelemetryConfigurationError('Telemetry session salt must be canonical base64url for 32 random bytes.');
  }
  return value;
}

export function telemetryEnvironmentOptOut(
  environment: Readonly<Record<string, string | undefined>>,
): TelemetryEnvironmentOptOut | undefined {
  if (environmentOptOutEnabled(environment.DO_NOT_TRACK)) return 'DO_NOT_TRACK';
  if (environmentOptOutEnabled(environment.DNT)) return 'DNT';
  if (threadnoteTelemetryDisabled(environment.THREADNOTE_TELEMETRY)) return 'THREADNOTE_TELEMETRY';
  return undefined;
}

function parseTelemetryConfigurationValue(value: unknown, source: string): TelemetryConfiguration {
  if (!isJsonObject(value)) {
    throw new TelemetryConfigurationError(`Telemetry configuration must be an object: ${source}`);
  }
  if (value.version !== TELEMETRY_CONFIGURATION_VERSION) {
    throw new TelemetryConfigurationError(
      `Unsupported telemetry configuration version in ${source}. Expected ${TELEMETRY_CONFIGURATION_VERSION}.`,
    );
  }
  if (value.consentVersion !== TELEMETRY_CONSENT_VERSION) {
    throw new TelemetryConfigurationError(
      `Unsupported telemetry consent version in ${source}. Expected ${TELEMETRY_CONSENT_VERSION}.`,
    );
  }
  if (value.enabled === false) {
    assertExactKeys(value, ['consentVersion', 'enabled', 'version'], source);
    return disabledTelemetryConfiguration();
  }
  if (value.enabled === true) {
    assertExactKeys(value, ['consentVersion', 'enabled', 'endpoint', 'sessionSalt', 'version'], source);
    if (typeof value.endpoint !== 'string' || typeof value.sessionSalt !== 'string') {
      throw new TelemetryConfigurationError(
        `Enabled telemetry configuration requires an endpoint and local session salt: ${source}`,
      );
    }
    return enabledTelemetryConfiguration(value.endpoint, value.sessionSalt);
  }
  throw new TelemetryConfigurationError(`Telemetry configuration requires a boolean enabled field: ${source}`);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], source: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new TelemetryConfigurationError(`Telemetry configuration contains unsupported fields: ${source}`);
  }
}

function environmentOptOutEnabled(value: string | undefined): boolean {
  return value !== undefined && ['1', 'on', 'true', 'yes'].includes(value.trim().toLowerCase());
}

function threadnoteTelemetryDisabled(value: string | undefined): boolean {
  return value !== undefined && ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '');
  return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}

function prepareTelemetryDirectory(fs: FileSystem.FileSystem, directory: string) {
  return Effect.gen(function* () {
    if ((yield* fs.exists(directory)) && Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) {
      return yield* Effect.fail(new TelemetryConfigurationError('Telemetry directory must not be a symbolic link.'));
    }
    yield* fs.makeDirectory(directory, {mode: TELEMETRY_DIRECTORY_MODE, recursive: true});
    yield* assertRegularTelemetryDirectory(fs, directory);
    yield* fs.chmod(directory, TELEMETRY_DIRECTORY_MODE);
  });
}

function assertRegularTelemetryDirectory(fs: FileSystem.FileSystem, directory: string) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) {
      return yield* Effect.fail(new TelemetryConfigurationError('Telemetry directory must not be a symbolic link.'));
    }
    const info = yield* fs.stat(directory);
    if (info.type !== 'Directory') {
      return yield* Effect.fail(new TelemetryConfigurationError('Telemetry directory must be a regular directory.'));
    }
  });
}
