import {remoteMemoryError} from './errors.js';

export interface RemoteMemoryServiceConfig {
  readonly accessTokenAudience: string;
  readonly accessTokenIssuer: string;
  readonly accessTokenJwksUrl: URL;
  readonly autoMigrate: boolean;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly attestationAudience: string;
  readonly cursorIssuer: string;
  readonly cursorJwksUrl: URL;
  readonly databaseUrl: string;
  readonly host: string;
  readonly globallyEnabled: boolean;
  readonly maxBodyBytes: number;
  readonly port: number;
  readonly publicBaseUrl: URL;
  readonly readRequestsPerMinute: number;
  readonly requestTimeoutMilliseconds: number;
  readonly writeRequestsPerMinute: number;
}

export function remoteMemoryConfigFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): RemoteMemoryServiceConfig {
  const publicBaseUrl = httpsUrl(required(environment, 'THREADNOTE_REMOTE_PUBLIC_URL'), 'THREADNOTE_REMOTE_PUBLIC_URL');
  if (publicBaseUrl.pathname !== '/' || publicBaseUrl.search || publicBaseUrl.hash) {
    throw remoteMemoryError('invalid_request', 'THREADNOTE_REMOTE_PUBLIC_URL must be an origin without a path.');
  }
  const accessTokenIssuer = issuerValue(
    httpsUrl(required(environment, 'THREADNOTE_REMOTE_OAUTH_ISSUER'), 'THREADNOTE_REMOTE_OAUTH_ISSUER'),
  );
  const cursorIssuer = issuerValue(
    httpsUrl(
      environment.THREADNOTE_REMOTE_CURSOR_ISSUER?.trim() || 'https://api.cursor.com',
      'THREADNOTE_REMOTE_CURSOR_ISSUER',
    ),
  );
  const databaseUrl = databaseConnectionUrl(required(environment, 'THREADNOTE_REMOTE_DATABASE_URL'));
  const localService = publicBaseUrl.hostname === 'localhost' || publicBaseUrl.hostname === '127.0.0.1';
  const autoMigrate = booleanValue(environment.THREADNOTE_REMOTE_AUTO_MIGRATE, localService);
  if (autoMigrate && !localService) {
    throw remoteMemoryError(
      'invalid_request',
      'THREADNOTE_REMOTE_AUTO_MIGRATE is only allowed for localhost development.',
    );
  }
  const allowedHosts = csv(environment.THREADNOTE_REMOTE_ALLOWED_HOSTS, [publicBaseUrl.host]).map(validateHostValue);
  const allowedOrigins = csv(environment.THREADNOTE_REMOTE_ALLOWED_ORIGINS, ['https://cursor.com']).map(
    validateOriginValue,
  );
  const accessTokenAudience = audienceValue(
    environment.THREADNOTE_REMOTE_OAUTH_AUDIENCE?.trim() || new URL('/mcp', publicBaseUrl).toString(),
    'THREADNOTE_REMOTE_OAUTH_AUDIENCE',
  );
  const attestationAudience = audienceValue(
    environment.THREADNOTE_REMOTE_CURSOR_AUDIENCE?.trim() || new URL('/attest/cursor', publicBaseUrl).toString(),
    'THREADNOTE_REMOTE_CURSOR_AUDIENCE',
  );
  if (accessTokenAudience !== new URL('/mcp', publicBaseUrl).toString()) {
    throw remoteMemoryError('invalid_request', 'THREADNOTE_REMOTE_OAUTH_AUDIENCE must equal the public MCP URL.');
  }
  if (attestationAudience !== new URL('/attest/cursor', publicBaseUrl).toString()) {
    throw remoteMemoryError(
      'invalid_request',
      'THREADNOTE_REMOTE_CURSOR_AUDIENCE must equal the public Cursor attestation audience.',
    );
  }
  const accessTokenJwksUrl = httpsUrl(
    environment.THREADNOTE_REMOTE_OAUTH_JWKS_URL?.trim() ||
      new URL('/.well-known/jwks.json', `${accessTokenIssuer.replace(/\/$/, '')}/`).toString(),
    'THREADNOTE_REMOTE_OAUTH_JWKS_URL',
  );
  const cursorJwksUrl = httpsUrl(
    environment.THREADNOTE_REMOTE_CURSOR_JWKS_URL?.trim() ||
      (cursorIssuer === 'https://api.cursor.com'
        ? 'https://api.cursor.com/keys'
        : new URL('/.well-known/jwks.json', `${cursorIssuer.replace(/\/$/, '')}/`).toString()),
    'THREADNOTE_REMOTE_CURSOR_JWKS_URL',
  );
  if (accessTokenJwksUrl.origin !== new URL(accessTokenIssuer).origin) {
    throw remoteMemoryError('invalid_request', 'The OAuth JWKS URL must use the configured issuer origin.');
  }
  if (cursorJwksUrl.origin !== new URL(cursorIssuer).origin) {
    throw remoteMemoryError('invalid_request', 'The Cursor JWKS URL must use the configured Cursor issuer origin.');
  }
  if (cursorIssuer === 'https://api.cursor.com' && cursorJwksUrl.toString() !== 'https://api.cursor.com/keys') {
    throw remoteMemoryError('invalid_request', "The Cursor JWKS URL must use Cursor's published /keys endpoint.");
  }
  return {
    accessTokenAudience,
    accessTokenIssuer,
    accessTokenJwksUrl,
    autoMigrate,
    allowedHosts,
    allowedOrigins,
    attestationAudience,
    cursorIssuer,
    cursorJwksUrl,
    databaseUrl,
    globallyEnabled: booleanValue(environment.THREADNOTE_REMOTE_ENABLED, false),
    host: environment.THREADNOTE_REMOTE_HOST?.trim() || '127.0.0.1',
    maxBodyBytes: boundedInteger(environment.THREADNOTE_REMOTE_MAX_BODY_BYTES, 256 * 1024, 1024, 1024 * 1024),
    port: boundedInteger(environment.THREADNOTE_REMOTE_PORT, 8787, 1, 65_535),
    publicBaseUrl,
    readRequestsPerMinute: boundedInteger(environment.THREADNOTE_REMOTE_READ_REQUESTS_PER_MINUTE, 300, 1, 100_000),
    requestTimeoutMilliseconds: boundedInteger(environment.THREADNOTE_REMOTE_REQUEST_TIMEOUT_MS, 10_000, 100, 120_000),
    writeRequestsPerMinute: boundedInteger(environment.THREADNOTE_REMOTE_WRITE_REQUESTS_PER_MINUTE, 60, 1, 100_000),
  };
}

