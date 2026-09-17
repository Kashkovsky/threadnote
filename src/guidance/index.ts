import {DateTime, Effect, FileSystem, Path, Schema} from 'effect';
import {resolveRepositoryIdentity} from '../code_graph/repository.js';
import {sha256HexSync} from '../crypto/sha256.js';
import {
  atomicAgentWrite,
  assertAgentTargetNotSymlink,
  removeAgentTargetIfUnchanged,
} from '../agent_integration/index.js';
import {withAgentIntegrationLock} from '../agent_integration/registry.js';
import type {AgentAdapter} from '../agent_integration/adapters/contract.js';
import {AGENT_ADAPTERS} from '../agent_integration/adapters.js';
import {credentialScrubberBlocker} from '../share/scrubber.js';
import {buildExactDurableCandidateReview, listCandidateReviews, saveCandidateReview} from '../memory/candidate.js';
import {readActiveProjectMemoryRecords} from '../memory/maintenance_records.js';
import {parseResourceId} from '../storage/resource-id.js';
import type {RuntimeConfig} from '../types.js';
import {readFileIfExists} from '../utils.js';
import {SystemInfo} from '../effect/system.js';
import {USER_INSTRUCTIONS_END_MARKER, USER_INSTRUCTIONS_START_MARKER} from '../constants.js';

export const GUIDANCE_SCHEMA_VERSION = 1 as const;
export const GUIDANCE_BLOCK_START = '<!-- threadnote:project-guidance:start v1 -->';
export const GUIDANCE_BLOCK_END = '<!-- threadnote:project-guidance:end -->';
const MAX_IMPORT_BYTES = 60 * 1024;
const MAX_GUIDANCE_BLOCK_BYTES = 256 * 1024;
const MAX_GUIDANCE_RECEIPT_BYTES = 256 * 1024;
const MAX_GUIDANCE_SOURCES = 64;
const MAX_GUIDANCE_URI_BYTES = 4 * 1024;
const MAX_GUIDANCE_IDENTITY_BYTES = 4 * 1024;
const MAX_GUIDANCE_TARGET_BYTES = 1_024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export class GuidanceError extends Schema.TaggedError<GuidanceError>()('GuidanceError', {message: Schema.String}) {}

export interface GuidanceSourceV1 {
  readonly contentHash: string;
  readonly text: string;
  readonly uri: string;
}

export interface GuidanceReceiptV1 {
  readonly expectedManagedBlockHash: string;
  readonly previousManagedBlockHash: string | null;
  readonly project: string;
  readonly removeTargetWhenEmpty: boolean;
  readonly repositoryId: string;
  readonly sources: readonly {readonly contentHash: string; readonly uri: string}[];
  readonly state: 'current' | 'pending';
  readonly surface: string;
  readonly targetPath: string;
  readonly version: typeof GUIDANCE_SCHEMA_VERSION;
  readonly wrapperOwned: boolean;
}

export type GuidanceDriftState = 'current' | 'locally-modified' | 'missing-block' | 'stale-sources' | 'unavailable';

export interface GuidanceStatusV1 {
  readonly state: GuidanceDriftState;
  readonly surface: string;
}

export interface GuidanceHealthEvidenceV1 {
  readonly sourceUris: readonly string[];
  readonly state: Exclude<GuidanceDriftState, 'current'>;
}

export interface GuidanceProjectOptions {
  readonly apply: boolean;
  readonly cwd?: string;
  readonly force: boolean;
  readonly memory: readonly string[];
  readonly project: string;
}

export interface GuidanceImportOptions {
  readonly apply: boolean;
  readonly cwd?: string;
  readonly project: string;
}

export interface GuidanceRemoveOptions {
  readonly apply: boolean;
  readonly cwd?: string;
  readonly force: boolean;
  readonly project: string;
}

