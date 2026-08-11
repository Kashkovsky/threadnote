import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Console, Effect, Terminal} from 'effect';
import {describe, expect, it} from 'vitest';
import {promptForSelection, startProgress} from '../../src/cli_ui.js';
import {CliOutput, makeQueuedCliWriter, withCliOutputConsole} from '../../src/effect/cli_output.js';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';

describe('CLI progress indicator', () => {
  effectIt.effect('keeps Effect diagnostics off machine-readable stdout', () =>
    Effect.gen(function* () {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const flush = Effect.void;
      const output = CliOutput.of({
        drain: flush,
        enqueueError: value => stderr.push(value),
        enqueueOutput: value => stdout.push(value),
        flush,
        writeError: value => Effect.sync(() => stderr.push(value)),
        writeFinal: value => Effect.sync(() => stdout.push(value)),
      });

      yield* withCliOutputConsole(
        Effect.gen(function* () {
          yield* Console.log('{"type":"machine-result"}');
          yield* Effect.logWarning('deferred maintenance diagnostic');
        }),
      ).pipe(Effect.provideService(CliOutput, output));

      expect(stdout).toEqual(['{"type":"machine-result"}']);
      expect(stderr).toHaveLength(1);
      expect(stderr[0]).toContain('deferred maintenance diagnostic');
    }),
  );

  it('waits for a backpressured pipe write before flushing or closing it', async () => {
    const events: string[] = [];
    let releaseWrite: (() => void) | undefined;
    const pendingWrite = new Promise<void>(resolve => {
      releaseWrite = resolve;
    });
    const writer = makeQueuedCliWriter(() => ({
      end: () => {
        events.push('end');
        return 0;
      },
      flush: () => {
        events.push('flush');
        return 0;
      },
      write: async output => {
        events.push(`write:${output}`);
        await pendingWrite;
        events.push('written');
        return output.length;
      },
    }));

    const write = writer.write('complete-json');
    await Promise.resolve();
    expect(events).toEqual(['write:complete-json\n']);
    releaseWrite?.();
    await write;
    await writer.drain();

    expect(events).toEqual(['write:complete-json\n', 'written', 'flush', 'end']);
  });

  effectIt.effect('renders each explicit milestone immediately in an interactive terminal', () =>
    Effect.gen(function* () {
      const displays: string[] = [];
      const system = yield* SystemInfo.pipe(provideTestLayer(ApplicationLayer));
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
      const output = orderedCliOutput([]);

      yield* Effect.acquireUseRelease(
        startProgress('Building lexical recall index.'),
        progress => progress.update('Building lexical recall index: 64/4,084 (1%).'),
        progress => progress.stop,
      ).pipe(
        Effect.provideService(CliOutput, output),
        Effect.provideService(SystemInfo, interactiveSystem),
        Effect.provideService(Terminal.Terminal, terminal),
      );

      expect(displays.some(display => display.includes('Building lexical recall index.'))).toBe(true);
      expect(displays.some(display => display.includes('64/4,084 (1%)'))).toBe(true);
      expect(displays.at(-1)).toBe('\r\u001b[2K');
    }),
  );

  effectIt.effect('flushes queued headings before an interactive terminal frame', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const system = yield* SystemInfo.pipe(provideTestLayer(ApplicationLayer));
      const interactiveSystem = SystemInfo.of({...system, environment: () => ({}), stdoutIsTTY: true});
      const output = orderedCliOutput(events);
      const terminal = Terminal.make({
        columns: Effect.succeed(120),
        display: text =>
          Effect.sync(() => {
            events.push(`terminal:${text}`);
          }),
        readInput: Effect.never,
        readLine: Effect.never,
        rows: Effect.succeed(40),
      });

      yield* withCliOutputConsole(
        Effect.gen(function* () {
          yield* Console.log('Indexing code graph.');
          const progress = yield* startProgress('Scanning repository source from Git.');
          yield* progress.stop;
        }),
      ).pipe(
        Effect.provideService(CliOutput, output),
        Effect.provideService(SystemInfo, interactiveSystem),
        Effect.provideService(Terminal.Terminal, terminal),
      );

      expect(events[0]).toBe('Indexing code graph.');
      expect(events[1]).toContain('terminal:');
      expect(events[1]).toContain('Scanning repository source from Git.');
    }),
  );

  effectIt.effect('flushes queued menu lines before writing a direct prompt', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const system = yield* SystemInfo.pipe(provideTestLayer(ApplicationLayer));
      const interactiveSystem = SystemInfo.of({
        ...system,
        readLine: (prompt, onLine) => {
          events.push(prompt);
          onLine('1');
          return () => {};
        },
      });
      const output = orderedCliOutput(events);

      const selected = yield* withCliOutputConsole(promptForSelection('Choose a model:', ['Small', 'Large'])).pipe(
        Effect.provideService(CliOutput, output),
        Effect.provideService(SystemInfo, interactiveSystem),
      );

      expect(selected).toBe(0);
      expect(events).toEqual(['Choose a model:', '> 1. Small', '  2. Large', 'Select [1]: ']);
    }),
  );

  effectIt.effect('coalesces rapid line-mode updates while preserving phase boundaries and the final milestone', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo.pipe(provideTestLayer(ApplicationLayer));
      const lineSystem = SystemInfo.of({
        ...system,
        environment: () => ({}),
        stdoutIsTTY: false,
      });

      const captured = yield* captureConsole(
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
          progress => progress.stop,
        ),
      ).pipe(Effect.provideService(SystemInfo, lineSystem), provideTestLayer(ApplicationLayer));

      expect(captured.output.split('\n')).toEqual([
        'Scanning repository source from Git.',
        'Scanning · 0/100 files',
        'Scanning · 99/100 files',
        'Materializing · 0/100 files',
        'Materializing · 99/100 files',
        'Ready · 100 files',
      ]);
    }),
  );
});

function orderedCliOutput(events: string[]) {
  const pending: string[] = [];
  const flush = Effect.sync(() => {
    events.push(...pending);
    pending.length = 0;
  });
  return CliOutput.of({
    drain: flush,
    enqueueError: output => pending.push(output),
    enqueueOutput: output => pending.push(output),
    flush,
    writeError: output => Effect.sync(() => events.push(output)),
    writeFinal: output => Effect.sync(() => events.push(output)),
  });
}
