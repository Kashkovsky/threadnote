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
      lockfileSha256: string;
      packageManifestSha256: string;
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
      target: string;
      executionMode: 'managed-exact-head';
      dependencyInstallation: 'bun install --frozen-lockfile';
      executableSha256: string;
      payloadManifestSha256: string;
      releaseMetadataSha256: string;
      payloadBytes: number;
      payloadFileCount: number;
      processLeaseInspection: 'complete';
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

export type RetainedPerformanceHarnessArtifact = Readonly<{
  createdAt: string;
  environment: Readonly<{
    architecture: string;
    commit: string;
    cpu: string;
    dirty: false;
    fixtureHash: string;
    memoryBytes: number;
    model?: Readonly<{backend: string; id: string; revision: string}>;
    node: string;
    operatingSystem: string;
    packageManager: string;
    runner: 'threadnote-code-graph-e2e';
    runnerVersion: '1';
  }>;
  measurements: readonly Readonly<{
    maximum: number;
    mean: number;
    minimum: number;
    name: string;
    p50: number;
    p95: number;
    p99: number;
    samples: number;
    unit: 'bytes' | 'count' | 'milliseconds' | 'operations_per_second' | 'percent';
  }>[];
  metadata: Readonly<Record<string, boolean | number | string>>;
  suite: 'code-graph-external-repository-v1';
  version: 1;
  warmups: number;
}>;

export type RetainedPerformancePayload = RetainedPerformanceHarnessArtifact;

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
  'source.threadnote.lockfileSha256',
  'source.threadnote.packageManifestSha256',
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
  'runner.runtime.target',
  'runner.runtime.executionMode',
  'runner.runtime.dependencyInstallation',
  'runner.runtime.executableSha256',
  'runner.runtime.payloadManifestSha256',
  'runner.runtime.releaseMetadataSha256',
  'runner.runtime.payloadBytes',
  'runner.runtime.payloadFileCount',
  'runner.runtime.processLeaseInspection',
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

