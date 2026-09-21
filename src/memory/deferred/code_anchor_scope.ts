import {Effect, Predicate} from 'effect';
import {CodeGraphQueryService} from '../../code_graph/query.js';
import {sha256Hex} from '../../effect/digest.js';
import type {RuntimeConfig} from '../../types.js';
import type {
  MemoryCodeCitationCaptureRecoveryV1,
  MemoryCodeCitationProjectScopeExpectationV1,
} from '../code/citation_capture.js';
import {memoryCodeCitationProjectScopeMatches, MemoryCodeCitationCaptureError} from '../code/citation_capture.js';

export type DeferredCodeAnchorProjectScopeExpectationV1 = MemoryCodeCitationProjectScopeExpectationV1;

export function isDeferredCodeAnchorFullProjectScope(
  value: DeferredCodeAnchorProjectScopeExpectationV1,
): value is {readonly kind: 'full'} {
  return 'kind' in value && value.kind === 'full';
}

export interface DeferredCodeAnchorIntentV1 {
  readonly authorization: 'explicit-code-refs';
  readonly callerCwd: string;
  readonly codeRefs: readonly string[];
  readonly createdAt: string;
  readonly expectedMemoryHash: string;
  readonly intentId: string;
  readonly memoryId: string;
  readonly memoryUri: string;
  readonly project?: string;
  readonly projectScope?: DeferredCodeAnchorProjectScopeExpectationV1;
  readonly repositoryId: string;
  readonly recovery: MemoryCodeCitationCaptureRecoveryV1;
  readonly type: 'threadnote-deferred-code-anchor-intent';
  readonly version: 1;
  readonly visibility: 'private-local';
  readonly worktreeId: string;
}

export const verifyDeferredCodeAnchorProjectScope = Effect.fn('memoryCodeAnchor.verifyProjectScope')(function* (
  config: RuntimeConfig,
  intent: DeferredCodeAnchorIntentV1,
) {
  if (intent.projectScope === undefined) return;
  const query = yield* CodeGraphQueryService;
  const status = yield* query.status(config.agentContextHome, intent.callerCwd, {
    project: intent.project,
    manifestPath: config.manifestPath,
    observeWorktree: true,
    requestMaintenance: false,
  });
  if (!memoryCodeCitationProjectScopeMatches(status, intent.projectScope)) {
    return yield* MemoryCodeCitationCaptureError.of(
      'The selected project graph changed since deferred code citation capture; replace the memory with current code references.',
    );
  }
});

export function deferredCodeAnchorIntentId(input: {
  readonly callerCwd: string;
  readonly codeRefs: readonly string[];
  readonly expectedMemoryHash: string;
  readonly memoryId: string;
  readonly memoryUri: string;
  readonly project?: string;
  readonly projectScope?: DeferredCodeAnchorProjectScopeExpectationV1;
  readonly repositoryId: string;
  readonly recovery: MemoryCodeCitationCaptureRecoveryV1;
  readonly worktreeId: string;
}) {
  const fields = [
    input.memoryUri,
    input.memoryId,
    input.expectedMemoryHash,
    input.repositoryId,
    input.worktreeId,
    input.callerCwd,
    input.recovery.code,
    input.recovery.observedGraph.freshness,
    input.recovery.observedGraph.readySnapshot,
    String(input.recovery.observedGraph.stale),
    input.recovery.preparation.action,
    input.recovery.preparation.target,
    input.recovery.preparation.command,
    ...input.recovery.preparation.arguments,
    ...input.codeRefs,
  ];
  if (input.project !== undefined) fields.push('project', input.project);
  if (input.projectScope !== undefined) {
    fields.push('projectScope');
    if (isDeferredCodeAnchorFullProjectScope(input.projectScope)) {
      fields.push('full');
    } else {
      fields.push(
        input.projectScope.project,
        input.projectScope.scopeKey,
        input.projectScope.definitionDigest,
        input.projectScope.closureDigest,
      );
    }
  }
  return sha256Hex(fields.join('\n')).pipe(Effect.map(digest => `tnca_${digest.slice(0, 32)}`));
}

export function hasDeferredCodeAnchorIntentKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const allowed = new Set([...required, 'project', 'projectScope']);
  return required.every(key => key in value) && Object.keys(value).every(key => allowed.has(key));
}

export function parseMemoryCodeCitationProjectScopeReceipt(
  value: unknown,
): DeferredCodeAnchorProjectScopeExpectationV1 | undefined {
  if (Predicate.isObject(value) && hasExactKeys(value, ['kind']) && value.kind === 'full') return {kind: 'full'};
  if (!Predicate.isObject(value) || !hasExactKeys(value, ['closureDigest', 'definitionDigest', 'project', 'scopeKey']))
    return undefined;
  return typeof value.project === 'string' &&
    value.project.length > 0 &&
    typeof value.scopeKey === 'string' &&
    value.scopeKey.length > 0 &&
    typeof value.definitionDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.definitionDigest) &&
    typeof value.closureDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.closureDigest)
    ? {
        closureDigest: value.closureDigest,
        definitionDigest: value.definitionDigest,
        project: value.project,
        scopeKey: value.scopeKey,
      }
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
