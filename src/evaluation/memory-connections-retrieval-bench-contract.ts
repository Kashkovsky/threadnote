import {sha256HexSync} from '../crypto/sha256.js';
import {MEMORY_RELATION_TYPES, type MemoryRelation, type MemoryRelationType} from '../memory/document.js';
import type {MemoryStatus} from '../types.js';
import {Predicate} from 'effect';

export const MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ID = 'memory-connections-retrieval-bench-v1' as const;
export const MEMORY_CONNECTIONS_RETRIEVAL_BENCH_VERSION = 1 as const;
export const MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ABILITIES = [
  'static-contract',
  'dynamic-state',
  'workflow-knowledge',
  'environment-gotcha',
  'premise-awareness',
] as const;
export const MEMORY_CONNECTIONS_RETRIEVAL_BENCH_SCENARIOS = [
  'direct-incoming-outgoing',
  'multi-seed-fairness',
  'one-hop-chain',
  'cycle',
  'unresolved-legacy',
  'identity-conflict',
  'historical-validity',
  'explicit-supersession',
  'authorization-nondisclosure',
  'no-connections',
] as const;
export const MEMORY_CONNECTIONS_RETRIEVAL_BENCH_APPROVED_FIXTURE_HASH =
  'f14272e99ae45c04169df0f761fba6bacb77d73eb9b2b67489a7a443900b1fad' as const;

export type MemoryConnectionsRetrievalBenchAbility = (typeof MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ABILITIES)[number];
export type MemoryConnectionsRetrievalBenchScenario = (typeof MEMORY_CONNECTIONS_RETRIEVAL_BENCH_SCENARIOS)[number];

export interface MemoryConnectionsRetrievalBenchDocumentV1 {
  readonly body: string;
  readonly memoryId: string;
  readonly relations: readonly MemoryRelation[];
  readonly status: MemoryStatus;
  readonly supersedes?: string;
  readonly topic: string;
  readonly user: string;
  readonly validFrom?: string;
  readonly validTo?: string;
}

export interface MemoryConnectionsRetrievalBenchCaseV1 {
  readonly ability: MemoryConnectionsRetrievalBenchAbility;
  readonly expectedConnectionCount: number;
  readonly expectedMemoryIds: readonly string[];
  readonly expectedPremiseStates: readonly ('conflicted' | 'current' | 'historical' | 'unresolved')[];
  readonly forbiddenMemoryIds: readonly string[];
  readonly id: string;
  readonly includeHistorical?: boolean;
  readonly limit?: number;
  readonly memoryRefs: readonly string[];
  readonly relationTypes?: readonly MemoryRelationType[];
  readonly scenario: MemoryConnectionsRetrievalBenchScenario;
}

export interface MemoryConnectionsRetrievalBenchFixtureV1 {
  readonly abilities: readonly MemoryConnectionsRetrievalBenchAbility[];
  readonly cases: readonly MemoryConnectionsRetrievalBenchCaseV1[];
  readonly documents: readonly MemoryConnectionsRetrievalBenchDocumentV1[];
  readonly id: typeof MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ID;
  readonly version: typeof MEMORY_CONNECTIONS_RETRIEVAL_BENCH_VERSION;
}

export interface MemoryConnectionsRetrievalBenchObservationV1 {
  readonly connectionCount: number;
  readonly connectionStates: readonly RecallObservedConnectionState[];
  readonly elapsedMilliseconds: number;
  readonly estimatedTokens: number;
  readonly memoryIds: readonly string[];
  readonly premiseStates: readonly string[];
  readonly queryId: string;
  readonly responseBytes: number;
  readonly serializedResult: string;
}

export interface RecallObservedConnectionState {
  readonly currentness: 'conflicted' | 'current' | 'historical' | 'unresolved';
  readonly resolution: 'conflicted' | 'resolved' | 'unresolved';
}

export interface MemoryConnectionsRetrievalBenchResultV1 {
  readonly fixtureHash: string;
  readonly fixtureId: string;
  readonly gate: {readonly failures: readonly string[]; readonly passed: boolean};
  readonly metrics: {
    readonly authorizationLeaks: number;
    readonly currentnessAccuracy: number;
    readonly duplicateResults: number;
    readonly falseAuthorityClaims: number;
    readonly maximumEstimatedTokens: number;
    readonly noAnswerAccuracy: number;
    readonly precision: number;
    readonly recall: number;
  };
  readonly observations: readonly Omit<MemoryConnectionsRetrievalBenchObservationV1, 'serializedResult'>[];
  readonly version: 1;
}

