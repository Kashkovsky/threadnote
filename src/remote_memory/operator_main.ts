import {Cause, Console, Crypto, Effect, FileSystem, Path, Schema} from 'effect';
import {fromPromiseInterruptibleAwaiting} from '../effect/errors.js';
import {createRemoteMemorySql} from './postgres_control_plane.js';
import {
  applyRemoteMemoryProvisioningOperator,
  applyGitBetaImportOperator,
  assertHostedContextHealthWorkerPrivileges,
  claimHostedContextHealthOperator,
  completeHostedContextHealthOperatorCycle,
  exportRemoteMemoryOperator,
  failHostedContextHealthOperatorClaim,
  migrateRemoteMemoryOperator,
  planRemoteMemoryProvisioningOperator,
  planGitBetaImportOperator,
  provisionRemoteMemoryOperator,
  recordHostedContextHealthOperator,
  registerHostedContextHealthOperator,
  RemoteMemoryOperatorError,
  setHostedContextHealthOperatorStatus,
  type RemoteMemoryOperatorAdapter,
} from './operator.js';
import {
  buildHostedContextHealthPolicyV1,
  buildHostedContextHealthScheduleV1,
  hostedContextHealthTargetLabelsV1,
  parseHostedContextHealthRunInputV1,
  parseHostedContextHealthScheduleV1,
  type HostedContextHealthReceiptV1,
  type HostedContextHealthRunInputV1,
} from './hosted_context_health.js';
import type {RemoteMemoryProvisioningPlanV1} from './provisioning.js';
import {
  readGitBetaImportPlan,
  readGitBetaMemorySources,
  readOperatorJson,
  RemoteMemoryOperatorFileError,
  writeOperatorJsonExclusive,
  writeRemoteMemoryExportBundle,
} from './operator_files.js';
import {PostgresRemoteMemoryOperatorAdapter} from './operator_postgres.js';

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);
const Project = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255));
const Projects = Schema.Array(Project).check(Schema.isMaxLength(1_000));
const Url = Schema.String.check(
  Schema.makeFilter(value => {
    try {
      new URL(value);
      return undefined;
    } catch {
      return 'Expected a URL.';
    }
  }),
);
const CanonicalTimestamp = Schema.String.check(
  Schema.makeFilter(value => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
      ? undefined
      : 'Expected a canonical UTC timestamp.';
  }),
);
const RemoteMemoryProvisioningRequestFields = {
  allowedProjects: Schema.optionalKey(Projects),
  cloudAdmissionRequired: Schema.optionalKey(Schema.Boolean),
  cursorAttestationRequired: Schema.optionalKey(Schema.Boolean),
  cursorOwnerIds: Schema.optionalKey(Schema.Array(Identifier).check(Schema.isMaxLength(1_000))),
  cursorSubjects: Schema.optionalKey(Schema.Array(Identifier).check(Schema.isMinLength(1), Schema.isMaxLength(1_000))),
  cursorTeamId: Schema.optionalKey(Identifier),
  displayName: Project,
  featureFlags: Schema.optionalKey(
    Schema.Array(
      Schema.Literals([
        'remote_memory_read',
        'remote_memory_durable_write',
        'remote_memory_handoff_write',
        'cursor_oidc_required',
        'git_beta_import',
        'remote_memory_ga',
      ]),
    ).check(Schema.isMaxLength(6)),
  ),
  grantExpiresAt: Schema.optionalKey(Schema.String),
  issuer: Url,
  policyVersion: Identifier,
  principalId: Identifier,
  projects: Schema.optionalKey(Projects),
  region: Identifier,
  repositoryBindings: Schema.optionalKey(Schema.Record(Project, Schema.Array(Url).check(Schema.isMaxLength(1_000)))),
  shareId: Identifier,
  sharePolicyVersion: Schema.optionalKey(Identifier),
  subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  tenantId: Identifier,
} as const;
const RemoteMemoryCapabilities = Schema.Array(
  Schema.Literals([
    'memory:admin',
    'memory:propose:durable',
    'memory:read',
    'memory:review:durable',
    'memory:write:durable',
    'memory:write:handoff',
  ]),
).check(Schema.isMinLength(1), Schema.isMaxLength(6));
export const RemoteMemoryProvisioningInputSchema = Schema.Struct({
  ...RemoteMemoryProvisioningRequestFields,
  capabilities: RemoteMemoryCapabilities,
  clientId: Schema.optionalKey(Identifier),
  expectedCurrentPolicyVersion: Schema.optionalKey(Identifier),
  expectedCurrentSharePolicyVersion: Schema.optionalKey(Identifier),
});
export const RemoteMemoryProvisioningRequestSchema = Schema.Struct({
  ...RemoteMemoryProvisioningRequestFields,
  capabilities: Schema.optionalKey(RemoteMemoryCapabilities),
  clientId: Identifier,
});
const RemoteMemoryProvisioningStateSchema = Schema.Struct({
  grant: Schema.optionalKey(
    Schema.Struct({
      expiresAt: Schema.optionalKey(Schema.String),
      policyDigest: Schema.String,
      policyVersion: Schema.String,
      status: Schema.Literals(['active', 'revoked']),
    }),
  ),
  identityPrincipalId: Schema.optionalKey(Schema.String),
  membershipStatus: Schema.optionalKey(Schema.Literals(['active', 'revoked'])),
  principalStatus: Schema.optionalKey(Schema.Literals(['active', 'disabled'])),
  share: Schema.optionalKey(
    Schema.Struct({
      featureFlags: Schema.Array(
        Schema.Literals([
          'cursor_oidc_required',
          'remote_memory_durable_write',
          'remote_memory_ga',
          'remote_memory_handoff_write',
          'remote_memory_read',
          'remote_memory_write',
        ]),
      ),
      policyDigest: Schema.String,
      policyVersion: Schema.String,
      status: Schema.Literals(['active', 'deleted', 'revoked']),
    }),
  ),
  tenant: Schema.optionalKey(
    Schema.Struct({region: Schema.String, status: Schema.Literals(['active', 'deleted', 'disabled'])}),
  ),
  version: Schema.Literal(1),
});
export const RemoteMemoryProvisioningPlanSchema = Schema.Struct({
  action: Schema.Literals([
    'create_grant',
    'create_share_and_grant',
    'replace_grant',
    'unchanged',
    'update_control_plane',
  ]),
  changes: Schema.Array(
    Schema.Literals([
      'create_grant',
      'create_identity',
      'create_membership',
      'create_principal',
      'create_share',
      'create_tenant',
      'replace_grant',
      'replace_share_policy',
    ]),
  ),
  dryRun: Schema.Boolean,
  input: Schema.Struct({
    ...RemoteMemoryProvisioningRequestFields,
    capabilities: RemoteMemoryCapabilities,
    clientId: Identifier,
    expectedCurrentPolicyVersion: Schema.optionalKey(Identifier),
    expectedCurrentSharePolicyVersion: Schema.optionalKey(Identifier),
  }),
  observed: RemoteMemoryProvisioningStateSchema,
  planDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  planId: Schema.String.check(Schema.isPattern(/^tnpp_[0-9a-f]{32}$/u)),
  plannedAt: Schema.String,
  version: Schema.Literal(1),
});
const HostedContextHealthTargetSchema = Schema.Struct({
  project: Project,
  shareId: Identifier,
  tenantId: Identifier,
});
const HostedContextHealthSchedulePlanInputSchema = Schema.Struct({
  cadenceMinutes: Schema.Finite,
  nextDueAt: CanonicalTimestamp,
  policy: Schema.Struct({
    backlogAlertCount: Schema.Finite,
    persistentStaleRuns: Schema.Finite,
    policyVersion: Identifier,
    schedulerLagMinutes: Schema.Finite,
    supportOwner: Identifier,
    workerHeartbeatMinutes: Schema.Finite,
  }),
  project: Project,
  shareId: Identifier,
  tenantId: Identifier,
});