export function renderManagedGuidanceBlock(sources: readonly GuidanceSourceV1[]): string {
  const canonical = canonicalSources(sources);
  if (canonical.length === 0 || canonical.length > MAX_GUIDANCE_SOURCES)
    throw new Error(`Project guidance requires between 1 and ${MAX_GUIDANCE_SOURCES} unique sources.`);
  for (const source of canonical) {
    if (
      source.uri.includes(GUIDANCE_BLOCK_START) ||
      source.uri.includes(GUIDANCE_BLOCK_END) ||
      source.text.includes(GUIDANCE_BLOCK_START) ||
      source.text.includes(GUIDANCE_BLOCK_END)
    )
      throw new Error('Project guidance source contains a reserved managed-block marker.');
    if (!SHA256_PATTERN.test(source.contentHash)) throw new Error('Project guidance source hash is invalid.');
  }
  const sourceMetadata = canonical.map(({contentHash, uri}) => ({contentHash, uri}));
  const contentHash = sha256HexSync(canonical.map(source => `${source.uri}\n${source.text}`).join('\n\n'));
  const block = [
    GUIDANCE_BLOCK_START,
    `<!-- threadnote:project-guidance:metadata ${JSON.stringify({contentHash, schemaVersion: GUIDANCE_SCHEMA_VERSION, sources: sourceMetadata})} -->`,
    ...canonical.map(source => `## Source ${source.uri}\n\n${source.text.trimEnd()}`),
    GUIDANCE_BLOCK_END,
  ].join('\n\n');
  if (new TextEncoder().encode(block).byteLength > MAX_GUIDANCE_BLOCK_BYTES)
    throw new Error(`Managed project guidance exceeds ${MAX_GUIDANCE_BLOCK_BYTES} UTF-8 bytes.`);
  if (hasMalformedGuidanceBlock(block) || guidanceBlock(block) !== block)
    throw new Error('Managed project guidance could not be rendered as one complete block.');
  return block;
}

export function guidanceImportReviewId(surface: string, project: string, imported: string): string {
  return `review-guidance-${sha256HexSync(`${surface}\n${project}\n${imported}`).slice(0, 16)}`;
}

export function guidanceBlock(content: string): string | undefined {
  const start = content.indexOf(GUIDANCE_BLOCK_START);
  const end = content.indexOf(GUIDANCE_BLOCK_END);
  if (start < 0 || end < start || content.indexOf(GUIDANCE_BLOCK_START, start + 1) >= 0) return undefined;
  return content.slice(start, end + GUIDANCE_BLOCK_END.length);
}

export function hasMalformedGuidanceBlock(content: string): boolean {
  const starts = content.split(GUIDANCE_BLOCK_START).length - 1;
  const ends = content.split(GUIDANCE_BLOCK_END).length - 1;
  return (
    starts !== ends ||
    starts > 1 ||
    (starts === 1 && content.indexOf(GUIDANCE_BLOCK_END) < content.indexOf(GUIDANCE_BLOCK_START))
  );
}

export function upsertGuidanceBlock(
  content: string | undefined,
  block: string,
  wrapper?: {readonly prefix: string; readonly suffix: string},
): string {
  const current = content ?? '';
  if (hasMalformedGuidanceBlock(current)) throw new Error('Project guidance markers are incomplete or duplicated.');
  const existing = guidanceBlock(current);
  if (existing !== undefined) return current.replace(existing, block);
  const prefix = current.length === 0 ? (wrapper?.prefix ?? '') : '';
  const suffix = current.length === 0 ? (wrapper?.suffix ?? '') : '';
  return `${current}${prefix}${block}${suffix}`;
}

export function removeGuidanceBlock(content: string): string | undefined {
  if (hasMalformedGuidanceBlock(content)) return undefined;
  const block = guidanceBlock(content);
  if (block === undefined) return undefined;
  const index = content.indexOf(block);
  const next = `${content.slice(0, index)}${content.slice(index + block.length)}`;
  return next.length === 0 ? '' : next;
}

function removeProjectedGuidance(
  content: string,
  wrapper: {readonly prefix: string; readonly suffix: string} | undefined,
  wrapperOwned: boolean,
): string | undefined {
  const block = guidanceBlock(content);
  if (block === undefined) return undefined;
  if (wrapperOwned && wrapper) {
    const envelope = `${wrapper.prefix}${block}${wrapper.suffix}`;
    const envelopeIndex = content.indexOf(envelope);
    if (envelopeIndex >= 0)
      return `${content.slice(0, envelopeIndex)}${content.slice(envelopeIndex + envelope.length)}`;
  }
  return removeGuidanceBlock(content);
}

function hasMalformedBootstrapBlock(content: string): boolean {
  const starts = content.split(USER_INSTRUCTIONS_START_MARKER).length - 1;
  const ends = content.split(USER_INSTRUCTIONS_END_MARKER).length - 1;
  return (
    starts !== ends ||
    starts > 1 ||
    (starts === 1 && content.indexOf(USER_INSTRUCTIONS_END_MARKER) < content.indexOf(USER_INSTRUCTIONS_START_MARKER))
  );
}

