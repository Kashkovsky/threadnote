import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import type {CodeMemoryLinkAgentLedgerLayout} from '../../src/evaluation/code-memory-link-agent-attempts.js';
import {
  CODE_MEMORY_LINK_AGENT_LEDGER_DURABILITY_STEPS,
  durablyRemoveCodeMemoryLinkAgentLedger,
  durablyReplaceCodeMemoryLinkAgentLedger,
  persistCodeMemoryLinkAgentAttemptStartDurably,
  projectCodeMemoryLinkAgentPendingCommitDurably,
  type CodeMemoryLinkAgentLedgerDurabilityStep,
} from '../../src/evaluation/code-memory-link-agent-ledger-durability.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '../helpers/test-error.js';

describe('Code Memory Link agent ledger durability', () => {
  effectIt.effect('syncs file data before rename and the parent after rename and unlink', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const fs = {
        makeDirectory: (target: string) => Effect.sync(() => calls.push(`mkdir:${target}`)),
        open: (target: string, options: {readonly flag: string}) =>
          Effect.succeed({
            sync: Effect.sync(() => calls.push(`sync:${options.flag}:${target}`)),
          }),
        remove: (target: string) => Effect.sync(() => calls.push(`remove:${target}`)),
        rename: (from: string, to: string) => Effect.sync(() => calls.push(`rename:${from}:${to}`)),
        writeFileString: (target: string) => Effect.sync(() => calls.push(`write:${target}`)),
      } as unknown as FileSystem.FileSystem;
      const target = '/reviewed/evidence/trials.jsonl';

      yield* durablyReplaceCodeMemoryLinkAgentLedger(target, 'trial\n').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const writeIndex = calls.findIndex(call => call.startsWith('write:'));
      const fileSyncIndex = calls.findIndex(call => call.startsWith('sync:r+:'));
      const renameIndex = calls.findIndex(call => call.startsWith('rename:'));
      const directorySyncIndex = calls.findIndex(call => call === 'sync:r:/reviewed/evidence');
      expect(writeIndex).toBeGreaterThanOrEqual(0);
      expect(fileSyncIndex).toBeGreaterThan(writeIndex);
      expect(renameIndex).toBeGreaterThan(fileSyncIndex);
      expect(directorySyncIndex).toBeGreaterThan(renameIndex);

      calls.length = 0;
      yield* durablyRemoveCodeMemoryLinkAgentLedger(target).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      expect(calls).toEqual(['remove:/reviewed/evidence/trials.jsonl', 'sync:r:/reviewed/evidence']);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not begin external execution after a crash at the durable attempt-start boundary', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-attempt-durable-'});
        const attemptsPath = path.join(root, 'trials.jsonl.attempts.jsonl');
        let executed = false;
        const exit = yield* persistCodeMemoryLinkAgentAttemptStartDurably(attemptsPath, 'started\n', {
          afterStep: () => Effect.fail(TestError.make({message: 'simulated host crash'})),
        }).pipe(Effect.andThen(Effect.sync(() => (executed = true))), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(executed).toBe(false);
        expect(yield* fs.readFileString(attemptsPath)).toBe('started\n');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails closed when the host cannot sync the ledger directory', () =>
    Effect.gen(function* () {
      const fs = {
        makeDirectory: () => Effect.void,
        open: (_target: string, options: {readonly flag: string}) =>
          options.flag === 'r'
            ? Effect.fail(TestError.make({message: 'directory sync unsupported'}))
            : Effect.succeed({sync: Effect.void}),
        remove: () => Effect.void,
        rename: () => Effect.void,
        writeFileString: () => Effect.void,
      } as unknown as FileSystem.FileSystem;

      const exit = yield* durablyReplaceCodeMemoryLinkAgentLedger('/reviewed/evidence/trials.jsonl', 'trial\n').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('recovers every fully durable pending-commit kill point without rerunning execution', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        for (const step of CODE_MEMORY_LINK_AGENT_LEDGER_DURABILITY_STEPS.filter(
          candidate => candidate !== 'attempt-start-durable',
        )) {
          const root = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-agent-ledger-${step}-`});
          const layout = ledgerLayout(path, root);
          yield* fs.writeFileString(layout.evidencePath, 'old-evidence\n');
          yield* fs.writeFileString(layout.trialsPath, 'old-trial\n');
          const exit = yield* projectCodeMemoryLinkAgentPendingCommitDurably(
            layout,
            {
              evidenceSource: 'new-evidence\n',
              pendingSource: 'pending\n',
              trialsSource: 'new-trial\n',
            },
            {afterStep: observed => failAt(observed, step)},
          ).pipe(Effect.exit);
          expect(Exit.isFailure(exit), step).toBe(true);

          const pendingExists = yield* fs.exists(layout.pendingPath);
          if (step === 'pending-removal-durable') {
            expect(pendingExists, step).toBe(false);
          } else {
            expect(pendingExists, step).toBe(true);
            yield* projectCodeMemoryLinkAgentPendingCommitDurably(layout, {
              evidenceSource:
                (yield* fs.readFileString(layout.evidencePath)) === 'new-evidence\n' ? undefined : 'new-evidence\n',
              trialsSource: (yield* fs.readFileString(layout.trialsPath)) === 'new-trial\n' ? undefined : 'new-trial\n',
            });
          }
          expect(yield* fs.readFileString(layout.evidencePath), step).toBe('new-evidence\n');
          expect(yield* fs.readFileString(layout.trialsPath), step).toBe('new-trial\n');
          expect(yield* fs.exists(layout.pendingPath), step).toBe(false);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function failAt(observed: CodeMemoryLinkAgentLedgerDurabilityStep, target: CodeMemoryLinkAgentLedgerDurabilityStep) {
  return observed === target
    ? Effect.fail(TestError.make({message: `simulated host crash after ${target}`}))
    : Effect.void;
}

function ledgerLayout(path: Path.Path, root: string): CodeMemoryLinkAgentLedgerLayout {
  const trialsPath = path.join(root, 'trials.jsonl');
  return {
    attemptsPath: `${trialsPath}.attempts.jsonl`,
    evidencePath: `${trialsPath}.evidence.jsonl`,
    lockPath: `${trialsPath}.lock`,
    pendingPath: `${trialsPath}.pending.json`,
    trialsPath,
  };
}
