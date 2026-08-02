import {Effect, Terminal} from 'effect';
import {describe, expect, it} from 'vitest';
import {startProgress} from '../../src/cli_ui.js';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';

describe('CLI progress indicator', () => {
  it('renders each explicit milestone immediately in an interactive terminal', async () => {
    const displays: string[] = [];
    const system = await Effect.runPromise(SystemInfo.pipe(Effect.provide(ApplicationLayer)));
    const interactiveSystem = SystemInfo.of({
      ...system,
      environment: () => ({}),
      stdoutIsTTY: true,
    });
    const terminal = Terminal.make({
      columns: Effect.succeed(120),
      display: text =>
        Effect.sync(() => {
          displays.push(text);
        }),
      readInput: Effect.never,
      readLine: Effect.never,
      rows: Effect.succeed(40),
    });

    await Effect.runPromise(
      Effect.acquireUseRelease(
        startProgress('Building lexical recall index.'),
        progress => progress.update('Building lexical recall index: 64/4,084 (1%).'),
        progress => progress.stop(),
      ).pipe(Effect.provideService(SystemInfo, interactiveSystem), Effect.provideService(Terminal.Terminal, terminal)),
    );

    expect(displays.some(display => display.includes('Building lexical recall index.'))).toBe(true);
    expect(displays.some(display => display.includes('64/4,084 (1%)'))).toBe(true);
    expect(displays.at(-1)).toBe('\r\u001b[2K');
  });

  it('coalesces rapid line-mode updates while preserving phase boundaries and the final milestone', async () => {
    const system = await Effect.runPromise(SystemInfo.pipe(Effect.provide(ApplicationLayer)));
    const lineSystem = SystemInfo.of({
      ...system,
      environment: () => ({}),
      stdoutIsTTY: false,
    });

    const captured = await Effect.runPromise(
      captureConsole(
        Effect.acquireUseRelease(
          startProgress('Scanning repository source from Git.'),
          progress =>
            Effect.gen(function* () {
              for (let index = 0; index < 100; index += 1) {
                yield* progress.update(`Scanning · ${index}/100 files`);
              }
              for (let index = 0; index < 100; index += 1) {
                yield* progress.update(`Materializing · ${index}/100 files`);
              }
              yield* progress.update('Ready · 100 files');
            }),
          progress => progress.stop(),
        ),
      ).pipe(Effect.provideService(SystemInfo, lineSystem), Effect.provide(ApplicationLayer)),
    );

    expect(captured.output.split('\n')).toEqual([
      'Scanning repository source from Git.',
      'Scanning · 0/100 files',
      'Scanning · 99/100 files',
      'Materializing · 0/100 files',
      'Materializing · 99/100 files',
      'Ready · 100 files',
    ]);
  });
});
