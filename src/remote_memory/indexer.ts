import type {Sql, TransactionSql} from 'postgres';

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_POLL_MILLISECONDS = 250;
const MAX_RETRY_MILLISECONDS = 60_000;
const MAX_PROJECTION_ATTEMPTS = 10;

interface ShareDirectoryRow {
  readonly share_id: string;
  readonly tenant_id: string;
}

interface OutboxRow {
  readonly aggregate_id: string;
  readonly attempts: number;
  readonly event_type: string;
  readonly generation: string | number;
  readonly id: string;
}

interface IndexerHealthAggregateRow {
  readonly dead_letters: string | number;
  readonly oldest_pending_at: Date | null;
  readonly pending_work: string | number;
}

type ProjectionResult = 'claimed_failed' | 'claimed_processed' | 'not_claimed';

export interface RemoteMemoryIndexerOptions {
  readonly batchSize?: number;
  readonly pollMilliseconds?: number;
  readonly signal?: AbortSignal;
}

export interface RemoteMemoryIndexPassResult {
  readonly failed: number;
  readonly processed: number;
}

/**
 * Projects committed memory heads into the derived lexical index. A pass takes
 * at most one event per share before rotating, so one hot share cannot consume
 * the whole batch. The claim, projection, failure bookkeeping, and outcome are
 * decided in one transaction; a SKIP LOCKED miss is never counted as progress.
 */
export class RemoteMemoryIndexer {
  private nextShareKey: string | undefined;

  constructor(readonly sql: Sql) {}

  async retryDeadLetters(input: {
    readonly eventId?: string;
    readonly shareId: string;
    readonly tenantId: string;
  }): Promise<number> {
    return this.withTenant(input.tenantId, async transaction => {
      const rows = await transaction<{id: string}[]>`
        UPDATE remote_memory.outbox_events
        SET attempts = 0, available_at = now(), dead_lettered_at = NULL, last_error_class = NULL
        WHERE tenant_id = ${input.tenantId} AND share_id = ${input.shareId}
          AND dead_lettered_at IS NOT NULL
          AND (${input.eventId ?? null}::text IS NULL OR id = ${input.eventId ?? null})
        RETURNING id
      `;
      return rows.length;
    });
  }

  async runPass(options: Pick<RemoteMemoryIndexerOptions, 'batchSize'> = {}): Promise<RemoteMemoryIndexPassResult> {
    const batchSize = boundedBatchSize(options.batchSize);
    const shares = rotateShares(await this.activeShares(), this.nextShareKey);
    let processed = 0;
    let failed = 0;
    let attempts = 0;
    let lastAttempted: ShareDirectoryRow | undefined;
    if (shares.length > 0) {
      while (attempts < batchSize) {
        let roundClaimed = 0;
        for (const share of shares) {
          if (attempts >= batchSize) break;
          lastAttempted = share;
          const outcome = await this.claimAndProject(share);
          if (outcome === 'not_claimed') continue;
          attempts += 1;
          roundClaimed += 1;
          if (outcome === 'claimed_processed') processed += 1;
          else failed += 1;
        }
        if (roundClaimed === 0) break;
      }
    }
    if (lastAttempted) this.nextShareKey = shareKeyAfter(shares, lastAttempted);
    await this.updateHealth(shares, {failed, processed});
    return {failed, processed};
  }

  async run(options: RemoteMemoryIndexerOptions = {}): Promise<void> {
    const pollMilliseconds = boundedPollMilliseconds(options.pollMilliseconds);
    while (!options.signal?.aborted) {
      const pass = await this.runPass({batchSize: options.batchSize});
      if (pass.processed + pass.failed === 0 && !options.signal?.aborted) {
        await waitForAbortableDelay(pollMilliseconds, options.signal);
      }
    }
  }

  private async activeShares(): Promise<readonly ShareDirectoryRow[]> {
    return this.sql<ShareDirectoryRow[]>`
      SELECT tenant_id, share_id FROM remote_memory.share_directory
      WHERE status = 'active' ORDER BY tenant_id, share_id
    `;
  }

