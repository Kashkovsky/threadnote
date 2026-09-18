import {
  OPERATIONS_ALERTS,
  OPERATIONS_CHECKS,
  OPERATIONS_CHECK_SPECIFICATIONS,
  type OperationsManifest,
} from '../../src/remote_memory/operations_contract.js';

export const checkedAt = '2026-09-18T01:00:00.000Z';
export function operationsDraft() {
  const owners = {operator: '1'.repeat(32), support: '2'.repeat(32), escalation: '3'.repeat(32)};
  return {
    version: 1,
    deploymentId: 'a'.repeat(32),
    plannedAt: '2026-09-18T00:00:00.000Z',
    maxEvidenceAgeSeconds: 86_400,
    owners,
    ownerRosterDigest: '7'.repeat(64),
    authority: 'git',
    backup: {
      method: 'snapshot-and-pitr',
      scheduleSeconds: 3600,
      retentionSeconds: 604800,
      rpoSeconds: 300,
      rtoSeconds: 1800,
    },
    baseline: {
      expectedRecords: 1,
      gitAuthorityDigest: '1'.repeat(64),
      databaseCheckpointDigest: '2'.repeat(64),
      aliasCatalogDigest: '3'.repeat(64),
      grantPolicyDigest: '4'.repeat(64),
      runtimeArtifactDigest: '5'.repeat(64),
      rollbackArtifactDigest: '6'.repeat(64),
    },
    alerts: OPERATIONS_ALERTS.map(kind => ({
      kind,
      owners: {...owners},
      safeFirstAction: 'disable-writes',
      rollback: 'keep-writes-disabled-restore-reviewed-baseline',
    })),
  };
}

export function observedOperationsEvidence(manifest: OperationsManifest) {
  return {
    version: 1 as const,
    manifestDigest: manifest.manifestDigest,
    drillId: 'b'.repeat(32),
    isolatedTargetId: 'c'.repeat(32),
    checks: OPERATIONS_CHECKS.map((check, index) => {
      const spec = OPERATIONS_CHECK_SPECIFICATIONS[check];
      const metrics: Record<string, number> = Object.fromEntries(spec.metrics.map(key => [key, 0]));
      if (check === 'backup') metrics.pitrWindowSeconds = manifest.backup.retentionSeconds;
      if (check === 'isolated-restore') metrics.elapsedSeconds = 60;
      if (check === 'readiness') metrics.recoveryElapsedSeconds = 600;
      if (check === 'restore-reconciliation' || check === 'post-rollback-reconciliation') metrics.verifiedRecords = 1;
      return {
        check,
        status: 'observed' as const,
        observedAt: new Date(Date.parse(manifest.plannedAt) + index * 60_000).toISOString(),
        observerId: manifest.owners.operator,
        evidenceDigest: 'd'.repeat(64),
        facts: Object.fromEntries(spec.facts.map(key => [key, true])),
        metrics,
      };
    }),
  };
}
