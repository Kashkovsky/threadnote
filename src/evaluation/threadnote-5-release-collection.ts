import {canonicalJson} from '../code_graph/checkpoint/canonical_json.js';
import {sha256HexSync} from '../crypto/sha256.js';
import {
  parseThreadnote5TrustedSourceV1,
  type Threadnote5ReleaseScenario,
  type Threadnote5SourceV1,
} from './threadnote-5-release-readiness-contract.js';
import type {Threadnote5LocalSourceKindV1} from './threadnote-5-release-readiness-receipts.js';

export const THREADNOTE_5_COLLECTION_MATRIX = [
  [
    'solo',
    [
      ['activation', 10],
      ['context-brief', 10],
      ['value-report', 10],
    ],
  ],
  [
    'two-agent',
    [
      ['activation', 10],
      ['recall', 10],
      ['value-report', 10],
    ],
  ],
  [
    'git-shared',
    [
      ['sharing', 10],
      ['recall', 10],
      ['value-report', 10],
    ],
  ],
  [
    'offline',
    [
      ['activation', 10],
      ['value-report', 10],
    ],
  ],
  ['dirty-worktree', [['context-check', 1]]],
  [
    'interrupted-resumed',
    [
      ['activation', 1],
      ['closeout', 10],
    ],
  ],
  ['upgrade-downgrade', [['migration', 1]]],
  ['provider-neutral-proposal', [['git-proposal', 10]]],
  ['verified-procedures', [['procedure', 1]]],
  ['health-maintenance', [['context-health', 10]]],
  ['structured-closeout', [['closeout', 10]]],
  ['stale-citation', [['context-health', 1]]],
  ['contradiction-triage', [['context-health', 1]]],
  ['projection-drift', [['guidance', 1]]],
  [
    'output-budgets',
    [
      ['context-brief', 1],
      ['closeout', 1],
    ],
  ],
] as const satisfies readonly (readonly [
  Threadnote5ReleaseScenario,
  readonly (readonly [Threadnote5LocalSourceKindV1, number])[],
])[];

