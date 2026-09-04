import {Schema} from 'effect';
import type {Sql, TransactionSql} from 'postgres';
import {sha256HexSync} from '../crypto/sha256.js';
import {randomUuidV4} from '../crypto/uuid.js';
import {MEMORY_SCHEMA_VERSION} from '../memory/code_citation.js';
import {
  assertMemoryDocumentSchemaWritable,
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryMetadata,
} from '../memory/document.js';
import {formatRemoteMemoryUri, parseRemoteShareAddress} from '../memory_domain/address.js';
import {inspectRemoteMemoryContent} from '../memory_domain/content.js';
import type {RemoteReadInputV1, RemoteRecallInputV1, RemoteRememberInputV1} from '../memory_domain/contracts.js';
import {transitionRemoteHandoffLifecycle, type RemoteHandoffLifecycleOperation} from '../memory_domain/lifecycle.js';
import {
  formatRemoteMemoryLogicalKey,
  planRemoteMutation,
  REMOTE_MEMORY_REVISION_VERSION,
  type RemoteMemoryHeadV1,
  type RemoteMutationIntentV1,
} from '../memory_domain/revisions.js';
import {
  parseRemoteMemoryReceiptV1,
  REMOTE_MEMORY_RECEIPT_VERSION,
  type RemoteMemoryReceiptV1,
} from '../memory_domain/receipts.js';
import type {AuthorizedRemotePrincipal, RemoteMemoryFeatureFlag, RemoteMemoryScope} from './authorization.js';
import {authorizeCursorClaims, type CursorWorkloadAttestation} from './cursor_oidc.js';
import {RemoteMemoryError, remoteMemoryError, type RemoteMemoryErrorCode} from './errors.js';
import {GitCanonicalMemoryStore, gitCanonicalSharePath} from './git_canonical_store.js';
import {requireJsonValue} from './json.js';
import {
  remoteMemoryDatabaseTimeoutMilliseconds,
  requireActiveRemoteMemoryRequest,
  withRemoteMemoryRequestCancellation,
  type RemoteMemoryRequestExecution,
} from './request_execution.js';

interface ShareStateRow {
  readonly indexed_generation: string | number;
  readonly policy_digest: string;
  readonly policy_version: string;
  readonly share_generation: string | number;
}

interface GrantStateRow extends ShareStateRow {
  readonly allowed_projects: string[] | null;
  readonly capabilities: string[];
  readonly feature_flags: string[];
  readonly grant_policy_version: string;
  readonly grant_policy_digest: string;
}

interface HeadRow {
  readonly canonical_uri: string;
  readonly content_hash: string;
  readonly created_at: Date;
  readonly current_revision_id: string;
  readonly expires_at: Date | null;
  readonly git_commit: string | null;
  readonly git_path: string | null;
  readonly head_id: string;
  readonly kind: 'durable' | 'handoff';
  readonly markdown_body: string;
  readonly project: string;
  readonly retention_class: string | null;
  readonly status: 'active' | 'archived' | 'expired' | 'superseded';
  readonly topic: string;
  readonly updated_at: Date;
}

interface RecallRow extends HeadRow {
  readonly generation: string | number;
  readonly score: string | number;
}

interface IdempotencyRecordRow {
  readonly outcome: unknown | null;
  readonly outcome_expires_at: Date;
  readonly request_hash: string;
}

interface StoredOperationRejectionV1 {
  readonly error: {
    readonly code: RemoteMemoryErrorCode;
    readonly details: Readonly<Record<string, boolean | number | string>>;
    readonly message: string;
  };
  readonly kind: 'rejected';
  readonly version: 1;
}

type OperationReservation =
  {readonly kind: 'execute'} | {readonly kind: 'replay'; readonly receipt: RemoteMemoryReceiptV1};

const IDEMPOTENCY_REPLAY_WINDOW_MILLISECONDS = 24 * 60 * 60_000;
const GIT_INGEST_HYDRATE_LIMIT = 256;

export interface RemoteMemoryReadResult {
  readonly content: string;
  readonly kind: 'durable' | 'handoff';
  readonly project: string;
  readonly receipt: RemoteMemoryReceiptV1;
  readonly status: 'active' | 'archived' | 'expired' | 'superseded';
  readonly topic: string;
  readonly uri: string;
}

export interface RemoteMemoryListEntry {
  readonly kind: 'durable' | 'handoff';
  readonly modifiedAt: string;
  readonly project: string;
  readonly revision: string;
  readonly status: 'active' | 'archived' | 'expired' | 'superseded';
  readonly topic: string;
  readonly uri: string;
}

export interface RemoteMemoryRecallResult {
  readonly excerpt: string;
  readonly kind: 'durable' | 'handoff';
  readonly project: string;
  readonly revision: string;
  readonly score: number;
  readonly status: 'active' | 'archived' | 'expired' | 'superseded';
  readonly topic: string;
  readonly uri: string;
}

export interface RemoteMemoryStatusResult {
  readonly receipt: RemoteMemoryReceiptV1;
  readonly writable: Readonly<{readonly durable: boolean; readonly handoff: boolean}>;
}

export interface RemoteHandoffTransitionInput {
  readonly baseRevision: string;
  readonly operation: RemoteHandoffLifecycleOperation;
  readonly operationId: string;
  readonly uri: string;
}

export class PostgresRemoteMemoryRepository {
  readonly gitStore?: GitCanonicalMemoryStore;
  readonly statementTimeoutMilliseconds: number;

  constructor(
    readonly sql: Sql,
    options: {readonly gitStore?: GitCanonicalMemoryStore; readonly statementTimeoutMilliseconds?: number} = {},
  ) {
    const timeout = options.statementTimeoutMilliseconds ?? 5_000;
    this.gitStore = options.gitStore;
    this.statementTimeoutMilliseconds =
      Number.isSafeInteger(timeout) && timeout >= 100 && timeout <= 120_000 ? timeout : 5_000;
  }

