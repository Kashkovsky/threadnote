import {Console, Effect, Fiber, Ref, Schedule, Terminal} from 'effect';
import {SystemInfo} from './effect/system.js';

type ColorName = 'blue' | 'cyan' | 'dim' | 'green' | 'red' | 'yellow';

const ANSI: Record<ColorName | 'bold' | 'reset', string> = {
  blue: '\u001b[34m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  reset: '\u001b[0m',
  yellow: '\u001b[33m',
};

let colorEnabled = false;

export const initializeCliUi = Effect.fn('cliUi.initialize')(function* () {
  const system = yield* SystemInfo;
  const environment = system.environment();
  colorEnabled =
    system.stdoutIsTTY &&
    environment.NO_COLOR === undefined &&
    environment.CI === undefined &&
    environment.TERM !== 'dumb';
});

export function color(name: ColorName, text: string): string {
  if (!shouldUseColor()) {
    return text;
  }
  return `${ANSI[name]}${text}${ANSI.reset}`;
}

export function bold(text: string): string {
  if (!shouldUseColor()) {
    return text;
  }
  return `${ANSI.bold}${text}${ANSI.reset}`;
}

export function command(text: string): string {
  return color('cyan', text);
}

export function heading(text: string): string {
  return bold(text);
}

export function info(text: string): string {
  return color('cyan', text);
}

export function muted(text: string): string {
  return color('dim', text);
}

export function success(text: string): string {
  return color('green', text);
}

export function warning(text: string): string {
  return color('yellow', text);
}

export function failure(text: string): string {
  return color('red', text);
}

export function keyValue(label: string, value: string): string {
  return `${label}: ${value}`;
}

export const promptForConfirmation = Effect.fn('cliUi.promptForConfirmation')(function* (
  prompt: string,
  defaultYes = false,
) {
  const system = yield* SystemInfo;
  return yield* Effect.callback<boolean>(resume => {
    const cleanup = system.readLine(prompt, answer => resume(Effect.succeed(confirmationAnswer(answer, defaultYes))));
    return Effect.sync(cleanup);
  });
});

export function confirmationAnswer(answer: string, defaultYes = false): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === '' ? defaultYes : normalized === 'y' || normalized === 'yes';
}

export function shouldUseColor(): boolean {
  return colorEnabled;
}

export function withSpinnerEffect<A, E, R>(message: string, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const environment = system.environment();
    if (!system.stdoutIsTTY || environment.CI !== undefined || environment.THREADNOTE_NO_SPINNER !== undefined) {
      return yield* effect;
    }
    return yield* Effect.acquireUseRelease(
      startSpinner(message),
      () => effect,
      spinner => spinner.stop(),
    );
  });
}

const startSpinner = Effect.fn('cliUi.startSpinner')(function* (message: string) {
  const terminal = yield* Terminal.Terminal;
  const frames = ['-', '\\', '|', '/'];
  const frameIndex = yield* Ref.make(0);
  const render = Ref.getAndUpdate(frameIndex, index => (index + 1) % frames.length).pipe(
    Effect.flatMap(index => terminal.display(`\r\u001b[2K${muted(frames[index])} ${message}`)),
  );
  yield* render;
  const fiber = yield* render.pipe(Effect.repeat(Schedule.spaced(100)), Effect.forkDetach);
  return {
    stop: () => Fiber.interrupt(fiber).pipe(Effect.andThen(terminal.display('\r\u001b[2K'))),
  };
});

export interface ProgressIndicator {
  update(message: string): Effect.Effect<void>;
  stop(): Effect.Effect<void>;
}

export const startProgress = Effect.fn('cliUi.startProgress')(function* (message: string) {
  const system = yield* SystemInfo;
  const environment = system.environment();
  if (!system.stdoutIsTTY || environment.CI !== undefined || environment.THREADNOTE_NO_SPINNER !== undefined) {
    yield* Console.log(message);
    return {
      update: (nextMessage: string) => Console.log(nextMessage),
      stop: () => Effect.void,
    };
  }

  const terminal = yield* Terminal.Terminal;
  const frames = ['-', '\\', '|', '/'];
  const frameIndex = yield* Ref.make(0);
  const currentMessage = yield* Ref.make(message);
  const render = Effect.all([
    Ref.getAndUpdate(frameIndex, index => (index + 1) % frames.length),
    Ref.get(currentMessage),
  ]).pipe(Effect.flatMap(([index, text]) => terminal.display(`\r\u001b[2K${muted(frames[index])} ${text}`)));
  yield* render;
  const fiber = yield* render.pipe(Effect.repeat(Schedule.spaced(100)), Effect.forkDetach);
  return {
    update: (nextMessage: string) => Ref.set(currentMessage, nextMessage).pipe(Effect.andThen(render)),
    stop: () => Fiber.interrupt(fiber).pipe(Effect.andThen(terminal.display('\r\u001b[2K'))),
  };
});
