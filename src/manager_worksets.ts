import {Cause, Clock, Crypto, Effect, Fiber, FileSystem, Path, Scope} from 'effect';
import {isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq} from 'yaml';
import {compileContextBrief, type ContextBriefMode} from './context_brief/index.js';
import {
  findCodeGraphWorksetPath,
  inspectCodeGraphWorksetTopology,
  traceCodeGraphWorksetImpact,
} from './code_graph/cross_repository/runtime.js';
import {codeGraphWorksetCatalogLayout} from './code_graph/workset_catalog/layout.js';
import {CodeGraphWorksetCatalogError} from './code_graph/workset_catalog/types.js';
import {
  inspectCodeGraphWorksetStatus,
  prepareCodeGraphWorkset,
  type CodeGraphWorksetPrepareResultV1,
} from './code_graph/workset_catalog/workset.js';
import {
  readPublishedCodeGraphWorksetCatalogGeneration,
  retireCodeGraphWorksetPublication,
} from './code_graph/workset_catalog/store.js';
import {continueCodeGraphWorksetQueryV2, queryCodeGraphWorksetV2} from './code_graph/workset_query_v2.js';
import {CODE_GRAPH_WORKSET_ROUTER_LIMITS} from './code_graph/workset_router.js';
import {observeRepositoryBranch} from './code_graph/repository.js';
import {sha256HexSync} from './crypto/sha256.js';
import {isFileLockTimeout, withExclusiveFileLock} from './effect/file_lock.js';
import type {ApplicationServices} from './effect/runtime.js';
import {parseSeedManifest, readSeedManifest} from './manifest.js';
import type {ProjectManifest, RuntimeConfig, SeedManifest, WorksetManifest} from './types.js';
import {expandPath} from './utils.js';

const UTF8 = new TextEncoder();
const MANAGER_WORKSET_DEFINITION_MAXIMUM = 4_096;
const MANAGER_WORKSET_MEMBER_MAXIMUM = 4_096;
const MANAGER_WORKSET_NAME_BYTES_MAXIMUM = 256;
const MANAGER_WORKSET_DESCRIPTION_BYTES_MAXIMUM = 4_096;
const MANAGER_WORKSET_QUERY_BYTES_MAXIMUM = CODE_GRAPH_WORKSET_ROUTER_LIMITS.queryBytesMaximum;
const MANAGER_WORKSET_SELECTOR_BYTES_MAXIMUM = 4_096;
const MANAGER_WORKSET_JOB_MAXIMUM = 32;
const MANAGER_WORKSET_BRANCH_OBSERVATION_MAXIMUM = 128;
const MANAGER_WORKSET_PREPARE_CONCURRENCY_MAXIMUM = 8;
const MANAGER_WORKSET_RESPONSE_TOKENS_MAXIMUM = 1_500;
const MANAGER_WORKSET_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 10_000,
} as const;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface ManagerWorksetDefinitionMember {
  readonly branch?: string;
  readonly branchState: 'current' | 'detached' | 'missing' | 'not-observed';
  readonly configured: boolean;
  readonly folder?: string;
  readonly path?: string;
  readonly project: string;
}

export interface ManagerWorksetProjectSummary {
  readonly branch?: string;
  readonly branchState: 'current' | 'detached' | 'missing' | 'not-observed';
  readonly folder: string;
  readonly name: string;
  readonly path: string;
}

export interface ManagerWorksetDefinition {
  readonly configuredMembers: number;
  readonly description?: string;
  readonly members: readonly ManagerWorksetDefinitionMember[];
  readonly name: string;
  readonly unresolvedMembers: number;
}

export interface ManagerWorksetDefinitionSummary {
  readonly description?: string;
  readonly memberCount: number;
  readonly name: string;
}

export interface ManagerWorksetCatalog {
  readonly definitions: readonly ManagerWorksetDefinitionSummary[];
  readonly definitionSource: 'seed-manifest';
  readonly editability: {
    readonly reason?: 'manifest-symlink' | 'unsupported-workset-yaml';
    readonly state: 'editable' | 'read-only';
  };
  readonly projects: readonly ManagerWorksetProjectSummary[];
  readonly readOnly: boolean;
  readonly revision: string;
  readonly type: 'manager-workset-catalog';
  readonly version: 1;
}

export type ManagerWorksetDefinitionMutation =
  | {
      readonly description?: string;
      readonly expectedRevision: string;
      readonly name: string;
      readonly operation: 'create';
      readonly projects: readonly string[];
    }
  | {
      readonly description?: string;
      readonly expectedRevision: string;
      readonly name: string;
      readonly operation: 'update';
      readonly projects: readonly string[];
      readonly workset: string;
    }
  | {
      readonly confirm: true;
      readonly expectedRevision: string;
      readonly operation: 'delete';
      readonly workset: string;
    };

export interface ManagerWorksetDefinitionMutationResult {
  readonly catalog: ManagerWorksetCatalog;
  readonly changed: boolean;
  readonly operation: ManagerWorksetDefinitionMutation['operation'];
  readonly warnings: readonly string[];
}

export type ManagerWorksetJobStatus = 'cancelled' | 'cancelling' | 'completed' | 'failed' | 'running';

export interface ManagerWorksetPrepareJob {
  readonly createdAt: string;
  readonly error?: string;
  readonly errorCode?: string;
  readonly finishedAt?: string;
  readonly id: string;
  readonly progress: {
    readonly completed?: number;
    readonly message: string;
    readonly phase: 'cancelled' | 'cancelling' | 'completed' | 'failed' | 'preparing';
    readonly total: number;
  };
  readonly result?: CodeGraphWorksetPrepareResultV1;
  readonly status: ManagerWorksetJobStatus;
  readonly workset: string;
}

export type ManagerWorksetPrepareJobSummary = Omit<ManagerWorksetPrepareJob, 'result'>;

export interface ManagerWorksetApiResponse {
  readonly body: unknown;
  readonly status: number;
}

export interface ManagerWorksetApiRequest {
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
  readonly config: RuntimeConfig;
  readonly contextKey: object;
  readonly jobScope: Scope.Scope;
  readonly method: string;
  readonly prepareWorkset?: (
    config: RuntimeConfig,
    worksetName: string,
    options: {readonly concurrency?: number},
  ) => Effect.Effect<CodeGraphWorksetPrepareResultV1, unknown, ApplicationServices>;
  readonly url: URL;
}

interface InternalManagerWorksetPrepareJob {
  fiber?: Fiber.Fiber<void>;
  job: ManagerWorksetPrepareJob;
}

interface ManagerWorksetJobRegistry {
  readonly jobs: Map<string, InternalManagerWorksetPrepareJob>;
  lifecycleScope?: Scope.Scope;
  mutating: boolean;
  starting: boolean;
}