function sitePathAt(record: Record<string, unknown>, key: string, path: string): void {
  const value = stringAt(record, key, path);
  const parts = value.split('/').filter(Boolean);
  const directories = parts.slice(0, -1);
  if (
    !value.startsWith('/') ||
    parts.at(-1) !== 'performance-evidence.json' ||
    directories.some(part => part === '.' || part === '..' || !/^[A-Za-z0-9._~-]+$/.test(part))
  ) {
    throw new Error(`Performance evidence ${path}.${key} must be a root-relative site artifact path.`);
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
  sitePathAt(artifact, 'url', 'artifact');
  digestAt(artifact, 'sha256', 'artifact');
  const generatedAt = stringAt(artifact, 'generatedAt', 'artifact');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(generatedAt)) {
    throw new Error('Performance evidence artifact.generatedAt must be an ISO-8601 UTC timestamp.');
  }

  const source = recordAt(root.source, 'source', ['threadnote', 'repository']);
  const threadnote = recordAt(source.threadnote, 'source.threadnote', [
    'version',
    'commit',
    'lockfileSha256',
    'packageManifestSha256',
  ]);
  stringAt(threadnote, 'version', 'source.threadnote');
  digestAt(threadnote, 'commit', 'source.threadnote', sha40Pattern);
  digestAt(threadnote, 'lockfileSha256', 'source.threadnote');
  digestAt(threadnote, 'packageManifestSha256', 'source.threadnote');
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
  const runtime = recordAt(runner.runtime, 'runner.runtime', [
    'name',
    'version',
    'target',
    'executionMode',
    'dependencyInstallation',
    'executableSha256',
    'payloadManifestSha256',
    'releaseMetadataSha256',
    'payloadBytes',
    'payloadFileCount',
    'processLeaseInspection',
  ]);
  literalAt(runtime, 'name', 'runner.runtime', 'Bun');
  stringAt(runtime, 'version', 'runner.runtime');
  stringAt(runtime, 'target', 'runner.runtime');
  literalAt(runtime, 'executionMode', 'runner.runtime', 'managed-exact-head');
  literalAt(runtime, 'dependencyInstallation', 'runner.runtime', 'bun install --frozen-lockfile');
  digestAt(runtime, 'executableSha256', 'runner.runtime');
  digestAt(runtime, 'payloadManifestSha256', 'runner.runtime');
  digestAt(runtime, 'releaseMetadataSha256', 'runner.runtime');
  positiveNumberAt(runtime, 'payloadBytes', 'runner.runtime', true);
  positiveNumberAt(runtime, 'payloadFileCount', 'runner.runtime', true);
  literalAt(runtime, 'processLeaseInspection', 'runner.runtime', 'complete');
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

type HarnessMeasurement = RetainedPerformanceHarnessArtifact['measurements'][number];

const harnessLanguageControls = [
  {display: 'java', harness: 'java'},
  {display: 'kotlin', harness: 'kotlin'},
  {display: 'typescript', harness: 'typescript'},
  {display: 'bazel', harness: 'bazel-build'},
] as const satisfies readonly {display: PerformanceControlLanguage; harness: string}[];

function openRecordAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Performance evidence ${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function metadataString(metadata: Record<string, unknown>, key: string): string {
  return stringAt(metadata, key, 'harness.metadata');
}

function metadataNumber(metadata: Record<string, unknown>, key: string, integer = false): number {
  return numberAt(metadata, key, 'harness.metadata', integer);
}

function measurementMap(artifact: RetainedPerformanceHarnessArtifact): ReadonlyMap<string, HarnessMeasurement> {
  const measurements = new Map<string, HarnessMeasurement>();
  for (const measurement of artifact.measurements) {
    if (measurements.has(measurement.name)) {
      throw new Error(`Performance harness contains duplicate measurement ${measurement.name}.`);
    }
    measurements.set(measurement.name, measurement);
  }
  return measurements;
}

function requiredMeasurement(
  measurements: ReadonlyMap<string, HarnessMeasurement>,
  name: string,
  unit: HarnessMeasurement['unit'],
  positive = true,
): HarnessMeasurement {
  const measurement = measurements.get(name);
  if (!measurement || measurement.unit !== unit || (positive && measurement.maximum <= 0)) {
    throw new Error(`Performance harness requires ${name} (${unit})${positive ? ' with a positive result' : ''}.`);
  }
  return measurement;
}

function parseHarnessControls(metadata: Record<string, unknown>): LanguageRecord<{
  query: string;
  path: string;
  stableNodeId: string;
}> {
  let input: unknown;
  try {
    input = JSON.parse(metadataString(metadata, 'externalControlEvidence'));
  } catch {
    throw new Error('Performance harness metadata.externalControlEvidence must be valid JSON.');
  }
  const controls = recordAt(input, 'harness.metadata.externalControlEvidence', performanceControlLanguages);
  return Object.fromEntries(
    performanceControlLanguages.map(language => {
      const control = recordAt(controls[language], `harness.controls.${language}`, ['query', 'path', 'stableNodeId']);
      const query = stringAt(control, 'query', `harness.controls.${language}`);
      const path = stringAt(control, 'path', `harness.controls.${language}`);
      const stableNodeId = stringAt(control, 'stableNodeId', `harness.controls.${language}`);
      if (!/^cgs_[a-f0-9]{32,64}$/.test(stableNodeId)) {
        throw new Error(`Performance harness controls.${language}.stableNodeId is invalid.`);
      }
      return [language, {path, query, stableNodeId}];
    }),
  ) as LanguageRecord<{query: string; path: string; stableNodeId: string}>;
}

function validateHarnessRuntimeProvenance(
  environment: Record<string, unknown>,
  metadata: Record<string, unknown>,
): void {
  const commit = stringAt(environment, 'commit', 'harness.environment');
  digestAt(environment, 'commit', 'harness.environment', sha40Pattern);
  literalAt(environment, 'dirty', 'harness.environment', false);
  literalAt(metadata, 'benchmarkRuntimeProvenanceMode', 'harness.metadata', 'managed-exact-head');
  literalAt(metadata, 'benchmarkRuntimeSourceCommit', 'harness.metadata', commit);
  digestAt(metadata, 'benchmarkRuntimeSourceLockfileSha256', 'harness.metadata');
  digestAt(metadata, 'benchmarkRuntimeSourcePackageManifestSha256', 'harness.metadata');
  literalAt(metadata, 'benchmarkManagedDependencyInstallation', 'harness.metadata', 'bun install --frozen-lockfile');
  literalAt(metadata, 'benchmarkManagedProcessLeaseInspection', 'harness.metadata', 'complete');
  for (const key of [
    'benchmarkManagedExecutableSha256',
    'benchmarkManagedPayloadManifestSha256',
    'benchmarkManagedReleaseMetadataSha256',
  ]) {
    digestAt(metadata, key, 'harness.metadata');
  }
  positiveNumberAt(metadata, 'benchmarkManagedPayloadBytes', 'harness.metadata', true);
  positiveNumberAt(metadata, 'benchmarkManagedPayloadFileCount', 'harness.metadata', true);
  const managedVersion = metadataString(metadata, 'benchmarkManagedVersion');
  if (!managedVersion.endsWith(`.local.g${commit}`)) {
    throw new Error('Performance harness managed version is not bound to its source commit.');
  }
  const managedRuntime = metadataString(metadata, 'benchmarkManagedRuntime');
  const environmentRuntime = stringAt(environment, 'node', 'harness.environment');
  if (!environmentRuntime.startsWith('bun/') || managedRuntime !== `bun-${environmentRuntime.slice(4)}`) {
    throw new Error('Performance harness managed runtime does not match the measured Bun runtime.');
  }
  const target = metadataString(metadata, 'benchmarkManagedTarget');
  const architecture = stringAt(environment, 'architecture', 'harness.environment');
  if (!target.endsWith(`-${architecture}`)) {
    throw new Error('Performance harness managed target does not match the measured architecture.');
  }
}

function validateHarnessMeasurements(
  artifact: RetainedPerformanceHarnessArtifact,
  metadata: Record<string, unknown>,
): void {
  const measurements = measurementMap(artifact);
  for (const [name, unit, positive = true] of [
    ['cold-index', 'milliseconds'],
    ['cold-registration-lock-and-database-setup', 'milliseconds'],
    ['cold-inventory-and-extraction', 'milliseconds'],
    ['cold-materialization', 'milliseconds'],
    ['cold-reference-resolution', 'milliseconds'],
    ['cold-activation-lexical-only', 'milliseconds'],
    ['one-file-reindex-index', 'milliseconds'],
    ['same-overlay-full-rebuild-index', 'milliseconds'],
    ['hot-exact-lexical-query', 'milliseconds'],
    ['cold-materialized-file-rows', 'count'],
    ['cold-materialized-symbol-rows', 'count'],
    ['cold-materialized-edge-rows', 'count'],
    ['cold-materialization-deduplicated-reference-rows-n1', 'count'],
    ['cold-materialized-reference-candidate-rows-n1', 'count'],
    ['cold-materialized-lookup-key-rows-n1', 'count'],
    ['cold-materialized-lexical-term-rows', 'count'],
    ['sqlite-main-disk', 'bytes'],
    ['cold-process-peak-rss', 'bytes'],
    ['cold-sqlite-wal-peak-observed', 'bytes', false],
    ['cold-sqlite-temp-peak-observed', 'bytes', false],
    ['cold-sqlite-durable-database-pages-high-water-n1', 'bytes', false],
    ['primary-query-structural-parity', 'count'],
    ['structural-graph-digest-parity', 'count'],
    ['manager-catalog-cold', 'milliseconds'],
    ['manager-catalog-warm', 'milliseconds'],
    ['manager-overview-cold', 'milliseconds'],
    ['manager-overview-warm', 'milliseconds'],
    ['manager-detail-cold', 'milliseconds'],
    ['manager-render-proxy', 'milliseconds'],
    ['manager-response-payload', 'bytes'],
    ['manager-bounded-query', 'milliseconds'],
    ['manager-bounded-query-payload', 'bytes'],
  ] as const) {
    requiredMeasurement(measurements, name, unit, positive);
  }
  for (const {harness} of harnessLanguageControls) {
    const files = requiredMeasurement(measurements, `cold-materialized-file-rows-language-${harness}`, 'count');
    requiredMeasurement(measurements, `external-query-cold-${harness}-duration`, 'milliseconds');
    const returned = requiredMeasurement(measurements, `external-query-cold-${harness}-returned-nodes`, 'count');
    const expected = requiredMeasurement(
      measurements,
      `external-query-cold-${harness}-expected-path-language-nodes`,
      'count',
    );
    const parity = requiredMeasurement(
      measurements,
      `external-query-${harness}-same-overlay-structural-parity`,
      'count',
    );
    if (files.minimum < 1 || returned.minimum < 1 || expected.minimum < 1 || parity.minimum < 1) {
      throw new Error(`Performance harness ${harness} control did not pass every retained sample.`);
    }
  }
  for (const name of ['primary-query-structural-parity', 'structural-graph-digest-parity']) {
    if (requiredMeasurement(measurements, name, 'count').minimum < 1) {
      throw new Error(`Performance harness ${name} did not pass.`);
    }
  }
  literalAt(metadata, 'retrievalMode', 'harness.metadata', 'lexical-only');
}

/**
 * Validates the complete benchmark harness artifact stored as the public evidence file.
 * The site derives every displayed measurement and provenance field from this one artifact.
 */
export function validateRetainedPerformancePayload(input: unknown): RetainedPerformancePayload {
  const payload = recordAt(input, 'harness', [
    'createdAt',
    'environment',
    'measurements',
    'metadata',
    'suite',
    'version',
    'warmups',
  ]);
  literalAt(payload, 'suite', 'harness', 'code-graph-external-repository-v1');
  literalAt(payload, 'version', 'harness', 1);
  numberAt(payload, 'warmups', 'harness', true);
  const createdAt = stringAt(payload, 'createdAt', 'harness');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(createdAt)) {
    throw new Error('Performance harness createdAt must be an ISO-8601 UTC timestamp.');
  }

  const environmentInput = openRecordAt(payload.environment, 'harness.environment');
  const environmentKeys = [
    'architecture',
    'commit',
    'cpu',
    'dirty',
    'fixtureHash',
    'memoryBytes',
    'node',
    'operatingSystem',
    'packageManager',
    'runner',
    'runnerVersion',
    ...('model' in environmentInput ? ['model'] : []),
  ];
  const environment = recordAt(environmentInput, 'harness.environment', environmentKeys);
  for (const key of ['architecture', 'cpu', 'fixtureHash', 'node', 'operatingSystem', 'packageManager']) {
    stringAt(environment, key, 'harness.environment');
  }
  positiveNumberAt(environment, 'memoryBytes', 'harness.environment', true);
  literalAt(environment, 'runner', 'harness.environment', 'threadnote-code-graph-e2e');
  literalAt(environment, 'runnerVersion', 'harness.environment', '1');
  if ('model' in environment) {
    const model = recordAt(environment.model, 'harness.environment.model', ['backend', 'id', 'revision']);
    for (const key of ['backend', 'id', 'revision']) stringAt(model, key, 'harness.environment.model');
  }

  if (!Array.isArray(payload.measurements) || payload.measurements.length === 0) {
    throw new Error('Performance harness measurements must be a non-empty array.');
  }
  for (const [index, inputMeasurement] of payload.measurements.entries()) {
    const measurement = recordAt(inputMeasurement, `harness.measurements[${index}]`, [
      'maximum',
      'mean',
      'minimum',
      'name',
      'p50',
      'p95',
      'p99',
      'samples',
      'unit',
    ]);
    stringAt(measurement, 'name', `harness.measurements[${index}]`);
    const minimum = numberAt(measurement, 'minimum', `harness.measurements[${index}]`);
    const p50 = numberAt(measurement, 'p50', `harness.measurements[${index}]`);
    const p95 = numberAt(measurement, 'p95', `harness.measurements[${index}]`);
    const p99 = numberAt(measurement, 'p99', `harness.measurements[${index}]`);
    const maximum = numberAt(measurement, 'maximum', `harness.measurements[${index}]`);
    const mean = numberAt(measurement, 'mean', `harness.measurements[${index}]`);
    positiveNumberAt(measurement, 'samples', `harness.measurements[${index}]`, true);
    if (!['bytes', 'count', 'milliseconds', 'operations_per_second', 'percent'].includes(String(measurement.unit))) {
      throw new Error(`Performance harness measurement ${String(measurement.name)} has an invalid unit.`);
    }
    if (minimum > p50 || p50 > p95 || p95 > p99 || p99 > maximum || mean < minimum || mean > maximum) {
      throw new Error(`Performance harness measurement ${String(measurement.name)} is not monotonic.`);
    }
  }

  const metadata = openRecordAt(payload.metadata, 'harness.metadata');
  for (const [key, value] of Object.entries(metadata)) {
    if (
      !['boolean', 'number', 'string'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw new Error(`Performance harness metadata.${key} must be a finite primitive value.`);
    }
  }
  validateHarnessRuntimeProvenance(environment, metadata);
  const sourceCommit = stringAt(environment, 'commit', 'harness.environment');
  const repositoryCommit = metadataString(metadata, 'externalRepositoryCommit');
  if (
    !sha40Pattern.test(repositoryCommit) ||
    environment.fixtureHash !== `external-code-graph-v1:${repositoryCommit}`
  ) {
    throw new Error('Performance harness external repository identity is not bound to its exact commit.');
  }
  literalAt(
    metadata,
    'externalRepositoryMode',
    'harness.metadata',
    'clean checkout with a byte-compared, scoped one-file overlay',
  );
  const repositoryName = metadataString(metadata, 'externalRepositoryName');
  const repositoryUrl = metadataString(metadata, 'externalRepositoryUrl');
  try {
    const parsed = new URL(repositoryUrl);
    const expectedPath = `/${repositoryName.replace(/^\/+|\/+$/g, '')}`;
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'github.com' ||
      parsed.pathname.replace(/\.git$/, '') !== expectedPath
    ) {
      throw new Error('mismatch');
    }
  } catch {
    throw new Error('Performance harness repository name and public GitHub URL do not match.');
  }
  if (metadataString(metadata, 'releaseEvidenceSha') !== sourceCommit) {
    throw new Error('Performance harness release evidence is not bound to its source commit.');
  }
  if (!/^refs\/tags\/v4\.0\.0(?:-(?:beta|rc)\.\d+)?$/.test(metadataString(metadata, 'releaseEvidenceRef'))) {
    throw new Error('Performance harness release evidence does not name a Threadnote 4 release tag.');
  }
  literalAt(metadata, 'releaseEvidenceResolvedSha', 'harness.metadata', sourceCommit);
  positiveNumberAt(metadata, 'benchmarkLogicalCpuCount', 'harness.metadata', true);
  metadataString(metadata, 'benchmarkDiskMedium');
  metadataString(metadata, 'benchmarkDiskFilesystem');
  positiveNumberAt(metadata, 'benchmarkInventoryEligibleFiles', 'harness.metadata', true);
  metadataNumber(metadata, 'benchmarkInventoryExcludedFiles', true);
  positiveNumberAt(metadata, 'managerNodeBudget', 'harness.metadata', true);
  positiveNumberAt(metadata, 'managerEdgeBudget', 'harness.metadata', true);
  literalAt(metadata, 'managerSnapshotBindingPassed', 'harness.metadata', true);
  literalAt(metadata, 'managerStaleRequestCancellationPassed', 'harness.metadata', true);
  const simultaneousWorktrees = positiveNumberAt(metadata, 'simultaneousWorktrees', 'harness.metadata', true);
  if (simultaneousWorktrees < 2) throw new Error('Performance harness must exercise concurrent worktrees.');
  literalAt(metadata, 'worktreeIsolationPassed', 'harness.metadata', true);
  for (const key of [
    'structuralGraphDigestCold',
    'structuralGraphDigestIncremental',
    'structuralGraphDigestSameOverlayReference',
  ]) {
    digestAt(metadata, key, 'harness.metadata');
  }
  if (metadata.structuralGraphDigestIncremental !== metadata.structuralGraphDigestSameOverlayReference) {
    throw new Error('Performance harness overlay digests must match before publication.');
  }
  if (!/^\d+\.\d+\.\d+/.test(metadataString(metadata, 'sqliteVersion'))) {
    throw new Error('Performance harness SQLite version is invalid.');
  }
  parseHarnessControls(metadata);
  validateHarnessMeasurements(input as RetainedPerformanceHarnessArtifact, metadata);
  return input as RetainedPerformancePayload;
}

export function retainedPerformanceArtifactFromHarness(
  input: unknown,
  binding: Readonly<{
    artifactUrl: string;
    artifactSha256: string;
    generatedAt: string;
    currentLockfileSha256: string;
    currentPackageManifestSha256: string;
  }>,
): RetainedPerformanceArtifact {
  const harness = validateRetainedPerformancePayload(input);
  const metadata = harness.metadata as Record<string, unknown>;
  if (binding.generatedAt !== harness.createdAt) {
    throw new Error('Performance binding timestamp does not match the retained harness artifact.');
  }
  for (const [actual, metadataKey, label] of [
    [binding.currentLockfileSha256, 'benchmarkRuntimeSourceLockfileSha256', 'lockfile'],
    [binding.currentPackageManifestSha256, 'benchmarkRuntimeSourcePackageManifestSha256', 'package manifest'],
  ] as const) {
    if (!sha256Pattern.test(actual) || actual !== metadata[metadataKey]) {
      throw new Error(`Performance harness ${label} SHA-256 does not match the bound source tree.`);
    }
  }
  const measurements = measurementMap(harness);
  const measurement = (name: string, unit: HarnessMeasurement['unit'], positive = true) =>
    requiredMeasurement(measurements, name, unit, positive);
  const count = (name: string) => measurement(name, 'count').maximum;
  const duration = (name: string) => measurement(name, 'milliseconds').maximum;
  const bytes = (name: string, positive = true) => measurement(name, 'bytes', positive).maximum;
  const controlsInput = parseHarnessControls(metadata);
  const controls = Object.fromEntries(
    harnessLanguageControls.map(({display, harness: language}) => [
      display,
      {
        ...controlsInput[display],
        milliseconds: duration(`external-query-cold-${language}-duration`),
        passed: true,
      },
    ]),
  ) as RetainedPerformanceArtifact['controls'];
  const query = measurement('hot-exact-lexical-query', 'milliseconds');
  const managerQuery = measurement('manager-bounded-query', 'milliseconds');

  return validateVerifiedArtifact({
    schemaVersion: 1,
    status: 'verified',
    artifact: {
      url: binding.artifactUrl,
      sha256: binding.artifactSha256,
      generatedAt: binding.generatedAt,
    },
    source: {
      threadnote: {
        version: metadataString(metadata, 'benchmarkManagedVersion'),
        commit: harness.environment.commit,
        lockfileSha256: binding.currentLockfileSha256,
        packageManifestSha256: binding.currentPackageManifestSha256,
      },
      repository: {
        name: metadataString(metadata, 'externalRepositoryName'),
        url: metadataString(metadata, 'externalRepositoryUrl'),
        commit: metadataString(metadata, 'externalRepositoryCommit'),
        checkout: 'clean',
      },
    },
    runner: {
      hardware: harness.environment.cpu,
      operatingSystem: harness.environment.operatingSystem,
      architecture: harness.environment.architecture,
      memoryBytes: harness.environment.memoryBytes,
      logicalCpuCount: metadataNumber(metadata, 'benchmarkLogicalCpuCount', true),
      runtime: {
        name: 'Bun',
        version: harness.environment.node.slice(4),
        target: metadataString(metadata, 'benchmarkManagedTarget'),
        executionMode: 'managed-exact-head',
        dependencyInstallation: 'bun install --frozen-lockfile',
        executableSha256: metadataString(metadata, 'benchmarkManagedExecutableSha256'),
        payloadManifestSha256: metadataString(metadata, 'benchmarkManagedPayloadManifestSha256'),
        releaseMetadataSha256: metadataString(metadata, 'benchmarkManagedReleaseMetadataSha256'),
        payloadBytes: metadataNumber(metadata, 'benchmarkManagedPayloadBytes', true),
        payloadFileCount: metadataNumber(metadata, 'benchmarkManagedPayloadFileCount', true),
        processLeaseInspection: 'complete',
      },
      database: {name: 'SQLite', version: metadataString(metadata, 'sqliteVersion')},
      disk: {
        medium: metadataString(metadata, 'benchmarkDiskMedium'),
        filesystem: metadataString(metadata, 'benchmarkDiskFilesystem'),
      },
    },
    inventory: {
      eligibleFiles: metadataNumber(metadata, 'benchmarkInventoryEligibleFiles', true),
      indexedFiles: count('cold-materialized-file-rows'),
      excludedFiles: metadataNumber(metadata, 'benchmarkInventoryExcludedFiles', true),
      languages: Object.fromEntries(
        harnessLanguageControls.map(({display, harness: language}) => [
          display,
          count(`cold-materialized-file-rows-language-${language}`),
        ]),
      ),
    },
    graph: {
      symbols: count('cold-materialized-symbol-rows'),
      relationships: count('cold-materialized-edge-rows'),
      references: count('cold-materialization-deduplicated-reference-rows-n1'),
      referenceCandidates: count('cold-materialized-reference-candidate-rows-n1'),
      lookupKeys: count('cold-materialized-lookup-key-rows-n1'),
      lexicalPostings: count('cold-materialized-lexical-term-rows'),
    },
    phases: {
      cold: {
        totalMilliseconds: duration('cold-index'),
        discoveryMilliseconds: duration('cold-registration-lock-and-database-setup'),
        extractionMilliseconds: duration('cold-inventory-and-extraction'),
        materializationMilliseconds: duration('cold-materialization'),
        resolutionMilliseconds: duration('cold-reference-resolution'),
        activationMilliseconds: duration('cold-activation-lexical-only'),
      },
      incremental: {totalMilliseconds: duration('one-file-reindex-index'), changedFiles: 1},
      independentRebuild: {totalMilliseconds: duration('same-overlay-full-rebuild-index')},
    },
    queries: {
      sampleCount: query.samples,
      p50Milliseconds: query.p50,
      p95Milliseconds: query.p95,
      maxMilliseconds: query.maximum,
    },
    controls,
    parity: {
      cleanColdDigest: metadataString(metadata, 'structuralGraphDigestCold'),
      incrementalOverlayDigest: metadataString(metadata, 'structuralGraphDigestIncremental'),
      independentOverlayDigest: metadataString(metadata, 'structuralGraphDigestSameOverlayReference'),
      incrementalMatchesIndependent: true,
    },
    storage: {
      databaseBytes: bytes('sqlite-main-disk'),
      peakResidentBytes: bytes('cold-process-peak-rss'),
      peakWalBytes: bytes('cold-sqlite-wal-peak-observed', false),
      peakTemporaryBytes: bytes('cold-sqlite-temp-peak-observed', false),
      peakDurableGrowthBytes: bytes('cold-sqlite-durable-database-pages-high-water-n1', false),
    },
    manager: {
      catalogColdMilliseconds: duration('manager-catalog-cold'),
      catalogWarmMilliseconds: duration('manager-catalog-warm'),
      overviewColdMilliseconds: duration('manager-overview-cold'),
      overviewWarmMilliseconds: duration('manager-overview-warm'),
      detailColdMilliseconds: duration('manager-detail-cold'),
      renderProxyMilliseconds: duration('manager-render-proxy'),
      maxPayloadBytes: bytes('manager-response-payload'),
      querySampleCount: managerQuery.samples,
      queryP50Milliseconds: managerQuery.p50,
      queryP95Milliseconds: managerQuery.p95,
      queryMaxMilliseconds: managerQuery.maximum,
      queryMaxPayloadBytes: bytes('manager-bounded-query-payload'),
      nodeBudget: metadataNumber(metadata, 'managerNodeBudget', true),
      edgeBudget: metadataNumber(metadata, 'managerEdgeBudget', true),
      snapshotBindingPassed: true,
      staleRequestCancellationPassed: true,
    },
    concurrency: {
      simultaneousWorktrees: metadataNumber(metadata, 'simultaneousWorktrees', true),
      isolationPassed: true,
    },
  });
}

export function pendingPerformanceEvidence(reason: string): PerformanceEvidence {
  if (reason.trim().length === 0) throw new Error('Pending performance evidence requires a reason.');
  return {state: 'pending', reason};
}