export type CollectionSurface = 'primary' | 'secondary';
export type CollectionStep =
  | {
      readonly id: string;
      readonly type: 'cli';
      readonly surface: CollectionSurface;
      readonly argv: readonly string[];
      readonly expectedExit: number;
    }
  | {
      readonly id: string;
      readonly type: 'mcp';
      readonly surface: CollectionSurface;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | {
      readonly id: string;
      readonly type: 'read-json';
      readonly surface: CollectionSurface;
      readonly root: 'home' | 'repo';
      readonly path: string;
    }
  | {
      readonly id: string;
      readonly type: 'write';
      readonly surface: CollectionSurface;
      readonly root: 'home' | 'repo';
      readonly path: string;
      readonly text: string;
    };

/** Projections can only select captured native data, collect trials, or compose containers. */
export type NativeProjection =
  | {readonly select: string; readonly pointer: string; readonly trial: number}
  | {readonly collect: string; readonly pointer: string; readonly flatten: boolean}
  | {readonly object: Readonly<Record<string, NativeProjection>>}
  | {readonly array: readonly NativeProjection[]};

export interface CollectionRecipe {
  readonly scenario: Threadnote5ReleaseScenario;
  readonly steps: readonly CollectionStep[];
  readonly exports: Readonly<Record<string, NativeProjection>>;
}

export interface Threadnote5CollectionPlan {
  readonly version: 1;
  readonly runId: string;
  readonly candidate: Threadnote5SourceV1;
  readonly measuredTrials: number;
  readonly retentionHours: number;
  readonly recipes: readonly CollectionRecipe[];
}

export function parseThreadnote5CollectionPlan(value: unknown): Threadnote5CollectionPlan {
  const input = exact(value, ['version', 'runId', 'candidate', 'measuredTrials', 'retentionHours', 'recipes']);
  if (input.version !== 1 || !Array.isArray(input.recipes) || input.recipes.length !== 15) {
    throw new Error('Collection requires exactly 15 reviewed scenario recipes; missing adapters cannot be skipped.');
  }
  const runId = identifier(input.runId);
  const measuredTrials = integer(input.measuredTrials, 10, 64);
  const retentionHours = integer(input.retentionHours, 1, 168);
  const candidate = parseThreadnote5TrustedSourceV1(input.candidate, 'candidate');
  const seen = new Set<string>();
  const recipes = input.recipes.map(value => {
    const recipe = exact(value, ['scenario', 'steps', 'exports']);
    const matrix = THREADNOTE_5_COLLECTION_MATRIX.find(item => item[0] === recipe.scenario);
    if (matrix === undefined || seen.has(matrix[0])) throw new Error('Unknown or duplicate collection scenario.');
    seen.add(matrix[0]);
    if (!Array.isArray(recipe.steps) || recipe.steps.length < 1 || recipe.steps.length > 128) {
      throw new Error('Every scenario requires bounded executable product steps.');
    }
    const steps = recipe.steps.map(parseStep);
    const ids = new Set(steps.map(step => step.id));
    if (ids.size !== steps.length || !steps.some(step => step.type === 'cli' || step.type === 'mcp')) {
      throw new Error('Scenario steps must have unique identities and execute the candidate.');
    }
    const exports = exact(
      recipe.exports,
      matrix[1].map(item => item[0]),
    );
    const sources = new Set(steps.filter(step => step.type !== 'write').map(step => step.id));
    const trials = matrix[1].some(item => item[1] > 1) ? measuredTrials : 1;
    for (const projection of Object.values(exports)) validateProjection(projection, sources, trials, 0);
    for (const [kind, count] of matrix[1])
      validateObservationProjection(
        exports[kind] as NativeProjection,
        collectionObservationField(matrix[0], kind),
        count > 1,
      );
    return {scenario: matrix[0], steps, exports: exports as Record<string, NativeProjection>};
  });
  recipes.sort(
    (a, b) =>
      THREADNOTE_5_COLLECTION_MATRIX.findIndex(item => item[0] === a.scenario) -
      THREADNOTE_5_COLLECTION_MATRIX.findIndex(item => item[0] === b.scenario),
  );
  return {version: 1, runId, candidate, measuredTrials, retentionHours, recipes};
}

export function threadnote5CollectionPlanHash(value: unknown): string {
  return sha256HexSync(
    `threadnote-5-private-collection-plan-v1\0${canonicalJson(parseThreadnote5CollectionPlan(value))}`,
  );
}

export function collectionTrialIdentity(runId: string, scenario: Threadnote5ReleaseScenario, trial: number) {
  identifier(runId);
  integer(trial, 0, 63);
  const digest = sha256HexSync(`threadnote-5-private-trial-v1\0${runId}\0${scenario}\0${trial}`).slice(0, 32);
  return {
    laneId: `lane_${digest}`,
    trialId: `trial_${digest}`,
    reviewId: `review_${digest}`,
    proposalId: `proposal_${digest}`,
    activationId: `activation_${digest}`,
  };
}

export function projectNativeCapture(
  projection: NativeProjection,
  trials: readonly Readonly<Record<string, unknown>>[],
): unknown {
  if ('select' in projection) return nativePointer(trials[projection.trial]?.[projection.select], projection.pointer);
  if ('collect' in projection) {
    const values = trials.map(trial => nativePointer(trial[projection.collect], projection.pointer));
    if (projection.flatten && values.some(value => !Array.isArray(value) || value.length !== 1))
      throw new Error('Native flatten requires exactly one observation from each trial.');
    return projection.flatten ? values.flat() : values;
  }
  if ('array' in projection) return projection.array.map(value => projectNativeCapture(value, trials));
  return Object.fromEntries(
    Object.entries(projection.object).map(([key, value]) => [key, projectNativeCapture(value, trials)]),
  );
}

export function nativePointer(value: unknown, pointer: string): unknown {
  if (pointer !== '' && !pointer.startsWith('/')) throw new Error('Native selection requires a JSON pointer.');
  let selected = value;
  for (const part of pointer === '' ? [] : pointer.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype' ||
      typeof selected !== 'object' ||
      selected === null ||
      !Object.hasOwn(selected, key)
    ) {
      throw new Error('Native capture pointer is missing or unsafe.');
    }
    selected = (selected as Record<string, unknown>)[key];
  }
  if (selected === undefined) throw new Error('Native capture is missing.');
  return selected;
}

export function assertCollectionCardinality(
  scenario: Threadnote5ReleaseScenario,
  kind: Threadnote5LocalSourceKindV1,
  artifact: unknown,
  measuredTrials: number,
): void {
  const requirement = THREADNOTE_5_COLLECTION_MATRIX.find(item => item[0] === scenario)?.[1].find(
    item => item[0] === kind,
  );
  if (requirement === undefined) throw new Error('Unexpected source record.');
  const field = collectionObservationField(scenario, kind);
  const count = field === null ? 1 : nativePointer(artifact, `/${field}`);
  if (
    (field === null ? count : Array.isArray(count) ? count.length : -1) !== (requirement[1] === 1 ? 1 : measuredTrials)
  ) {
    throw new Error(`Invalid native trial cardinality for ${scenario}/${kind}.`);
  }
}

export function collectionObservationField(
  scenario: Threadnote5ReleaseScenario,
  kind: Threadnote5LocalSourceKindV1,
): string | null {
  return kind === 'activation' || kind === 'recall' || kind === 'sharing'
    ? 'trials'
    : kind === 'closeout'
      ? 'reviews'
      : kind === 'value-report'
        ? 'feedbackTrials'
        : kind === 'context-health'
          ? scenario === 'health-maintenance'
            ? 'repairs'
            : 'reports'
          : kind === 'context-brief' || kind === 'procedure' || kind === 'git-proposal'
            ? 'attempts'
            : null;
}

function validateObservationProjection(projection: NativeProjection, field: string | null, measured: boolean): void {
  if (measured) {
    if (field === null || !('object' in projection) || !('collect' in (projection.object[field] ?? {})))
      throw new Error('Measured sources must collect one native observation from every independent trial.');
    return;
  }
  const selections = projectionSelections(projection);
  if (selections.length === 0 || selections.some(item => item.trial !== 0))
    throw new Error('Static sources must select exactly one trial (trial 0).');
}