class RemoteMemoryOperatorInvocationError extends Schema.TaggedError<RemoteMemoryOperatorInvocationError>()(
  'RemoteMemoryOperatorInvocationError',
  {message: Schema.String},
) {}

export interface RemoteMemoryOperatorRuntime {
  readonly createAdapter: (
    databaseUrl: string,
    options?: {readonly contextHealthEvaluationKey?: string},
  ) => RemoteMemoryOperatorAdapter & {readonly close?: () => Promise<void>};
  readonly executablePath?: string;
}

export function createRemoteMemoryOperatorRuntime(executablePath?: string): RemoteMemoryOperatorRuntime {
  return {
    createAdapter: (databaseUrl, options) =>
      new PostgresRemoteMemoryOperatorAdapter(createRemoteMemorySql(databaseUrl), {...options, executablePath}),
    ...(executablePath === undefined ? {} : {executablePath}),
  };
}

export const runRemoteMemoryOperator = Effect.fn('remoteMemory.operator.run')(function* (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  runtime: RemoteMemoryOperatorRuntime = createRemoteMemoryOperatorRuntime(),
): Effect.fn.Return<number, never, RemoteMemoryOperatorFileServices> {
  // FileSystem and Path requirements are supplied only by the hidden
  // src/standalone.ts application entrypoint.
  const [command, ...rest] = arguments_;
  if (!command || command === 'help' || command === '--help') {
    yield* Console.log(operatorHelp());
    return 0;
  }
  return yield* Effect.gen(function* () {
    const databaseUrl = operatorDatabaseUrl(environment.THREADNOTE_REMOTE_DATABASE_URL);
    const contextHealthEvaluationKey =
      command === 'health-run' || command === 'health-cycle'
        ? operatorEvaluationKey(environment.THREADNOTE_CONTEXT_HEALTH_EVALUATION_KEY)
        : undefined;
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => runtime.createAdapter(databaseUrl, {contextHealthEvaluationKey})),
      adapter =>
        Effect.gen(function* () {
          const options = parseOptions(rest);
          if (command === 'capabilities') {
            rejectOptions(options, []);
            yield* Console.log(JSON.stringify(adapter.capabilities));
            return 0;
          }
          if (command === 'migrate') {
            rejectOptions(options, []);
            yield* Console.log(JSON.stringify(yield* operatorPromise(() => migrateRemoteMemoryOperator(adapter))));
            return 0;
          }
          if (command === 'provision') {
            rejectOptions(options, ['input']);
            const input = yield* Schema.decodeUnknownEffect(RemoteMemoryProvisioningInputSchema, {
              onExcessProperty: 'error',
            })(yield* readOperatorJson<unknown>(requiredOption(options, 'input')));
            yield* Console.log(
              JSON.stringify(yield* operatorPromise(() => provisionRemoteMemoryOperator(adapter, input))),
            );
            return 0;
          }
          if (command === 'provision-plan') {
            rejectOptions(options, ['for-apply', 'input', 'output']);
            const request = yield* Schema.decodeUnknownEffect(RemoteMemoryProvisioningRequestSchema, {
              onExcessProperty: 'error',
            })(yield* readOperatorJson<unknown>(requiredOption(options, 'input')));
            const plan = yield* operatorPromise(() =>
              planRemoteMemoryProvisioningOperator(adapter, {apply: flag(options, 'for-apply'), request}),
            );
            yield* writeOperatorJsonExclusive(requiredOption(options, 'output'), plan);
            yield* Console.log(
              JSON.stringify({
                action: plan.action,
                changes: plan.changes,
                dryRun: plan.dryRun,
                planId: plan.planId,
                version: plan.version,
              }),
            );
            return 0;
          }
          if (command === 'provision-apply') {
            rejectOptions(options, ['plan', 'receipt']);
            const plan = yield* Schema.decodeUnknownEffect(RemoteMemoryProvisioningPlanSchema, {
              onExcessProperty: 'error',
            })(yield* readOperatorJson<unknown>(requiredOption(options, 'plan')));
            const receipt = yield* operatorPromise(() =>
              applyRemoteMemoryProvisioningOperator(adapter, plan as RemoteMemoryProvisioningPlanV1),
            );
            yield* writeOperatorJsonExclusive(requiredOption(options, 'receipt'), receipt);
            yield* Console.log(
              JSON.stringify({
                action: receipt.action,
                changes: receipt.changes,
                planId: receipt.planId,
                status: receipt.status,
                version: 1,
              }),
            );
            return 0;
          }
          if (command === 'import-plan') {
            rejectOptions(options, [
              'alias-compatibility-ends-at',
              'for-apply',
              'output',
              'projects',
              'share',
              'source',
              'team',
              'user',
            ]);
            const sources = yield* readGitBetaMemorySources({
              directory: requiredOption(options, 'source'),
              team: requiredOption(options, 'team'),
              user: requiredOption(options, 'user'),
            });
            const projects = optionalList(options, 'projects');
            const plan = yield* operatorPromise(() =>
              planGitBetaImportOperator(adapter, {
                aliasCompatibilityEndsAt: requiredOption(options, 'alias-compatibility-ends-at'),
                apply: flag(options, 'for-apply'),
                policy: {
                  ...(projects ? {projects} : {}),
                  sourceTeams: [requiredOption(options, 'team')],
                  sourceUsers: [requiredOption(options, 'user')],
                },
                records: sources,
                shareId: requiredOption(options, 'share'),
              }),
            );
            yield* writeOperatorJsonExclusive(requiredOption(options, 'output'), plan);
            yield* Console.log(
              JSON.stringify({counts: plan.counts, dryRun: plan.dryRun, planId: plan.planId, version: plan.version}),
            );
            return plan.counts.blocked + plan.counts.conflict + plan.counts.invalid === 0 ? 0 : 2;
          }
          if (command === 'import-apply') {
            rejectOptions(options, ['plan', 'receipt', 'source', 'team', 'user']);
            const sources = yield* readGitBetaMemorySources({
              directory: requiredOption(options, 'source'),
              team: requiredOption(options, 'team'),
              user: requiredOption(options, 'user'),
            });
            const plan = yield* readGitBetaImportPlan(requiredOption(options, 'plan'));
            const result = yield* operatorPromise(() => applyGitBetaImportOperator(adapter, {plan, records: sources}));
            yield* writeOperatorJsonExclusive(requiredOption(options, 'receipt'), result);
            yield* Console.log(
              JSON.stringify({planId: result.cutover.planId, status: result.cutover.status, version: result.version}),
            );
            return 0;
          }
          if (command === 'export') {
            rejectOptions(options, ['output', 'share']);
            const plan = yield* operatorPromise(() =>
              exportRemoteMemoryOperator(adapter, requiredOption(options, 'share')),
            );
            yield* writeRemoteMemoryExportBundle(requiredOption(options, 'output'), plan);
            yield* Console.log(
              JSON.stringify({bundleDigest: plan.bundleDigest, files: plan.files.length, version: plan.version}),
            );
            return 0;
          }
          if (command === 'health-schedule') {
            rejectOptions(options, ['input', 'receipt']);
            const raw = yield* readOperatorJson<unknown>(requiredOption(options, 'input'));
            if (!isJsonRecord(raw) || typeof raw.nextDueAt !== 'string') {
              return yield* operatorInvocationError('Hosted health schedule input is invalid.');
            }
            const schedule = yield* Effect.try({
              try: () => parseHostedContextHealthScheduleV1(raw.schedule),
              catch: cause => operatorInvocationError(operatorInputFailureMessage(cause)),
            });
            const receipt = yield* operatorPromise(() =>
              registerHostedContextHealthOperator(adapter, schedule, raw.nextDueAt as string),
            );
            yield* writeOperatorJsonExclusive(requiredOption(options, 'receipt'), receipt);
            yield* Console.log(JSON.stringify(receipt));
            return 0;
          }
          if (command === 'health-schedule-plan') {
            rejectOptions(options, ['input', 'output']);
            const input = yield* Schema.decodeUnknownEffect(HostedContextHealthSchedulePlanInputSchema, {
              onExcessProperty: 'error',
            })(yield* readOperatorJson<unknown>(requiredOption(options, 'input')));
            const schedule = yield* Effect.try({
              try: () =>
                buildHostedContextHealthScheduleV1({
                  cadenceMinutes: input.cadenceMinutes,
                  policy: buildHostedContextHealthPolicyV1(input.policy),
                  project: input.project,
                  shareId: input.shareId,
                  tenantId: input.tenantId,
                }),
              catch: cause => operatorInvocationError(operatorInputFailureMessage(cause)),
            });
            yield* writeOperatorJsonExclusive(requiredOption(options, 'output'), {
              nextDueAt: input.nextDueAt,
              schedule,
            });
            yield* Console.log(
              JSON.stringify({
                labels: hostedContextHealthTargetLabelsV1(schedule),
                policyDigest: schedule.policy.digest,
                scheduleId: schedule.scheduleId,
                version: schedule.version,
              }),
            );
            return 0;
          }
          if (command === 'health-run') {
            rejectOptions(options, ['input', 'receipt']);
            yield* operatorPromise(() => assertHostedContextHealthWorkerPrivileges(adapter));
            const raw = yield* readOperatorJson<unknown>(requiredOption(options, 'input'));
            const input = yield* Effect.try({
              try: () => parseHostedContextHealthRunInputV1(raw),
              catch: cause => operatorInvocationError(operatorInputFailureMessage(cause)),
            });
            const cycle = yield* operatorPromise(() => executeHostedContextHealthCycle(adapter, [input], 1));
            const receipt = cycle.receipts[0];
            if (!receipt) {
              return yield* operatorInvocationError('No due hosted context health schedule matched the evaluation.');
            }
            yield* writeOperatorJsonExclusive(requiredOption(options, 'receipt'), receipt);
            yield* Console.log(
              JSON.stringify({
                alerts: receipt.alerts.filter(alert => alert.state === 'firing').map(alert => alert.kind),
                labels: receipt.labels,
                outcome: receipt.outcome,
                receiptId: receipt.receiptId,
                version: receipt.version,
              }),
            );
            return receipt.outcome === 'unknown' ? 2 : receipt.reviewRequired ? 1 : 0;
          }
          if (command === 'health-cycle') {
            rejectOptions(options, ['input', 'receipt']);
            yield* operatorPromise(() => assertHostedContextHealthWorkerPrivileges(adapter));
            const raw = yield* readOperatorJson<unknown>(requiredOption(options, 'input'));
            if (!isJsonRecord(raw)) {
              return yield* operatorInvocationError('Hosted health cycle input is invalid.');
            }
            if (Object.keys(raw).some(key => key !== 'concurrency' && key !== 'runs')) {
              return yield* operatorInvocationError('Hosted health cycle input is invalid.');
            }
            const rawRuns = raw.runs;
            if (!Array.isArray(rawRuns)) return yield* operatorInvocationError('Hosted health cycle input is invalid.');
            const concurrency = raw.concurrency;
            if (typeof concurrency !== 'number') {
              return yield* operatorInvocationError('Hosted health cycle scheduling values are invalid.');
            }
            const cycle = yield* operatorPromise(() => executeHostedContextHealthCycle(adapter, rawRuns, concurrency));
            const receipts = cycle.receipts;
            const cycleReceipt = {
              backlogDepth: cycle.completion.backlogDepth,
              generation: cycle.completion.generation,
              invalidCandidates: cycle.invalidCandidates,
              nextTenantOrdinal: cycle.nextTenantOrdinal,
              receipts: receipts.map(receipt => ({
                alerts: receipt.alerts.filter(alert => alert.state === 'firing').map(alert => alert.kind),
                labels: receipt.labels,
                outcome: receipt.outcome,
                receiptId: receipt.receiptId,
                scheduleId: receipt.scheduleId,
              })),
              failedClaims: cycle.failedClaims,
              unavailableClaims: cycle.unavailableClaims,
              selected: cycle.selected,
              workerState: cycle.completion.status,
              version: 1,
            } as const;
            yield* writeOperatorJsonExclusive(requiredOption(options, 'receipt'), cycleReceipt);
            yield* Console.log(JSON.stringify(cycleReceipt));
            return cycle.completion.status === 'failed' || receipts.some(receipt => receipt.outcome === 'unknown')
              ? 2
              : receipts.some(receipt => receipt.reviewRequired)
                ? 1
                : 0;
          }
          if (command === 'health-pause' || command === 'health-resume') {
            rejectOptions(options, ['input', 'receipt']);
            const target = yield* Schema.decodeUnknownEffect(HostedContextHealthTargetSchema, {
              onExcessProperty: 'error',
            })(yield* readOperatorJson<unknown>(requiredOption(options, 'input')));
            const receipt = yield* operatorPromise(() =>
              setHostedContextHealthOperatorStatus(adapter, {
                ...target,
                status: command === 'health-pause' ? 'paused' : 'active',
              }),
            );
            yield* writeOperatorJsonExclusive(requiredOption(options, 'receipt'), receipt);
            yield* Console.log(JSON.stringify(receipt));
            return 0;
          }
          return yield* operatorInvocationError('Unknown remote memory operator command.');
        }),
      adapter => (adapter.close ? operatorPromise(() => adapter.close!()) : Effect.void),
    );
  }).pipe(Effect.catchCause(cause => Console.error(operatorFailureMessage(Cause.squash(cause))).pipe(Effect.as(1))));
});

