import {Effect} from 'effect';
import type {DoctorCheck, RuntimeConfig} from '../../types.js';
import {observeDeferredCodeAnchorCallerCheckout} from './code_anchor_checkout.js';
import {listDeferredCodeAnchorIntents, type StoredDeferredCodeAnchorIntent} from './code_anchor.js';

const MAX_INSPECTIONS = 25;
const CONCURRENCY = 4;

export const deferredCodeAnchorDoctorCheck = Effect.fn('memoryCodeAnchor.doctorCheck')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
) {
  const entries = yield* listDeferredCodeAnchorIntents(config);
  const invalid = entries.filter(entry => entry.kind === 'invalid').length;
  if (invalid > 0) {
    return {
      detail: `${invalid} malformed or unreadable private intent(s); run \`threadnote finalize-code-refs\` for a bounded failure receipt`,
      name: 'deferred code anchors',
      status: 'fail',
    } satisfies DoctorCheck;
  }
  if (entries.length === 0) {
    return {
      detail: 'no pending private code-anchor intents',
      name: 'deferred code anchors',
      status: 'ok',
    } satisfies DoctorCheck;
  }
  const inspected = entries.slice(0, MAX_INSPECTIONS) as readonly StoredDeferredCodeAnchorIntent[];
  const attribution = yield* Effect.forEach(
    inspected,
    entry =>
      observeDeferredCodeAnchorCallerCheckout(entry.intent.callerCwd).pipe(
        Effect.catchCause(() => Effect.succeed({state: 'unobserved'} as const)),
        Effect.map(observation => {
          const reason =
            observation.state === 'missing'
              ? 'caller checkout missing'
              : observation.state === 'unobserved'
                ? 'checkout unobserved/read failure'
                : observation.repositoryId === entry.intent.repositoryId &&
                    observation.worktreeId === entry.intent.worktreeId
                  ? 'present matching'
                  : 'caller repository identity changed';
          return `${entry.intent.worktreeId.slice(0, 12)} ${reason}`;
        }),
      ),
    {concurrency: CONCURRENCY},
  );
  const remaining = entries.length - inspected.length;
  return {
    detail: `${entries.length} private code-anchor intent(s) are pending finalization across ${new Set(inspected.map(entry => entry.intent.worktreeId)).size} worktree(s): ${[...new Set(attribution)].join(', ')}${remaining > 0 ? `; attribution partial (${remaining} remaining)` : ''}`,
    name: 'deferred code anchors',
    status: 'warn',
  } satisfies DoctorCheck;
});
