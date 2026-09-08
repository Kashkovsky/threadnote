import {createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey} from 'jose';
import {Schema} from 'effect';

export const ACCESS_TOKEN_ERRORS = {
  invalidBearer: 'The bearer access token is invalid.',
  invalidLifetime: 'The access token lifetime is invalid.',
  invalidTime: 'The access token time claims are invalid.',
  missingBearer: 'A bearer access token is required.',
  missingIdentity: 'The access token is missing its issuer or subject.',
  unverifiable: 'The access token could not be verified.',
} as const;

export class AccessTokenError extends Schema.TaggedError<AccessTokenError>()('AccessTokenError', {
  message: Schema.String,
  reason: Schema.Literals([
    'invalidBearer',
    'invalidLifetime',
    'invalidTime',
    'missingBearer',
    'missingIdentity',
    'unverifiable',
  ]),
}) {
  static of(reason: keyof typeof ACCESS_TOKEN_ERRORS) {
    return AccessTokenError.make({message: ACCESS_TOKEN_ERRORS[reason], reason});
  }
}

export interface AccessTokenClaims {
  readonly expiresAt: number;
  readonly issuer: string;
  readonly scopes: ReadonlySet<string>;
  readonly subject: string;
}

export interface AccessTokenConfig {
  readonly audience: string;
  readonly issuer: string;
}

export function parseBearerAccessToken(authorization: string | null | undefined): string {
  if (!authorization) throw AccessTokenError.of('missingBearer');
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match?.[1] || Buffer.byteLength(match[1], 'utf8') > 16 * 1024) {
    throw AccessTokenError.of('invalidBearer');
  }
  return match[1];
}

export function createRemoteAccessTokenVerifier(config: AccessTokenConfig & {readonly jwksUrl: URL}) {
  return createAccessTokenVerifier(
    createRemoteJWKSet(config.jwksUrl, {cacheMaxAge: 5 * 60_000, timeoutDuration: 3000}),
    config,
  );
}

export function createAccessTokenVerifier(key: CryptoKey | JWTVerifyGetKey, config: AccessTokenConfig) {
  return async (token: string): Promise<AccessTokenClaims> => {
    let payload: JWTPayload;
    try {
      ({payload} = await jwtVerify(token, key, {
        algorithms: ['RS256'],
        audience: config.audience,
        clockTolerance: 5,
        issuer: config.issuer,
        maxTokenAge: '10 minutes',
        requiredClaims: ['sub', 'iat', 'exp'],
      }));
    } catch {
      throw AccessTokenError.of('unverifiable');
    }
    if (!payload.iss || !payload.sub) throw AccessTokenError.of('missingIdentity');
    const issuedAt = numericDate(payload.iat);
    const expiresAt = numericDate(payload.exp);
    const notBefore = payload.nbf === undefined ? issuedAt : numericDate(payload.nbf);
    if (expiresAt <= issuedAt || expiresAt - issuedAt > 605 || notBefore > issuedAt + 5) {
      throw AccessTokenError.of('invalidLifetime');
    }
    const rawScopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : payload.scp;
    const scopes = new Set<string>(
      Array.isArray(rawScopes)
        ? rawScopes.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : [],
    );
    return {expiresAt, issuer: payload.iss, scopes, subject: payload.sub};
  };
}

function numericDate(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw AccessTokenError.of('invalidTime');
  return Number(value);
}
