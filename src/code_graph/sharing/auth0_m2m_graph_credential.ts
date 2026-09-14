import {createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey} from 'jose';

const MAX_INPUT_BYTES = 8192;
const MAX_RESPONSE_BYTES = 32768;
const MAX_TOKEN_BYTES = 16384;
// The graph listener enforces a 605-second JWT lifetime ceiling.
const MAX_TOKEN_LIFETIME_SECONDS = 600;
const CLOCK_TOLERANCE_SECONDS = 5;
const PROFILE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REPOSITORY_ID = /^[a-f0-9]{64}$/u;
const ORGANIZATION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/u;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const GRAPH_SCOPES = new Set(['graph:read', 'graph:contribute']);

export interface Auth0M2MGraphCredentialRequest {
  readonly audience: string;
  readonly coordinatorUrl: string;
  readonly interactive: false;
  readonly issuer: string;
  readonly organization: string;
  readonly profileDigest: string;
  readonly repositoryId: string;
  readonly schemaVersion: 1;
  readonly scopes: readonly ['graph:read' | 'graph:contribute'];
}

interface Auth0M2MGraphCredentialConfig {
  readonly audience: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly coordinatorUrl: string;
  readonly issuer: string;
  readonly organization: string;
  readonly profileDigest: string;
  readonly repositoryId: string;
  readonly scopes: ReadonlySet<string>;
  readonly subject: string;
}

export interface Auth0M2MTokenDependencies {
  readonly fetch: (url: URL, init: RequestInit) => Promise<Response>;
  readonly key: JWTVerifyGetKey;
  readonly now: () => number;
}

export interface Auth0M2MTokenAuthority {
  readonly allowedScopes?: ReadonlySet<string>;
  readonly audience: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly issuer: string;
  readonly scope: string;
  readonly subject: string;
}

export interface Auth0M2MHelperIO {
  readonly stdin: AsyncIterable<Uint8Array | string>;
  readonly writeStderr: (text: string) => void;
  readonly writeStdout: (text: string) => void;
}

/** No diagnostic or error from this boundary may contain the secret, token, or Auth0 response. */
function credentialFailure(): Error {
  return new Error('Auth0 graph credential unavailable.');
}

export function parseAuth0M2MGraphCredentialRequest(value: unknown): Auth0M2MGraphCredentialRequest {
  if (
    !isObjectWithKeys(value, [
      'audience',
      'coordinatorUrl',
      'interactive',
      'issuer',
      'organization',
      'profileDigest',
      'repositoryId',
      'schemaVersion',
      'scopes',
    ])
  )
    throw credentialFailure();
  if (
    typeof value.audience !== 'string' ||
    !canonicalHttpsUrl(value.audience) ||
    typeof value.coordinatorUrl !== 'string' ||
    !canonicalHttpsUrl(value.coordinatorUrl) ||
    typeof value.issuer !== 'string' ||
    !canonicalAuth0Issuer(value.issuer) ||
    typeof value.organization !== 'string' ||
    !ORGANIZATION.test(value.organization) ||
    typeof value.profileDigest !== 'string' ||
    !PROFILE_DIGEST.test(value.profileDigest) ||
    typeof value.repositoryId !== 'string' ||
    !REPOSITORY_ID.test(value.repositoryId) ||
    value.interactive !== false ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.scopes) ||
    value.scopes.length !== 1 ||
    !GRAPH_SCOPES.has(value.scopes[0])
  )
    throw credentialFailure();
  return value as unknown as Auth0M2MGraphCredentialRequest;
}