  async status(
    principal: AuthorizedRemotePrincipal,
    requestId: string,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<RemoteMemoryStatusResult> {
    return this.withTenant(
      principal.tenantId,
      async transaction => {
        const state = await requireShareState(transaction, principal);
        return {
          receipt: receipt(principal, state, requestId),
          writable: {
            durable: principalAllows(principal, 'memory:write:durable', 'remote_memory_durable_write'),
            handoff: principalAllows(principal, 'memory:write:handoff', 'remote_memory_handoff_write'),
          },
        };
      },
      execution,
    );
  }

  async read(
    principal: AuthorizedRemotePrincipal,
    input: RemoteReadInputV1,
    requestId: string,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<RemoteMemoryReadResult> {
    const loaded = await this.withTenant(
      principal.tenantId,
      async transaction => {
        const state = await requireShareState(transaction, principal);
        const canonicalUri = await resolveCanonicalUri(transaction, principal, input.uri);
        const project = parseRemoteShareAddress(canonicalUri).project;
        requirePrincipalProject(principal, project);
        await requireActiveProject(transaction, principal, project);
        const rows = input.revision
          ? await transaction<HeadRow[]>`
            SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic, r.id AS current_revision_id,
              r.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path, h.retention_class, h.expires_at,
              h.created_at, r.created_at AS updated_at
            FROM remote_memory.memory_heads h
            JOIN remote_memory.memory_revisions r
              ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.head_id = h.id
            WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
              AND h.canonical_uri = ${canonicalUri} AND r.id = ${input.revision}
          `
          : await transaction<HeadRow[]>`
            SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic, h.current_revision_id,
              h.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path, h.retention_class, h.expires_at,
              h.created_at, h.updated_at
            FROM remote_memory.memory_heads h
            JOIN remote_memory.memory_revisions r
              ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
            WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
              AND h.canonical_uri = ${canonicalUri}
          `;
        const head = rows[0];
        if (!head) throw remoteMemoryError('not_found', 'The remote memory was not found.');
        return {head, state};
      },
      execution,
    );
    return {
      content: await this.revisionBody(loaded.head),
      kind: loaded.head.kind,
      project: loaded.head.project,
      receipt: receipt(principal, loaded.state, requestId, {
        revision: loaded.head.current_revision_id,
        uri: loaded.head.canonical_uri,
      }),
      status: loaded.head.status,
      topic: loaded.head.topic,
      uri: loaded.head.canonical_uri,
    };
  }

  async list(
    principal: AuthorizedRemotePrincipal,
    input: {
      readonly afterUri?: string;
      readonly kinds?: readonly ('durable' | 'handoff')[];
      readonly limit: number;
      readonly project?: string;
      readonly status?: 'active' | 'archived' | 'expired' | 'superseded';
    },
    requestId: string,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<{
    readonly entries: readonly RemoteMemoryListEntry[];
    readonly nextCursor?: string;
    readonly receipt: RemoteMemoryReceiptV1;
  }> {
    return this.withTenant(
      principal.tenantId,
      async transaction => {
        const state = await requireShareState(transaction, principal);
        const kinds = input.kinds ?? ['durable', 'handoff'];
        const allowedProjects = principal.allowedProjects === 'all' ? null : [...principal.allowedProjects];
        const rows = await transaction<HeadRow[]>`
        SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic, h.current_revision_id,
          h.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path, h.retention_class, h.expires_at,
          h.created_at, h.updated_at
        FROM remote_memory.memory_heads h
        JOIN remote_memory.projects p
          ON p.tenant_id = h.tenant_id AND p.share_id = h.share_id AND p.name = h.project AND p.status = 'active'
        JOIN remote_memory.memory_revisions r
          ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
        WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
          AND h.kind = ANY(${transaction.array([...kinds])})
          AND (${allowedProjects ? transaction.array(allowedProjects) : null}::text[] IS NULL
            OR h.project = ANY(${allowedProjects ? transaction.array(allowedProjects) : null}))
          AND (${input.project ?? null}::text IS NULL OR h.project = ${input.project ?? null})
          AND (${input.status ?? null}::text IS NULL OR h.status = ${input.status ?? null})
          AND h.canonical_uri > ${input.afterUri ?? ''}
        ORDER BY h.canonical_uri
        LIMIT ${input.limit + 1}
      `;
        const page = rows.slice(0, input.limit);
        return {
          entries: page.map(head => ({
            kind: head.kind,
            modifiedAt: head.updated_at.toISOString(),
            project: head.project,
            revision: head.current_revision_id,
            status: head.status,
            topic: head.topic,
            uri: head.canonical_uri,
          })),
          ...(rows.length > input.limit && page.at(-1) ? {nextCursor: page.at(-1)!.canonical_uri} : {}),
          receipt: receipt(principal, state, requestId),
        };
      },
      execution,
    );
  }

  async recall(
    principal: AuthorizedRemotePrincipal,
    input: RemoteRecallInputV1,
    requestId: string,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<{readonly receipt: RemoteMemoryReceiptV1; readonly results: readonly RemoteMemoryRecallResult[]}> {
    requirePrincipalProject(principal, input.project);
    const loaded = await this.withTenant(
      principal.tenantId,
      async transaction => {
        const authorizedState = await requireShareState(transaction, principal);
        await requireActiveProject(transaction, principal, input.project);
        const kinds = input.kinds ?? ['durable', 'handoff'];
        const limit = input.limit ?? 10;
        const rows = await transaction<RecallRow[]>`
        WITH share_state AS (
          SELECT indexed_generation FROM remote_memory.shares
          WHERE tenant_id = ${principal.tenantId} AND id = ${principal.shareId} AND status = 'active'
        ), query AS (
          SELECT plainto_tsquery('simple', ${input.query}) AS value
        ), candidates AS (
          SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic,
            h.current_revision_id, h.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path,
            h.retention_class, h.expires_at, h.created_at, h.updated_at,
            d.generation,
            ts_rank_cd(d.searchable, query.value) + CASE WHEN h.kind = 'handoff' THEN 0.02 ELSE 0 END AS score
          FROM remote_memory.search_documents d
          JOIN remote_memory.memory_heads h
            ON h.tenant_id = d.tenant_id AND h.share_id = d.share_id AND h.id = d.head_id
          JOIN remote_memory.memory_revisions r
            ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
          CROSS JOIN query
          WHERE d.tenant_id = ${principal.tenantId} AND d.share_id = ${principal.shareId}
            AND h.project = ${input.project} AND h.kind = ANY(${transaction.array([...kinds])})
            AND h.status = 'active' AND d.revision_id = h.current_revision_id
            AND d.searchable @@ query.value
          UNION ALL
          SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic,
            h.current_revision_id, h.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path,
            h.retention_class, h.expires_at, h.created_at, h.updated_at,
            r.generation,
            ts_rank_cd(to_tsvector('simple', h.project || ' ' || h.topic || ' ' || r.markdown_body), query.value)
              + CASE WHEN h.kind = 'handoff' THEN 0.02 ELSE 0 END + 0.01
          FROM remote_memory.memory_heads h
          JOIN remote_memory.memory_revisions r
            ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
          CROSS JOIN share_state
          CROSS JOIN query
          WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
            AND h.project = ${input.project} AND h.kind = ANY(${transaction.array([...kinds])})
            AND h.status = 'active' AND r.generation > share_state.indexed_generation
            AND to_tsvector('simple', h.project || ' ' || h.topic || ' ' || r.markdown_body) @@ query.value
        )
        SELECT DISTINCT ON (canonical_uri) * FROM (
          SELECT * FROM candidates
          ORDER BY score DESC, generation DESC
          LIMIT ${Math.min(limit * 8, 800)}
        ) bounded_candidates
        ORDER BY canonical_uri, generation DESC, score DESC
      `;
        const ranked = rows.sort(
          (left, right) =>
            numeric(right.score) - numeric(left.score) || left.canonical_uri.localeCompare(right.canonical_uri),
        );
        return {authorizedState, limit, ranked};
      },
      execution,
    );
    const results: RemoteMemoryRecallResult[] = [];
    let hydrates = 0;
    for (const row of loaded.ranked) {
      if (results.length >= loaded.limit || hydrates >= loaded.limit) break;
      hydrates += 1;
      const body = await this.revisionBody(row);
      if (
        row.git_commit &&
        row.markdown_body === '' &&
        !recallTextMatches(`${row.project} ${row.topic} ${body}`, input.query)
      ) {
        continue;
      }
      results.push({
        excerpt: memoryExcerpt(body, input.query),
        kind: row.kind,
        project: row.project,
        revision: row.current_revision_id,
        score: numeric(row.score),
        status: row.status,
        topic: row.topic,
        uri: row.canonical_uri,
      });
    }
    return {
      receipt: receipt(principal, loaded.authorizedState, requestId, {
        overlayUsed:
          numeric(loaded.authorizedState.indexed_generation) < numeric(loaded.authorizedState.share_generation),
      }),
      results,
    };
  }

  async remember(
    principal: AuthorizedRemotePrincipal,
    input: RemoteRememberInputV1,
    requestId: string,
    attestation?: CursorWorkloadAttestation,
    now = new Date(),
    execution?: RemoteMemoryRequestExecution,
  ): Promise<RemoteMemoryReceiptV1> {
    requirePrincipalProject(principal, input.project);
    if (input.lifecycle?.expiresAt && Date.parse(input.lifecycle.expiresAt) <= now.getTime()) {
      throw remoteMemoryError('invalid_request', 'Remote memory expiry must be in the future.');
    }
    const logicalKey = formatRemoteMemoryLogicalKey({
      kind: input.kind,
      project: input.project,
      shareId: principal.shareId,
      tenantId: principal.tenantId,
      topic: input.topic,
      version: REMOTE_MEMORY_REVISION_VERSION,
    });
    const fingerprint = requestFingerprint(principal, input);
    const reservation = await this.reserveOperation(
      principal,
      input.operationId,
      fingerprint,
      requestId,
      now,
      execution,
    );
    if (reservation.kind === 'replay') return reservation.receipt;
    let gitLanded = false;
    try {
      const planned = await this.withTenant(
        principal.tenantId,
        async transaction => {
          await requireShareState(transaction, principal);
          await requireActiveProject(transaction, principal, input.project);
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${logicalKey}, 0))`;
          const current = await this.loadTopicHead(transaction, principal, input.kind, input.project, input.topic);
          if (current?.kind === 'handoff' && current.status !== 'active') {
            throw remoteMemoryError(
              'conflict',
              'A terminal remote handoff cannot be revised; create a new logical handoff.',
              {
                currentRevision: current.current_revision_id,
                currentState: current.status,
                reason: 'terminal_state',
              },
            );
          }
          const share = await requireShareState(transaction, principal);
          requireFreshAttestationPolicy(principal, share, attestation, input.project);
          const proposedRevision = randomUuidV4();
          this.assertRememberDecision(principal, input, current, logicalKey, fingerprint, proposedRevision, share);
          return {
            canonicalUri: formatRemoteMemoryUri({
              kind: input.kind,
              project: input.project,
              shareId: principal.shareId,
              topic: input.topic,
            }),
            current,
            proposedRevision,
          };
        },
        execution,
      );
      const priorBody = planned.current ? await this.revisionBody(planned.current) : undefined;
      const document = makeRemoteDocument(input, planned.current, planned.canonicalUri, attestation, now, priorBody);
      const stored = await this.persistCanonicalBody({
        current: planned.current,
        document,
        kind: input.kind,
        message: `remember ${input.kind} ${input.project}/${input.topic}`,
        project: input.project,
        topic: input.topic,
      });
      gitLanded = stored.gitCommit !== null;
      try {
        return await this.commitRememberRevision({
          attestation,
          canonicalUri: planned.canonicalUri,
          document,
          execution,
          expectedRevision: planned.current?.current_revision_id,
          fingerprint,
          input,
          logicalKey,
          now,
          principal,
          proposedRevision: planned.proposedRevision,
          requestId,
          stored,
        });
      } catch (phase3) {
        if (!gitLanded) throw phase3;
        return await this.commitRememberRevision({
          attestation,
          canonicalUri: planned.canonicalUri,
          document,
          execution,
          expectedRevision: planned.current?.current_revision_id,
          fingerprint,
          input,
          logicalKey,
          now,
          principal,
          proposedRevision: planned.proposedRevision,
          recoverGit: true,
          requestId,
          stored,
        });
      }
    } catch (cause) {
      const conflictAfterGit = gitLanded && Schema.is(RemoteMemoryError)(cause) && cause.code === 'conflict';
      if (!gitLanded || conflictAfterGit) {
        await this.retainRejectedOperation(principal, input.operationId, fingerprint, cause, execution);
      }
      throw cause;
    }
  }

  async transitionHandoff(
    principal: AuthorizedRemotePrincipal,
    input: RemoteHandoffTransitionInput,
    requestId: string,
    attestation?: CursorWorkloadAttestation,
    now = new Date(),
    execution?: RemoteMemoryRequestExecution,
  ): Promise<RemoteMemoryReceiptV1> {
    const address = parseRemoteShareAddress(input.uri);
    if (address.shareId !== principal.shareId || address.kind !== 'handoff') {
      throw remoteMemoryError('forbidden', 'The handoff URI is outside the authorized share.');
    }
    requirePrincipalProject(principal, address.project);
    const fingerprint = lifecycleRequestFingerprint(principal, input);
    const reservation = await this.reserveOperation(
      principal,
      input.operationId,
      fingerprint,
      requestId,
      now,
      execution,
    );
    if (reservation.kind === 'replay') return reservation.receipt;
    const logicalKey = formatRemoteMemoryLogicalKey({
      kind: 'handoff',
      project: address.project,
      shareId: principal.shareId,
      tenantId: principal.tenantId,
      topic: address.topic,
      version: REMOTE_MEMORY_REVISION_VERSION,
    });
    let gitLanded = false;
    try {
      const planned = await this.withTenant(
        principal.tenantId,
        async transaction => {
          await requireShareState(transaction, principal);
          await requireActiveProject(transaction, principal, address.project);
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${logicalKey}, 0))`;
          const current = await this.loadHeadByUri(transaction, principal, address.canonicalUri, 'handoff');
          if (!current) throw remoteMemoryError('not_found', 'The remote handoff was not found.');
          if (current.current_revision_id !== input.baseRevision) {
            throw remoteMemoryError('conflict', 'The remote handoff changed; re-read it before changing lifecycle.', {
              currentRevision: current.current_revision_id,
              reason: 'stale_base',
            });
          }
          const lifecycle = transitionRemoteHandoffLifecycle(current.status, input.operation);
          if (lifecycle.kind === 'rejected') {
            throw remoteMemoryError('conflict', 'The remote handoff lifecycle transition is not allowed.', {
              currentState: lifecycle.from,
              reason: lifecycle.reason,
            });
          }
          const proposedRevision = randomUuidV4();
          const share = await requireShareState(transaction, principal);
          requireFreshAttestationPolicy(principal, share, attestation, address.project);
          const decision = planRemoteMutation({
            currentShareGeneration: numeric(share.share_generation),
            head: {
              logicalKey,
              revision: current.current_revision_id,
              status: current.status,
              version: REMOTE_MEMORY_REVISION_VERSION,
            },
            intent: {
              baseRevision: input.baseRevision,
              fingerprint,
              idempotencyKey: {
                operationId: input.operationId,
                principalId: principal.principalId,
                tenantId: principal.tenantId,
                version: REMOTE_MEMORY_REVISION_VERSION,
              },
              logicalKey,
              proposedRevision,
              version: REMOTE_MEMORY_REVISION_VERSION,
            },
          });
          if (decision.kind !== 'commit') {
            throw remoteMemoryError('conflict', 'The remote handoff lifecycle transition conflicted.');
          }
          return {current, proposedRevision, status: lifecycle.to};
        },
        execution,
      );
      const document = makeLifecycleDocument(
        planned.current,
        planned.status,
        now,
        await this.revisionBody(planned.current),
      );
      const stored = await this.persistCanonicalBody({
        current: planned.current,
        document,
        kind: 'handoff',
        message: `handoff ${input.operation} ${address.project}/${address.topic}`,
        project: address.project,
        topic: address.topic,
      });
      gitLanded = stored.gitCommit !== null;
      try {
        return await this.commitHandoffRevision({
          address,
          attestation,
          document,
          execution,
          fingerprint,
          input,
          logicalKey,
          now,
          planned,
          principal,
          requestId,
          stored,
        });
      } catch (phase3) {
        if (!gitLanded) throw phase3;
        return await this.commitHandoffRevision({
          address,
          attestation,
          document,
          execution,
          fingerprint,
          input,
          logicalKey,
          now,
          planned,
          principal,
          requestId,
          stored,
        });
      }
    } catch (cause) {
      const conflictAfterGit = gitLanded && Schema.is(RemoteMemoryError)(cause) && cause.code === 'conflict';
      if (!gitLanded || conflictAfterGit) {
        await this.retainRejectedOperation(principal, input.operationId, fingerprint, cause, execution);
      }
      throw cause;
    }
  }

  async ingestActiveGitShares(
    requestId: string,
    now = new Date(),
  ): Promise<{readonly ingested: number; readonly skipped: number}> {
    if (!this.gitStore) {
      throw remoteMemoryError('invalid_request', 'Git share ingest requires a git canonical store.');
    }
    const shares = await this.sql<{readonly share_id: string; readonly tenant_id: string}[]>`
      SELECT tenant_id, share_id FROM remote_memory.share_directory
      WHERE status = 'active' ORDER BY tenant_id, share_id
    `;
    let ingested = 0;
    let skipped = 0;
    for (const share of shares) {
      const principal = await this.loadGitIngestPrincipal(share.tenant_id, share.share_id);
      if (!principal) {
        skipped += 1;
        continue;
      }
      const result = await this.ingestGitShare(principal, `${requestId}:${share.share_id}`, now);
      ingested += result.ingested;
      skipped += result.skipped;
    }
    return {ingested, skipped};
  }

  async ingestGitShare(
    principal: AuthorizedRemotePrincipal,
    requestId: string,
    now = new Date(),
  ): Promise<{readonly ingested: number; readonly skipped: number}> {
    const gitStore = this.gitStore;
    if (!gitStore) {
      throw remoteMemoryError('invalid_request', 'Git share ingest requires a git canonical store.');
    }
    const paths = await gitStore.listCanonicalPaths();
    const blobCache = new Map<string, ReadonlyMap<string, string>>();
    const blobsAt = async (commit: string): Promise<ReadonlyMap<string, string>> => {
      const cached = blobCache.get(commit);
      if (cached) return cached;
      const blobs = await gitStore.listBlobIds(commit);
      blobCache.set(commit, blobs);
      return blobs;
    };
    const snapshot = await this.withTenant(principal.tenantId, async transaction => {
      await requireShareState(transaction, principal);
      const heads = await transaction<
        {
          readonly content_hash: string;
          readonly git_commit: string | null;
          readonly git_path: string | null;
          readonly kind: 'durable' | 'handoff';
          readonly project: string;
          readonly status: HeadRow['status'];
          readonly topic: string;
        }[]
      >`
        SELECT h.kind, h.project, h.topic, h.status, r.content_hash, r.git_commit, r.git_path
        FROM remote_memory.memory_heads h
        JOIN remote_memory.memory_revisions r
          ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
        WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
      `;
      const projects = await transaction<{name: string}[]>`
        SELECT name FROM remote_memory.projects
        WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId} AND status = 'active'
      `;
      return {heads, projects: new Set(projects.map(project => project.name))};
    });
    const heads = new Map(snapshot.heads.map(head => [`${head.kind}:${head.project}:${head.topic}`, head] as const));
    let ingested = 0;
    let skipped = 0;
    let hydrates = 0;
    for (const path of paths) {
      if (!principalAllowsProject(principal, path.project) || !snapshot.projects.has(path.project)) {
        skipped += 1;
        continue;
      }
      if (
        (path.kind === 'durable' &&
          !principalAllows(principal, 'memory:write:durable', 'remote_memory_durable_write')) ||
        (path.kind === 'handoff' && !principalAllows(principal, 'memory:write:handoff', 'remote_memory_handoff_write'))
      ) {
        skipped += 1;
        continue;
      }
      const current = heads.get(`${path.kind}:${path.project}:${path.topic}`);
      if (current && current.status !== 'active') {
        skipped += 1;
        continue;
      }
      if (current?.git_commit === path.gitCommit && current.git_path === path.gitPath) {
        skipped += 1;
        continue;
      }
      if (current?.git_commit && current.git_path === path.gitPath) {
        const priorBlob = (await blobsAt(current.git_commit)).get(path.gitPath);
        if (priorBlob === path.blobId) {
          skipped += 1;
          continue;
        }
      }
      if (hydrates >= GIT_INGEST_HYDRATE_LIMIT) {
        skipped += 1;
        continue;
      }
      hydrates += 1;
      const content = await gitStore.read({commit: path.gitCommit, path: path.gitPath});
      const inspected = inspectRemoteMemoryContent(content);
      if (!inspected.allowed) {
        skipped += 1;
        continue;
      }
      const changed = await this.ingestGitFile(
        principal,
        {...path, contentHash: sha256HexSync(content)},
        requestId,
        now,
      );
      if (changed) ingested += 1;
      else skipped += 1;
    }
    return {ingested, skipped};
  }

  private async ingestGitFile(
    principal: AuthorizedRemotePrincipal,
    file: {
      readonly contentHash: string;
      readonly gitCommit: string;
      readonly gitPath: string;
      readonly kind: 'durable' | 'handoff';
      readonly project: string;
      readonly topic: string;
    },
    requestId: string,
    now: Date,
  ): Promise<boolean> {
    return this.withTenant(principal.tenantId, async transaction => {
      await requireShareState(transaction, principal);
      await requireActiveProject(transaction, principal, file.project);
      const logicalKey = formatRemoteMemoryLogicalKey({
        kind: file.kind,
        project: file.project,
        shareId: principal.shareId,
        tenantId: principal.tenantId,
        topic: file.topic,
        version: REMOTE_MEMORY_REVISION_VERSION,
      });
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${logicalKey}, 0))`;
      const currentRows = await transaction<HeadRow[]>`
        SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic, h.current_revision_id,
          h.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path, h.retention_class, h.expires_at,
          h.created_at, h.updated_at
        FROM remote_memory.memory_heads h
        JOIN remote_memory.memory_revisions r
          ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
        WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
          AND h.kind = ${file.kind} AND h.project = ${file.project} AND h.topic = ${file.topic}
        FOR UPDATE OF h
      `;
      const current = currentRows[0];
      if (current && current.status !== 'active') return false;
      if (current?.git_commit === file.gitCommit && current.git_path === file.gitPath) return false;
      if (current?.content_hash === file.contentHash) return false;
      const canonicalUri = formatRemoteMemoryUri({
        kind: file.kind,
        project: file.project,
        shareId: principal.shareId,
        topic: file.topic,
      });
      const headId = current?.head_id ?? randomUuidV4();
      const proposedRevision = randomUuidV4();
      if (!current) {
        await transaction`
          INSERT INTO remote_memory.memory_heads(
            tenant_id, share_id, id, kind, project, topic, canonical_uri, status
          ) VALUES (
            ${principal.tenantId}, ${principal.shareId}, ${headId}, ${file.kind}, ${file.project},
            ${file.topic}, ${canonicalUri}, 'active'
          )
        `;
      }
      const generationRows = await transaction<ShareStateRow[]>`
        UPDATE remote_memory.shares SET share_generation = share_generation + 1
        WHERE tenant_id = ${principal.tenantId} AND id = ${principal.shareId} AND status = 'active'
          AND policy_version = ${principal.sharePolicyVersion}
          AND policy_digest = ${principal.sharePolicyDigest}
        RETURNING share_generation, indexed_generation, policy_version, policy_digest
      `;
      const committedGeneration = generationRows[0];
      if (!committedGeneration) throw remoteMemoryError('forbidden', 'The memory share is no longer active.');
      const committed = await requireShareState(transaction, principal);
      if (numeric(committed.share_generation) !== numeric(committedGeneration.share_generation)) {
        throw remoteMemoryError('service_unavailable', 'The committed memory generation could not be verified.');
      }
      await transaction`
        INSERT INTO remote_memory.memory_revisions(
          tenant_id, share_id, id, head_id, base_revision_id, generation, status,
          markdown_body, content_hash, git_commit, git_path, oauth_principal_id, operation_id
        ) VALUES (
          ${principal.tenantId}, ${principal.shareId}, ${proposedRevision}, ${headId},
          ${current?.current_revision_id ?? null}, ${numeric(committed.share_generation)}, 'active',
          ${''}, ${file.contentHash}, ${file.gitCommit}, ${file.gitPath},
          ${principal.principalId}, ${`git-ingest:${file.gitCommit}:${file.gitPath}`}
        )
      `;
      await transaction`
        UPDATE remote_memory.memory_heads SET
          current_revision_id = ${proposedRevision}, status = 'active', updated_at = ${now.toISOString()}
        WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId} AND id = ${headId}
      `;
      await transaction`
        INSERT INTO remote_memory.outbox_events(
          tenant_id, share_id, id, generation, event_type, aggregate_id
        ) VALUES (
          ${principal.tenantId}, ${principal.shareId}, ${randomUuidV4()},
          ${numeric(committed.share_generation)}, 'memory_head_changed', ${headId}
        )
      `;
      await transaction`
        INSERT INTO remote_memory.audit_events(
          tenant_id, share_id, id, request_id, principal_id, operation, result,
          policy_version, share_policy_version, generation
        ) VALUES (
          ${principal.tenantId}, ${principal.shareId}, ${randomUuidV4()}, ${requestId},
          ${principal.principalId}, 'ingest_git_share', 'committed',
          ${principal.policyVersion}, ${committed.policy_version}, ${numeric(committed.share_generation)}
        )
      `;
      return true;
    });
  }

  private async revisionBody(head: Pick<HeadRow, 'git_commit' | 'git_path' | 'markdown_body'>): Promise<string> {
    if (head.git_commit && head.git_path) {
      if (!this.gitStore) {
        throw remoteMemoryError('service_unavailable', 'The git-canonical memory store is not configured.');
      }
      return this.gitStore.read({commit: head.git_commit, path: head.git_path});
    }
    return head.markdown_body;
  }

  private async persistCanonicalBody(input: {
    readonly current?: HeadRow;
    readonly document: {readonly content: string; readonly contentHash: string};
    readonly kind: 'durable' | 'handoff';
    readonly message: string;
    readonly project: string;
    readonly topic: string;
  }): Promise<{readonly gitCommit: string | null; readonly gitPath: string | null; readonly markdownBody: string}> {
    if (!this.gitStore) {
      return {gitCommit: null, gitPath: null, markdownBody: input.document.content};
    }
    const committed = await this.gitStore.commit({
      content: input.document.content,
      ...(input.current ? {expectedContentHash: input.current.content_hash} : {}),
      message: input.message,
      path: gitCanonicalSharePath(input.kind, input.project, input.topic),
    });
    return {gitCommit: committed.gitCommit, gitPath: committed.gitPath, markdownBody: ''};
  }

  private async loadTopicHead(
    transaction: TransactionSql,
    principal: AuthorizedRemotePrincipal,
    kind: 'durable' | 'handoff',
    project: string,
    topic: string,
  ): Promise<HeadRow | undefined> {
    const rows = await transaction<HeadRow[]>`
      SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic, h.current_revision_id,
        h.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path, h.retention_class, h.expires_at,
        h.created_at, h.updated_at
      FROM remote_memory.memory_heads h
      JOIN remote_memory.memory_revisions r
        ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
      WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
        AND h.kind = ${kind} AND h.project = ${project} AND h.topic = ${topic}
      FOR UPDATE OF h
    `;
    return rows[0];
  }

  private async loadHeadByUri(
    transaction: TransactionSql,
    principal: AuthorizedRemotePrincipal,
    canonicalUri: string,
    kind: 'durable' | 'handoff',
  ): Promise<HeadRow | undefined> {
    const rows = await transaction<HeadRow[]>`
      SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic, h.current_revision_id,
        h.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path, h.retention_class, h.expires_at,
        h.created_at, h.updated_at
      FROM remote_memory.memory_heads h
      JOIN remote_memory.memory_revisions r
        ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
      WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
        AND h.canonical_uri = ${canonicalUri} AND h.kind = ${kind}
      FOR UPDATE OF h
    `;
    return rows[0];
  }

  private assertRememberDecision(
    principal: AuthorizedRemotePrincipal,
    input: RemoteRememberInputV1,
    current: HeadRow | undefined,
    logicalKey: string,
    fingerprint: string,
    proposedRevision: string,
    share: ShareStateRow,
  ): void {
    const intent: RemoteMutationIntentV1 = {
      ...(input.baseRevision ? {baseRevision: input.baseRevision} : {}),
      fingerprint,
      idempotencyKey: {
        operationId: input.operationId,
        principalId: principal.principalId,
        tenantId: principal.tenantId,
        version: REMOTE_MEMORY_REVISION_VERSION,
      },
      logicalKey,
      proposedRevision,
      version: REMOTE_MEMORY_REVISION_VERSION,
    };
    const head: RemoteMemoryHeadV1 | undefined = current
      ? {
          logicalKey,
          revision: current.current_revision_id,
          status: current.status,
          version: REMOTE_MEMORY_REVISION_VERSION,
        }
      : undefined;
    const decision = planRemoteMutation({
      currentShareGeneration: numeric(share.share_generation),
      head,
      intent,
    });
    if (decision.kind === 'conflict') {
      throw remoteMemoryError(
        'conflict',
        'The remote memory changed; re-read it and retry with its current revision.',
        {
          ...(decision.currentRevision ? {currentRevision: decision.currentRevision} : {}),
          reason: decision.reason,
          shareGeneration: decision.shareGeneration,
        },
      );
    }
    if (decision.kind !== 'commit') {
      throw remoteMemoryError('service_unavailable', 'The remote mutation could not be planned.');
    }
  }

  private async commitRememberRevision(input: {
    readonly attestation?: CursorWorkloadAttestation;
    readonly canonicalUri: string;
    readonly document: {readonly contentHash: string};
    readonly execution?: RemoteMemoryRequestExecution;
    readonly expectedRevision?: string;
    readonly fingerprint: string;
    readonly input: RemoteRememberInputV1;
    readonly logicalKey: string;
    readonly now: Date;
    readonly principal: AuthorizedRemotePrincipal;
    readonly proposedRevision: string;
    readonly recoverGit?: boolean;
    readonly requestId: string;
    readonly stored: {
      readonly gitCommit: string | null;
      readonly gitPath: string | null;
      readonly markdownBody: string;
    };
  }): Promise<RemoteMemoryReceiptV1> {
    return this.withTenant(
      input.principal.tenantId,
      async transaction => {
        await requireShareState(transaction, input.principal);
        await requireActiveProject(transaction, input.principal, input.input.project);
        await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.logicalKey}, 0))`;
        const current = await this.loadTopicHead(
          transaction,
          input.principal,
          input.input.kind,
          input.input.project,
          input.input.topic,
        );
        if (current?.content_hash === input.document.contentHash) {
          return this.recordExistingRememberOutcome(transaction, input, current);
        }
        if (input.recoverGit && input.stored.gitCommit && current?.git_commit === input.stored.gitCommit) {
          return this.recordExistingRememberOutcome(transaction, input, current);
        }
        if (current && current.current_revision_id !== input.expectedRevision) {
          throw remoteMemoryError(
            'conflict',
            'The remote memory changed; re-read it and retry with its current revision.',
            {
              currentRevision: current.current_revision_id,
              reason: 'stale_base',
            },
          );
        }
        const share = await requireShareState(transaction, input.principal);
        requireFreshAttestationPolicy(input.principal, share, input.attestation, input.input.project);
        const headId = current?.head_id ?? randomUuidV4();
        if (!current) {
          await transaction`
            INSERT INTO remote_memory.memory_heads(
              tenant_id, share_id, id, kind, project, topic, canonical_uri, status,
              retention_class, expires_at
            ) VALUES (
              ${input.principal.tenantId}, ${input.principal.shareId}, ${headId}, ${input.input.kind},
              ${input.input.project}, ${input.input.topic}, ${input.canonicalUri}, 'active',
              ${input.input.lifecycle?.retentionClass ?? null}, ${input.input.lifecycle?.expiresAt ?? null}
            )
          `;
        }
        return this.finishRememberRevision(transaction, input, current, headId, 'active');
      },
      input.execution,
    );
  }

  private async recordExistingRememberOutcome(
    transaction: TransactionSql,
    input: {
      readonly attestation?: CursorWorkloadAttestation;
      readonly canonicalUri: string;
      readonly fingerprint: string;
      readonly input: RemoteRememberInputV1;
      readonly principal: AuthorizedRemotePrincipal;
      readonly requestId: string;
    },
    current: HeadRow,
  ): Promise<RemoteMemoryReceiptV1> {
    const committed = await requireShareState(transaction, input.principal);
    const result = receipt(input.principal, committed, input.requestId, {
      actor: mutationActor(input.principal, input.attestation),
      revision: current.current_revision_id,
      uri: input.canonicalUri,
    });
    await this.recordIdempotentOutcome(
      transaction,
      input.principal,
      input.input.operationId,
      input.fingerprint,
      result,
    );
    return result;
  }

  private async finishRememberRevision(
    transaction: TransactionSql,
    input: {
      readonly attestation?: CursorWorkloadAttestation;
      readonly canonicalUri: string;
      readonly document: {readonly contentHash: string};
      readonly fingerprint: string;
      readonly input: RemoteRememberInputV1;
      readonly now: Date;
      readonly principal: AuthorizedRemotePrincipal;
      readonly proposedRevision: string;
      readonly requestId: string;
      readonly stored: {
        readonly gitCommit: string | null;
        readonly gitPath: string | null;
        readonly markdownBody: string;
      };
    },
    current: HeadRow | undefined,
    headId: string,
    status: HeadRow['status'],
  ): Promise<RemoteMemoryReceiptV1> {
    const generationRows = await transaction<ShareStateRow[]>`
      UPDATE remote_memory.shares SET share_generation = share_generation + 1
      WHERE tenant_id = ${input.principal.tenantId} AND id = ${input.principal.shareId} AND status = 'active'
        AND policy_version = ${input.principal.sharePolicyVersion}
        AND policy_digest = ${input.principal.sharePolicyDigest}
      RETURNING share_generation, indexed_generation, policy_version, policy_digest
    `;
    const committedGeneration = generationRows[0];
    if (!committedGeneration) throw remoteMemoryError('forbidden', 'The memory share is no longer active.');
    const committed = await requireShareState(transaction, input.principal);
    if (numeric(committed.share_generation) !== numeric(committedGeneration.share_generation)) {
      throw remoteMemoryError('service_unavailable', 'The committed memory generation could not be verified.');
    }
    requireFreshAttestationPolicy(input.principal, committed, input.attestation, input.input.project);
    await transaction`
      INSERT INTO remote_memory.memory_revisions(
        tenant_id, share_id, id, head_id, base_revision_id, generation, status,
        markdown_body, content_hash, git_commit, git_path, oauth_principal_id, workload_attestation_id, operation_id
      ) VALUES (
        ${input.principal.tenantId}, ${input.principal.shareId}, ${input.proposedRevision}, ${headId},
        ${input.input.baseRevision ?? current?.current_revision_id ?? null}, ${numeric(committed.share_generation)},
        ${status}, ${input.stored.markdownBody}, ${input.document.contentHash}, ${input.stored.gitCommit},
        ${input.stored.gitPath}, ${input.principal.principalId}, ${input.attestation?.attestationId ?? null},
        ${input.input.operationId}
      )
    `;
    await transaction`
      UPDATE remote_memory.memory_heads SET
        current_revision_id = ${input.proposedRevision}, status = ${status},
        retention_class = ${input.input.lifecycle?.retentionClass ?? current?.retention_class ?? null},
        expires_at = ${input.input.lifecycle?.expiresAt ?? current?.expires_at?.toISOString() ?? null},
        updated_at = ${input.now.toISOString()}
      WHERE tenant_id = ${input.principal.tenantId} AND share_id = ${input.principal.shareId} AND id = ${headId}
    `;
    const result = receipt(input.principal, committed, input.requestId, {
      actor: mutationActor(input.principal, input.attestation),
      revision: input.proposedRevision,
      uri: input.canonicalUri,
    });
    await transaction`
      INSERT INTO remote_memory.outbox_events(
        tenant_id, share_id, id, generation, event_type, aggregate_id
      ) VALUES (
        ${input.principal.tenantId}, ${input.principal.shareId}, ${randomUuidV4()},
        ${numeric(committed.share_generation)}, 'memory_head_changed', ${headId}
      )
    `;
    await transaction`
      INSERT INTO remote_memory.audit_events(
        tenant_id, share_id, id, request_id, principal_id, workload_attestation_id,
        operation, result, policy_version, share_policy_version, generation
      ) VALUES (
        ${input.principal.tenantId}, ${input.principal.shareId}, ${randomUuidV4()}, ${input.requestId},
        ${input.principal.principalId}, ${input.attestation?.attestationId ?? null}, 'remember_context', 'committed',
        ${input.principal.policyVersion}, ${committed.policy_version}, ${numeric(committed.share_generation)}
      )
    `;
    await this.recordIdempotentOutcome(
      transaction,
      input.principal,
      input.input.operationId,
      input.fingerprint,
      result,
    );
    return result;
  }

  private async commitHandoffRevision(input: {
    readonly address: {readonly project: string; readonly topic: string};
    readonly attestation?: CursorWorkloadAttestation;
    readonly document: {readonly contentHash: string};
    readonly execution?: RemoteMemoryRequestExecution;
    readonly fingerprint: string;
    readonly input: RemoteHandoffTransitionInput;
    readonly logicalKey: string;
    readonly now: Date;
    readonly planned: {
      readonly current: HeadRow;
      readonly proposedRevision: string;
      readonly status: HeadRow['status'];
    };
    readonly principal: AuthorizedRemotePrincipal;
    readonly requestId: string;
    readonly stored: {
      readonly gitCommit: string | null;
      readonly gitPath: string | null;
      readonly markdownBody: string;
    };
  }): Promise<RemoteMemoryReceiptV1> {
    return this.withTenant(
      input.principal.tenantId,
      async transaction => {
        await requireShareState(transaction, input.principal);
        await requireActiveProject(transaction, input.principal, input.address.project);
        await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.logicalKey}, 0))`;
        const current = await this.loadHeadByUri(
          transaction,
          input.principal,
          input.planned.current.canonical_uri,
          'handoff',
        );
        if (!current) throw remoteMemoryError('not_found', 'The remote handoff was not found.');
        if (current.content_hash === input.document.contentHash && current.status === input.planned.status) {
          const committed = await requireShareState(transaction, input.principal);
          const result = receipt(input.principal, committed, input.requestId, {
            actor: mutationActor(input.principal, input.attestation),
            revision: current.current_revision_id,
            uri: current.canonical_uri,
          });
          await this.recordIdempotentOutcome(
            transaction,
            input.principal,
            input.input.operationId,
            input.fingerprint,
            result,
          );
          return result;
        }
        if (current.current_revision_id !== input.input.baseRevision) {
          throw remoteMemoryError('conflict', 'The remote handoff changed; re-read it before changing lifecycle.', {
            currentRevision: current.current_revision_id,
            reason: 'stale_base',
          });
        }
        const generationRows = await transaction<ShareStateRow[]>`
          UPDATE remote_memory.shares SET share_generation = share_generation + 1
          WHERE tenant_id = ${input.principal.tenantId} AND id = ${input.principal.shareId} AND status = 'active'
            AND policy_version = ${input.principal.sharePolicyVersion}
            AND policy_digest = ${input.principal.sharePolicyDigest}
          RETURNING share_generation, indexed_generation, policy_version, policy_digest
        `;
        const committedGeneration = generationRows[0];
        if (!committedGeneration) throw remoteMemoryError('forbidden', 'The memory share is no longer active.');
        const committed = await requireShareState(transaction, input.principal);
        if (numeric(committed.share_generation) !== numeric(committedGeneration.share_generation)) {
          throw remoteMemoryError('service_unavailable', 'The committed memory generation could not be verified.');
        }
        requireFreshAttestationPolicy(input.principal, committed, input.attestation, input.address.project);
        await transaction`
          INSERT INTO remote_memory.memory_revisions(
            tenant_id, share_id, id, head_id, base_revision_id, generation, status,
            markdown_body, content_hash, git_commit, git_path, oauth_principal_id, workload_attestation_id, operation_id
          ) VALUES (
            ${input.principal.tenantId}, ${input.principal.shareId}, ${input.planned.proposedRevision}, ${current.head_id},
            ${input.input.baseRevision}, ${numeric(committed.share_generation)}, ${input.planned.status},
            ${input.stored.markdownBody}, ${input.document.contentHash}, ${input.stored.gitCommit}, ${input.stored.gitPath},
            ${input.principal.principalId}, ${input.attestation?.attestationId ?? null}, ${input.input.operationId}
          )
        `;
        await transaction`
          UPDATE remote_memory.memory_heads
          SET current_revision_id = ${input.planned.proposedRevision}, status = ${input.planned.status},
            updated_at = ${input.now.toISOString()}
          WHERE tenant_id = ${input.principal.tenantId} AND share_id = ${input.principal.shareId} AND id = ${current.head_id}
        `;
        const result = receipt(input.principal, committed, input.requestId, {
          actor: mutationActor(input.principal, input.attestation),
          revision: input.planned.proposedRevision,
          uri: current.canonical_uri,
        });
        await transaction`
          INSERT INTO remote_memory.outbox_events(
            tenant_id, share_id, id, generation, event_type, aggregate_id
          ) VALUES (
            ${input.principal.tenantId}, ${input.principal.shareId}, ${randomUuidV4()},
            ${numeric(committed.share_generation)}, 'memory_head_changed', ${current.head_id}
          )
        `;
        await transaction`
          INSERT INTO remote_memory.audit_events(
            tenant_id, share_id, id, request_id, principal_id, workload_attestation_id,
            operation, result, policy_version, share_policy_version, generation
          ) VALUES (
            ${input.principal.tenantId}, ${input.principal.shareId}, ${randomUuidV4()}, ${input.requestId},
            ${input.principal.principalId}, ${input.attestation?.attestationId ?? null},
            ${`handoff_${input.input.operation}`}, 'committed', ${input.principal.policyVersion},
            ${committed.policy_version}, ${numeric(committed.share_generation)}
          )
        `;
        await this.recordIdempotentOutcome(
          transaction,
          input.principal,
          input.input.operationId,
          input.fingerprint,
          result,
        );
        return result;
      },
      input.execution,
    );
  }

  private async recordIdempotentOutcome(
    transaction: TransactionSql,
    principal: AuthorizedRemotePrincipal,
    operationId: string,
    fingerprint: string,
    result: RemoteMemoryReceiptV1,
  ): Promise<void> {
    const recordedOutcomes = await transaction<{operation_id: string}[]>`
      UPDATE remote_memory.idempotency_records SET outcome = ${transaction.json(result)}
      WHERE tenant_id = ${principal.tenantId} AND principal_id = ${principal.principalId}
        AND operation_id = ${operationId} AND request_hash = ${fingerprint}
      RETURNING operation_id
    `;
    if (!recordedOutcomes[0]) {
      throw remoteMemoryError('service_unavailable', 'The remote operation outcome could not be recorded.');
    }
  }

  private async loadGitIngestPrincipal(
    tenantId: string,
    shareId: string,
  ): Promise<AuthorizedRemotePrincipal | undefined> {
    return this.withTenant(tenantId, async transaction => {
      const rows = await transaction<
        {
          readonly allowed_projects: string[] | null;
          readonly capabilities: string[];
          readonly feature_flags: string[];
          readonly grant_policy_digest: string;
          readonly grant_policy_version: string;
          readonly principal_id: string;
          readonly share_policy_digest: string;
          readonly share_policy_version: string;
        }[]
      >`
        SELECT g.principal_id, g.capabilities, g.allowed_projects,
          g.policy_version AS grant_policy_version, g.policy_digest AS grant_policy_digest,
          s.policy_version AS share_policy_version, s.policy_digest AS share_policy_digest,
          s.feature_flags
        FROM remote_memory.shares s
        JOIN remote_memory.share_grants g
          ON g.tenant_id = s.tenant_id AND g.share_id = s.id AND g.status = 'active'
        WHERE s.tenant_id = ${tenantId} AND s.id = ${shareId} AND s.status = 'active'
          AND (
            g.capabilities && ARRAY['memory:write:durable', 'memory:write:handoff', 'memory:admin']::text[]
          )
        ORDER BY g.principal_id
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return undefined;
      const capabilities = new Set(row.capabilities as RemoteMemoryScope[]);
      return {
        allowedProjects: row.allowed_projects === null ? 'all' : new Set(row.allowed_projects),
        attestationRequiredForWrites: false,
        capabilities,
        cursorOwnerIds: new Set(),
        cursorSubjects: new Set(),
        featureFlags: new Set(row.feature_flags as RemoteMemoryFeatureFlag[]),
        OAuth: {
          issuer: 'threadnote:git-ingest',
          scopes: capabilities,
          subject: 'system:git-ingest',
        },
        policyDigest: row.grant_policy_digest,
        policyVersion: row.grant_policy_version,
        principalId: row.principal_id,
        repositoryBindings: new Set(),
        repositoriesByProject: new Map(),
        shareId,
        sharePolicyDigest: row.share_policy_digest,
        sharePolicyVersion: row.share_policy_version,
        tenantId,
      };
    });
  }

  private async reserveOperation(
    principal: AuthorizedRemotePrincipal,
    operationId: string,
    fingerprint: string,
    requestId: string,
    now: Date,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<OperationReservation> {
    return this.withTenant(
      principal.tenantId,
      async transaction => {
        const expiresAt = new Date(now.getTime() + IDEMPOTENCY_REPLAY_WINDOW_MILLISECONDS).toISOString();
        const ambiguousOutcome = storedOperationRejection(
          remoteMemoryError(
            'service_unavailable',
            'The operation outcome is unavailable and will not be re-executed.',
            {
              reason: 'outcome_ambiguous',
            },
          ),
        );
        const inserted = await transaction<{request_hash: string}[]>`
        INSERT INTO remote_memory.idempotency_records(
          tenant_id, share_id, principal_id, operation_id, request_hash, outcome, outcome_expires_at
        ) VALUES (
          ${principal.tenantId}, ${principal.shareId}, ${principal.principalId},
          ${operationId}, ${fingerprint}, ${transaction.json(requireJsonValue(ambiguousOutcome))}, ${expiresAt}
        ) ON CONFLICT DO NOTHING
        RETURNING request_hash
      `;
        if (inserted[0]) return {kind: 'execute'};

        const records = await transaction<IdempotencyRecordRow[]>`
        SELECT request_hash, outcome, outcome_expires_at
        FROM remote_memory.idempotency_records
        WHERE tenant_id = ${principal.tenantId} AND principal_id = ${principal.principalId}
          AND operation_id = ${operationId}
        FOR UPDATE
      `;
        const record = records[0];
        if (!record || record.request_hash !== fingerprint) {
          throw remoteMemoryError('idempotency_mismatch', 'The operation id was already used for a different request.');
        }
        if (record.outcome_expires_at.getTime() <= now.getTime()) {
          throw remoteMemoryError('idempotency_mismatch', 'The operation replay outcome is no longer retained.', {
            reason: 'outcome_expired',
            replayWindowHours: IDEMPOTENCY_REPLAY_WINDOW_MILLISECONDS / 3_600_000,
          });
        }
        if (record.outcome !== null) {
          const replay = readStoredOperationOutcome(record.outcome, requestId);
          if (Schema.is(RemoteMemoryError)(replay)) throw replay;
          return {kind: 'replay', receipt: replay};
        }
        throw remoteMemoryError(
          'service_unavailable',
          'The operation outcome is unavailable and will not be re-executed.',
          {
            reason: 'outcome_ambiguous',
          },
        );
      },
      execution,
    );
  }

  private async retainRejectedOperation(
    principal: AuthorizedRemotePrincipal,
    operationId: string,
    fingerprint: string,
    cause: unknown,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<void> {
    const error = Schema.is(RemoteMemoryError)(cause)
      ? cause
      : remoteMemoryError('service_unavailable', 'Remote memory could not complete the request.');
    const rejection = storedOperationRejection(error);
    try {
      await this.withTenant(
        principal.tenantId,
        async transaction => {
          await transaction`
            UPDATE remote_memory.idempotency_records
            SET outcome = ${transaction.json(requireJsonValue(rejection))}
            WHERE tenant_id = ${principal.tenantId} AND principal_id = ${principal.principalId}
              AND operation_id = ${operationId} AND request_hash = ${fingerprint}
              AND outcome->>'kind' = 'rejected'
              AND outcome->'error'->'details'->>'reason' = 'outcome_ambiguous'
          `;
        },
        execution,
      );
    } catch {
      // The durable request-hash tombstone still prevents reuse or re-execution.
    }
  }

  private async withTenant<A>(
    tenantId: string,
    use: (transaction: TransactionSql) => Promise<A>,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<A> {
    requireActiveRemoteMemoryRequest(execution);
    return await this.sql.begin<Promise<A>>(async transaction =>
      withRemoteMemoryRequestCancellation(transaction, execution, async cancellableTransaction => {
        const timeout = remoteMemoryDatabaseTimeoutMilliseconds(this.statementTimeoutMilliseconds, execution);
        await cancellableTransaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
        await cancellableTransaction`SELECT set_config('statement_timeout', ${String(timeout)}, true)`;
        await cancellableTransaction`SELECT set_config('lock_timeout', ${String(timeout)}, true)`;
        await cancellableTransaction`SELECT set_config('transaction_timeout', ${String(timeout)}, true)`;
        return use(cancellableTransaction);
      }),
    );
  }
}

function readStoredOperationOutcome(outcome: unknown, requestId: string): RemoteMemoryReceiptV1 | RemoteMemoryError {
  if (isStoredOperationRejection(outcome)) {
    return remoteMemoryError(outcome.error.code, outcome.error.message, outcome.error.details);
  }
  return {...parseRemoteMemoryReceiptV1(outcome), requestId};
}

function storedOperationRejection(error: RemoteMemoryError): StoredOperationRejectionV1 {
  return {
    error: {code: error.code, details: error.details, message: error.message},
    kind: 'rejected',
    version: 1,
  };
}

function isStoredOperationRejection(value: unknown): value is StoredOperationRejectionV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const error = 'error' in value ? value.error : undefined;
  return (
    'kind' in value &&
    value.kind === 'rejected' &&
    'version' in value &&
    value.version === 1 &&
    typeof error === 'object' &&
    error !== null &&
    !Array.isArray(error) &&
    'code' in error &&
    isRemoteMemoryErrorCode(error.code) &&
    'message' in error &&
    typeof error.message === 'string' &&
    'details' in error &&
    typeof error.details === 'object' &&
    error.details !== null &&
    !Array.isArray(error.details)
  );
}

function isRemoteMemoryErrorCode(value: unknown): value is RemoteMemoryErrorCode {
  return (
    value === 'attestation_required' ||
    value === 'conflict' ||
    value === 'forbidden' ||
    value === 'idempotency_mismatch' ||
    value === 'invalid_request' ||
    value === 'not_found' ||
    value === 'rate_limited' ||
    value === 'service_unavailable' ||
    value === 'unauthorized'
  );
}

async function resolveCanonicalUri(
  transaction: TransactionSql,
  principal: AuthorizedRemotePrincipal,
  inputUri: string,
): Promise<string> {
  try {
    const address = parseRemoteShareAddress(inputUri);
    if (address.shareId !== principal.shareId)
      throw remoteMemoryError('forbidden', 'The URI belongs to another share.');
    return address.canonicalUri;
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'RemoteMemoryError') throw cause;
  }
  const aliases = await transaction<{canonical_uri: string}[]>`
    SELECT canonical_uri FROM remote_memory.uri_aliases
    WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId} AND alias_uri = ${inputUri}
      AND (expires_at IS NULL OR expires_at > now())
  `;
  const canonicalUri = aliases[0]?.canonical_uri;
  if (!canonicalUri || parseRemoteShareAddress(canonicalUri).shareId !== principal.shareId) {
    throw remoteMemoryError('not_found', 'The remote memory was not found.');
  }
  return canonicalUri;
}