export function stripThreadnoteManagedGuidance(content: string): string {
  if (hasMalformedGuidanceBlock(content) || hasMalformedBootstrapBlock(content))
    throw new Error('Threadnote-managed guidance markers are incomplete, reversed, or duplicated.');
  const withoutProject = removeGuidanceBlock(content) ?? content;
  const start = withoutProject.indexOf(USER_INSTRUCTIONS_START_MARKER);
  const end = withoutProject.indexOf(USER_INSTRUCTIONS_END_MARKER);
  if (start < 0 || end < start) return withoutProject;
  const before = withoutProject.slice(0, start);
  const after = withoutProject.slice(end + USER_INSTRUCTIONS_END_MARKER.length);
  return before.endsWith('\n') && after.startsWith('\n') ? `${before}${after.slice(1)}` : `${before}${after}`;
}

export const runGuidanceImport = Effect.fn('guidance.import')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: GuidanceImportOptions,
) {
  const contract = guidanceContract(adapter);
  const root = yield* projectRoot(options.cwd);
  const contents = yield* Effect.forEach(contract.importPaths, relative => readGuidanceTarget(root, relative));
  if (
    contents.some(
      content => content !== undefined && (hasMalformedGuidanceBlock(content) || hasMalformedBootstrapBlock(content)),
    )
  )
    return yield* GuidanceError.make({
      message: 'Threadnote-managed guidance markers are incomplete, reversed, or duplicated; import refused.',
    });
  const imported = contents
    .filter((value): value is string => value !== undefined)
    .map(stripThreadnoteManagedGuidance)
    .map(value => value.trim())
    .filter(Boolean)
    .join('\n\n');
  if (new TextEncoder().encode(imported).byteLength > MAX_IMPORT_BYTES)
    return yield* GuidanceError.make({message: `Imported guidance exceeds ${MAX_IMPORT_BYTES} bytes.`});
  const blocker = credentialScrubberBlocker(imported);
  if (blocker)
    return yield* GuidanceError.make({message: `Imported guidance contains ${blocker}; it was not persisted.`});
  if (!imported) return {mode: 'empty' as const};
  const fingerprint = sha256HexSync(`${adapter.catalog.id}\n${options.project}\n${imported}`);
  const reviewId = guidanceImportReviewId(adapter.catalog.id, options.project, imported);
  if (!options.apply) return {mode: 'preview' as const, revision: 1, reviewId};
  return yield* withAgentIntegrationLock(
    config,
    Effect.gen(function* () {
      const existing = yield* listCandidateReviews(config.agentContextHome);
      const task = `guidance-import:${fingerprint}`;
      const previous = existing.find(review => review.project === options.project && review.task === task);
      if (previous) return {mode: 'reused' as const, revision: previous.revision, reviewId: previous.reviewId};
      const records = yield* readActiveProjectMemoryRecords(config, options.project);
      const built = yield* buildExactDurableCandidateReview(
        {
          evidence: [`guidance-import:${adapter.catalog.id}:${fingerprint}`],
          outcome: 'Imported project guidance requires explicit candidate review before it becomes memory.',
          project: options.project,
          sourceAgentClient: 'threadnote-guidance',
          task,
          topic: `guidance-import-${adapter.catalog.id}`,
        },
        imported,
        records,
        yield* DateTime.nowAsDate,
      );
      const review = {
        ...built,
        auditEvents: built.auditEvents.map(event => ({...event, reviewId})),
        candidates: built.candidates.map((candidate, index) => ({
          ...candidate,
          candidateId: `${reviewId}-${index + 1}`,
        })),
        reviewId,
      };
      yield* saveCandidateReview(config.agentContextHome, review);
      return {mode: 'created' as const, revision: review.revision, reviewId: review.reviewId};
    }),
  );
});

export const runGuidanceProject = Effect.fn('guidance.project')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: GuidanceProjectOptions,
) {
  const contract = guidanceContract(adapter);
  const root = yield* projectRoot(options.cwd);
  const repository = yield* resolveRepositoryIdentity(root);
  const target = yield* safeTarget(root, contract.projection.relativePath);
  const plan = () =>
    guidanceProjectionPlan(config, adapter, options, root, repository.repositoryId, target).pipe(
      Effect.map(value => ({...value, receipt: {...value.receipt, state: 'pending' as const}})),
    );
  if (!options.apply) {
    const preview = yield* plan();
    return {
      mode: 'preview' as const,
      receipt: {...preview.receipt, previousManagedBlockHash: null, state: 'current' as const},
      state: preview.state,
    };
  }
  return yield* withAgentIntegrationLock(
    config,
    Effect.gen(function* () {
      const mutation = yield* plan();
      const currentReceipt = {
        ...mutation.receipt,
        previousManagedBlockHash: null,
        state: 'current' as const,
      };
      if (mutation.resumePending) {
        yield* writeReceipt(config, currentReceipt);
        return {mode: 'resumed' as const, receipt: currentReceipt, state: mutation.state};
      }
      yield* writeReceipt(config, mutation.receipt);
      yield* assertGuidanceTarget(root, target);
      yield* atomicAgentWrite(target, mutation.next, 0o644, {content: mutation.current});
      yield* writeReceipt(config, currentReceipt);
      return {mode: 'applied' as const, receipt: currentReceipt, state: mutation.state};
    }),
  );
});

