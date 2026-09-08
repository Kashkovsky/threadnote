import {
  AccessTokenError,
  ACCESS_TOKEN_ERRORS,
  createAccessTokenVerifier,
  createRemoteAccessTokenVerifier,
  parseBearerAccessToken,
  type AccessTokenClaims,
} from '../oauth/access_token.js';
import {Schema} from 'effect';
import {remoteMemoryError} from './errors.js';

export const COMPOSER_OAUTH_SCOPES = ['memory:read', 'memory:write:durable', 'memory:write:handoff'] as const;

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

export interface LocalOAuthVerifierConfig {
  readonly audience: string;
  readonly issuer: string;
  readonly publicKey: CryptoKey;
}

export function bearerTokenFromRequest(request: Request): string {
  try {
    return parseBearerAccessToken(request.headers.get('authorization'));
  } catch (error) {
    throw memoryTokenError(error);
  }
}

export function createOAuthTokenVerifier(config: OAuthVerifierConfig): OAuthTokenVerifier {
  return memoryVerifier(createRemoteAccessTokenVerifier(config));
}

export function createLocalOAuthTokenVerifier(config: LocalOAuthVerifierConfig): OAuthTokenVerifier {
  return memoryVerifier(createAccessTokenVerifier(config.publicKey, config));
}

function memoryVerifier(verify: (token: string) => Promise<AccessTokenClaims>): OAuthTokenVerifier {
  return {
    verify: async token => {
      try {
        const {issuer, scopes, subject} = await verify(token);
        return {issuer, scopes, subject};
      } catch (error) {
        throw memoryTokenError(error);
      }
    },
  };
}

function memoryTokenError(error: unknown) {
  return remoteMemoryError(
    'unauthorized',
    Schema.is(AccessTokenError)(error) ? ACCESS_TOKEN_ERRORS[error.reason] : 'The access token could not be verified.',
  );
}

export function protectedResourceMetadata(publicBaseUrl: URL, authorizationServers: readonly string[]) {
  return {
    authorization_servers: authorizationServers,
    bearer_methods_supported: ['header'],
    resource: new URL('/mcp', publicBaseUrl).toString(),
    resource_documentation: new URL('/docs/remote-memory', publicBaseUrl).toString(),
    scopes_supported: [...COMPOSER_OAUTH_SCOPES, 'memory:admin'],
  } as const;
}

export function oauthChallenge(publicBaseUrl: URL): string {
  const metadata = new URL('/.well-known/oauth-protected-resource', publicBaseUrl);
  return `Bearer resource_metadata="${metadata.toString()}"`;
}
