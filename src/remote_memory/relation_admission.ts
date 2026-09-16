import type {TransactionSql} from 'postgres';

export function remoteRelationAdmissionLockKey(tenantId: string, shareId: string): string {
  return `remote-memory:relation-admission:${tenantId}:${shareId}`;
}

export async function acquireRemoteRelationAdmissionTransactionLock(
  transaction: TransactionSql,
  tenantId: string,
  shareId: string,
): Promise<void> {
  const lockKey = remoteRelationAdmissionLockKey(tenantId, shareId);
  await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
}
