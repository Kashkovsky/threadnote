import {AsyncLocalStorage} from 'node:async_hooks';
import {Console, Effect} from 'effect';

const consoleScope = new AsyncLocalStorage<Console.Console>();

type OutputMethod = 'debug' | 'error' | 'info' | 'log' | 'warn';

function forward(method: OutputMethod, args: readonly unknown[]): void {
  const service = consoleScope.getStore();
  if (!service) {
    throw new Error('Console output escaped its Effect Console scope.');
  }
  service[method](...args);
}

/**
 * Synchronous view of the current Effect Console service for Promise-based
 * compatibility code. New Effect code should use Console.log / warn / error
 * directly; fromPromise installs this scope at the compatibility boundary.
 */
export const consoleOutput = {
  debug: (...args: readonly unknown[]) => forward('debug', args),
  error: (...args: readonly unknown[]) => forward('error', args),
  info: (...args: readonly unknown[]) => forward('info', args),
  log: (...args: readonly unknown[]) => forward('log', args),
  warn: (...args: readonly unknown[]) => forward('warn', args),
} as const;

export function runWithConsole<A>(service: Console.Console, evaluate: () => A): A {
  return consoleScope.run(service, evaluate);
}

export function syncWithConsole<A>(evaluate: () => A): Effect.Effect<A> {
  return Console.consoleWith(service => Effect.sync(() => runWithConsole(service, evaluate)));
}

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

export function tryPromiseWithConsole<A, E>(options: {
  readonly catch: (cause: unknown) => E;
  readonly try: () => PromiseLike<A>;
}): Effect.Effect<A, E> {
  return Console.consoleWith(service =>
    Effect.tryPromise({
      catch: options.catch,
      try: () => runWithConsole(service, options.try),
    }),
  );
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

export async function capturePromiseConsole<A>(
  evaluate: () => Promise<A>,
): Promise<{readonly output: string; readonly value: A}> {
  const parent = consoleScope.getStore();
  if (!parent) {
    throw new Error('Console capture escaped its Effect Console scope.');
  }
  const lines: string[] = [];
  const service = capturingConsole(parent, lines);
  const value = await runWithConsole(service, evaluate);
  return {output: lines.join('\n'), value};
}
