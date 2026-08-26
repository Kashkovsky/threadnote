import * as z from 'zod/v4';
import {Cause, Console, Effect, FileSystem, Path, Schema} from 'effect';
import {fromPromiseInterruptibleAwaiting} from '../effect/errors.js';
import {createRemoteMemorySql, type RemoteMemoryProvisioningInput} from './postgres_control_plane.js';
import {
  applyGitBetaImportOperator,
  exportRemoteMemoryOperator,
  migrateRemoteMemoryOperator,
  planGitBetaImportOperator,
  provisionRemoteMemoryOperator,
  RemoteMemoryOperatorError,
  type RemoteMemoryOperatorAdapter,
} from './operator.js';
import {
  readGitBetaImportPlan,
  readGitBetaMemorySources,
  readOperatorJson,
  RemoteMemoryOperatorFileError,
  writeOperatorJsonExclusive,
  writeRemoteMemoryExportBundle,
} from './operator_files.js';
import {PostgresRemoteMemoryOperatorAdapter} from './operator_postgres.js';

const Identifier = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const ProvisioningInput = z
  .object({
    allowedProjects: z.array(z.string().min(1).max(255)).max(1000).optional(),
    capabilities: z
      .array(z.enum(['memory:admin', 'memory:read', 'memory:write:durable', 'memory:write:handoff']))
      .min(1)
      .max(4),
    cursorAttestationRequired: z.boolean().optional(),
    cursorOwnerIds: z.array(Identifier).max(1000).optional(),
    cursorSubjects: z.array(Identifier).min(1).max(1000).optional(),
    cursorTeamId: Identifier.optional(),
    displayName: z.string().min(1).max(255),
    expectedCurrentPolicyVersion: Identifier.optional(),
    expectedCurrentSharePolicyVersion: Identifier.optional(),
    featureFlags: z
      .array(
        z.enum([
          'remote_memory_read',
          'remote_memory_durable_write',
          'remote_memory_handoff_write',
          'cursor_oidc_required',
          'git_beta_import',
          'remote_memory_ga',
        ]),
      )
      .max(6)
      .optional(),
    issuer: z.url(),
    policyVersion: Identifier,
    principalId: Identifier,
    projects: z.array(z.string().min(1).max(255)).max(1000).optional(),
    region: Identifier,
    repositoryBindings: z.record(z.string().min(1).max(255), z.array(z.url()).max(1000)).optional(),
    shareId: Identifier,
    sharePolicyVersion: Identifier.optional(),
    subject: z.string().min(1).max(1024),
    tenantId: Identifier,
  })
  .strict();

class RemoteMemoryOperatorInvocationError extends Schema.TaggedError<RemoteMemoryOperatorInvocationError>()(
  'RemoteMemoryOperatorInvocationError',
  {message: Schema.String},
) {}

export interface RemoteMemoryOperatorRuntime {
  readonly createAdapter: (databaseUrl: string) => RemoteMemoryOperatorAdapter & {readonly close?: () => Promise<void>};
}

const defaultRuntime: RemoteMemoryOperatorRuntime = {
  createAdapter: databaseUrl => new PostgresRemoteMemoryOperatorAdapter(createRemoteMemorySql(databaseUrl)),
};

export const runRemoteMemoryOperator = Effect.fn('remoteMemory.operator.run')(function* (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  runtime: RemoteMemoryOperatorRuntime = defaultRuntime,
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
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => runtime.createAdapter(databaseUrl)),
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
            const input = ProvisioningInput.parse(yield* readOperatorJson<unknown>(requiredOption(options, 'input')));
            yield* Console.log(
              JSON.stringify(
                yield* operatorPromise(() =>
                  provisionRemoteMemoryOperator(adapter, input as RemoteMemoryProvisioningInput),
                ),
              ),
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
          return yield* Effect.fail(operatorInvocationError('Unknown remote memory operator command.'));
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
    const token = arguments_[index]!;
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

function operatorInvocationError(message: string): RemoteMemoryOperatorInvocationError {
  return new RemoteMemoryOperatorInvocationError({message});
}

function operatorFailureMessage(cause: unknown): string {
  if (
    cause instanceof RemoteMemoryOperatorInvocationError ||
    cause instanceof RemoteMemoryOperatorFileError ||
    cause instanceof RemoteMemoryOperatorError
  ) {
    return cause.message;
  }
  return 'Remote memory operator failed. Inspect privacy-safe service logs for the failure class.';
}

function operatorHelp(): string {
  return [
    'Threadnote remote memory operator',
    '',
    'Database credentials are accepted only through THREADNOTE_REMOTE_DATABASE_URL.',
    '  migrate',
    '  capabilities',
    '  provision --input <json>',
    '  import-plan --source <git-share> --user <id> --team <team> --share <id>',
    '    --alias-compatibility-ends-at <ISO timestamp> --output <plan.json> [--projects <csv>] [--for-apply]',
    '  import-apply --source <git-share> --user <id> --team <team> --plan <plan.json> --receipt <json>',
    '  export --share <id> --output <new-directory>',
    '',
    'Import never deletes the Git source and never enables dual-write. A ready receipt still requires an explicit',
    'Cursor Dashboard transport switch. PostgreSQL import apply is atomic and requires the share git_beta_import flag.',
  ].join('\n');
}

export type RemoteMemoryOperatorFileServices = FileSystem.FileSystem | Path.Path;
