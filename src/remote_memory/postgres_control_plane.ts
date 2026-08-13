import postgres, {type Sql, type TransactionSql} from 'postgres';
import {sha256HexSync} from '../crypto/sha256.js';
import type {
  AuthorizedRemotePrincipal,
  RemoteAuthorizationStore,
  RemoteMemoryFeatureFlag,
  RemoteMemoryScope,
} from './authorization.js';
import type {OAuthPrincipalClaims} from './oauth.js';
import type {
  CursorAttestationChallenge,
  CursorAttestationStore,
  CursorWorkloadAttestation,
  CursorWorkloadClaims,
} from './cursor_oidc.js';
import {canonicalCursorRepositoryBinding, cursorAttestationMaximumAttempts} from './cursor_oidc.js';
import {remoteMemoryError} from './errors.js';
import {validatePortableSegment} from '../storage/resource-id.js';
import {
  remoteMemoryDatabaseTimeoutMilliseconds,
  requireActiveRemoteMemoryRequest,
  type RemoteMemoryRequestExecution,
  withRemoteMemoryRequestCancellation,
} from './request_execution.js';

const DATABASE_TIMEOUT_MILLISECONDS = 5_000;

interface AuthorizationRow {
  readonly allowed_projects: string[] | null;
  readonly capabilities: string[];
  readonly cursor_attestation_required: boolean;
  readonly cursor_owner_ids: string[];
  readonly cursor_subjects: string[];
  readonly cursor_team_id: string | null;
  readonly feature_flags: string[];
  readonly policy_version: string;
  readonly policy_digest: string;
  readonly grant_policy_version: string;
  readonly grant_policy_digest: string;
  readonly principal_id: string;
  readonly project_repository_bindings: Readonly<Record<string, readonly string[]>> | null;
  readonly share_id: string;
  readonly tenant_id: string;
}

interface ChallengeRow {
  readonly audience: string;
  readonly completion_url: string;
  readonly expires_at: Date;
  readonly id: string;
  readonly nonce: string;
  readonly principal_id: string;
  readonly share_id: string;
  readonly tenant_id: string;
}

interface AttestationRow {
  readonly cloud_agent_id: string;
  readonly expires_at: Date;
  readonly id: string;
  readonly issuer: string;
  readonly jwt_id: string;
  readonly owner_id: string | null;
  readonly principal_id: string;
  readonly repository_urls: string[] | null;
  readonly share_id: string;
  readonly subject: string;
  readonly team_id: string | null;
  readonly tenant_id: string;
  readonly turn_id: string | null;
}

interface SharePolicyRow {
  readonly policy_digest: string;
  readonly policy_document: unknown;
  readonly policy_version: string;
  readonly status: string;
}

export interface RemoteMemoryProvisioningInput {
  readonly allowedProjects?: readonly string[];
  readonly capabilities: readonly RemoteMemoryScope[];
  readonly cursorAttestationRequired?: boolean;
  readonly cursorOwnerIds?: readonly string[];
  readonly cursorSubjects?: readonly string[];
  readonly cursorTeamId?: string;
  readonly displayName: string;
  readonly expectedCurrentPolicyVersion?: string;
  readonly expectedCurrentSharePolicyVersion?: string;
  readonly featureFlags?: readonly RemoteMemoryFeatureFlag[];
  readonly issuer: string;
  readonly policyVersion: string;
  readonly principalId: string;
  /** Share-wide project/repository catalog. Required when creating or changing share policy. */
  readonly projects?: readonly string[];
  readonly region: string;
  readonly repositoryBindings?: Readonly<Record<string, readonly string[]>>;
  readonly sharePolicyVersion?: string;
  readonly shareId: string;
  readonly subject: string;
  readonly tenantId: string;
}

export function createRemoteMemorySql(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    connect_timeout: 10,
    idle_timeout: 20,
    max: 20,
    onnotice: () => undefined,
    prepare: true,
  });
}

export class PostgresRemoteControlPlane implements RemoteAuthorizationStore, CursorAttestationStore {
  constructor(readonly sql: Sql) {}