async function requireShareState(
  transaction: TransactionSql,
  principal: AuthorizedRemotePrincipal,
): Promise<GrantStateRow> {
  const rows = await transaction<GrantStateRow[]>`
    SELECT s.share_generation, s.indexed_generation, s.policy_version, s.policy_digest,
      s.feature_flags, g.capabilities, g.allowed_projects, g.policy_version AS grant_policy_version,
      g.policy_digest AS grant_policy_digest
    FROM remote_memory.shares s
    JOIN remote_memory.tenants t ON t.id = s.tenant_id AND t.status = 'active'
    JOIN remote_memory.tenant_memberships m
      ON m.tenant_id = s.tenant_id AND m.principal_id = ${principal.principalId} AND m.status = 'active'
    JOIN remote_memory.share_grants g
      ON g.tenant_id = s.tenant_id AND g.share_id = s.id
      AND g.principal_id = m.principal_id AND g.status = 'active'
    JOIN remote_memory.principals p
      ON p.tenant_id = m.tenant_id AND p.id = m.principal_id AND p.status = 'active'
    WHERE s.tenant_id = ${principal.tenantId} AND s.id = ${principal.shareId} AND s.status = 'active'
  `;
  const state = rows[0];
  if (!state) throw remoteMemoryError('forbidden', 'The memory share grant is not active.');
  const allowedProjects = state.allowed_projects === null ? 'all' : new Set(state.allowed_projects);
  if (!sameSetOrAll(principal.allowedProjects, allowedProjects)) {
    throw remoteMemoryError('forbidden', 'The memory share grant changed; authenticate again.');
  }
  if (
    state.grant_policy_version !== principal.policyVersion ||
    state.grant_policy_digest !== principal.policyDigest ||
    state.policy_version !== principal.sharePolicyVersion ||
    state.policy_digest !== principal.sharePolicyDigest ||
    !setContains(state.capabilities, principal.capabilities) ||
    !setContains(state.feature_flags, principal.featureFlags)
  ) {
    throw remoteMemoryError('forbidden', 'The memory share policy changed; authenticate again.');
  }
  return state;
}

