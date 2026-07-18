import {clearLine, cursorTo} from 'node:readline';
import {stdout} from 'node:process';
import {Effect} from 'effect';

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

export function shouldUseColor(): boolean {
  return (
    stdout.isTTY === true &&
    process.env.NO_COLOR === undefined &&
    process.env.CI === undefined &&
    process.env.TERM !== 'dumb'
  );
}

export function withSpinnerEffect<A, E, R>(message: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  if (stdout.isTTY !== true || process.env.CI !== undefined || process.env.THREADNOTE_NO_SPINNER !== undefined) {
    return effect;
  }
  return Effect.acquireUseRelease(
    Effect.sync(() => startSpinner(message)),
    () => effect,
    spinner => Effect.sync(spinner.stop),
  );
}

function startSpinner(message: string): {readonly stop: () => void} {
  const frames = ['-', '\\', '|', '/'];
  let frameIndex = 0;
  const render = () => {
    clearLine(stdout, 0);
    cursorTo(stdout, 0);
    stdout.write(`${muted(frames[frameIndex])} ${message}`);
    frameIndex = (frameIndex + 1) % frames.length;
  };
  render();
  const timer = setInterval(render, 100);
  return {
    stop: () => {
      clearInterval(timer);
      clearLine(stdout, 0);
      cursorTo(stdout, 0);
    },
  };
}

export interface ProgressIndicator {
  update(message: string): void;
  stop(): void;
}

export function startProgress(message: string): ProgressIndicator {
  if (stdout.isTTY !== true || process.env.CI !== undefined || process.env.THREADNOTE_NO_SPINNER !== undefined) {
    console.log(message);
    return {
      update(nextMessage: string): void {
        console.log(nextMessage);
      },
      stop(): void {
        return;
      },
    };
  }

  const frames = ['-', '\\', '|', '/'];
  let frameIndex = 0;
  let currentMessage = message;
  const render = () => {
    clearLine(stdout, 0);
    cursorTo(stdout, 0);
    stdout.write(`${muted(frames[frameIndex])} ${currentMessage}`);
    frameIndex = (frameIndex + 1) % frames.length;
  };
  const timer = setInterval(render, 100);
  render();
  return {
    update(nextMessage: string): void {
      currentMessage = nextMessage;
      render();
    },
    stop(): void {
      clearInterval(timer);
      clearLine(stdout, 0);
      cursorTo(stdout, 0);
    },
  };
}
