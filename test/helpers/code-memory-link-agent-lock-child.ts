import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, FileSystem, Path} from 'effect';
import {
  resolveCodeMemoryLinkAgentLedgerLayout,
  withCodeMemoryLinkAgentLedgerLock,
} from '../../src/evaluation/code-memory-link-agent-attempts.js';
import {SystemInfo} from '../../src/effect/system.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideScriptLayer, ScriptError} from '../../scripts/effect/errors.js';
import {atomicWrite, scriptArguments} from '../../scripts/effect/script.js';

const program = Effect.gen(function* () {
  const [root] = yield* scriptArguments();
  if (!root) return yield* ScriptError.make({message: 'Ledger-lock child requires a fixture root.'});
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const trialsPath = path.join(root, 'trials.jsonl');
  const attemptsPath = `${trialsPath}.attempts.jsonl`;
  const evidencePath = `${trialsPath}.evidence.jsonl`;
  const layout = yield* resolveCodeMemoryLinkAgentLedgerLayout(trialsPath, attemptsPath, evidencePath);
  yield* withCodeMemoryLinkAgentLedgerLock(
    layout,
    10_000,
    Effect.gen(function* () {
      const current = (yield* fs.exists(layout.trialsPath)) ? yield* fs.readFileString(layout.trialsPath) : '';
      if (current.trim()) return;
      const executions = path.join(root, 'external-executions');
      yield* fs.makeDirectory(executions, {recursive: true, mode: 0o700});
      yield* fs.writeFileString(path.join(executions, `${system.processId}.marker`), 'executed\n', {
        flag: 'wx',
        mode: 0o600,
      });
      yield* Effect.sleep(500);
      yield* atomicWrite(layout.trialsPath, `${system.processId}\n`);
    }),
  );
});

BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
