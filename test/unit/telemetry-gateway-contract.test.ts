import ts from 'typescript-compiler';
import {describe, expect, it} from 'vitest';
import {
  ANONYMOUS_TELEMETRY_PHASES,
  ANONYMOUS_TELEMETRY_STAGES,
  ANONYMOUS_TELEMETRY_SUBPHASES,
  ANONYMOUS_TELEMETRY_WAITING_REASONS,
} from '../../src/effect/telemetry.js';
import {closedTelemetryErrorType} from '../../src/telemetry/diagnostic.js';
import {safeAnonymousTelemetryOperation} from '../../src/telemetry/operations.js';
import {readFileSync} from '../helpers/node-fs.js';
import {join} from '../helpers/node-path.js';

interface TelemetrySchemaV1 {
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
const schema = JSON.parse(
  readFileSync(join(root, 'infra', 'telemetry-gateway', 'telemetry-schema-v1.json'), 'utf8'),
) as TelemetrySchemaV1;

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
    for (const file of ['go.sum', 'schema.go', 'telemetry-schema-v1.json']) {
      expect(dockerfile).toContain(`infra/telemetry-gateway/${file}`);
      expect(dockerignore).toContain(`!infra/telemetry-gateway/${file}`);
    }
    expect(dockerfile).toContain('infra/telemetry-gateway/cmd');
    expect(dockerignore).toContain('!infra/telemetry-gateway/cmd/');
    expect(dockerfile).toContain('USER 10001:10001');
  });
});

function producerRegistries(): Readonly<Record<string, readonly string[]>> {
  const modelWorkerOperations = literalRegistry(diagnosticSource, 'MODEL_WORKER_OPERATIONS');
  const codeGraphFailureOperations = [
    ...literalRegistry(diskCapacitySource, 'CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_OPERATIONS'),
    ...literalRegistry(diagnosticSource, 'CODE_GRAPH_FAILURE_OPERATIONS', {ignoreSpreads: true}),
  ];
  return {
    component: interfacePropertyStrings(effectTelemetrySource, 'AnonymousTelemetryInvocationOptions', 'component'),
    correlationScope: interfacePropertyStrings(
      effectTelemetrySource,
      'AnonymousTelemetryRuntimeOptions',
      'correlationScope',
    ),
    degradationReason: interfacePropertyStrings(effectTelemetrySource, 'AnonymousTelemetryFields', 'degradationReason'),
    errorType: [...literalRegistry(diagnosticSource, 'SAFE_TELEMETRY_ERROR_TYPES'), 'UnknownError'],
    event: functionStringLiterals(effectTelemetrySource, 'safeEvent'),
    failureCode: literalRegistry(diagnosticSource, 'CODE_GRAPH_STORE_FAILURE_CODES'),
    failureDomain: interfacePropertyStrings(diagnosticSource, 'AnonymousTelemetryDiagnostic', 'domain'),
    failureOperation: codeGraphFailureOperations.map(value => value.replaceAll(' ', '-')),
    failureReason: interfacePropertyStrings(diagnosticSource, 'AnonymousTelemetryDiagnostic', 'reason'),
    failureRecovery: literalRegistry(diagnosticSource, 'CODE_GRAPH_STORE_RECOVERIES'),
    memoryBucket: functionStringLiterals(effectTelemetrySource, 'byteBucket'),
    modelWorkerOperation: modelWorkerOperations,
    operation: anonymousTelemetryOperations(),
    outcome: interfacePropertyStrings(effectTelemetrySource, 'AnonymousTelemetryEventOptions', 'outcome'),
    phase: ANONYMOUS_TELEMETRY_PHASES,
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