const operatorPromise = <A>(evaluate: (signal: AbortSignal) => PromiseLike<A>) =>
  fromPromiseInterruptibleAwaiting(evaluate, cause => cause);

function parseOptions(arguments_: readonly string[]): ReadonlyMap<string, string | true> {
  const options = new Map<string, string | true>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const token = arguments_[index];
    if (!token.startsWith('--') || token.length <= 2) {
      throw operatorInvocationError('Operator arguments must use --name followed by an optional value.');
    }
    const key = token.slice(2);
    if (options.has(key)) throw operatorInvocationError('An operator option was provided more than once.');
    const next = arguments_[index + 1];
    if (!next || next.startsWith('--')) options.set(key, true);
    else {
      options.set(key, next);
      index += 1;
    }
  }
  return options;
}

function rejectOptions(options: ReadonlyMap<string, string | true>, allowed: readonly string[]): void {
  for (const key of options.keys()) {
    if (!allowed.includes(key)) throw operatorInvocationError('An operator option is not valid for this command.');
  }
}

function requiredOption(options: ReadonlyMap<string, string | true>, key: string): string {
  const value = options.get(key);
  if (typeof value !== 'string' || !value) {
    throw operatorInvocationError(`Operator option --${key} requires a value.`);
  }
  return value;
}