/** Evaluate frozen retrieval truth without accepting self-reported metrics. */
export function evaluateMemoryConnectionsRetrievalBench(input: {
  readonly fixture: MemoryConnectionsRetrievalBenchFixtureV1 | unknown;
  readonly observations: readonly MemoryConnectionsRetrievalBenchObservationV1[] | unknown;
}): MemoryConnectionsRetrievalBenchResultV1 {
  const fixture = parseMemoryConnectionsRetrievalBenchFixtureV1(input.fixture);
  if (!Array.isArray(input.observations)) invalid('observations must be an array');
  const observations = input.observations.map(parseObservation);
  unique(
    observations.map(observation => observation.queryId),
    'observation query ids',
  );
  const byId = new Map(observations.map(observation => [observation.queryId, observation] as const));
  const failures: string[] = [];
  let truePositiveCount = 0;
  let returnedCount = 0;
  let expectedCount = 0;
  let correctPremiseStates = 0;
  let premiseStateCount = 0;
  let authorizationLeaks = 0;
  let falseAuthorityClaims = 0;
  let duplicateResults = 0;
  let noAnswerCorrect = 0;
  let noAnswerCount = 0;
  let maximumEstimatedTokens = 0;

  for (const testCase of fixture.cases) {
    const observation = byId.get(testCase.id);
    if (!observation) {
      failures.push(`${testCase.id}: missing observation`);
      continue;
    }
    const expected = new Set(testCase.expectedMemoryIds);
    const returned = new Set(observation.memoryIds);
    truePositiveCount += observation.memoryIds.filter(id => expected.has(id)).length;
    returnedCount += observation.memoryIds.length;
    expectedCount += testCase.expectedMemoryIds.length;
    duplicateResults += observation.memoryIds.length - returned.size;
    authorizationLeaks += testCase.forbiddenMemoryIds.filter(
      id => returned.has(id) || observation.serializedResult.includes(id),
    ).length;
    for (let index = 0; index < testCase.expectedPremiseStates.length; index += 1) {
      const expectedState = testCase.expectedPremiseStates[index];
      const actualState = observation.premiseStates[index];
      premiseStateCount += 1;
      if (actualState === expectedState) correctPremiseStates += 1;
      if (expectedState !== 'current' && actualState === 'current') falseAuthorityClaims += 1;
    }
    falseAuthorityClaims += observation.connectionStates.filter(
      connection => connection.currentness === 'current' && connection.resolution !== 'resolved',
    ).length;
    if (testCase.expectedMemoryIds.length === 0) {
      noAnswerCount += 1;
      if (observation.memoryIds.length === 0) noAnswerCorrect += 1;
    }
    maximumEstimatedTokens = Math.max(maximumEstimatedTokens, observation.estimatedTokens);
    if (!sameSet(observation.memoryIds, testCase.expectedMemoryIds)) {
      failures.push(`${testCase.id}: returned memory ids differ from reviewed truth`);
    }
    if (!sameOrderedValues(observation.premiseStates, testCase.expectedPremiseStates)) {
      failures.push(`${testCase.id}: premise currentness differs from reviewed truth`);
    }
    if (observation.connectionCount !== testCase.expectedConnectionCount) {
      failures.push(
        `${testCase.id}: returned ${observation.connectionCount}/${testCase.expectedConnectionCount} connection receipts`,
      );
    }
    if (observation.estimatedTokens > 1_500) failures.push(`${testCase.id}: exceeded 1,500 estimated tokens`);
  }
  for (const observation of observations) {
    if (!fixture.cases.some(testCase => testCase.id === observation.queryId)) {
      failures.push(`${observation.queryId}: unexpected observation`);
    }
  }

  const metrics = {
    authorizationLeaks,
    currentnessAccuracy: ratio(correctPremiseStates, premiseStateCount),
    duplicateResults,
    falseAuthorityClaims,
    maximumEstimatedTokens,
    noAnswerAccuracy: ratio(noAnswerCorrect, noAnswerCount),
    precision: ratio(truePositiveCount, returnedCount),
    recall: ratio(truePositiveCount, expectedCount),
  };
  if (metrics.precision !== 1) failures.push(`precision ${metrics.precision} is below 1`);
  if (metrics.recall !== 1) failures.push(`recall ${metrics.recall} is below 1`);
  if (metrics.currentnessAccuracy !== 1)
    failures.push(`currentness accuracy ${metrics.currentnessAccuracy} is below 1`);
  if (metrics.noAnswerAccuracy !== 1) failures.push(`no-answer accuracy ${metrics.noAnswerAccuracy} is below 1`);
  if (metrics.authorizationLeaks !== 0) failures.push(`authorization leaks ${metrics.authorizationLeaks} exceeds 0`);
  if (metrics.falseAuthorityClaims !== 0)
    failures.push(`false authority claims ${metrics.falseAuthorityClaims} exceeds 0`);
  if (metrics.duplicateResults !== 0) failures.push(`duplicate results ${metrics.duplicateResults} exceeds 0`);
  return {
    fixtureHash: memoryConnectionsRetrievalBenchFixtureHash(fixture),
    fixtureId: fixture.id,
    gate: {failures: [...new Set(failures)].sort(), passed: failures.length === 0},
    metrics,
    observations: observations.map(({serializedResult: _serializedResult, ...observation}) => observation),
    version: 1,
  };
}