export const runGuidanceStatus = Effect.fn('guidance.status')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  project: string,
  cwd?: string,
) {
  const root = yield* projectRoot(cwd);
  const repository = yield* resolveRepositoryIdentity(root);
  return yield* projectStatus(config, adapter, project, root, repository.repositoryId).pipe(
    Effect.orElseSucceed(() => ({state: 'unavailable' as const, surface: adapter.catalog.id})),
  );
});

export const guidanceHealthEvidence = Effect.fn('guidance.healthEvidence')(function* (
  config: RuntimeConfig,
  project: string,
  cwd: string,
) {
  const root = yield* projectRoot(cwd);
  const repository = yield* resolveRepositoryIdentity(root);
  const evidence: readonly (GuidanceHealthEvidenceV1 | undefined)[] = yield* Effect.forEach(
    AGENT_ADAPTERS.filter(adapter => adapter.guidance !== undefined),
    adapter =>
      Effect.gen(function* () {
        const receipt = yield* readReceipt(
          config,
          repository.repositoryId,
          project,
          adapter.catalog.id,
          guidanceContract(adapter).projection.relativePath,
        );
        if (!receipt) return undefined;
        const status = yield* projectStatus(config, adapter, project, root, repository.repositoryId).pipe(
          Effect.orElseSucceed(() => ({state: 'unavailable' as const, surface: adapter.catalog.id})),
        );
        if (!isGuidanceDriftState(status.state)) return undefined;
        return {sourceUris: receipt.sources.map(source => source.uri), state: status.state};
      }),
    {concurrency: 4},
  );
  return evidence.filter((value): value is GuidanceHealthEvidenceV1 => value !== undefined);
});

export const guidanceSourceUrisForChangedPaths = Effect.fn('guidance.changedPathSources')(function* (
  config: RuntimeConfig,
  project: string,
  cwd: string,
  changedPaths: readonly string[],
) {
  const root = yield* projectRoot(cwd);
  const repository = yield* resolveRepositoryIdentity(root);
  const changed = new Set(changedPaths);
  const receipts = yield* Effect.forEach(
    AGENT_ADAPTERS.filter(adapter => adapter.guidance !== undefined),
    adapter =>
      readReceipt(
        config,
        repository.repositoryId,
        project,
        adapter.catalog.id,
        guidanceContract(adapter).projection.relativePath,
      ),
    {concurrency: 4},
  );
  return [
    ...new Set(
      receipts.flatMap(receipt =>
        receipt && changed.has(receipt.targetPath) ? receipt.sources.map(source => source.uri) : [],
      ),
    ),
  ].sort(compareText);
});

function isGuidanceDriftState(value: string): value is GuidanceHealthEvidenceV1['state'] {
  return (
    value === 'locally-modified' || value === 'missing-block' || value === 'stale-sources' || value === 'unavailable'
  );
}

