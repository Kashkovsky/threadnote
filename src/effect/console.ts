import {Console, Effect} from 'effect';

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
    return effect.pipe(
      Effect.provideService(Console.Console, service),
      Effect.map(value => ({output: lines.join('\n'), value})),
    );
  });
}
