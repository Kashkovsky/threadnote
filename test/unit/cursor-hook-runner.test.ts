import {provideTestLayer} from '../helpers/effect-layer.js';
import {BunPath} from '@effect/platform-bun';
import {it as effectIt} from '@effect/vitest';
import {Console, Effect, Fiber, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {SystemInfo} from '../../src/effect/system.js';
import {runCursorHookWith} from '../../src/cursor_hook_runner.js';

const TestLayer = Layer.merge(BunPath.layer, SystemInfo.layer);

describe('Cursor hook protocol', () => {
  effectIt.effect('scopes user hooks to the first workspace and emits session context as one JSON object', () =>
    Effect.gen(function* () {
      const payload = Effect.succeed({sessionId: 'conversation', workspaceRoots: ['/repo/first', '/repo/second']});
      const result = yield* captureConsole(
        runCursorHookWith('sessionStart', payload, sessionId =>
          Effect.gen(function* () {
            expect(sessionId).toBe('conversation');
            const system = yield* SystemInfo;
            expect(system.currentDirectory()).toBe('/repo/first');
            expect(system.environment().THREADNOTE_CALLER_CWD).toBe('/repo/first');
            yield* Console.log('## Threadnote unread queue\n- [unread] threadnote://memory/example');
          }),
        ),
      );
      expect(JSON.parse(result.output)).toEqual({
        additional_context: '## Threadnote unread queue\n- [unread] threadnote://memory/example',
      });
    }).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('passes the conversation identity and keeps preCompact output outside the JSON response', () =>
    Effect.gen(function* () {
      const payload = Effect.succeed({sessionId: 'cursor-conversation', workspaceRoots: ['/repo']});
      let called = false;
      const result = yield* captureConsole(
        runCursorHookWith('preCompact', payload, sessionId =>
          Effect.gen(function* () {
            expect(sessionId).toBe('cursor-conversation');
            called = true;
            yield* Console.log('Stored snapshot output');
          }),
        ),
      );
      expect(called).toBe(true);
      expect(JSON.parse(result.output)).toEqual({});
    }).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect.each([undefined, [], ['relative']])('ignores missing or non-absolute workspace roots %s', roots =>
    Effect.gen(function* () {
      const payload = Effect.succeed({workspaceRoots: roots});
      const result = yield* captureConsole(
        runCursorHookWith('sessionStart', payload, () => Effect.die('must not run')),
      );
      expect(JSON.parse(result.output)).toEqual({});
    }).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('bounds slow hooks and emits a harmless response', () =>
    Effect.gen(function* () {
      const payload = Effect.succeed({workspaceRoots: ['/repo']});
      const fiber = yield* captureConsole(runCursorHookWith('sessionStart', payload, () => Effect.never)).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust('12 seconds');
      const result = yield* Fiber.join(fiber);
      expect(JSON.parse(result.output)).toEqual({});
    }).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('fails open with valid JSON when the action fails', () =>
    Effect.gen(function* () {
      const payload = Effect.succeed({workspaceRoots: ['/repo']});
      const result = yield* captureConsole(runCursorHookWith('preCompact', payload, () => Effect.fail('unavailable')));
      expect(JSON.parse(result.output)).toEqual({});
    }).pipe(provideTestLayer(TestLayer)),
  );
});
