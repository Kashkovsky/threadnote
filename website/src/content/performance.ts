export const performanceControlLanguages = ['java', 'kotlin', 'typescript', 'bazel'] as const;

export type PerformanceControlLanguage = (typeof performanceControlLanguages)[number];

type LanguageRecord<T> = Readonly<Record<PerformanceControlLanguage, T>>;

export type RetainedPerformanceArtifact = Readonly<{
  schemaVersion: 1;
  status: 'verified';
  artifact: Readonly<{
    url: string;
    sha256: string;
    generatedAt: string;
  }>;
  source: Readonly<{
    threadnote: Readonly<{
      version: string;
      commit: string;
    }>;
    repository: Readonly<{
      name: string;
      url: string;
      commit: string;
      checkout: 'clean';
    }>;
  }>;
  runner: Readonly<{
    hardware: string;
    operatingSystem: string;
    architecture: string;
    memoryBytes: number;
    logicalCpuCount: number;
    runtime: Readonly<{
      name: 'Bun';
      version: string;
    }>;
    database: Readonly<{
      name: 'SQLite';
      version: string;
    }>;
    disk: Readonly<{
      medium: string;
      filesystem: string;
    }>;
  }>;
  inventory: Readonly<{
    eligibleFiles: number;
    indexedFiles: number;
    excludedFiles: number;
    languages: LanguageRecord<number>;
  }>;
  graph: Readonly<{
    symbols: number;
    relationships: number;
    references: number;
    referenceCandidates: number;
    lookupKeys: number;
    lexicalPostings: number;
  }>;
  phases: Readonly<{
    cold: Readonly<{
      totalMilliseconds: number;
      discoveryMilliseconds: number;
      extractionMilliseconds: number;
      materializationMilliseconds: number;
      resolutionMilliseconds: number;
      activationMilliseconds: number;
    }>;
    incremental: Readonly<{
      totalMilliseconds: number;
      changedFiles: number;
    }>;
    independentRebuild: Readonly<{
      totalMilliseconds: number;
    }>;
  }>;
  queries: Readonly<{
    sampleCount: number;
    p50Milliseconds: number;
    p95Milliseconds: number;
    maxMilliseconds: number;
  }>;
  controls: LanguageRecord<
    Readonly<{
      query: string;
      path: string;
      stableNodeId: string;
      milliseconds: number;
      passed: true;
    }>
  >;
  parity: Readonly<{
    cleanColdDigest: string;
    incrementalOverlayDigest: string;
    independentOverlayDigest: string;
    incrementalMatchesIndependent: true;
  }>;
  storage: Readonly<{
    databaseBytes: number;
    peakResidentBytes: number;
    peakWalBytes: number;
    peakTemporaryBytes: number;
    peakDurableGrowthBytes: number;
  }>;
  manager: Readonly<{
    catalogColdMilliseconds: number;
    catalogWarmMilliseconds: number;
    overviewColdMilliseconds: number;
    overviewWarmMilliseconds: number;
    detailColdMilliseconds: number;
    renderProxyMilliseconds: number;
    maxPayloadBytes: number;
    querySampleCount: number;
    queryP50Milliseconds: number;
    queryP95Milliseconds: number;
    queryMaxMilliseconds: number;
    queryMaxPayloadBytes: number;
    nodeBudget: number;
    edgeBudget: number;
    snapshotBindingPassed: true;
    staleRequestCancellationPassed: true;
  }>;
  concurrency: Readonly<{
    simultaneousWorktrees: number;
    isolationPassed: true;
  }>;
}>;

export type RetainedPerformancePayload = Omit<RetainedPerformanceArtifact, 'status' | 'artifact'>;

export type PerformanceEvidence =
  | Readonly<{
      state: 'pending';
      reason: string;
    }>
  | Readonly<{
      state: 'verified';
      artifact: RetainedPerformanceArtifact;
    }>;