export const runGuidanceRemove = Effect.fn('guidance.remove')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: GuidanceRemoveOptions,
) {
  const contract = guidanceContract(adapter);
  const root = yield* projectRoot(options.cwd);
  const repository = yield* resolveRepositoryIdentity(root);
  const plan = Effect.fn('guidance.remove.plan')(function* () {
    const receipt = yield* readReceipt(
      config,
      repository.repositoryId,
      options.project,
      adapter.catalog.id,
      contract.projection.relativePath,
    );
    if (!receipt) return {kind: 'absent' as const};
    const target = yield* safeTarget(root, contract.projection.relativePath);
    const current = yield* readGuidanceTargetByPath(root, target);
    if (current === undefined) {
      if (!options.force) return {kind: 'missing' as const};
      return {kind: 'receipt-only' as const};
    }
    if (hasMalformedGuidanceBlock(current))
      return yield* GuidanceError.make({message: 'Project guidance markers are malformed; removal refused.'});
    const block = guidanceBlock(current);
    if ((!block || sha256HexSync(block) !== receipt.expectedManagedBlockHash) && !options.force)
      return yield* GuidanceError.make({message: 'Guidance block changed or is missing; rerun with --force.'});
    if (!block) return {kind: 'receipt-only' as const};
    const next = removeProjectedGuidance(current, contract.projection.wrapper, receipt.wrapperOwned)!;
    return {current, kind: 'target' as const, next, receipt, target};
  });
  if (!options.apply) {
    const preview = yield* plan();
    if (preview.kind === 'absent') return {mode: 'absent' as const};
    if (preview.kind === 'missing') return {mode: 'missing' as const};
    return {
      mode: 'preview' as const,
      resolution: preview.kind,
      targetPath: contract.projection.relativePath,
    };
  }
  return yield* withAgentIntegrationLock(
    config,
    Effect.gen(function* () {
      const mutation = yield* plan();
      if (mutation.kind === 'absent') return {mode: 'absent' as const};
      if (mutation.kind === 'missing') return {mode: 'missing' as const};
      if (mutation.kind === 'target') {
        yield* assertGuidanceTarget(root, mutation.target);
        if (mutation.next === '' && mutation.receipt.removeTargetWhenEmpty)
          yield* removeAgentTargetIfUnchanged(mutation.target, mutation.current);
        else yield* atomicAgentWrite(mutation.target, mutation.next, 0o644, {content: mutation.current});
      }
      yield* removeReceipt(config, repository.repositoryId, options.project, adapter.catalog.id);
      return {
        mode: 'removed' as const,
        resolution: mutation.kind,
        targetPath: contract.projection.relativePath,
      };
    }),
  );
});

function guidanceContract(adapter: AgentAdapter) {
  if (!adapter.guidance) throw new Error(`${adapter.catalog.id} does not declare project guidance support.`);
  return adapter.guidance;
}

function canonicalSources(sources: readonly GuidanceSourceV1[]): readonly GuidanceSourceV1[] {
  const byUri = new Map<string, GuidanceSourceV1>();
  for (const source of sources) byUri.set(source.uri, source);
  return [...byUri.values()].sort((left, right) => compareText(left.uri, right.uri));
}

const guidanceSources = Effect.fn('guidance.sources')(function* (
  config: RuntimeConfig,
  project: string,
  uris: readonly string[],
) {
  if (uris.length === 0) return yield* GuidanceError.make({message: 'Provide at least one --memory URI.'});
  if (uris.length > MAX_GUIDANCE_SOURCES)
    return yield* GuidanceError.make({message: `Provide at most ${MAX_GUIDANCE_SOURCES} --memory URIs.`});
  if (new Set(uris).size !== uris.length)
    return yield* GuidanceError.make({message: 'Provide each --memory URI only once.'});
  const records = yield* readActiveProjectMemoryRecords(config, project);
  const recordsByUri = new Map(records.map(record => [record.uri, record]));
  return yield* Effect.try({
    try: () =>
      uris.map(uri => {
        const record = recordsByUri.get(uri);
        if (!record || record.metadata.kind !== 'durable')
          throw new Error(`Memory ${uri} is not an active durable project memory.`);
        return {contentHash: sha256HexSync(record.body), text: record.body, uri};
      }),
    catch: cause => GuidanceError.make({message: cause instanceof Error ? cause.message : String(cause)}),
  });
});

