import {Schema} from 'effect';
import type {CodeGraphSpan} from '../types.js';

export const CODE_GRAPH_MONIKER_VERSION = 1 as const;

export const CODE_GRAPH_EXTERNAL_DEPENDENCY_KINDS = ['runtime', 'development', 'optional', 'peer'] as const;
export type CodeGraphExternalDependencyKind = (typeof CODE_GRAPH_EXTERNAL_DEPENDENCY_KINDS)[number];

export interface CodeGraphSourceEvidenceV1 {
  readonly path: string;
  readonly span?: CodeGraphSpan;
}

/** A declared package dependency that was not resolved to a local workspace component. */
export interface CodeGraphExternalDependencyV1 {
  readonly ecosystem: 'npm';
  readonly evidence: CodeGraphSourceEvidenceV1;
  /** Local manifest key used to import the target package (for example an npm alias). */
  readonly importAlias: string;
  readonly kind: CodeGraphExternalDependencyKind;
  /** Canonical registry package identity, which may differ from importAlias. */
  readonly name: string;
  readonly versionConstraint: string;
}

export type CodeGraphMonikerRole = 'import' | 'export';
export type CodeGraphProtobufMonikerKind = 'file' | 'package' | 'message' | 'service' | 'rpc';

interface CodeGraphMonikerBaseV1 {
  readonly evidence: {readonly path: string; readonly span: CodeGraphSpan};
  /** Stable declaration occurrence identity; it is not the future bridge identity. */
  readonly id: string;
  /** Fully scoped normalized key used by a future explicit import/export bridge. */
  readonly identity: string;
  readonly role: CodeGraphMonikerRole;
  readonly version: typeof CODE_GRAPH_MONIKER_VERSION;
}

export interface CodeGraphPackageMonikerV1 extends CodeGraphMonikerBaseV1 {
  readonly componentId: string;
  readonly dependencyKind?: CodeGraphExternalDependencyKind;
  readonly kind: 'package';
  readonly packageName: string;
  readonly packageVersion?: string;
  readonly resolutionDomain: 'package:npm';
  readonly scheme: 'package';
}

export interface CodeGraphProtobufMonikerV1 extends CodeGraphMonikerBaseV1 {
  readonly importPath?: string;
  readonly kind: CodeGraphProtobufMonikerKind;
  readonly packageName?: string;
  readonly qualifiedName?: string;
  readonly resolutionDomain: 'protobuf';
  readonly scheme: 'protobuf';
  readonly symbolId: string;
}

export type CodeGraphMonikerV1 = CodeGraphPackageMonikerV1 | CodeGraphProtobufMonikerV1;

const NonEmptyString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SpanSchema = Schema.Struct({
  column: NonNegativeInteger,
  endColumn: NonNegativeInteger,
  endLine: NonNegativeInteger,
  line: NonNegativeInteger,
});
const EvidenceSchema = Schema.Struct({path: NonEmptyString, span: SpanSchema});
const OptionalSourceEvidenceSchema = Schema.Struct({path: NonEmptyString, span: Schema.optionalKey(SpanSchema)});

export const CodeGraphExternalDependencySchemaV1 = Schema.Struct({
  ecosystem: Schema.Literal('npm'),
  evidence: OptionalSourceEvidenceSchema,
  importAlias: NonEmptyString,
  kind: Schema.Literals(CODE_GRAPH_EXTERNAL_DEPENDENCY_KINDS),
  name: NonEmptyString,
  versionConstraint: NonEmptyString,
});

export const CodeGraphPackageMonikerSchemaV1 = Schema.Struct({
  componentId: NonEmptyString,
  dependencyKind: Schema.optionalKey(Schema.Literals(CODE_GRAPH_EXTERNAL_DEPENDENCY_KINDS)),
  evidence: EvidenceSchema,
  id: NonEmptyString,
  identity: NonEmptyString,
  kind: Schema.Literal('package'),
  packageName: NonEmptyString,
  packageVersion: Schema.optionalKey(NonEmptyString),
  resolutionDomain: Schema.Literal('package:npm'),
  role: Schema.Literals(['import', 'export']),
  scheme: Schema.Literal('package'),
  version: Schema.Literal(CODE_GRAPH_MONIKER_VERSION),
});

export const CodeGraphProtobufMonikerSchemaV1 = Schema.Struct({
  evidence: EvidenceSchema,
  id: NonEmptyString,
  identity: NonEmptyString,
  importPath: Schema.optionalKey(NonEmptyString),
  kind: Schema.Literals(['file', 'package', 'message', 'service', 'rpc']),
  packageName: Schema.optionalKey(NonEmptyString),
  qualifiedName: Schema.optionalKey(NonEmptyString),
  resolutionDomain: Schema.Literal('protobuf'),
  role: Schema.Literals(['import', 'export']),
  scheme: Schema.Literal('protobuf'),
  symbolId: NonEmptyString,
  version: Schema.Literal(CODE_GRAPH_MONIKER_VERSION),
});

export const CodeGraphMonikerSchemaV1 = Schema.Union([
  CodeGraphPackageMonikerSchemaV1,
  CodeGraphProtobufMonikerSchemaV1,
]);

export const CODE_GRAPH_MONIKER_STRICT_PARSE_OPTIONS = {errors: 'all', onExcessProperty: 'error'} as const;
