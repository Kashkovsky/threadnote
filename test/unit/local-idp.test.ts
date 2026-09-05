import {describe, expect, it} from 'vitest';
import * as FC from 'effect/testing/FastCheck';
import {createOAuthTokenVerifier, createLocalOAuthTokenVerifier} from '../../src/remote_memory/oauth.js';
import {
  COMPOSER_OAUTH_CLIENT_ID,
  COMPOSER_OAUTH_REDIRECT_URIS,
  createLocalIdp,
  pkceS256Challenge,
} from '../../src/remote_memory/local_idp.js';

const ISSUER = 'http://127.0.0.1:18788';
const AUDIENCE = 'http://127.0.0.1:18788/mcp';
const SUBJECT = 'local:tester';
const REDIRECT = COMPOSER_OAUTH_REDIRECT_URIS[0];
const PKCE_VERIFIER = FC.stringMatching(/^[A-Za-z0-9-._~]{43,96}$/u);

async function localIdp() {
  return createLocalIdp({audience: AUDIENCE, issuer: ISSUER, subject: SUBJECT});
}

async function jsonBody(response: Response | undefined): Promise<Record<string, unknown>> {
  expect(response).toBeInstanceOf(Response);
  return (await (response as Response).json()) as Record<string, unknown>;
}

describe('local composer OAuth issuer', () => {
  it('rejects a non-loopback HTTP issuer', async () => {
    await expect(
      createLocalIdp({audience: AUDIENCE, issuer: 'http://identity.example.test', subject: SUBJECT}),
    ).rejects.toMatchObject({message: expect.stringContaining('HTTPS')});
  });

  it('issues an RS256 access token that both verifiers accept', async () => {
    const idp = await localIdp();
    const token = await idp.issueAccessToken();
    const claims = await idp.verifier().verify(token);
    expect(claims).toEqual({
      issuer: ISSUER,
      scopes: new Set(['memory:read', 'memory:write:durable', 'memory:write:handoff']),
      subject: SUBJECT,
    });
    expect(
      await createLocalOAuthTokenVerifier({audience: AUDIENCE, issuer: ISSUER, publicKey: idp.publicKey}).verify(token),
    ).toEqual(claims);
  });

  it('advertises authorization-server metadata, JWKS, and a static public client', async () => {
    const idp = await localIdp();
    const metadata = await idp.handle(new Request(`${ISSUER}/.well-known/oauth-authorization-server`));
    const jwks = await idp.handle(new Request(`${ISSUER}/.well-known/jwks.json`));
    const registered = await idp.handle(new Request(`${ISSUER}/register`, {method: 'POST', body: '{}'}));
    expect(metadata?.status).toBe(200);
    expect(await jsonBody(metadata)).toMatchObject({
      authorization_endpoint: `${ISSUER}/authorize`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code'],
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      token_endpoint: `${ISSUER}/token`,
      token_endpoint_auth_methods_supported: ['none'],
    });
    expect((await jsonBody(jwks)).keys).toEqual([expect.objectContaining({alg: 'RS256'})]);
    expect(registered?.status).toBe(201);
    expect(await jsonBody(registered)).toMatchObject({
      client_id: COMPOSER_OAUTH_CLIENT_ID,
      token_endpoint_auth_method: 'none',
    });
  });

  it('completes authorization-code PKCE and rejects client-credentials grants', async () => {
    const idp = await localIdp();
    const verifier = 'a'.repeat(43);
    const authorize = await idp.handle(
      new Request(
        `${ISSUER}/authorize?client_id=${COMPOSER_OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${pkceS256Challenge(verifier)}&code_challenge_method=S256&state=xyz`,
      ),
    );
    expect(authorize?.status).toBe(302);
    const location = new URL(authorize?.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe('xyz');
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();
    const token = await idp.handle(
      new Request(`${ISSUER}/token`, {
        body: new URLSearchParams({
          client_id: COMPOSER_OAUTH_CLIENT_ID,
          code: code ?? '',
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT,
        }).toString(),
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        method: 'POST',
      }),
    );
    expect(token?.status).toBe(200);
    const body = (await token?.json()) as {access_token: string; token_type: string};
    expect(body.token_type).toBe('Bearer');
    expect(await idp.verifier().verify(body.access_token)).toMatchObject({subject: SUBJECT});

    const credentials = await idp.handle(
      new Request(`${ISSUER}/token`, {
        body: new URLSearchParams({
          client_id: COMPOSER_OAUTH_CLIENT_ID,
          grant_type: 'client_credentials',
        }).toString(),
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        method: 'POST',
      }),
    );
    expect(credentials?.status).toBe(400);
    expect(await credentials?.json()).toEqual({error: 'unsupported_grant_type'});

    const missingClient = await idp.handle(
      new Request(`${ISSUER}/token`, {
        body: new URLSearchParams({
          code: code ?? '',
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT,
        }).toString(),
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        method: 'POST',
      }),
    );
    expect(missingClient?.status).toBe(401);
    expect(await missingClient?.json()).toEqual({error: 'invalid_client'});

    const extraLoopback = await idp.handle(
      new Request(
        `${ISSUER}/authorize?client_id=${COMPOSER_OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent('http://127.0.0.1:9999/callback')}&response_type=code&code_challenge=${pkceS256Challenge(verifier)}&code_challenge_method=S256`,
      ),
    );
    expect(extraLoopback?.status).toBe(400);
    expect(await extraLoopback?.json()).toMatchObject({error: 'invalid_request'});
  });

  it('rejects a PKCE verifier that does not match the authorization challenge', async () => {
    const idp = await localIdp();
    const authorize = await idp.handle(
      new Request(
        `${ISSUER}/authorize?client_id=${COMPOSER_OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${pkceS256Challenge('a'.repeat(43))}&code_challenge_method=S256`,
      ),
    );
    const code = new URL(authorize?.headers.get('location') ?? '').searchParams.get('code');
    const token = await idp.handle(
      new Request(`${ISSUER}/token`, {
        body: new URLSearchParams({
          client_id: COMPOSER_OAUTH_CLIENT_ID,
          code: code ?? '',
          code_verifier: 'b'.repeat(43),
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT,
        }).toString(),
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        method: 'POST',
      }),
    );
    expect(token?.status).toBe(400);
    expect(await token?.json()).toEqual({error: 'invalid_grant'});
  });

  it('lets createOAuthTokenVerifier fetch the local JWKS', async () => {
    const idp = await localIdp();
    const server = Bun.serve({
      fetch(request) {
        if (new URL(request.url).pathname !== '/.well-known/jwks.json') {
          return new Response('not found', {status: 404});
        }
        return Response.json({keys: [idp.publicJwk]});
      },
      hostname: '127.0.0.1',
      port: 0,
    });
    try {
      const token = await idp.issueAccessToken();
      await expect(
        createOAuthTokenVerifier({
          audience: AUDIENCE,
          issuer: ISSUER,
          jwksUrl: new URL('/.well-known/jwks.json', server.url),
        }).verify(token),
      ).resolves.toMatchObject({issuer: ISSUER, subject: SUBJECT});
    } finally {
      await server.stop(true);
    }
  });

  it('computes a deterministic S256 challenge for any legal PKCE verifier', () => {
    FC.assert(
      FC.property(PKCE_VERIFIER, verifier => {
        const challenge = pkceS256Challenge(verifier);
        expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(pkceS256Challenge(verifier)).toBe(challenge);
      }),
    );
  });
});