export function parseMemoryConnectionsRetrievalBenchFixtureV1(
  value: unknown,
): MemoryConnectionsRetrievalBenchFixtureV1 {
  const fixture = record(value, 'fixture');
  exactKeys(fixture, ['abilities', 'cases', 'documents', 'id', 'version']);
  if (fixture.id !== MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ID) invalid('fixture id is invalid');
  if (fixture.version !== 1) invalid('fixture version must be 1');
  const abilities = literalArray(fixture.abilities, MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ABILITIES, 'abilities');
  if (!sameSet(abilities, MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ABILITIES)) invalid('all five abilities are required');
  if (!Array.isArray(fixture.documents) || fixture.documents.length === 0) invalid('documents must be non-empty');
  if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) invalid('cases must be non-empty');
  const documents = fixture.documents.map(parseDocument);
  const cases = fixture.cases.map(parseCase);
  unique(
    documents.map(document => `${document.user}\n${document.topic}`),
    'document addresses',
  );
  unique(
    cases.map(testCase => testCase.id),
    'case ids',
  );
  for (const scenario of MEMORY_CONNECTIONS_RETRIEVAL_BENCH_SCENARIOS) {
    if (!cases.some(testCase => testCase.scenario === scenario)) invalid(`missing scenario ${scenario}`);
  }
  for (const ability of MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ABILITIES) {
    if (!cases.some(testCase => testCase.ability === ability)) invalid(`missing ability ${ability}`);
  }
  return {
    abilities,
    cases,
    documents,
    id: MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ID,
    version: 1,
  };
}

export function serializeMemoryConnectionsRetrievalBenchFixtureIdentity(
  value: MemoryConnectionsRetrievalBenchFixtureV1,
): string {
  return `${JSON.stringify(parseMemoryConnectionsRetrievalBenchFixtureV1(value), undefined, 2)}\n`;
}

export function memoryConnectionsRetrievalBenchFixtureHash(value: MemoryConnectionsRetrievalBenchFixtureV1): string {
  return sha256HexSync(serializeMemoryConnectionsRetrievalBenchFixtureIdentity(value));
}

export function assertApprovedMemoryConnectionsRetrievalBenchFixture(
  value: MemoryConnectionsRetrievalBenchFixtureV1,
): void {
  const hash = memoryConnectionsRetrievalBenchFixtureHash(value);
  if (hash !== MEMORY_CONNECTIONS_RETRIEVAL_BENCH_APPROVED_FIXTURE_HASH) {
    invalid(`fixture hash ${hash} is not the approved ${MEMORY_CONNECTIONS_RETRIEVAL_BENCH_APPROVED_FIXTURE_HASH}`);
  }
}

function parseDocument(value: unknown): MemoryConnectionsRetrievalBenchDocumentV1 {
  const document = record(value, 'document');
  exactKeys(document, [
    'body',
    'memoryId',
    'relations',
    'status',
    'supersedes',
    'topic',
    'user',
    'validFrom',
    'validTo',
  ]);
  if (!Array.isArray(document.relations) || document.relations.length > 16) invalid('relations are invalid');
  return {
    body: text(document.body, 'document body'),
    memoryId: memoryId(document.memoryId),
    relations: document.relations.map(parseRelation),
    status: literal(document.status, ['active', 'archived', 'expired', 'superseded'] as const, 'status'),
    ...(document.supersedes === undefined ? {} : {supersedes: text(document.supersedes, 'supersedes')}),
    topic: slug(document.topic, 'topic'),
    user: slug(document.user, 'user'),
    ...(document.validFrom === undefined ? {} : {validFrom: timestamp(document.validFrom, 'validFrom')}),
    ...(document.validTo === undefined ? {} : {validTo: timestamp(document.validTo, 'validTo')}),
  };
}

