import {generateKeyPair, SignJWT} from 'jose';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  getAuth0M2MGraphCredential,
  parseAuth0M2MGraphCredentialConfig,
  parseAuth0M2MGraphCredentialRequest,
} from '../../src/code_graph/sharing/auth0_m2m_graph_credential.js';
import {createAccessTokenVerifier} from '../../src/oauth/access_token.js';

const now = Math.floor(Date.now() / 1000);
const request = {
  audience: 'https://graph.threadnote.test/',
  coordinatorUrl: 'https://graph.threadnote.test/org',
  interactive: false,
  issuer: 'https://threadnote-org.eu.auth0.com/',
  organization: 'threadnote',
  profileDigest: `sha256:${'a'.repeat(64)}`,
  repositoryId: 'b'.repeat(64),
  schemaVersion: 1,
  scopes: ['graph:contribute'],
} as const;
const environment = {
  THREADNOTE_AUTH0_GRAPH_M2M_AUDIENCE: request.audience,
  THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_ID: 'syntheticCloudClientId123',
  THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_SECRET: 'synthetic-secret-never-log',
  THREADNOTE_AUTH0_GRAPH_M2M_COORDINATOR_URL: request.coordinatorUrl,
  THREADNOTE_AUTH0_GRAPH_M2M_ISSUER: request.issuer,
  THREADNOTE_AUTH0_GRAPH_M2M_ORGANIZATION: request.organization,
  THREADNOTE_AUTH0_GRAPH_M2M_PROFILE_DIGEST: request.profileDigest,
  THREADNOTE_AUTH0_GRAPH_M2M_REPOSITORY_ID: request.repositoryId,
  THREADNOTE_AUTH0_GRAPH_M2M_SCOPES: 'graph:read graph:contribute',
  THREADNOTE_AUTH0_GRAPH_M2M_SUBJECT: 'syntheticCloudClientId123@clients',
};