  private async claimAndProject(share: ShareDirectoryRow): Promise<ProjectionResult> {
    return await this.sql.begin(async transaction => {
      await configureTenantTransaction(transaction, share.tenant_id);
      const locked = await transaction<OutboxRow[]>`
        SELECT id, aggregate_id, event_type, generation, attempts
        FROM remote_memory.outbox_events
        WHERE tenant_id = ${share.tenant_id} AND share_id = ${share.share_id}
          AND processed_at IS NULL AND available_at <= now() AND dead_lettered_at IS NULL
        ORDER BY generation, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const event = locked[0];
      if (!event) return 'not_claimed' as const;
      try {
        await transaction.savepoint(async projection => {
          if (event.event_type !== 'memory_head_changed') throw new Error('unsupported_outbox_event');
          const projected = await projection`
            INSERT INTO remote_memory.search_documents(
              tenant_id, share_id, head_id, revision_id, generation, project, topic, kind, searchable
            )
            SELECT h.tenant_id, h.share_id, h.id, r.id, r.generation, h.project, h.topic, h.kind,
              to_tsvector('simple', h.project || ' ' || h.topic || ' ' || r.markdown_body)
            FROM remote_memory.memory_heads h
            JOIN remote_memory.memory_revisions r
              ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
            WHERE h.tenant_id = ${share.tenant_id} AND h.share_id = ${share.share_id}
              AND h.id = ${event.aggregate_id}
            ON CONFLICT (tenant_id, share_id, head_id) DO UPDATE SET
              revision_id = EXCLUDED.revision_id, generation = EXCLUDED.generation,
              project = EXCLUDED.project, topic = EXCLUDED.topic, kind = EXCLUDED.kind,
              searchable = EXCLUDED.searchable, updated_at = now()
            RETURNING head_id
          `;
          if (projected.length !== 1) throw new Error('missing_outbox_aggregate');
          await projection`
            UPDATE remote_memory.outbox_events SET processed_at = now(), last_error_class = NULL
            WHERE tenant_id = ${share.tenant_id} AND share_id = ${share.share_id} AND id = ${event.id}
          `;
          await advanceContiguousGeneration(projection, share);
        });
        return 'claimed_processed' as const;
      } catch (cause) {
        const nextAttempts = event.attempts + 1;
        await transaction`
          UPDATE remote_memory.outbox_events
          SET attempts = attempts + 1, last_error_class = ${classifyIndexerFailure(cause)},
            dead_lettered_at = CASE WHEN ${nextAttempts} >= ${MAX_PROJECTION_ATTEMPTS} THEN now() ELSE NULL END,
            available_at = now() + (${remoteIndexerBackoffMilliseconds(nextAttempts)} * interval '1 millisecond')
          WHERE tenant_id = ${share.tenant_id} AND share_id = ${share.share_id} AND id = ${event.id}
        `;
        return 'claimed_failed' as const;
      }
    });
  }

  private async updateHealth(shares: readonly ShareDirectoryRow[], result: RemoteMemoryIndexPassResult): Promise<void> {
    let deadLetters = 0;
    let pendingWork = 0;
    let oldestPendingAt: Date | undefined;
    for (const tenantId of new Set(shares.map(share => share.tenant_id))) {
      const rows = await this.withTenant(
        tenantId,
        transaction =>
          transaction<IndexerHealthAggregateRow[]>`
          SELECT count(*) FILTER (WHERE e.dead_lettered_at IS NULL) AS pending_work,
            count(*) FILTER (WHERE e.dead_lettered_at IS NOT NULL) AS dead_letters,
            min(e.created_at) AS oldest_pending_at
          FROM remote_memory.outbox_events e
          JOIN remote_memory.shares s ON s.tenant_id = e.tenant_id AND s.id = e.share_id
          WHERE e.tenant_id = ${tenantId} AND e.processed_at IS NULL AND s.status = 'active'
        `,
      );
      const row = rows[0];
      pendingWork += Number(row?.pending_work ?? 0);
      deadLetters += Number(row?.dead_letters ?? 0);
      if (row?.oldest_pending_at && (!oldestPendingAt || row.oldest_pending_at < oldestPendingAt)) {
        oldestPendingAt = row.oldest_pending_at;
      }
    }
    const failureClass = result.failed > 0 ? 'projection_failed' : deadLetters > 0 ? 'dead_lettered_event' : undefined;
    await this.sql`
      UPDATE remote_memory.worker_health SET
        heartbeat_at = now(),
        last_success_at = CASE WHEN ${failureClass ?? null}::text IS NULL THEN now() ELSE last_success_at END,
        last_failure_at = CASE WHEN ${failureClass ?? null}::text IS NOT NULL THEN now() ELSE last_failure_at END,
        failure_class = ${failureClass ?? null}, pending_work = ${pendingWork + deadLetters},
        oldest_pending_at = ${oldestPendingAt?.toISOString() ?? null},
        updated_at = now()
      WHERE worker_name = 'indexer'
    `;
  }

  private async withTenant<A>(tenantId: string, use: (transaction: TransactionSql) => Promise<A>): Promise<A> {
    return await this.sql.begin<Promise<A>>(async transaction => {
      await configureTenantTransaction(transaction, tenantId);
      return use(transaction);
    });
  }
}

export function remoteIndexerBackoffMilliseconds(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) return 1_000;
  return Math.min(MAX_RETRY_MILLISECONDS, 1_000 * 2 ** Math.min(attempts - 1, 16));
}

export function rotateShares<A extends {readonly share_id: string; readonly tenant_id: string}>(
  shares: readonly A[],
  nextShareKey: string | undefined,
): readonly A[] {
  if (!nextShareKey || shares.length < 2) return shares;
  const index = shares.findIndex(share => shareKey(share) >= nextShareKey);
  if (index <= 0) return index === 0 ? shares : [...shares];
  return [...shares.slice(index), ...shares.slice(0, index)];
}

function shareKey(share: ShareDirectoryRow): string {
  return `${share.tenant_id}\u0000${share.share_id}`;
}

function shareKeyAfter(shares: readonly ShareDirectoryRow[], current: ShareDirectoryRow): string | undefined {
  if (shares.length === 0) return undefined;
  const index = shares.findIndex(share => shareKey(share) === shareKey(current));
  return shareKey(shares[(index + 1) % shares.length]);
}

async function advanceContiguousGeneration(transaction: TransactionSql, share: ShareDirectoryRow): Promise<void> {
  await transaction`
    UPDATE remote_memory.shares s SET indexed_generation = GREATEST(
      s.indexed_generation,
      COALESCE((
        SELECT MIN(e.generation) - 1 FROM remote_memory.outbox_events e
        WHERE e.tenant_id = s.tenant_id AND e.share_id = s.id AND e.processed_at IS NULL
      ), s.share_generation)
    ) WHERE s.tenant_id = ${share.tenant_id} AND s.id = ${share.share_id}
  `;
}

async function configureTenantTransaction(transaction: TransactionSql, tenantId: string): Promise<void> {
  await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
  await transaction`SELECT set_config('statement_timeout', '10000', true)`;
  await transaction`SELECT set_config('lock_timeout', '5000', true)`;
  await transaction`SELECT set_config('transaction_timeout', '10000', true)`;
}

function classifyIndexerFailure(cause: unknown): string {
  if (cause instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(cause.message)) return cause.message;
  return 'projection_failed';
}

function boundedBatchSize(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? Math.min(value, 1_000) : DEFAULT_BATCH_SIZE;
}

function boundedPollMilliseconds(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 10
    ? Math.min(value, 60_000)
    : DEFAULT_POLL_MILLISECONDS;
}

async function waitForAbortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => {
    const timeout = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, {once: true});
    function finish(): void {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
  });
}