function parseCase(value: unknown): MemoryConnectionsRetrievalBenchCaseV1 {
  const testCase = record(value, 'case');
  exactKeys(testCase, [
    'ability',
    'expectedConnectionCount',
    'expectedMemoryIds',
    'expectedPremiseStates',
    'forbiddenMemoryIds',
    'id',
    'includeHistorical',
    'limit',
    'memoryRefs',
    'relationTypes',
    'scenario',
  ]);
  const memoryRefs = stringArray(testCase.memoryRefs, 'memoryRefs');
  if (memoryRefs.length === 0 || memoryRefs.length > 8) invalid('memoryRefs must contain 1-8 items');
  const expectedPremiseStates = literalArray(
    testCase.expectedPremiseStates,
    ['conflicted', 'current', 'historical', 'unresolved'] as const,
    'premise states',
  );
  if (expectedPremiseStates.length !== memoryRefs.length) invalid('premise state count must match memoryRefs');
  return {
    ability: literal(testCase.ability, MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ABILITIES, 'ability'),
    expectedConnectionCount: integer(testCase.expectedConnectionCount, 'expectedConnectionCount', 0, 32),
    expectedMemoryIds: stringArray(testCase.expectedMemoryIds, 'expectedMemoryIds').map(memoryId),
    expectedPremiseStates,
    forbiddenMemoryIds: stringArray(testCase.forbiddenMemoryIds, 'forbiddenMemoryIds').map(memoryId),
    id: slug(testCase.id, 'case id'),
    ...(testCase.includeHistorical === undefined
      ? {}
      : {includeHistorical: boolean(testCase.includeHistorical, 'includeHistorical')}),
    ...(testCase.limit === undefined ? {} : {limit: integer(testCase.limit, 'limit', 1, 8)}),
    memoryRefs,
    ...(testCase.relationTypes === undefined
      ? {}
      : {relationTypes: literalArray(testCase.relationTypes, MEMORY_RELATION_TYPES, 'relationTypes')}),
    scenario: literal(testCase.scenario, MEMORY_CONNECTIONS_RETRIEVAL_BENCH_SCENARIOS, 'scenario'),
  };
}

function parseRelation(value: unknown): MemoryRelation {
  const relation = record(value, 'relation');
  exactKeys(relation, ['type', 'uri']);
  return {
    type: literal(relation.type, MEMORY_RELATION_TYPES, 'relation type'),
    uri: text(relation.uri, 'relation uri'),
  };
}

function parseObservation(value: unknown): MemoryConnectionsRetrievalBenchObservationV1 {
  const observation = record(value, 'observation');
  exactKeys(observation, [
    'connectionCount',
    'connectionStates',
    'elapsedMilliseconds',
    'estimatedTokens',
    'memoryIds',
    'premiseStates',
    'queryId',
    'responseBytes',
    'serializedResult',
  ]);
  if (!Array.isArray(observation.connectionStates)) invalid('connectionStates must be an array');
  return {
    connectionCount: integer(observation.connectionCount, 'connectionCount', 0, 32),
    connectionStates: observation.connectionStates.map(value => {
      const state = record(value, 'connection state');
      exactKeys(state, ['currentness', 'resolution']);
      return {
        currentness: literal(
          state.currentness,
          ['conflicted', 'current', 'historical', 'unresolved'] as const,
          'connection currentness',
        ),
        resolution: literal(state.resolution, ['conflicted', 'resolved', 'unresolved'] as const, 'resolution'),
      };
    }),
    elapsedMilliseconds: finiteNumber(observation.elapsedMilliseconds, 'elapsedMilliseconds'),
    estimatedTokens: integer(observation.estimatedTokens, 'estimatedTokens', 0, 100_000),
    memoryIds: stringArray(observation.memoryIds, 'memoryIds').map(memoryId),
    premiseStates: literalArray(
      observation.premiseStates,
      ['conflicted', 'current', 'historical', 'unresolved'] as const,
      'premiseStates',
    ),
    queryId: slug(observation.queryId, 'queryId'),
    responseBytes: integer(observation.responseBytes, 'responseBytes', 0, 1_000_000),
    serializedResult: text(observation.serializedResult, 'serializedResult'),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter(key => !allowed.has(key));
  const missing = keys.filter(
    key =>
      !(key in value) &&
      !['includeHistorical', 'limit', 'relationTypes', 'supersedes', 'validFrom', 'validTo'].includes(key),
  );
  if (unexpected.length > 0 || missing.length > 0) invalid('object has unsupported or missing fields');
}

function literal<const T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !isLiteral(value, values)) invalid(`${label} is invalid`);
  return value;
}

function isLiteral<const T extends string>(value: string, values: readonly T[]): value is T {
  return values.some(candidate => candidate === value);
}

function literalArray<const T extends string>(value: unknown, values: readonly T[], label: string): readonly T[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value.map(item => literal(item, values, label));
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value.map(item => text(item, label));
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} must be non-empty text`);
  return value;
}

function slug(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(parsed)) invalid(`${label} must be a slug`);
  return parsed;
}

function memoryId(value: unknown): string {
  const parsed = text(value, 'memory id');
  if (!/^tn_[A-Za-z0-9_-]+$/u.test(parsed)) invalid('memory id is invalid');
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!Number.isFinite(Date.parse(parsed))) invalid(`${label} must be an ISO timestamp`);
  return parsed;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(`${label} must be non-negative`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
  return value;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value));
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function invalid(message: string): never {
  throw new Error(`Invalid MemoryConnectionsRetrievalBench fixture: ${message}.`);
}