class ManagerWorksetApiError extends Error {
  override readonly name = 'ManagerWorksetApiError';

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryAfterMilliseconds?: number,
  ) {
    super(message);
  }
}

const JOB_REGISTRIES = new WeakMap<object, ManagerWorksetJobRegistry>();

export function managerWorksetRequestAllowedDuringMaintenance(method: string, pathname: string): boolean {
  return (
    pathname === '/api/worksets' ||
    (method === 'GET' && pathname === '/api/worksets/definition') ||
    (method === 'GET' && (pathname === '/api/worksets/jobs' || pathname.startsWith('/api/worksets/jobs/'))) ||
    pathname === '/api/worksets/definitions' ||
    pathname === '/api/worksets/jobs/cancel'
  );
}

export function isManagerWorksetApiPath(pathname: string): boolean {
  return pathname === '/api/worksets' || pathname.startsWith('/api/worksets/');
}

export function managerWorksetCatalogFromManifest(
  manifest: SeedManifest,
  revision: string,
  editability: ManagerWorksetCatalog['editability'] = {state: 'editable'},
  projects: readonly ManagerWorksetProjectSummary[] = manifest.projects.map(project => ({
    branchState: 'not-observed',
    folder:
      project.path
        .replace(/[\\/]+$/u, '')
        .split(/[\\/]/u)
        .at(-1) || safeLabel(project.name),
    name: safeLabel(project.name),
    path: safeLocalPath(project.path),
  })),
): ManagerWorksetCatalog {
  if (!SHA256.test(revision)) throw new Error('Manager workset catalog revision is invalid.');
  assertUniqueManagerManifestIdentity(manifest);
  if ((manifest.worksets?.length ?? 0) > MANAGER_WORKSET_DEFINITION_MAXIMUM) {
    throw new Error(`The seed manifest exceeds ${MANAGER_WORKSET_DEFINITION_MAXIMUM} worksets.`);
  }
  if (manifest.projects.length > MANAGER_WORKSET_MEMBER_MAXIMUM) {
    throw new Error(`The seed manifest exceeds ${MANAGER_WORKSET_MEMBER_MAXIMUM} projects.`);
  }
  const definitions = (manifest.worksets ?? []).map(workset => {
    if (workset.projects.length > MANAGER_WORKSET_MEMBER_MAXIMUM) {
      throw new Error(`Workset ${safeLabel(workset.name)} exceeds the member limit.`);
    }
    return {
      ...(workset.description === undefined ? {} : {description: safeDescription(workset.description)}),
      memberCount: workset.projects.length,
      name: safeLabel(workset.name),
    } satisfies ManagerWorksetDefinitionSummary;
  });
  return {
    definitions,
    definitionSource: 'seed-manifest',
    editability,
    projects,
    readOnly: editability.state === 'read-only',
    revision,
    type: 'manager-workset-catalog',
    version: 1,
  };
}

export const readManagerWorksetCatalog = Effect.fn('managerWorksets.readCatalog')(function* (config: RuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(config.manifestPath);
  const manifest = yield* parseManifestForMutation(raw, config.manifestPath);
  yield* managerWorksetValidation(() => assertUniqueManagerManifestIdentity(manifest));
  const document = parseDocument(raw, {keepSourceTokens: true});
  const symbolicTarget = yield* fs.readLink(config.manifestPath).pipe(Effect.option);
  const projects = yield* observeManagerWorksetProjects(manifest.projects);
  return yield* managerWorksetValidation(() =>
    managerWorksetCatalogFromManifest(
      manifest,
      sha256HexSync(raw),
      symbolicTarget._tag === 'Some'
        ? {reason: 'manifest-symlink', state: 'read-only'}
        : managerWorksetYamlSupported(document)
          ? {state: 'editable'}
          : {reason: 'unsupported-workset-yaml', state: 'read-only'},
      projects,
    ),
  );
});

export const readManagerWorksetDefinition = Effect.fn('managerWorksets.readDefinition')(function* (
  config: RuntimeConfig,
  worksetName: string,
) {
  const manifest = yield* readSeedManifest(config.manifestPath);
  yield* managerWorksetValidation(() => assertUniqueManagerManifestIdentity(manifest));
  const workset = manifest.worksets?.find(item => item.name.toLowerCase() === worksetName.toLowerCase());
  if (!workset)
    return yield* Effect.fail(new ManagerWorksetApiError('workset-not-found', 'Workset definition not found.', 404));
  const projects = new Map(manifest.projects.map(project => [project.name.toLowerCase(), project]));
  const observed = yield* observeManagerWorksetProjects(
    workset.projects.flatMap(project => {
      const configured = projects.get(project.toLowerCase());
      return configured === undefined ? [] : [configured];
    }),
  );
  const observedByName = new Map(observed.map(project => [project.name.toLowerCase(), project]));
  const members = workset.projects.map(project => {
    const configured = observedByName.get(project.toLowerCase());
    return {
      ...(configured !== undefined && 'branch' in configured && configured.branch !== undefined
        ? {branch: configured.branch}
        : {}),
      branchState: configured?.branchState ?? 'missing',
      configured: configured !== undefined,
      ...(configured === undefined ? {} : {folder: configured.folder, path: configured.path}),
      project: safeLabel(project),
    };
  });
  return {
    configuredMembers: members.filter(member => member.configured).length,
    ...(workset.description === undefined ? {} : {description: safeDescription(workset.description)}),
    members,
    name: safeLabel(workset.name),
    unresolvedMembers: members.filter(member => !member.configured).length,
  } satisfies ManagerWorksetDefinition;
});

