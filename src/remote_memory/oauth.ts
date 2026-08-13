import {createRemoteJWKSet, jwtVerify, type JWTPayload} from 'jose';
import {remoteMemoryError} from './errors.js';

const MAX_BEARER_TOKEN_BYTES = 16 * 1024;

export interface OAuthPrincipalClaims {
  readonly issuer: string;
  readonly scopes: ReadonlySet<string>;
  readonly subject: string;
}

export interface OAuthTokenVerifier {
  readonly verify: (token: string) => Promise<OAuthPrincipalClaims>;
}

export interface OAuthVerifierConfig {
  readonly audience: string;
  readonly issuer: string;
  readonly jwksUrl: URL;
}

export function bearerTokenFromRequest(request: Request): string {
  const authorization = request.headers.get('authorization');
  if (!authorization) throw remoteMemoryError('unauthorized', 'A bearer access token is required.');
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match?.[1] || Buffer.byteLength(match[1], 'utf8') > MAX_BEARER_TOKEN_BYTES) {
    throw remoteMemoryError('unauthorized', 'The bearer access token is invalid.');
  }
  return match[1];
}

export function createOAuthTokenVerifier(config: OAuthVerifierConfig): OAuthTokenVerifier {
  const jwks = createRemoteJWKSet(config.jwksUrl, {cacheMaxAge: 5 * 60_000, timeoutDuration: 3000});
  return {
    verify: async token => {
      let payload: JWTPayload;
      try {
        ({payload} = await jwtVerify(token, jwks, {
          algorithms: ['RS256'],
          audience: config.audience,
          clockTolerance: 5,
          issuer: config.issuer,
          maxTokenAge: '10 minutes',
          requiredClaims: ['sub', 'iat', 'nbf', 'exp'],
        }));
      } catch {
        throw remoteMemoryError('unauthorized', 'The access token could not be verified.');
      }
      if (!payload.iss || !payload.sub) {
        throw remoteMemoryError('unauthorized', 'The access token is missing its issuer or subject.');
      }
      const issuedAt = numericDate(payload.iat);
      const expiresAt = numericDate(payload.exp);
      const notBefore = numericDate(payload.nbf);
      if (expiresAt <= issuedAt || expiresAt - issuedAt > 605 || notBefore > issuedAt + 5) {
        throw remoteMemoryError('unauthorized', 'The access token lifetime is invalid.');
      }
      return {issuer: payload.iss, scopes: parseScopes(payload), subject: payload.sub};
    },
  };
}

export function protectedResourceMetadata(publicBaseUrl: URL, authorizationServers: readonly string[]) {
  return {
    authorization_servers: authorizationServers,
    bearer_methods_supported: ['header'],
    resource: new URL('/mcp', publicBaseUrl).toString(),
    resource_documentation: new URL('/docs/remote-memory', publicBaseUrl).toString(),
    scopes_supported: ['memory:read', 'memory:write:durable', 'memory:write:handoff', 'memory:admin'],
  } as const;
}

export function oauthChallenge(publicBaseUrl: URL): string {
  const metadata = new URL('/.well-known/oauth-protected-resource', publicBaseUrl);
  return `Bearer resource_metadata="${metadata.toString()}"`;
}

function parseScopes(payload: JWTPayload): ReadonlySet<string> {
  const raw = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : payload.scp;
  if (Array.isArray(raw))
    return new Set(raw.filter((item): item is string => typeof item === 'string' && item.length > 0));
  return new Set();
}

function numericDate(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw remoteMemoryError('unauthorized', 'The access token time claims are invalid.');
  }
  return Number(value);
}
