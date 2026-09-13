import {
  requestVerifiedAuth0M2MToken,
  type Auth0M2MHelperIO,
  type Auth0M2MTokenDependencies,
} from './auth0_m2m_graph_credential.js';

const MAX_INPUT_BYTES = 512;
const SERVER = /^[a-z0-9.-]+(?::[1-9][0-9]{0,4})?$/u;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const SCOPE = 'registry:worker';

export interface Auth0M2MRegistryCredentialConfig {
  readonly audience: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly issuer: string;
  readonly origin: string;
  readonly subject: string;
}

function credentialFailure(): Error {
  return new Error('Auth0 registry credential unavailable.');
}

export function parseAuth0M2MRegistryCredentialConfig(
  environment: NodeJS.ProcessEnv,
): Auth0M2MRegistryCredentialConfig {
  const audience = environment.THREADNOTE_AUTH0_REGISTRY_M2M_AUDIENCE;
  const clientId = environment.THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_ID;
  const clientSecret = environment.THREADNOTE_AUTH0_REGISTRY_M2M_CLIENT_SECRET;
  const issuer = environment.THREADNOTE_AUTH0_REGISTRY_M2M_ISSUER;
  const origin = environment.THREADNOTE_AUTH0_REGISTRY_M2M_ORIGIN;
  const subject = environment.THREADNOTE_AUTH0_REGISTRY_M2M_SUBJECT;
  if (
    !origin ||
    !canonicalOrigin(origin) ||
    audience !== origin ||
    !issuer ||
    !canonicalIssuer(issuer) ||
    !clientId ||
    !CLIENT_ID.test(clientId) ||
    !clientSecret ||
    clientSecret.length > 4096 ||
    !subject ||
    !validSubject(subject) ||
    (environment.THREADNOTE_AUTH0_GRAPH_M2M_AUDIENCE !== undefined &&
      audience === environment.THREADNOTE_AUTH0_GRAPH_M2M_AUDIENCE) ||
    (environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_ID !== undefined &&
      clientId === environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_ID) ||
    (environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_SECRET !== undefined &&
      clientSecret === environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_SECRET)
  )
    throw credentialFailure();
  return {audience, clientId, clientSecret, issuer, origin, subject};
}

/** Docker helper `get`: only an exact configured Zot host can receive this role's JWT. */
export async function getAuth0M2MRegistryCredential(
  rawServer: string,
  environment: NodeJS.ProcessEnv,
  dependencies?: Partial<Auth0M2MTokenDependencies>,
): Promise<{readonly Username: 'zot'; readonly Secret: string; readonly ServerURL: string}> {
  const config = parseAuth0M2MRegistryCredentialConfig(environment);
  if (!SERVER.test(rawServer) || `https://${rawServer}` !== config.origin) throw credentialFailure();
  try {
    const token = await requestVerifiedAuth0M2MToken({...config, scope: SCOPE}, dependencies);
    // The Threadnote Docker credential loader bounds Secret at 8 KiB.
    if (token.accessToken.length > 8192) throw credentialFailure();
    return {Username: 'zot', Secret: token.accessToken, ServerURL: config.origin};
  } catch {
    throw credentialFailure();
  }
}

function canonicalOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.origin === value &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname === '/' &&
      value.length <= 512
    );
  } catch {
    return false;
  }
}

function canonicalIssuer(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.href === value &&
      url.pathname === '/' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      value.length <= 512
    );
  } catch {
    return false;
  }
}

function validSubject(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    [...value].every(character => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127)
  );
}

export async function runAuth0M2MRegistryCredentialHelper(
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
    const value = new TextDecoder('utf-8', {fatal: true}).decode(input);
    if (!value.endsWith('\n') || value.indexOf('\n') !== value.length - 1) throw credentialFailure();
    io.writeStdout(`${JSON.stringify(await getAuth0M2MRegistryCredential(value.slice(0, -1), environment))}\n`);
    return 0;
  } catch {
    io.writeStderr('Auth0 registry credential unavailable.\n');
    return 1;
  }
}