export const mutateManagerWorksetDefinition = Effect.fn('managerWorksets.mutateDefinition')(function* (
  config: RuntimeConfig,
  mutation: ManagerWorksetDefinitionMutation,
) {
  yield* managerWorksetValidation(() => validateExpectedRevision(mutation.expectedRevision));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockPath = `${config.manifestPath}.worksets.lock`;
  const promoted = yield* withExclusiveFileLock(
    fs,
    codeGraphWorksetCatalogLayout(path, config.agentContextHome).prepareLockPath,
    MANAGER_WORKSET_LOCK_OPTIONS,
    withExclusiveFileLock(
      fs,
      lockPath,
      MANAGER_WORKSET_LOCK_OPTIONS,
      Effect.gen(function* () {
        const symbolicTarget = yield* fs.readLink(config.manifestPath).pipe(Effect.option);
        if (symbolicTarget._tag === 'Some') {
          return yield* Effect.fail(
            new ManagerWorksetApiError(
              'manifest-symlink',
              'Workset definitions cannot edit a symbolic-link manifest.',
              409,
            ),
          );
        }
        const raw = yield* fs.readFileString(config.manifestPath);
        const revision = sha256HexSync(raw);
        if (revision !== mutation.expectedRevision) {
          return yield* Effect.fail(
            new ManagerWorksetApiError(
              'revision-conflict',
              'The seed manifest changed after it was loaded. Refresh Worksets and retry.',
              409,
            ),
          );
        }
        const manifest = yield* parseManifestForMutation(raw, config.manifestPath);
        const document = parseDocument(raw, {keepSourceTokens: true});
        if (document.errors.length > 0) {
          return yield* Effect.fail(
            new ManagerWorksetApiError('manifest-invalid', 'The seed manifest contains invalid YAML.', 409),
          );
        }
        const change = yield* managerWorksetValidation(() => {
          assertSupportedManagerWorksetYaml(document);
          return applyDefinitionMutation(document, manifest, mutation);
        });
        if (!change.changed) {
          return {
            catalog: yield* managerWorksetValidation(() => managerWorksetCatalogFromManifest(manifest, revision)),
            changed: false,
            operation: mutation.operation,
            retirementTargets: [],
            warnings: [],
          };
        }
        const candidate = String(document);
        const parsedCandidate = yield* parseManifestForMutation(candidate, config.manifestPath);
        const candidateCatalog = yield* managerWorksetValidation(() =>
          managerWorksetCatalogFromManifest(parsedCandidate, sha256HexSync(candidate)),
        );
        const retirementCaptures = yield* Effect.forEach(
          change.retireWorksets,
          worksetName =>
            readPublishedCodeGraphWorksetCatalogGeneration(config.agentContextHome, worksetName).pipe(
              Effect.map(generation =>
                generation === undefined
                  ? {target: undefined, warning: undefined}
                  : {target: {generationId: generation.id, worksetName}, warning: undefined},
              ),
              Effect.catch(() =>
                Effect.succeed({
                  target: undefined,
                  warning: `The manifest can be changed, but published storage for ${safeLabel(worksetName)} needs catalog repair before retirement.`,
                }),
              ),
            ),
          {concurrency: 1},
        );
        const crypto = yield* Crypto.Crypto;
        const temporary = path.join(
          path.dirname(config.manifestPath),
          `.${path.basename(config.manifestPath)}.worksets-${yield* crypto.randomUUIDv4}.tmp`,
        );
        yield* Effect.gen(function* () {
          yield* fs.writeFileString(temporary, candidate, {flag: 'wx', mode: 0o600});
          yield* fs.chmod(temporary, 0o600);
          const latestRaw = yield* fs.readFileString(config.manifestPath);
          const latestSymbolicTarget = yield* fs.readLink(config.manifestPath).pipe(Effect.option);
          if (sha256HexSync(latestRaw) !== revision || latestSymbolicTarget._tag === 'Some') {
            return yield* Effect.fail(
              new ManagerWorksetApiError(
                'revision-conflict',
                'The seed manifest changed while the workset edit was being prepared. Refresh Worksets and retry.',
                409,
              ),
            );
          }
          yield* fs.rename(temporary, config.manifestPath);
        }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.catch(() => Effect.void))));
        return {
          catalog: candidateCatalog,
          changed: true,
          operation: mutation.operation,
          retirementTargets: retirementCaptures.flatMap(capture =>
            capture.target === undefined ? [] : [capture.target],
          ),
          warnings: [
            ...change.warnings,
            ...retirementCaptures.flatMap(capture => (capture.warning === undefined ? [] : [capture.warning])),
          ],
        };
      }),
    ),
  ).pipe(
    Effect.mapError(cause =>
      isFileLockTimeout(cause)
        ? new ManagerWorksetApiError(
            'workset-busy',
            'Another workset definition or preparation operation is active. Retry shortly.',
            409,
            1_000,
          )
        : cause,
    ),
  );
  const retirementWarnings = yield* Effect.forEach(
    promoted.retirementTargets,
    target =>
      retireCodeGraphWorksetPublication(config.agentContextHome, target).pipe(
        Effect.map(receipt =>
          receipt.cleanupPending
            ? `Published storage for ${safeLabel(target.worksetName)} was retired; bounded cleanup remains pending.`
            : undefined,
        ),
        Effect.catch(() =>
          Effect.succeed(
            `The manifest changed, but published storage for ${safeLabel(target.worksetName)} could not be retired yet.`,
          ),
        ),
      ),
    {concurrency: 1},
  );
  const catalog = yield* readManagerWorksetCatalog(config).pipe(Effect.catch(() => Effect.succeed(promoted.catalog)));
  return {
    catalog,
    changed: promoted.changed,
    operation: promoted.operation,
    warnings: [...promoted.warnings, ...retirementWarnings.filter(value => value !== undefined)],
  } satisfies ManagerWorksetDefinitionMutationResult;
});

export const handleManagerWorksetRequest = Effect.fn('managerWorksets.handleRequest')(function* (
  request: ManagerWorksetApiRequest,
): Effect.fn.Return<ManagerWorksetApiResponse | undefined, never, ApplicationServices> {
  if (!isManagerWorksetApiPath(request.url.pathname)) return undefined;
  return yield* routeManagerWorksetRequest(request).pipe(
    Effect.catchCause(cause => Effect.succeed(managerWorksetErrorResponse(Cause.squash(cause)))),
  );
});

function routeManagerWorksetRequest(request: ManagerWorksetApiRequest) {
  const {config, method, url} = request;
  return Effect.gen(function* () {
    if (method === 'GET' && url.pathname === '/api/worksets') {
      return response(200, yield* readManagerWorksetCatalog(config));
    }
    if (method === 'GET' && url.pathname === '/api/worksets/status') {
      const workset = yield* requireKnownManagerWorkset(config, requiredQuery(url, 'workset'));
      return response(200, yield* inspectCodeGraphWorksetStatus(config, workset));
    }
    if (method === 'GET' && url.pathname === '/api/worksets/definition') {
      return response(200, yield* readManagerWorksetDefinition(config, requiredQuery(url, 'workset')));
    }
    if (method === 'GET' && url.pathname === '/api/worksets/jobs') {
      const jobs = [...registryFor(request.contextKey).jobs.values()]
        .map(entry => managerWorksetJobSummary(entry.job))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return response(200, {jobs});
    }
    if (method === 'GET' && url.pathname.startsWith('/api/worksets/jobs/')) {
      const id = url.pathname.slice('/api/worksets/jobs/'.length);
      const job = registryFor(request.contextKey).jobs.get(id)?.job;
      if (!job) throw new ManagerWorksetApiError('job-not-found', 'Workset preparation job not found.', 404);
      return response(200, {job});
    }
    if (method !== 'POST') return response(404, {error: 'Not found'});
    const body = yield* request.body.pipe(
      Effect.mapError(() => new ManagerWorksetApiError('invalid-json', 'Provide a JSON object request body.', 400)),
    );
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ManagerWorksetApiError('invalid-json', 'Provide a JSON object request body.', 400);
    }
    switch (url.pathname) {
      case '/api/worksets/definitions':
        return response(
          200,
          yield* mutateManagerWorksetDefinitionFromRequest(request, definitionMutationFromBody(body)),
        );
      case '/api/worksets/prepare':
        return response(202, {job: yield* startManagerWorksetPrepare(request, body)});
      case '/api/worksets/jobs/cancel':
        return response(202, {job: yield* cancelManagerWorksetPrepare(request.contextKey, request.jobScope, body)});
      case '/api/worksets/query':
        return response(200, yield* runManagerWorksetQuery(config, body));
      case '/api/worksets/continue':
        return response(
          200,
          yield* continueCodeGraphWorksetQueryV2(config, {
            cursor: requiredText(body.cursor, 'cursor', 256),
            ...optionalResponseBudget(body.budgetTokens),
          }),
        );
      case '/api/worksets/path':
        return response(200, yield* runManagerWorksetPath(config, body));
      case '/api/worksets/impact':
        return response(200, yield* runManagerWorksetImpact(config, body));
      case '/api/worksets/topology':
        return response(200, yield* runManagerWorksetTopology(config, body));
      case '/api/worksets/context-brief':
        return response(200, yield* runManagerWorksetContextBrief(config, body));
      default:
        return response(404, {error: 'Not found'});
    }
  });
}