function sameSetOrAll(left: ReadonlySet<string> | 'all', right: ReadonlySet<string> | 'all'): boolean {
  if (left === 'all' || right === 'all') return left === right;
  return left.size === right.size && [...left].every(value => right.has(value));
}

function setContains(current: readonly string[], authorized: ReadonlySet<string>): boolean {
  const values = new Set(current);
  return [...authorized].every(value => values.has(value));
}

function receipt(
  principal: AuthorizedRemotePrincipal,
  state: ShareStateRow,
  requestId: string,
  extra: Partial<Pick<RemoteMemoryReceiptV1, 'actor' | 'revision' | 'uri'>> & {
    readonly overlayUsed?: boolean;
  } = {},
): RemoteMemoryReceiptV1 {
  const shareGeneration = numeric(state.share_generation);
  const indexedGeneration = numeric(state.indexed_generation);
  const {overlayUsed, ...receiptFields} = extra;
  return {
    ...receiptFields,
    consistency:
      indexedGeneration === shareGeneration
        ? 'current'
        : extra.revision || overlayUsed
          ? 'recent-write-overlay'
          : 'stale-index',
    indexedGeneration,
    policyVersion: principal.policyVersion,
    sharePolicyVersion: state.policy_version,
    requestId,
    shareGeneration,
    shareId: principal.shareId,
    tenantId: principal.tenantId,
    version: REMOTE_MEMORY_RECEIPT_VERSION,
  };
}

