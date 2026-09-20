import type {Sql} from 'postgres';
import {
  buildHostedContextCiPolicyV1,
  type HostedContextCiPolicyV1,
  type HostedContextCiWebhookV1,
} from './context_ci.js';
import {
  archiveHostedContextCiJobs,
  enqueueHostedContextCiWebhook,
  registerHostedContextCiTarget,
  setHostedContextCiEnabled,
  setHostedContextCiOptIn,
} from './context_ci_postgres.js';

/** Trusted operator input, never a public HTTP request. Each action still uses its dedicated database grants. */
export async function controlHostedContextCi(sql: Sql, input: unknown, webhookKey?: string): Promise<unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Context CI control input is invalid.');
  const value = input as Record<string, unknown>;
  if (value.action === 'register') {
    exactKeys(value, ['action', 'policy']);
    const policy = buildHostedContextCiPolicyV1(value.policy as HostedContextCiPolicyV1);
    await registerHostedContextCiTarget(sql, policy);
    return {version: 1, status: 'registered', policyDigest: policy.digest};
  }
  if (value.action === 'enable') {
    exactKeys(value, ['action', 'enabled']);
    await setHostedContextCiEnabled(sql, value.enabled as boolean);
    return {version: 1, status: value.enabled ? 'enabled' : 'disabled'};
  }
  if (value.action === 'opt-in') {
    exactKeys(value, ['action', 'tenantId', 'repositoryId', 'enabled']);
    await setHostedContextCiOptIn(
      sql,
      value.tenantId as string,
      value.repositoryId as string,
      value.enabled as boolean,
    );
    return {version: 1, status: value.enabled ? 'opted-in' : 'opted-out'};
  }
  if (value.action === 'archive') {
    exactKeys(value, ['action', 'tenantId', 'repositoryId']);
    const count = await archiveHostedContextCiJobs(sql, value.tenantId as string, value.repositoryId as string);
    return {version: 1, status: 'archived', count};
  }
  if (value.action === 'enqueue') {
    exactKeys(value, ['action', 'tenantId', 'repositoryId', 'webhook']);
    if (!webhookKey) throw new Error('Context CI webhook verification key is unavailable.');
    return enqueueHostedContextCiWebhook(sql, {
      tenantId: value.tenantId as string,
      repositoryId: value.repositoryId as string,
      webhook: value.webhook as HostedContextCiWebhookV1,
      webhookKey,
    });
  }
  throw new Error('Context CI control action is invalid.');
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('Context CI control fields are invalid.');
  }
}