export function managerWorksetJobSummary(job: ManagerWorksetPrepareJob): ManagerWorksetPrepareJobSummary {
  const {result: _result, ...summary} = job;
  return summary;
}

function runManagerWorksetQuery(config: RuntimeConfig, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const worksetName = yield* requireKnownManagerWorkset(
      config,
      requiredText(body.workset, 'workset', MANAGER_WORKSET_NAME_BYTES_MAXIMUM),
    );
    return yield* queryCodeGraphWorksetV2(config, {
      ...optionalBoundedInteger(body.deadlineMilliseconds, 'deadlineMilliseconds', 1, 60_000),
      ...optionalBoundedInteger(body.depth, 'depth', 0, 16),
      ...optionalBoundedInteger(body.edgeLimit, 'edgeLimit', 1, 1_000),
      ...optionalBoundedInteger(body.evidenceCards, 'evidenceCards', 1, 512),
      ...optionalBoolean(body.includeHeuristic, 'includeHeuristic'),
      ...optionalBoolean(body.includeModelAssociations, 'includeModelAssociations'),
      ...optionalResponseBudget(body.budgetTokens),
      ...optionalBoundedInteger(body.nodeLimit, 'nodeLimit', 1, 1_000),
      ...(body.packageName === undefined
        ? {}
        : {packageName: requiredText(body.packageName, 'packageName', MANAGER_WORKSET_SELECTOR_BYTES_MAXIMUM)}),
      query: requiredText(body.query, 'query', MANAGER_WORKSET_QUERY_BYTES_MAXIMUM),
      worksetName,
    });
  });
}

function runManagerWorksetPath(config: RuntimeConfig, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const worksetName = yield* knownWorksetFromBody(config, body);
    return yield* findCodeGraphWorksetPath(config, {
      ...traversalBudgets(body),
      from: requiredText(body.from, 'from', MANAGER_WORKSET_SELECTOR_BYTES_MAXIMUM),
      to: requiredText(body.to, 'to', MANAGER_WORKSET_SELECTOR_BYTES_MAXIMUM),
      worksetName,
    });
  });
}

function runManagerWorksetImpact(config: RuntimeConfig, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const worksetName = yield* knownWorksetFromBody(config, body);
    return yield* traceCodeGraphWorksetImpact(config, {
      ...traversalBudgets(body),
      query: requiredText(body.query, 'query', MANAGER_WORKSET_SELECTOR_BYTES_MAXIMUM),
      worksetName,
    });
  });
}

function runManagerWorksetTopology(config: RuntimeConfig, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const worksetName = yield* knownWorksetFromBody(config, body);
    return yield* inspectCodeGraphWorksetTopology(config, {
      ...optionalBoundedInteger(body.maxEdges, 'maxEdges', 1, 16_384),
      ...optionalBoundedInteger(body.maxEvidence, 'maxEvidence', 1, 8_192),
      ...optionalBoundedInteger(body.maxEvidencePerEdge, 'maxEvidencePerEdge', 1, 32),
      ...optionalBoundedInteger(body.maximumBridges, 'maximumBridges', 1, 20_000),
      ...optionalBoundedInteger(body.maxNodes, 'maxNodes', 1, 16_384),
      worksetName,
    });
  });
}

function runManagerWorksetContextBrief(config: RuntimeConfig, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const workset = yield* knownWorksetFromBody(config, body);
    return yield* compileContextBrief(config, {
      budgetTokens: optionalIntegerValue(body.budgetTokens, 'budgetTokens', 1, 1_500) ?? 1_250,
      mode: contextBriefMode(body.mode),
      scope: {kind: 'workset', name: workset},
      task: requiredText(body.task, 'task', 4_096),
    });
  });
}

function startManagerWorksetPrepare(request: ManagerWorksetApiRequest, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const workset = yield* requireKnownManagerWorkset(
      request.config,
      requiredText(body.workset, 'workset', MANAGER_WORKSET_NAME_BYTES_MAXIMUM),
    );
    const concurrency = optionalIntegerValue(
      body.concurrency,
      'concurrency',
      1,
      MANAGER_WORKSET_PREPARE_CONCURRENCY_MAXIMUM,
    );
    const registry = registryFor(request.contextKey);
    if (
      registry.mutating ||
      registry.starting ||
      [...registry.jobs.values()].some(entry => entry.job.status === 'running' || entry.job.status === 'cancelling')
    ) {
      throw new ManagerWorksetApiError('prepare-busy', 'A Manager workset preparation is already running.', 409);
    }
    registry.starting = true;
    return yield* Effect.gen(function* () {
      yield* ensureManagerWorksetRegistryLifecycle(registry, request.jobScope);
      trimFinishedJobs(registry);
      const catalog = yield* readManagerWorksetCatalog(request.config);
      const total = catalog.definitions.find(definition => definition.name === workset)?.memberCount ?? 0;
      const crypto = yield* Crypto.Crypto;
      const createdAt = isoTimestamp(yield* Clock.currentTimeMillis);
      const id = `cgwj_${(yield* crypto.randomUUIDv4).replaceAll('-', '')}`;
      const entry: InternalManagerWorksetPrepareJob = {
        job: {
          createdAt,
          id,
          progress: {
            message: 'Indexing members, building routing projections, and publishing one atomic generation.',
            phase: 'preparing',
            total,
          },
          status: 'running',
          workset,
        },
      };
      registry.jobs.set(id, entry);
      const fiber = yield* (request.prepareWorkset ?? prepareCodeGraphWorkset)(request.config, workset, {
        ...(concurrency === undefined ? {} : {concurrency}),
      }).pipe(
        Effect.matchCauseEffect({
          onFailure: cause => finishFailedPrepareJob(entry, cause),
          onSuccess: result => finishSuccessfulPrepareJob(entry, result),
        }),
        Effect.forkIn(request.jobScope),
      );
      entry.fiber = fiber;
      return entry.job;
    }).pipe(Effect.ensuring(Effect.sync(() => (registry.starting = false))));
  });
}