function makeRemoteDocument(
  input: RemoteRememberInputV1,
  current: HeadRow | undefined,
  uri: string,
  attestation: CursorWorkloadAttestation | undefined,
  now: Date,
  priorBody: string | undefined,
): {readonly content: string; readonly contentHash: string} {
  const timestamp = now.toISOString();
  const prior = current && priorBody ? parseMemoryDocument(uri, priorBody) : undefined;
  if (current && priorBody) assertMemoryDocumentSchemaWritable(priorBody);
  const metadata: MemoryMetadata = {
    createdAt: prior?.metadata.createdAt ?? prior?.metadata.timestamp ?? timestamp,
    kind: input.kind,
    memoryId: prior?.metadata.memoryId ?? `tn_${randomUuidV4().replaceAll('-', '')}`,
    project: input.project,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceAgentClient: attestation ? 'cursor' : 'remote',
    status: 'active',
    timestamp,
    topic: input.topic,
    updatedAt: timestamp,
    visibility: 'shared',
  };
  const formatted = formatMemoryDocument(input.kind === 'handoff' ? 'HANDOFF' : 'MEMORY', metadata, input.text.trim());
  const inspected = inspectRemoteMemoryContent(formatted);
  if (!inspected.allowed) {
    throw remoteMemoryError('invalid_request', `Remote memory content was blocked by ${inspected.category} policy.`);
  }
  return {
    content: inspected.canonicalContent,
    contentHash: sha256HexSync(inspected.canonicalContent),
  };
}

