import {Console, Effect, Path} from 'effect';
import {captureConsole} from './effect/console.js';
import {SystemInfo} from './effect/system.js';
import {readHookPayload, runPreCompactHook, runSessionStartHook} from './hooks.js';
import type {CursorHookEvent} from './cursor_hooks.js';
import type {HookRunnerOptions, RuntimeConfig} from './types.js';

export const runCursorHook = Effect.fn('hooks.runCursor')(function* (
  config: RuntimeConfig,
  event: CursorHookEvent,
  options: HookRunnerOptions = {},
) {
  yield* runCursorHookWith(event, readHookPayload(), sessionId =>
    Effect.gen(function* () {
      if (event === 'sessionStart') yield* runSessionStartHook(config, options);
      else yield* runPreCompactHook(config, {...options, sourceAgentClient: 'cursor', sessionId});
    }),
  );
});

/** User hooks run in ~/.cursor, so scope must come from the provider payload. */
export const runCursorHookWith = Effect.fn('hooks.runCursorWith')(function* <E, R, PE, PR>(
  event: CursorHookEvent,
  readPayload: Effect.Effect<
    | {
        readonly workspaceRoots?: readonly string[];
        readonly sessionId?: string;
      }
    | undefined,
    PE,
    PR
  >,
  action: (sessionId: string | undefined) => Effect.Effect<void, E, R>,
) {
  const response = yield* Effect.gen(function* () {
    const payload = yield* readPayload;
    const path = yield* Path.Path;
    const cwd = payload?.workspaceRoots?.[0];
    if (!cwd || !path.isAbsolute(cwd)) return {};
    const system = yield* SystemInfo;
    const scopedSystem = SystemInfo.of({
      ...system,
      currentDirectory: () => cwd,
      environment: () => ({...system.environment(), THREADNOTE_CALLER_CWD: cwd}),
    });
    const captured = yield* captureConsole(
      action(payload?.sessionId).pipe(Effect.provideService(SystemInfo, scopedSystem)),
    );
    // preCompact is observational: its response cannot inject context. Never send
    // the handoff command's human-readable output as Cursor's JSON protocol.
    return event === 'sessionStart' && captured.output ? {additional_context: captured.output} : {};
  }).pipe(
    Effect.timeoutOrElse({duration: '12 seconds', orElse: () => Effect.succeed({})}),
    Effect.orElseSucceed(() => ({})),
  );
  yield* Console.log(JSON.stringify(response));
});