function cancelManagerWorksetPrepare(contextKey: object, jobScope: Scope.Scope, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const id = requiredText(body.id, 'id', 256);
    const entry = registryFor(contextKey).jobs.get(id);
    if (!entry) throw new ManagerWorksetApiError('job-not-found', 'Workset preparation job not found.', 404);
    if (entry.job.status !== 'running' || !entry.fiber) return entry.job;
    entry.job = {
      ...entry.job,
      progress: {
        ...entry.job.progress,
        message: 'Stopping preparation; readiness will confirm whether an atomic publication completed.',
        phase: 'cancelling',
      },
      status: 'cancelling',
    };
    yield* Fiber.interrupt(entry.fiber).pipe(
      Effect.andThen(finishInterruptedPrepareJob(entry)),
      Effect.forkIn(jobScope),
    );
    return entry.job;
  });
}

function finishSuccessfulPrepareJob(entry: InternalManagerWorksetPrepareJob, result: CodeGraphWorksetPrepareResultV1) {
  return Clock.currentTimeMillis.pipe(
    Effect.tap(now =>
      Effect.sync(() => {
        entry.job = {
          ...entry.job,
          error: result.state === 'ready' ? undefined : 'No ready generation was published; review member receipts.',
          errorCode: result.state === 'ready' ? undefined : 'prepare-incomplete',
          finishedAt: isoTimestamp(now),
          progress: {
            completed: result.members.length,
            message:
              result.state === 'ready' ? 'Published the ready generation.' : 'Preparation finished without publishing.',
            phase: result.state === 'ready' ? 'completed' : 'failed',
            total: entry.job.progress.total,
          },
          result,
          status: result.state === 'ready' ? 'completed' : 'failed',
        };
      }),
    ),
    Effect.asVoid,
  );
}

function finishFailedPrepareJob(entry: InternalManagerWorksetPrepareJob, cause: Cause.Cause<unknown>) {
  return Clock.currentTimeMillis.pipe(
    Effect.tap(now =>
      Effect.sync(() => {
        const cancelled = Cause.hasInterruptsOnly(cause);
        const failure = managerWorksetCauseError(cause);
        entry.job = {
          ...entry.job,
          error: cancelled ? undefined : failure.error,
          errorCode: cancelled ? undefined : failure.code,
          finishedAt: isoTimestamp(now),
          progress: {
            message: cancelled
              ? 'Preparation stopped; refresh readiness to confirm whether an atomic publication completed.'
              : 'Preparation failed safely.',
            phase: cancelled ? 'cancelled' : 'failed',
            total: entry.job.progress.total,
          },
          status: cancelled ? 'cancelled' : 'failed',
        };
      }),
    ),
    Effect.asVoid,
  );
}

function finishInterruptedPrepareJob(entry: InternalManagerWorksetPrepareJob) {
  return Clock.currentTimeMillis.pipe(
    Effect.tap(now =>
      Effect.sync(() => {
        if (entry.job.status !== 'running' && entry.job.status !== 'cancelling') return;
        entry.job = {
          ...entry.job,
          error: undefined,
          errorCode: undefined,
          finishedAt: isoTimestamp(now),
          progress: {
            message: 'Preparation stopped; refresh readiness to confirm whether an atomic publication completed.',
            phase: 'cancelled',
            total: entry.job.progress.total,
          },
          status: 'cancelled',
        };
      }),
    ),
    Effect.asVoid,
  );
}

function definitionMutationFromBody(body: Record<string, unknown>): ManagerWorksetDefinitionMutation {
  const expectedRevision = requiredText(body.expectedRevision, 'expectedRevision', 64);
  if (body.operation === 'create') {
    return {
      ...optionalDescription(body.description),
      expectedRevision,
      name: requiredText(body.name, 'name', MANAGER_WORKSET_NAME_BYTES_MAXIMUM),
      operation: 'create',
      projects: requiredTextArray(body.projects, 'projects', MANAGER_WORKSET_MEMBER_MAXIMUM),
    };
  }
  if (body.operation === 'update') {
    return {
      ...optionalDescription(body.description),
      expectedRevision,
      name: requiredText(body.name, 'name', MANAGER_WORKSET_NAME_BYTES_MAXIMUM),
      operation: 'update',
      projects: requiredTextArray(body.projects, 'projects', MANAGER_WORKSET_MEMBER_MAXIMUM),
      workset: requiredText(body.workset, 'workset', MANAGER_WORKSET_NAME_BYTES_MAXIMUM),
    };
  }
  if (body.operation === 'delete') {
    if (body.confirm !== true)
      throw new ManagerWorksetApiError('confirmation-required', 'Confirm workset deletion.', 400);
    return {
      confirm: true,
      expectedRevision,
      operation: 'delete',
      workset: requiredText(body.workset, 'workset', MANAGER_WORKSET_NAME_BYTES_MAXIMUM),
    };
  }
  throw new ManagerWorksetApiError('invalid-input', 'Workset definition operation is invalid.', 400);
}