const guidanceProjectionPlan = Effect.fn('guidance.project.plan')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: GuidanceProjectOptions,
  root: string,
  repositoryId: string,
  target: string,
) {
  const contract = guidanceContract(adapter);
  const sources = yield* guidanceSources(config, options.project, options.memory);
  const block = yield* Effect.try({
    try: () => renderManagedGuidanceBlock(sources),
    catch: cause => GuidanceError.make({message: cause instanceof Error ? cause.message : String(cause)}),
  });
  const current = yield* readGuidanceTargetByPath(root, target);
  if (hasMalformedGuidanceBlock(current ?? ''))
    return yield* GuidanceError.make({
      message: 'Project guidance markers are incomplete, reversed, or duplicated; projection refused.',
    });
  const previous = yield* readReceipt(
    config,
    repositoryId,
    options.project,
    adapter.catalog.id,
    contract.projection.relativePath,
  );
  const state = yield* projectStatusFromEvidence(config, adapter, options.project, previous, current);
  const existingBlock = guidanceBlock(current ?? '');
  const previousWrapperReusable =
    previous?.wrapperOwned === true &&
    wrapperOwnershipMatches(current, existingBlock, contract.projection.wrapper, true);
  const wrapperOwned =
    previousWrapperReusable ||
    (existingBlock === undefined && (current ?? '').length === 0 && contract.projection.wrapper !== undefined);
  const draftReceipt: GuidanceReceiptV1 = {
    expectedManagedBlockHash: sha256HexSync(block),
    previousManagedBlockHash: null,
    project: options.project,
    removeTargetWhenEmpty: previous?.removeTargetWhenEmpty ?? current === undefined,
    repositoryId,
    sources: canonicalSources(sources).map(({contentHash, uri}) => ({contentHash, uri})),
    state: 'pending',
    surface: adapter.catalog.id,
    targetPath: contract.projection.relativePath,
    version: GUIDANCE_SCHEMA_VERSION,
    wrapperOwned,
  };
  const continuingPending = previous?.state === 'pending' && receiptsDescribeSameProjection(previous, draftReceipt);
  const receipt: GuidanceReceiptV1 = {
    ...draftReceipt,
    previousManagedBlockHash: continuingPending
      ? previous.previousManagedBlockHash
      : existingBlock === undefined
        ? null
        : sha256HexSync(existingBlock),
  };
  yield* Effect.try({
    try: () =>
      parseGuidanceReceiptV1(receipt, {
        project: options.project,
        repositoryId,
        surface: adapter.catalog.id,
        targetPath: contract.projection.relativePath,
      }),
    catch: () => GuidanceError.make({message: 'Generated guidance receipt exceeds its strict bounds.'}),
  });
  const wrapper = contract.projection.wrapper;
  const next =
    wrapperOwned && existingBlock === undefined && current === `${wrapper?.prefix ?? ''}${wrapper?.suffix ?? ''}`
      ? `${wrapper?.prefix ?? ''}${block}${wrapper?.suffix ?? ''}`
      : upsertGuidanceBlock(current, block, wrapperOwned ? wrapper : undefined);
  const resumePending = continuingPending && current === next;
  const continuePending = continuingPending && pendingTargetMatchesPrevious(previous, existingBlock);
  if (
    existingBlock !== undefined &&
    state.state === 'unavailable' &&
    !options.force &&
    !resumePending &&
    !continuePending
  )
    return yield* GuidanceError.make({
      message:
        'A project guidance block exists without a matching current receipt; rerun with --force to replace only that block.',
    });
  if ((state.state === 'locally-modified' || state.state === 'missing-block') && !options.force)
    return yield* GuidanceError.make({
      message: `Guidance projection is ${state.state}; rerun with --force to replace only its managed block.`,
    });
  return {current, next, receipt, resumePending, state: state.state};
});

const projectStatus = Effect.fn('guidance.projectStatus')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  project: string,
  root: string,
  repositoryId: string,
) {
  const contract = guidanceContract(adapter);
  const receipt = yield* readReceipt(
    config,
    repositoryId,
    project,
    adapter.catalog.id,
    contract.projection.relativePath,
  );
  const target = yield* safeTarget(root, contract.projection.relativePath);
  const current = yield* readGuidanceTargetByPath(root, target);
  return yield* projectStatusFromEvidence(config, adapter, project, receipt, current);
});

const projectStatusFromEvidence = Effect.fn('guidance.projectStatusFromEvidence')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  project: string,
  receipt: GuidanceReceiptV1 | undefined,
  current: string | undefined,
) {
  if (!receipt || receipt.state !== 'current') return {state: 'unavailable' as const, surface: adapter.catalog.id};
  if (current !== undefined && hasMalformedGuidanceBlock(current))
    return {state: 'unavailable' as const, surface: adapter.catalog.id};
  const block = current === undefined ? undefined : guidanceBlock(current);
  if (!block) return {state: 'missing-block' as const, surface: adapter.catalog.id};
  if (
    sha256HexSync(block) !== receipt.expectedManagedBlockHash ||
    !wrapperOwnershipMatches(current, block, guidanceContract(adapter).projection.wrapper, receipt.wrapperOwned)
  )
    return {state: 'locally-modified' as const, surface: adapter.catalog.id};
  const records = yield* readActiveProjectMemoryRecords(config, project);
  const currentHashes = new Map(records.map(record => [record.uri, sha256HexSync(record.body)]));
  if (receipt.sources.some(source => currentHashes.get(source.uri) !== source.contentHash))
    return {state: 'stale-sources' as const, surface: adapter.catalog.id};
  return {state: 'current' as const, surface: adapter.catalog.id};
});