export const retainedPerformanceArtifactFieldPaths = [
  'schemaVersion',
  'status',
  'artifact.url',
  'artifact.sha256',
  'artifact.generatedAt',
  'source.threadnote.version',
  'source.threadnote.commit',
  'source.repository.name',
  'source.repository.url',
  'source.repository.commit',
  'source.repository.checkout',
  'runner.hardware',
  'runner.operatingSystem',
  'runner.architecture',
  'runner.memoryBytes',
  'runner.logicalCpuCount',
  'runner.runtime.name',
  'runner.runtime.version',
  'runner.database.name',
  'runner.database.version',
  'runner.disk.medium',
  'runner.disk.filesystem',
  'inventory.eligibleFiles',
  'inventory.indexedFiles',
  'inventory.excludedFiles',
  'inventory.languages.java',
  'inventory.languages.kotlin',
  'inventory.languages.typescript',
  'inventory.languages.bazel',
  'graph.symbols',
  'graph.relationships',
  'graph.references',
  'graph.referenceCandidates',
  'graph.lookupKeys',
  'graph.lexicalPostings',
  'phases.cold.totalMilliseconds',
  'phases.cold.discoveryMilliseconds',
  'phases.cold.extractionMilliseconds',
  'phases.cold.materializationMilliseconds',
  'phases.cold.resolutionMilliseconds',
  'phases.cold.activationMilliseconds',
  'phases.incremental.totalMilliseconds',
  'phases.incremental.changedFiles',
  'phases.independentRebuild.totalMilliseconds',
  'queries.sampleCount',
  'queries.p50Milliseconds',
  'queries.p95Milliseconds',
  'queries.maxMilliseconds',
  'controls.java.query',
  'controls.java.path',
  'controls.java.stableNodeId',
  'controls.java.milliseconds',
  'controls.java.passed',
  'controls.kotlin.query',
  'controls.kotlin.path',
  'controls.kotlin.stableNodeId',
  'controls.kotlin.milliseconds',
  'controls.kotlin.passed',
  'controls.typescript.query',
  'controls.typescript.path',
  'controls.typescript.stableNodeId',
  'controls.typescript.milliseconds',
  'controls.typescript.passed',
  'controls.bazel.query',
  'controls.bazel.path',
  'controls.bazel.stableNodeId',
  'controls.bazel.milliseconds',
  'controls.bazel.passed',
  'parity.cleanColdDigest',
  'parity.incrementalOverlayDigest',
  'parity.independentOverlayDigest',
  'parity.incrementalMatchesIndependent',
  'storage.databaseBytes',
  'storage.peakResidentBytes',
  'storage.peakWalBytes',
  'storage.peakTemporaryBytes',
  'storage.peakDurableGrowthBytes',
  'manager.catalogColdMilliseconds',
  'manager.catalogWarmMilliseconds',
  'manager.overviewColdMilliseconds',
  'manager.overviewWarmMilliseconds',
  'manager.detailColdMilliseconds',
  'manager.renderProxyMilliseconds',
  'manager.maxPayloadBytes',
  'manager.querySampleCount',
  'manager.queryP50Milliseconds',
  'manager.queryP95Milliseconds',
  'manager.queryMaxMilliseconds',
  'manager.queryMaxPayloadBytes',
  'manager.nodeBudget',
  'manager.edgeBudget',
  'manager.snapshotBindingPassed',
  'manager.staleRequestCancellationPassed',
  'concurrency.simultaneousWorktrees',
  'concurrency.isolationPassed',
] as const;

const sha40Pattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function recordAt(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Performance evidence ${path} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`Performance evidence ${path} has unexpected or missing fields.`);
  }
  return record;
}