function requestFingerprint(principal: AuthorizedRemotePrincipal, input: RemoteRememberInputV1): string {
  // Attestation IDs are renewable authorization proofs, not mutation intent.
  // A retried operation must replay its original committed actor after renewal.
  return sha256HexSync(
    JSON.stringify({
      baseRevision: input.baseRevision ?? null,
      kind: input.kind,
      lifecycle: input.lifecycle ?? null,
      operationId: input.operationId,
      project: input.project,
      shareId: principal.shareId,
      text: input.text,
      topic: input.topic,
      version: input.version,
    }),
  );
}

function lifecycleRequestFingerprint(
  principal: AuthorizedRemotePrincipal,
  input: RemoteHandoffTransitionInput,
): string {
  return sha256HexSync(
    JSON.stringify({
      baseRevision: input.baseRevision,
      operation: input.operation,
      operationId: input.operationId,
      shareId: principal.shareId,
      uri: input.uri,
      version: 1,
    }),
  );
}

function makeLifecycleDocument(
  current: HeadRow,
  status: 'active' | 'archived' | 'expired' | 'superseded',
  now: Date,
  priorBody = current.markdown_body,
): {readonly content: string; readonly contentHash: string} {
  const prior = parseMemoryDocument(current.canonical_uri, priorBody);
  if (!prior || prior.headerTitle !== 'HANDOFF') {
    throw remoteMemoryError('service_unavailable', 'The stored remote handoff document is invalid.');
  }
  const content = formatMemoryDocument(
    'HANDOFF',
    {
      ...prior.metadata,
      status,
      updatedAt: now.toISOString(),
    },
    prior.body,
  );
  const inspected = inspectRemoteMemoryContent(content);
  if (!inspected.allowed) {
    throw remoteMemoryError('service_unavailable', 'The stored remote handoff no longer passes content policy.');
  }
  return {
    content: inspected.canonicalContent,
    contentHash: sha256HexSync(inspected.canonicalContent),
  };
}

