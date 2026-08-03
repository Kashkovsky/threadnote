import {Console, Effect} from 'effect';

/**
 * Emits a complete final CLI payload and waits until Bun has drained stdout.
 *
 * Effect's Console service remains the emission boundary so Manager and test
 * capture layers keep working. Bun's console write itself is asynchronous when
 * stdout is a pipe, however, and a one-shot CLI can otherwise exit after only
 * one platform pipe buffer has been delivered.
 */
export function makeFinalCliOutput(drain: () => Promise<void>) {
  return Effect.fn('cliOutput.writeFinal')(function* (output: string) {
    yield* Console.log(output);
    yield* Effect.tryPromise({
      try: drain,
      catch: cause => new Error('Failed to drain Threadnote CLI output.', {cause}),
    });
  });
}

const drainBunStdout = () =>
  new Promise<void>((resolve, reject) => {
    // Effect Console ultimately queues through Bun's Node-compatible stdout.
    // Its write callback is the cross-platform completion signal for that
    // queue; a separate BunFile writer does not drain already queued console
    // bytes in a compiled standalone executable.
    process.stdout.write('', error => (error ? reject(error) : resolve()));
  });

export const drainCliStdout = Effect.tryPromise({
  try: drainBunStdout,
  catch: cause => new Error('Failed to drain Threadnote CLI output.', {cause}),
});

export const writeFinalCliOutput = makeFinalCliOutput(drainBunStdout);