function applyDefinitionMutation(
  document: ReturnType<typeof parseDocument>,
  manifest: SeedManifest,
  mutation: ManagerWorksetDefinitionMutation,
): {readonly changed: boolean; readonly retireWorksets: readonly string[]; readonly warnings: readonly string[]} {
  let worksets = document.get('worksets', true);
  if (worksets === undefined) {
    if (mutation.operation !== 'create') {
      throw new ManagerWorksetApiError('workset-not-found', 'Workset definition not found.', 404);
    }
    document.set('worksets', document.createNode([]));
    worksets = document.get('worksets', true);
  }
  if (!isSeq(worksets))
    throw new ManagerWorksetApiError('manifest-invalid', 'Manifest worksets must be a YAML sequence.', 409);
  const sequence = worksets as YAMLSeq;
  const targetName = mutation.operation === 'create' ? mutation.name : mutation.workset;
  const targetIndexes = findWorksetNodeIndexes(sequence, targetName);
  if (targetIndexes.length > 1) {
    throw new ManagerWorksetApiError('name-conflict', 'The target workset name is ambiguous in the manifest.', 409);
  }
  const index = targetIndexes[0] ?? -1;
  const current = index < 0 ? undefined : manifest.worksets?.[index];
  if (mutation.operation === 'create') {
    if (index >= 0) throw new ManagerWorksetApiError('name-conflict', 'A workset with that name already exists.', 409);
    const value = validatedDefinition(manifest, mutation.name, mutation.description, mutation.projects);
    sequence.add(value);
    return {changed: true, retireWorksets: [], warnings: []};
  }
  if (index < 0) throw new ManagerWorksetApiError('workset-not-found', 'Workset definition not found.', 404);
  if (mutation.operation === 'delete') {
    sequence.delete(index);
    return {
      changed: true,
      retireWorksets: [current?.name ?? mutation.workset],
      warnings: [],
    };
  }
  const nameConflict = findWorksetNodeIndex(sequence, mutation.name);
  if (nameConflict >= 0 && nameConflict !== index) {
    throw new ManagerWorksetApiError('name-conflict', 'A workset with that name already exists.', 409);
  }
  const value = validatedDefinition(
    manifest,
    mutation.name,
    mutation.description,
    mutation.projects,
    current?.projects,
  );
  if (current && definitionsEqual(current, value)) return {changed: false, retireWorksets: [], warnings: []};
  const node = sequence.items[index];
  if (!isMap(node)) throw new ManagerWorksetApiError('manifest-invalid', 'Workset entries must be YAML maps.', 409);
  const map = node as YAMLMap;
  if (current?.name !== value.name) map.set('name', value.name);
  if (current?.description !== value.description) {
    if (value.description === undefined) map.delete('description');
    else map.set('description', value.description);
  }
  const membersChanged = current === undefined || !textSetsEqual(current.projects, value.projects);
  if (membersChanged) reconcileProjectSequence(map, value.projects);
  const renamed = current !== undefined && current.name !== value.name;
  return {
    changed: true,
    retireWorksets: renamed ? [current.name] : membersChanged ? [value.name] : [],
    warnings: [],
  };
}

function validatedDefinition(
  manifest: SeedManifest,
  nameValue: string,
  descriptionValue: string | undefined,
  projectValues: readonly string[],
  allowedUnknownProjects: readonly string[] = [],
): WorksetManifest {
  const name = normalizedText(nameValue, 'name', MANAGER_WORKSET_NAME_BYTES_MAXIMUM);
  const description =
    descriptionValue === undefined
      ? undefined
      : normalizedText(descriptionValue, 'description', MANAGER_WORKSET_DESCRIPTION_BYTES_MAXIMUM);
  if (projectValues.length === 0 || projectValues.length > MANAGER_WORKSET_MEMBER_MAXIMUM) {
    throw new ManagerWorksetApiError('invalid-input', 'A workset must contain 1 to 4096 projects.', 400);
  }
  const configured = new Map(manifest.projects.map(project => [project.name.toLowerCase(), project.name]));
  const allowedUnknown = new Map(allowedUnknownProjects.map(project => [project.toLowerCase(), project]));
  const seen = new Set<string>();
  const projects = projectValues.map(value => {
    const project = normalizedText(value, 'project', MANAGER_WORKSET_NAME_BYTES_MAXIMUM);
    const key = project.toLowerCase();
    if (seen.has(key))
      throw new ManagerWorksetApiError('invalid-input', 'Workset project members must be unique.', 400);
    seen.add(key);
    const canonical = configured.get(key) ?? allowedUnknown.get(key);
    if (!canonical)
      throw new ManagerWorksetApiError('invalid-input', `Unknown manifest project: ${safeLabel(project)}.`, 400);
    return canonical;
  });
  return {description, name, projects};
}

function assertUniqueManifestNames(values: readonly string[], kind: 'project' | 'workset'): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      throw new ManagerWorksetApiError(
        'manifest-invalid',
        `The seed manifest has ambiguous case-insensitive ${kind} names.`,
        409,
      );
    }
    seen.add(key);
  }
}

function assertUniqueManagerManifestIdentity(manifest: SeedManifest): void {
  for (const name of [
    ...manifest.projects.map(project => project.name),
    ...(manifest.worksets ?? []).flatMap(workset => [workset.name, ...workset.projects]),
  ]) {
    if (!managerManifestNameIsCanonical(name)) {
      throw new ManagerWorksetApiError(
        'manifest-invalid',
        'Manager requires project and workset names to be normalized, bounded text without surrounding whitespace.',
        409,
      );
    }
  }
  if (manifest.projects.length > MANAGER_WORKSET_MEMBER_MAXIMUM) {
    throw new ManagerWorksetApiError('manifest-invalid', 'The seed manifest has too many projects for Manager.', 409);
  }
  if ((manifest.worksets?.length ?? 0) > MANAGER_WORKSET_DEFINITION_MAXIMUM) {
    throw new ManagerWorksetApiError('manifest-invalid', 'The seed manifest has too many worksets for Manager.', 409);
  }
  if (manifest.worksets?.some(workset => workset.projects.length > MANAGER_WORKSET_MEMBER_MAXIMUM)) {
    throw new ManagerWorksetApiError('manifest-invalid', 'A workset has too many members for Manager.', 409);
  }
  assertUniqueManifestNames(
    manifest.projects.map(project => project.name),
    'project',
  );
  assertUniqueManifestNames(
    (manifest.worksets ?? []).map(workset => workset.name),
    'workset',
  );
}

function managerManifestNameIsCanonical(value: string): boolean {
  try {
    return normalizedText(value, 'manifest name', MANAGER_WORKSET_NAME_BYTES_MAXIMUM) === value;
  } catch {
    return false;
  }
}

function managerWorksetYamlSupported(document: ReturnType<typeof parseDocument>): boolean {
  try {
    assertSupportedManagerWorksetYaml(document);
    return true;
  } catch {
    return false;
  }
}

function assertSupportedManagerWorksetYaml(document: ReturnType<typeof parseDocument>): void {
  const worksets = document.get('worksets', true);
  if (worksets === undefined) return;
  if (!isSeq(worksets)) throw unsupportedWorksetYaml();
  for (const item of worksets.items) {
    if (!isMap(item) || hasYamlAnchor(item)) throw unsupportedWorksetYaml();
    const name = item.get('name', true);
    const projects = item.get('projects', true);
    const description = item.get('description', true);
    if (
      !isScalar(name) ||
      typeof name.value !== 'string' ||
      hasYamlAnchor(name) ||
      !isSeq(projects) ||
      hasYamlAnchor(projects)
    ) {
      throw unsupportedWorksetYaml();
    }
    if (
      description !== undefined &&
      (!isScalar(description) || typeof description.value !== 'string' || hasYamlAnchor(description))
    ) {
      throw unsupportedWorksetYaml();
    }
    if (
      projects.items.some(project => !isScalar(project) || typeof project.value !== 'string' || hasYamlAnchor(project))
    ) {
      throw unsupportedWorksetYaml();
    }
  }
}

function hasYamlAnchor(node: {readonly anchor?: string}): boolean {
  return typeof node.anchor === 'string' && node.anchor.length > 0;
}

