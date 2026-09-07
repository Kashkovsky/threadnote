import {generateKeyPair, SignJWT} from 'jose';
import {describe, expect, it} from 'vitest';
import {remoteMemoryConfigFromEnvironment} from '../../src/remote_memory/config.js';
import {createLocalOAuthTokenVerifier} from '../../src/remote_memory/oauth.js';
import {PostgresRemoteControlPlane} from '../../src/remote_memory/postgres_control_plane.js';
import {createRemoteMemoryPostgresFixture} from '../helpers/remote-memory-postgres.js';

const TEST_DATABASE_URL = process.env.THREADNOTE_TEST_POSTGRES_URL;
const postgresDescribe = TEST_DATABASE_URL ? describe.sequential : describe.skip;

postgresDescribe('remote memory OAuth provider identity', () => {
  it('provisions, verifies and authorizes an exact issuer without conflating its slashless identity', async () => {
    const fixture = await createRemoteMemoryPostgresFixture(TEST_DATABASE_URL!);
    try {
      const config = remoteMemoryConfigFromEnvironment({
        THREADNOTE_REMOTE_PUBLIC_URL: 'https://memory.example.test',
        THREADNOTE_REMOTE_OAUTH_ISSUER: 'https://identity.example.test/',
        THREADNOTE_REMOTE_DATABASE_URL: 'postgresql://runtime@localhost/threadnote',
      });
      const operator = new PostgresRemoteControlPlane(fixture.migratorSql);
      const control = new PostgresRemoteControlPlane(fixture.sql);
      await operator.provision({
        tenantId: 'oauth-tenant',
        shareId: 'oauth-share',
        principalId: 'oauth-member',
        issuer: config.accessTokenIssuer,
        subject: 'same-subject',
        displayName: 'OAuth fixture',
        region: 'eu-test',
        policyVersion: 'grant-v1',
        sharePolicyVersion: 'share-v1',
        capabilities: ['memory:read'],
        cursorAttestationRequired: false,
        featureFlags: ['remote_memory_read', 'remote_memory_ga'],
        projects: ['threadnote'],
      });
      const {publicKey, privateKey} = await generateKeyPair('RS256');
      const tokenVerifier = createLocalOAuthTokenVerifier({
        audience: config.accessTokenAudience,
        issuer: config.accessTokenIssuer,
        publicKey,
      });
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({scope: 'memory:read'})
        .setProtectedHeader({alg: 'RS256', typ: 'at+jwt'})
        .setIssuer(config.accessTokenIssuer)
        .setAudience(config.accessTokenAudience)
        .setSubject('same-subject')
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);
      const claims = await tokenVerifier.verify(token);

      expect(await control.authorize(claims, 'oauth-share')).toMatchObject({principalId: 'oauth-member'});
      expect(
        await control.authorize({...claims, issuer: 'https://identity.example.test'}, 'oauth-share'),
      ).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });
});