describe('Auth0 graph worker credential helper', () => {
  it('requests only the selected graph scope and returns the strict existing helper contract', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    let calls = 0;
    const credential = await getAuth0M2MGraphCredential(request, environment, {
      key: async () => publicKey,
      now: () => now * 1000,
      fetch: async (url, init) => {
        calls++;
        expect(String(url)).toBe(`${request.issuer}oauth/token`);
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        const body = new URLSearchParams(String(init?.body));
        expect(Object.fromEntries(body)).toEqual({
          audience: request.audience,
          client_id: environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_ID,
          client_secret: environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_SECRET,
          grant_type: 'client_credentials',
          scope: 'graph:contribute',
        });
        return Response.json({
          access_token: await signedToken(privateKey),
          expires_in: 600,
          token_type: 'Bearer',
        });
      },
    });
    expect(calls).toBe(1);
    expect(credential).toEqual({
      accessToken: expect.any(String),
      audience: request.audience,
      expiresAt: now + 600,
      issuer: request.issuer,
      schemaVersion: 1,
      subject: environment.THREADNOTE_AUTH0_GRAPH_M2M_SUBJECT,
    });
    expect(JSON.stringify({...credential, accessToken: '[redacted]'})).not.toContain(
      environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_SECRET,
    );
    const listenerClaims = await createAccessTokenVerifier(publicKey, {
      audience: request.audience,
      issuer: request.issuer,
    })(credential.accessToken);
    expect(listenerClaims.subject).toBe(environment.THREADNOTE_AUTH0_GRAPH_M2M_SUBJECT);
    expect(listenerClaims.scopes).toEqual(new Set(['graph:contribute']));
  });

  it('refuses mismatched local authority before sending the client secret', async () => {
    for (const changed of [
      {...request, audience: 'https://other.threadnote.test/'},
      {...request, coordinatorUrl: 'https://other.threadnote.test/org'},
      {...request, issuer: 'https://other.eu.auth0.com/'},
      {...request, organization: 'other'},
      {...request, profileDigest: `sha256:${'c'.repeat(64)}`},
      {...request, repositoryId: 'c'.repeat(64)},
      {...request, scopes: ['graph:write']},
      {...request, interactive: true},
      {...request, extra: 'injected'},
    ]) {
      let called = false;
      await expect(
        getAuth0M2MGraphCredential(changed, environment, {
          fetch: async () => {
            called = true;
            return new Response(null);
          },
        }),
      ).rejects.toThrow('Auth0 graph credential unavailable.');
      expect(called).toBe(false);
    }
  });

  it('rejects foreign, expanded, stale, and malformed signed tokens without leaking token material', async () => {
    const {publicKey, privateKey} = await generateKeyPair('RS256');
    const negativeClaims = [
      {iss: 'https://other.eu.auth0.com/'},
      {aud: 'https://other.threadnote.test/'},
      {sub: 'other@clients'},
      {azp: 'differentCloudClientId'},
      {scope: 'graph:read graph:contribute'},
      {scope: 'graph:read'},
      {exp: now + 29},
      {exp: now + 610},
      {iat: now - 100},
      {gty: 'authorization_code'},
    ];
    for (const override of negativeClaims) {
      const token = await signedToken(privateKey, override);
      try {
        await getAuth0M2MGraphCredential(request, environment, {
          key: async () => publicKey,
          now: () => now * 1000,
          fetch: async () => Response.json({access_token: token, expires_in: 600, token_type: 'Bearer'}),
        });
        throw new Error('Expected token rejection');
      } catch (error) {
        expect(String(error)).toBe('Error: Auth0 graph credential unavailable.');
        expect(JSON.stringify(error)).not.toContain(token);
      }
    }
  });

  it('rejects non-success, response expansion, unsupported token type, and inaccessible Auth0', async () => {
    const {publicKey} = await generateKeyPair('RS256');
    const bodies = [
      new Response(null, {status: 401}),
      Response.json({access_token: 'opaque', token_type: 'Bearer', expires_in: 600, debug: 'extra'}),
      Response.json({access_token: 'opaque', token_type: 'mac', expires_in: 600}),
      Response.json({access_token: 'opaque', token_type: 'Bearer', expires_in: 601}),
      new Response('x'.repeat(32769)),
    ];
    for (const response of bodies) {
      await expect(
        getAuth0M2MGraphCredential(request, environment, {
          key: async () => publicKey,
          fetch: async () => response,
        }),
      ).rejects.toThrow('Auth0 graph credential unavailable.');
    }
    await expect(
      getAuth0M2MGraphCredential(request, environment, {
        fetch: async () => {
          throw new Error('synthetic-secret-never-log');
        },
      }),
    ).rejects.toThrow('Auth0 graph credential unavailable.');
  });

  it('requires a dedicated, exact Cloud M2M binding from environment', () => {
    for (const changed of [
      {THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_SECRET: undefined},
      {THREADNOTE_AUTH0_GRAPH_M2M_ISSUER: 'http://threadnote-org.eu.auth0.com/'},
      {THREADNOTE_AUTH0_GRAPH_M2M_AUDIENCE: 'https://graph.threadnote.test/?token=bad'},
      {THREADNOTE_AUTH0_GRAPH_M2M_SCOPES: 'graph:contribute graph:contribute'},
      {THREADNOTE_AUTH0_GRAPH_M2M_SCOPES: 'graph:contribute memory:write'},
      {THREADNOTE_AUTH0_GRAPH_M2M_SUBJECT: 'user\nother'},
    ])
      expect(() => parseAuth0M2MGraphCredentialConfig({...environment, ...changed})).toThrow(
        'Auth0 graph credential unavailable.',
      );
  });

  it('accepts only a single known graph scope for all arbitrary input strings', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 40}), candidate => {
        const input = {...request, scopes: [candidate]};
        if (candidate === 'graph:read' || candidate === 'graph:contribute') {
          expect(parseAuth0M2MGraphCredentialRequest(input).scopes[0]).toBe(candidate);
        } else {
          expect(() => parseAuth0M2MGraphCredentialRequest(input)).toThrow('Auth0 graph credential unavailable.');
        }
      }),
      {numRuns: 100},
    );
  });
});

async function signedToken(privateKey: CryptoKey, claims: Record<string, unknown> = {}): Promise<string> {
  const payload = {
    aud: request.audience,
    azp: environment.THREADNOTE_AUTH0_GRAPH_M2M_CLIENT_ID,
    gty: 'client-credentials',
    iss: request.issuer,
    scope: 'graph:contribute',
    sub: environment.THREADNOTE_AUTH0_GRAPH_M2M_SUBJECT,
    ...claims,
  };
  return new SignJWT(payload)
    .setProtectedHeader({alg: 'RS256'})
    .setIssuedAt(typeof claims.iat === 'number' ? claims.iat : now)
    .setExpirationTime(typeof claims.exp === 'number' ? claims.exp : now + 600)
    .sign(privateKey);
}
