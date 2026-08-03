import {Console, Effect} from 'effect';
import {CliOutput} from './cli_output.js';

function capturingConsole(parent: Console.Console, lines: string[]): Console.Console {
  const append = (...args: readonly unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  return Object.assign(Object.create(parent) as Console.Console, {
    error: append,
    log: append,
    warn: append,
  });
}

export function captureConsole<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<{readonly output: string; readonly value: A}, E, R> {
  return Console.consoleWith(parent => {
    const lines: string[] = [];
    const service = capturingConsole(parent, lines);
    const cliOutput = CliOutput.of({
      drain: Effect.void,
      enqueueError: output => {
        lines.push(output);
      },
      enqueueOutput: output => {
        lines.push(output);
      },
      writeError: output =>
        Effect.sync(() => {
          lines.push(output);
        }),
      writeFinal: output =>
        Effect.sync(() => {
          lines.push(output);
        }),
    });
    return effect.pipe(
      Effect.provideService(Console.Console, service),
      Effect.provideService(CliOutput, cliOutput),
      Effect.map(value => ({output: lines.join('\n'), value})),
    );
  });
}