function memoryExcerpt(content: string, query: string): string {
  const record = parseMemoryDocument('threadnote://share/excerpt/memories/durable/project/topic.md', content);
  const body = (record?.body ?? content).replace(/\s+/g, ' ').trim();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = body.toLowerCase();
  const first =
    terms
      .map(term => lower.indexOf(term))
      .filter(index => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 120);
  const excerpt = body.slice(start, start + 600);
  return `${start > 0 ? '…' : ''}${excerpt}${start + 600 < body.length ? '…' : ''}`;
}

function recallTextMatches(content: string, query: string): boolean {
  const haystack = content.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(term => haystack.includes(term));
}

function numeric(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) && !Number.isFinite(parsed)) {
    throw remoteMemoryError('service_unavailable', 'A remote memory generation was invalid.');
  }
  return parsed;
}

function mutationActor(
  principal: AuthorizedRemotePrincipal,
  attestation: CursorWorkloadAttestation | undefined,
): RemoteMemoryReceiptV1['actor'] {
  return attestation
    ? {
        cloudAgentId: attestation.cloudAgentId,
        principalId: principal.principalId,
        provider: 'cursor',
        ...(attestation.turnId ? {turnId: attestation.turnId} : {}),
      }
    : {principalId: principal.principalId};
}

function principalAllowsProject(principal: AuthorizedRemotePrincipal, project: string): boolean {
  return principal.allowedProjects === 'all' || principal.allowedProjects.has(project);
}