function unsupportedWorksetYaml(): ManagerWorksetApiError {
  return new ManagerWorksetApiError(
    'manifest-invalid',
    'Workset definitions use YAML aliases or shapes that Manager cannot edit safely.',
    409,
  );
}

function managerWorksetValidation<A>(evaluate: () => A): Effect.Effect<A, ManagerWorksetApiError> {
  return Effect.try({
    try: evaluate,
    catch: cause =>
      cause instanceof ManagerWorksetApiError
        ? cause
        : new ManagerWorksetApiError('manifest-invalid', 'The seed manifest cannot be edited safely.', 409),
  });
}

function parseManifestForMutation(raw: string, path: string) {
  return Effect.try({
    try: () => parseSeedManifest(raw, path),
    catch: cause =>
      cause instanceof ManagerWorksetApiError
        ? cause
        : new ManagerWorksetApiError('manifest-invalid', 'The seed manifest could not be validated.', 409),
  });
}

function requireKnownManagerWorkset(config: RuntimeConfig, requested: string) {
  return readSeedManifest(config.manifestPath).pipe(
    Effect.tap(manifest => managerWorksetValidation(() => assertUniqueManagerManifestIdentity(manifest))),
    Effect.map(manifest => manifest.worksets?.find(item => item.name.toLowerCase() === requested.toLowerCase())),
    Effect.flatMap(workset =>
      workset
        ? Effect.succeed(workset.name)
        : Effect.fail(new ManagerWorksetApiError('workset-not-found', 'Workset definition not found.', 404)),
    ),
    Effect.catch(error =>
      error instanceof ManagerWorksetApiError
        ? Effect.fail(error)
        : Effect.fail(new ManagerWorksetApiError('manifest-unavailable', 'The seed manifest could not be read.', 500)),
    ),
  );
}

function knownWorksetFromBody(config: RuntimeConfig, body: Record<string, unknown>) {
  return requireKnownManagerWorkset(config, requiredText(body.workset, 'workset', MANAGER_WORKSET_NAME_BYTES_MAXIMUM));
}

function registryFor(key: object): ManagerWorksetJobRegistry {
  const current = JOB_REGISTRIES.get(key);
  if (current) return current;
  const created = {jobs: new Map<string, InternalManagerWorksetPrepareJob>(), mutating: false, starting: false};
  JOB_REGISTRIES.set(key, created);
  return created;
}

function ensureManagerWorksetRegistryLifecycle(registry: ManagerWorksetJobRegistry, scope: Scope.Scope) {
  if (registry.lifecycleScope === scope) return Effect.void;
  if (registry.lifecycleScope !== undefined) {
    return Effect.fail(new ManagerWorksetApiError('prepare-busy', 'The Manager workset job scope changed.', 409));
  }
  registry.lifecycleScope = scope;
  return Scope.addFinalizer(
    scope,
    Effect.suspend(() =>
      Effect.forEach(
        [...registry.jobs.values()],
        entry =>
          entry.fiber === undefined
            ? Effect.void
            : Fiber.interrupt(entry.fiber).pipe(Effect.andThen(finishInterruptedPrepareJob(entry))),
        {concurrency: 'unbounded', discard: true},
      ),
    ),
  );
}

function mutateManagerWorksetDefinitionFromRequest(
  request: ManagerWorksetApiRequest,
  mutation: ManagerWorksetDefinitionMutation,
) {
  const registry = registryFor(request.contextKey);
  assertNoActiveManagerPrepare(registry);
  registry.mutating = true;
  return mutateManagerWorksetDefinition(request.config, mutation).pipe(
    Effect.ensuring(Effect.sync(() => (registry.mutating = false))),
  );
}

function assertNoActiveManagerPrepare(registry: ManagerWorksetJobRegistry): void {
  if (
    registry.mutating ||
    registry.starting ||
    [...registry.jobs.values()].some(entry => entry.job.status === 'running' || entry.job.status === 'cancelling')
  ) {
    throw new ManagerWorksetApiError(
      'prepare-busy',
      'Wait for the active Manager workset preparation before editing definitions.',
      409,
    );
  }
}

function trimFinishedJobs(registry: ManagerWorksetJobRegistry): void {
  const finished = [...registry.jobs.values()]
    .filter(entry => entry.job.status !== 'running' && entry.job.status !== 'cancelling')
    .sort((left, right) => left.job.createdAt.localeCompare(right.job.createdAt));
  while (registry.jobs.size >= MANAGER_WORKSET_JOB_MAXIMUM && finished.length > 0) {
    registry.jobs.delete(finished.shift()!.job.id);
  }
}

function traversalBudgets(body: Record<string, unknown>) {
  return {
    ...optionalBoundedInteger(body.deadlineMilliseconds, 'deadlineMilliseconds', 1, 60_000),
    ...optionalBoundedInteger(body.maxDepth, 'maxDepth', 1, 16),
    ...optionalBoundedInteger(body.maxEdges, 'maxEdges', 1, 1_000),
  };
}

function optionalResponseBudget(value: unknown): {readonly maximumEstimatedTokens?: number} {
  const budget = optionalIntegerValue(value, 'budgetTokens', 1, MANAGER_WORKSET_RESPONSE_TOKENS_MAXIMUM);
  return budget === undefined ? {} : {maximumEstimatedTokens: budget};
}

function optionalBoundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): Readonly<Record<string, number>> {
  const parsed = optionalIntegerValue(value, name, minimum, maximum);
  return parsed === undefined ? {} : {[name]: parsed};
}

function optionalIntegerValue(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ManagerWorksetApiError('invalid-input', `${name} must be an integer from ${minimum} to ${maximum}.`, 400);
  }
  return value as number;
}

function optionalBoolean(value: unknown, name: string): Readonly<Record<string, boolean>> {
  if (value === undefined) return {};
  if (typeof value !== 'boolean') throw new ManagerWorksetApiError('invalid-input', `${name} must be a boolean.`, 400);
  return {[name]: value};
}

function optionalDescription(value: unknown): {readonly description?: string} {
  if (value === undefined || value === '') return {};
  return {description: requiredText(value, 'description', MANAGER_WORKSET_DESCRIPTION_BYTES_MAXIMUM)};
}

function requiredText(value: unknown, name: string, maximumBytes: number): string {
  if (typeof value !== 'string') throw new ManagerWorksetApiError('invalid-input', `Provide ${name}.`, 400);
  return normalizedText(value, name, maximumBytes);
}

function normalizedText(value: string, name: string, maximumBytes: number): string {
  const text = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!text || UTF8.encode(text).byteLength > maximumBytes || hasControlCharacter(text)) {
    throw new ManagerWorksetApiError('invalid-input', `${name} must be bounded text without control characters.`, 400);
  }
  return text;
}

