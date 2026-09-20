import {canonicalJson} from '../../code_graph/checkpoint/canonical_json.js';
import {sha256HexSync} from '../../crypto/sha256.js';
import {
  hostedContextCiDiagnosticsV1,
  validateHostedContextCiJobV1,
  type HostedContextCiJobV1,
  type HostedContextCiPolicyV1,
} from './context_ci.js';

export type HostedContextCiDiagnosticsV1 = ReturnType<typeof hostedContextCiDiagnosticsV1>;
export type HostedContextCiFailureV1 = 'evaluation-unavailable' | 'publication-unavailable' | 'immutable-ref-changed';

export interface HostedContextCiReadIdentityV1 {
  readonly identity: string;
  readonly capabilities: readonly ['repository:read', 'context:check'];
  readonly resolve: (job: HostedContextCiJobV1) => Promise<{
    readonly installationId: string;
    readonly repositoryId: string;
    readonly headCommit: string;
    readonly baseCommit: string;
  }>;
  /** Run only the pinned Threadnote evaluator; never execute checkout hooks, build scripts, or repository code. */
  readonly evaluate: (job: HostedContextCiJobV1, project: string) => Promise<string>;
}

export interface HostedContextCiPublicationIdentityV1 {
  readonly identity: string;
  readonly capabilities: readonly ['checks:publish'];
  /** Upsert exactly this idempotency key; reject a different digest for an already accepted key. */
  readonly publish: (input: {
    readonly installationId: string;
    readonly repositoryId: string;
    readonly headCommit: string;
    readonly idempotencyKey: string;
    readonly conclusion: 'success' | 'failure';
    readonly diagnostics: HostedContextCiDiagnosticsV1;
  }) => Promise<{readonly publicationId: string; readonly digest: string}>;
}

export type HostedContextCiAttemptResultV1 =
  | {readonly status: 'evaluated'; readonly diagnostics: HostedContextCiDiagnosticsV1}
  | {readonly status: 'published'; readonly publicationDigest: string; readonly reportDigest: string}
  | {readonly status: 'retry'; readonly reason: HostedContextCiFailureV1};

export async function evaluateHostedContextCiJobV1(
  policy: HostedContextCiPolicyV1,
  job: HostedContextCiJobV1,
  reader: HostedContextCiReadIdentityV1,
): Promise<HostedContextCiAttemptResultV1> {
  validateHostedContextCiJobV1(policy, job);
  assertReader(policy, reader);
  try {
    if (!(await matchesImmutableRefs(job, reader))) return {status: 'retry', reason: 'immutable-ref-changed'};
    const raw = await reader.evaluate(structuredClone(job), policy.project);
    const diagnostics = hostedContextCiDiagnosticsV1(raw);
    if (JSON.parse(raw).project !== policy.project) return {status: 'retry', reason: 'evaluation-unavailable'};
    if (!(await matchesImmutableRefs(job, reader))) return {status: 'retry', reason: 'immutable-ref-changed'};
    return {status: 'evaluated', diagnostics};
  } catch {
    return {status: 'retry', reason: 'evaluation-unavailable'};
  }
}

export async function publishHostedContextCiJobV1(
  policy: HostedContextCiPolicyV1,
  job: HostedContextCiJobV1,
  input: HostedContextCiDiagnosticsV1,
  reader: HostedContextCiReadIdentityV1,
  publisher: HostedContextCiPublicationIdentityV1,
): Promise<HostedContextCiAttemptResultV1> {
  validateHostedContextCiJobV1(policy, job);
  assertReader(policy, reader);
  if (
    publisher.identity !== policy.publisherIdentity ||
    publisher.capabilities.length !== 1 ||
    publisher.capabilities[0] !== 'checks:publish' ||
    publisher.identity === reader.identity
  ) {
    throw new Error('Context CI publication identity rejected.');
  }
  // Reconstruct both formats; stored SARIF and unrecognized fields never cross the publication boundary.
  const diagnostics = hostedContextCiDiagnosticsV1(JSON.stringify(input.report));
  if (diagnostics.digest !== input.digest) throw new Error('Context CI diagnostic digest mismatch.');
  try {
    if (!(await matchesImmutableRefs(job, reader))) return {status: 'retry', reason: 'immutable-ref-changed'};
    const published = await publisher.publish({
      installationId: job.event.installationId,
      repositoryId: job.repositoryId,
      headCommit: job.event.headCommit,
      idempotencyKey: job.jobId,
      conclusion: diagnostics.report.exitCode === 0 ? 'success' : 'failure',
      diagnostics,
    });
    if (
      typeof published.publicationId !== 'string' ||
      published.publicationId.length < 1 ||
      published.publicationId.length > 256 ||
      published.digest !== diagnostics.digest
    ) {
      return {status: 'retry', reason: 'publication-unavailable'};
    }
    return {
      status: 'published',
      reportDigest: diagnostics.digest,
      publicationDigest: sha256HexSync(canonicalJson([job.jobId, published.publicationId, diagnostics.digest])),
    };
  } catch {
    return {status: 'retry', reason: 'publication-unavailable'};
  }
}

function assertReader(policy: HostedContextCiPolicyV1, reader: HostedContextCiReadIdentityV1): void {
  if (
    reader.identity !== policy.readerIdentity ||
    reader.capabilities.length !== 2 ||
    !reader.capabilities.includes('repository:read') ||
    !reader.capabilities.includes('context:check')
  ) {
    throw new Error('Context CI read identity rejected.');
  }
}

async function matchesImmutableRefs(
  job: HostedContextCiJobV1,
  reader: HostedContextCiReadIdentityV1,
): Promise<boolean> {
  const resolved = await reader.resolve(structuredClone(job));
  return (
    resolved.installationId === job.event.installationId &&
    resolved.repositoryId === job.repositoryId &&
    resolved.headCommit === job.event.headCommit &&
    resolved.baseCommit === job.event.baseCommit
  );
}
