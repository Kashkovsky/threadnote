import ts from 'typescript-compiler';
import {describe, expect, it} from 'vitest';
import {
  ANONYMOUS_TELEMETRY_AUTO_UPDATE_RESULTS,
  ANONYMOUS_TELEMETRY_PHASES,
  ANONYMOUS_TELEMETRY_STAGES,
  ANONYMOUS_TELEMETRY_SUBPHASES,
  ANONYMOUS_TELEMETRY_WAITING_REASONS,
} from '../../src/effect/telemetry.js';
import {closedTelemetryErrorType} from '../../src/telemetry/diagnostic.js';
import {safeAnonymousTelemetryOperation} from '../../src/telemetry/operations.js';
import {readFileSync} from '../helpers/node-fs.js';
import {join} from '../helpers/node-path.js';

interface TelemetrySchema {
  readonly attributeContract: {
    readonly booleanSpan: readonly string[];
    readonly integerSpan: readonly string[];
    readonly memoryBucketSpan: readonly string[];
    readonly quantityBucketSpan: readonly string[];
    readonly requiredSpan: readonly string[];
    readonly resource: readonly string[];
    readonly span: readonly string[];
  };
  readonly limits: {
    readonly maxSafeInteger: number;
    readonly maxSpansPerRequest: number;
    readonly maxVersionBytes: number;
  };
  readonly patterns: Readonly<Record<string, string>>;
  readonly registries: Readonly<Record<string, readonly string[]>>;
  readonly schemaVersion: number;
}

const root = process.cwd();
const effectTelemetrySource = sourceFile('src/effect/telemetry.ts');
const diagnosticSource = sourceFile('src/telemetry/diagnostic.ts');
const diskCapacitySource = sourceFile('src/code_graph/disk_capacity.ts');
const operationsSource = sourceFile('src/telemetry/operations.ts');
const schemaV1 = JSON.parse(
  readFileSync(join(root, 'infra', 'telemetry-gateway', 'telemetry-schema-v1.json'), 'utf8'),
) as TelemetrySchema;
const schemaV2 = JSON.parse(
  readFileSync(join(root, 'infra', 'telemetry-gateway', 'telemetry-schema-v2.json'), 'utf8'),
) as TelemetrySchema;
const schemaV3 = JSON.parse(
  readFileSync(join(root, 'infra', 'telemetry-gateway', 'telemetry-schema-v3.json'), 'utf8'),
) as TelemetrySchema;
const schema = JSON.parse(
  readFileSync(join(root, 'infra', 'telemetry-gateway', 'telemetry-schema-v4.json'), 'utf8'),
) as TelemetrySchema;