export function parseAuth0M2MGraphCredentialConfig(environment: NodeJS.ProcessEnv): Auth0M2MGraphCredentialConfig {
  const audience = environment.THREADNOTE_AUTH0_GRAPH_M2M_AUDIENCE;
  const clientId = environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_ID;
  const clientSecret = environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_SECRET;
  const coordinatorUrl = environment.THREADNOTE_AUTH0_GRAPH_M2M_COORDINATOR_URL;
  const issuer = environment.THREADNOTE_AUTH0_GRAPH_M2M_ISSUER;
  const organization = environment.THREADNOTE_AUTH0_GRAPH_M2M_ORGANIZATION;
  const profileDigest = environment.THREADNOTE_AUTH0_GRAPH_M2M_PROFILE_DIGEST;
  const repositoryId = environment.THREADNOTE_AUTH0_GRAPH_M2M_REPOSITORY_ID;
  const rawScopes = environment.THREADNOTE_AUTH0_GRAPH_M2M_SCOPES;
  const subject = environment.THREADNOTE_AUTH0_GRAPH_M2M_SUBJECT;
  const scopes = new Set(rawScopes?.split(' '));
  if (
    !audience ||
    !canonicalHttpsUrl(audience) ||
    !coordinatorUrl ||
    !canonicalHttpsUrl(coordinatorUrl) ||
    !issuer ||
    !canonicalAuth0Issuer(issuer) ||
    !organization ||
    !ORGANIZATION.test(organization) ||
    !profileDigest ||
    !PROFILE_DIGEST.test(profileDigest) ||
    !repositoryId ||
    !REPOSITORY_ID.test(repositoryId) ||
    !clientId ||
    !CLIENT_ID.test(clientId) ||
    !clientSecret ||
    clientSecret.length > 4096 ||
    !subject ||
    !validSubject(subject) ||
    !rawScopes ||
    [...scopes].some(scope => !GRAPH_SCOPES.has(scope)) ||
    scopes.size === 0 ||
    rawScopes !== [...scopes].join(' ')
  )
    throw credentialFailure();
  return {
    audience,
    clientId,
    clientSecret,
    coordinatorUrl,
    issuer,
    organization,
    profileDigest,
    repositoryId,
    scopes,
    subject,
  };
}

export async function getAuth0M2MGraphCredential(
  rawRequest: unknown,
  environment: NodeJS.ProcessEnv,
  dependencies?: Partial<Auth0M2MTokenDependencies>,
): Promise<{
  readonly accessToken: string;
  readonly audience: string;
  readonly expiresAt: number;
  readonly issuer: string;
  readonly schemaVersion: 1;
  readonly subject: string;
}> {
  const request = parseAuth0M2MGraphCredentialRequest(rawRequest);
  const config = parseAuth0M2MGraphCredentialConfig(environment);
  if (
    request.audience !== config.audience ||
    request.coordinatorUrl !== config.coordinatorUrl ||
    request.issuer !== config.issuer ||
    request.organization !== config.organization ||
    request.profileDigest !== config.profileDigest ||
    request.repositoryId !== config.repositoryId ||
    !config.scopes.has(request.scopes[0])
  )
    throw credentialFailure();

  const token = await requestVerifiedAuth0M2MToken(
    {...config, allowedScopes: config.scopes, scope: request.scopes[0]},
    dependencies,
  );
  return {
    accessToken: token.accessToken,
    audience: config.audience,
    expiresAt: token.expiresAt,
    issuer: config.issuer,
    schemaVersion: 1,
    subject: config.subject,
  };
}

/** Shared verifier for distinct control and registry M2M clients; callers own exact local binding checks. */
export async function requestVerifiedAuth0M2MToken(
  config: Auth0M2MTokenAuthority,
  dependencies?: Partial<Auth0M2MTokenDependencies>,
): Promise<{readonly accessToken: string; readonly expiresAt: number}> {
  const fetch_ = dependencies?.fetch ?? fetch;
  const now = dependencies?.now ?? Date.now;
  const key =
    dependencies?.key ??
    createRemoteJWKSet(new URL('.well-known/jwks.json', config.issuer), {
      cacheMaxAge: 5 * 60_000,
      timeoutDuration: 3000,
    });
  const startedAt = Math.floor(now() / 1000);
  try {
    const response = await fetch_(new URL('oauth/token', config.issuer), {
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        audience: config.audience,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'client_credentials',
        scope: config.scope,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 200) throw credentialFailure();
    const body = parseTokenResponse(await boundedResponse(response, MAX_RESPONSE_BYTES));
    if (
      body.token_type.toLowerCase() !== 'bearer' ||
      body.expires_in < 1 ||
      body.expires_in > MAX_TOKEN_LIFETIME_SECONDS
    )
      throw credentialFailure();
    const {payload} = await jwtVerify(body.access_token, key, {
      algorithms: ['RS256'],
      audience: config.audience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      issuer: config.issuer,
      requiredClaims: ['sub', 'iat', 'exp'],
    });
    const receivedAt = Math.floor(now() / 1000);
    validateClaims(payload, config, startedAt, receivedAt, body.expires_in);
    if (body.scope !== undefined && !hasMatchingAuthorizedScopes(body.scope, payload.scope, config))
      throw credentialFailure();
    return {
      accessToken: body.access_token,
      expiresAt: payload.exp!,
    };
  } catch {
    throw credentialFailure();
  }
}

function parseTokenResponse(value: string): {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw credentialFailure();
  }
  if (
    !isObjectWithKeys(parsed, ['access_token', 'expires_in', 'token_type']) &&
    !isObjectWithKeys(parsed, ['access_token', 'expires_in', 'scope', 'token_type'])
  )
    throw credentialFailure();
  if (
    typeof parsed.access_token !== 'string' ||
    parsed.access_token.length > MAX_TOKEN_BYTES ||
    !BEARER_TOKEN.test(parsed.access_token) ||
    typeof parsed.expires_in !== 'number' ||
    !Number.isSafeInteger(parsed.expires_in) ||
    typeof parsed.token_type !== 'string' ||
    (parsed.scope !== undefined && (typeof parsed.scope !== 'string' || parsed.scope.length > 512))
  )
    throw credentialFailure();
  return parsed as {access_token: string; expires_in: number; scope?: string; token_type: string};
}