  async authorize(
    claims: OAuthPrincipalClaims,
    requestedShareId: string | undefined,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<AuthorizedRemotePrincipal | undefined> {
    if (!requestedShareId) return undefined;
    const tenantId = await this.tenantForShare(requestedShareId, execution);
    if (!tenantId) return undefined;
    return this.withTenant(
      tenantId,
      async transaction => {
        const rows = await transaction<AuthorizationRow[]>`
        SELECT
          g.allowed_projects,
          g.capabilities,
          g.cursor_attestation_required,
          g.cursor_owner_ids,
          g.cursor_subjects,
          s.cursor_team_id,
          s.feature_flags,
          s.policy_version,
          s.policy_digest,
          g.policy_version AS grant_policy_version,
          g.policy_digest AS grant_policy_digest,
          p.id AS principal_id,
          COALESCE(
            jsonb_object_agg(b.project_name, b.repository_urls)
              FILTER (WHERE b.project_name IS NOT NULL),
            '{}'::jsonb
          ) AS project_repository_bindings,
          s.id AS share_id,
          s.tenant_id
        FROM remote_memory.external_identities e
        JOIN remote_memory.principals p
          ON p.tenant_id = e.tenant_id AND p.id = e.principal_id AND p.status = 'active'
        JOIN remote_memory.tenants t ON t.id = ${tenantId} AND t.status = 'active'
        JOIN remote_memory.tenant_memberships m
          ON m.principal_id = p.id AND m.tenant_id = ${tenantId} AND m.status = 'active'
        JOIN remote_memory.share_grants g
          ON g.principal_id = p.id AND g.tenant_id = m.tenant_id AND g.status = 'active'
        JOIN remote_memory.shares s
          ON s.tenant_id = g.tenant_id AND s.id = g.share_id AND s.status = 'active'
        LEFT JOIN LATERAL (
          SELECT project_name, array_agg(repository_url ORDER BY repository_url) AS repository_urls
          FROM remote_memory.project_repository_bindings
          WHERE tenant_id = s.tenant_id AND share_id = s.id
            AND (g.allowed_projects IS NULL OR project_name = ANY(g.allowed_projects))
          GROUP BY project_name
        ) b ON true
        WHERE e.issuer = ${claims.issuer}
          AND e.subject = ${claims.subject}
          AND e.tenant_id = ${tenantId}
          AND s.id = ${requestedShareId}
        GROUP BY g.allowed_projects, g.capabilities, g.cursor_attestation_required,
          s.feature_flags,
          g.cursor_owner_ids, g.cursor_subjects, s.cursor_team_id, s.policy_version, s.policy_digest,
          g.policy_version, g.policy_digest,
          p.id, s.id, s.tenant_id
      `;
        return rows[0] ? authorizedPrincipal(rows[0], claims) : undefined;
      },
      execution,
    );
  }

  async principalForChallenge(
    challengeId: string,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<AuthorizedRemotePrincipal | undefined> {
    const directory = await this.readDirectory(
      transaction => transaction<{share_id: string; tenant_id: string}[]>`
        SELECT share_id, tenant_id
        FROM remote_memory.challenge_directory
        WHERE challenge_id = ${challengeId} AND expires_at > now()
      `,
      execution,
    );
    const target = directory[0];
    if (!target) return undefined;
    return this.withTenant(
      target.tenant_id,
      async transaction => {
        const rows = await transaction<AuthorizationRow[]>`
        SELECT
          g.allowed_projects,
          g.capabilities,
          g.cursor_attestation_required,
          g.cursor_owner_ids,
          g.cursor_subjects,
          s.cursor_team_id,
          s.feature_flags,
          s.policy_version,
          s.policy_digest,
          g.policy_version AS grant_policy_version,
          g.policy_digest AS grant_policy_digest,
          p.id AS principal_id,
          COALESCE(
            jsonb_object_agg(b.project_name, b.repository_urls)
              FILTER (WHERE b.project_name IS NOT NULL),
            '{}'::jsonb
          ) AS project_repository_bindings,
          s.id AS share_id,
          s.tenant_id
        FROM remote_memory.attestation_challenges c
        JOIN remote_memory.tenants t ON t.id = c.tenant_id AND t.status = 'active'
        JOIN remote_memory.principals p
          ON p.tenant_id = c.tenant_id AND p.id = c.principal_id AND p.status = 'active'
        JOIN remote_memory.tenant_memberships m
          ON m.principal_id = p.id AND m.tenant_id = c.tenant_id AND m.status = 'active'
        JOIN remote_memory.share_grants g
          ON g.principal_id = p.id AND g.tenant_id = c.tenant_id
          AND g.share_id = c.share_id AND g.status = 'active'
        JOIN remote_memory.shares s
          ON s.tenant_id = c.tenant_id AND s.id = c.share_id AND s.status = 'active'
        LEFT JOIN LATERAL (
          SELECT project_name, array_agg(repository_url ORDER BY repository_url) AS repository_urls
          FROM remote_memory.project_repository_bindings
          WHERE tenant_id = s.tenant_id AND share_id = s.id
            AND (g.allowed_projects IS NULL OR project_name = ANY(g.allowed_projects))
          GROUP BY project_name
        ) b ON true
        WHERE c.id = ${challengeId} AND c.expires_at > now() AND c.consumed_at IS NULL
        GROUP BY g.allowed_projects, g.capabilities, g.cursor_attestation_required,
          s.feature_flags,
          g.cursor_owner_ids, g.cursor_subjects, s.cursor_team_id, s.policy_version, s.policy_digest,
          g.policy_version, g.policy_digest,
          p.id, s.id, s.tenant_id
      `;
        const claims: OAuthPrincipalClaims = {
          issuer: 'challenge-bound',
          scopes: new Set<RemoteMemoryScope>(['memory:admin']),
          subject: rows[0]?.principal_id ?? '',
        };
        return rows[0] ? authorizedPrincipal(rows[0], claims) : undefined;
      },
      execution,
    );
  }

  async createChallenge(
    challenge: CursorAttestationChallenge,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<void> {
    await this.withTenant(
      challenge.tenantId,
      async transaction => {
        await transaction`
        INSERT INTO remote_memory.challenge_directory(challenge_id, share_id, tenant_id, expires_at)
        VALUES (${challenge.challengeId}, ${challenge.shareId}, ${challenge.tenantId}, ${challenge.expiresAt})
      `;
        await transaction`
        INSERT INTO remote_memory.attestation_challenges(
          tenant_id, share_id, id, principal_id, nonce, audience, completion_url, expires_at
        ) VALUES (
          ${challenge.tenantId}, ${challenge.shareId}, ${challenge.challengeId}, ${challenge.principalId},
          ${challenge.nonce}, ${challenge.audience}, ${challenge.completionUrl}, ${challenge.expiresAt}
        )
      `;
      },
      execution,
    );
  }

  async claimChallengeAttempt(
    challengeId: string,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<CursorAttestationChallenge | undefined> {
    const directory = await this.readDirectory(
      transaction => transaction<{tenant_id: string}[]>`
        SELECT tenant_id FROM remote_memory.challenge_directory
        WHERE challenge_id = ${challengeId} AND expires_at > now()
      `,
      execution,
    );
    const tenantId = directory[0]?.tenant_id;
    if (!tenantId) return undefined;
    return this.withTenant(
      tenantId,
      async transaction => {
        const rows = await transaction<ChallengeRow[]>`
        UPDATE remote_memory.attestation_challenges
        SET attempts = attempts + 1
        WHERE id = ${challengeId} AND consumed_at IS NULL AND expires_at > now()
          AND attempts < ${cursorAttestationMaximumAttempts()}
        RETURNING tenant_id, share_id, id, principal_id, nonce, audience, completion_url, expires_at
      `;
        return rows[0] ? challengeFromRow(rows[0]) : undefined;
      },
      execution,
    );
  }

  async consumeChallenge(
    challengeId: string,
    expected: {
      readonly nonce: string;
      readonly principalId: string;
      readonly shareId: string;
      readonly tenantId: string;
    },
    claims: CursorWorkloadClaims,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<CursorWorkloadAttestation | undefined> {
    return this.withTenant(
      expected.tenantId,
      async transaction => {
        const consumed = await transaction<{id: string}[]>`
        UPDATE remote_memory.attestation_challenges
        SET consumed_at = now()
        WHERE id = ${challengeId}
          AND tenant_id = ${expected.tenantId}
          AND share_id = ${expected.shareId}
          AND principal_id = ${expected.principalId}
          AND nonce = ${expected.nonce}
          AND consumed_at IS NULL
          AND expires_at > now()
        RETURNING id
      `;
        if (!consumed[0]) return undefined;
        const attestationId = crypto.randomUUID();
        const rows = await transaction<AttestationRow[]>`
        INSERT INTO remote_memory.workload_attestations(
          tenant_id, share_id, id, principal_id, issuer, subject, jwt_id, cloud_agent_id,
          turn_id, team_id, owner_id, repository_urls, expires_at
        ) VALUES (
          ${expected.tenantId}, ${expected.shareId}, ${attestationId}, ${expected.principalId},
          ${claims.issuer}, ${claims.subject}, ${claims.jti}, ${claims.cloudAgentId},
          ${claims.turnId ?? null}, ${claims.teamId ?? null}, ${claims.ownerId ?? null},
          ${claims.repositoryUrls ? transaction.array([...claims.repositoryUrls]) : null}, ${claims.expiresAt}
        )
        ON CONFLICT (issuer, jwt_id) DO NOTHING
        RETURNING *
      `;
        return rows[0] ? attestationFromRow(rows[0]) : undefined;
      },
      execution,
    );
  }

  async getValidAttestation(
    attestationId: string,
    principal: AuthorizedRemotePrincipal,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<CursorWorkloadAttestation | undefined> {
    return this.withTenant(
      principal.tenantId,
      async transaction => {
        const rows = await transaction<AttestationRow[]>`
        SELECT * FROM remote_memory.workload_attestations
        WHERE id = ${attestationId}
          AND tenant_id = ${principal.tenantId}
          AND share_id = ${principal.shareId}
          AND principal_id = ${principal.principalId}
          AND expires_at > now()
      `;
        return rows[0] ? attestationFromRow(rows[0]) : undefined;
      },
      execution,
    );
  }

  async provision(input: RemoteMemoryProvisioningInput): Promise<void> {
    validateRemoteMemoryProvisioningInput(input);
    const retentionPrincipalId = remoteRetentionPrincipalId(input.tenantId);
    const retentionPolicy = internalRetentionPolicy();
    await this.sql.begin(async transaction => {
      await setTenant(transaction, input.tenantId);
      await transaction`
        INSERT INTO remote_memory.tenants(id, region, status)
        VALUES (${input.tenantId}, ${input.region}, 'active')
        ON CONFLICT (id) DO NOTHING
      `;
      const tenants = await transaction<{region: string; status: string}[]>`
        SELECT region, status FROM remote_memory.tenants WHERE id = ${input.tenantId}
      `;
      if (tenants[0]?.region !== input.region || tenants[0]?.status !== 'active') {
        throw remoteMemoryError('conflict', 'The tenant region or lifecycle state differs from provisioning input.');
      }
      await transaction`
        INSERT INTO remote_memory.principals(tenant_id, id, status)
        VALUES (${input.tenantId}, ${input.principalId}, 'active')
        ON CONFLICT (tenant_id, id) DO NOTHING
      `;
      await transaction`
        INSERT INTO remote_memory.principals(tenant_id, id, status)
        VALUES (${input.tenantId}, ${retentionPrincipalId}, 'active')
        ON CONFLICT (tenant_id, id) DO NOTHING
      `;
      const principals = await transaction<{id: string; status: string}[]>`
        SELECT id, status FROM remote_memory.principals
        WHERE tenant_id = ${input.tenantId} AND id = ANY(${transaction.array([input.principalId, retentionPrincipalId])})
      `;
      if (principals.length !== 2 || principals.some(principal => principal.status !== 'active')) {
        throw remoteMemoryError('conflict', 'A provisioning principal is disabled or unavailable.');
      }
      await transaction`
        INSERT INTO remote_memory.external_identities(tenant_id, issuer, subject, principal_id)
        VALUES (${input.tenantId}, ${input.issuer}, ${input.subject}, ${input.principalId})
        ON CONFLICT (tenant_id, issuer, subject) DO NOTHING
      `;
      const identity = await transaction<{principal_id: string}[]>`
        SELECT principal_id FROM remote_memory.external_identities
        WHERE tenant_id = ${input.tenantId} AND issuer = ${input.issuer} AND subject = ${input.subject}
      `;
      if (identity[0]?.principal_id !== input.principalId) {
        throw remoteMemoryError('conflict', 'The external identity is already bound to another principal.');
      }
      await transaction`
        INSERT INTO remote_memory.share_directory(share_id, tenant_id, status)
        VALUES (${input.shareId}, ${input.tenantId}, 'active')
        ON CONFLICT (share_id) DO NOTHING
      `;
      const directory = await transaction<{status: string; tenant_id: string}[]>`
        SELECT tenant_id, status FROM remote_memory.share_directory WHERE share_id = ${input.shareId}
      `;
      if (directory[0]?.tenant_id !== input.tenantId || directory[0]?.status !== 'active') {
        throw remoteMemoryError('conflict', 'The opaque share directory entry conflicts or is not active.');
      }
      await transaction`
        INSERT INTO remote_memory.tenant_memberships(tenant_id, principal_id, status)
        VALUES (${input.tenantId}, ${input.principalId}, 'active')
        ON CONFLICT (tenant_id, principal_id) DO UPDATE SET status = 'active'
      `;
      const desiredPolicy = provisioningPolicy(input);
      const currentShares = await transaction<SharePolicyRow[]>`
        SELECT s.policy_version, s.policy_digest, s.status, v.policy_document
        FROM remote_memory.shares s
        JOIN remote_memory.share_policy_versions v
          ON v.tenant_id = s.tenant_id AND v.share_id = s.id AND v.version = s.policy_version
        WHERE s.tenant_id = ${input.tenantId} AND s.id = ${input.shareId}
        FOR UPDATE
      `;
      const currentShare = currentShares[0];
      if (currentShare && currentShare.status !== 'active') {
        throw remoteMemoryError('conflict', 'The memory share lifecycle state does not allow provisioning.');
      }
      if (currentShare && input.sharePolicyVersion === undefined) {
        requireNoImplicitSharePolicyChange(input, currentShare.policy_document);
      }
      const desiredSharePolicy =
        currentShare && input.sharePolicyVersion === undefined
          ? {digest: currentShare.policy_digest, document: currentShare.policy_document}
          : provisioningSharePolicy(input);
      const sharePolicyVersion = input.sharePolicyVersion ?? currentShare?.policy_version ?? input.policyVersion;
      let replaceSharePolicy = currentShare === undefined;
      if (currentShare) {
        if (
          input.expectedCurrentSharePolicyVersion !== undefined &&
          input.expectedCurrentSharePolicyVersion !== currentShare.policy_version
        ) {
          throw remoteMemoryError('conflict', 'The share-wide policy changed before provisioning could replace it.');
        }
        if (input.sharePolicyVersion !== undefined && input.sharePolicyVersion !== currentShare.policy_version) {
          requireCompleteSharePolicy(input);
          if (input.expectedCurrentSharePolicyVersion !== currentShare.policy_version) {
            throw remoteMemoryError(
              'conflict',
              'Changing the share policy version requires its exact expected current version.',
            );
          }
          replaceSharePolicy = true;
        } else if (
          input.sharePolicyVersion === currentShare.policy_version &&
          currentShare.policy_digest !== desiredSharePolicy.digest
        ) {
          throw remoteMemoryError(
            'conflict',
            'A share policy version cannot be reused for different share-wide policy content.',
          );
        }
      }
      const currentPolicies = await transaction<{policy_digest: string | null; policy_version: string}[]>`
        SELECT g.policy_version, v.policy_digest
        FROM remote_memory.share_grants g
        LEFT JOIN remote_memory.grant_policy_versions v
          ON v.tenant_id = g.tenant_id AND v.share_id = g.share_id
          AND v.version = g.policy_version AND v.principal_id = g.principal_id
        WHERE g.tenant_id = ${input.tenantId} AND g.share_id = ${input.shareId}
          AND g.principal_id = ${input.principalId}
        FOR UPDATE OF g
      `;
      const currentPolicy = currentPolicies[0];
      if (currentPolicy) {
        if (
          input.expectedCurrentPolicyVersion !== undefined &&
          input.expectedCurrentPolicyVersion !== currentPolicy.policy_version
        ) {
          throw remoteMemoryError('conflict', 'The share policy changed before provisioning could replace it.');
        }
        if (
          input.expectedCurrentPolicyVersion === undefined &&
          (currentPolicy.policy_version !== input.policyVersion || currentPolicy.policy_digest !== desiredPolicy.digest)
        ) {
          throw remoteMemoryError(
            'conflict',
            'Replacing an existing share policy requires its expected current policy version.',
          );
        }
      }
      await transaction`
        INSERT INTO remote_memory.tenant_memberships(tenant_id, principal_id, status)
        VALUES (${input.tenantId}, ${retentionPrincipalId}, 'active')
        ON CONFLICT (tenant_id, principal_id) DO UPDATE SET status = 'active'
      `;
      if (!currentShare) {
        await transaction`
          INSERT INTO remote_memory.shares(
            tenant_id, id, display_name, status, policy_version, policy_digest, cursor_team_id, feature_flags
          ) VALUES (
            ${input.tenantId}, ${input.shareId}, ${input.displayName}, 'active',
            ${sharePolicyVersion}, ${desiredSharePolicy.digest}, ${input.cursorTeamId ?? null},
            ${transaction.array([...(input.featureFlags ?? ['remote_memory_read'])])}
          )
        `;
      } else if (replaceSharePolicy) {
        await transaction`
          UPDATE remote_memory.shares SET
            display_name = ${input.displayName}, status = 'active', policy_version = ${sharePolicyVersion},
            policy_digest = ${desiredSharePolicy.digest}, cursor_team_id = ${input.cursorTeamId ?? null},
            feature_flags = ${transaction.array([...(input.featureFlags ?? ['remote_memory_read'])])}
          WHERE tenant_id = ${input.tenantId} AND id = ${input.shareId}
            AND policy_version = ${input.expectedCurrentSharePolicyVersion!}
        `;
      }
      if (replaceSharePolicy) {
        await transaction`
          INSERT INTO remote_memory.share_policy_versions(
            tenant_id, share_id, version, policy_document, policy_digest
          ) VALUES (
            ${input.tenantId}, ${input.shareId}, ${sharePolicyVersion},
            ${JSON.stringify(desiredSharePolicy.document)}::jsonb, ${desiredSharePolicy.digest}
          )
          ON CONFLICT (tenant_id, share_id, version) DO NOTHING
        `;
        const storedSharePolicies = await transaction<{policy_digest: string}[]>`
          SELECT policy_digest FROM remote_memory.share_policy_versions
          WHERE tenant_id = ${input.tenantId} AND share_id = ${input.shareId} AND version = ${sharePolicyVersion}
        `;
        if (storedSharePolicies[0]?.policy_digest !== desiredSharePolicy.digest) {
          throw remoteMemoryError('conflict', 'The share policy version is already bound to different policy content.');
        }
      }
      await transaction`
        INSERT INTO remote_memory.grant_policy_versions(
          tenant_id, share_id, version, principal_id, policy_document, policy_digest
        ) VALUES (
          ${input.tenantId}, ${input.shareId}, ${input.policyVersion}, ${input.principalId},
          ${JSON.stringify(desiredPolicy.document)}::jsonb, ${desiredPolicy.digest}
        )
        ON CONFLICT (tenant_id, share_id, version, principal_id) DO NOTHING
      `;
      const storedPolicies = await transaction<{policy_digest: string}[]>`
        SELECT policy_digest FROM remote_memory.grant_policy_versions
        WHERE tenant_id = ${input.tenantId} AND share_id = ${input.shareId}
          AND version = ${input.policyVersion} AND principal_id = ${input.principalId}
      `;
      if (storedPolicies[0]?.policy_digest !== desiredPolicy.digest) {
        throw remoteMemoryError('conflict', 'The policy version is already bound to different policy content.');
      }
      await transaction`
        INSERT INTO remote_memory.grant_policy_versions(
          tenant_id, share_id, version, principal_id, policy_document, policy_digest
        ) VALUES (
          ${input.tenantId}, ${input.shareId}, 'retention-v1', ${retentionPrincipalId},
          ${JSON.stringify(retentionPolicy.document)}::jsonb, ${retentionPolicy.digest}
        ) ON CONFLICT (tenant_id, share_id, version, principal_id) DO NOTHING
      `;
      const storedRetentionPolicies = await transaction<{policy_digest: string}[]>`
        SELECT policy_digest FROM remote_memory.grant_policy_versions
        WHERE tenant_id = ${input.tenantId} AND share_id = ${input.shareId}
          AND version = 'retention-v1' AND principal_id = ${retentionPrincipalId}
      `;
      if (storedRetentionPolicies[0]?.policy_digest !== retentionPolicy.digest) {
        throw remoteMemoryError('conflict', 'The internal retention policy version has conflicting content.');
      }
      await transaction`
        INSERT INTO remote_memory.share_grants(
          tenant_id, share_id, principal_id, status, capabilities, allowed_projects,
          cursor_owner_ids, cursor_subjects, cursor_attestation_required, policy_version, policy_digest
        ) VALUES (
          ${input.tenantId}, ${input.shareId}, ${input.principalId}, 'active',
          ${transaction.array([...input.capabilities])},
          ${input.allowedProjects ? transaction.array([...input.allowedProjects]) : null},
          ${transaction.array([...(input.cursorOwnerIds ?? [])])},
          ${transaction.array([...(input.cursorSubjects ?? [])])},
          ${input.cursorAttestationRequired ?? true}, ${input.policyVersion}, ${desiredPolicy.digest}
        ) ON CONFLICT (tenant_id, share_id, principal_id) DO UPDATE SET
          status = 'active',
          capabilities = EXCLUDED.capabilities,
          allowed_projects = EXCLUDED.allowed_projects,
          cursor_owner_ids = EXCLUDED.cursor_owner_ids,
          cursor_subjects = EXCLUDED.cursor_subjects,
          cursor_attestation_required = EXCLUDED.cursor_attestation_required,
          policy_version = EXCLUDED.policy_version,
          policy_digest = EXCLUDED.policy_digest
      `;
      await transaction`
        INSERT INTO remote_memory.share_grants(
          tenant_id, share_id, principal_id, status, capabilities, allowed_projects,
          cursor_owner_ids, cursor_subjects, cursor_attestation_required, policy_version, policy_digest
        ) VALUES (
          ${input.tenantId}, ${input.shareId}, ${retentionPrincipalId}, 'active',
          ${transaction.array(['memory:admin'])}, NULL,
          ${transaction.array([])}, ${transaction.array([])}, false, 'retention-v1',
          ${retentionPolicy.digest}
        ) ON CONFLICT (tenant_id, share_id, principal_id) DO UPDATE SET
          status = 'active', capabilities = EXCLUDED.capabilities, allowed_projects = NULL,
          cursor_owner_ids = EXCLUDED.cursor_owner_ids, cursor_subjects = EXCLUDED.cursor_subjects,
          cursor_attestation_required = false
      `;
      if (replaceSharePolicy) {
        const configuredProjects = [...new Set(input.projects ?? Object.keys(input.repositoryBindings ?? {}))];
        for (const project of configuredProjects) {
          await transaction`
            INSERT INTO remote_memory.projects(tenant_id, share_id, name, status)
            VALUES (${input.tenantId}, ${input.shareId}, ${project}, 'active')
            ON CONFLICT (tenant_id, share_id, name) DO UPDATE SET status = 'active'
          `;
        }
        await transaction`
          DELETE FROM remote_memory.project_repository_bindings
          WHERE tenant_id = ${input.tenantId} AND share_id = ${input.shareId}
            AND (${configuredProjects.length === 0}
              OR project_name <> ALL(${transaction.array(configuredProjects)}))
        `;
        for (const project of configuredProjects) {
          const repositories = [...new Set(input.repositoryBindings?.[project] ?? [])];
          for (const repository of repositories) {
            await transaction`
              INSERT INTO remote_memory.project_repository_bindings(
                tenant_id, share_id, project_name, repository_url
              ) VALUES (${input.tenantId}, ${input.shareId}, ${project}, ${repository})
              ON CONFLICT DO NOTHING
            `;
          }
          await transaction`
            DELETE FROM remote_memory.project_repository_bindings
            WHERE tenant_id = ${input.tenantId} AND share_id = ${input.shareId} AND project_name = ${project}
              AND (${repositories.length === 0}
                OR repository_url <> ALL(${transaction.array(repositories)}))
          `;
        }
        await transaction`
          UPDATE remote_memory.projects SET status = 'archived'
          WHERE tenant_id = ${input.tenantId} AND share_id = ${input.shareId}
            AND (${configuredProjects.length === 0}
              OR name <> ALL(${transaction.array(configuredProjects)}))
        `;
      }
      if (input.allowedProjects) {
        const allowedProjects = [...new Set(input.allowedProjects)];
        const activeProjects = await transaction<{name: string}[]>`
          SELECT name FROM remote_memory.projects
          WHERE tenant_id = ${input.tenantId} AND share_id = ${input.shareId} AND status = 'active'
            AND name = ANY(${transaction.array(allowedProjects)})
        `;
        if (activeProjects.length !== allowedProjects.length) {
          throw remoteMemoryError('conflict', 'The grant references a project outside the active share catalog.');
        }
      }
    });
  }

  async tenantForShare(shareId: string, execution?: RemoteMemoryRequestExecution): Promise<string | undefined> {
    const rows = await this.readDirectory(
      transaction => transaction<{tenant_id: string}[]>`
        SELECT tenant_id FROM remote_memory.share_directory
        WHERE share_id = ${shareId} AND status = 'active'
      `,
      execution,
    );
    return rows[0]?.tenant_id;
  }

  async tenantForIdentity(
    input: {
      readonly issuer: string;
      readonly requestedShareId: string;
      readonly subject: string;
    },
    execution?: RemoteMemoryRequestExecution,
  ): Promise<string | undefined> {
    const tenantId = await this.tenantForShare(input.requestedShareId, execution);
    if (!tenantId) return undefined;
    return this.withTenant(
      tenantId,
      async transaction => {
        const rows = await transaction<{tenant_id: string}[]>`
        SELECT tenant_id FROM remote_memory.external_identities
        WHERE tenant_id = ${tenantId} AND issuer = ${input.issuer} AND subject = ${input.subject}
        LIMIT 1
      `;
        return rows[0]?.tenant_id;
      },
      execution,
    );
  }

  async close(): Promise<void> {
    await this.sql.end({timeout: 5});
  }

  private async readDirectory<A>(
    use: (transaction: TransactionSql) => Promise<A>,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<A> {
    requireActiveRemoteMemoryRequest(execution);
    return (await this.sql.begin(async transaction =>
      withRemoteMemoryRequestCancellation(transaction, execution, async cancellable => {
        const timeout = remoteMemoryDatabaseTimeoutMilliseconds(DATABASE_TIMEOUT_MILLISECONDS, execution);
        await setDatabaseTimeouts(cancellable, timeout);
        return use(cancellable);
      }),
    )) as A;
  }

  private async withTenant<A>(
    tenantId: string,
    use: (transaction: TransactionSql) => Promise<A>,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<A> {
    requireActiveRemoteMemoryRequest(execution);
    return (await this.sql.begin(async transaction => {
      return withRemoteMemoryRequestCancellation(transaction, execution, async cancellable => {
        const timeout = remoteMemoryDatabaseTimeoutMilliseconds(DATABASE_TIMEOUT_MILLISECONDS, execution);
        await setTenant(cancellable, tenantId, timeout);
        return use(cancellable);
      });
    })) as A;
  }
}

export function remoteRetentionPrincipalId(tenantId: string): string {
  return `system:retention:${sha256HexSync(tenantId).slice(0, 32)}`;
}

export function validateRemoteMemoryProvisioningInput(input: RemoteMemoryProvisioningInput): void {
  const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
  const managedShareId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  const cursorOwnerSubject = /^(?:service_account|user):[0-9]{1,128}$/u;
  const decimalIdentifier = /^[0-9]{1,128}$/u;
  for (const [label, value] of [
    ['tenantId', input.tenantId],
    ['shareId', input.shareId],
    ['principalId', input.principalId],
    ['policyVersion', input.policyVersion],
    ['expectedCurrentPolicyVersion', input.expectedCurrentPolicyVersion ?? input.policyVersion],
    ['expectedCurrentSharePolicyVersion', input.expectedCurrentSharePolicyVersion ?? input.policyVersion],
    ['sharePolicyVersion', input.sharePolicyVersion ?? input.policyVersion],
  ] as const) {
    if (!opaqueId.test(value)) throw remoteMemoryError('invalid_request', `Provisioning ${label} is invalid.`);
  }
  if (!managedShareId.test(input.shareId)) {
    throw remoteMemoryError('invalid_request', 'Provisioning shareId is invalid.');
  }
  if (input.principalId.startsWith('system:') || input.principalId === remoteRetentionPrincipalId(input.tenantId)) {
    throw remoteMemoryError(
      'invalid_request',
      'Provisioning principal id is reserved for an internal service identity.',
    );
  }
  if (!input.displayName.trim() || input.displayName.length > 256 || !input.region.trim() || input.region.length > 64) {
    throw remoteMemoryError('invalid_request', 'Provisioning display name or region is invalid.');
  }
  validateProvisioningIdentity(input.issuer, input.subject);
  if (input.capabilities.length === 0 || input.capabilities.some(value => !isRemoteMemoryScope(value))) {
    throw remoteMemoryError('invalid_request', 'Provisioning capabilities are invalid.');
  }
  if (input.featureFlags?.some(value => !isRemoteMemoryFeatureFlag(value))) {
    throw remoteMemoryError('invalid_request', 'Provisioning feature flags are invalid.');
  }
  const requiresCursorIdentity =
    (input.cursorAttestationRequired ?? true) || input.featureFlags?.includes('cursor_oidc_required');
  if (requiresCursorIdentity && (!input.cursorSubjects || input.cursorSubjects.length === 0)) {
    throw remoteMemoryError(
      'invalid_request',
      'Provisioning managed-cloud writes requires at least one trusted Cursor workload subject.',
    );
  }
  for (const subject of input.cursorSubjects ?? []) {
    if (!cursorOwnerSubject.test(subject))
      throw remoteMemoryError('invalid_request', 'Provisioning Cursor subjects are invalid.');
  }
  if (input.cursorOwnerIds?.some(ownerId => !decimalIdentifier.test(ownerId))) {
    throw remoteMemoryError('invalid_request', 'Provisioning Cursor owner ids are invalid.');
  }
  if (input.cursorTeamId !== undefined && !decimalIdentifier.test(input.cursorTeamId)) {
    throw remoteMemoryError('invalid_request', 'Provisioning Cursor team id is invalid.');
  }
  for (const project of input.allowedProjects ?? []) validateProjectName(project);
  for (const project of input.projects ?? []) validateProjectName(project);
  const shareProjects = input.projects ? new Set(input.projects) : undefined;
  for (const [project, repositories] of Object.entries(input.repositoryBindings ?? {})) {
    validateProjectName(project);
    if (shareProjects && !shareProjects.has(project)) {
      throw remoteMemoryError(
        'invalid_request',
        'A repository binding references a project outside the share catalog.',
      );
    }
    for (const repository of repositories) validateRepositoryUrl(repository);
  }
}

function validateProvisioningIdentity(issuer: string, subject: string): void {
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw remoteMemoryError('invalid_request', 'Provisioning issuer is invalid.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    issuer !== parsed.toString().replace(/\/$/u, '')
  ) {
    throw remoteMemoryError('invalid_request', 'Provisioning issuer must be one canonical credential-free HTTPS URL.');
  }
  const hasControlCharacter = [...subject].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!subject.trim() || subject !== subject.trim() || subject.length > 1024 || hasControlCharacter) {
    throw remoteMemoryError('invalid_request', 'Provisioning OAuth subject is invalid.');
  }
}

function provisioningPolicy(input: RemoteMemoryProvisioningInput): {
  readonly digest: string;
  readonly document: Readonly<Record<string, unknown>>;
} {
  const document = {
    allowedProjects: input.allowedProjects ? [...new Set(input.allowedProjects)].sort() : 'all',
    capabilities: [...new Set(input.capabilities)].sort(),
    cursorAttestationRequired: input.cursorAttestationRequired ?? true,
    cursorOwnerIds: [...new Set(input.cursorOwnerIds ?? [])].sort(),
    cursorSubjects: [...new Set(input.cursorSubjects ?? [])].sort(),
  };
  return {
    digest: sha256HexSync(JSON.stringify(document)),
    document,
  };
}

function internalRetentionPolicy(): {
  readonly digest: string;
  readonly document: Readonly<Record<string, unknown>>;
} {
  const document = {capabilities: ['memory:admin'], internal: 'retention'} as const;
  return {digest: sha256HexSync(JSON.stringify(document)), document};
}

function provisioningSharePolicy(input: RemoteMemoryProvisioningInput): {
  readonly digest: string;
  readonly document: Readonly<Record<string, unknown>>;
} {
  const repositoryBindings = Object.fromEntries(
    Object.entries(input.repositoryBindings ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([project, repositories]) => [project, [...new Set(repositories)].sort()]),
  );
  const document = {
    cursorTeamId: input.cursorTeamId ?? null,
    displayName: input.displayName,
    featureFlags: [...new Set(input.featureFlags ?? ['remote_memory_read'])].sort(),
    projects: [...new Set(input.projects ?? Object.keys(repositoryBindings))].sort(),
    repositoryBindings,
  };
  return {digest: sha256HexSync(JSON.stringify(document)), document};
}

function requireCompleteSharePolicy(input: RemoteMemoryProvisioningInput): void {
  if (input.featureFlags === undefined || input.projects === undefined || input.repositoryBindings === undefined) {
    throw remoteMemoryError(
      'invalid_request',
      'Changing share-wide policy requires the complete feature, project, and repository catalog.',
    );
  }
}

function requireNoImplicitSharePolicyChange(input: RemoteMemoryProvisioningInput, stored: unknown): void {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw remoteMemoryError('conflict', 'The stored share-wide policy cannot be safely compared.');
  }
  const document = stored as Readonly<Record<string, unknown>>;
  const explicit = {
    ...(input.cursorTeamId !== undefined ? {cursorTeamId: input.cursorTeamId} : {}),
    displayName: input.displayName,
    ...(input.featureFlags !== undefined ? {featureFlags: [...new Set(input.featureFlags)].sort()} : {}),
    ...(input.projects !== undefined ? {projects: [...new Set(input.projects)].sort()} : {}),
    ...(input.repositoryBindings !== undefined
      ? {
          repositoryBindings: Object.fromEntries(
            Object.entries(input.repositoryBindings)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([project, repositories]) => [project, [...new Set(repositories)].sort()]),
          ),
        }
      : {}),
  };
  for (const [key, value] of Object.entries(explicit)) {
    if (JSON.stringify(document[key]) !== JSON.stringify(value)) {
      throw remoteMemoryError(
        'conflict',
        'Changing share-wide policy requires a new share policy version and exact expected current version.',
      );
    }
  }
}

function validateProjectName(value: string): void {
  try {
    validatePortableSegment(value);
  } catch {
    throw remoteMemoryError('invalid_request', 'Provisioning project name is invalid.');
  }
}

function validateRepositoryUrl(value: string): void {
  try {
    if (!value.includes('://')) throw new Error('repository binding is not a URL');
    canonicalCursorRepositoryBinding(value);
  } catch {
    throw remoteMemoryError('invalid_request', 'Provisioning repository bindings must use credential-free HTTPS URLs.');
  }
}

async function setTenant(transaction: TransactionSql, tenantId: string, timeout = DATABASE_TIMEOUT_MILLISECONDS) {
  await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
  await setDatabaseTimeouts(transaction, timeout);
}

async function setDatabaseTimeouts(transaction: TransactionSql, timeout: number): Promise<void> {
  const milliseconds = String(timeout);
  await transaction`SELECT set_config('statement_timeout', ${milliseconds}, true)`;
  await transaction`SELECT set_config('lock_timeout', ${milliseconds}, true)`;
  await transaction`SELECT set_config('transaction_timeout', ${milliseconds}, true)`;
}

function authorizedPrincipal(row: AuthorizationRow, OAuth: OAuthPrincipalClaims): AuthorizedRemotePrincipal {
  const repositoriesByProject = new Map(
    Object.entries(row.project_repository_bindings ?? {}).map(([project, repositories]) => [
      project,
      new Set(repositories),
    ]),
  );
  return {
    allowedProjects: row.allowed_projects === null ? 'all' : new Set(row.allowed_projects),
    attestationRequiredForWrites: row.cursor_attestation_required || row.feature_flags.includes('cursor_oidc_required'),
    capabilities: new Set(row.capabilities.filter(isRemoteMemoryScope)),
    cursorOwnerIds: new Set(row.cursor_owner_ids),
    cursorSubjects: new Set(row.cursor_subjects),
    cursorTeamId: row.cursor_team_id ?? undefined,
    featureFlags: new Set(row.feature_flags.filter(isRemoteMemoryFeatureFlag)),
    OAuth,
    policyVersion: row.grant_policy_version,
    policyDigest: row.grant_policy_digest,
    principalId: row.principal_id,
    repositoryBindings: new Set([...repositoriesByProject.values()].flatMap(repositories => [...repositories])),
    repositoriesByProject,
    shareId: row.share_id,
    sharePolicyDigest: row.policy_digest,
    sharePolicyVersion: row.policy_version,
    tenantId: row.tenant_id,
  };
}

function isRemoteMemoryScope(value: string): value is RemoteMemoryScope {
  return (
    value === 'memory:admin' ||
    value === 'memory:read' ||
    value === 'memory:write:durable' ||
    value === 'memory:write:handoff'
  );
}

function isRemoteMemoryFeatureFlag(value: string): value is RemoteMemoryFeatureFlag {
  return (
    value === 'remote_memory_read' ||
    value === 'remote_memory_durable_write' ||
    value === 'remote_memory_handoff_write' ||
    value === 'cursor_oidc_required' ||
    value === 'git_beta_import' ||
    value === 'remote_memory_ga'
  );
}

function challengeFromRow(row: ChallengeRow): CursorAttestationChallenge {
  return {
    audience: row.audience,
    challengeId: row.id,
    completionUrl: row.completion_url,
    expiresAt: row.expires_at.toISOString(),
    nonce: row.nonce,
    principalId: row.principal_id,
    shareId: row.share_id,
    tenantId: row.tenant_id,
  };
}

function attestationFromRow(row: AttestationRow): CursorWorkloadAttestation {
  return {
    attestationId: row.id,
    cloudAgentId: row.cloud_agent_id,
    expiresAt: row.expires_at.toISOString(),
    issuer: row.issuer,
    jti: row.jwt_id,
    ownerId: row.owner_id ?? undefined,
    principalId: row.principal_id,
    repositoryUrls: row.repository_urls ?? undefined,
    shareId: row.share_id,
    subject: row.subject,
    teamId: row.team_id ?? undefined,
    tenantId: row.tenant_id,
    turnId: row.turn_id ?? undefined,
  };
}