function stringAt(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Performance evidence ${path}.${key} must be a non-empty string.`);
  }
  return value;
}

function numberAt(record: Record<string, unknown>, key: string, path: string, integer = false): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`Performance evidence ${path}.${key} must be a non-negative ${integer ? 'integer' : 'number'}.`);
  }
  return value;
}

function positiveNumberAt(record: Record<string, unknown>, key: string, path: string, integer = false): number {
  const value = numberAt(record, key, path, integer);
  if (value === 0) {
    throw new Error(`Performance evidence ${path}.${key} must be greater than zero.`);
  }
  return value;
}

function literalAt(
  record: Record<string, unknown>,
  key: string,
  path: string,
  expected: string | number | boolean,
): void {
  if (record[key] !== expected) {
    throw new Error(`Performance evidence ${path}.${key} must be ${JSON.stringify(expected)}.`);
  }
}

function httpsUrlAt(record: Record<string, unknown>, key: string, path: string): void {
  const value = stringAt(record, key, path);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error('not HTTPS');
  } catch {
    throw new Error(`Performance evidence ${path}.${key} must be an HTTPS URL.`);
  }
}

function digestAt(record: Record<string, unknown>, key: string, path: string, pattern = sha256Pattern): void {
  if (!pattern.test(stringAt(record, key, path))) {
    throw new Error(`Performance evidence ${path}.${key} has an invalid digest.`);
  }
}

function validateLanguageRecord(
  value: unknown,
  path: string,
  validate: (record: Record<string, unknown>, key: string) => void,
): void {
  const record = recordAt(value, path, performanceControlLanguages);
  for (const language of performanceControlLanguages) validate(record, language);
}

function validateVerifiedArtifact(input: unknown): RetainedPerformanceArtifact {
  const root = recordAt(input, 'root', [
    'schemaVersion',
    'status',
    'artifact',
    'source',
    'runner',
    'inventory',
    'graph',
    'phases',
    'queries',
    'controls',
    'parity',
    'storage',
    'manager',
    'concurrency',
  ]);
  literalAt(root, 'schemaVersion', 'root', 1);
  literalAt(root, 'status', 'root', 'verified');

  const artifact = recordAt(root.artifact, 'artifact', ['url', 'sha256', 'generatedAt']);
  httpsUrlAt(artifact, 'url', 'artifact');
  digestAt(artifact, 'sha256', 'artifact');
  const generatedAt = stringAt(artifact, 'generatedAt', 'artifact');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(generatedAt)) {
    throw new Error('Performance evidence artifact.generatedAt must be an ISO-8601 UTC timestamp.');
  }

  const source = recordAt(root.source, 'source', ['threadnote', 'repository']);
  const threadnote = recordAt(source.threadnote, 'source.threadnote', ['version', 'commit']);
  stringAt(threadnote, 'version', 'source.threadnote');
  digestAt(threadnote, 'commit', 'source.threadnote', sha40Pattern);
  const repository = recordAt(source.repository, 'source.repository', ['name', 'url', 'commit', 'checkout']);
  stringAt(repository, 'name', 'source.repository');
  httpsUrlAt(repository, 'url', 'source.repository');
  digestAt(repository, 'commit', 'source.repository', sha40Pattern);
  literalAt(repository, 'checkout', 'source.repository', 'clean');

  const runner = recordAt(root.runner, 'runner', [
    'hardware',
    'operatingSystem',
    'architecture',
    'memoryBytes',
    'logicalCpuCount',
    'runtime',
    'database',
    'disk',
  ]);
  stringAt(runner, 'hardware', 'runner');
  stringAt(runner, 'operatingSystem', 'runner');
  stringAt(runner, 'architecture', 'runner');
  positiveNumberAt(runner, 'memoryBytes', 'runner', true);
  positiveNumberAt(runner, 'logicalCpuCount', 'runner', true);
  const runtime = recordAt(runner.runtime, 'runner.runtime', ['name', 'version']);
  literalAt(runtime, 'name', 'runner.runtime', 'Bun');
  stringAt(runtime, 'version', 'runner.runtime');
  const database = recordAt(runner.database, 'runner.database', ['name', 'version']);
  literalAt(database, 'name', 'runner.database', 'SQLite');
  stringAt(database, 'version', 'runner.database');
  const disk = recordAt(runner.disk, 'runner.disk', ['medium', 'filesystem']);
  stringAt(disk, 'medium', 'runner.disk');
  stringAt(disk, 'filesystem', 'runner.disk');

  const inventory = recordAt(root.inventory, 'inventory', [
    'eligibleFiles',
    'indexedFiles',
    'excludedFiles',
    'languages',
  ]);
  const eligibleFiles = positiveNumberAt(inventory, 'eligibleFiles', 'inventory', true);
  const indexedFiles = positiveNumberAt(inventory, 'indexedFiles', 'inventory', true);
  numberAt(inventory, 'excludedFiles', 'inventory', true);
  if (indexedFiles > eligibleFiles) {
    throw new Error('Performance evidence inventory.indexedFiles cannot exceed eligibleFiles.');
  }
  validateLanguageRecord(inventory.languages, 'inventory.languages', (record, language) => {
    positiveNumberAt(record, language, 'inventory.languages', true);
  });

  const graph = recordAt(root.graph, 'graph', [
    'symbols',
    'relationships',
    'references',
    'referenceCandidates',
    'lookupKeys',
    'lexicalPostings',
  ]);
  for (const key of Object.keys(graph)) positiveNumberAt(graph, key, 'graph', true);

  const phases = recordAt(root.phases, 'phases', ['cold', 'incremental', 'independentRebuild']);
  const cold = recordAt(phases.cold, 'phases.cold', [
    'totalMilliseconds',
    'discoveryMilliseconds',
    'extractionMilliseconds',
    'materializationMilliseconds',
    'resolutionMilliseconds',
    'activationMilliseconds',
  ]);
  for (const key of Object.keys(cold)) positiveNumberAt(cold, key, 'phases.cold');
  const incremental = recordAt(phases.incremental, 'phases.incremental', ['totalMilliseconds', 'changedFiles']);
  positiveNumberAt(incremental, 'totalMilliseconds', 'phases.incremental');
  literalAt(incremental, 'changedFiles', 'phases.incremental', 1);
  const rebuild = recordAt(phases.independentRebuild, 'phases.independentRebuild', ['totalMilliseconds']);
  positiveNumberAt(rebuild, 'totalMilliseconds', 'phases.independentRebuild');

  const queries = recordAt(root.queries, 'queries', [
    'sampleCount',
    'p50Milliseconds',
    'p95Milliseconds',
    'maxMilliseconds',
  ]);
  positiveNumberAt(queries, 'sampleCount', 'queries', true);
  const queryP50 = positiveNumberAt(queries, 'p50Milliseconds', 'queries');
  const queryP95 = positiveNumberAt(queries, 'p95Milliseconds', 'queries');
  const queryMax = positiveNumberAt(queries, 'maxMilliseconds', 'queries');
  if (queryP50 > queryP95 || queryP95 > queryMax) {
    throw new Error('Performance evidence query percentiles must be monotonic.');
  }

  validateLanguageRecord(root.controls, 'controls', (record, language) => {
    const control = recordAt(record[language], `controls.${language}`, [
      'query',
      'path',
      'stableNodeId',
      'milliseconds',
      'passed',
    ]);
    stringAt(control, 'query', `controls.${language}`);
    stringAt(control, 'path', `controls.${language}`);
    if (!/^cgs_[a-f0-9]{32,64}$/.test(stringAt(control, 'stableNodeId', `controls.${language}`))) {
      throw new Error(`Performance evidence controls.${language}.stableNodeId is invalid.`);
    }
    positiveNumberAt(control, 'milliseconds', `controls.${language}`);
    literalAt(control, 'passed', `controls.${language}`, true);
  });

  const parity = recordAt(root.parity, 'parity', [
    'cleanColdDigest',
    'incrementalOverlayDigest',
    'independentOverlayDigest',
    'incrementalMatchesIndependent',
  ]);
  for (const key of ['cleanColdDigest', 'incrementalOverlayDigest', 'independentOverlayDigest']) {
    digestAt(parity, key, 'parity');
  }
  literalAt(parity, 'incrementalMatchesIndependent', 'parity', true);
  if (parity.incrementalOverlayDigest !== parity.independentOverlayDigest) {
    throw new Error('Performance evidence overlay digests must match before publication.');
  }

  const storage = recordAt(root.storage, 'storage', [
    'databaseBytes',
    'peakResidentBytes',
    'peakWalBytes',
    'peakTemporaryBytes',
    'peakDurableGrowthBytes',
  ]);
  positiveNumberAt(storage, 'databaseBytes', 'storage', true);
  positiveNumberAt(storage, 'peakResidentBytes', 'storage', true);
  for (const key of ['peakWalBytes', 'peakTemporaryBytes', 'peakDurableGrowthBytes']) {
    numberAt(storage, key, 'storage', true);
  }

  const manager = recordAt(root.manager, 'manager', [
    'catalogColdMilliseconds',
    'catalogWarmMilliseconds',
    'overviewColdMilliseconds',
    'overviewWarmMilliseconds',
    'detailColdMilliseconds',
    'renderProxyMilliseconds',
    'maxPayloadBytes',
    'querySampleCount',
    'queryP50Milliseconds',
    'queryP95Milliseconds',
    'queryMaxMilliseconds',
    'queryMaxPayloadBytes',
    'nodeBudget',
    'edgeBudget',
    'snapshotBindingPassed',
    'staleRequestCancellationPassed',
  ]);
  for (const key of [
    'catalogColdMilliseconds',
    'catalogWarmMilliseconds',
    'overviewColdMilliseconds',
    'overviewWarmMilliseconds',
    'detailColdMilliseconds',
    'renderProxyMilliseconds',
  ]) {
    positiveNumberAt(manager, key, 'manager');
  }
  for (const key of ['maxPayloadBytes', 'querySampleCount', 'queryMaxPayloadBytes', 'nodeBudget', 'edgeBudget']) {
    positiveNumberAt(manager, key, 'manager', true);
  }
  const managerQueryP50 = positiveNumberAt(manager, 'queryP50Milliseconds', 'manager');
  const managerQueryP95 = positiveNumberAt(manager, 'queryP95Milliseconds', 'manager');
  const managerQueryMax = positiveNumberAt(manager, 'queryMaxMilliseconds', 'manager');
  if (managerQueryP50 > managerQueryP95 || managerQueryP95 > managerQueryMax) {
    throw new Error('Performance evidence Manager query percentiles must be monotonic.');
  }
  literalAt(manager, 'snapshotBindingPassed', 'manager', true);
  literalAt(manager, 'staleRequestCancellationPassed', 'manager', true);

  const concurrency = recordAt(root.concurrency, 'concurrency', ['simultaneousWorktrees', 'isolationPassed']);
  const simultaneousWorktrees = positiveNumberAt(concurrency, 'simultaneousWorktrees', 'concurrency', true);
  if (simultaneousWorktrees < 2) {
    throw new Error('Performance evidence concurrency.simultaneousWorktrees must exercise concurrency.');
  }
  literalAt(concurrency, 'isolationPassed', 'concurrency', true);

  return input as RetainedPerformanceArtifact;
}

/**
 * Validates the exact JSON payload stored in the checked-in retained artifact.
 * Artifact URL, byte digest, and timestamp are supplied only by the build-time binding.
 */
export function validateRetainedPerformancePayload(input: unknown): RetainedPerformancePayload {
  const payload = recordAt(input, 'payload', [
    'schemaVersion',
    'source',
    'runner',
    'inventory',
    'graph',
    'phases',
    'queries',
    'controls',
    'parity',
    'storage',
    'manager',
    'concurrency',
  ]);
  validateVerifiedArtifact({
    ...payload,
    status: 'verified',
    artifact: {
      url: 'https://threadnote.io/performance-evidence.json',
      sha256: '0'.repeat(64),
      generatedAt: '2000-01-01T00:00:00Z',
    },
  });
  return input as RetainedPerformancePayload;
}

/**
 * Final shape validation after build-time byte and source binding succeeds.
 * Do not use this as a substitute for `bindRetainedPerformanceArtifact`.
 */
export function validateBoundRetainedPerformanceArtifact(input: unknown): RetainedPerformanceArtifact {
  return validateVerifiedArtifact(input);
}

export function pendingPerformanceEvidence(reason: string): PerformanceEvidence {
  if (reason.trim().length === 0) throw new Error('Pending performance evidence requires a reason.');
  return {state: 'pending', reason};
}