function validateClaims(
  payload: JWTPayload,
  config: Auth0M2MTokenAuthority,
  startedAt: number,
  receivedAt: number,
  expiresIn: number,
): void {
  const audience = payload.aud;
  const client = payload.azp ?? payload.client_id;
  const issuedAt = payload.iat;
  const expiresAt = payload.exp;
  const notBefore = payload.nbf ?? issuedAt;
  if (
    payload.iss !== config.issuer ||
    payload.sub !== config.subject ||
    client !== config.clientId ||
    (typeof audience !== 'string'
      ? !Array.isArray(audience) || audience.length !== 1 || audience[0] !== config.audience
      : audience !== config.audience) ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(notBefore) ||
    issuedAt! > receivedAt + CLOCK_TOLERANCE_SECONDS ||
    notBefore! > receivedAt + CLOCK_TOLERANCE_SECONDS ||
    issuedAt! < startedAt - CLOCK_TOLERANCE_SECONDS ||
    expiresAt! <= receivedAt + 30 ||
    expiresAt! - issuedAt! > MAX_TOKEN_LIFETIME_SECONDS ||
    expiresAt! <= issuedAt! ||
    Math.abs(expiresAt! - startedAt - expiresIn) > CLOCK_TOLERANCE_SECONDS + (receivedAt - startedAt) ||
    !hasAuthorizedScopes(payload.scope, config.scope, config.allowedScopes) ||
    (payload.gty !== undefined && payload.gty !== 'client-credentials')
  )
    throw credentialFailure();
}

function hasAuthorizedScopes(claim: unknown, requested: string, configured: ReadonlySet<string> | undefined): boolean {
  if (typeof claim !== 'string') return false;
  const granted = claim.split(' ');
  const allowed = configured ?? new Set([requested]);
  return (
    granted.length > 0 &&
    granted.length <= allowed.size &&
    new Set(granted).size === granted.length &&
    granted.includes(requested) &&
    granted.every(scope => allowed.has(scope))
  );
}

function hasMatchingAuthorizedScopes(response: string, token: unknown, config: Auth0M2MTokenAuthority): boolean {
  if (!hasAuthorizedScopes(response, config.scope, config.allowedScopes) || typeof token !== 'string') return false;
  const responseScopes = response.split(' ');
  const tokenScopes = new Set(token.split(' '));
  return responseScopes.length === tokenScopes.size && responseScopes.every(scope => tokenScopes.has(scope));
}

async function boundedResponse(response: Response, limit: number): Promise<string> {
  if (!response.body) throw credentialFailure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw credentialFailure();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}

function isObjectWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
  );
}

function validSubject(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    [...value].every(character => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127)
  );
}

function canonicalHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      (url.href === value || (url.pathname === '/' && url.origin === value)) &&
      value.length <= 512
    );
  } catch {
    return false;
  }
}

function canonicalAuth0Issuer(value: string): boolean {
  if (!canonicalHttpsUrl(value)) return false;
  const url = new URL(value);
  return url.pathname === '/' && url.href === value;
}

/** Hidden standalone entrypoint used only through the managed credential helper launcher. */
export async function runAuth0M2MGraphCredentialHelper(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: Auth0M2MHelperIO,
): Promise<number> {
  try {
    if (arguments_.length !== 1 || arguments_[0] !== 'get') throw credentialFailure();
    let length = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of io.stdin) {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
      length += bytes.length;
      if (length > MAX_INPUT_BYTES) throw credentialFailure();
      chunks.push(bytes);
    }
    const input = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      input.set(chunk, offset);
      offset += chunk.length;
    }
    const request = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(input)) as unknown;
    io.writeStdout(`${JSON.stringify(await getAuth0M2MGraphCredential(request, environment))}\n`);
    return 0;
  } catch {
    io.writeStderr('Auth0 graph credential unavailable.\n');
    return 1;
  }
}