function requirePrincipalProject(principal: AuthorizedRemotePrincipal, project: string): void {
  if (principal.allowedProjects !== 'all' && !principal.allowedProjects.has(project)) {
    throw remoteMemoryError('forbidden', 'The project is outside the authorized share grant.');
  }
}

async function requireActiveProject(
  transaction: TransactionSql,
  principal: AuthorizedRemotePrincipal,
  project: string,
): Promise<void> {
  const rows = await transaction<{name: string}[]>`
    SELECT name FROM remote_memory.projects
    WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId}
      AND name = ${project} AND status = 'active'
  `;
  if (!rows[0]) throw remoteMemoryError('forbidden', 'The project is not active in the authorized memory share.');
}

function principalAllows(
  principal: AuthorizedRemotePrincipal,
  scope: RemoteMemoryScope,
  feature: RemoteMemoryFeatureFlag,
): boolean {
  return (
    (principal.OAuth.scopes.has(scope) || principal.OAuth.scopes.has('memory:admin')) &&
    (principal.capabilities.has(scope) || principal.capabilities.has('memory:admin')) &&
    principal.featureFlags.has(feature) &&
    principal.featureFlags.has('remote_memory_ga')
  );
}

function requireFreshAttestationPolicy(
  principal: AuthorizedRemotePrincipal,
  state: GrantStateRow,
  attestation: CursorWorkloadAttestation | undefined,
  project: string,
): void {
  if (
    (principal.attestationRequiredForWrites || state.feature_flags.includes('cursor_oidc_required')) &&
    !attestation
  ) {
    throw remoteMemoryError('attestation_required', 'A fresh Cursor workload attestation is required.');
  }
  if (attestation) {
    const expiresAt = Date.parse(attestation.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw remoteMemoryError('attestation_required', 'The Cursor workload attestation is invalid or expired.');
    }
    authorizeCursorClaims(principal, attestation, project);
  }
}