export function redactedRemoteMemoryConfig(config: RemoteMemoryServiceConfig): Readonly<Record<string, unknown>> {
  return {
    accessTokenAudience: config.accessTokenAudience,
    accessTokenIssuer: config.accessTokenIssuer,
    autoMigrate: config.autoMigrate,
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
    attestationAudience: config.attestationAudience,
    cursorIssuer: config.cursorIssuer,
    globallyEnabled: config.globallyEnabled,
    host: config.host,
    maxBodyBytes: config.maxBodyBytes,
    port: config.port,
    publicBaseUrl: config.publicBaseUrl.toString(),
    readRequestsPerMinute: config.readRequestsPerMinute,
    requestTimeoutMilliseconds: config.requestTimeoutMilliseconds,
    writeRequestsPerMinute: config.writeRequestsPerMinute,
  };
}

function required(environment: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw remoteMemoryError('invalid_request', `${key} is required.`);
  return value;
}

function httpsUrl(value: string, key: string): URL {
  const url = configuredUrl(value, undefined, key);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw remoteMemoryError('invalid_request', `${key} must use HTTPS outside localhost.`);
  }
  if (url.username || url.password || url.hash) {
    throw remoteMemoryError('invalid_request', `${key} must be credential-free and cannot contain a fragment.`);
  }
  return url;
}

function audienceValue(value: string, key: string): string {
  const url = httpsUrl(value, key);
  if (url.search || url.hash) throw remoteMemoryError('invalid_request', `${key} cannot contain a query or fragment.`);
  return url.toString();
}

function databaseConnectionUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw remoteMemoryError('invalid_request', 'THREADNOTE_REMOTE_DATABASE_URL must be an absolute PostgreSQL URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw remoteMemoryError('invalid_request', 'THREADNOTE_REMOTE_DATABASE_URL must use PostgreSQL.');
  }
  const localDatabase =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === 'remote-memory-db';
  const sslMode = url.searchParams.get('sslmode');
  if (!localDatabase && sslMode !== 'verify-full') {
    throw remoteMemoryError(
      'invalid_request',
      'THREADNOTE_REMOTE_DATABASE_URL must use sslmode=verify-full outside a local database network.',
    );
  }
  return value;
}

function issuerValue(url: URL): string {
  if (url.search || url.hash)
    throw remoteMemoryError('invalid_request', 'Issuer URLs cannot contain a query or fragment.');
  return url.toString().replace(/\/$/u, '');
}

function configuredUrl(value: string | undefined, fallback: URL | undefined, key: string): URL {
  if (!value?.trim()) {
    if (fallback) return fallback;
    throw remoteMemoryError('invalid_request', `${key} is required.`);
  }
  try {
    return new URL(value);
  } catch (cause) {
    throw remoteMemoryError('invalid_request', `${key} must be an absolute URL.`, {
      cause: cause instanceof Error ? cause.name : 'invalid URL',
    });
  }
}

function csv(value: string | undefined, fallback: readonly string[]): readonly string[] {
  const values = value
    ?.split(',')
    .map(item => item.trim())
    .filter(Boolean);
  return values && values.length > 0 ? [...new Set(values)] : fallback;
}

function validateHostValue(value: string): string {
  const normalized = value.toLowerCase();
  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch {
    throw remoteMemoryError('invalid_request', 'Allowed Host entries must be exact host[:port] values.');
  }
  const labels = parsed.hostname.startsWith('[') ? [] : parsed.hostname.split('.');
  if (
    parsed.host !== normalized ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    labels.some(label => !label || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  ) {
    throw remoteMemoryError('invalid_request', 'Allowed Host entries must be exact host[:port] values.');
  }
  return parsed.host;
}

function validateOriginValue(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw remoteMemoryError('invalid_request', 'Allowed Origin entries must be absolute origins.');
  }
  if (url.protocol !== 'https:' || url.origin !== value.replace(/\/$/u, '') || url.username || url.password) {
    throw remoteMemoryError('invalid_request', 'Allowed Origin entries must be credential-free HTTPS origins.');
  }
  return url.origin;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw remoteMemoryError('invalid_request', `Expected an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw remoteMemoryError('invalid_request', 'Expected true or false.');
}