function requiredTextArray(value: unknown, name: string, maximumItems: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    throw new ManagerWorksetApiError('invalid-input', `Provide ${name} as a bounded non-empty string array.`, 400);
  }
  return value.map(item => requiredText(item, name, MANAGER_WORKSET_NAME_BYTES_MAXIMUM));
}

function contextBriefMode(value: unknown): ContextBriefMode {
  if (value === undefined || value === 'brief') return 'brief';
  if (value === 'locate' || value === 'explain' || value === 'trace' || value === 'impact') return value;
  throw new ManagerWorksetApiError('invalid-input', 'mode must be brief, locate, explain, trace, or impact.', 400);
}

function validateExpectedRevision(value: string): void {
  if (!SHA256.test(value)) throw new ManagerWorksetApiError('invalid-input', 'expectedRevision is invalid.', 400);
}

function findWorksetNodeIndex(sequence: YAMLSeq, name: string): number {
  return findWorksetNodeIndexes(sequence, name)[0] ?? -1;
}

function findWorksetNodeIndexes(sequence: YAMLSeq, name: string): readonly number[] {
  const target = name.toLowerCase();
  return sequence.items.flatMap((item, index) => {
    if (!isMap(item)) return [];
    const value = item.get('name');
    return typeof value === 'string' && value.toLowerCase() === target ? [index] : [];
  });
}

function definitionsEqual(left: WorksetManifest, right: WorksetManifest): boolean {
  return (
    left.name === right.name && left.description === right.description && textSetsEqual(left.projects, right.projects)
  );
}

function textSetsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === right.length && right.every(value => values.has(value));
}

function reconcileProjectSequence(map: YAMLMap, projects: readonly string[]): void {
  const current = map.get('projects', true);
  if (!isSeq(current)) {
    map.set('projects', [...projects]);
    return;
  }
  const desired = new Map(projects.map(project => [project.toLowerCase(), project]));
  const retained = [] as typeof current.items;
  const retainedKeys = new Set<string>();
  for (const item of current.items) {
    if (!isScalar(item) || typeof item.value !== 'string') continue;
    const key = item.value.toLowerCase();
    if (!desired.has(key) || retainedKeys.has(key)) continue;
    item.value = desired.get(key)!;
    retained.push(item);
    retainedKeys.add(key);
  }
  current.items = retained;
  for (const project of projects) {
    if (retainedKeys.has(project.toLowerCase())) continue;
    current.add(project);
  }
}

function managerWorksetErrorResponse(error: unknown): ManagerWorksetApiResponse {
  if (error instanceof ManagerWorksetApiError) {
    return response(error.status, {
      code: error.code,
      error: error.message,
      ...(error.retryAfterMilliseconds === undefined ? {} : {retryAfterMilliseconds: error.retryAfterMilliseconds}),
    });
  }
  if (error instanceof CodeGraphWorksetCatalogError) {
    const statuses = {busy: 409, capacity: 507, expired: 410, 'invalid-input': 400, missing: 409, stale: 409};
    const messages = {
      busy: 'The workset catalog is busy. Retry shortly.',
      capacity: 'The workset catalog has reached its safe capacity.',
      corrupt: 'The workset catalog needs repair before this operation can continue.',
      expired: 'The saved continuation expired. Run the query again.',
      incompatible: 'The workset catalog is incompatible with this runtime.',
      'invalid-input': 'The workset request is invalid.',
      missing: 'No published workset catalog is available. Prepare the workset first.',
      stale: 'The published workset catalog is stale. Prepare the workset again.',
      storage: 'The workset catalog could not complete the storage operation.',
    } as const;
    return response(statuses[error.reason as keyof typeof statuses] ?? 500, {
      code: `catalog-${error.reason}`,
      error: messages[error.reason],
    });
  }
  return response(500, {code: 'workset-operation-failed', error: publicWorksetError(error)});
}

function managerWorksetCauseError(cause: Cause.Cause<unknown>): {readonly code: string; readonly error: string} {
  const failure = cause.reasons.find(Cause.isFailReason)?.error;
  const result = managerWorksetErrorResponse(failure ?? cause);
  if (typeof result.body === 'object' && result.body !== null && 'error' in result.body) {
    const body = result.body as {readonly code?: unknown; readonly error?: unknown};
    return {
      code: typeof body.code === 'string' ? body.code : 'workset-operation-failed',
      error: typeof body.error === 'string' ? body.error : publicWorksetError(failure ?? cause),
    };
  }
  return {code: 'workset-operation-failed', error: publicWorksetError(failure ?? cause)};
}

function publicWorksetError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const allowed = [
    'Invalid Context Brief request:',
    'Cross-repository ',
    'The published workset ',
    'The published generation ',
    'The qualified reference ',
    'Workset path/impact ',
    'Workset component ',
    'A component selector ',
  ];
  return allowed.some(prefix => message.startsWith(prefix))
    ? message
    : 'The workset operation failed without changing repository graphs.';
}

function response(status: number, body: unknown): ManagerWorksetApiResponse {
  return {body, status};
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new ManagerWorksetApiError('invalid-input', `Missing query parameter: ${name}.`, 400);
  return requiredText(value, name, MANAGER_WORKSET_NAME_BYTES_MAXIMUM);
}

function safeLabel(value: string): string {
  return (
    value
      .replace(/[\r\n\t\0]/gu, ' ')
      .trim()
      .slice(0, MANAGER_WORKSET_NAME_BYTES_MAXIMUM) || 'unknown'
  );
}

function safeDescription(value: string): string {
  return value
    .replace(/[\r\n\t\0]/gu, ' ')
    .trim()
    .slice(0, MANAGER_WORKSET_DESCRIPTION_BYTES_MAXIMUM);
}

function safeLocalPath(value: string): string {
  return value
    .replace(/[\r\n\t\0]/gu, ' ')
    .trim()
    .slice(0, MANAGER_WORKSET_SELECTOR_BYTES_MAXIMUM);
}

const observeManagerWorksetProjects = Effect.fn('managerWorksets.observeProjects')(function* (
  projects: readonly ProjectManifest[],
) {
  const path = yield* Path.Path;
  return yield* Effect.forEach(
    projects,
    (project, index) =>
      Effect.gen(function* () {
        const localPath = yield* expandPath(project.path);
        const base = {
          folder: path.basename(localPath) || safeLabel(project.name),
          name: safeLabel(project.name),
          path: safeLocalPath(localPath),
        };
        if (index >= MANAGER_WORKSET_BRANCH_OBSERVATION_MAXIMUM) {
          return {...base, branchState: 'not-observed' as const};
        }
        const branch = yield* observeRepositoryBranch(localPath);
        return {...base, ...(branch.state === 'current' ? {branch: branch.branch} : {}), branchState: branch.state};
      }),
    {concurrency: 16},
  );
});

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
}

function isoTimestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}