describe('telemetry producer and production gateway schema', () => {
  it('keeps the exact producer resource and span attribute surface', () => {
    const sourceText = effectTelemetrySource.getFullText();
    const sourceAttributeKeys = new Set(
      [...sourceText.matchAll(/['"]((?:error\.type|session\.id|threadnote\.[a-z0-9_.]+))['"]/giu)].map(
        match => match[1]!,
      ),
    );
    sourceAttributeKeys.add('service.name');
    sourceAttributeKeys.add('service.version');

    const schemaAttributeKeys = new Set([...schema.attributeContract.resource, ...schema.attributeContract.span]);
    expect(sorted(schemaAttributeKeys)).toEqual(sorted(sourceAttributeKeys));
    expect(schema.attributeContract.resource).toEqual([
      'service.name',
      'service.version',
      'session.id',
      'threadnote.session.scope',
      'threadnote.telemetry.schema_version',
    ]);

    const classifiedSpanKeys = [
      ...schema.attributeContract.requiredSpan,
      ...schema.attributeContract.integerSpan,
      ...schema.attributeContract.booleanSpan,
      ...schema.attributeContract.memoryBucketSpan,
      ...schema.attributeContract.quantityBucketSpan,
    ];
    expect(new Set(classifiedSpanKeys).size).toBe(classifiedSpanKeys.length);
    expect(classifiedSpanKeys.every(key => schema.attributeContract.span.includes(key))).toBe(true);
    expect(schema.attributeContract.requiredSpan).toEqual([
      'threadnote.component',
      'threadnote.event',
      'threadnote.operation',
      'threadnote.runtime.architecture',
      'threadnote.runtime.platform',
      'threadnote.runtime.version',
    ]);
  });

  it('retains frozen v1/v2/v3 while v4 adds only the closed graph-query surface', () => {
    expect(schemaV1.schemaVersion).toBe(1);
    expect(schemaV2.schemaVersion).toBe(2);
    expect(schemaV3.schemaVersion).toBe(3);
    expect(schema.schemaVersion).toBe(4);
    expect(schemaV1.attributeContract.resource).toEqual(schemaV2.attributeContract.resource);
    expect(schemaV2.attributeContract.resource).toEqual(schemaV3.attributeContract.resource);
    expect(schemaV3.attributeContract.resource).toEqual(schema.attributeContract.resource);
    expect(
      schemaV1.attributeContract.span.some(
        key => key.startsWith('threadnote.graph.') && key !== 'threadnote.graph.degradation_reason',
      ),
    ).toBe(false);

    const graphAttributes = schemaV2.attributeContract.span.filter(
      key => key.startsWith('threadnote.graph.') && key !== 'threadnote.graph.degradation_reason',
    );
    expect(graphAttributes).toEqual([
      'threadnote.graph.build_kind',
      'threadnote.graph.cached_fact_replay_bytes_bucket',
      'threadnote.graph.changed_fact_bytes_bucket',
      'threadnote.graph.changed_files_bucket',
      'threadnote.graph.deleted_files_bucket',
      'threadnote.graph.delta_files_bucket',
      'threadnote.graph.efficiency_class',
      'threadnote.graph.extracted_files_bucket',
      'threadnote.graph.fact_replay_amplification_bucket',
      'threadnote.graph.fallback_reason',
      'threadnote.graph.final_fact_bytes_bucket',
      'threadnote.graph.materialization_mode',
      'threadnote.graph.resolution_closure',
      'threadnote.graph.reused_files_bucket',
      'threadnote.graph.rewrite_amplification_bucket',
      'threadnote.graph.staged_files_bucket',
      'threadnote.graph.total_files_bucket',
    ]);
    expect(graphAttributes.some(key => /(?:repository|path|commit|session|invocation)/u.test(key))).toBe(false);
    const autoUpdateAttributes = schemaV3.attributeContract.span.filter(
      key => !schemaV2.attributeContract.span.includes(key),
    );
    expect(autoUpdateAttributes).toEqual(['threadnote.auto_update.repair_required', 'threadnote.auto_update.result']);
    expect(
      schemaV3.attributeContract.booleanSpan.filter(key => !schemaV2.attributeContract.booleanSpan.includes(key)),
    ).toEqual(['threadnote.auto_update.repair_required']);
    expect(schemaV3.registries.autoUpdateResult).toEqual(ANONYMOUS_TELEMETRY_AUTO_UPDATE_RESULTS);

    const graphQueryAttributes = schema.attributeContract.span.filter(
      key => key.startsWith('threadnote.graph.') && !schemaV3.attributeContract.span.includes(key),
    );
    expect(graphQueryAttributes).toEqual([
      'threadnote.graph.request_kind',
      'threadnote.graph.request_scope',
      'threadnote.graph.snapshot_edges_bucket',
      'threadnote.graph.snapshot_files_bucket',
      'threadnote.graph.snapshot_freshness',
      'threadnote.graph.snapshot_selection',
      'threadnote.graph.snapshot_symbols_bucket',
    ]);
    expect(
      graphQueryAttributes.some(key => /(?:repository|path|commit|query_text|symbol_id|graph_id)/u.test(key)),
    ).toBe(false);
    expect(schema.attributeContract.span.filter(key => !schemaV3.attributeContract.span.includes(key))).toEqual(
      graphQueryAttributes,
    );
    expect(
      schema.attributeContract.booleanSpan.filter(key => !schemaV3.attributeContract.booleanSpan.includes(key)),
    ).toEqual([]);
    const collector = readFileSync(join(root, 'infra', 'telemetry-gateway', 'collector.yaml'), 'utf8');
    const canarySource = readFileSync(join(root, 'infra', 'telemetry-gateway', 'cmd', 'canary', 'main.go'), 'utf8');
    expect(collector).toContain(
      'resource.attributes["threadnote.telemetry.schema_version"] != 1 and resource.attributes["threadnote.telemetry.schema_version"] != 2 and resource.attributes["threadnote.telemetry.schema_version"] != 3 and resource.attributes["threadnote.telemetry.schema_version"] != 4',
    );
    for (const attribute of [...graphAttributes, ...autoUpdateAttributes, ...graphQueryAttributes]) {
      expect(collector).toContain(`"${attribute}"`);
      expect(canarySource).toContain(`"${attribute}"`);
    }
  });

  it('keeps every closed producer registry identical to the gateway boundary', () => {
    const expected = producerRegistries();
    expect(Object.keys(schema.registries).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, values] of Object.entries(expected)) {
      expect(sortedUnique(schema.registries[name] ?? []), name).toEqual(sortedUnique(values));
    }

    for (const operation of requiredRegistry('operation')) {
      expect(safeAnonymousTelemetryOperation(operation)).toBe(operation);
    }
    expect(safeAnonymousTelemetryOperation('private-user-operation')).toBe('unknown');
    for (const errorType of requiredRegistry('errorType')) {
      expect(closedTelemetryErrorType(errorType)).toBe(errorType);
    }
    expect(closedTelemetryErrorType('PrivateCustomerError')).toBe('UnknownError');
  });

  it('keeps bounded identifier, version, bucket, and numeric limits executable', () => {
    expect(schema.schemaVersion).toBe(numericVariable(effectTelemetrySource, 'TELEMETRY_SCHEMA_VERSION'));
    expect(schema.limits.maxSafeInteger).toBe(Number.MAX_SAFE_INTEGER);
    expect(schema.limits.maxSpansPerRequest).toBeGreaterThan(0);
    expect(schema.limits.maxVersionBytes).toBe(numericVariable(effectTelemetrySource, 'TELEMETRY_VERSION_MAX_BYTES'));

    const invocation = pattern('invocationId');
    const quantity = pattern('quantityBucket');
    const runtime = pattern('runtimeLabel');
    const serviceVersion = pattern('serviceVersion');
    const session = pattern('sessionId');

    expect(invocation.test(`tni_${'0'.repeat(24)}`)).toBe(true);
    expect(invocation.test(`tni_${'0'.repeat(23)}`)).toBe(false);
    expect(session.test(`tns_${'a'.repeat(32)}`)).toBe(true);
    expect(session.test(`tns_${'a'.repeat(33)}`)).toBe(false);
    expect(runtime.test('darwin-arm64_1.2')).toBe(true);
    expect(runtime.test('/Users/private')).toBe(false);
    expect(serviceVersion.test('4.2.2-local.g63bc61f')).toBe(true);
    expect(serviceVersion.test('private version')).toBe(false);
    expect(quantity.test('0')).toBe(true);
    for (let exponent = 0; exponent <= 52; exponent += 1) expect(quantity.test(`2^${exponent}`)).toBe(true);
    expect(quantity.test('2^53')).toBe(false);
    expect(quantity.test('private')).toBe(false);
  });

  it('packages the canonical schema into the production gateway image', () => {
    const dockerfile = readFileSync(join(root, 'infra', 'telemetry-gateway', 'Dockerfile'), 'utf8');
    const dockerignore = readFileSync(join(root, '.dockerignore'), 'utf8');
    for (const file of [
      'go.sum',
      'schema.go',
      'telemetry-schema-v1.json',
      'telemetry-schema-v2.json',
      'telemetry-schema-v3.json',
      'telemetry-schema-v4.json',
    ]) {
      expect(dockerfile).toContain(`infra/telemetry-gateway/${file}`);
      expect(dockerignore).toContain(`!infra/telemetry-gateway/${file}`);
    }
    expect(dockerfile).toContain('infra/telemetry-gateway/cmd');
    expect(dockerignore).toContain('!infra/telemetry-gateway/cmd/');
    expect(dockerfile).toContain('infra/telemetry-gateway/internal');
    expect(dockerignore).toContain('!infra/telemetry-gateway/internal/');
    expect(dockerfile).toContain('USER 10001:10001');
  });

  it('keeps the live Fly topology, gateway cap, and Free-plan stop gates coupled', () => {
    const budget = readFileSync(join(root, 'infra', 'telemetry-gateway', 'internal', 'budget', 'budget.go'), 'utf8');
    const gateway = readFileSync(join(root, 'infra', 'telemetry-gateway', 'gateway.go'), 'utf8');
    const collector = readFileSync(join(root, 'infra', 'telemetry-gateway', 'collector.yaml'), 'utf8');
    const fly = readFileSync(join(root, 'fly.toml'), 'utf8');
    const canary = readFileSync(join(root, '.github', 'workflows', 'telemetry-delivery-canary.yml'), 'utf8');
    const canarySource = readFileSync(join(root, 'infra', 'telemetry-gateway', 'cmd', 'canary', 'main.go'), 'utf8');
    const gatewayWorkflow = readFileSync(join(root, '.github', 'workflows', 'telemetry-gateway.yml'), 'utf8');
    const codeOwners = readFileSync(join(root, '.github', 'CODEOWNERS'), 'utf8');
    const runbook = readFileSync(join(root, 'docs', 'operations', 'telemetry-production.md'), 'utf8');

    expect(budget).toMatch(/AcceptedBytesPerMachinePerMinute\s*=\s*32 \* 1024/u);
    expect(budget).toMatch(/AcceptedBytesPerSourcePerMinute\s*=\s*16 \* 1024/u);
    expect(budget).toMatch(/ProductionMachineCount\s*=\s*2/u);
    expect(budget).toMatch(/SafeMonthlyCanonicalBytes\s+int64\s*=\s*3_000_000_000/u);
    expect(budget).toMatch(/UsageWarningBytes\s+int64\s*=\s*10_000_000_000/u);
    expect(budget).toMatch(/UsageShutdownBytes\s+int64\s*=\s*20_000_000_000/u);
    expect(budget).toMatch(/GrafanaFreeMonthlyBytes\s+int64\s*=\s*50_000_000_000/u);
    expect(gateway).toMatch(/acceptedBytesPerMin\s*=\s*budget\.AcceptedBytesPerMachinePerMinute/u);
    expect(gateway).toMatch(/acceptedBytesPerSourceMin\s*=\s*budget\.AcceptedBytesPerSourcePerMinute/u);
    expect(gateway).toContain('THREADNOTE_TELEMETRY_PUBLIC_INGESTION');
    expect(collector).toMatch(/retry_on_failure:\s*\n(?:\s*#[^\n]*\n)*\s*enabled: false/u);
    expect(collector).toMatch(/sending_queue:\s*\n\s*enabled: false/u);
    expect(fly).toMatch(/min_machines_running = 2/u);
    expect(fly).toContain("THREADNOTE_TELEMETRY_PUBLIC_INGESTION = 'enabled'");
    expect(canary).toContain('THREADNOTE_TELEMETRY_CANARY_FLY_READ_TOKEN');
    expect(canary).toContain('vars.THREADNOTE_TELEMETRY_CANARY_GATEWAY_URL');
    expect(canary).toContain('flyctl machine list --app threadnote-telemetry --json | go run ./cmd/budget');
    expect(canarySource).toContain('{schemaVersion: 1, kind: canaryTraceCompletion}');
    expect(canarySource).toContain('{schemaVersion: 2, kind: canaryTraceGraph}');
    expect(canarySource).toContain('{schemaVersion: 3, kind: canaryTraceGraph}');
    expect(canarySource).toContain('{schemaVersion: 3, kind: canaryTraceAutoUpdate}');
    expect(canarySource).toContain('{schemaVersion: 4, kind: canaryTraceGraph}');
    expect(canarySource).toContain('{schemaVersion: 4, kind: canaryTraceAutoUpdate}');
    expect(canarySource).toContain('{schemaVersion: 4, kind: canaryTraceQueryCheckpoint}');
    expect(canarySource).toContain('{schemaVersion: 4, kind: canaryTraceQueryCompletion}');
    expect(canarySource).toContain('{"threadnote.stage", "query-worktree-observation"}');
    expect(canarySource).toContain('{"threadnote.subphase", "skipped"}');
    expect(canarySource).toContain('{"threadnote.auto_update.result", "updated"}');
    expect(canarySource).toContain('threadnote.graph.build_kind');
    expect(canarySource).toContain('threadnote.graph.fact_replay_amplification_bucket');
    expect(gatewayWorkflow).toContain("github.event_name != 'pull_request'");
    expect(gatewayWorkflow).toContain("github.ref == 'refs/heads/main'");
    expect(gatewayWorkflow).toContain('name: telemetry-production');
    expect(gatewayWorkflow).toContain('deployment: false');
    expect(gatewayWorkflow).toContain('THREADNOTE_TELEMETRY_CANARY_FLY_READ_TOKEN');
    expect(gatewayWorkflow).toContain('flyctl config validate --config fly.toml --strict');
    expect(gatewayWorkflow).toContain('name: telemetry-production-deploy');
    expect(gatewayWorkflow).toContain('THREADNOTE_TELEMETRY_FLY_DEPLOY_TOKEN');
    expect(gatewayWorkflow).toContain('version: 0.4.83');
    expect(gatewayWorkflow).toContain('queue: max');
    expect(gatewayWorkflow).toContain('cancel-in-progress: false');
    expect(gatewayWorkflow).toContain('classify-changes.sh');
    expect(gatewayWorkflow.match(/git diff --name-only --no-renames/gu)).toHaveLength(3);
    expect(gatewayWorkflow).toContain("grep -qx 'supersede=true'");
    expect(gatewayWorkflow).toContain('--image "$THREADNOTE_TELEMETRY_IMAGE"');
    expect(gatewayWorkflow).toContain('--update-only');
    expect(gatewayWorkflow).toContain('flyctl image show --app threadnote-telemetry --json');
    expect(gatewayWorkflow).toContain('all(.Digest == $digest)');
    expect(gatewayWorkflow).toContain('https://telemetry.threadnote.io/healthz');
    expect(gatewayWorkflow).toContain('https://threadnote-telemetry.fly.dev/healthz');
    expect(canary).toContain('group: telemetry-delivery-canary');
    expect(canary).toContain('for _ in $(seq 1 12)');
    expect(canary).toContain('deployment: false');
    expect(canary).toContain('version: 0.4.83');
    expect(codeOwners).toContain('/.github/CODEOWNERS @Kashkovsky');
    expect(codeOwners).toContain('/.github/workflows/ @Kashkovsky');
    expect(codeOwners).toContain('/infra/telemetry-gateway/ @Kashkovsky');
    expect(runbook).toContain('2,925,527,040');
    expect(runbook).toContain('10 GB');
    expect(runbook).toContain('20 GB');
    expect(runbook).toContain('50 GB');
    expect(runbook).toContain('THREADNOTE_TELEMETRY_PUBLIC_INGESTION=disabled');
    expect(runbook).toContain('THREADNOTE_TELEMETRY_CANARY_GATEWAY_URL');
    expect(runbook).toContain('deployment order is a hard compatibility gate');
    expect(runbook).toContain('Only after the gateway, eight-trace/four-version canary, and dashboard gates');
    expect(runbook).toContain('Keep v1/v2/v3 ingress and canary coverage');
  });
});

function producerRegistries(): Readonly<Record<string, readonly string[]>> {
  const modelWorkerOperations = literalRegistry(diagnosticSource, 'MODEL_WORKER_OPERATIONS');
  const codeGraphFailureOperations = [
    ...literalRegistry(diskCapacitySource, 'CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_OPERATIONS'),
    ...literalRegistry(diagnosticSource, 'CODE_GRAPH_FAILURE_OPERATIONS', {ignoreSpreads: true}),
  ];
  return {
    autoUpdateResult: ANONYMOUS_TELEMETRY_AUTO_UPDATE_RESULTS,
    buildKind: literalRegistry(effectTelemetrySource, 'ANONYMOUS_TELEMETRY_GRAPH_BUILD_KINDS'),
    component: interfacePropertyStrings(effectTelemetrySource, 'AnonymousTelemetryInvocationOptions', 'component'),
    correlationScope: interfacePropertyStrings(
      effectTelemetrySource,
      'AnonymousTelemetryRuntimeOptions',
      'correlationScope',
    ),
    degradationReason: interfacePropertyStrings(effectTelemetrySource, 'AnonymousTelemetryFields', 'degradationReason'),
    efficiencyClass: literalRegistry(effectTelemetrySource, 'ANONYMOUS_TELEMETRY_GRAPH_EFFICIENCY_CLASSES'),
    errorType: [...literalRegistry(diagnosticSource, 'SAFE_TELEMETRY_ERROR_TYPES'), 'UnknownError'],
    event: functionStringLiterals(effectTelemetrySource, 'safeEvent'),
    failureCode: literalRegistry(diagnosticSource, 'CODE_GRAPH_STORE_FAILURE_CODES'),
    failureDomain: interfacePropertyStrings(diagnosticSource, 'AnonymousTelemetryDiagnostic', 'domain'),
    failureOperation: codeGraphFailureOperations.map(value => value.replaceAll(' ', '-')),
    failureReason: interfacePropertyStrings(diagnosticSource, 'AnonymousTelemetryDiagnostic', 'reason'),
    failureRecovery: literalRegistry(diagnosticSource, 'CODE_GRAPH_STORE_RECOVERIES'),
    fallbackReason: literalRegistry(effectTelemetrySource, 'ANONYMOUS_TELEMETRY_GRAPH_FALLBACK_REASONS'),
    graphRequestKind: literalRegistry(effectTelemetrySource, 'ANONYMOUS_TELEMETRY_GRAPH_REQUEST_KINDS'),
    graphRequestScope: literalRegistry(effectTelemetrySource, 'ANONYMOUS_TELEMETRY_GRAPH_REQUEST_SCOPES'),
    graphSnapshotFreshness: literalRegistry(effectTelemetrySource, 'ANONYMOUS_TELEMETRY_GRAPH_SNAPSHOT_FRESHNESS'),
    graphSnapshotSelection: literalRegistry(effectTelemetrySource, 'ANONYMOUS_TELEMETRY_GRAPH_SNAPSHOT_SELECTIONS'),
    memoryBucket: functionStringLiterals(effectTelemetrySource, 'byteBucket'),
    materializationMode: literalRegistry(effectTelemetrySource, 'ANONYMOUS_TELEMETRY_GRAPH_MATERIALIZATION_MODES'),
    modelWorkerOperation: modelWorkerOperations,
    operation: anonymousTelemetryOperations(),
    outcome: interfacePropertyStrings(effectTelemetrySource, 'AnonymousTelemetryEventOptions', 'outcome'),
    phase: ANONYMOUS_TELEMETRY_PHASES,
    resolutionClosure: literalRegistry(effectTelemetrySource, 'ANONYMOUS_TELEMETRY_GRAPH_RESOLUTION_CLOSURES'),
    stage: ANONYMOUS_TELEMETRY_STAGES,
    subphase: ANONYMOUS_TELEMETRY_SUBPHASES,
    waitingReason: ANONYMOUS_TELEMETRY_WAITING_REASONS,
  };
}

function anonymousTelemetryOperations(): readonly string[] {
  const topLevel = literalRegistry(operationsSource, 'CLI_TOP_LEVEL_OPERATIONS');
  const fixed = literalRegistry(operationsSource, 'FIXED_RUNTIME_OPERATIONS');
  const subcommands = objectStringArrays(operationsSource, 'CLI_SUBCOMMANDS');
  const nested = Object.entries(subcommands).flatMap(([top, values]) => values.map(value => `${top}.${value}`));
  const explicit = literalRegistry(operationsSource, 'ANONYMOUS_TELEMETRY_OPERATIONS', {ignoreSpreads: true});
  return [...topLevel, ...nested, ...fixed, ...explicit, 'unknown'];
}

function sourceFile(path: string): ts.SourceFile {
  const absolute = join(root, path);
  return ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function variableInitializer(source: ts.SourceFile, name: string): ts.Expression {
  let result: ts.Expression | undefined;
  visit(source, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      result = node.initializer;
    }
  });
  if (result === undefined) throw new Error(`Missing telemetry registry ${name}.`);
  return unwrap(result);
}

function numericVariable(source: ts.SourceFile, name: string): number {
  const initializer = variableInitializer(source, name);
  if (!ts.isNumericLiteral(initializer)) throw new Error(`${name} must remain a numeric literal.`);
  return Number(initializer.text);
}

function literalRegistry(
  source: ts.SourceFile,
  name: string,
  options: {readonly ignoreSpreads?: boolean} = {},
): readonly string[] {
  let initializer = variableInitializer(source, name);
  if (ts.isNewExpression(initializer)) initializer = unwrap(initializer.arguments?.[0] as ts.Expression);
  if (!ts.isArrayLiteralExpression(initializer)) throw new Error(`${name} must remain an array-backed registry.`);
  const values: string[] = [];
  for (const element of initializer.elements) {
    if (ts.isStringLiteral(element)) values.push(element.text);
    else if (!options.ignoreSpreads || !ts.isSpreadElement(element)) {
      throw new Error(`${name} contains a non-literal registry member.`);
    }
  }
  return values;
}

function objectStringArrays(source: ts.SourceFile, name: string): Readonly<Record<string, readonly string[]>> {
  const initializer = variableInitializer(source, name);
  if (!ts.isObjectLiteralExpression(initializer)) throw new Error(`${name} must remain an object literal.`);
  return Object.fromEntries(
    initializer.properties.map(property => {
      if (!ts.isPropertyAssignment(property)) throw new Error(`${name} contains an unsupported property.`);
      const key = propertyName(property.name);
      const value = unwrap(property.initializer);
      if (!ts.isArrayLiteralExpression(value) || value.elements.some(element => !ts.isStringLiteral(element))) {
        throw new Error(`${name}.${key} must remain a string literal array.`);
      }
      return [key, value.elements.map(element => (element as ts.StringLiteral).text)];
    }),
  );
}

function interfacePropertyStrings(source: ts.SourceFile, interfaceName: string, property: string): readonly string[] {
  let type: ts.TypeNode | undefined;
  visit(source, node => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== interfaceName) return;
    for (const member of node.members) {
      if (ts.isPropertySignature(member) && propertyName(member.name) === property) type = member.type;
    }
  });
  if (type === undefined) throw new Error(`Missing ${interfaceName}.${property}.`);
  const values: string[] = [];
  visit(type, node => {
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) values.push(node.literal.text);
  });
  return values;
}

function functionStringLiterals(source: ts.SourceFile, name: string): readonly string[] {
  let declaration: ts.FunctionDeclaration | undefined;
  visit(source, node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
  });
  if (declaration?.body === undefined) throw new Error(`Missing telemetry function ${name}.`);
  const values: string[] = [];
  visit(declaration.body, node => {
    if (ts.isStringLiteral(node)) values.push(node.text);
  });
  return sortedUnique(values);
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  throw new Error('Telemetry registry property names must remain literals.');
}

function visit(node: ts.Node, observer: (node: ts.Node) => void): void {
  observer(node);
  ts.forEachChild(node, child => visit(child, observer));
}

function requiredRegistry(name: string): readonly string[] {
  const value = schema.registries[name];
  if (value === undefined) throw new Error(`Missing telemetry schema registry ${name}.`);
  return value;
}

function pattern(name: string): RegExp {
  const value = schema.patterns[name];
  if (value === undefined) throw new Error(`Missing telemetry schema pattern ${name}.`);
  return new RegExp(value, 'u');
}

function sorted(values: ReadonlySet<string>): readonly string[] {
  return [...values].sort();
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
