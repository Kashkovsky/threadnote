export const ciLongRunningTestGroups = {
  'lifecycle-alpha': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-beta': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-gamma': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-delta': ['test/integration/code-graph.lifecycle.test.ts'],
  'project-closure': ['test/integration/code-graph.project-closure.test.ts'],
  'incremental-property': [
    'test/integration/code-graph.incremental.property.test.ts',
    'test/unit/code-graph.analysis-summary.property.test.ts',
    'test/unit/code-graph.resolution-summary.property.test.ts',
    'test/unit/code-graph.store-query.property.test.ts',
  ],
  'load-evidence': [
    'test/integration/code-graph.removed-view-cleanup-load.test.ts',
    'test/integration/code-graph.vector-retirement-load.test.ts',
    'test/integration/code-graph.cache-capacity-load.test.ts',
  ],
  'os-contention': [
    'test/integration/code-graph.read-bootstrap.test.ts',
    'test/integration/code-graph.view-attach-lock.test.ts',
    'test/integration/code-graph.vector-retirement-os.test.ts',
    'test/integration/code-graph.removed-view-cleanup-os.test.ts',
    'test/integration/code-graph.cache-capacity-os.test.ts',
    'test/integration/code-graph.disk-reservation.test.ts',
    'test/unit/code-graph.maintenance-residual-live.test.ts',
  ],
  'heavy-integration': [
    'test/integration/cli.effect.test.ts',
    'test/integration/mcp.native-tools.test.ts',
    'test/integration/code-graph.performance-evidence.test.ts',
    'test/integration/code-graph.snapshot-repair.property.test.ts',
    'test/integration/code-graph.cross-session-incremental.test.ts',
    'test/integration/code-graph.session.test.ts',
    'test/integration/code-graph.benchmark-preflight.test.ts',
    'test/unit/code-graph.tree-sitter-identity.property.test.ts',
    'test/unit/code-graph.languages.property.test.ts',
    'test/unit/code-graph.languages.test.ts',
  ],
  'heavy-state': [
    'test/unit/code-graph.removed-view-cleanup.property.test.ts',
    'test/unit/code-graph.view-removal.property.test.ts',
    'test/unit/code-graph.worktree-reconciliation.test.ts',
    'test/unit/code-graph.vector-retirement-schema.test.ts',
    'test/unit/code-graph.vector-retirement-ordinary.test.ts',
    'test/unit/code-graph.vector-maintenance.test.ts',
    'test/unit/code-graph.materialization-store.test.ts',
    'test/unit/evaluation.recall-v2.test.ts',
    'test/unit/code-graph.project-closure-store.test.ts',
    'test/unit/code-graph.snapshot-retention.test.ts',
    'test/integration/share.sync.test.ts',
    'test/unit/code-graph.cache-coalescer.test.ts',
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type CiLongRunningTestGroupName = keyof typeof ciLongRunningTestGroups;

export const ciLongRunningTestGroupNames = Object.keys(ciLongRunningTestGroups) as CiLongRunningTestGroupName[];

export const ciScheduledLongRunningTestGroupNames = [
  'load-evidence',
] as const satisfies readonly CiLongRunningTestGroupName[];

const ciScheduledLongRunningTestGroups = new Set<CiLongRunningTestGroupName>(ciScheduledLongRunningTestGroupNames);

export const ciRequiredLongRunningTestGroupNames = ciLongRunningTestGroupNames.filter(
  group => !ciScheduledLongRunningTestGroups.has(group),
);

export const ciSerializedLongRunningTestGroups = new Set<CiLongRunningTestGroupName>([
  'heavy-state',
  'load-evidence',
  'os-contention',
]);