export function projectionSelections(
  projection: NativeProjection,
): readonly {select: string; pointer: string; trial: number}[] {
  if ('select' in projection) return [projection];
  if ('collect' in projection) return [{select: projection.collect, pointer: projection.pointer, trial: -1}];
  return ('array' in projection ? projection.array : Object.values(projection.object)).flatMap(projectionSelections);
}

export function projectNativeRecord(
  plan: Threadnote5CollectionPlan,
  recipe: CollectionRecipe,
  kind: Threadnote5LocalSourceKindV1,
  trials: readonly Readonly<Record<string, unknown>>[],
) {
  const projection = recipe.exports[kind];
  const count = THREADNOTE_5_COLLECTION_MATRIX.find(item => item[0] === recipe.scenario)![1].find(
    item => item[0] === kind,
  )![1];
  const field = collectionObservationField(recipe.scenario, kind);
  validateObservationProjection(projection, field, count > 1);
  const artifact = projectNativeCapture(projection, trials);
  assertCollectionCardinality(recipe.scenario, kind, artifact, plan.measuredTrials);
  const observations = field === null ? [artifact] : (nativePointer(artifact, `/${field}`) as unknown[]);
  if (observations.some(value => value === null || typeof value !== 'object' || Array.isArray(value)))
    throw new Error('A source observation must be one native object, not a batch.');
  const digests = observations.map(value => sha256HexSync(canonicalJson(value)));
  if (new Set(digests).size !== digests.length)
    throw new Error('Source observations must not be reused across measured trials.');
  const provenance = observations.map((_, index) => ({
    trialId: collectionTrialIdentity(plan.runId, recipe.scenario, count > 1 ? index : 0).trialId,
    observationDigest: digests[index],
  }));
  return {artifact, provenance};
}

function parseStep(value: unknown): CollectionStep {
  const source = object(value);
  const common = ['id', 'type', 'surface'];
  identifier(source.id);
  if (source.surface !== 'primary' && source.surface !== 'secondary') throw new Error('Invalid isolated surface.');
  if (source.type === 'cli') {
    exact(source, [...common, 'argv', 'expectedExit']);
    if (
      !Array.isArray(source.argv) ||
      source.argv.length === 0 ||
      source.argv.length > 128 ||
      source.argv.some(value => typeof value !== 'string' || value.length > 65536)
    )
      throw new Error('Invalid candidate argv.');
    integer(source.expectedExit, 0, 255);
  } else if (source.type === 'mcp') {
    exact(source, [...common, 'tool', 'arguments']);
    identifier(source.tool);
    object(source.arguments);
  } else if (source.type === 'read-json' || source.type === 'write') {
    exact(source, [...common, 'root', 'path', ...(source.type === 'write' ? ['text'] : [])]);
    if (source.root !== 'home' && source.root !== 'repo') throw new Error('Invalid isolated file root.');
    relativeFile(source.path);
    if (source.type === 'write' && (typeof source.text !== 'string' || source.text.length > 1024 * 1024))
      throw new Error('Invalid synthetic input text.');
  } else throw new Error('Unsupported collection step.');
  return source as unknown as CollectionStep;
}

export function relativeFile(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some(part => !part || part === '.' || part === '..') ||
    [...value].some(char => char.charCodeAt(0) < 32)
  )
    throw new Error('Collection file must be a confined relative path.');
  return value;
}

function validateProjection(value: unknown, sources: ReadonlySet<string>, trials: number, depth: number): void {
  if (depth > 24) throw new Error('Native projection is too deep.');
  const source = object(value);
  if ('select' in source || 'collect' in source) {
    const collect = 'collect' in source;
    exact(source, collect ? ['collect', 'pointer', 'flatten'] : ['select', 'pointer', 'trial']);
    if (
      !sources.has(String(source[collect ? 'collect' : 'select'])) ||
      typeof source.pointer !== 'string' ||
      (source.pointer !== '' && !source.pointer.startsWith('/'))
    )
      throw new Error('Projection must select a captured native source.');
    if (collect ? typeof source.flatten !== 'boolean' : integer(source.trial, 0, trials - 1) < 0)
      throw new Error('Invalid projection cardinality.');
  } else if ('array' in source) {
    exact(source, ['array']);
    if (!Array.isArray(source.array)) throw new Error('Invalid projection array.');
    source.array.forEach(value => validateProjection(value, sources, trials, depth + 1));
  } else {
    exact(source, ['object']);
    Object.values(object(source.object)).forEach(value => validateProjection(value, sources, trials, depth + 1));
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Collection input must be an object.');
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = object(value);
  if (canonicalJson(Object.keys(result).sort()) !== canonicalJson([...keys].sort()))
    throw new Error('Collection input has missing or extra fields.');
  return result;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,95}$/u.test(value))
    throw new Error('Invalid collection identity.');
  return value;
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new Error('Invalid collection count.');
  return value;
}