const projectRoot = Effect.fn('guidance.projectRoot')(function* (cwd?: string) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  return path.resolve(cwd ?? system.currentDirectory());
});

const safeTarget = Effect.fn('guidance.safeTarget')(function* (root: string, relativePath: string) {
  const path = yield* Path.Path;
  if (relativePath.length === 0 || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes('..'))
    return yield* GuidanceError.make({message: 'Adapter guidance target escapes the project root.'});
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`))
    return yield* GuidanceError.make({message: 'Adapter guidance target escapes the project root.'});
  return target;
});

const readGuidanceTarget = Effect.fn('guidance.readTarget')(function* (root: string, relativePath: string) {
  const target = yield* safeTarget(root, relativePath);
  return yield* readGuidanceTargetByPath(root, target);
});

const readGuidanceTargetByPath = Effect.fn('guidance.readTargetByPath')(function* (root: string, target: string) {
  yield* assertGuidanceTarget(root, target);
  return yield* readFileIfExists(target);
});

const assertGuidanceTarget = Effect.fn('guidance.assertTarget')(function* (root: string, target: string) {
  const path = yield* Path.Path;
  let current = target;
  while (true) {
    yield* assertAgentTargetNotSymlink(current);
    if (current === root || current === path.dirname(current)) break;
    current = path.dirname(current);
  }
});

function wrapperOwnershipMatches(
  current: string | undefined,
  block: string | undefined,
  wrapper: {readonly prefix: string; readonly suffix: string} | undefined,
  wrapperOwned: boolean,
): boolean {
  if (!wrapperOwned) return true;
  if (!wrapper) return false;
  if (current === undefined) return true;
  if (block === undefined) return current === `${wrapper.prefix}${wrapper.suffix}`;
  return current.startsWith(`${wrapper.prefix}${block}${wrapper.suffix}`);
}

function receiptsDescribeSameProjection(left: GuidanceReceiptV1, right: GuidanceReceiptV1): boolean {
  return (
    left.expectedManagedBlockHash === right.expectedManagedBlockHash &&
    left.project === right.project &&
    left.removeTargetWhenEmpty === right.removeTargetWhenEmpty &&
    left.repositoryId === right.repositoryId &&
    left.surface === right.surface &&
    left.targetPath === right.targetPath &&
    left.wrapperOwned === right.wrapperOwned &&
    JSON.stringify(left.sources) === JSON.stringify(right.sources)
  );
}

function pendingTargetMatchesPrevious(receipt: GuidanceReceiptV1 | undefined, block: string | undefined): boolean {
  if (!receipt || receipt.state !== 'pending') return false;
  return receipt.previousManagedBlockHash === null
    ? block === undefined
    : block !== undefined && sha256HexSync(block) === receipt.previousManagedBlockHash;
}

function receiptPath(path: Path.Path, home: string, repositoryId: string, project: string, surface: string): string {
  return path.join(
    home,
    'guidance',
    'v1',
    'receipts',
    `${sha256HexSync([repositoryId, project, surface].join('\n'))}.json`,
  );
}

const readReceipt = Effect.fn('guidance.readReceipt')(function* (
  config: RuntimeConfig,
  repositoryId: string,
  project: string,
  surface: string,
  targetPath: string,
) {
  const path = yield* Path.Path;
  const raw = yield* readBoundedReceiptFile(receiptPath(path, config.agentContextHome, repositoryId, project, surface));
  if (raw === undefined) return undefined;
  return yield* Effect.try({
    try: () => parseGuidanceReceiptV1(JSON.parse(raw), {project, repositoryId, surface, targetPath}),
    catch: () => GuidanceError.make({message: 'Guidance receipt is invalid.'}),
  });
});

export function parseGuidanceReceiptV1(
  value: unknown,
  expected: {
    readonly project: string;
    readonly repositoryId: string;
    readonly surface: string;
    readonly targetPath: string;
  },
): GuidanceReceiptV1 {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as {version?: unknown}).version !== GUIDANCE_SCHEMA_VERSION ||
    !['current', 'pending'].includes(String((value as {state?: unknown}).state))
  )
    throw new Error('invalid receipt');
  const receipt = value as Partial<GuidanceReceiptV1>;
  if (
    !hasExactKeys(value, [
      'expectedManagedBlockHash',
      'previousManagedBlockHash',
      'project',
      'removeTargetWhenEmpty',
      'repositoryId',
      'sources',
      'state',
      'surface',
      'targetPath',
      'version',
      'wrapperOwned',
    ])
  )
    throw new Error('invalid receipt');
  if (
    typeof receipt.repositoryId !== 'string' ||
    typeof receipt.project !== 'string' ||
    typeof receipt.surface !== 'string' ||
    typeof receipt.targetPath !== 'string' ||
    typeof receipt.expectedManagedBlockHash !== 'string' ||
    (receipt.previousManagedBlockHash !== null && typeof receipt.previousManagedBlockHash !== 'string') ||
    typeof receipt.removeTargetWhenEmpty !== 'boolean' ||
    typeof receipt.wrapperOwned !== 'boolean' ||
    receipt.repositoryId !== expected.repositoryId ||
    receipt.project !== expected.project ||
    receipt.surface !== expected.surface ||
    receipt.targetPath !== expected.targetPath ||
    !SHA256_PATTERN.test(receipt.expectedManagedBlockHash) ||
    (typeof receipt.previousManagedBlockHash === 'string' && !SHA256_PATTERN.test(receipt.previousManagedBlockHash)) ||
    (receipt.state === 'current' && receipt.previousManagedBlockHash !== null) ||
    utf8Bytes(receipt.repositoryId) > MAX_GUIDANCE_IDENTITY_BYTES ||
    utf8Bytes(receipt.project) > MAX_GUIDANCE_IDENTITY_BYTES ||
    utf8Bytes(receipt.surface) > MAX_GUIDANCE_IDENTITY_BYTES ||
    utf8Bytes(receipt.targetPath) > MAX_GUIDANCE_TARGET_BYTES ||
    !Array.isArray(receipt.sources) ||
    receipt.sources.length === 0 ||
    receipt.sources.length > MAX_GUIDANCE_SOURCES ||
    receipt.sources.some(
      source =>
        !source ||
        !hasExactKeys(source, ['contentHash', 'uri']) ||
        typeof source.uri !== 'string' ||
        typeof source.contentHash !== 'string' ||
        utf8Bytes(source.uri) > MAX_GUIDANCE_URI_BYTES ||
        !SHA256_PATTERN.test(source.contentHash) ||
        !isCanonicalThreadnoteUri(source.uri),
    ) ||
    new Set(receipt.sources.map(source => source.uri)).size !== receipt.sources.length
  )
    throw new Error('invalid receipt');
  return receipt as GuidanceReceiptV1;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const canonical = [...expected].sort(compareText);
  return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
}

function isCanonicalThreadnoteUri(uri: string): boolean {
  try {
    return uri.startsWith('threadnote://') && parseResourceId(uri).canonicalUri === uri;
  } catch {
    return false;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const readBoundedReceiptFile = Effect.fn('guidance.readBoundedReceiptFile')(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(target))) return undefined;
  yield* assertAgentTargetNotSymlink(target);
  const info = yield* fs.stat(target);
  if (info.type !== 'File' || info.size > BigInt(MAX_GUIDANCE_RECEIPT_BYTES))
    return yield* GuidanceError.make({message: 'Guidance receipt is invalid or exceeds its byte limit.'});
  const raw = yield* fs.readFileString(target);
  if (utf8Bytes(raw) > MAX_GUIDANCE_RECEIPT_BYTES)
    return yield* GuidanceError.make({message: 'Guidance receipt exceeds its byte limit.'});
  return raw;
});

const writeReceipt = Effect.fn('guidance.writeReceipt')(function* (config: RuntimeConfig, receipt: GuidanceReceiptV1) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = receiptPath(path, config.agentContextHome, receipt.repositoryId, receipt.project, receipt.surface);
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  const content = `${JSON.stringify(receipt, undefined, 2)}\n`;
  if (utf8Bytes(content) > MAX_GUIDANCE_RECEIPT_BYTES)
    return yield* GuidanceError.make({message: 'Guidance receipt exceeds its byte limit.'});
  const previous = yield* readBoundedReceiptFile(target);
  yield* atomicAgentWrite(target, content, 0o600, {content: previous});
});

const removeReceipt = Effect.fn('guidance.removeReceipt')(function* (
  config: RuntimeConfig,
  repositoryId: string,
  project: string,
  surface: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = receiptPath(path, config.agentContextHome, repositoryId, project, surface);
  yield* fs.remove(target).pipe(Effect.ignore);
});

export const renderGuidanceResult = (value: unknown, json: boolean) =>
  json ? JSON.stringify(value) : `Guidance ${JSON.stringify(value)}`;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