function optionalList(options: ReadonlyMap<string, string | true>, key: string): readonly string[] | undefined {
  const value = options.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw operatorInvocationError(`Operator option --${key} requires a comma-separated value.`);
  }
  const values = value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (values.length === 0) throw operatorInvocationError(`Operator option --${key} cannot be empty.`);
  return values;
}

function flag(options: ReadonlyMap<string, string | true>, key: string): boolean {
  const value = options.get(key);
  if (value === undefined) return false;
  if (value !== true) throw operatorInvocationError(`Operator option --${key} does not take a value.`);
  return true;
}

function operatorDatabaseUrl(value: string | undefined): string {
  if (!value?.trim()) throw operatorInvocationError('THREADNOTE_REMOTE_DATABASE_URL is required.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw operatorInvocationError('THREADNOTE_REMOTE_DATABASE_URL must be an absolute PostgreSQL URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw operatorInvocationError('THREADNOTE_REMOTE_DATABASE_URL must use PostgreSQL.');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === 'remote-memory-db';
  const sslMode = url.searchParams.get('sslmode');
  if (!local && sslMode !== 'require' && sslMode !== 'verify-full') {
    throw operatorInvocationError(
      'THREADNOTE_REMOTE_DATABASE_URL must require TLS outside the local development stack.',
    );
  }
  return value;
}

function operatorEvaluationKey(value: string | undefined): string {
  if (!value || new TextEncoder().encode(value).length < 32) {
    throw operatorInvocationError('THREADNOTE_CONTEXT_HEALTH_EVALUATION_KEY must contain at least 32 bytes.');
  }
  return value;
}

function operatorInvocationError(message: string): RemoteMemoryOperatorInvocationError {
  return RemoteMemoryOperatorInvocationError.make({message});
}

function operatorFailureMessage(cause: unknown): string {
  if (
    Schema.is(RemoteMemoryOperatorInvocationError)(cause) ||
    Schema.is(RemoteMemoryOperatorFileError)(cause) ||
    Schema.is(RemoteMemoryOperatorError)(cause)
  ) {
    return cause.message;
  }
  return 'Remote memory operator failed. Inspect privacy-safe service logs for the failure class.';
}

function operatorInputFailureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Hosted context health input is invalid.';
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function executeHostedContextHealthCycle(
  adapter: RemoteMemoryOperatorAdapter,
  rawRuns: readonly unknown[],
  concurrency: number,
): Promise<{
  readonly completion: Awaited<ReturnType<typeof completeHostedContextHealthOperatorCycle>>;
  readonly failedClaims: number;
  readonly invalidCandidates: number;
  readonly nextTenantOrdinal: number;
  readonly receipts: readonly HostedContextHealthReceiptV1[];
  readonly selected: number;
  readonly unavailableClaims: number;
}> {
  const parsed = rawRuns.map(raw => parseHealthCandidate(raw));
  const validBySchedule = new Map<string, HostedContextHealthRunInputV1>();
  const duplicates = new Set<string>();
  let invalidCandidates = 0;
  for (const candidate of parsed) {
    if (!candidate.input) {
      invalidCandidates += 1;
      continue;
    }
    const scheduleId = candidate.input.schedule.scheduleId;
    if (validBySchedule.has(scheduleId)) {
      duplicates.add(scheduleId);
      invalidCandidates += 1;
      continue;
    }
    validBySchedule.set(scheduleId, candidate.input);
  }
  for (const duplicate of duplicates) validBySchedule.delete(duplicate);

  const batch = await claimHostedContextHealthOperator(adapter, concurrency);
  const claimedIds = new Set(batch.claims.map(claim => claim.schedule.scheduleId));
  invalidCandidates += [...validBySchedule.keys()].filter(scheduleId => !claimedIds.has(scheduleId)).length;
  const settled = await Promise.all(
    batch.claims.map(async claim => {
      const input = validBySchedule.get(claim.schedule.scheduleId);
      if (!input) {
        await failHostedContextHealthOperatorClaim(adapter, claim).catch(() => undefined);
        return {failed: true as const};
      }
      try {
        return {failed: false as const, receipt: await recordHostedContextHealthOperator(adapter, claim, input)};
      } catch {
        await failHostedContextHealthOperatorClaim(adapter, claim).catch(() => undefined);
        return {failed: true as const};
      }
    }),
  );
  const failedClaims = settled.filter(result => result.failed).length;
  const receipts = settled.flatMap(result => (result.failed ? [] : [result.receipt]));
  const completion = await completeHostedContextHealthOperatorCycle(adapter, {
    failed: failedClaims > 0 || invalidCandidates > 0 || batch.unavailableCount > 0,
    generation: batch.generation,
  });
  return {
    completion,
    failedClaims,
    invalidCandidates,
    nextTenantOrdinal: batch.nextTenantOrdinal,
    receipts,
    selected: batch.claims.length,
    unavailableClaims: batch.unavailableCount,
  };
}

function parseHealthCandidate(raw: unknown): {
  readonly input?: HostedContextHealthRunInputV1;
  readonly scheduleId?: string;
} {
  const scheduleId =
    isJsonRecord(raw) && isJsonRecord(raw.schedule) && typeof raw.schedule.scheduleId === 'string'
      ? raw.schedule.scheduleId
      : undefined;
  try {
    return {input: parseHostedContextHealthRunInputV1(raw), scheduleId};
  } catch {
    return {scheduleId};
  }
}

function operatorHelp(): string {
  return [
    'Threadnote remote memory operator',
    '',
    'Database credentials are accepted only through THREADNOTE_REMOTE_DATABASE_URL.',
    '  migrate',
    '  capabilities',
    '  provision --input <json>',
    '  provision-plan --input <json> --output <plan.json> [--for-apply]',
    '  provision-apply --plan <plan.json> --receipt <receipt.json>',
    '  import-plan --source <git-share> --user <id> --team <team> --share <id>',
    '    --alias-compatibility-ends-at <ISO timestamp> --output <plan.json> [--projects <csv>] [--for-apply]',
    '  import-apply --source <git-share> --user <id> --team <team> --plan <plan.json> --receipt <json>',
    '  export --share <id> --output <new-directory>',
    '  health-schedule-plan --input <json> --output <plan.json>',
    '  health-schedule --input <json> --receipt <receipt.json>',
    '  health-run --input <immutable-evidence.json> --receipt <receipt.json>',
    '  health-cycle --input <immutable-evidence-batch.json> --receipt <receipt.json>',
    '  health-pause --input <target.json> --receipt <receipt.json>',
    '  health-resume --input <target.json> --receipt <receipt.json>',
    '',
    'Pilot provisioning defaults omitted capabilities to memory:read. Write grants require named projects,',
    'an OAuth client binding, and an expiry no more than 31 days after planning.',
    'Import never deletes the Git source and never enables dual-write. A ready receipt still requires an explicit',
    'Cursor Dashboard transport switch. PostgreSQL import apply is atomic and requires the share git_beta_import flag.',
  ].join('\n');
}

export type RemoteMemoryOperatorFileServices = Crypto.Crypto | FileSystem.FileSystem | Path.Path;
